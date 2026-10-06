import { after, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import {
  cleanupDatabase,
  request,
  resetDatabase,
  setupOAuth,
  callMcpTool,
  setupUser,
  sql,
} from "./support.js";
import { app } from "../apps/api/src/app.js";
import { digest, secret } from "../apps/api/src/external/protocol.js";

beforeEach(resetDatabase);
after(cleanupDatabase);
async function json(response: Response, status = 200) {
  assert.equal(response.status, status, await response.clone().text());
  return response.json();
}
async function board(cookie: string, prefix: string) {
  return (
    await json(
      await request("/api/boards", { cookie, body: { name: prefix, prefix } }),
      201,
    )
  ).board;
}
async function task(
  cookie: string,
  boardId: string,
  body: Record<string, unknown>,
  key?: string,
) {
  return (
    await json(
      await request(`/api/boards/${boardId}/tasks`, {
        cookie,
        body: { title: "Private task content", ...body },
        headers: key ? { "Idempotency-Key": key } : undefined,
      }),
      201,
    )
  ).task;
}
async function member(cookie: string, role: string) {
  const invitation = await json(
    await request("/api/auth/invitations", {
      cookie,
      body: { email: `${role}@example.test`, role },
    }),
    201,
  );
  const response = await request("/api/auth/accept-invitation", {
    body: {
      token: invitation.token,
      name: role,
      password: "Another secure passphrase 42!",
    },
  });
  const result = await json(response, 201);
  return {
    cookie: response.headers.get("set-cookie")!.split(";")[0],
    user: result.user,
  };
}

test("permanent task deletion purges owned content, preserves other work and numbering, and replays safely", async () => {
  const { cookie } = await setupUser();
  const colleague = await member(cookie, "member");
  const work = await board(cookie, "WORK");
  const parent = await task(
    cookie,
    work.id,
    { assigneeId: colleague.user.id },
    "parent-content-cache",
  );
  const child = await task(
    cookie,
    work.id,
    { status: "in_progress" },
    "child-content-cache",
  );
  const grandchild = await task(cookie, work.id, { status: "done" });
  const surviving = await task(
    cookie,
    work.id,
    { title: "Surviving work" },
    "surviving-work-cache",
  );
  await json(
    await request(`/api/tasks/${parent.id}/comments`, {
      cookie,
      body: {
        body: "Private comment content",
        mentionIds: [colleague.user.id],
      },
      headers: { "Idempotency-Key": "child-comment-cache" },
    }),
    201,
  );
  const ids = [parent.id];
  const independent =
    await sql`SELECT * FROM tasks WHERE id IN ${sql([child.id, grandchild.id])} ORDER BY id`;
  assert.equal(
    (await sql`SELECT id FROM notifications WHERE task_id IN ${sql(ids)}`)
      .length,
    2,
  );
  const options = {
    cookie: colleague.cookie,
    method: "DELETE",
    body: { version: parent.version },
    headers: { "Idempotency-Key": "permanent-task-delete" },
  };
  const concurrentDeletes = await Promise.all(
    Array.from({ length: 3 }, () =>
      request(`/api/tasks/${parent.id}`, options),
    ),
  );
  for (const response of concurrentDeletes)
    assert.deepEqual(await json(response), { ok: true });
  for (const table of ["tasks", "comments", "notifications", "activity"]) {
    const column = table === "tasks" ? "id" : "task_id";
    assert.equal(
      (
        await sql`SELECT * FROM ${sql(table)} WHERE ${sql(column)} IN ${sql(ids)}`
      ).length,
      0,
      table,
    );
  }
  assert.equal(
    (
      await sql`SELECT key FROM api_idempotency WHERE task_ids && ${ids}::uuid[] AND key<>'permanent-task-delete'`
    ).length,
    0,
  );
  assert.equal(
    (
      await sql`SELECT key FROM api_idempotency WHERE key='surviving-work-cache'`
    ).length,
    1,
  );
  const replay = await request(`/api/tasks/${parent.id}`, options);
  assert.equal(replay.headers.get("Idempotency-Replayed"), "true");
  assert.deepEqual(await json(replay), { ok: true });
  assert.equal(
    (
      await request(`/api/tasks/${parent.id}`, {
        cookie,
        method: "DELETE",
        body: { version: parent.version },
      })
    ).status,
    404,
  );
  assert.equal(
    (await request(`/api/tasks/${parent.id}`, { cookie })).status,
    404,
  );
  assert.equal(
    (
      await sql`SELECT id FROM activity WHERE task_id IS NULL OR action='task.deleted'`
    ).length,
    0,
  );
  const [remaining] =
    await sql`SELECT version FROM tasks WHERE id=${surviving.id}`;
  assert.equal(remaining.version, surviving.version);
  assert.deepEqual(
    await sql`SELECT * FROM tasks WHERE id IN ${sql([child.id, grandchild.id])} ORDER BY id`,
    independent,
  );
  assert.equal(
    (await task(cookie, work.id, { title: "Next work" })).identifier,
    "WORK-5",
  );
});

test("board deletion requires a human Admin and current version, purges owned rows and scope references, and preserves another board", async () => {
  const { cookie } = await setupUser();
  const colleague = await member(cookie, "member");
  const viewer = await member(cookie, "viewer");
  const removed = await board(cookie, "REMOVE");
  const kept = await board(cookie, "KEEP");
  const parent = await task(
    cookie,
    removed.id,
    { assigneeId: colleague.user.id },
    "board-task-content-cache",
  );
  const child = await task(cookie, removed.id, { status: "in_review" });
  const outside = await task(cookie, kept.id, { title: "Keep this task" });
  const comment = (
    await json(
      await request(`/api/tasks/${child.id}/comments`, {
        cookie,
        body: { body: "Remove this discussion" },
        headers: { "Idempotency-Key": "board-comment-content-cache" },
      }),
      201,
    )
  ).comment;
  const scoped = await setupOAuth(cookie, {
    boardIds: [removed.id],
  });
  const mixed = await setupOAuth(cookie, {
    boardIds: [removed.id, kept.id],
  });
  const personal = await json(
    await request("/api/credentials", {
      cookie,
      body: { name: "Persistent personal key", expiresInDays: 90 },
      headers: { "Idempotency-Key": "personal-credential-cache" },
    }),
    201,
  );
  const memberKey = await json(
    await request("/api/credentials", {
      cookie: colleague.cookie,
      body: { name: "Member automation", expiresInDays: 30 },
    }),
    201,
  );
  assert.equal("agentId" in personal.credential, false);
  assert.equal(personal.credential.boardIds, null);
  for (const auth of [
    { cookie: colleague.cookie },
    { cookie: viewer.cookie },
    { token: memberKey.token },
  ])
    assert.equal(
      (
        await request(`/api/boards/${removed.id}`, {
          ...auth,
          method: "DELETE",
          body: { version: removed.version },
        })
      ).status,
      403,
    );
  assert.equal(
    (
      await request(`/api/boards/${removed.id}`, {
        token: mixed.token,
        method: "DELETE",
        body: { version: removed.version },
      })
    ).status,
    403,
  );
  assert.equal(
    (
      await request(`/api/boards/${removed.id}`, {
        cookie,
        method: "DELETE",
        body: { version: removed.version + 1 },
      })
    ).status,
    409,
  );
  assert.equal(
    (await sql`SELECT id FROM boards WHERE id=${removed.id}`).length,
    1,
  );
  const scopedDelete = await callMcpTool(scoped.token, "delete_task", {
    taskId: outside.id,
    version: outside.version,
  });
  assert.equal(scopedDelete.response.status, 200);
  assert.equal(scopedDelete.result?.isError, true);
  assert.equal(
    (await sql`SELECT id FROM tasks WHERE id=${outside.id}`).length,
    1,
  );
  assert.equal(
    (
      await request(`/api/tasks/${parent.id}`, {
        cookie: viewer.cookie,
        method: "DELETE",
        body: { version: parent.version },
      })
    ).status,
    403,
  );
  assert.equal(
    (
      await request(`/api/tasks/${parent.id}`, {
        cookie,
        method: "DELETE",
        body: { version: parent.version + 1 },
      })
    ).status,
    409,
  );
  const options = {
    token: personal.token,
    method: "DELETE",
    body: { version: removed.version },
    headers: { "Idempotency-Key": "permanent-board-delete" },
  };
  assert.deepEqual(
    await json(await request(`/api/boards/${removed.id}`, options)),
    { ok: true },
  );
  for (const table of ["boards", "tasks", "activity"]) {
    const column = table === "boards" ? "id" : "board_id";
    assert.equal(
      (
        await sql`SELECT * FROM ${sql(table)} WHERE ${sql(column)}=${removed.id}`
      ).length,
      0,
      table,
    );
  }
  assert.equal(
    (await sql`SELECT id FROM comments WHERE id=${comment.id}`).length,
    0,
  );
  assert.equal(
    (await sql`SELECT id FROM notifications WHERE task_id=${parent.id}`).length,
    0,
  );
  assert.equal(
    (
      await sql`SELECT key FROM api_idempotency WHERE board_ids @> ARRAY[${removed.id}::uuid] AND key<>'permanent-board-delete'`
    ).length,
    0,
  );
  const [only] =
    await sql`SELECT * FROM credentials WHERE id=${scoped.credential.id}`;
  assert.deepEqual(only.boardIds, []);
  assert.ok(only.revokedAt);
  const [both] =
    await sql`SELECT * FROM credentials WHERE id=${mixed.credential.id}`;
  assert.deepEqual(both.boardIds, [kept.id]);
  assert.equal(both.revokedAt, null);
  const keptRead = await callMcpTool(mixed.token, "get_task", {
    taskId: outside.id,
  });
  assert.equal(keptRead.response.status, 200);
  assert.equal(keptRead.result?.isError, false);
  assert.equal(
    keptRead.result?.structuredContent?.task &&
      (keptRead.result.structuredContent.task as { id: string }).id,
    outside.id,
  );
  assert.equal(
    (await callMcpTool(scoped.token, "list_boards")).response.status,
    401,
  );
  const [personalRow] =
    await sql`SELECT board_ids,scopes,revoked_at FROM credentials WHERE id=${personal.credential.id}`;
  assert.equal("agentId" in personalRow, false);
  assert.equal(personalRow.boardIds, null);
  assert.deepEqual(personalRow.scopes, []);
  assert.equal(personalRow.revokedAt, null);
  assert.equal(
    (
      await sql`SELECT key FROM api_idempotency WHERE key='personal-credential-cache'`
    ).length,
    1,
  );
  const personalRead = await json(
    await request(`/api/tasks/${outside.id}`, { token: personal.token }),
  );
  assert.equal(personalRead.task.id, outside.id);
  assert.deepEqual(
    (
      await json(await request("/api/boards", { token: personal.token }))
    ).items.map((item: { id: string }) => item.id),
    [kept.id],
  );
  const replay = await request(`/api/boards/${removed.id}`, options);
  assert.equal(replay.headers.get("Idempotency-Replayed"), "true");
  assert.deepEqual(await json(replay), { ok: true });
  assert.equal(
    (
      await request(`/api/boards/${removed.id}`, {
        cookie,
        method: "DELETE",
        body: { version: removed.version },
      })
    ).status,
    404,
  );
  assert.equal(
    (
      await sql`SELECT id FROM activity WHERE task_id IS NULL OR action='board.deleted'`
    ).length,
    0,
  );
  assert.equal(
    (await sql`SELECT version FROM boards WHERE id=${kept.id}`)[0].version,
    kept.version,
  );
});

test("deleting a board removes pending OAuth grants and narrows issued OAuth credentials", async () => {
  const { cookie } = await setupUser();
  const removed = await board(cookie, "OAUTH");
  const kept = await board(cookie, "OTHER");
  const redirect = "http://127.0.0.1:4182/callback";
  const client = await json(
    await request("/oauth/register", {
      body: {
        client_name: "Deletion scope",
        redirect_uris: [redirect],
        token_endpoint_auth_method: "none",
      },
    }),
    201,
  );
  async function grant(boardIds: string[]) {
    const verifier = secret();
    const response = await request(
      `/oauth/authorize?${new URLSearchParams({ response_type: "code", client_id: client.client_id, redirect_uri: redirect, resource: `${process.env.MILL_BASE_URL}/mcp`, scope: "read", code_challenge: digest(verifier), code_challenge_method: "S256" })}`,
    );
    assert.equal(response.status, 302);
    const id = new URL(response.headers.get("location")!).searchParams.get(
      "request",
    )!;
    const consent = await json(
      await request(`/api/oauth/consent/${id}`, {
        cookie,
        body: { allow: true, boardIds },
      }),
    );
    return {
      id,
      verifier,
      code: new URL(consent.redirectTo).searchParams.get("code")!,
    };
  }
  async function exchange(approved: Awaited<ReturnType<typeof grant>>) {
    return app.request("/oauth/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        client_id: client.client_id,
        redirect_uri: redirect,
        resource: `${process.env.MILL_BASE_URL}/mcp`,
        code: approved.code,
        code_verifier: approved.verifier,
      }),
    });
  }
  const pending = await grant([removed.id]);
  const issued = await grant([removed.id, kept.id]);
  const token = await json(await exchange(issued));
  await json(
    await request(`/api/boards/${removed.id}`, {
      cookie,
      method: "DELETE",
      body: { version: removed.version },
    }),
  );
  assert.equal(
    (await sql`SELECT id FROM oauth_requests WHERE id=${pending.id}`).length,
    0,
  );
  assert.equal((await exchange(pending)).status, 400);
  const [credential] =
    await sql`SELECT board_ids,revoked_at FROM credentials WHERE token_hash=${digest(token.access_token)}`;
  assert.deepEqual(credential.boardIds, [kept.id]);
  assert.equal(credential.revokedAt, null);
  assert.equal(
    (
      await sql`SELECT id FROM oauth_requests WHERE ${removed.id}=ANY(board_ids)`
    ).length,
    0,
  );
});

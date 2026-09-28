import { after, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import {
  cleanupDatabase,
  request,
  resetDatabase,
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

test("permanent task deletion purges descendants and content, preserves other work and numbering, and replays safely", async () => {
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
    { parentId: parent.id },
    "child-content-cache",
  );
  const detail = await json(
    await request(`/api/boards/${work.id}`, { cookie }),
  );
  const grandchild = await task(cookie, work.id, {
    parentId: child.id,
    columnId: detail.columns[1].id,
  });
  const surviving = await task(
    cookie,
    work.id,
    { title: "Surviving work" },
    "surviving-work-cache",
  );
  await json(
    await request(`/api/tasks/${child.id}/comments`, {
      cookie,
      body: {
        body: "Private comment content",
        mentionIds: [colleague.user.id],
      },
      headers: { "Idempotency-Key": "child-comment-cache" },
    }),
    201,
  );
  const ids = [parent.id, child.id, grandchild.id];
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
  const auditRows =
    await sql`SELECT * FROM activity WHERE action='task.deleted'`;
  assert.equal(auditRows.length, 1);
  const [audit] = auditRows;
  assert.equal(audit.taskId, null);
  assert.deepEqual(audit.detail, { taskId: parent.id });
  assert.equal(audit.actorId, colleague.user.id);
  const [remaining] =
    await sql`SELECT position,version FROM tasks WHERE id=${surviving.id}`;
  assert.equal(remaining.position, 0);
  assert.ok(remaining.version > surviving.version);
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
  const child = await task(cookie, removed.id, { parentId: parent.id });
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
  const scoped = await json(
    await request("/api/credentials", {
      cookie,
      body: {
        name: "Removed only",
        scopes: ["read", "write"],
        boardIds: [removed.id],
      },
      headers: { "Idempotency-Key": "removed-credential-cache" },
    }),
    201,
  );
  const mixed = await json(
    await request("/api/credentials", {
      cookie,
      body: {
        name: "Both boards",
        scopes: ["read", "write"],
        boardIds: [removed.id, kept.id],
      },
    }),
    201,
  );
  for (const auth of [
    { cookie: colleague.cookie },
    { cookie: viewer.cookie },
    { token: mixed.token },
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
  assert.equal(
    (
      await request(`/api/tasks/${outside.id}`, {
        token: scoped.token,
        method: "DELETE",
        body: { version: outside.version },
      })
    ).status,
    403,
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
    cookie,
    method: "DELETE",
    body: { version: removed.version },
    headers: { "Idempotency-Key": "permanent-board-delete" },
  };
  assert.deepEqual(
    await json(await request(`/api/boards/${removed.id}`, options)),
    { ok: true },
  );
  for (const table of ["boards", "columns", "tasks", "activity"]) {
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
  assert.equal(
    (await request(`/api/tasks/${outside.id}`, { token: mixed.token })).status,
    200,
  );
  assert.equal(
    (await request("/api/boards", { token: scoped.token })).status,
    401,
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
  const [audit] =
    await sql`SELECT * FROM activity WHERE action='board.deleted'`;
  assert.equal(audit.boardId, null);
  assert.equal(audit.taskId, null);
  assert.deepEqual(audit.detail, { boardId: removed.id });
  assert.equal(
    (await sql`SELECT position FROM boards WHERE id=${kept.id}`)[0].position,
    0,
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

test("legacy portable imports activate archives, exclude deleted work and descendants, and retain skipped task numbers", async () => {
  const { cookie } = await setupUser();
  const active = await board(cookie, "LEGACY");
  const removed = await board(cookie, "LEGONE");
  const surviving = await task(cookie, active.id, {
    title: "Archived work becomes ordinary",
  });
  const parent = await task(cookie, active.id, {
    title: "Previously deleted parent",
  });
  await task(cookie, active.id, { parentId: parent.id });
  await task(cookie, removed.id, { title: "Deleted board work" });
  await json(
    await request(`/api/tasks/${parent.id}/comments`, {
      cookie,
      body: { body: "Previously deleted discussion" },
    }),
    201,
  );
  const exported = await json(await request("/api/export", { cookie }));
  exported.version = 1;
  for (const board of exported.boards) {
    delete board.nextNumber;
    board.archived = true;
    board.deletedAt = board.id === removed.id ? new Date().toISOString() : null;
  }
  for (const task of exported.tasks) {
    task.archived = true;
    task.deletedAt = task.id === parent.id ? new Date().toISOString() : null;
  }
  const result = await json(
    await request("/api/import", { cookie, body: exported }),
    201,
  );
  assert.equal(result.imported.boards, 1);
  assert.equal(result.imported.tasks, 1);
  assert.equal(result.imported.comments, 0);
  const rows =
    await sql`SELECT * FROM tasks WHERE board_id=${result.imported.boardIds[0]}`;
  assert.equal(rows[0].title, surviving.title);
  assert.equal(rows[0].parentId, null);
  assert.equal(
    (
      await task(cookie, result.imported.boardIds[0], { title: "New task" })
    ).identifier.endsWith("-4"),
    true,
  );
});

test("forward migration purges previously deleted work, activates archives and removes state columns", async () => {
  const schema = `upgrade_${randomUUID().replaceAll("-", "")}`;
  await sql.begin(async (tx) => {
    await tx.unsafe(`CREATE SCHEMA "${schema}"`);
    await tx.unsafe(`SET LOCAL search_path TO "${schema}"`);
    for (const name of [
      "001_identity.sql",
      "002_boards.sql",
      "003_external.sql",
      "004_http.sql",
    ])
      await tx.unsafe(
        await readFile(
          new URL(`../packages/database/migrations/${name}`, import.meta.url),
          "utf8",
        ),
      );
    const [workspace] =
      await tx`INSERT INTO workspace(id,name) VALUES (${randomUUID()},'Upgrade') RETURNING id`;
    const [user] =
      await tx`INSERT INTO users(id,workspace_id,name,email,role,password_hash) VALUES (${randomUUID()},${workspace.id},'Admin','upgrade@example.test','admin','unused') RETURNING id`;
    const [active] =
      await tx`INSERT INTO boards(workspace_id,name,prefix,position,archived,next_number) VALUES (${workspace.id},'Archived board','ARCH',0,true,10) RETURNING id`;
    const [removed] =
      await tx`INSERT INTO boards(workspace_id,name,prefix,position,deleted_at) VALUES (${workspace.id},'Deleted board','GONE',1,now()) RETURNING id`;
    const [column] =
      await tx`INSERT INTO columns(board_id,name,position) VALUES (${active.id},'Status',0) RETURNING id`;
    const [removedColumn] =
      await tx`INSERT INTO columns(board_id,name,position) VALUES (${removed.id},'Removed',0) RETURNING id`;
    const [parent] =
      await tx`INSERT INTO tasks(board_id,column_id,identifier,title,position,created_by,deleted_at) VALUES (${active.id},${column.id},'ARCH-1','Deleted parent',0,${user.id},now()) RETURNING id`;
    const [child] =
      await tx`INSERT INTO tasks(board_id,column_id,identifier,title,position,created_by,parent_id) VALUES (${active.id},${column.id},'ARCH-2','Child content',1,${user.id},${parent.id}) RETURNING id`;
    await tx`INSERT INTO tasks(board_id,column_id,identifier,title,position,created_by,archived) VALUES (${active.id},${column.id},'ARCH-3','Archived task',2,${user.id},true)`;
    await tx`INSERT INTO tasks(board_id,column_id,identifier,title,position,created_by) VALUES (${removed.id},${removedColumn.id},'GONE-1','Removed work',0,${user.id})`;
    await tx`INSERT INTO comments(task_id,author_id,body) VALUES (${child.id},${user.id},'Remove content')`;
    await tx`INSERT INTO notifications(user_id,task_id,kind,actor_name) VALUES (${user.id},${child.id},'assignment','Admin')`;
    await tx`INSERT INTO activity(task_id,board_id,actor_id,actor_name,actor_kind,action,detail) VALUES (${child.id},${active.id},${user.id},'Admin','human','task.created',${tx.json({ title: "Remove content" })})`;
    await tx`INSERT INTO credentials(user_id,name,token_hash,token_prefix,scopes,board_ids,expires_at) VALUES (${user.id},'Old scope','hash','prefix',ARRAY['read'],ARRAY[${removed.id}::uuid],now()+interval '1 day')`;
    await tx`INSERT INTO api_idempotency(actor_key,key,request_hash,response,status) VALUES (${user.id},'old-content-cache','hash','{}',201)`;
    const [legacyRetry] = await tx`SELECT created_at FROM api_idempotency`;
    await tx.unsafe(
      await readFile(
        new URL(
          "../packages/database/migrations/005_permanent_deletion.sql",
          import.meta.url,
        ),
        "utf8",
      ),
    );
    assert.deepEqual(
      (await tx`SELECT title,position FROM tasks`).map((row) => ({
        title: row.title,
        position: row.position,
      })),
      [{ title: "Archived task", position: 0 }],
    );
    assert.equal((await tx`SELECT next_number FROM boards`)[0].nextNumber, 10);
    for (const table of ["comments", "notifications", "activity"])
      assert.equal((await tx`SELECT * FROM ${tx(table)}`).length, 0, table);
    const [retry] = await tx`SELECT * FROM api_idempotency`;
    assert.equal(retry.actorKey, user.id);
    assert.equal(retry.key, "old-content-cache");
    assert.equal(retry.requestHash, "hash");
    assert.equal(retry.status, 410);
    assert.equal(retry.response, null);
    assert.equal(retry.invalidationReason, "upgrade");
    assert.equal(
      retry.createdAt.toISOString(),
      legacyRetry.createdAt.toISOString(),
    );
    assert.deepEqual(retry.boardIds, []);
    assert.deepEqual(retry.taskIds, []);
    const [credential] = await tx`SELECT board_ids,revoked_at FROM credentials`;
    assert.deepEqual(credential.boardIds, []);
    assert.ok(credential.revokedAt);
    assert.equal(
      (
        await tx`SELECT column_name FROM information_schema.columns WHERE table_schema=${schema} AND column_name IN ('archived','deleted_at')`
      ).length,
      0,
    );
    await tx.unsafe(`DROP SCHEMA "${schema}" CASCADE`);
  });
});

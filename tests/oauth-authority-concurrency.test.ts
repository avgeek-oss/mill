import { after, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import {
  cleanupDatabase,
  request,
  resetDatabase,
  setupOAuth,
  setupUser,
  callMcpTool,
  sql,
} from "./support.js";

beforeEach(resetDatabase);
after(cleanupDatabase);
async function json(response: Response, status = 200) {
  assert.equal(response.status, status, await response.clone().text());
  return response.json();
}
async function fixture() {
  const admin = await setupUser();
  const invitation = await json(
    await request("/api/auth/invitations", {
      cookie: admin.cookie,
      body: { email: "mcp-owner@example.test", role: "member" },
    }),
    201,
  );
  const accepted = await request("/api/auth/accept-invitation", {
    body: {
      token: invitation.token,
      name: "MCP owner",
      password: "Another secure passphrase 42!",
    },
  });
  const member = (await json(accepted, 201)).user;
  const cookie = accepted.headers.get("set-cookie")!.split(";")[0]!;
  const { board } = await json(
    await request("/api/boards", {
      cookie: admin.cookie,
      body: { name: "Shared work", prefix: "MCP" },
    }),
    201,
  );
  const oauth = await setupOAuth(cookie, { boardIds: [board.id] });
  return { admin, member, cookie, board, oauth };
}
async function barrier() {
  let release!: () => void,
    ready!: () => void,
    fail!: (error: unknown) => void,
    pid = 0;
  const started = new Promise<void>((resolve, reject) => {
    ready = resolve;
    fail = reject;
  });
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  const holder = sql.begin(async (tx) => {
    pid = (await tx`SELECT pg_backend_pid() AS pid`)[0].pid;
    await tx`SELECT id FROM workspace FOR UPDATE`;
    ready();
    await released;
  });
  void holder.catch(fail);
  await started;
  return {
    pid,
    async release() {
      release();
      await holder;
    },
  };
}
async function waitForBlocked(pid: number, expected: number) {
  const deadline = Date.now() + 5000;
  do {
    const [row] =
      await sql`WITH RECURSIVE blocked(pid) AS (SELECT pid FROM pg_stat_activity WHERE ${pid}=ANY(pg_blocking_pids(pid)) UNION SELECT activity.pid FROM pg_stat_activity activity JOIN blocked ON blocked.pid=ANY(pg_blocking_pids(activity.pid))) SELECT count(DISTINCT pid)::int AS total FROM blocked`;
    if (row.total >= expected) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  } while (Date.now() < deadline);
  assert.fail(`Expected ${expected} requests blocked by authority ${pid}`);
}

for (const action of ["remove", "downgrade", "revoke"] as const) {
  test(`queued OAuth write rechecks human ${action} after waiting for authority`, async () => {
    const { admin, member, cookie, board, oauth } = await fixture();
    const gate = await barrier();
    let changed!: Promise<Response>, pending!: ReturnType<typeof callMcpTool>;
    try {
      changed =
        action === "revoke"
          ? request(`/api/credentials/${oauth.credential.id}`, {
              cookie,
              method: "DELETE",
            })
          : request(`/api/auth/members/${member.id}`, {
              cookie: admin.cookie,
              method: action === "remove" ? "DELETE" : "PATCH",
              ...(action === "downgrade" ? { body: { role: "viewer" } } : {}),
            });
      await waitForBlocked(gate.pid, 1);
      pending = callMcpTool(oauth.token, "create_task", {
        boardId: board.id,
        title: "Must not persist after access change",
        idempotencyKey: `oauth-${action}-pending`,
      });
      await waitForBlocked(gate.pid, 2);
    } finally {
      await gate.release();
    }
    await json(await changed);
    const denied = await pending;
    assert.ok(
      [401, 403].includes(denied.response.status) || denied.result?.isError,
      JSON.stringify(denied.result),
    );
    assert.equal((await sql`SELECT id FROM tasks`).length, 0);
    assert.equal(
      (
        await sql`SELECT key FROM api_idempotency WHERE key=${`oauth-${action}-pending`}`
      ).length,
      0,
    );
  });
}

test("OAuth retry cannot return an earlier mutation after its human owner becomes a Viewer", async () => {
  const { admin, member, board, oauth } = await fixture();
  const args = {
    boardId: board.id,
    title: "Created while permitted",
    idempotencyKey: "oauth-before-role-change",
  };
  const created = await callMcpTool(oauth.token, "create_task", args);
  assert.equal(created.result?.isError, false);
  await json(
    await request(`/api/auth/members/${member.id}`, {
      cookie: admin.cookie,
      method: "PATCH",
      body: { role: "viewer" },
    }),
  );
  const retry = await callMcpTool(oauth.token, "create_task", args);
  assert.ok(retry.response.status === 403 || retry.result?.isError);
  assert.equal((await sql`SELECT id FROM tasks`).length, 1);
  const read = await callMcpTool(oauth.token, "get_task", {
    taskId: (created.result!.structuredContent!.task as { id: string }).id,
  });
  assert.equal(read.result?.isError, false);
});

for (const action of ["remove", "revoke"] as const) {
  test(`queued OAuth read cannot return task content after human ${action}`, async () => {
    const { admin, member, cookie, board, oauth } = await fixture();
    const { task } = await json(
      await request(`/api/boards/${board.id}/tasks`, {
        cookie: admin.cookie,
        body: { title: "Private content after revocation" },
      }),
      201,
    );
    const gate = await barrier();
    let changed!: Promise<Response>, pending!: ReturnType<typeof callMcpTool>;
    try {
      changed =
        action === "revoke"
          ? request(`/api/credentials/${oauth.credential.id}`, {
              cookie,
              method: "DELETE",
            })
          : request(`/api/auth/members/${member.id}`, {
              cookie: admin.cookie,
              method: "DELETE",
            });
      await waitForBlocked(gate.pid, 1);
      pending = callMcpTool(oauth.token, "get_task", { taskId: task.id });
      await waitForBlocked(gate.pid, 2);
    } finally {
      await gate.release();
    }
    await json(await changed);
    const denied = await pending;
    assert.equal(denied.response.status, 200);
    assert.equal(denied.result?.isError, true);
    assert.equal("task" in (denied.result!.structuredContent ?? {}), false);
    assert.match(
      JSON.stringify(denied.result?.content),
      /credential is no longer active|credential expired or was revoked|membership changed/i,
    );
    assert.doesNotMatch(
      JSON.stringify(denied.result),
      /Private content after revocation/,
    );
  });
}

for (const access of ["session", "personal-key"] as const) {
  test(`queued ${access} read rechecks removed human membership before returning task content`, async () => {
    const { admin, member, cookie, board } = await fixture();
    const { task } = await json(
      await request(`/api/boards/${board.id}/tasks`, {
        cookie: admin.cookie,
        body: { title: "Hidden after membership removal" },
      }),
      201,
    );
    const credential =
      access === "personal-key"
        ? await json(
            await request("/api/credentials", {
              cookie,
              body: { name: "Read race key" },
            }),
            201,
          )
        : null;
    const gate = await barrier();
    let changed!: Promise<Response>, pending!: Promise<Response>;
    try {
      changed = request(`/api/auth/members/${member.id}`, {
        cookie: admin.cookie,
        method: "DELETE",
      });
      await waitForBlocked(gate.pid, 1);
      pending = request(
        `/api/tasks/${task.id}`,
        credential ? { token: credential.token } : { cookie },
      );
      await waitForBlocked(gate.pid, 2);
    } finally {
      await gate.release();
    }
    await json(await changed);
    const denied = await pending;
    assert.equal(denied.status, 401);
    assert.doesNotMatch(await denied.text(), /Hidden after membership removal/);
  });
}

for (const first of ["password", "read"] as const) {
  test(`password change and authenticated reads serialize without a lock inversion when ${first} queues first`, async () => {
    const { admin, board } = await fixture();
    const { task } = await json(
      await request(`/api/boards/${board.id}/tasks`, {
        cookie: admin.cookie,
        body: { title: "Password race content" },
      }),
      201,
    );
    const gate = await barrier();
    const change = () =>
      request("/api/auth/password", {
        cookie: admin.cookie,
        body: {
          currentPassword: "Secure test passphrase 42!",
          password: "New secure password for the race 42!",
        },
      });
    const read = () =>
      request(`/api/tasks/${task.id}`, { cookie: admin.cookie });
    let earlier!: Promise<Response>, later!: Promise<Response>;
    try {
      earlier = first === "password" ? change() : read();
      await waitForBlocked(gate.pid, 1);
      later = first === "password" ? read() : change();
      await waitForBlocked(gate.pid, 2);
    } finally {
      await gate.release();
    }
    const changed = await (first === "password" ? earlier : later);
    const result = await (first === "password" ? later : earlier);
    await json(changed);
    const content = await json(result);
    assert.equal(content.task.title, "Password race content");
    assert.equal(
      (await request(`/api/tasks/${task.id}`, { cookie: admin.cookie })).status,
      200,
    );
    const oldPassword = await request("/api/auth/login", {
      body: { email: admin.user.email, password: "Secure test passphrase 42!" },
    });
    assert.equal(oldPassword.status, 401);
  });
}

for (const operation of ["create_task", "update_task"] as const) {
  test(`queued OAuth ${operation} retry cannot replay write content after its scope is reduced to read`, async () => {
    const { board, oauth } = await fixture();
    const first = await callMcpTool(oauth.token, "create_task", {
      boardId: board.id,
      title: "Scope-sensitive cached content",
      idempotencyKey: "oauth-scope-cached-create",
    });
    assert.equal(first.result?.isError, false);
    const task = first.result!.structuredContent!.task as {
      id: string;
      version: number;
    };
    const args =
      operation === "create_task"
        ? {
            boardId: board.id,
            title: "Scope-sensitive cached content",
            idempotencyKey: "oauth-scope-cached-create",
          }
        : {
            taskId: task.id,
            version: task.version,
            title: "Scope-sensitive cached edit",
            idempotencyKey: "oauth-scope-cached-update",
          };
    if (operation === "update_task") {
      const changed = await callMcpTool(oauth.token, operation, args);
      assert.equal(changed.result?.isError, false);
    }
    const snapshot = await sql`SELECT * FROM tasks`;
    const gate = await barrier();
    let narrowed!: Promise<unknown>, pending!: ReturnType<typeof callMcpTool>;
    try {
      narrowed = sql.begin(async (tx) => {
        await tx`SELECT id FROM workspace FOR UPDATE`;
        await tx`UPDATE credentials SET scopes=ARRAY['read'] WHERE id=${oauth.credential.id}`;
      });
      await waitForBlocked(gate.pid, 1);
      pending = callMcpTool(oauth.token, operation, args);
      await waitForBlocked(gate.pid, 2);
    } finally {
      await gate.release();
    }
    await narrowed;
    const denied = await pending;
    assert.equal(denied.result?.isError, true, JSON.stringify(denied));
    assert.doesNotMatch(
      JSON.stringify(denied.result),
      /Scope-sensitive cached content|Scope-sensitive cached edit/,
    );
    assert.deepEqual(await sql`SELECT * FROM tasks`, snapshot);
  });
}

for (const withRetry of [false, true]) {
  test(`queued OAuth board creation ${withRetry ? "with" : "without"} a retry key rechecks a newly restricted board grant`, async () => {
    const { cookie } = await setupUser();
    const { board } = await json(
      await request("/api/boards", {
        cookie,
        body: { name: "Selected board", prefix: "KEEP" },
      }),
      201,
    );
    const oauth = await setupOAuth(cookie, {});
    const gate = await barrier();
    let narrowed!: Promise<unknown>, pending!: ReturnType<typeof callMcpTool>;
    try {
      narrowed = sql.begin(async (tx) => {
        await tx`SELECT id FROM workspace FOR UPDATE`;
        await tx`UPDATE credentials SET board_ids=ARRAY[${board.id}::uuid] WHERE id=${oauth.credential.id}`;
      });
      await waitForBlocked(gate.pid, 1);
      pending = callMcpTool(oauth.token, "create_board", {
        name: "Must not create after restriction",
        ...(withRetry
          ? { idempotencyKey: "oauth-board-after-grant-limit" }
          : {}),
      });
      await waitForBlocked(gate.pid, 2);
    } finally {
      await gate.release();
    }
    await narrowed;
    const denied = await pending;
    assert.equal(denied.result?.isError, true, JSON.stringify(denied));
    assert.equal(
      (
        await sql`SELECT id FROM boards WHERE name='Must not create after restriction'`
      ).length,
      0,
    );
    assert.equal(
      (
        await sql`SELECT key FROM api_idempotency WHERE key='oauth-board-after-grant-limit'`
      ).length,
      0,
    );
  });
}

for (const changedAccess of ["scope", "boards"] as const) {
  test(`queued all-notifications retry cannot replay an aggregate after its OAuth ${changedAccess} grant narrows`, async () => {
    const { admin, member, cookie, board: first } = await fixture();
    const { board: second } = await json(
      await request("/api/boards", {
        cookie: admin.cookie,
        body: { name: "Another board", prefix: "NEXT" },
      }),
      201,
    );
    for (const board of [first, second]) {
      await json(
        await request(`/api/boards/${board.id}/tasks`, {
          cookie: admin.cookie,
          body: { title: "Mention notification target", assigneeId: member.id },
        }),
        201,
      );
    }
    const oauth = await setupOAuth(cookie, {});
    const args = {
      all: true,
      read: true,
      idempotencyKey: `oauth-aggregate-${changedAccess}`,
    };
    const initial = await callMcpTool(oauth.token, "mark_notifications", args);
    assert.equal(
      initial.result?.isError,
      false,
      JSON.stringify(initial.result),
    );
    assert.equal(initial.result?.structuredContent?.updated, 2);
    const [cache] =
      await sql`SELECT board_ids FROM api_idempotency WHERE actor_key=${oauth.credential.id} AND key=${args.idempotencyKey}`;
    assert.deepEqual([...cache.boardIds].sort(), [first.id, second.id].sort());
    const snapshot = await sql`SELECT * FROM notifications ORDER BY id`;
    const gate = await barrier();
    let changed!: Promise<unknown>, pending!: ReturnType<typeof callMcpTool>;
    try {
      changed = sql.begin(async (tx) => {
        await tx`SELECT id FROM workspace FOR UPDATE`;
        if (changedAccess === "scope")
          await tx`UPDATE credentials SET scopes=ARRAY['read'] WHERE id=${oauth.credential.id}`;
        else
          await tx`UPDATE credentials SET board_ids=ARRAY[${first.id}::uuid] WHERE id=${oauth.credential.id}`;
      });
      await waitForBlocked(gate.pid, 1);
      pending = callMcpTool(oauth.token, "mark_notifications", args);
      await waitForBlocked(gate.pid, 2);
    } finally {
      await gate.release();
    }
    await changed;
    const denied = await pending;
    assert.equal(denied.result?.isError, true, JSON.stringify(denied.result));
    if (changedAccess === "boards")
      assert.equal(denied.result?.structuredContent?.code, "retry_invalidated");
    else
      assert.match(
        JSON.stringify(denied.result?.content),
        /does not permit notification changes/,
      );
    assert.equal(denied.result?.structuredContent?.updated, undefined);
    assert.deepEqual(
      await sql`SELECT * FROM notifications ORDER BY id`,
      snapshot,
    );
  });
}

test("browser session cannot replay a cached task edit after its human becomes a Viewer", async () => {
  const { admin, member, cookie, board } = await fixture();
  const { task } = await json(
    await request(`/api/boards/${board.id}/tasks`, {
      cookie,
      body: { title: "Task before role change" },
    }),
    201,
  );
  const input = { version: task.version, title: "Private cached edited title" };
  const headers = { "Idempotency-Key": "browser-edit-before-demotion" };
  const path = `/api/tasks/${task.id}`;
  const edit = await json(
    await request(path, { cookie, method: "PATCH", body: input, headers }),
  );
  assert.equal(edit.task.title, input.title);
  await json(
    await request(`/api/auth/members/${member.id}`, {
      cookie: admin.cookie,
      method: "PATCH",
      body: { role: "viewer" },
    }),
  );
  const snapshot = await sql`SELECT * FROM tasks ORDER BY id`;
  const replay = await request(path, {
    cookie,
    method: "PATCH",
    body: input,
    headers,
  });
  assert.equal(replay.status, 403);
  assert.doesNotMatch(await replay.text(), /Private cached edited title/);
  assert.deepEqual(await sql`SELECT * FROM tasks ORDER BY id`, snapshot);
});

test("browser session cannot replay a cached workspace edit after its administrator becomes a Member", async () => {
  const { admin, member } = await fixture();
  await json(
    await request(`/api/auth/members/${member.id}`, {
      cookie: admin.cookie,
      method: "PATCH",
      body: { role: "admin" },
    }),
  );
  const input = { name: "Private cached workspace name" };
  const headers = { "Idempotency-Key": "browser-workspace-before-demotion" };
  await json(
    await request("/api/workspace", {
      cookie: admin.cookie,
      method: "PATCH",
      body: input,
      headers,
    }),
  );
  await sql`UPDATE users SET role='member' WHERE id=${admin.user.id}`;
  const snapshot = await sql`SELECT * FROM workspace`;
  const replay = await request("/api/workspace", {
    cookie: admin.cookie,
    method: "PATCH",
    body: input,
    headers,
  });
  assert.equal(replay.status, 403);
  assert.doesNotMatch(await replay.text(), /Private cached workspace name/);
  assert.deepEqual(await sql`SELECT * FROM workspace`, snapshot);
});

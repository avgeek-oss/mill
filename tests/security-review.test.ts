import { after, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

const {
  cleanupDatabase,
  request,
  resetDatabase,
  setupOAuth,
  callMcpTool,
  setupUser,
  sql,
} = await import("./support.js");
const { digest, secret } = await import("../apps/api/src/external/protocol.js");
beforeEach(resetDatabase);
after(cleanupDatabase);

async function fixture(scopes: string[] = ["read", "write"]) {
  const { cookie, user } = await setupUser();
  const first = await (
    await request("/api/boards", {
      cookie,
      body: { name: "Private board", prefix: "PRIV" },
    })
  ).json();
  const second = await (
    await request("/api/boards", {
      cookie,
      body: { name: "Allowed board", prefix: "ALLOW" },
    })
  ).json();
  const oauth = await setupOAuth(cookie, {
    scopes: scopes as ("read" | "write")[],
    boardIds: [second.board.id],
  });
  const created = await request("/api/credentials", {
    cookie,
    body: {
      name: "Personal automation",
      access: "edit",
      includeAdmin: false,
      expiresAt: new Date(Date.now() + 30 * 86400000).toISOString(),
    },
  });
  assert.equal(created.status, 201);
  const personal = await created.json();
  return {
    cookie,
    user,
    privateBoard: first.board,
    allowedBoard: second.board,
    token: oauth.token,
    restToken: personal.token,
  };
}

test("a board-restricted OAuth connection cannot gain administration while personal keys use current human permissions", async () => {
  const { cookie, token, restToken, allowedBoard, privateBoard, user } =
    await fixture();
  const before = await sql`SELECT id,name,version FROM boards ORDER BY id`;
  const update = await callMcpTool(token, "update_board", {
    boardId: privateBoard.id,
    version: privateBoard.version,
    name: "Captured board",
  });
  assert.equal(update.response.status, 200);
  assert.equal(update.result?.isError, true);
  assert.deepEqual(
    await sql`SELECT id,name,version FROM boards ORDER BY id`,
    before,
  );
  const unscopedCreate = await callMcpTool(token, "create_board", {
    name: "Scope escape",
  });
  assert.equal(unscopedCreate.response.status, 403);
  assert.equal(unscopedCreate.error, "insufficient_scope");
  assert.equal(
    (await sql`SELECT id FROM boards WHERE name='Scope escape'`).length,
    0,
  );
  for (const [path, method, body] of [
    ["/api/credentials", "POST", { name: "Escalation", expiresInDays: 30 }],
    [
      "/api/auth/invitations",
      "POST",
      { email: "outsider@example.test", role: "admin" },
    ],
    ["/api/workspace", "PATCH", { name: "Captured workspace" }],
  ] as const) {
    assert.equal(
      (await request(path, { token, method, body })).status,
      403,
      path,
    );
    assert.equal(
      (await request(path, { token: restToken, method, body })).status,
      403,
      path,
    );
  }
  const list = await callMcpTool(token, "list_boards");
  assert.equal(list.result?.isError, false);
  assert.deepEqual(
    (list.result?.structuredContent?.items as { id: string }[]).map(
      (board) => board.id,
    ),
    [allowedBoard.id],
  );
  assert.equal(
    (await callMcpTool(token, "get_board", { boardId: privateBoard.id })).result
      ?.isError,
    true,
  );
  const future = await request("/api/boards", {
    cookie,
    body: { name: "Future board" },
  });
  assert.equal(future.status, 201);
  const futureBoard = (await future.json()).board;
  const personalList = await (
    await request("/api/boards", { token: restToken })
  ).json();
  assert.deepEqual(
    new Set(personalList.items.map((board: { id: string }) => board.id)),
    new Set([privateBoard.id, allowedBoard.id, futureBoard.id]),
  );
  const humanTask = await request(`/api/boards/${futureBoard.id}/tasks`, {
    token: restToken,
    body: { title: "Human API key work" },
  });
  assert.equal(humanTask.status, 201);
  const human = (await humanTask.json()).task;
  const [humanEvent] =
    await sql`SELECT actor_id,actor_name,actor_kind FROM activity WHERE task_id=${human.id} AND action='task.created'`;
  assert.equal(humanEvent.actorId, user.id);
  assert.equal(humanEvent.actorName, user.name);
  assert.equal(humanEvent.actorKind, "human");
  const oauthTask = await callMcpTool(token, "create_task", {
    boardId: allowedBoard.id,
    title: "OAuth work",
  });
  assert.equal(oauthTask.result?.isError, false);
  const [oauthEvent] =
    await sql`SELECT actor_id,actor_name,actor_kind FROM activity WHERE task_id=${(oauthTask.result?.structuredContent?.task as { id: string }).id} AND action='task.created'`;
  assert.equal(oauthEvent.actorId, user.id);
  assert.equal(oauthEvent.actorName, user.name);
  assert.equal(oauthEvent.actorKind, "oauth");
});

test("removed status, subtask, move and portable routes cannot mutate the workspace", async () => {
  const { cookie, restToken, allowedBoard } = await fixture();
  const response = await request(`/api/boards/${allowedBoard.id}/tasks`, {
    cookie,
    body: { title: "Keep task" },
  });
  assert.equal(response.status, 201);
  const { task } = await response.json();
  const before = {
    boards: await sql`SELECT * FROM boards ORDER BY id`,
    tasks: await sql`SELECT * FROM tasks ORDER BY id`,
    history: await sql`SELECT * FROM activity ORDER BY id`,
  };
  for (const access of [{ cookie }, { token: restToken }])
    for (const [path, method, body] of [
      ["/api/export", "GET", undefined],
      ["/api/import", "POST", {}],
      [`/api/boards/${allowedBoard.id}/columns`, "GET", undefined],
      [
        `/api/boards/${allowedBoard.id}/columns`,
        "POST",
        { name: "Custom status" },
      ],
      [
        `/api/columns/${randomUUID()}`,
        "PATCH",
        { version: 1, name: "Custom status" },
      ],
      [`/api/columns/${randomUUID()}`, "DELETE", { version: 1 }],
      [
        `/api/tasks/${task.id}/move`,
        "POST",
        { version: task.version, status: "done" },
      ],
      [`/api/tasks/${task.id}/subtasks`, "GET", undefined],
    ] as const)
      assert.equal(
        (await request(path, { ...access, method, body })).status,
        404,
        `${method} ${path}`,
      );
  assert.deepEqual(await sql`SELECT * FROM boards ORDER BY id`, before.boards);
  assert.deepEqual(await sql`SELECT * FROM tasks ORDER BY id`, before.tasks);
  assert.deepEqual(
    await sql`SELECT * FROM activity ORDER BY id`,
    before.history,
  );
});

test("mixed accessible and inaccessible notification IDs fail without any update", async () => {
  const { token, user, privateBoard, allowedBoard } = await fixture();
  const makeTask = async (boardId: string) => {
    const [task] =
      await sql`INSERT INTO tasks(board_id,status,identifier,title,created_by) VALUES(${boardId},'todo',${randomUUID()},'Notification target',${user.id}) RETURNING id`;
    const [notification] =
      await sql`INSERT INTO notifications(user_id,task_id,kind,actor_name) VALUES(${user.id},${task.id},'mention','Another person') RETURNING id`;
    return notification.id;
  };
  const accessible = await makeTask(allowedBoard.id);
  const inaccessible = await makeTask(privateBoard.id);
  const result = await callMcpTool(token, "mark_notifications", {
    ids: [accessible, inaccessible],
    read: true,
  });
  assert.equal(result.response.status, 200);
  assert.equal(result.result?.isError, true);
  const rows = await sql`SELECT id,read_at FROM notifications ORDER BY id`;
  assert.equal(
    rows.every((row) => row.readAt === null),
    true,
  );
  const listing = await callMcpTool(token, "list_notifications");
  assert.equal(listing.result?.isError, false);
  assert.deepEqual(
    (listing.result?.structuredContent?.items as { id: string }[]).map(
      (item) => item.id,
    ),
    [accessible],
  );
  assert.equal(listing.result?.structuredContent?.unreadCount, 1);
});

test("OAuth tokens must match the canonical MCP resource and cannot call REST directly", async () => {
  const { user } = await setupUser();
  const baseUrl = new URL(process.env.MILL_BASE_URL!);
  const resource = new URL("/mcp", baseUrl).href;
  const restUrl = new URL("/api/boards", baseUrl);
  const token = `mill_${secret()}`;
  const [credential] =
    await sql`INSERT INTO credentials(user_id,name,token_hash,token_prefix,scopes,token_type,resource,expires_at) VALUES(${user.id},'Wrong audience',${digest(token)},${token.slice(0, 12)},${["read"]},'oauth','https://old.example.test/mcp',now()+interval '1 day') RETURNING id`;
  const { credentialActor } =
    await import("../apps/api/src/external/credentials.js");
  const headers = { authorization: `Bearer ${token}` };
  assert.equal(await credentialActor(new Request(resource, { headers })), null);
  await sql`UPDATE credentials SET resource=${resource} WHERE id=${credential.id}`;
  assert.equal(
    (await credentialActor(new Request(resource, { headers })))?.kind,
    "oauth",
  );
  await assert.rejects(
    credentialActor(new Request(restUrl, { headers })),
    (error: unknown) =>
      error instanceof Error &&
      "status" in error &&
      error.status === 403 &&
      error.message === "OAuth credentials use MCP",
  );
});

test("idempotency remains atomic when a late response failure follows a domain mutation", async () => {
  const { user } = await setupUser();
  const { Hono } = await import("hono");
  const { idempotency } = await import("../apps/api/src/middleware.js");
  const probe = new Hono<import("../apps/api/src/http.js").Env>();
  probe.use("*", async (c, next) => {
    c.set("actor", {
      userId: user.id,
      name: user.name,
      role: "admin",
      kind: "human",
      scopes: ["read", "write"],
    });
    await next();
  });
  probe.use("/api/*", idempotency);
  probe.onError((_error, c) =>
    c.json({ error: "Simulated response failure" }, 500),
  );
  probe.post("/api/security-late-failure", async () => {
    await sql.begin(async (tx) => {
      await tx`INSERT INTO boards(workspace_id,name,prefix) SELECT id,'Must roll back','FAIL' FROM workspace`;
    });
    throw new Error("Security review simulated response failure");
  });
  const response = await probe.request("/api/security-late-failure", {
    method: "POST",
    headers: {
      "Idempotency-Key": "security-late-failure",
      "Content-Type": "application/json",
    },
    body: "{}",
  });
  assert.equal(response.status, 500);
  assert.equal(
    (await sql`SELECT id FROM boards WHERE prefix='FAIL'`).length,
    0,
  );
  assert.equal(
    (
      await sql`SELECT key FROM api_idempotency WHERE key='security-late-failure'`
    ).length,
    0,
  );
});

test("REST and MCP resolve task, comment, and activity IDs through board scope", async () => {
  const { cookie, token, restToken, privateBoard, allowedBoard, user } =
    await fixture();
  const privateTaskResponse = await request(
    `/api/boards/${privateBoard.id}/tasks`,
    { cookie, body: { title: "Hidden task" } },
  );
  assert.equal(privateTaskResponse.status, 201);
  const { task: privateTask } = await privateTaskResponse.json();
  const { task: allowedTask } = await (
    await request(`/api/boards/${allowedBoard.id}/tasks`, {
      cookie,
      body: { title: "Accessible task" },
    })
  ).json();
  const commentResponse = await request(
    `/api/tasks/${privateTask.id}/comments`,
    { cookie, body: { body: "Hidden comment" } },
  );
  const { comment } = await commentResponse.json();
  for (const path of [
    `/api/tasks/${privateTask.id}`,
    `/api/tasks/${privateTask.id}/comments`,
    `/api/tasks/${privateTask.id}/activity`,
  ]) {
    assert.equal((await request(path, { token })).status, 403, path);
    assert.equal((await request(path, { token: restToken })).status, 200, path);
  }
  assert.equal(
    (
      await request(`/api/comments/${comment.id}`, {
        token,
        method: "PATCH",
        body: { version: comment.version, body: "Scope bypass" },
      })
    ).status,
    403,
  );
  for (const credentials of [{ cookie }, { token: restToken }])
    assert.equal(
      (
        await request(`/api/comments/${comment.id}`, {
          ...credentials,
          method: "PATCH",
          body: { version: comment.version, body: "Removed edit endpoint" },
        })
      ).status,
      404,
    );
  const commentBypass = await callMcpTool(token, "delete_comment", {
    commentId: comment.id,
    version: comment.version,
  });
  assert.equal(commentBypass.result?.isError, true);
  assert.equal(
    (await sql`SELECT body FROM comments WHERE id=${comment.id}`)[0].body,
    "Hidden comment",
  );
  const call = async (name: string, args: Record<string, unknown>) => {
    const result = await callMcpTool(token, name, args);
    assert.equal(result.response.status, 200);
    assert.ok(result.result, JSON.stringify(result));
    return result.result;
  };
  for (const name of ["get_task", "list_comments", "get_activity"]) {
    assert.equal(
      (await call(name, { taskId: privateTask.id })).isError,
      true,
      name,
    );
  }
  assert.equal(
    (await call("get_task", { taskId: allowedTask.id })).isError,
    false,
  );
  const otherId = randomUUID();
  await sql`INSERT INTO users(id,workspace_id,name,email,password_hash,role) SELECT ${otherId},workspace_id,'Other author','other-author@example.test',password_hash,'member' FROM users WHERE id=${user.id}`;
  const [otherComment] =
    await sql`INSERT INTO comments(task_id,author_id,body) VALUES(${allowedTask.id},${otherId},'Another person comment') RETURNING id,version`;
  const moderation = await call("delete_comment", {
    commentId: otherComment.id,
    version: otherComment.version,
  });
  assert.equal(moderation.isError, true);
  assert.equal(
    (await sql`SELECT body FROM comments WHERE id=${otherComment.id}`)[0].body,
    "Another person comment",
  );
});

async function changeAccessWhileWriteWaits(
  action: "remove" | "downgrade" | "revoke",
  access: "session" | "personal-key" = "session",
) {
  const { cookie, user: admin } = await setupUser();
  const { board } = await (
    await request("/api/boards", {
      cookie,
      body: { name: "Access race board", prefix: "RACE" },
    })
  ).json();
  const memberId = randomUUID();
  const sessionToken = secret();
  const { hashToken } = await import("../apps/api/src/auth/security.js");
  await sql`INSERT INTO users(id,workspace_id,name,email,password_hash,role) SELECT ${memberId},workspace_id,'Pending member','pending-member@example.test',password_hash,'member' FROM users WHERE id=${admin.id}`;
  await sql`INSERT INTO sessions(id,user_id,token_hash,user_agent,expires_at,security_epoch) VALUES(${randomUUID()},${memberId},${hashToken(sessionToken)},'Security race test',now()+interval '1 day',0)`;
  const memberCookie = `mill_session=${sessionToken}`;
  const credentialResponse =
    action === "revoke" || access === "personal-key"
      ? await request("/api/credentials", {
          cookie: memberCookie,
          body: {
            name: "Pending personal key",
            access: "edit",
            includeAdmin: false,
            expiresAt: new Date(Date.now() + 30 * 86400000).toISOString(),
          },
        })
      : null;
  const credential = credentialResponse
    ? await credentialResponse.json()
    : null;
  if (credential)
    assert.equal(
      (await request("/api/boards", { token: credential.token })).status,
      200,
    );
  let release!: () => void;
  let locked!: () => void;
  let holderPid = 0;
  const ready = new Promise<void>((resolve) => {
    locked = resolve;
  });
  const unblock = new Promise<void>((resolve) => {
    release = resolve;
  });
  const holder = sql.begin(async (tx) => {
    const [backend] = await tx`SELECT pg_backend_pid() AS pid`;
    holderPid = backend.pid;
    await tx`SELECT id FROM workspace FOR UPDATE`;
    locked();
    await unblock;
  });
  await ready;
  async function waitForBlocked(expected: number) {
    for (let attempt = 0; attempt < 100; attempt++) {
      const [wait] = await sql`WITH RECURSIVE blocked(pid) AS (
          SELECT pid FROM pg_stat_activity WHERE ${holderPid}=ANY(pg_blocking_pids(pid))
          UNION SELECT activity.pid FROM pg_stat_activity activity JOIN blocked ON blocked.pid=ANY(pg_blocking_pids(activity.pid))
        ) SELECT count(DISTINCT pid)::int AS total FROM blocked`;
      if (wait.total >= expected) return;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.fail(
      `Expected ${expected} actual requests waiting on the workspace authority lock`,
    );
  }
  let changed!: Promise<Response>;
  let pending!: Promise<Response>;
  try {
    changed =
      action === "revoke"
        ? request(`/api/credentials/${credential.credential.id}`, {
            cookie: memberCookie,
            method: "DELETE",
          })
        : action === "downgrade"
          ? request(`/api/auth/members/${memberId}`, {
              cookie,
              method: "PATCH",
              body: { role: "viewer" },
            })
          : request(`/api/auth/members/${memberId}`, {
              cookie,
              method: "DELETE",
            });
    await waitForBlocked(1);
    pending = request(`/api/boards/${board.id}/tasks`, {
      ...(credential ? { token: credential.token } : { cookie: memberCookie }),
      body: { title: "Access changed while waiting" },
    });
    await waitForBlocked(2);
  } finally {
    release();
    await holder;
  }
  const changedResponse = await changed;
  assert.equal(changedResponse.status, 200);
  const result = await pending;
  assert.ok(
    [401, 403].includes(result.status),
    `Pending ${action} write returned ${result.status}`,
  );
  assert.equal(
    (await sql`SELECT id FROM tasks WHERE title='Access changed while waiting'`)
      .length,
    0,
  );
}

for (const action of ["remove", "downgrade", "revoke"] as const) {
  test(`access ${action} queued first prevents a mutation waiting on workspace authority`, async () =>
    changeAccessWhileWriteWaits(action));
}

for (const action of ["remove", "downgrade"] as const) {
  test(`personal key ${action} queued first prevents a write under stale human-owner permissions`, async () =>
    changeAccessWhileWriteWaits(action, "personal-key"));
}

test("anonymous rate limits isolate actual peers and ignore untrusted forwarded headers", async () => {
  const { app } = await import("../apps/api/src/app.js");
  const { IncomingMessage } = await import("node:http");
  const { Socket } = await import("node:net");
  const previous = process.env.MILL_TRUSTED_PROXY_IPS;
  const fromPeer = async (peer: string, forwarded?: string) => {
    const socket = new Socket();
    Object.defineProperty(socket, "remoteAddress", { value: peer });
    const incoming = new IncomingMessage(socket);
    try {
      return await app.fetch(
        new Request("http://localhost:4321/api/auth/status", {
          headers: forwarded ? { "X-Forwarded-For": forwarded } : {},
        }),
        { incoming },
      );
    } finally {
      socket.destroy();
    }
  };
  try {
    process.env.MILL_TRUSTED_PROXY_IPS = "";
    await sql`INSERT INTO request_limits(key,count,reset_at) VALUES('anonymous:203.0.113.10',120,now()+interval '1 minute')`;
    assert.equal((await fromPeer("203.0.113.10", "198.51.100.10")).status, 429);
    assert.equal((await fromPeer("203.0.113.11", "203.0.113.10")).status, 200);
    process.env.MILL_TRUSTED_PROXY_IPS = "203.0.113.10";
    assert.equal((await fromPeer("203.0.113.10", "198.51.100.10")).status, 200);
    await sql`UPDATE request_limits SET count=120 WHERE key='anonymous:198.51.100.10'`;
    assert.equal(
      (await fromPeer("203.0.113.10", "198.51.100.20, 198.51.100.10")).status,
      429,
    );
  } finally {
    if (previous === undefined) delete process.env.MILL_TRUSTED_PROXY_IPS;
    else process.env.MILL_TRUSTED_PROXY_IPS = previous;
  }
});

test("retrying credential creation returns the same secret while encrypting stored retry responses", async () => {
  const { cookie } = await setupUser();
  const options = {
    cookie,
    body: {
      name: "Retried credential",
      access: "edit",
      includeAdmin: false,
      expiresAt: new Date(Date.now() + 30 * 86400000).toISOString(),
    },
    headers: { "Idempotency-Key": "security-credential-retry" },
  };
  const firstResponse = await request("/api/credentials", options);
  assert.equal(firstResponse.status, 201);
  const first = await firstResponse.json();
  const retryResponse = await request("/api/credentials", options);
  assert.equal(retryResponse.status, 201);
  assert.equal(retryResponse.headers.get("Idempotency-Replayed"), "true");
  const retry = await retryResponse.json();
  assert.deepEqual(retry, first);
  assert.equal(
    (await sql`SELECT id FROM credentials WHERE name='Retried credential'`)
      .length,
    1,
  );
  const [record] =
    await sql`SELECT response FROM api_idempotency WHERE key='security-credential-retry'`;
  assert.equal(JSON.stringify(record.response).includes(first.token), false);
  assert.ok(record.response.iv && record.response.tag && record.response.data);
});

test("MCP can read a task with a valid long description and a long discussion", async () => {
  const { cookie, user, token, allowedBoard } = await fixture(["read"]);
  const createdResponse = await request(
    `/api/boards/${allowedBoard.id}/tasks`,
    {
      cookie,
      body: {
        title: "Long but valid task",
        description: "Detailed context ".repeat(5000),
      },
    },
  );
  assert.equal(createdResponse.status, 201);
  const { task } = await createdResponse.json();
  await sql`INSERT INTO comments(task_id,author_id,body,created_at) SELECT ${task.id},${user.id},${"Discussion ".repeat(900)},now()+sequence*interval '1 millisecond' FROM generate_series(1,100) sequence`;
  const response = await callMcpTool(token, "get_task", {
    taskId: task.id,
    commentLimit: 10,
  });
  assert.equal(response.response.status, 200);
  const result = response.result!;
  assert.equal(result.isError, false, JSON.stringify(result));
  const content = result.structuredContent as {
    task: { id: string; description: string };
    comments: { body: string }[];
    commentsPage: { hasMore: boolean };
  };
  assert.equal(content.task.id, task.id);
  assert.equal(content.task.description, task.description);
  assert.equal(content.comments.length, 10);
  assert.equal(content.comments[0]!.body, "Discussion ".repeat(900));
  assert.equal(content.commentsPage.hasMore, true);
  assert.equal("subtasks" in content, false);
  assert.equal("parent" in content, false);
});

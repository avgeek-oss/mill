import { after, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

const { cleanupDatabase, request, resetDatabase, setupUser, sql } =
  await import("./support.js");
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
  const created = await (
    await request("/api/credentials", {
      cookie,
      body: { name: "Scoped reviewer", scopes, boardIds: [second.board.id] },
    })
  ).json();
  assert.ok(created.token);
  return {
    cookie,
    user,
    privateBoard: first.board,
    allowedBoard: second.board,
    token: created.token,
  };
}

test("a board-restricted agent cannot reorder other boards or gain administration", async () => {
  const { token, cookie, allowedBoard, privateBoard } = await fixture();
  const before = await sql`SELECT id,position,version FROM boards ORDER BY id`;
  const reorder = await request(`/api/boards/${allowedBoard.id}`, {
    token,
    method: "PATCH",
    body: { version: allowedBoard.version, beforeId: privateBoard.id },
  });
  assert.equal(reorder.status, 403);
  assert.deepEqual(
    await sql`SELECT id,position,version FROM boards ORDER BY id`,
    before,
  );
  for (const [path, method, body] of [
    [
      "/api/credentials",
      "POST",
      { name: "Escalation", scopes: ["read", "write"] },
    ],
    [
      "/api/auth/invitations",
      "POST",
      { email: "outsider@example.test", role: "admin" },
    ],
    ["/api/workspace", "PATCH", { name: "Captured workspace" }],
    ["/api/export", "GET", undefined],
  ] as const) {
    const response = await request(path, { token, method, body });
    assert.equal(response.status, 403, path);
  }
  const list = await (await request("/api/boards", { token })).json();
  assert.deepEqual(
    list.items.map((board: { id: string }) => board.id),
    [allowedBoard.id],
  );
  assert.equal(
    (await request(`/api/boards/${privateBoard.id}`, { token })).status,
    403,
  );
  assert.equal((await request("/api/export", { cookie })).status, 200);
});

test("mixed accessible and inaccessible notification IDs fail without any update", async () => {
  const { token, user, privateBoard, allowedBoard } = await fixture();
  const makeTask = async (boardId: string) => {
    const [column] =
      await sql`SELECT id FROM columns WHERE board_id=${boardId} ORDER BY position LIMIT 1`;
    const [task] =
      await sql`INSERT INTO tasks(board_id,column_id,identifier,title,created_by,position) VALUES(${boardId},${column.id},${randomUUID()},'Notification target',${user.id},0) RETURNING id`;
    const [notification] =
      await sql`INSERT INTO notifications(user_id,task_id,kind,actor_name) VALUES(${user.id},${task.id},'mention','Another person') RETURNING id`;
    return notification.id;
  };
  const accessible = await makeTask(allowedBoard.id);
  const inaccessible = await makeTask(privateBoard.id);
  const result = await request("/api/notifications", {
    token,
    method: "PATCH",
    body: { ids: [accessible, inaccessible] },
  });
  assert.equal(result.status, 403);
  const rows = await sql`SELECT id,read_at FROM notifications ORDER BY id`;
  assert.equal(
    rows.every((row) => row.readAt === null),
    true,
  );
  const listing = await (await request("/api/notifications", { token })).json();
  assert.deepEqual(
    listing.items.map((item: { id: string }) => item.id),
    [accessible],
  );
  assert.equal(listing.unreadCount, 1);
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
    "agent",
  );
  assert.equal(await credentialActor(new Request(restUrl, { headers })), null);
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
      await tx`INSERT INTO boards(workspace_id,name,prefix,position) SELECT id,'Must roll back','FAIL',0 FROM workspace`;
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
  const { cookie, token, privateBoard, allowedBoard, user } = await fixture();
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
  const call = async (name: string, arguments_: Record<string, unknown>) => {
    const response = await request("/mcp", {
      token,
      body: {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name, arguments: arguments_ },
      },
      headers: { Accept: "application/json, text/event-stream" },
    });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.ok(body.result, JSON.stringify(body));
    return body.result;
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
  const moderation = await request(`/api/comments/${otherComment.id}`, {
    token,
    method: "PATCH",
    body: { version: otherComment.version, body: "Admin-parent bypass" },
  });
  assert.equal(moderation.status, 403);
  assert.equal(
    (await sql`SELECT body FROM comments WHERE id=${otherComment.id}`)[0].body,
    "Another person comment",
  );
});

test("portable import rejects bad references atomically and keeps the operator secure", async () => {
  const { cookie, user } = await setupUser();
  const { board } = await (
    await request("/api/boards", {
      cookie,
      body: { name: "Portable workspace", prefix: "PORT" },
    })
  ).json();
  const { task: parent } = await (
    await request(`/api/boards/${board.id}/tasks`, {
      cookie,
      body: {
        title: "Parent",
        dueDate: "2027-01-30",
        description: "Portable Markdown",
        labels: ["release"],
        checklist: [{ id: "first", text: "Keep data", done: false }],
      },
    })
  ).json();
  const { task: child } = await (
    await request(`/api/boards/${board.id}/tasks`, {
      cookie,
      body: { title: "Child", parentId: parent.id, assigneeId: user.id },
    })
  ).json();
  assert.equal(
    (
      await request(`/api/tasks/${child.id}/comments`, {
        cookie,
        body: { body: "Portable comment" },
      })
    ).status,
    201,
  );
  const exportedResponse = await request("/api/export", { cookie });
  assert.equal(exportedResponse.status, 200);
  const exported = await exportedResponse.json();
  const serialized = JSON.stringify(exported);
  for (const forbidden of [
    "passwordHash",
    "password_hash",
    "tokenHash",
    "token_hash",
    "encryptedSecret",
    "encrypted_secret",
  ])
    assert.equal(serialized.includes(forbidden), false, forbidden);
  const invalid = structuredClone(exported);
  invalid.comments[0].taskId = randomUUID();
  const countsBefore =
    await sql`SELECT (SELECT count(*)::int FROM users) AS users,(SELECT count(*)::int FROM boards) AS boards,(SELECT count(*)::int FROM tasks) AS tasks,(SELECT count(*)::int FROM comments) AS comments`;
  assert.equal(
    (await request("/api/import", { cookie, body: invalid })).status,
    400,
  );
  assert.deepEqual(
    await sql`SELECT (SELECT count(*)::int FROM users) AS users,(SELECT count(*)::int FROM boards) AS boards,(SELECT count(*)::int FROM tasks) AS tasks,(SELECT count(*)::int FROM comments) AS comments`,
    countsBefore,
  );
  exported.members[0].role = "viewer";
  const importedResponse = await request("/api/import", {
    cookie,
    body: exported,
  });
  assert.equal(
    importedResponse.status,
    201,
    JSON.stringify(await importedResponse.clone().json()),
  );
  const { imported } = await importedResponse.json();
  assert.equal(imported.boards, 1);
  const copiedTasks = await (
    await request(`/api/boards/${imported.boardIds[0]}/tasks`, { cookie })
  ).json();
  const copiedParent = copiedTasks.items.find(
    (item: { title: string }) => item.title === "Parent",
  );
  const copiedChild = copiedTasks.items.find(
    (item: { title: string }) => item.title === "Child",
  );
  assert.equal(copiedChild.parentId, copiedParent.id);
  assert.equal(copiedParent.dueDate, "2027-01-30");
  assert.equal(copiedChild.assigneeId, user.id);
  const copiedComments = await (
    await request(`/api/tasks/${copiedChild.id}/comments`, { cookie })
  ).json();
  assert.equal(copiedComments.items[0].body, "Portable comment");
  assert.equal(
    (await sql`SELECT role FROM users WHERE id=${user.id}`)[0].role,
    "admin",
  );
  assert.equal((await request("/api/auth/me", { cookie })).status, 200);
});

async function changeAccessWhileWriteWaits(
  action: "remove" | "downgrade" | "revoke",
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
    action === "revoke"
      ? await request("/api/credentials", {
          cookie: memberCookie,
          body: {
            name: "Pending agent",
            scopes: ["read", "write"],
            boardIds: [board.id],
          },
        })
      : null;
  const credential = credentialResponse
    ? await credentialResponse.json()
    : null;
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
    await tx`SELECT id FROM boards WHERE id=${board.id} FOR UPDATE`;
    locked();
    await unblock;
  });
  await ready;
  const pending = request(`/api/boards/${board.id}/tasks`, {
    ...(credential ? { token: credential.token } : { cookie: memberCookie }),
    body: { title: "Access changed while waiting" },
  });
  let observed = false;
  let changedStatus = 0;
  try {
    for (let attempt = 0; attempt < 100; attempt++) {
      const [wait] =
        await sql`SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE wait_event_type='Lock' AND ${holderPid}=ANY(pg_blocking_pids(pid))) AS blocked`;
      if (wait.blocked) {
        observed = true;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(
      observed,
      true,
      "The actual domain write must be waiting on the held board lock",
    );
    const changed =
      action === "revoke"
        ? await request(`/api/credentials/${credential.credential.id}`, {
            cookie: memberCookie,
            method: "DELETE",
          })
        : action === "downgrade"
          ? await request(`/api/auth/members/${memberId}`, {
              cookie,
              method: "PATCH",
              body: { role: "viewer" },
            })
          : await request(`/api/auth/members/${memberId}`, {
              cookie,
              method: "DELETE",
            });
    changedStatus = changed.status;
  } finally {
    release();
    await holder;
  }
  assert.equal(changedStatus, 200);
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
  test(`access ${action} prevents a mutation already waiting on a board lock`, async () =>
    changeAccessWhileWriteWaits(action));
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
    body: { name: "Retried credential", scopes: ["read"] },
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

test("accounts accepted by identity remain portable at the email length boundary", async () => {
  const email =
    "a".repeat(64) +
    "@" +
    ["b".repeat(63), "c".repeat(63), "d".repeat(63), "e".repeat(60)].join(".");
  const { cookie, user } = await setupUser({ email });
  const exportedResponse = await request("/api/export", { cookie });
  assert.equal(exportedResponse.status, 200);
  const exported = await exportedResponse.json();
  const importedResponse = await request("/api/import", {
    cookie,
    body: exported,
  });
  assert.equal(
    importedResponse.status,
    201,
    JSON.stringify(await importedResponse.clone().json()),
  );
  assert.equal(
    (await sql`SELECT role FROM users WHERE id=${user.id}`)[0].role,
    "admin",
  );
});

test("MCP can read a task with valid long descriptions, many subtasks, and a long discussion", async () => {
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
  await sql`INSERT INTO tasks(board_id,column_id,identifier,title,description,parent_id,position,created_by) SELECT ${allowedBoard.id},${task.columnId},'ALLOW-'||(sequence+1),'Child '||sequence,${"Child details ".repeat(1500)},${task.id},sequence,${user.id} FROM generate_series(1,50) sequence`;
  await sql`UPDATE boards SET next_number=52 WHERE id=${allowedBoard.id}`;
  await sql`INSERT INTO comments(task_id,author_id,body,created_at) SELECT ${task.id},${user.id},${"Discussion ".repeat(900)},now()+sequence*interval '1 millisecond' FROM generate_series(1,100) sequence`;
  const response = await request("/mcp", {
    token,
    body: {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "get_task", arguments: { taskId: task.id } },
    },
    headers: { Accept: "application/json, text/event-stream" },
  });
  assert.equal(response.status, 200);
  const result = (await response.json()).result;
  assert.equal(result.isError, false, JSON.stringify(result));
  assert.equal(result.structuredContent.task.id, task.id);
  assert.ok(result.structuredContent.subtasks.length > 0);
});

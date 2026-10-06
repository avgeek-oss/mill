import { after, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import {
  cleanupDatabase,
  callMcpTool,
  request,
  resetDatabase,
  setupOAuth,
  setupUser,
  sql,
} from "./support.js";

beforeEach(resetDatabase);
after(cleanupDatabase);
async function json(response: Response, status = 200) {
  assert.equal(response.status, status, await response.clone().text());
  return response.json();
}
async function mcpResult(
  token: string,
  name: string,
  args: Record<string, unknown> = {},
) {
  const called = await callMcpTool(token, name, args);
  assert.equal(called.response.status, 200);
  assert.equal(called.error, undefined);
  assert.ok(called.result);
  return called.result;
}
async function mcpJson<
  T extends Record<string, unknown> = Record<string, unknown>,
>(token: string, name: string, args: Record<string, unknown> = {}) {
  const result = await mcpResult(token, name, args);
  assert.equal(result.isError, false, JSON.stringify(result));
  assert.ok(result.structuredContent);
  return result.structuredContent as T;
}
async function mcpDenied(
  token: string,
  name: string,
  args: Record<string, unknown>,
  error: string,
) {
  const result = await mcpResult(token, name, args);
  assert.equal(result.isError, true, name);
  const body = result.structuredContent ?? JSON.parse(result.content[0]!.text!);
  assert.equal(body.error, error, name);
}
async function member(cookie: string, email: string, role = "member") {
  const invitation = await json(
    await request("/api/auth/invitations", { cookie, body: { email, role } }),
    201,
  );
  const response = await request("/api/auth/accept-invitation", {
    body: {
      token: invitation.token,
      name: email.split("@")[0],
      password: "Another secure passphrase 42!",
    },
  });
  const result = await json(response, 201);
  return {
    cookie: response.headers.get("set-cookie")!.split(";")[0],
    user: result.user,
  };
}
async function fixture() {
  const admin = await setupUser();
  const created = await json(
    await request("/api/boards", {
      cookie: admin.cookie,
      body: { name: "Engineering", prefix: "ENG" },
    }),
    201,
  );
  const detail = await json(
    await request(`/api/boards/${created.board.id}`, { cookie: admin.cookie }),
  );
  assert.deepEqual(Object.keys(detail), ["board"]);
  return { ...admin, board: created.board };
}
async function createTask(
  cookie: string,
  boardId: string,
  title = "A useful task",
  extra: Record<string, unknown> = {},
) {
  return (
    await json(
      await request(`/api/boards/${boardId}/tasks`, {
        cookie,
        body: { title, ...extra },
      }),
      201,
    )
  ).task;
}

test("task types persist with defaulting, validation, activity, permissions and version conflicts", async () => {
  const { cookie, board } = await fixture();
  const ordinary = await createTask(cookie, board.id);
  assert.equal(ordinary.type, "task");
  const bug = await createTask(cookie, board.id, "A reported bug", {
    type: "bug",
    status: "backlog",
  });
  assert.equal(bug.type, "bug");
  const detail = await json(await request(`/api/tasks/${bug.id}`, { cookie }));
  assert.equal(detail.task.type, "bug");
  assert.equal(detail.activity[0].detail.type, "bug");
  const listed = await json(
    await request(`/api/boards/${board.id}/tasks`, { cookie }),
  );
  assert.equal(
    listed.items.find((row: { id: string }) => row.id === bug.id).type,
    "bug",
  );
  for (const type of ["feature", "Bug", "", null]) {
    assert.equal(
      (
        await request(`/api/boards/${board.id}/tasks`, {
          cookie,
          body: { title: "Invalid type", type },
        })
      ).status,
      400,
    );
    assert.equal(
      (
        await request(`/api/tasks/${bug.id}`, {
          cookie,
          method: "PATCH",
          body: { version: bug.version, type },
        })
      ).status,
      400,
    );
  }
  await assert.rejects(
    sql`UPDATE tasks SET type='feature' WHERE id=${bug.id}`,
    { code: "23514" },
  );
  await assert.rejects(sql`UPDATE tasks SET type=NULL WHERE id=${bug.id}`, {
    code: "23502",
  });
  const viewer = await member(cookie, "type-viewer@example.test", "viewer");
  assert.equal(
    (
      await request(`/api/tasks/${bug.id}`, {
        cookie: viewer.cookie,
        method: "PATCH",
        body: { version: bug.version, type: "task" },
      })
    ).status,
    403,
  );
  const writes = await Promise.all([
    request(`/api/tasks/${bug.id}`, {
      cookie,
      method: "PATCH",
      body: { version: bug.version, type: "task" },
    }),
    request(`/api/tasks/${bug.id}`, {
      cookie,
      method: "PATCH",
      body: { version: bug.version, title: "Concurrent title" },
    }),
  ]);
  assert.deepEqual(
    writes.map((response) => response.status).sort(),
    [200, 409],
  );
  const current = (
    await json(await request(`/api/tasks/${bug.id}`, { cookie }))
  ).task;
  const updated = (
    await json(
      await request(`/api/tasks/${bug.id}`, {
        cookie,
        method: "PATCH",
        body: { version: current.version, type: "task" },
      }),
    )
  ).task;
  assert.equal(updated.type, "task");
  assert.equal(updated.identifier, bug.identifier);
  assert.equal(updated.statusChangedAt, bug.statusChangedAt);
  assert.equal(updated.version, bug.version + 2);
  const activity = await json(
    await request(`/api/tasks/${bug.id}/activity`, { cookie }),
  );
  assert(
    activity.items.some(
      (entry: { action: string; detail: { fields?: string[] } }) =>
        entry.action === "task.updated" &&
        entry.detail.fields?.includes("type"),
    ),
  );
});

test("start dates persist as nullable calendar dates with validation, permissions and independent versioned updates", async () => {
  const { cookie, board } = await fixture();
  const ordinary = await createTask(cookie, board.id);
  assert.equal(ordinary.startDate, null);
  let item = await createTask(cookie, board.id, "Calendar date task", {
    startDate: "2028-02-29",
    dueDate: "2028-02-28",
  });
  assert.equal(item.startDate, "2028-02-29");
  assert.equal(item.dueDate, "2028-02-28");
  assert.equal(
    (await json(await request(`/api/tasks/${item.id}`, { cookie }))).task
      .startDate,
    "2028-02-29",
  );
  const listed = await json(
    await request(`/api/boards/${board.id}/tasks`, { cookie }),
  );
  assert.equal(
    listed.items.find((row: { id: string }) => row.id === item.id).startDate,
    "2028-02-29",
  );
  for (const startDate of [
    "2026-02-29",
    "2026-02-31",
    "2026-10-01T00:00:00Z",
    "",
    1,
  ]) {
    assert.equal(
      (
        await request(`/api/boards/${board.id}/tasks`, {
          cookie,
          body: { title: "Invalid calendar date", startDate },
        })
      ).status,
      400,
    );
    assert.equal(
      (
        await request(`/api/tasks/${item.id}`, {
          cookie,
          method: "PATCH",
          body: { version: item.version, startDate },
        })
      ).status,
      400,
    );
  }
  const viewer = await member(cookie, "date-viewer@example.test", "viewer");
  assert.equal(
    (
      await request(`/api/tasks/${item.id}`, {
        cookie: viewer.cookie,
        method: "PATCH",
        body: { version: item.version, startDate: null },
      })
    ).status,
    403,
  );
  const before = item;
  item = (
    await json(
      await request(`/api/tasks/${item.id}`, {
        cookie,
        method: "PATCH",
        body: { version: item.version, startDate: "2026-10-01" },
      }),
    )
  ).task;
  assert.equal(item.startDate, "2026-10-01");
  assert.equal(item.dueDate, before.dueDate);
  assert.equal(item.identifier, before.identifier);
  assert.equal(item.statusChangedAt, before.statusChangedAt);
  assert.equal(item.version, before.version + 1);
  assert.equal(
    (
      await request(`/api/tasks/${item.id}`, {
        cookie,
        method: "PATCH",
        body: { version: before.version, startDate: "2026-10-02" },
      })
    ).status,
    409,
  );
  item = (
    await json(
      await request(`/api/tasks/${item.id}`, {
        cookie,
        method: "PATCH",
        body: { version: item.version, title: "Preserves date" },
      }),
    )
  ).task;
  assert.equal(item.startDate, "2026-10-01");
  item = (
    await json(
      await request(`/api/tasks/${item.id}`, {
        cookie,
        method: "PATCH",
        body: { version: item.version, startDate: null },
      }),
    )
  ).task;
  assert.equal(item.startDate, null);
  assert.equal(item.dueDate, before.dueDate);
  const activity = await json(
    await request(`/api/tasks/${item.id}/activity`, { cookie }),
  );
  assert.equal(
    activity.items.filter(
      (entry: { action: string; detail: { fields?: string[] } }) =>
        entry.action === "task.updated" &&
        entry.detail.fields?.includes("startDate"),
    ).length,
    2,
  );
});

test("task lifecycle persists identifiers, edits, status and permanent deletion", async () => {
  const { cookie, board } = await fixture();
  const teammate = await member(cookie, "teammate@example.test");
  let item = await createTask(cookie, board.id, "Ship B1", {
    description: "[Reference](https://example.test)",
    assigneeId: teammate.user.id,
    priority: "urgent",
    dueDate: "2026-10-01",
  });
  assert.equal(item.identifier, "ENG-1");
  assert.equal(item.status, "todo");
  const detail = await json(await request(`/api/tasks/${item.id}`, { cookie }));
  assert.equal(detail.task.description, "[Reference](https://example.test)");
  item = (
    await json(
      await request(`/api/tasks/${item.id}`, {
        method: "PATCH",
        cookie,
        body: {
          version: item.version,
          title: "Ship reviewed B1",
          status: "in_review",
          assigneeId: null,
          dueDate: null,
        },
      }),
    )
  ).task;
  assert.equal(item.status, "in_review");
  assert.equal(item.assigneeId, null);
  assert.equal(item.dueDate, null);
  const independent = await createTask(cookie, board.id, "Review permissions");
  assert.equal(independent.identifier, "ENG-2");
  assert.deepEqual(
    await json(
      await request(`/api/tasks/${item.id}`, {
        method: "DELETE",
        cookie,
        body: { version: item.version },
      }),
    ),
    { ok: true },
  );
  assert.equal(
    (await request(`/api/tasks/${item.id}`, { cookie })).status,
    404,
  );
  assert.equal(
    (await request(`/api/tasks/${independent.id}`, { cookie })).status,
    200,
  );
  const next = await createTask(cookie, board.id, "Continue work");
  assert.equal(next.identifier, "ENG-3");
});

test("personal REST keys inherit human roles while OAuth MCP enforces board restrictions", async () => {
  const { cookie, board, user } = await fixture();
  const viewer = await member(cookie, "viewer@example.test", "viewer");
  const writer = await member(cookie, "writer@example.test");
  const item = await createTask(cookie, board.id);
  const comment = (
    await json(
      await request(`/api/tasks/${item.id}/comments`, {
        cookie,
        body: { body: "Administrator comment" },
      }),
      201,
    )
  ).comment;
  assert.equal(
    (await request(`/api/tasks/${item.id}`, { cookie: viewer.cookie })).status,
    200,
  );
  for (const [path, method, payload] of [
    ["/api/boards", "POST", { name: "Denied" }],
    [
      `/api/tasks/${item.id}`,
      "PATCH",
      { version: item.version, title: "Denied" },
    ],
    [`/api/tasks/${item.id}/comments`, "POST", { body: "Denied" }],
    [`/api/tasks/${item.id}`, "DELETE", { version: item.version }],
    ["/api/workspace", "PATCH", { name: "Denied" }],
  ] as const)
    assert.equal(
      (await request(path, { method, cookie: viewer.cookie, body: payload }))
        .status,
      403,
    );
  assert.equal(
    (
      await request(`/api/comments/${comment.id}`, {
        method: "PATCH",
        cookie: writer.cookie,
        body: { body: "Hijack", version: comment.version },
      })
    ).status,
    404,
  );
  const privateBoard = (
    await json(
      await request("/api/boards", {
        cookie,
        body: { name: "Other board", prefix: "OTHER" },
      }),
      201,
    )
  ).board;
  const privateTask = await createTask(cookie, privateBoard.id);
  const privateComment = (
    await json(
      await request(`/api/tasks/${privateTask.id}/comments`, {
        cookie,
        body: { body: "Other board comment" },
      }),
      201,
    )
  ).comment;
  const personal = await json(
    await request("/api/credentials", {
      cookie,
      body: { name: "Personal work key", expiresInDays: 30 },
    }),
    201,
  );
  assert.equal(personal.credential.userId, user.id);
  assert.equal("agentId" in personal.credential, false);
  assert.equal(personal.credential.boardIds, null);
  assert.deepEqual(personal.credential.scopes, []);
  assert.deepEqual(
    (await json(await request("/api/boards", { token: personal.token }))).items
      .map((row: { id: string }) => row.id)
      .sort(),
    [board.id, privateBoard.id].sort(),
  );
  for (const id of [item.id, privateTask.id])
    assert.equal(
      (await request(`/api/tasks/${id}`, { token: personal.token })).status,
      200,
    );
  for (const [path, method, body] of [
    ["/api/auth/me", "GET", undefined],
    ["/api/auth/members", "GET", undefined],
    ["/api/credentials", "GET", undefined],
    ["/api/credentials", "POST", { name: "Nested key" }],
    ["/api/workspace", "GET", undefined],
    ["/api/workspace", "PATCH", { name: "Denied" }],
  ] as const)
    assert.equal(
      (await request(path, { token: personal.token, method, body })).status,
      403,
      path,
    );
  assert.equal(
    (await callMcpTool(personal.token, "list_boards")).response.status,
    403,
  );
  const viewerKey = await json(
    await request("/api/credentials", {
      cookie: viewer.cookie,
      body: { name: "Viewer personal key" },
    }),
    201,
  );
  assert.equal(viewerKey.credential.userId, viewer.user.id);
  assert.equal(
    (await request(`/api/tasks/${privateTask.id}`, { token: viewerKey.token }))
      .status,
    200,
  );
  for (const [path, method, body] of [
    ["/api/boards", "POST", { name: "Denied" }],
    [
      `/api/tasks/${item.id}`,
      "PATCH",
      { version: item.version, title: "Denied" },
    ],
    [`/api/tasks/${item.id}/comments`, "POST", { body: "Denied" }],
    [`/api/tasks/${item.id}`, "DELETE", { version: item.version }],
    ["/api/workspace", "PATCH", { name: "Denied" }],
  ] as const)
    assert.equal(
      (await request(path, { token: viewerKey.token, method, body })).status,
      403,
      path,
    );
  const credential = await setupOAuth(cookie, {
    scopes: ["read", "write"],
    boardIds: [board.id],
  });
  const token = credential.token;
  const otherAuthorComment = (
    await json(
      await request(`/api/tasks/${item.id}/comments`, {
        cookie: writer.cookie,
        body: { body: "Member-owned comment" },
      }),
      201,
    )
  ).comment;
  await mcpDenied(
    token,
    "delete_comment",
    {
      commentId: otherAuthorComment.id,
      version: otherAuthorComment.version,
    },
    "Only the author or an administrator can delete this comment",
  );
  assert.deepEqual(
    (
      await mcpJson<{ items: { id: string }[] }>(token, "list_boards")
    ).items.map((b: { id: string }) => b.id),
    [board.id],
  );
  for (const [name, args] of [
    ["get_board", { boardId: privateBoard.id }],
    ["list_tasks", { boardId: privateBoard.id }],
    ["get_task", { taskId: privateTask.id }],
    ["list_comments", { taskId: privateTask.id }],
    ["get_activity", { taskId: privateTask.id }],
    [
      "delete_comment",
      { commentId: privateComment.id, version: privateComment.version },
    ],
    [
      "update_board",
      {
        boardId: privateBoard.id,
        version: privateBoard.version,
        name: "Denied",
      },
    ],
  ] as const)
    await mcpDenied(
      token,
      name,
      args,
      "This credential does not permit this action",
    );
  await mcpDenied(
    token,
    "get_workspace",
    {},
    "This tool is unavailable with your credential and current role",
  );
  assert.equal((await request(`/api/tasks/${item.id}`, { token })).status, 403);
  const readCredential = await setupOAuth(cookie, {
    scopes: ["read"],
    boardIds: [board.id],
  });
  const before = await sql`SELECT * FROM tasks WHERE id=${item.id}`;
  const readDenied = await callMcpTool(readCredential.token, "update_task", {
    taskId: item.id,
    version: item.version,
    title: "Denied",
  });
  assert.equal(readDenied.response.status, 403);
  assert.equal(readDenied.error, "insufficient_scope");
  assert.equal(readDenied.result, undefined);
  assert.match(
    readDenied.response.headers.get("WWW-Authenticate") ?? "",
    /Bearer error="insufficient_scope".*scope="read write"/,
  );
  assert.deepEqual(await sql`SELECT * FROM tasks WHERE id=${item.id}`, before);
  assert.deepEqual(
    await mcpJson(token, "delete_comment", {
      commentId: comment.id,
      version: comment.version,
    }),
    { ok: true },
  );
  assert.equal(
    (await sql`SELECT * FROM comments WHERE id=${comment.id}`).length,
    0,
  );
  assert.equal(
    (await sql`SELECT * FROM comments WHERE id=${privateComment.id}`).length,
    1,
  );
  await json(
    await request(`/api/credentials/${credential.credential.id}`, {
      cookie,
      method: "DELETE",
    }),
  );
  assert.equal(
    (await request(`/api/tasks/${privateTask.id}`, { token: personal.token }))
      .status,
    200,
  );
  const [retained] =
    await sql`SELECT revoked_at FROM credentials WHERE id=${personal.credential.id}`;
  assert.equal(retained.revokedAt, null);
  assert.equal(
    (await callMcpTool(token, "get_task", { taskId: item.id })).response.status,
    401,
  );
});

test("concurrent edits and status changes reject stale versions without lost fields", async () => {
  const { cookie, board } = await fixture();
  const item = await createTask(cookie, board.id);
  const edits = await Promise.all(
    ["First edit", "Second edit"].map((title) =>
      request(`/api/tasks/${item.id}`, {
        method: "PATCH",
        cookie,
        body: { version: item.version, title },
      }),
    ),
  );
  assert.deepEqual(edits.map((r) => r.status).sort(), [200, 409]);
  const fresh = (await json(await request(`/api/tasks/${item.id}`, { cookie })))
    .task;
  assert.ok(["First edit", "Second edit"].includes(fresh.title));
  const changes = await Promise.all(
    ["in_progress", "done"].map((status) =>
      request(`/api/tasks/${item.id}`, {
        method: "PATCH",
        cookie,
        body: { status, version: fresh.version },
      }),
    ),
  );
  assert.deepEqual(changes.map((r) => r.status).sort(), [200, 409]);
  const updated = (
    await json(await request(`/api/tasks/${item.id}`, { cookie }))
  ).task;
  assert.equal(updated.title, fresh.title);
  assert.ok(["in_progress", "done"].includes(updated.status));
  assert.equal(updated.version, fresh.version + 1);
  const a = await createTask(cookie, board.id, "Independent A", {
    status: "backlog",
  });
  const b = await createTask(cookie, board.id, "Independent B", {
    status: "in_review",
  });
  const independent = await Promise.all(
    [a, b].map((row) =>
      request(`/api/tasks/${row.id}`, {
        method: "PATCH",
        cookie,
        body: { status: "done", version: row.version },
      }),
    ),
  );
  assert.deepEqual(
    independent.map((r) => r.status),
    [200, 200],
  );
  const rows =
    await sql`SELECT status FROM tasks WHERE id IN (${a.id},${b.id})`;
  assert.deepEqual(
    rows.map((row) => row.status),
    ["done", "done"],
  );
});

test("combined search filters and keyset pagination are bounded and deterministic", async () => {
  const { cookie, board } = await fixture();
  for (let index = 0; index < 7; index++)
    await createTask(cookie, board.id, `Release ${index}`, {
      priority: "high",
      status: "in_review",
      description: index === 6 ? "contains wildcard_%" : "",
    });
  await createTask(cookie, board.id, "Unrelated task", {
    priority: "low",
    status: "todo",
  });
  let cursor: string | null = null;
  const ids: string[] = [];
  do {
    const page = await json(
      await request(
        `/api/boards/${board.id}/tasks?q=Release&priority=high&status=in_review&assigneeId=unassigned&limit=2&sort=title${cursor ? "&cursor=" + cursor : ""}`,
        { cookie },
      ),
    );
    assert.ok(page.items.length <= 2);
    ids.push(...page.items.map((t: { id: string }) => t.id));
    cursor = page.nextCursor;
  } while (cursor);
  assert.equal(ids.length, 7);
  assert.equal(new Set(ids).size, 7);
  assert.equal(
    (
      await json(
        await request(`/api/boards/${board.id}/tasks?q=wildcard_%`, { cookie }),
      )
    ).items.length,
    1,
  );
  assert.equal(
    (await request(`/api/boards/${board.id}/tasks?limit=101`, { cookie }))
      .status,
    400,
  );
  const page = await json(
    await request(`/api/boards/${board.id}/tasks?limit=1`, { cookie }),
  );
  assert.equal(
    (
      await request(
        `/api/boards/${board.id}/tasks?sort=title&cursor=${page.nextCursor}`,
        { cookie },
      )
    ).status,
    400,
  );
});

test("assignments and mentions respect preferences and notifications remain private and atomically scoped", async () => {
  const { cookie, user, board } = await fixture();
  const teammate = await member(cookie, "mentioned@example.test");
  const item = await createTask(cookie, board.id, "Notify teammate", {
    assigneeId: teammate.user.id,
  });
  await json(
    await request(`/api/tasks/${item.id}/comments`, {
      cookie,
      body: {
        body: `Hello @mentioned@example.test`,
        mentionIds: [teammate.user.id],
      },
    }),
    201,
  );
  const own = await json(await request("/api/notifications", { cookie }));
  assert.equal(own.items.length, 0);
  const notices = await json(
    await request("/api/notifications?unread=true", {
      cookie: teammate.cookie,
    }),
  );
  assert.equal(notices.unreadCount, 2);
  assert.deepEqual(notices.items.map((n: { kind: string }) => n.kind).sort(), [
    "assignment",
    "mention",
  ]);
  const forged = user.id;
  assert.equal(
    (
      await request("/api/notifications", {
        method: "PATCH",
        cookie: teammate.cookie,
        body: { ids: [notices.items[0].id, forged] },
      })
    ).status,
    403,
  );
  assert.equal(
    (
      await json(
        await request("/api/notifications", { cookie: teammate.cookie }),
      )
    ).unreadCount,
    2,
  );
  await json(
    await request("/api/notifications", {
      method: "PATCH",
      cookie: teammate.cookie,
      body: { all: true },
    }),
  );
  assert.equal(
    (
      await json(
        await request("/api/notifications", { cookie: teammate.cookie }),
      )
    ).unreadCount,
    0,
  );
  await sql`UPDATE users SET notification_preferences='{"assignments":false,"mentions":false}'::jsonb WHERE id=${teammate.user.id}`;
  await createTask(cookie, board.id, "Muted assignment", {
    assigneeId: teammate.user.id,
  });
  await json(
    await request(`/api/tasks/${item.id}/comments`, {
      cookie,
      body: { body: "@mentioned@example.test muted" },
    }),
    201,
  );
  assert.equal(
    (
      await json(
        await request("/api/notifications", { cookie: teammate.cookie }),
      )
    ).items.length,
    2,
  );
  const other = (
    await json(
      await request("/api/boards", {
        cookie,
        body: { name: "Other", prefix: "NTO" },
      }),
      201,
    )
  ).board;
  await createTask(teammate.cookie, board.id, "Admin assignment", {
    assigneeId: user.id,
  });
  await createTask(teammate.cookie, other.id, "Admin private assignment", {
    assigneeId: user.id,
  });
  const credential = await setupOAuth(cookie, {
    scopes: ["read", "write"],
    boardIds: [board.id],
  });
  const limited = await mcpJson<{
    items: { id: string; boardId: string }[];
    unreadCount: number;
  }>(credential.token, "list_notifications");
  assert.equal(limited.items.length, 1);
  assert.equal(limited.items[0].boardId, board.id);
  const all = await json(await request("/api/notifications", { cookie }));
  const personal = await json(
    await request("/api/credentials", {
      cookie,
      body: { name: "Personal notification key" },
    }),
    201,
  );
  const personalNotices = await json(
    await request("/api/notifications", { token: personal.token }),
  );
  assert.equal(personalNotices.items.length, 2);
  assert.deepEqual(
    personalNotices.items.map((notice: { id: string }) => notice.id),
    all.items.map((notice: { id: string }) => notice.id),
  );
  await mcpDenied(
    credential.token,
    "mark_notifications",
    { ids: all.items.map((n: { id: string }) => n.id) },
    "Some notifications are outside your access",
  );
  assert.equal(
    (await json(await request("/api/notifications", { cookie }))).unreadCount,
    2,
  );
});

test("archive fields, deleted filters and restore routes are rejected", async () => {
  const { cookie, board } = await fixture();
  const task = await createTask(cookie, board.id);
  for (const field of ["archived", "deleted"])
    assert.equal(
      (
        await request(`/api/boards/${board.id}`, {
          cookie,
          method: "PATCH",
          body: { version: board.version, [field]: true },
        })
      ).status,
      400,
    );
  assert.equal(
    (
      await request(`/api/tasks/${task.id}`, {
        cookie,
        method: "PATCH",
        body: { version: task.version, archived: true },
      })
    ).status,
    400,
  );
  assert.equal(
    (
      await request(`/api/boards/${board.id}/tasks`, {
        cookie,
        body: { title: "Archived", archived: true },
      })
    ).status,
    400,
  );
  for (const path of [
    "/api/boards?archived=true",
    "/api/boards?deleted=false",
    `/api/boards/${board.id}/tasks?archived=false`,
    `/api/boards/${board.id}/tasks?deleted=true`,
  ])
    assert.equal((await request(path, { cookie })).status, 400);
  for (const path of [
    `/api/boards/${board.id}/restore`,
    `/api/tasks/${task.id}/restore`,
  ])
    assert.equal(
      (await request(path, { cookie, body: { version: 1 } })).status,
      404,
    );
});

test("comment, activity and notification pagination preserve PostgreSQL microsecond ordering", async () => {
  const { cookie, board, user } = await fixture();
  const item = await createTask(cookie, board.id);
  for (let index = 0; index < 7; index++)
    await json(
      await request(`/api/tasks/${item.id}/comments`, {
        cookie,
        body: { body: `Comment ${index}` },
      }),
      201,
    );
  await sql`UPDATE comments SET created_at='2026-09-28T00:00:00.000001Z'::timestamptz WHERE task_id=${item.id}`;
  await sql`UPDATE activity SET created_at='2026-09-28T00:00:00.000002Z'::timestamptz WHERE task_id=${item.id}`;
  for (let index = 0; index < 7; index++)
    await sql`INSERT INTO notifications (user_id,task_id,kind,actor_name,created_at) VALUES (${user.id},${item.id},'mention','Teammate','2026-09-28T00:00:00.000003Z'::timestamptz)`;
  for (const [path, expected] of [
    [`/api/tasks/${item.id}/comments`, 7],
    [`/api/tasks/${item.id}/activity`, 8],
    ["/api/notifications", 7],
  ] as const) {
    const ids: string[] = [];
    let cursor: string | null = null;
    do {
      const page = await json(
        await request(`${path}?limit=2${cursor ? "&cursor=" + cursor : ""}`, {
          cookie,
        }),
      );
      ids.push(...page.items.map((row: { id: string }) => row.id));
      cursor = page.nextCursor;
      assert.ok(
        ids.length <= Number(expected),
        `Pagination repeated items in ${path}`,
      );
    } while (cursor);
    assert.equal(ids.length, Number(expected), path);
    assert.equal(new Set(ids).size, ids.length, path);
  }
});

test("bounded input validation rejects invalid sorts, unknown assignments and oversized task/comment fields", async () => {
  const { cookie, board } = await fixture();
  const item = await createTask(cookie, board.id);
  for (const sort of ["constructor", "__proto__", "toString", "unknown"])
    assert.equal(
      (await request(`/api/boards/${board.id}/tasks?sort=${sort}`, { cookie }))
        .status,
      400,
    );
  for (const input of [
    { title: "x".repeat(301) },
    { title: "Task", description: "x".repeat(100001) },
    { title: "Task", dueDate: "2026-02-31" },
    { title: "Task", assigneeId: "00000000-0000-4000-8000-000000000000" },
    { title: "Task", checklist: [] },
  ])
    assert.equal(
      (await request(`/api/boards/${board.id}/tasks`, { cookie, body: input }))
        .status,
      400,
    );
  assert.equal(
    (
      await request(`/api/tasks/${item.id}/comments`, {
        cookie,
        body: { body: "x".repeat(10001) },
      })
    ).status,
    400,
  );
  assert.equal(
    (await request(`/api/tasks/00000000-0000-4000-8000-000000000000`)).status,
    401,
  );
});

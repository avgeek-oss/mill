import { after, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import {
  cleanupDatabase,
  request,
  resetDatabase,
  setupAgent,
  setupUser,
  sql,
} from "./support.js";

beforeEach(resetDatabase);
after(cleanupDatabase);
async function json(response: Response, status = 200) {
  assert.equal(response.status, status, await response.clone().text());
  return response.json();
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

test("task lifecycle persists identifiers, edits, checklist, status and permanent deletion", async () => {
  const { cookie, board } = await fixture();
  const teammate = await member(cookie, "teammate@example.test");
  let item = await createTask(cookie, board.id, "Ship B1", {
    description: "[Reference](https://example.test)",
    assigneeId: teammate.user.id,
    priority: "urgent",
    dueDate: "2026-10-01",
    checklist: [{ id: "review", text: "Review the board", done: false }],
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
          checklist: [{ id: "review", text: "Review the board", done: true }],
          assigneeId: null,
          dueDate: null,
        },
      }),
    )
  ).task;
  assert.equal(item.status, "in_review");
  assert.equal(item.checklist[0].done, true);
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

test("all board/task/comment/admin endpoints enforce roles and board credential restrictions", async () => {
  const { cookie, board } = await fixture();
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
    403,
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
  const credential = await json(
    await request("/api/credentials", {
      cookie,
      body: {
        agentId: (await setupAgent(cookie)).id,
        name: "Board agent",
        scopes: ["read", "write"],
        boardIds: [board.id],
        expiresInDays: 1,
      },
    }),
    201,
  );
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
  assert.equal(
    (
      await request(`/api/comments/${otherAuthorComment.id}`, {
        token,
        method: "PATCH",
        body: {
          version: otherAuthorComment.version,
          body: "Agent moderation denied",
        },
      })
    ).status,
    403,
  );
  assert.deepEqual(
    (await json(await request("/api/boards", { token }))).items.map(
      (b: { id: string }) => b.id,
    ),
    [board.id],
  );
  for (const path of [
    `/api/boards/${privateBoard.id}`,
    `/api/boards/${privateBoard.id}/tasks`,
    `/api/tasks/${privateTask.id}`,
    `/api/tasks/${privateTask.id}/comments`,
    `/api/tasks/${privateTask.id}/activity`,
    "/api/workspace",
  ])
    assert.equal((await request(path, { token })).status, 403, path);
  assert.equal(
    (
      await request(`/api/comments/${privateComment.id}`, {
        method: "DELETE",
        token,
        body: { version: privateComment.version },
      })
    ).status,
    403,
  );
  assert.equal(
    (
      await request(`/api/boards/${privateBoard.id}`, {
        method: "PATCH",
        token,
        body: { version: privateBoard.version, name: "Denied" },
      })
    ).status,
    403,
  );
  const readCredential = await json(
    await request("/api/credentials", {
      cookie,
      body: {
        agentId: (await setupAgent(cookie)).id,
        name: "Reader",
        scopes: ["read"],
        boardIds: [board.id],
        expiresInDays: 1,
      },
    }),
    201,
  );
  assert.equal(
    (
      await request(`/api/tasks/${item.id}`, {
        method: "PATCH",
        token: readCredential.token,
        body: { version: item.version, title: "Denied" },
      })
    ).status,
    403,
  );
  assert.equal(
    (
      await request(`/api/comments/${comment.id}`, {
        method: "DELETE",
        token,
        body: { version: comment.version },
      })
    ).status,
    200,
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
  const credential = await json(
    await request("/api/credentials", {
      cookie,
      body: {
        agentId: (await setupAgent(cookie)).id,
        name: "Limited notifications",
        scopes: ["read", "write"],
        boardIds: [board.id],
        expiresInDays: 1,
      },
    }),
    201,
  );
  const limited = await json(
    await request("/api/notifications", { token: credential.token }),
  );
  assert.equal(limited.items.length, 1);
  assert.equal(limited.items[0].boardId, board.id);
  const all = await json(await request("/api/notifications", { cookie }));
  assert.equal(
    (
      await request("/api/notifications", {
        method: "PATCH",
        token: credential.token,
        body: { ids: all.items.map((n: { id: string }) => n.id) },
      })
    ).status,
    403,
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
    {
      title: "Task",
      checklist: [
        { id: "same", text: "One", done: false },
        { id: "same", text: "Two", done: true },
      ],
    },
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

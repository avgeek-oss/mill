import { after, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import {
  cleanupDatabase,
  request,
  resetDatabase,
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
  return { ...admin, board: created.board, columns: detail.columns };
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

test("task lifecycle persists identifiers, edits, checklist, relationships, move and permanent deletion", async () => {
  const { cookie, board, columns } = await fixture();
  const teammate = await member(cookie, "teammate@example.test");
  let parent = await createTask(cookie, board.id, "Ship B1", {
    description: "[Reference](https://example.test)",
    assigneeId: teammate.user.id,
    priority: "urgent",
    labels: ["release", "release"],
    dueDate: "2026-10-01",
    checklist: [{ id: "review", text: "Review the board", done: false }],
  });
  assert.equal(parent.identifier, "ENG-1");
  assert.deepEqual(parent.labels, ["release"]);
  const subtask = await createTask(cookie, board.id, "Review permissions", {
    parentId: parent.id,
  });
  assert.equal(subtask.identifier, "ENG-2");
  const childDetail = await json(
    await request(`/api/tasks/${subtask.id}`, { cookie }),
  );
  assert.equal(childDetail.parent.id, parent.id);
  const parentDetail = await json(
    await request(`/api/tasks/${parent.id}`, { cookie }),
  );
  assert.equal(parentDetail.subtasks[0].id, subtask.id);
  assert.equal(
    parentDetail.task.description,
    "[Reference](https://example.test)",
  );
  parent = (
    await json(
      await request(`/api/tasks/${parent.id}`, {
        method: "PATCH",
        cookie,
        body: {
          version: parent.version,
          title: "Ship reviewed B1",
          columnId: columns[1].id,
          checklist: [{ id: "review", text: "Review the board", done: true }],
          assigneeId: null,
          dueDate: null,
        },
      }),
    )
  ).task;
  assert.equal(parent.columnId, columns[1].id);
  assert.equal(parent.checklist[0].done, true);
  assert.equal(parent.assigneeId, null);
  parent = (
    await json(
      await request(`/api/tasks/${parent.id}/move`, {
        cookie,
        body: { version: parent.version, columnId: columns[2].id },
      }),
    )
  ).task;
  assert.deepEqual(
    await json(
      await request(`/api/tasks/${parent.id}`, {
        method: "DELETE",
        cookie,
        body: { version: parent.version },
      }),
    ),
    { ok: true },
  );
  assert.equal(
    (await request(`/api/tasks/${parent.id}`, { cookie })).status,
    404,
  );
  assert.equal(
    (await request(`/api/tasks/${subtask.id}`, { cookie })).status,
    404,
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
  for (const path of ["/api/audit", "/api/export"])
    assert.equal((await request(path, { cookie: writer.cookie })).status, 403);
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
    `/api/boards/${privateBoard.id}/columns`,
    `/api/boards/${privateBoard.id}/tasks`,
    `/api/tasks/${privateTask.id}`,
    `/api/tasks/${privateTask.id}/comments`,
    `/api/tasks/${privateTask.id}/activity`,
    "/api/audit",
    "/api/export",
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
      await request(`/api/boards/${board.id}`, {
        method: "PATCH",
        token,
        body: { version: board.version, beforeId: privateBoard.id },
      })
    ).status,
    403,
  );
  assert.equal((await request("/api/import", { token, body: {} })).status, 403);
  const readCredential = await json(
    await request("/api/credentials", {
      cookie,
      body: {
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

test("concurrent task edits and moves reject stale versions without lost fields or duplicate ranks", async () => {
  const { cookie, board, columns } = await fixture();
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
  const moves = await Promise.all(
    [columns[1], columns[2]].map((col) =>
      request(`/api/tasks/${item.id}/move`, {
        cookie,
        body: { columnId: col.id, version: fresh.version },
      }),
    ),
  );
  assert.deepEqual(moves.map((r) => r.status).sort(), [200, 409]);
  const a = await createTask(cookie, board.id, "Independent A", {
    columnId: columns[0].id,
  });
  const b = await createTask(cookie, board.id, "Independent B", {
    columnId: columns[1].id,
  });
  const independent = await Promise.all(
    [a, b].map((row) =>
      request(`/api/tasks/${row.id}/move`, {
        cookie,
        body: { columnId: columns[2].id, version: row.version },
      }),
    ),
  );
  assert.deepEqual(
    independent.map((r) => r.status),
    [200, 200],
  );
  const rows =
    await sql`SELECT column_id,position FROM tasks WHERE board_id=${board.id} ORDER BY column_id,position`;
  for (const col of columns)
    assert.deepEqual(
      rows.filter((t) => t.columnId === col.id).map((t) => t.position),
      rows.filter((t) => t.columnId === col.id).map((_t, index) => index),
    );
});

test("status reorder is concurrent-safe and removal transfers all tasks without orphaned statuses", async () => {
  const { cookie, board, columns } = await fixture();
  const item = await createTask(cookie, board.id, "A status task");
  const reorder = await Promise.all(
    [columns[1].id, null].map((beforeId) =>
      request(`/api/columns/${columns[2].id}`, {
        method: "PATCH",
        cookie,
        body: { version: columns[2].version, beforeId },
      }),
    ),
  );
  assert.deepEqual(reorder.map((r) => r.status).sort(), [200, 409]);
  const currentColumns = (
    await json(await request(`/api/boards/${board.id}/columns`, { cookie }))
  ).items;
  assert.deepEqual(
    currentColumns.map((col: { position: number }) => col.position),
    [0, 1, 2],
  );
  const initial = currentColumns.find(
    (col: { id: string }) => col.id === item.columnId,
  );
  assert.equal(
    (
      await request(`/api/columns/${initial.id}`, {
        method: "DELETE",
        cookie,
        body: { version: initial.version },
      })
    ).status,
    409,
  );
  await json(
    await request(`/api/columns/${initial.id}`, {
      method: "DELETE",
      cookie,
      body: { version: initial.version, moveToColumnId: columns[1].id },
    }),
  );
  const updated = (
    await json(await request(`/api/tasks/${item.id}`, { cookie }))
  ).task;
  assert.equal(updated.columnId, columns[1].id);
  const remaining = (
    await json(await request(`/api/boards/${board.id}/columns`, { cookie }))
  ).items;
  assert.deepEqual(
    remaining.map((col: { position: number }) => col.position),
    [0, 1],
  );
});

test("combined search filters and keyset pagination are bounded and deterministic", async () => {
  const { cookie, board } = await fixture();
  for (let index = 0; index < 7; index++)
    await createTask(cookie, board.id, `Release ${index}`, {
      priority: "high",
      labels: ["B1"],
      description: index === 6 ? "contains wildcard_%" : "",
    });
  await createTask(cookie, board.id, "Unrelated task", {
    priority: "low",
    labels: ["other"],
  });
  let cursor: string | null = null;
  const ids: string[] = [];
  do {
    const page = await json(
      await request(
        `/api/boards/${board.id}/tasks?q=Release&priority=high&label=B1&assigneeId=unassigned&limit=2&sort=title${cursor ? "&cursor=" + cursor : ""}`,
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

test("portable export/import preserves data and member attribution without granting access or leaking secrets", async () => {
  const { cookie, user, board } = await fixture();
  const teammate = await member(cookie, "portable@example.test");
  const parent = await createTask(cookie, board.id, "Portable parent", {
    assigneeId: teammate.user.id,
    checklist: [{ id: "one", text: "Persist me", done: true }],
    dueDate: "2026-10-04",
  });
  await createTask(cookie, board.id, "Portable subtask", {
    parentId: parent.id,
  });
  await json(
    await request(`/api/tasks/${parent.id}/comments`, {
      cookie: teammate.cookie,
      body: { body: "Portable comment" },
    }),
    201,
  );
  const exported = await json(await request("/api/export", { cookie }));
  const serialized = JSON.stringify(exported);
  for (const forbidden of [
    "passwordHash",
    "tokenHash",
    "publicKey",
    "recoveryCodes",
    "sessions",
  ])
    assert.equal(serialized.includes(forbidden), false);
  assert.equal(exported.format, "mill-portable");
  await resetDatabase();
  const destination = await setupUser({
    email: "destination@example.test",
    name: "Destination admin",
  });
  const imported = await json(
    await request("/api/import", {
      cookie: destination.cookie,
      body: exported,
    }),
    201,
  );
  assert.equal(imported.imported.tasks, 2);
  assert.equal(imported.imported.comments, 1);
  const [admin] =
    await sql`SELECT role,disabled_at FROM users WHERE id=${destination.user.id}`;
  assert.equal(admin.role, "admin");
  assert.equal(admin.disabledAt, null);
  const [restoredMember] =
    await sql`SELECT id,disabled_at FROM users WHERE email=${teammate.user.email}`;
  assert.ok(restoredMember.disabledAt);
  assert.notEqual(restoredMember.id, teammate.user.id);
  const [restoredTask] =
    await sql`SELECT * FROM tasks WHERE title='Portable parent'`;
  assert.equal(restoredTask.assigneeId, restoredMember.id);
  assert.equal(restoredTask.identifier, parent.identifier);
  assert.equal(restoredTask.checklist[0].done, true);
  const child = (
    await sql`SELECT * FROM tasks WHERE title='Portable subtask'`
  )[0];
  assert.equal(child.parentId, restoredTask.id);
  assert.notEqual(restoredTask.createdBy, user.id);
  const detail = await json(
    await request(`/api/tasks/${restoredTask.id}`, {
      cookie: destination.cookie,
    }),
  );
  assert.equal(detail.comments[0].body, "Portable comment");
  assert.equal(detail.comments[0].authorId, restoredMember.id);
  const reinvited = await member(destination.cookie, teammate.user.email);
  assert.equal(reinvited.user.id, restoredMember.id);
  assert.equal(
    (
      await request(`/api/tasks/${restoredTask.id}`, {
        cookie: reinvited.cookie,
      })
    ).status,
    200,
  );
});

test("invalid imports fail before changing data and live task relations cannot create cycles or cross boards", async () => {
  const { cookie, board } = await fixture();
  const a = await createTask(cookie, board.id, "A");
  const b = await createTask(cookie, board.id, "B", { parentId: a.id });
  assert.equal(
    (
      await request(`/api/tasks/${a.id}`, {
        method: "PATCH",
        cookie,
        body: { version: a.version, parentId: b.id },
      })
    ).status,
    400,
  );
  const other = (
    await json(
      await request("/api/boards", {
        cookie,
        body: { name: "Other", prefix: "REL" },
      }),
      201,
    )
  ).board;
  assert.equal(
    (
      await request(`/api/boards/${other.id}/tasks`, {
        cookie,
        body: { title: "Invalid", parentId: a.id },
      })
    ).status,
    400,
  );
  const exported = await json(await request("/api/export", { cookie }));
  const before = (await sql`SELECT count(*)::int AS total FROM boards`)[0]
    .total;
  exported.tasks[0].parentId = exported.tasks[1].id;
  exported.tasks[1].parentId = exported.tasks[0].id;
  assert.equal(
    (await request("/api/import", { cookie, body: exported })).status,
    400,
  );
  assert.equal(
    (await sql`SELECT count(*)::int AS total FROM boards`)[0].total,
    before,
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

test("exports remain internally consistent while tasks and comments are concurrently created", async () => {
  const { cookie, board } = await fixture();
  const snapshots = await Promise.all(
    Array.from({ length: 8 }, async (_unused, index) => {
      const write = (async () => {
        const task = await createTask(cookie, board.id, `Concurrent ${index}`);
        await json(
          await request(`/api/tasks/${task.id}/comments`, {
            cookie,
            body: { body: `Comment ${index}` },
          }),
          201,
        );
      })();
      const exportResponse = await json(
        await request("/api/export", { cookie }),
      );
      await write;
      return exportResponse;
    }),
  );
  for (const snapshot of snapshots) {
    const ids = new Set(snapshot.tasks.map((t: { id: string }) => t.id));
    assert.ok(
      snapshot.comments.every((comment: { taskId: string }) =>
        ids.has(comment.taskId),
      ),
    );
  }
  const latest = await json(await request("/api/export", { cookie }));
  assert.equal(latest.tasks.length, 8);
  assert.equal(latest.comments.length, 8);
  assert.equal(
    (await request("/api/import", { cookie, body: latest })).status,
    201,
  );
});

test("comment, activity, notification and audit pagination preserve PostgreSQL microsecond ordering", async () => {
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
    [
      "/api/audit",
      (
        await sql`SELECT (SELECT count(*) FROM activity)+(SELECT count(*) FROM auth_audit) AS total`
      )[0].total,
    ],
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

test("bounded input validation rejects invalid sorts, impossible relations and oversized task/comment fields", async () => {
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
    {
      title: "Task",
      labels: Array.from({ length: 21 }, (_unused, index) => `Label ${index}`),
    },
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

test("portable data excludes permanently deleted work and preserves accepted account email lengths and task numbering", async () => {
  const email =
    "x".repeat(64) +
    "@" +
    [
      "a".repeat(63),
      "b".repeat(63),
      "c".repeat(63),
      "d".repeat(55),
      "test",
    ].join(".");
  assert.equal(email.length, 317);
  const { cookie } = await setupUser({ email });
  const created = await json(
    await request("/api/boards", {
      cookie,
      body: { name: "Portable work", prefix: "PAR" },
    }),
    201,
  );
  const surviving = await createTask(
    cookie,
    created.board.id,
    "Surviving record",
  );
  const deleted = await createTask(cookie, created.board.id, "Deleted record");
  await json(
    await request(`/api/tasks/${deleted.id}`, {
      cookie,
      method: "DELETE",
      body: { version: deleted.version },
    }),
  );
  const exported = await json(await request("/api/export", { cookie }));
  assert.equal(exported.version, 2);
  assert.equal(exported.members[0].email, email);
  assert.equal(exported.boards[0].nextNumber, 3);
  assert.equal(exported.tasks.length, 1);
  assert.equal(exported.tasks[0].id, surviving.id);
  for (const row of [...exported.boards, ...exported.tasks]) {
    assert.equal(Object.hasOwn(row, "archived"), false);
    assert.equal(Object.hasOwn(row, "deletedAt"), false);
  }
  const imported = await json(
    await request("/api/import", { cookie, body: exported }),
    201,
  );
  const next = await createTask(
    cookie,
    imported.imported.boardIds[0],
    "Next imported task",
  );
  assert.match(next.identifier, /-3$/);
});

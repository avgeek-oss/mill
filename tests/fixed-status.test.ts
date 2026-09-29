import { after, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { TASK_STATUSES } from "../packages/contracts/src/index.js";
import type { Task } from "../packages/contracts/src/index.js";
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
async function fixture() {
  const admin = await setupUser();
  const { board } = await json(
    await request("/api/boards", {
      cookie: admin.cookie,
      body: { name: "Fixed workflow", prefix: "FIX" },
    }),
    201,
  );
  return { ...admin, board };
}
async function createTask(
  cookie: string,
  boardId: string,
  title: string,
  fields: Record<string, unknown> = {},
): Promise<Task> {
  return (
    await json(
      await request(`/api/boards/${boardId}/tasks`, {
        cookie,
        body: { title, ...fields },
      }),
      201,
    )
  ).task;
}
async function tasks(cookie: string, boardId: string, query: string) {
  const items: Task[] = [];
  let cursor: string | null = null;
  do {
    const page = await json(
      await request(
        `/api/boards/${boardId}/tasks?limit=2${query ? "&" + query : ""}${cursor ? "&cursor=" + cursor : ""}`,
        { cookie },
      ),
    );
    assert.ok(page.items.length <= 2);
    items.push(...page.items);
    assert.equal(page.hasMore, page.nextCursor !== null);
    cursor = page.nextCursor;
    assert.ok(items.length <= 100, "Task pagination did not terminate");
  } while (cursor);
  assert.equal(new Set(items.map((item) => item.id)).size, items.length);
  return items;
}

test("every fixed status persists, creation defaults to Todo and versioned edits preserve other fields", async () => {
  const { cookie, board } = await fixture();
  assert.deepEqual(TASK_STATUSES, [
    "backlog",
    "todo",
    "in_progress",
    "in_review",
    "done",
    "wont_do",
  ]);
  const detail = await json(
    await request(`/api/boards/${board.id}`, { cookie }),
  );
  assert.deepEqual(Object.keys(detail), ["board"]);
  assert.equal(Object.hasOwn(detail.board, "position"), false);
  let item = await createTask(cookie, board.id, "Default workflow", {
    description: "Preserve this context",
    priority: "high",
    dueDate: "2026-10-04",
    checklist: [{ id: "review", text: "Review", done: false }],
  });
  assert.equal(item.status, "todo");
  for (const field of ["columnId", "labels", "parentId", "position"])
    assert.equal(Object.hasOwn(item, field), false, field);
  for (const status of TASK_STATUSES) {
    const created = await createTask(cookie, board.id, `Start ${status}`, {
      status,
    });
    assert.equal(created.status, status);
    assert.equal(
      (await json(await request(`/api/tasks/${created.id}`, { cookie }))).task
        .status,
      status,
    );
    const previousVersion = item.version;
    item = (
      await json(
        await request(`/api/tasks/${item.id}`, {
          method: "PATCH",
          cookie,
          body: { version: previousVersion, status },
        }),
      )
    ).task;
    assert.equal(item.status, status);
    assert.equal(item.version, previousVersion + 1);
    assert.equal(item.description, "Preserve this context");
    assert.equal(item.priority, "high");
    assert.equal(item.dueDate, "2026-10-04");
    assert.deepEqual(item.checklist, [
      { id: "review", text: "Review", done: false },
    ]);
    assert.equal(
      (
        await request(`/api/tasks/${item.id}`, {
          method: "PATCH",
          cookie,
          body: { version: previousVersion, status: "todo" },
        })
      ).status,
      409,
    );
  }
  const persisted = (
    await json(await request(`/api/tasks/${item.id}`, { cookie }))
  ).task;
  assert.equal(persisted.status, "wont_do");
  assert.equal(persisted.version, item.version);
});

test("status filtering composes with search and priority and binds pagination to the chosen status", async () => {
  const { cookie, board } = await fixture();
  const matching = [];
  for (let index = 0; index < 5; index++)
    matching.push(
      await createTask(cookie, board.id, `Release ${index}`, {
        status: "in_review",
        priority: "high",
      }),
    );
  await createTask(cookie, board.id, "Release wrong status", {
    status: "done",
    priority: "high",
  });
  await createTask(cookie, board.id, "Release wrong priority", {
    status: "in_review",
    priority: "low",
  });
  await createTask(cookie, board.id, "Unrelated", {
    status: "in_review",
    priority: "high",
  });
  const query =
    "q=Release&status=in_review&priority=high&assigneeId=unassigned&sort=title";
  assert.deepEqual(
    (await tasks(cookie, board.id, query)).map((item) => item.id),
    matching.map((item) => item.id),
  );
  const first = await json(
    await request(`/api/boards/${board.id}/tasks?limit=2&status=in_review`, {
      cookie,
    }),
  );
  assert.ok(first.nextCursor);
  assert.equal(
    (
      await request(
        `/api/boards/${board.id}/tasks?status=done&cursor=${first.nextCursor}`,
        { cookie },
      )
    ).status,
    400,
  );
  for (const status of ["Done", "custom", "in-progress", "", "constructor"])
    assert.equal(
      (
        await request(`/api/boards/${board.id}/tasks?status=${status}`, {
          cookie,
        })
      ).status,
      400,
      status,
    );
});

test("task sorts traverse ties deterministically and default to newest creation first", async () => {
  const { cookie, board } = await fixture();
  const rows = [
    {
      title: "Bravo",
      priority: "none",
      dueDate: null,
      created: "2026-09-28 00:00:00.000001",
      updated: "2026-09-28 00:00:00.000005",
    },
    {
      title: "alpha",
      priority: "urgent",
      dueDate: "2026-10-03",
      created: "2026-09-28 00:00:00.000002",
      updated: "2026-09-28 00:00:00.000001",
    },
    {
      title: "Alpha",
      priority: "high",
      dueDate: "2026-10-01",
      created: "2026-09-28 00:00:00.000002",
      updated: "2026-09-28 00:00:00.000006",
    },
    {
      title: "Charlie",
      priority: "medium",
      dueDate: null,
      created: "2026-09-28 00:00:00.000003",
      updated: "2026-09-28 00:00:00.000002",
    },
    {
      title: "Echo",
      priority: "low",
      dueDate: "2026-10-03",
      created: "2026-09-28 00:00:00.000004",
      updated: "2026-09-28 00:00:00.000002",
    },
    {
      title: "Delta",
      priority: "high",
      dueDate: "2026-10-02",
      created: "2026-09-28 00:00:00.000005",
      updated: "2026-09-28 00:00:00.000003",
    },
    {
      title: "Foxtrot",
      priority: "none",
      dueDate: "2026-10-01",
      created: "2026-09-28 00:00:00.000006",
      updated: "2026-09-28 00:00:00.000004",
    },
  ];
  const created: ((typeof rows)[number] & { id: string })[] = [];
  for (const row of rows) {
    const item = await createTask(cookie, board.id, row.title, {
      priority: row.priority,
      dueDate: row.dueDate,
      status: "todo",
    });
    await sql`UPDATE tasks SET created_at=${row.created}::text::timestamptz,updated_at=${row.updated}::text::timestamptz WHERE id=${item.id}`;
    created.push({ ...row, id: item.id });
  }
  const priorityOrder = ["urgent", "high", "medium", "low", "none"];
  const expectedFor = (sort: string) => {
    const key = (row: (typeof created)[number]) => {
      if (sort === "title") return row.title.toLowerCase();
      if (sort === "priority")
        return String(priorityOrder.indexOf(row.priority));
      if (sort === "dueDate") return row.dueDate ?? "9999-12-31";
      return sort === "updatedAt" ? row.updated : row.created;
    };
    const direction = ["createdAt", "updatedAt"].includes(sort) ? -1 : 1;
    return [...created]
      .sort((a, b) => {
        const left = key(a),
          right = key(b);
        const difference =
          left < right ? -1 : left > right ? 1 : a.id < b.id ? -1 : 1;
        return direction * difference;
      })
      .map((item) => item.id);
  };
  for (const sort of ["title", "dueDate", "priority", "updatedAt", "createdAt"])
    assert.deepEqual(
      (await tasks(cookie, board.id, `sort=${sort}`)).map((item) => item.id),
      expectedFor(sort),
      sort,
    );
  assert.deepEqual(
    (await tasks(cookie, board.id, "")).map((item) => item.id),
    expectedFor("createdAt"),
  );
});

test("removed fields fail validation without changing tasks or boards", async () => {
  const { cookie, board } = await fixture();
  const item = await createTask(cookie, board.id, "Preserve this task");
  const taskFields = {
    labels: ["legacy"],
    parentId: item.id,
    columnId: randomUUID(),
    position: 1,
    beforeId: null,
  };
  for (const [field, value] of Object.entries(taskFields)) {
    assert.equal(
      (
        await request(`/api/boards/${board.id}/tasks`, {
          cookie,
          body: { title: "Rejected task", [field]: value },
        })
      ).status,
      400,
      `create ${field}`,
    );
    assert.equal(
      (
        await request(`/api/tasks/${item.id}`, {
          cookie,
          method: "PATCH",
          body: { version: item.version, [field]: value },
        })
      ).status,
      400,
      `edit ${field}`,
    );
  }
  for (const status of ["Done", "custom", "", null, 1]) {
    assert.equal(
      (
        await request(`/api/boards/${board.id}/tasks`, {
          cookie,
          body: { title: "Rejected status", status },
        })
      ).status,
      400,
    );
    assert.equal(
      (
        await request(`/api/tasks/${item.id}`, {
          cookie,
          method: "PATCH",
          body: { version: item.version, status },
        })
      ).status,
      400,
    );
  }
  for (const [field, value] of Object.entries({
    position: 1,
    beforeId: null,
  })) {
    assert.equal(
      (
        await request("/api/boards", {
          cookie,
          body: { name: "Rejected board", [field]: value },
        })
      ).status,
      400,
    );
    assert.equal(
      (
        await request(`/api/boards/${board.id}`, {
          cookie,
          method: "PATCH",
          body: { version: board.version, [field]: value },
        })
      ).status,
      400,
    );
  }
  const persisted = (
    await json(await request(`/api/tasks/${item.id}`, { cookie }))
  ).task;
  assert.deepEqual(persisted, item);
  assert.equal((await tasks(cookie, board.id, "")).length, 1);
  assert.equal(
    (await json(await request("/api/boards", { cookie }))).items.length,
    1,
  );
  for (const query of [
    "columnId=" + randomUUID(),
    "label=legacy",
    "parentId=" + item.id,
    "sort=position",
  ])
    assert.equal(
      (await request(`/api/boards/${board.id}/tasks?${query}`, { cookie }))
        .status,
      400,
    );
});

test("removed workflow and portable routes return 404 for human and agent clients", async () => {
  const { cookie, board } = await fixture();
  const item = await createTask(cookie, board.id, "Current task");
  const { token } = await json(
    await request("/api/credentials", {
      cookie,
      body: { name: "Writer", scopes: ["read", "write"], boardIds: [board.id] },
    }),
    201,
  );
  const columnId = randomUUID();
  for (const auth of [{ cookie }, { token }])
    for (const [path, method, body] of [
      [`/api/boards/${board.id}/columns`, "GET", undefined],
      [`/api/boards/${board.id}/columns`, "POST", { name: "Custom" }],
      [`/api/columns/${columnId}`, "PATCH", { version: 1, name: "Edited" }],
      [`/api/columns/${columnId}`, "DELETE", { version: 1 }],
      [
        `/api/tasks/${item.id}/move`,
        "POST",
        { version: item.version, status: "done" },
      ],
      [`/api/tasks/${item.id}/subtasks`, "GET", undefined],
      ["/api/export", "GET", undefined],
      ["/api/import", "POST", {}],
    ] as const)
      assert.equal(
        (await request(path, { ...auth, method, body })).status,
        404,
        `${method} ${path}`,
      );
  assert.equal(
    (await json(await request(`/api/tasks/${item.id}`, { cookie }))).task
      .version,
    item.version,
  );
});

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, beforeEach, test } from "node:test";
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
  const { cookie } = await setupUser();
  const { board } = await json(
    await request("/api/boards", {
      cookie,
      body: { name: "Bulk actions", prefix: "BULK" },
    }),
    201,
  );
  const tasks: Task[] = [];
  for (const title of ["First", "Second"])
    tasks.push(
      (
        await json(
          await request(`/api/boards/${board.id}/tasks`, {
            cookie,
            body: {
              title,
              description: "Keep the description",
              acceptanceCriteria: "- Keep criteria",
              type: "bug",
              priority: "high",
              status: "todo",
              startDate: "2026-10-01",
              dueDate: "2026-10-31",
            },
          }),
          201,
        )
      ).task,
    );
  const bulk = (
    items: Pick<Task, "id" | "version">[],
    changes: object,
    auth = cookie,
  ) =>
    request(`/api/boards/${board.id}/tasks/bulk`, {
      method: "PATCH",
      cookie: auth,
      body: {
        tasks: items.map(({ id, version }) => ({ id, version })),
        changes,
      },
    });
  const read = async () =>
    Promise.all(
      tasks.map(
        async ({ id }) =>
          (await json(await request(`/api/tasks/${id}`, { cookie })))
            .task as Task,
      ),
    );
  return { cookie, board, tasks, bulk, read };
}

async function teammate(cookie: string) {
  const invitation = await json(
    await request("/api/auth/invitations", {
      cookie,
      body: { email: "assignee@example.test", role: "member" },
    }),
    201,
  );
  const accepted = await request("/api/auth/accept-invitation", {
    body: {
      token: invitation.token,
      name: "Bulk assignee",
      password: "Another secure passphrase 42!",
    },
  });
  const { user } = await json(accepted, 201);
  return { user, cookie: accepted.headers.get("set-cookie")!.split(";")[0] };
}

test("bulk assignment and unassignment preserve other fields and respect assignment notifications", async () => {
  const { cookie, board, tasks, bulk, read } = await fixture();
  const member = await teammate(cookie);
  const filteredCount = async (assigneeId: string) =>
    (
      await json(
        await request(
          `/api/boards/${board.id}/tasks?page=1&limit=10&assigneeId=${assigneeId}`,
          { cookie },
        ),
      )
    ).total;
  const notifications = async () =>
    (await json(await request("/api/notifications", { cookie: member.cookie })))
      .items;
  await json(await bulk(tasks, { assigneeId: member.user.id }));
  let saved = await read();
  assert.equal(await filteredCount(member.user.id), 2);
  assert.equal(await filteredCount("unassigned"), 0);
  for (let index = 0; index < saved.length; index++) {
    assert.equal(saved[index].assigneeId, member.user.id);
    assert.equal(saved[index].version, tasks[index].version + 1);
    for (const key of [
      "title",
      "description",
      "acceptanceCriteria",
      "priority",
      "status",
      "startDate",
      "dueDate",
      "statusChangedAt",
    ] as const)
      assert.equal(saved[index][key], tasks[index][key], key);
    const detail = await json(
      await request(`/api/tasks/${saved[index].id}`, { cookie }),
    );
    assert.ok(
      detail.activity.some(
        (item: { action: string; detail: { fields?: string[] } }) =>
          item.action === "task.updated" &&
          item.detail.fields?.includes("assigneeId"),
      ),
    );
  }
  assert.equal((await notifications()).length, 2);
  await json(await bulk(saved, { assigneeId: member.user.id }));
  assert.equal(
    (await notifications()).length,
    2,
    "Reapplying the same assignee must not notify again",
  );
  saved = await read();
  await json(await bulk(saved, { assigneeId: null }));
  saved = await read();
  assert.ok(saved.every((task) => task.assigneeId === null));
  assert.equal(await filteredCount(member.user.id), 0);
  assert.equal(await filteredCount("unassigned"), 2);
  assert.equal((await notifications()).length, 2);
  await sql`UPDATE users SET notification_preferences='{"assignments":false,"mentions":true}'::jsonb WHERE id=${member.user.id}`;
  await json(await bulk(saved, { assigneeId: member.user.id }));
  assert.ok((await read()).every((task) => task.assigneeId === member.user.id));
  assert.equal(
    (await notifications()).length,
    2,
    "Bulk assignments must respect notification preferences",
  );
});

test("invalid or inactive assignees and stale versions roll back every assignment without notifications", async () => {
  const { cookie, tasks, bulk, read } = await fixture();
  const member = await teammate(cookie);
  await json(
    await bulk(tasks, { assigneeId: randomUUID(), priority: "low" }),
    400,
  );
  assert.deepEqual(await read(), tasks);
  await sql`UPDATE users SET disabled_at=now() WHERE id=${member.user.id}`;
  await json(
    await bulk(tasks, { assigneeId: member.user.id, priority: "low" }),
    400,
  );
  assert.deepEqual(await read(), tasks);
  await sql`UPDATE users SET disabled_at=NULL WHERE id=${member.user.id}`;
  await json(
    await request(`/api/tasks/${tasks[1].id}`, {
      cookie,
      method: "PATCH",
      body: { version: tasks[1].version, title: "Changed elsewhere" },
    }),
  );
  const baseline = await read();
  await json(
    await bulk(tasks, { assigneeId: member.user.id, priority: "low" }),
    409,
  );
  assert.deepEqual(await read(), baseline);
  const notifications = await json(
    await request("/api/notifications", { cookie: member.cookie }),
  );
  assert.equal(notifications.items.length, 0);
});

test("bulk status, priority and date updates preserve other content and clear dates", async () => {
  const { cookie, board, tasks, bulk, read } = await fixture();
  const initial = await json(
    await request(
      `/api/boards/${board.id}/tasks?sort=priority&page=1&limit=10`,
      { cookie },
    ),
  );
  const { items } = await json(
    await bulk(tasks, {
      priority: "low",
      status: "in_review",
      startDate: "2026-10-18",
      dueDate: "2026-10-25",
    }),
  );
  assert.equal(items.length, 2);
  let persisted = await read();
  for (let index = 0; index < tasks.length; index++) {
    const original = tasks[index];
    const saved = persisted[index];
    assert.equal(saved.version, original.version + 1);
    for (const key of [
      "id",
      "identifier",
      "title",
      "description",
      "acceptanceCriteria",
      "type",
      "assigneeId",
    ] as const)
      assert.equal(saved[key], original[key], key);
    assert.equal(saved.priority, "low");
    assert.equal(saved.status, "in_review");
    assert.equal(saved.startDate, "2026-10-18");
    assert.equal(saved.dueDate, "2026-10-25");
    const detail = await json(
      await request(`/api/tasks/${saved.id}`, { cookie }),
    );
    assert.ok(
      detail.activity.some(
        (item: { action: string }) => item.action === "task.moved",
      ),
    );
    assert.ok(
      detail.activity.some(
        (item: { action: string }) => item.action === "task.updated",
      ),
    );
  }
  await json(
    await request(
      `/api/boards/${board.id}/tasks?sort=priority&page=1&limit=10&revision=${initial.revision}`,
      { cookie },
    ),
    409,
  );
  const clocks = persisted.map((task) => task.statusChangedAt);
  await json(
    await bulk(
      persisted.map((task) => ({ ...task, id: task.id.toUpperCase() })),
      { startDate: null, dueDate: null },
    ),
  );
  persisted = await read();
  persisted.forEach((task, index) => {
    assert.equal(task.startDate, null);
    assert.equal(task.dueDate, null);
    assert.equal(task.priority, "low");
    assert.equal(task.statusChangedAt, clocks[index]);
  });
});

test("stale versions, missing tasks and tasks from another board leave the entire selection unchanged", async () => {
  const { cookie, tasks, bulk, read } = await fixture();
  const edited = (
    await json(
      await request(`/api/tasks/${tasks[1].id}`, {
        method: "PATCH",
        cookie,
        body: { version: tasks[1].version, title: "Changed elsewhere" },
      }),
    )
  ).task;
  const baseline = await read();
  await json(await bulk(tasks, { priority: "urgent" }), 409);
  assert.deepEqual(await read(), baseline);
  await json(
    await bulk([tasks[0], { id: randomUUID(), version: 1 }], {
      status: "done",
    }),
    404,
  );
  assert.deepEqual(await read(), baseline);
  const { board: other } = await json(
    await request("/api/boards", {
      cookie,
      body: { name: "Other", prefix: "OTHER" },
    }),
    201,
  );
  const foreign = (
    await json(
      await request(`/api/boards/${other.id}/tasks`, {
        cookie,
        body: { title: "Foreign task" },
      }),
      201,
    )
  ).task;
  await json(await bulk([tasks[0], foreign], { dueDate: null }), 404);
  assert.deepEqual(await read(), baseline);
  const recovered = await json(
    await bulk([tasks[0], edited], { priority: "urgent" }),
  );
  assert.equal(recovered.items.length, 2);
});

test("bulk validation and read-only permissions reject requests before changing any tasks", async () => {
  const { cookie, board, tasks, bulk, read } = await fixture();
  for (const changes of [
    {},
    { title: "Unsupported" },
    { status: "custom" },
    { priority: "critical" },
    { assigneeId: "not-a-user" },
    { startDate: "2026-02-30" },
    { dueDate: "not a date" },
  ])
    await json(await bulk(tasks, changes), 400);
  await json(await bulk([], { status: "done" }), 400);
  await json(await bulk([tasks[0], tasks[0]], { status: "done" }), 400);
  await json(
    await bulk([tasks[0], { ...tasks[0], id: tasks[0].id.toUpperCase() }], {
      status: "done",
    }),
    400,
  );
  await json(
    await bulk(
      Array.from({ length: 101 }, () => ({ id: randomUUID(), version: 1 })),
      { status: "done" },
    ),
    400,
  );
  const invitation = await json(
    await request("/api/auth/invitations", {
      cookie,
      body: { email: "viewer@example.test", role: "viewer" },
    }),
    201,
  );
  const accepted = await request("/api/auth/accept-invitation", {
    body: {
      token: invitation.token,
      name: "Viewer",
      password: "Another secure passphrase 42!",
    },
  });
  await json(accepted, 201);
  const viewerCookie = accepted.headers.get("set-cookie")!.split(";")[0];
  await json(
    await bulk(
      tasks,
      {
        priority: "urgent",
        status: "done",
        assigneeId: null,
        startDate: null,
        dueDate: null,
      },
      viewerCookie,
    ),
    403,
  );
  assert.deepEqual(await read(), tasks);
  for (const access of ["read", "edit"]) {
    const key = await json(
      await request("/api/credentials", {
        cookie,
        body: {
          name: `${access} bulk key`,
          access,
          includeAdmin: false,
          expiresAt: new Date(Date.now() + 2 * 86400000).toISOString(),
        },
      }),
      201,
    );
    const response = await request(`/api/boards/${board.id}/tasks/bulk`, {
      method: "PATCH",
      token: key.token,
      body: {
        tasks: tasks.map(({ id, version }) => ({ id, version })),
        changes: { priority: "low" },
      },
    });
    await json(response, access === "read" ? 403 : 200);
    if (access === "read") assert.deepEqual(await read(), tasks);
  }
  assert.ok((await read()).every((task) => task.priority === "low"));
});

test("overlapping concurrent batches serialize so one complete update wins and the other conflicts", async () => {
  const { tasks, bulk, read } = await fixture();
  const results = await Promise.all([
    bulk(tasks, { priority: "urgent" }),
    bulk([...tasks].reverse(), { priority: "low" }),
  ]);
  assert.deepEqual(
    results.map((response) => response.status).sort(),
    [200, 409],
  );
  const persisted = await read();
  assert.equal(persisted[0].priority, persisted[1].priority);
  for (const task of persisted) assert.equal(task.version, 2);
});

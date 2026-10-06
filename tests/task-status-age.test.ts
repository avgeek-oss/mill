import { after, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import type { Task, TaskStatus } from "../packages/contracts/src/index.js";
import {
  callMcpTool,
  cleanupDatabase,
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
async function fixture() {
  const admin = await setupUser();
  const { board } = await json(
    await request("/api/boards", {
      cookie: admin.cookie,
      body: { name: "Status history", prefix: "AGE" },
    }),
    201,
  );
  const create = async (title: string, status: TaskStatus): Promise<Task> =>
    (
      await json(
        await request(`/api/boards/${board.id}/tasks`, {
          cookie: admin.cookie,
          body: { title, status, priority: "high" },
        }),
        201,
      )
    ).task;
  const list = async (query = "") =>
    json(
      await request(`/api/boards/${board.id}/tasks?sort=title&${query}`, {
        cookie: admin.cookie,
      }),
    );
  return { ...admin, board, create, list };
}

test("default pages exclude only terminal tasks older than 24 hours; explicit status includes history", async () => {
  const { cookie, board, create, list } = await fixture();
  const old = [];
  const visible = [];
  for (const status of ["done", "wont_do"] as const) {
    const archivedFromDefault = await create(`Old ${status}`, status);
    await sql`UPDATE tasks SET status_changed_at=now()-interval '25 hours' WHERE id=${archivedFromDefault.id}`;
    old.push(archivedFromDefault);
    const recent = await create(`Recent ${status}`, status);
    await sql`UPDATE tasks SET status_changed_at=now()-interval '23 hours' WHERE id=${recent.id}`;
    visible.push(recent);
  }
  for (const status of [
    "backlog",
    "todo",
    "in_progress",
    "in_review",
  ] as const) {
    const active = await create(`Active ${status}`, status);
    await sql`UPDATE tasks SET status_changed_at=now()-interval '30 days',updated_at=now()-interval '30 days' WHERE id=${active.id}`;
    visible.push(active);
  }
  const expected = visible.map((task) => task.id).sort();
  for (const query of ["", "priority=high&assigneeId=unassigned", "q=Old"]) {
    const page = await list(query);
    assert.equal(page.total, query === "q=Old" ? 0 : visible.length);
    assert.deepEqual(
      page.items.map((task: Task) => task.id).sort(),
      query === "q=Old" ? [] : expected,
    );
  }
  const paged = await list("limit=2&page=999");
  assert.equal(paged.total, 6);
  assert.equal(paged.page, 3);
  assert.equal(paged.items.length, 2);
  assert.equal(paged.hasMore, false);
  for (const task of old) {
    const filtered = await list(`status=${task.status}&q=Old&priority=high`);
    assert.equal(filtered.total, 1);
    assert.equal(filtered.items[0].id, task.id);
    assert.equal(
      (await json(await request(`/api/tasks/${task.id}`, { cookie }))).task.id,
      task.id,
    );
  }
  const key = await json(
    await request("/api/credentials", {
      cookie,
      body: { name: "Status history reader" },
    }),
    201,
  );
  const oauth = await setupOAuth(cookie, {
    scopes: ["read"],
    boardIds: [board.id],
  });
  const rest = await json(
    await request(`/api/boards/${board.id}/tasks`, { token: key.token }),
  );
  assert.deepEqual(rest.items.map((task: Task) => task.id).sort(), expected);
  for (const status of [undefined, "done", "wont_do"]) {
    const { result, error } = await callMcpTool(oauth.token, "list_tasks", {
      boardId: board.id,
      ...(status ? { status } : {}),
    });
    assert.equal(error, undefined);
    assert.equal(result?.isError, false);
    const page = result!.structuredContent!;
    assert.deepEqual(
      (page.items as Task[]).map((task) => task.id).sort(),
      status
        ? [...old, ...visible]
            .filter((task) => task.status === status)
            .map((task) => task.id)
            .sort()
        : expected,
    );
  }
});

test("unrelated edits and repeated terminal status preserve age; reopening starts a new window", async () => {
  const { cookie, create, list } = await fixture();
  for (const status of ["done", "wont_do"] as const) {
    let task = await create(`Old ${status}`, status);
    const [aged] =
      await sql`UPDATE tasks SET status_changed_at=now()-interval '2 days' WHERE id=${task.id} RETURNING status_changed_at`;
    const edit = async (fields: Record<string, unknown>) => {
      task = (
        await json(
          await request(`/api/tasks/${task.id}`, {
            cookie,
            method: "PATCH",
            body: { version: task.version, ...fields },
          }),
        )
      ).task;
    };
    await edit({
      title: `Renamed ${status}`,
      description: "Still complete",
      status,
    });
    assert.equal(task.statusChangedAt, aged.statusChangedAt.toISOString());
    assert.ok(Date.now() - Date.parse(task.updatedAt) < 10000);
    await json(
      await request(`/api/tasks/${task.id}/comments`, {
        cookie,
        body: { body: "Keep this discussion" },
      }),
      201,
    );
    assert.equal(
      (await list()).items.some((item: Task) => item.id === task.id),
      false,
    );
    await edit({ status: "todo" });
    assert.ok(
      Date.parse(task.statusChangedAt) > aged.statusChangedAt.getTime(),
    );
    assert.equal(
      (await list()).items.some((item: Task) => item.id === task.id),
      true,
    );
    const reopenedAt = task.statusChangedAt;
    await edit({ status });
    assert.ok(Date.parse(task.statusChangedAt) >= Date.parse(reopenedAt));
    assert.equal(
      (await list()).items.some((item: Task) => item.id === task.id),
      true,
    );
    assert.equal(
      (await list(`status=${status}`)).items.some(
        (item: Task) => item.id === task.id,
      ),
      true,
    );
    assert.equal(
      (
        await request(`/api/tasks/${task.id}`, {
          cookie,
          method: "PATCH",
          body: { version: task.version, statusChangedAt: reopenedAt },
        })
      ).status,
      400,
    );
  }
});

test("aging out without a task version change invalidates default cursor and numbered-page revisions", async () => {
  const { cookie, board, create, list } = await fixture();
  const expired = await create("A completed", "done");
  await create("B completed", "done");
  await create("C active", "in_progress");
  await create("D active", "backlog");
  const otherCompleted = await create("E completed", "done");
  const first = await list("limit=2");
  const explicit = await list("status=done&limit=2");
  assert.equal(first.total, 5);
  assert.ok(first.nextCursor);
  await sql`UPDATE tasks SET status_changed_at=now()-interval '25 hours' WHERE id=${expired.id}`;
  const [persisted] =
    await sql`SELECT version FROM tasks WHERE id=${expired.id}`;
  assert.equal(persisted.version, expired.version);
  for (const pagination of [
    `cursor=${first.nextCursor}`,
    `page=2&revision=${first.revision}`,
  ]) {
    const response = await json(
      await request(
        `/api/boards/${board.id}/tasks?limit=2&sort=title&${pagination}`,
        { cookie },
      ),
      409,
    );
    assert.equal(response.code, "task_list_changed");
  }
  const current = await list("limit=2");
  assert.equal(current.total, 4);
  assert.notEqual(current.revision, first.revision);
  const last = await list(`limit=2&cursor=${current.nextCursor}`);
  assert.equal(last.hasMore, false);
  assert.deepEqual(
    [...current.items, ...last.items].map((task: Task) => task.title),
    ["B completed", "C active", "D active", "E completed"],
  );
  const stillFiltered = await list(
    `status=done&page=1&revision=${explicit.revision}`,
  );
  assert.equal(stillFiltered.total, 3);
  assert.equal(stillFiltered.items[0].id, expired.id);
  const explicitLast = await list(
    `status=done&limit=2&cursor=${explicit.nextCursor}`,
  );
  assert.deepEqual(
    explicitLast.items.map((task: Task) => task.id),
    [otherCompleted.id],
  );
});

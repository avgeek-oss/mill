import { after, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { Board, Task } from "../packages/contracts/src/index.js";
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
type Page = { items: Task[]; hasMore: boolean; nextCursor: string | null };
async function createBoard(
  cookie: string,
  name: string,
  prefix: string,
): Promise<Board> {
  return (
    await json(
      await request("/api/boards", { cookie, body: { name, prefix } }),
      201,
    )
  ).board;
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
async function editTask(
  cookie: string,
  task: Task,
  fields: Record<string, unknown>,
): Promise<Task> {
  return (
    await json(
      await request(`/api/tasks/${task.id}`, {
        cookie,
        method: "PATCH",
        body: { version: task.version, ...fields },
      }),
    )
  ).task;
}
async function fixture(fields: Record<string, unknown> = {}) {
  const admin = await setupUser();
  const board = await createBoard(admin.cookie, "Pagination", "PAGE");
  const items: Task[] = [];
  for (const title of ["A", "B", "C", "D"])
    items.push(await createTask(admin.cookie, board.id, title, fields));
  return { ...admin, board, items };
}
async function page(
  cookie: string,
  boardId: string,
  query: string,
  cursor?: string | null,
): Promise<Page> {
  return json(
    await request(
      `/api/boards/${boardId}/tasks?limit=2&${query}${cursor ? "&cursor=" + cursor : ""}`,
      { cookie },
    ),
  );
}
async function traversal(
  cookie: string,
  boardId: string,
  query: string,
  first?: Page,
) {
  let current = first ?? (await page(cookie, boardId, query));
  const ids = current.items.map((item) => item.id);
  while (current.hasMore) {
    assert.ok(current.nextCursor);
    current = await page(cookie, boardId, query, current.nextCursor);
    ids.push(...current.items.map((item) => item.id));
    assert.ok(ids.length <= 100, "Pagination did not terminate");
  }
  assert.equal(current.nextCursor, null);
  assert.equal(new Set(ids).size, ids.length);
  return ids;
}
async function stale(
  cookie: string,
  boardId: string,
  query: string,
  first: Page,
) {
  assert.ok(first.nextCursor);
  const response = await request(
    `/api/boards/${boardId}/tasks?limit=2&${query}&cursor=${first.nextCursor}`,
    { cookie },
  );
  assert.deepEqual(await json(response, 409), {
    code: "task_list_changed",
    error: "Task list changed. Reload tasks to continue.",
  });
}
function encode(value: unknown) {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

test("renaming an unvisited task across the title cursor requires a complete restart", async () => {
  const { cookie, board, items } = await fixture();
  const first = await page(cookie, board.id, "sort=title");
  assert.deepEqual(
    first.items.map((item) => item.title),
    ["A", "B"],
  );
  await editTask(cookie, items[2]!, { title: "AA" });
  await stale(cookie, board.id, "sort=title", first);
  assert.deepEqual(await traversal(cookie, board.id, "sort=title"), [
    items[0]!.id,
    items[2]!.id,
    items[1]!.id,
    items[3]!.id,
  ]);
});

test("tasks entering and leaving a status filter invalidate continuation before omissions", async () => {
  const { cookie, board, items } = await fixture({ status: "in_review" });
  const outside = await createTask(cookie, board.id, "Z", { status: "todo" });
  const query = "sort=title&status=in_review";
  const first = await page(cookie, board.id, query);
  await editTask(cookie, outside, { status: "in_review" });
  await stale(cookie, board.id, query, first);
  assert.deepEqual(await traversal(cookie, board.id, query), [
    ...items.map((item) => item.id),
    outside.id,
  ]);
  const restarted = await page(cookie, board.id, query);
  await editTask(cookie, items[2]!, { status: "done" });
  await stale(cookie, board.id, query, restarted);
  assert.deepEqual(await traversal(cookie, board.id, query), [
    items[0]!.id,
    items[1]!.id,
    items[3]!.id,
    outside.id,
  ]);
});

test("an edit moving an unvisited task to the newest updatedAt position invalidates continuation", async () => {
  const { cookie, board, items } = await fixture();
  for (const [index, item] of items.entries())
    await sql`UPDATE tasks SET updated_at=${`2026-09-28 00:00:00.00000${index + 1}`}::text::timestamptz WHERE id=${item.id}`;
  const first = await page(cookie, board.id, "sort=updatedAt");
  assert.deepEqual(
    first.items.map((item) => item.id),
    [items[3]!.id, items[2]!.id],
  );
  await editTask(cookie, items[0]!, { description: "Latest context" });
  await stale(cookie, board.id, "sort=updatedAt", first);
  assert.deepEqual(await traversal(cookie, board.id, "sort=updatedAt"), [
    items[0]!.id,
    items[3]!.id,
    items[2]!.id,
    items[1]!.id,
  ]);
});

test("task inserts and deletions invalidate continuation and restarting returns every surviving task", async () => {
  const { cookie, board, items } = await fixture();
  const first = await page(cookie, board.id, "sort=title");
  const inserted = await createTask(cookie, board.id, "AA");
  await stale(cookie, board.id, "sort=title", first);
  assert.deepEqual(await traversal(cookie, board.id, "sort=title"), [
    items[0]!.id,
    inserted.id,
    items[1]!.id,
    items[2]!.id,
    items[3]!.id,
  ]);
  const restarted = await page(cookie, board.id, "sort=title");
  assert.equal(restarted.items.at(-1)!.id, inserted.id);
  await json(
    await request(`/api/tasks/${inserted.id}`, {
      cookie,
      method: "DELETE",
      body: { version: inserted.version },
    }),
  );
  await stale(cookie, board.id, "sort=title", restarted);
  assert.deepEqual(
    await traversal(cookie, board.id, "sort=title"),
    items.map((item) => item.id),
  );
});

test("same-board edits outside the active filter invalidate the snapshot", async () => {
  const { cookie, board, items } = await fixture({ status: "in_review" });
  const outside = await createTask(cookie, board.id, "Outside filter", {
    status: "todo",
  });
  const query = "sort=title&status=in_review";
  const first = await page(cookie, board.id, query);
  await editTask(cookie, outside, { description: "Changed outside this view" });
  await stale(cookie, board.id, query, first);
  assert.deepEqual(
    await traversal(cookie, board.id, query),
    items.map((item) => item.id),
  );
});

test("another board's mutations and comments preserve a current task cursor", async () => {
  const { cookie, board, items } = await fixture();
  const other = await createBoard(cookie, "Independent board", "OTHER");
  const first = await page(cookie, board.id, "sort=title");
  let external = await createTask(cookie, other.id, "External task");
  external = await editTask(cookie, external, {
    title: "Updated external task",
    status: "done",
  });
  await json(
    await request(`/api/tasks/${external.id}`, {
      cookie,
      method: "DELETE",
      body: { version: external.version },
    }),
  );
  await json(
    await request(`/api/tasks/${items[2]!.id}/comments`, {
      cookie,
      body: { body: "Discussion without changing the task" },
    }),
    201,
  );
  const detail = await json(
    await request(`/api/tasks/${items[2]!.id}`, { cookie }),
  );
  assert.equal(detail.task.version, items[2]!.version);
  assert.deepEqual(
    await traversal(cookie, board.id, "sort=title", first),
    items.map((item) => item.id),
  );
});

test("task cursors reject malformed, legacy, forged and wrong-search anchors", async () => {
  const { cookie, board, items } = await fixture({
    status: "in_review",
    priority: "high",
  });
  const excluded = await createTask(cookie, board.id, "Excluded", {
    status: "todo",
    priority: "low",
  });
  const other = await createBoard(cookie, "Other board", "OTHER");
  const foreign = await createTask(cookie, other.id, "Foreign task");
  const query = "sort=title&status=in_review&priority=high";
  const first = await page(cookie, board.id, query);
  assert.ok(first.nextCursor);
  const payload = JSON.parse(
    Buffer.from(first.nextCursor, "base64url").toString(),
  );
  assert.match(payload.revision, /^[a-f0-9]{32}$/);
  const { revision: _revision, ...legacy } = payload;
  const invalid = [
    "",
    "not-json",
    encode({}),
    encode(legacy),
    encode({ ...payload, revision: "" }),
    encode({ ...payload, revision: "invalid-revision" }),
    encode({ ...payload, key: "forged key" }),
    encode({ ...payload, id: randomUUID() }),
    encode({ ...payload, id: foreign.id }),
    encode({ ...payload, id: excluded.id, key: "excluded" }),
    encode({ ...payload, id: items[2]!.id }),
    encode({ ...payload, unexpected: "field" }),
  ];
  for (const cursor of invalid)
    assert.equal(
      (
        await request(
          `/api/boards/${board.id}/tasks?${query}&cursor=${cursor}`,
          { cookie },
        )
      ).status,
      400,
      cursor,
    );
  for (const wrongQuery of [
    "sort=title&status=todo&priority=high",
    "sort=title&status=in_review&priority=low",
    "sort=title&status=in_review&priority=high&q=A",
    "sort=updatedAt&status=in_review&priority=high",
    "sort=title&status=in_review&priority=high&assigneeId=unassigned",
  ])
    assert.equal(
      (
        await request(
          `/api/boards/${board.id}/tasks?${wrongQuery}&cursor=${first.nextCursor}`,
          { cookie },
        )
      ).status,
      400,
      wrongQuery,
    );
  assert.equal(
    (
      await request(
        `/api/boards/${other.id}/tasks?${query}&cursor=${first.nextCursor}`,
        { cookie },
      )
    ).status,
    400,
  );
  assert.deepEqual(
    await traversal(cookie, board.id, query, first),
    items.map((item) => item.id),
  );
});

test("a personal API key reads future-board task pages and restarts after its human-owner edit", async () => {
  const { cookie } = await setupUser();
  const key = await json(
    await request("/api/credentials", {
      cookie,
      body: { name: "Task page automation", expiresInDays: 365 },
    }),
    201,
  );
  assert.equal(key.credential.agentId, null);
  assert.equal(key.credential.boardIds, null);
  const future = await createBoard(cookie, "Created after key", "FUTURE");
  const items: Task[] = [];
  for (const title of ["A", "B", "C", "D"])
    items.push(await createTask(cookie, future.id, title));
  const path = `/api/boards/${future.id}/tasks?limit=2&sort=title`;
  const first: Page = await json(await request(path, { token: key.token }));
  assert.deepEqual(
    first.items.map((item) => item.id),
    items.slice(0, 2).map((item) => item.id),
  );
  assert.ok(first.nextCursor);
  assert.deepEqual(
    await json(
      await request(`${path}&cursor=${first.nextCursor}`, { token: key.token }),
    ),
    await json(await request(`${path}&cursor=${first.nextCursor}`, { cookie })),
  );
  const changed = await json(
    await request(`/api/tasks/${items[2]!.id}`, {
      token: key.token,
      method: "PATCH",
      body: { version: items[2]!.version, title: "AA" },
    }),
  );
  assert.equal(changed.task.agentId, null);
  const stale = await json(
    await request(`${path}&cursor=${first.nextCursor}`, { token: key.token }),
    409,
  );
  assert.equal(stale.code, "task_list_changed");
  let current: Page = await json(await request(path, { token: key.token }));
  const ids = current.items.map((item) => item.id);
  while (current.hasMore) {
    assert.ok(current.nextCursor);
    current = await json(
      await request(`${path}&cursor=${current.nextCursor}`, {
        token: key.token,
      }),
    );
    ids.push(...current.items.map((item) => item.id));
    assert.ok(ids.length <= items.length);
  }
  assert.equal(current.nextCursor, null);
  assert.deepEqual(ids, [
    items[0]!.id,
    items[2]!.id,
    items[1]!.id,
    items[3]!.id,
  ]);
  assert.equal(new Set(ids).size, items.length);
});

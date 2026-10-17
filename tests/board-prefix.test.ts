import { after, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import {
  cleanupDatabase,
  request,
  resetDatabase,
  setupUser,
  setupOAuth,
  callMcpTool,
  sql,
} from "./support.js";

beforeEach(resetDatabase);
after(cleanupDatabase);
async function json(response: Response, status = 200) {
  assert.equal(response.status, status, await response.clone().text());
  return response.json();
}
async function createBoard(cookie: string, prefix: string) {
  return (
    await json(
      await request("/api/boards", {
        cookie,
        body: {
          name: prefix,
          prefix,
          description: "Keep this board description",
        },
      }),
      201,
    )
  ).board;
}
async function createTask(cookie: string, boardId: string) {
  return (
    await json(
      await request(`/api/boards/${boardId}/tasks`, {
        cookie,
        body: { title: "Review task" },
      }),
      201,
    )
  ).task;
}
async function rename(
  cookie: string,
  boardId: string,
  version: number,
  prefix: string,
) {
  return request(`/api/boards/${boardId}`, {
    cookie,
    method: "PATCH",
    body: { version, prefix },
  });
}

test("prefix edits rename existing identifiers atomically, preserve task links and numbers, and invalidate stale edits and pages", async () => {
  const { cookie } = await setupUser();
  const board = await createBoard(cookie, "ENG");
  const first = await createTask(cookie, board.id);
  const second = await createTask(cookie, board.id);
  const page = await json(
    await request(`/api/boards/${board.id}/tasks?limit=1`, { cookie }),
  );
  const updated = (
    await json(await rename(cookie, board.id, board.version, " dev "))
  ).board;
  assert.equal(updated.prefix, "DEV");
  assert.equal(updated.name, "ENG");
  assert.equal(updated.description, "Keep this board description");
  assert.equal(updated.nextNumber, 3);
  for (const original of [first, second]) {
    const { task } = await json(
      await request(`/api/tasks/${original.id}`, { cookie }),
    );
    assert.equal(task.id, original.id);
    assert.equal(task.identifier, original.identifier.replace("ENG-", "DEV-"));
    assert.equal(task.version, original.version + 1);
    assert.equal(task.statusChangedAt, original.statusChangedAt);
  }
  assert.equal((await createTask(cookie, board.id)).identifier, "DEV-3");
  await json(
    await request(`/api/tasks/${first.id}`, {
      cookie,
      method: "PATCH",
      body: { version: first.version, title: "Stale edit" },
    }),
    409,
  );
  await json(
    await request(
      `/api/boards/${board.id}/tasks?cursor=${encodeURIComponent(page.nextCursor)}`,
      { cookie },
    ),
    409,
  );
  await json(await rename(cookie, board.id, board.version, "OLD"), 409);
  const restored = (
    await json(await rename(cookie, board.id, updated.version, "ENG"))
  ).board;
  assert.equal(restored.prefix, "ENG");
  assert.equal((await createTask(cookie, board.id)).identifier, "ENG-4");
});

test("duplicate prefixes and invalid values leave board and task data unchanged", async () => {
  const { cookie } = await setupUser();
  const board = await createBoard(cookie, "ENG");
  await createBoard(cookie, "PRD");
  const task = await createTask(cookie, board.id);
  const duplicate = await json(
    await rename(cookie, board.id, board.version, "prd"),
    409,
  );
  assert.equal(duplicate.error.code, "BOARD_PREFIX_TAKEN");
  for (const prefix of ["", "X", "1ENG", "ENG-TEAM", "ABCDEFGHIJK"])
    await json(await rename(cookie, board.id, board.version, prefix), 400);
  const current = (
    await json(await request(`/api/boards/${board.id}`, { cookie }))
  ).board;
  assert.equal(current.prefix, "ENG");
  assert.equal(current.version, board.version);
  assert.equal(
    (await json(await request(`/api/tasks/${task.id}`, { cookie }))).task
      .identifier,
    "ENG-1",
  );
  await sql`UPDATE boards SET last_activity_at='2001-01-01' WHERE id=${board.id}`;
  const unchanged = (
    await json(await rename(cookie, board.id, board.version, "eng"))
  ).board;
  assert.equal(new Date(unchanged.lastActivityAt).getUTCFullYear(), 2001);
  const changed = (
    await json(await rename(cookie, board.id, unchanged.version, "DEV"))
  ).board;
  assert.ok(new Date(changed.lastActivityAt).getUTCFullYear() > 2001);
});

test("concurrent prefix changes and board creation cannot claim the same prefix", async () => {
  const { cookie } = await setupUser();
  const first = await createBoard(cookie, "ENG");
  const second = await createBoard(cookie, "PRD");
  const results = await Promise.all([
    rename(cookie, first.id, first.version, "SAME"),
    rename(cookie, second.id, second.version, "SAME"),
    request("/api/boards", {
      cookie,
      body: { name: "Concurrent board", prefix: "SAME" },
    }),
  ]);
  assert.equal(results.filter((response) => response.ok).length, 1);
  assert.equal(results.filter((response) => response.status === 409).length, 2);
  assert.equal(
    (await sql`SELECT id FROM boards WHERE prefix='SAME'`).length,
    1,
  );
});

test("task creation serialized with a prefix edit uses the committed prefix and preserves sequence", async () => {
  const { cookie } = await setupUser();
  const board = await createBoard(cookie, "ENG");
  await createTask(cookie, board.id);
  await Promise.all([
    rename(cookie, board.id, board.version, "DEV").then((response) =>
      json(response),
    ),
    createTask(cookie, board.id),
  ]);
  const tasks =
    await sql`SELECT identifier FROM tasks WHERE board_id=${board.id} ORDER BY identifier`;
  assert.deepEqual(
    tasks.map((task) => task.identifier),
    ["DEV-1", "DEV-2"],
  );
  assert.equal((await createTask(cookie, board.id)).identifier, "DEV-3");
});

test("MCP shares prefix validation and viewer permissions prevent edits", async () => {
  const { cookie, user } = await setupUser();
  const board = await createBoard(cookie, "ENG");
  const oauth = await setupOAuth(cookie);
  const called = await callMcpTool(oauth.token, "update_board", {
    boardId: board.id,
    version: board.version,
    prefix: "NEW",
  });
  assert.equal(called.result?.isError, false, JSON.stringify(called.result));
  assert.equal(
    (await json(await request(`/api/boards/${board.id}`, { cookie }))).board
      .prefix,
    "NEW",
  );
  const empty = await createBoard(cookie, "EMPTY");
  await sql`UPDATE boards SET last_activity_at='2001-01-01' WHERE id=${empty.id}`;
  const changed = (
    await json(await rename(cookie, empty.id, empty.version, "OTHER"))
  ).board;
  assert.ok(new Date(changed.lastActivityAt).getUTCFullYear() > 2001);
  await sql`UPDATE users SET role='viewer' WHERE id=${user.id}`;
  await json(await rename(cookie, empty.id, changed.version, "NOPE"), 403);
  assert.equal(
    (await sql`SELECT prefix FROM boards WHERE id=${empty.id}`)[0].prefix,
    "OTHER",
  );
});

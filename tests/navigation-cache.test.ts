import assert from "node:assert/strict";
import { test } from "node:test";
import type { Board, Task } from "../packages/contracts/src/index.js";
import { parseBoardUrl } from "../apps/web/src/board-url.js";
import { NavigationCache } from "../apps/web/src/navigation-cache.js";

const board: Board = {
  id: "board-1",
  name: "Engineering",
  prefix: "ENG",
  description: "Engineering tasks",
  version: 1,
};
const task: Task = {
  id: "task-1",
  boardId: board.id,
  identifier: "ENG-1",
  type: "task",
  title: "Review navigation",
  description: "Keep content visible while refreshing.",
  acceptanceCriteria: "- Navigation stays visible.",
  status: "todo",
  statusChangedAt: "2026-10-17T12:00:00Z",
  assigneeId: null,
  priority: "high",
  startDate: null,
  dueDate: null,
  createdAt: "2026-10-17T12:00:00Z",
  updatedAt: "2026-10-17T12:00:00Z",
  version: 1,
};
const state = parseBoardUrl(`/boards/${board.id}`);
const page = { items: [task], total: 1, page: 1, revision: "revision-1" };

test("board data supplies task details immediately and restores each exact list view", () => {
  const cache = new NavigationCache();
  cache.rememberBoardPage(board, state, page, cache.generation);
  assert.deepEqual(cache.task(task.id), task);
  assert.deepEqual(cache.boardPage(board.id, state)?.tasks, page);
  for (const query of [
    "q=other",
    "status=done",
    "priority=low",
    "assigneeId=unassigned",
    "sort=title",
    "page=2",
    "limit=10",
  ]) {
    const other = parseBoardUrl(`/boards/${board.id}?${query}`);
    assert.equal(cache.boardPage(board.id, other), null, query);
    cache.rememberBoardPage(
      board,
      other,
      { ...page, items: [], total: 0, page: other.page },
      cache.generation,
    );
    assert.deepEqual(cache.boardPage(board.id, state)?.tasks, page);
  }
  assert.equal(cache.boardPage("another-board", state), null);
});

test("saved edits reach cached rows without older responses undoing them, and deletion removes them", () => {
  const cache = new NavigationCache();
  cache.rememberBoardPage(board, state, page, cache.generation);
  const saved = {
    ...task,
    title: "Navigation reviewed",
    acceptanceCriteria: "- Both navigation directions are verified.",
    version: 2,
  };
  cache.rememberTask(saved, cache.generation);
  assert.deepEqual(cache.boardPage(board.id, state)?.tasks.items, [saved]);
  cache.rememberBoardPage(board, state, page, cache.generation);
  assert.deepEqual(cache.task(task.id), saved);
  assert.deepEqual(cache.boardPage(board.id, state)?.tasks.items, [saved]);
  cache.forgetTask(task.id);
  assert.equal(cache.task(task.id), null);
  assert.deepEqual(cache.boardPage(board.id, state)?.tasks.items, []);
  assert.equal(cache.boardPage(board.id, state)?.tasks.total, 0);
});

test("access and identity resets reject late responses from the previous cache generation", () => {
  const cache = new NavigationCache();
  const previous = cache.generation;
  cache.rememberBoardPage(board, state, page, previous);
  cache.clear();
  cache.rememberBoardPage(board, state, page, previous);
  cache.rememberTask(task, previous);
  assert.equal(cache.boardPage(board.id, state), null);
  assert.equal(cache.task(task.id), null);
  cache.rememberBoardPage(board, state, page, cache.generation);
  cache.forgetBoard(board.id);
  assert.equal(cache.boardPage(board.id, state), null);
  assert.equal(cache.task(task.id), null);
});

test("bulk edits invalidate filtered board pages while keeping task details and other boards warm", () => {
  const cache = new NavigationCache();
  const filtered = parseBoardUrl(`/boards/${board.id}?priority=high`);
  const otherBoard = { ...board, id: "board-2" };
  cache.rememberBoardPage(board, state, page, cache.generation);
  cache.rememberBoardPage(board, filtered, page, cache.generation);
  cache.rememberBoardPage(
    otherBoard,
    state,
    { ...page, items: [] },
    cache.generation,
  );
  cache.forgetBoardPages(board.id);
  const saved = { ...task, priority: "low" as const, version: 2 };
  cache.rememberTask(saved, cache.generation);
  assert.equal(cache.boardPage(board.id, state), null);
  assert.equal(cache.boardPage(board.id, filtered), null);
  assert.deepEqual(cache.task(task.id), saved);
  assert.ok(cache.boardPage(otherBoard.id, state));
});

test("board metadata refreshes cached headers and prefix changes discard old task identifiers", () => {
  const cache = new NavigationCache();
  cache.rememberBoardPage(board, state, page, cache.generation);
  cache.rememberBoard({ ...board, name: "Development", version: 2 });
  cache.rememberBoard(board);
  assert.equal(cache.boardPage(board.id, state)?.board.name, "Development");
  cache.rememberBoard({ ...board, prefix: "DEV", version: 3 });
  assert.equal(cache.boardPage(board.id, state), null);
  assert.equal(cache.task(task.id), null);
});

test("navigation cache expires after five minutes and evicts least recently used entries", () => {
  let now = 0;
  const cache = new NavigationCache(() => now);
  cache.rememberBoardPage(board, state, page, cache.generation);
  now = 299_999;
  assert.ok(cache.task(task.id));
  assert.ok(cache.boardPage(board.id, state));
  now = 300_000;
  assert.equal(cache.task(task.id), null);
  assert.equal(cache.boardPage(board.id, state), null);
  for (let index = 0; index < 100; index++)
    cache.rememberTask({ ...task, id: String(index) }, cache.generation);
  assert.ok(cache.task("0"));
  cache.rememberTask({ ...task, id: "100" }, cache.generation);
  assert.ok(cache.task("0"));
  assert.equal(cache.task("1"), null);
  for (let index = 0; index < 8; index++)
    cache.rememberBoardPage(
      board,
      { ...state, q: String(index) },
      page,
      cache.generation,
    );
  assert.ok(cache.boardPage(board.id, { ...state, q: "0" }));
  cache.rememberBoardPage(board, state, page, cache.generation);
  assert.ok(cache.boardPage(board.id, { ...state, q: "0" }));
  assert.equal(cache.boardPage(board.id, { ...state, q: "1" }), null);
});

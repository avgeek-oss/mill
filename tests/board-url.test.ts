import assert from "node:assert/strict";
import { test } from "node:test";
import { boardUrl, parseBoardUrl } from "../apps/web/src/board-url.js";

test("board URLs default to priority and normalize unsupported sort values", () => {
  for (const query of ["", "?sort=priority", "?sort=unsupported", "?sort="]) {
    const state = parseBoardUrl(`/boards/board-1${query}`);
    assert.equal(state.sort, "priority");
    assert.equal(boardUrl("board-1", state), "/boards/board-1");
  }
});

test("an explicit newest-first choice stays in task return links", () => {
  const url = "/boards/board-1?q=review&sort=createdAt&page=2&limit=10";
  const state = parseBoardUrl(url);
  assert.equal(state.sort, "createdAt");
  assert.equal(boardUrl("board-1", state), url);
  assert.deepEqual(parseBoardUrl(boardUrl("board-1", state)), state);
});

test("every selected sort round-trips with filters, pagination and unrelated URL settings", () => {
  for (const sort of [
    "createdAt",
    "priority",
    "title",
    "updatedAt",
    "dueDate",
    "status",
  ]) {
    const state = parseBoardUrl(
      `/boards/board-1?q=review&status=todo&priority=high&assigneeId=unassigned&sort=${sort}&page=3&limit=50`,
    );
    const url = boardUrl("board-1", state, "?layout=table");
    assert.deepEqual(parseBoardUrl(url), state);
    assert.ok(url.includes("layout=table"));
  }
});

import assert from "node:assert/strict";
import { afterEach, mock, test } from "node:test";
import { loadBoardSummaries } from "../apps/web/src/board-directory.js";
import { readBoardPage } from "../apps/web/src/board-page-data.js";
import { parseBoardUrl } from "../apps/web/src/board-url.js";

Object.assign(globalThis, {
  window: {
    __MILL_RUNTIME_CONFIG__: { apiOrigin: "https://mill-api.example" },
  },
});
afterEach(() => mock.restoreAll());
const board = {
  id: "board-1",
  name: "Engineering",
  prefix: "ENG",
  description: "Tasks",
  version: 1,
  lastActivityAt: "2026-10-27T12:00:00Z",
  createdBy: null,
  backlogCount: 0,
  activeCount: 1,
  inProgressCount: 0,
  todoCount: 1,
};
const directoryPage = (items: unknown[], nextCursor: string | null = null) =>
  Response.json({ items, nextCursor, hasMore: nextCursor !== null });

test("destination directory preparation completes every page and restarts a changed snapshot", async () => {
  const paths: string[] = [];
  mock.method(globalThis, "fetch", async (input: string) => {
    paths.push(input);
    switch (paths.length) {
      case 1:
        return directoryPage(
          [{ ...board, name: "Old snapshot" }],
          "old cursor",
        );
      case 2:
        return Response.json(
          { error: { code: "CONFLICT", message: "Changed" } },
          { status: 409 },
        );
      case 3:
        return directoryPage([board], "new cursor");
      default:
        return directoryPage([{ ...board, id: "board-2", name: "Design" }]);
    }
  });
  const result = await loadBoardSummaries();
  assert.deepEqual(
    result.map((item) => item.name),
    ["Design", "Engineering"],
  );
  assert.equal(paths.length, 4);
  assert.equal(new URL(paths[1]).searchParams.get("cursor"), "old cursor");
  assert.equal(new URL(paths[2]).searchParams.has("cursor"), false);
  assert.equal(new URL(paths[3]).searchParams.get("cursor"), "new cursor");
});

test("destination preparation rejects repeated cursors and propagates cancellation to fetch", async () => {
  const request = new AbortController();
  let calls = 0;
  mock.method(
    globalThis,
    "fetch",
    async (_input: string, init: RequestInit) => {
      calls++;
      assert.equal(init.signal, request.signal);
      init.signal?.throwIfAborted();
      return directoryPage([board], "repeated");
    },
  );
  await assert.rejects(
    loadBoardSummaries(request.signal),
    /could not be completed/,
  );
  assert.equal(calls, 2);
  request.abort();
  await assert.rejects(loadBoardSummaries(request.signal), {
    name: "AbortError",
  });
});

test("a board destination waits for metadata and its exact filtered task page in parallel", async () => {
  const urls: URL[] = [];
  let finishBoard!: (value: Response) => void;
  const metadata = new Promise<Response>((resolve) => {
    finishBoard = resolve;
  });
  const page = { items: [], total: 0, page: 3, revision: "snapshot" };
  const request = new AbortController();
  mock.method(globalThis, "fetch", async (input: string, init: RequestInit) => {
    const url = new URL(input);
    urls.push(url);
    assert.equal(init.signal, request.signal);
    return url.pathname.endsWith("/tasks") ? Response.json(page) : metadata;
  });
  let settled = false;
  const result = readBoardPage(
    board.id,
    parseBoardUrl(
      "/boards/board-1?q=review&priority=high&status=todo&assigneeId=unassigned&sort=dueDate&page=3&limit=10",
    ),
    request.signal,
  ).then((value) => {
    settled = true;
    return value;
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(urls.length, 2);
  assert.equal(settled, false);
  assert.deepEqual(
    Object.fromEntries(
      urls.find((url) => url.pathname.endsWith("/tasks"))!.searchParams,
    ),
    {
      q: "review",
      priority: "high",
      status: "todo",
      assigneeId: "unassigned",
      sort: "dueDate",
      page: "3",
      limit: "10",
    },
  );
  finishBoard(Response.json({ board }));
  assert.deepEqual(await result, { board, tasks: page });
});

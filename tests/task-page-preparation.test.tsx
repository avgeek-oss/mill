import "./react-test-environment.js";
import assert from "node:assert/strict";
import { after, afterEach, beforeEach, test } from "node:test";
import { Window } from "happy-dom";
import React, { act, useState } from "react";
import type { Board, Task } from "../packages/contracts/src/index.js";
import {
  PageNavigation,
  PageReadScope,
} from "../apps/web/src/page-navigation.js";
import { useTaskPagePreparation } from "../apps/web/src/task-page-preparation.js";
import {
  useTaskEditor,
  type TaskEditor,
} from "../apps/web/src/use-task-editor.js";
import { navigationCache } from "../apps/web/src/navigation-cache.js";
import { ApiError } from "../apps/web/src/api.js";

const browser = new Window({ url: "http://localhost/boards/board/tasks/task" });
Object.assign(globalThis, {
  window: browser,
  document: browser.document,
  HTMLElement: browser.HTMLElement,
  Node: browser.Node,
  Event: browser.Event,
  IS_REACT_ACT_ENVIRONMENT: true,
});
Object.assign(browser, {
  __MILL_RUNTIME_CONFIG__: { apiOrigin: "http://localhost:4321" },
});
const { createRoot } = await import("react-dom/client");
const originalFetch = globalThis.fetch;
const board: Board = {
  id: "11111111-1111-4111-8111-111111111111",
  name: "Engineering",
  prefix: "ENG",
  description: "Engineering work",
  version: 1,
};
const task: Task = {
  id: "22222222-2222-4222-8222-222222222222",
  boardId: board.id,
  identifier: "ENG-1",
  type: "task",
  title: "Review task preparation",
  description: "Read independent data together",
  acceptanceCriteria: "- No duplicate reads",
  status: "todo",
  statusChangedAt: "2026-10-27T08:00:00Z",
  assigneeId: null,
  priority: "high",
  startDate: null,
  dueDate: null,
  createdAt: "2026-10-27T08:00:00Z",
  updatedAt: "2026-10-27T08:00:00Z",
  version: 1,
};
function deferred() {
  let resolve!: (value: Response) => void;
  const promise = new Promise<Response>((success) => {
    resolve = success;
  });
  return { promise, resolve };
}
let sources: Map<string, ReturnType<typeof deferred>[]>;
let calls: { url: URL; signal: AbortSignal | null | undefined }[];
let prepared: ReturnType<typeof useTaskPagePreparation>;
let editor: TaskEditor;
let revise: (revision: number) => void;
let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
function pending(path: string) {
  const result = deferred();
  sources.set(path, [...(sources.get(path) ?? []), result]);
  return result;
}
const boardPath = `/api/boards/${board.id}`;
const taskPath = `/api/tasks/${task.id}`;
function Page({ revision }: { revision: number }) {
  prepared = useTaskPagePreparation(board.id, task.id, revision);
  editor = useTaskEditor(task.id, revision, prepared.task);
  return (
    <article>
      <p data-board>{prepared.board?.status}</p>
      {editor.accessDenied || !editor.task ? (
        <p role="alert">{editor.loadError}</p>
      ) : (
        <h1>{editor.values?.title}</h1>
      )}
    </article>
  );
}
function Shell() {
  const [revision, setRevision] = useState(0);
  revise = setRevision;
  return (
    <PageNavigation location="/task">
      {() => (
        <PageReadScope scope={`person:team:member:${revision}`}>
          <Page revision={revision} />
        </PageReadScope>
      )}
    </PageNavigation>
  );
}
beforeEach(() => {
  navigationCache.clear();
  sources = new Map();
  calls = [];
  globalThis.fetch = async (input, options) => {
    const url = new URL(String(input));
    calls.push({ url, signal: options?.signal });
    assert.equal(options?.method, "GET");
    const source = sources.get(url.pathname)?.shift();
    assert(source, `Unexpected request: ${url}`);
    return source.promise;
  };
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  globalThis.fetch = originalFetch;
  navigationCache.clear();
});
after(() => browser.happyDOM.close());

test("task-page preparation starts both independent requests before either resolves and seeds the editor once", async () => {
  const boardRead = pending(boardPath);
  const taskRead = pending(taskPath);
  await act(async () => root.render(<Shell />));
  assert.deepEqual(
    calls.map((call) => call.url.pathname).sort(),
    [boardPath, taskPath].sort(),
  );
  const preview = calls.find((call) => call.url.pathname === taskPath)!;
  assert.equal(preview.url.searchParams.get("commentLimit"), "0");
  assert.equal(preview.url.searchParams.get("activityLimit"), "0");
  await act(async () => boardRead.resolve(Response.json({ board })));
  assert.equal(container.querySelector("article"), null);
  await act(async () => taskRead.resolve(Response.json({ task })));
  assert.equal(prepared.board?.status, "fulfilled");
  assert.equal(prepared.task?.status, "fulfilled");
  assert.equal(container.querySelector("h1")?.textContent, task.title);
  assert.equal(calls.length, 2);
});

test("a board failure remains separate from a successful task preview", async () => {
  const boardRead = pending(boardPath);
  const taskRead = pending(taskPath);
  await act(async () => root.render(<Shell />));
  await act(async () => taskRead.resolve(Response.json({ task })));
  assert.equal(container.querySelector("article"), null);
  await act(async () =>
    boardRead.resolve(
      Response.json({ error: "Board unavailable" }, { status: 503 }),
    ),
  );
  assert.equal(prepared.board?.status, "rejected");
  assert.equal(prepared.task?.status, "fulfilled");
  assert.equal(editor.task?.id, task.id);
  assert.equal(calls.length, 2);
});

test("a denied task preview remains separate from the board result and does not start another GET", async () => {
  const boardRead = pending(boardPath);
  const taskRead = pending(taskPath);
  await act(async () => root.render(<Shell />));
  await act(async () => boardRead.resolve(Response.json({ board })));
  await act(async () =>
    taskRead.resolve(
      Response.json({ error: "Access revoked" }, { status: 403 }),
    ),
  );
  assert.equal(prepared.board?.status, "fulfilled");
  assert.equal(prepared.task?.status, "rejected");
  assert.equal(editor.accessDenied, true);
  assert.equal(container.querySelector("h1"), null);
  assert.equal(calls.length, 2);
});

for (const invalid of ["foreign-id", "missing-criteria"] as const)
  test(`parallel task preparation keeps the full task validator for ${invalid}`, async () => {
    const boardRead = pending(boardPath);
    const taskRead = pending(taskPath);
    await act(async () => root.render(<Shell />));
    const malformed: Partial<Task> = { ...task };
    if (invalid === "foreign-id") malformed.id = board.id;
    else delete malformed.acceptanceCriteria;
    await act(async () => {
      boardRead.resolve(Response.json({ board }));
      taskRead.resolve(Response.json({ task: malformed }));
    });
    assert.equal(prepared.task?.status, "rejected");
    if (prepared.task?.status === "rejected")
      assert(prepared.task.reason instanceof ApiError);
    assert.equal(editor.task, null);
    assert.equal(container.querySelector("h1"), null);
    assert.equal(calls.length, 2);
  });

test("scope replacement aborts both superseded requests and cannot adopt their late data", async () => {
  const oldBoard = pending(boardPath);
  const oldTask = pending(taskPath);
  await act(async () => root.render(<Shell />));
  const currentBoard = pending(boardPath);
  const currentTask = pending(taskPath);
  await act(async () => revise(1));
  assert.equal(calls.length, 4);
  await act(async () => {
    currentBoard.resolve(Response.json({ board }));
    currentTask.resolve(
      Response.json({ task: { ...task, title: "Current task", version: 2 } }),
    );
  });
  assert.equal(calls[0].signal?.aborted, true);
  assert.equal(calls[1].signal?.aborted, true);
  await act(async () => {
    oldBoard.resolve(Response.json({ board }));
    oldTask.resolve(Response.json({ task }));
  });
  assert.equal(container.querySelector("h1")?.textContent, "Current task");
  assert.equal(editor.task?.version, 2);
});

test("unmounting cancels both independent reads", async () => {
  const boardRead = pending(boardPath);
  const taskRead = pending(taskPath);
  await act(async () => root.render(<Shell />));
  await act(async () => root.unmount());
  assert.equal(calls.length, 2);
  assert(calls.every((call) => call.signal?.aborted));
  await act(async () => {
    boardRead.resolve(Response.json({ board }));
    taskRead.resolve(Response.json({ task }));
  });
  assert.equal(container.textContent, "");
});

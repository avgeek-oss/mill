import "./react-test-environment.js";
import assert from "node:assert/strict";
import { after, afterEach, beforeEach, test } from "node:test";
import { Window } from "happy-dom";
import React, { act, useState } from "react";
import {
  PageNavigation,
  PageReadScope,
} from "../apps/web/src/page-navigation.js";
import {
  useTaskEditor,
  type TaskEditor,
} from "../apps/web/src/use-task-editor.js";
import { navigationCache } from "../apps/web/src/navigation-cache.js";
import type { Task } from "../packages/contracts/src/index.js";

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
const task: Task = {
  id: "22222222-2222-4222-8222-222222222222",
  boardId: "11111111-1111-4111-8111-111111111111",
  identifier: "ENG-1",
  type: "task",
  title: "Review navigation",
  description: "Original description",
  acceptanceCriteria: "- Preserve drafts",
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
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((success) => {
    resolve = success;
  });
  return { promise, resolve };
}
function response(saved: Task) {
  return Response.json({ task: saved });
}
let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
let editor: TaskEditor;
let revise: (version: number) => void;
let reads: ReturnType<typeof deferred<Response>>[];
let writes: ReturnType<typeof deferred<Response>>[];
let calls: { method: string; body: string | undefined }[];
function Consumer({ revision }: { revision: number }) {
  editor = useTaskEditor(task.id, revision);
  if (editor.accessDenied)
    return <p role="alert">Task denied: {editor.loadErrorStatus}</p>;
  if (!editor.task || !editor.values) return <p>Not loaded</p>;
  return (
    <article data-version={editor.task.version}>
      <h1>{editor.values.title}</h1>
      <p>{editor.values.description}</p>
      {editor.loadError && <p role="alert">{editor.loadError}</p>}
    </article>
  );
}
function Shell() {
  const [revision, setRevision] = useState(0);
  revise = setRevision;
  return (
    <PageNavigation location="/task">
      {() => <PageContent revision={revision} />}
    </PageNavigation>
  );
}
function PageContent({ revision }: { revision: number }) {
  return (
    <PageReadScope scope={`person:workspace:member:${revision}`}>
      <Consumer revision={revision} />
    </PageReadScope>
  );
}
function nextRead() {
  const pending = deferred<Response>();
  reads.push(pending);
  return pending;
}
function nextWrite() {
  const pending = deferred<Response>();
  writes.push(pending);
  return pending;
}
async function mount() {
  const initial = nextRead();
  await act(async () => root.render(<Shell />));
  await act(async () => initial.resolve(response(task)));
  assert.equal(
    container.querySelector("article")?.getAttribute("data-version"),
    "1",
  );
}
beforeEach(() => {
  navigationCache.clear();
  reads = [];
  writes = [];
  calls = [];
  globalThis.fetch = async (_url, options) => {
    const method = options?.method ?? "GET";
    calls.push({
      method,
      body: typeof options?.body === "string" ? options.body : undefined,
    });
    const request = method === "PATCH" ? writes.shift() : reads.shift();
    assert(request, `Unexpected ${method} request`);
    return request.promise;
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

test("reauthentication adopts prepared values in the existing controller without a duplicate GET", async () => {
  await mount();
  const previousFlush = editor.flushAll;
  const prepared = nextRead();
  await act(async () => revise(1));
  await act(async () =>
    prepared.resolve(response({ ...task, title: "Fresh title", version: 3 })),
  );
  assert.equal(editor.flushAll, previousFlush);
  assert.equal(editor.task?.version, 3);
  assert.equal(editor.values?.title, "Fresh title");
  assert.equal(container.querySelector("h1")?.textContent, "Fresh title");
  assert.deepEqual(
    calls.map((call) => call.method),
    ["GET", "GET"],
  );
});

test("prepared refresh preserves dirty drafts, merges clean fields and retains conflict protection", async () => {
  await mount();
  await act(async () => editor.textChange("description", "My unsaved draft"));
  const prepared = nextRead();
  await act(async () => revise(1));
  await act(async () =>
    prepared.resolve(
      response({
        ...task,
        title: "Updated title",
        description: "Changed by another person",
        version: 2,
      }),
    ),
  );
  assert.equal(editor.values?.description, "My unsaved draft");
  assert.equal(editor.values?.title, "Updated title");
  assert.equal(editor.task?.description, "Changed by another person");
  assert.equal(editor.hasUnsavedChanges, true);
  let saved = true;
  await act(async () => {
    saved = await editor.flushAll();
  });
  assert.equal(saved, false);
  assert.equal(editor.fields.description?.conflict, true);
  assert.equal(editor.values?.description, "My unsaved draft");
  assert.equal(calls.filter((call) => call.method === "PATCH").length, 0);
});

for (const status of [403, 404])
  test(`prepared HTTP ${status} hides the prior task before another fetch and preserves its draft`, async () => {
    await mount();
    await act(async () => editor.textChange("description", "Keep this draft"));
    const prepared = nextRead();
    await act(async () => revise(1));
    await act(async () =>
      prepared.resolve(
        Response.json(
          {
            error: {
              code: "TASK_UNAVAILABLE",
              message: "Task is unavailable",
              requestId: "example",
            },
          },
          { status },
        ),
      ),
    );
    assert.equal(editor.accessDenied, true);
    assert.equal(editor.loadErrorStatus, status);
    assert.equal(container.querySelector("article"), null);
    assert(container.textContent?.includes(`Task denied: ${status}`));
    assert.equal(editor.values?.description, "Keep this draft");
    assert.equal(editor.hasUnsavedChanges, true);
    assert.equal(navigationCache.task(task.id), null);
    assert.equal(calls.length, 2);
  });

test("a late save from the prior preparation cannot restore access or repopulate the denied cache", async () => {
  await mount();
  const save = nextWrite();
  await act(async () => editor.updateField("priority", "urgent"));
  assert.equal(calls.filter((call) => call.method === "PATCH").length, 1);
  const prepared = nextRead();
  await act(async () => revise(1));
  await act(async () =>
    prepared.resolve(
      Response.json({ error: "Access revoked" }, { status: 403 }),
    ),
  );
  assert.equal(editor.accessDenied, true);
  await act(async () =>
    save.resolve(response({ ...task, priority: "urgent", version: 2 })),
  );
  assert.equal(editor.accessDenied, true);
  assert.equal(container.querySelector("article"), null);
  assert.equal(navigationCache.task(task.id), null);
  assert.equal(editor.hasUnsavedChanges, true);
  assert.equal(calls.length, 3);
});

test("a failed prepared refresh keeps existing content and the ordinary retry restores the editor", async () => {
  await mount();
  const prepared = nextRead();
  await act(async () => revise(1));
  await act(async () =>
    prepared.resolve(
      Response.json({ error: "Temporarily unavailable" }, { status: 503 }),
    ),
  );
  assert.equal(editor.accessDenied, false);
  assert(container.textContent?.includes("Original description"));
  assert(
    container
      .querySelector('[role="alert"]')
      ?.textContent?.includes("Temporarily unavailable"),
  );
  const retry = nextRead();
  let refreshed!: Promise<void>;
  await act(async () => {
    refreshed = editor.reload();
  });
  await act(async () => {
    retry.resolve(response({ ...task, title: "Recovered title", version: 4 }));
    await refreshed;
  });
  assert.equal(editor.loadError, "");
  assert.equal(editor.task?.version, 4);
  assert.equal(container.querySelector("h1")?.textContent, "Recovered title");
  assert.equal(calls.length, 3);
});

test("a prepared refresh supersedes an old in-flight save and resumes dirty work against the fresh version", async () => {
  await mount();
  const oldSave = nextWrite();
  await act(async () => editor.updateField("priority", "urgent"));
  const prepared = nextRead();
  await act(async () => revise(1));
  await act(async () =>
    prepared.resolve(
      response({ ...task, title: "Fresh remote title", version: 3 }),
    ),
  );
  assert.equal(editor.values?.title, "Fresh remote title");
  assert.equal(editor.values?.priority, "urgent");
  assert.equal(calls.filter((call) => call.method === "PATCH").length, 1);
  const resumedSave = nextWrite();
  await act(async () =>
    oldSave.resolve(response({ ...task, priority: "urgent", version: 2 })),
  );
  assert.equal(editor.values?.title, "Fresh remote title");
  const patches = calls.filter((call) => call.method === "PATCH");
  assert.equal(patches.length, 2);
  assert.deepEqual(JSON.parse(patches[1].body!), {
    version: 3,
    priority: "urgent",
  });
  await act(async () =>
    resumedSave.resolve(
      response({
        ...task,
        title: "Fresh remote title",
        priority: "urgent",
        version: 4,
      }),
    ),
  );
  assert.equal(editor.task?.version, 4);
  assert.equal(editor.values?.title, "Fresh remote title");
  assert.equal(editor.hasUnsavedChanges, false);
});

test("a failed subsequent preparation cannot reveal a task that was already denied", async () => {
  await mount();
  const denied = nextRead();
  await act(async () => revise(1));
  await act(async () =>
    denied.resolve(Response.json({ error: "Access revoked" }, { status: 403 })),
  );
  const unavailable = nextRead();
  await act(async () => revise(2));
  await act(async () =>
    unavailable.resolve(
      Response.json({ error: "Service unavailable" }, { status: 503 }),
    ),
  );
  assert.equal(editor.accessDenied, true);
  assert.equal(container.querySelector("article"), null);
  assert.equal(navigationCache.task(task.id), null);
  const restored = nextRead();
  await act(async () => revise(3));
  await act(async () =>
    restored.resolve(
      response({ ...task, title: "Access restored", version: 3 }),
    ),
  );
  assert.equal(editor.accessDenied, false);
  assert.equal(container.querySelector("h1")?.textContent, "Access restored");
});

test("a prepared GET acknowledges an already-applied PATCH before its delayed response arrives", async () => {
  await mount();
  const delayedSave = nextWrite();
  await act(async () => editor.updateField("priority", "urgent"));
  const prepared = nextRead();
  await act(async () => revise(1));
  const applied = { ...task, priority: "urgent" as const, version: 2 };
  await act(async () => prepared.resolve(response(applied)));
  assert.equal(editor.values?.priority, "urgent");
  assert.equal(editor.hasUnsavedChanges, false);
  assert.equal(editor.fields.priority?.conflict, undefined);
  let flushed!: Promise<boolean>;
  await act(async () => {
    flushed = editor.flushAll();
  });
  await act(async () => {
    delayedSave.resolve(response(applied));
    assert.equal(await flushed, true);
  });
  assert.equal(editor.needsFlush(), false);
  assert.equal(editor.fields.priority?.state, "saved");
  assert.equal(calls.filter((call) => call.method === "PATCH").length, 1);
  assert.equal(calls.filter((call) => call.method === "GET").length, 2);
});

test("acknowledging an applied PATCH preserves an edit made after it was sent and saves against the new baseline", async () => {
  await mount();
  const delayedSave = nextWrite();
  await act(async () => editor.updateField("priority", "urgent"));
  await act(async () => editor.updateField("priority", "low"));
  const prepared = nextRead();
  await act(async () => revise(1));
  const applied = { ...task, priority: "urgent" as const, version: 2 };
  await act(async () => prepared.resolve(response(applied)));
  assert.equal(editor.task?.priority, "urgent");
  assert.equal(editor.values?.priority, "low");
  assert.equal(editor.hasUnsavedChanges, true);
  const laterSave = nextWrite();
  await act(async () => delayedSave.resolve(response(applied)));
  const patches = calls.filter((call) => call.method === "PATCH");
  assert.equal(patches.length, 2);
  assert.deepEqual(JSON.parse(patches[1].body!), {
    version: 2,
    priority: "low",
  });
  let flushed!: Promise<boolean>;
  await act(async () => {
    flushed = editor.flushAll();
  });
  await act(async () => {
    laterSave.resolve(response({ ...applied, priority: "low", version: 3 }));
    assert.equal(await flushed, true);
  });
  assert.equal(editor.values?.priority, "low");
  assert.equal(editor.task?.version, 3);
  assert.equal(editor.fields.priority?.conflict, undefined);
  assert.equal(editor.needsFlush(), false);
});

test("a prepared remote change that differs from the sent PATCH remains a real conflict", async () => {
  await mount();
  const delayedSave = nextWrite();
  await act(async () => editor.updateField("priority", "urgent"));
  await act(async () => editor.updateField("priority", "low"));
  const prepared = nextRead();
  await act(async () => revise(1));
  await act(async () =>
    prepared.resolve(response({ ...task, priority: "medium", version: 3 })),
  );
  await act(async () =>
    delayedSave.resolve(response({ ...task, priority: "urgent", version: 2 })),
  );
  let flushed = true;
  await act(async () => {
    flushed = await editor.flushAll();
  });
  assert.equal(flushed, false);
  assert.equal(editor.fields.priority?.conflict, true);
  assert.equal(editor.values?.priority, "low");
  assert.equal(editor.task?.priority, "medium");
  assert.equal(editor.hasUnsavedChanges, true);
  assert.equal(calls.filter((call) => call.method === "PATCH").length, 1);
});

test("a pre-write GET cannot acknowledge a later edit back to the original value", async () => {
  await mount();
  const delayedSave = nextWrite();
  await act(async () => editor.updateField("priority", "urgent"));
  await act(async () => editor.updateField("priority", "high"));
  const prepared = nextRead();
  await act(async () => revise(1));
  await act(async () => prepared.resolve(response(task)));
  assert.equal(editor.values?.priority, "high");
  assert.equal(editor.hasUnsavedChanges, true);
  assert.equal(calls.filter((call) => call.method === "PATCH").length, 1);
  await act(async () => root.unmount());
  await act(async () =>
    delayedSave.resolve(response({ ...task, priority: "urgent", version: 2 })),
  );
});

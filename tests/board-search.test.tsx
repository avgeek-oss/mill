import "./react-test-environment.js";
import assert from "node:assert/strict";
import { after, afterEach, beforeEach, test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { Window } from "happy-dom";
import React, { act, useEffect, useState } from "react";
import {
  PageNavigation,
  PageReadScope,
  usePageRead,
} from "../apps/web/src/page-navigation.js";
import {
  publishBoardSearch,
  useBoardSearch,
} from "../apps/web/src/use-board-search.js";
import { parseBoardUrl } from "../apps/web/src/board-url.js";

const base = "/boards/board-1";
const browser = new Window({ url: `http://localhost${base}` });
Object.assign(globalThis, {
  window: browser,
  document: browser.document,
  HTMLElement: browser.HTMLElement,
  Node: browser.Node,
  Event: browser.Event,
  IS_REACT_ACT_ENVIRONMENT: true,
});
const { createRoot } = await import("react-dom/client");
function deferred() {
  let resolve!: (value: string) => void;
  const promise = new Promise<string>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}
let root: ReturnType<typeof createRoot>;
let container: HTMLDivElement;
let edit: (query: string) => void;
let requests: Map<string, ReturnType<typeof deferred>>;
let signals: Map<string, AbortSignal>;
let cached: Map<string, string>;
let publications: string[];
const currentPath = () =>
  window.location.pathname + window.location.search + window.location.hash;
function source(path: string) {
  const pending = deferred();
  requests.set(path, pending);
  return pending;
}
function SearchBoard({ path }: { path: string }) {
  const { query, setQuery, prepare } = useBoardSearch({
    path,
    urlQuery: parseBoardUrl(path).q,
    onSearch: (value) => publishBoardSearch("board-1", value),
  });
  edit = setQuery;
  const prepared = usePageRead(cached.has(path) ? null : path, (signal) => {
    prepare(path);
    signals.set(path, signal);
    const pending = requests.get(path);
    assert(pending, `Missing request for ${path}`);
    return pending.promise;
  });
  return (
    <main data-path={path}>
      <input
        aria-label="Search tasks"
        value={query}
        onChange={(event) => setQuery(event.target.value)}
      />
      <p>
        {prepared?.status === "fulfilled" ? prepared.value : cached.get(path)}
      </p>
    </main>
  );
}
function Shell() {
  const [path, setPath] = useState(currentPath);
  useEffect(() => {
    const update = () => setPath(currentPath());
    const published = () => {
      publications.push(currentPath());
      update();
    };
    window.addEventListener("mill:navigate", published);
    window.addEventListener("popstate", update);
    return () => {
      window.removeEventListener("mill:navigate", published);
      window.removeEventListener("popstate", update);
    };
  }, []);
  return (
    <PageNavigation location={path}>
      {(displayed) => (
        <PageReadScope scope="person:team:member:0">
          <SearchBoard path={displayed} />
        </PageReadScope>
      )}
    </PageNavigation>
  );
}
async function mount(path = base) {
  window.history.replaceState({}, "", path);
  cached.set(path, "Existing tasks");
  await act(async () => root.render(<Shell />));
}
const input = () => container.querySelector("input")!;
const displayedPath = () => container.querySelector("main")?.dataset.path;
const debounce = () => act(async () => delay(275));
beforeEach(() => {
  window.history.replaceState({}, "", base);
  requests = new Map();
  signals = new Map();
  cached = new Map();
  publications = [];
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});
after(() => browser.happyDOM.close());

test("a late search commit preserves a newer clear and publishes the cleared query", async () => {
  const path = `${base}?q=review`;
  const pending = source(path);
  await mount();
  const search = input();
  search.focus();
  await act(async () => edit("review"));
  await debounce();
  assert.equal(currentPath(), path);
  assert.equal(displayedPath(), base);
  await act(async () => edit(""));
  await act(async () => pending.resolve("Review matches"));
  assert.equal(displayedPath(), path);
  assert.equal(input(), search);
  assert.equal(input().value, "");
  assert.equal(document.activeElement, search);
  await debounce();
  assert.equal(currentPath(), base);
  assert.equal(displayedPath(), base);
  assert.equal(input().value, "");
  assert.deepEqual(publications, [path, base]);
});

test("reverting to the prior nonempty query during preparation retains filters and republishes it", async () => {
  const original = `${base}?q=backlog&status=todo&sort=title`;
  const requested = `${base}?q=review&status=todo&sort=title`;
  const pending = source(requested);
  await mount(original);
  await act(async () => edit("review"));
  await debounce();
  await act(async () => edit("backlog"));
  await act(async () => pending.resolve("Review matches"));
  assert.equal(input().value, "backlog");
  await debounce();
  assert.equal(currentPath(), original);
  assert.equal(displayedPath(), original);
  assert.equal(input().value, "backlog");
  assert.deepEqual(publications, [requested, original]);
});

test("clearing back to the displayed query cancels a pending search before it resolves", async () => {
  const requested = `${base}?q=review`;
  const pending = source(requested);
  await mount();
  await act(async () => edit("review"));
  await debounce();
  await act(async () => edit(""));
  await debounce();
  assert.equal(currentPath(), base);
  assert.equal(displayedPath(), base);
  assert.equal(signals.get(requested)?.aborted, true);
  await act(async () => pending.resolve("Abandoned review matches"));
  assert.equal(displayedPath(), base);
  assert.equal(input().value, "");
  assert(!container.textContent?.includes("Abandoned review matches"));
});

test("client navigation back to the retained source restores its query without a popstate event", async () => {
  const requested = `${base}?q=review`;
  const pending = source(requested);
  await mount();
  await act(async () => edit("review"));
  await debounce();
  assert.equal(displayedPath(), base);
  await act(async () => {
    window.history.replaceState({}, "", base);
    window.dispatchEvent(new Event("mill:navigate"));
  });
  assert.equal(currentPath(), base);
  assert.equal(input().value, "");
  assert.equal(signals.get(requested)?.aborted, true);
  await debounce();
  assert.deepEqual(publications, [requested, base]);
  await act(async () => pending.resolve("Canceled review matches"));
  assert.equal(displayedPath(), base);
  assert.equal(input().value, "");
});

test("client cancellation discards older unpublished typing and allows edits made afterward", async () => {
  const requested = `${base}?q=review`;
  const latestPath = `${base}?q=reviewer`;
  const abandoned = source(requested);
  const latest = source(latestPath);
  await mount();
  await act(async () => edit("review"));
  await debounce();
  await act(async () => edit("older unpublished draft"));
  await act(async () => {
    window.history.replaceState({}, "", base);
    window.dispatchEvent(new Event("mill:navigate"));
  });
  assert.equal(input().value, "");
  assert.equal(signals.get(requested)?.aborted, true);
  await debounce();
  assert.equal(currentPath(), base);
  assert.deepEqual(publications, [requested, base]);
  await act(async () => edit("reviewer"));
  await debounce();
  assert.equal(currentPath(), latestPath);
  assert.equal(input().value, "reviewer");
  await act(async () => abandoned.resolve("Abandoned review matches"));
  assert.equal(displayedPath(), base);
  await act(async () => latest.resolve("Latest reviewer matches"));
  assert.equal(displayedPath(), latestPath);
  assert.equal(input().value, "reviewer");
  assert.deepEqual(publications, [requested, base, latestPath]);
});

test("Back and Forward restore their URL query without republishing an earlier draft", async () => {
  const reviewPath = `${base}?q=review`;
  window.history.pushState({}, "", reviewPath);
  await mount(reviewPath);
  cached.delete(reviewPath);
  const back = source(base);
  await act(async () => edit("unfinished"));
  await act(async () => {
    window.history.back();
    await delay(0);
  });
  assert.equal(currentPath(), base);
  assert.equal(input().value, "");
  await debounce();
  assert.equal(currentPath(), base);
  assert.deepEqual(publications, []);
  await act(async () => back.resolve("Tasks after Back"));
  assert.equal(displayedPath(), base);
  assert.equal(input().value, "");

  const forward = source(reviewPath);
  await act(async () => {
    window.history.forward();
    await delay(0);
  });
  assert.equal(currentPath(), reviewPath);
  assert.equal(input().value, "review");
  await act(async () => forward.resolve("Tasks after Forward"));
  assert.equal(displayedPath(), reviewPath);
  assert.equal(input().value, "review");
  await debounce();
  assert.deepEqual(publications, []);
});

test("search publication cannot replace another board or a task/settings route", () => {
  for (const path of [
    "/boards/board-2?q=other",
    `${base}/tasks/task-1`,
    `${base}/settings`,
    "/settings/profile",
  ]) {
    window.history.replaceState({}, "", path);
    publishBoardSearch("board-1", "review");
    assert.equal(currentPath(), path);
  }
});

import "./react-test-environment.js";
import assert from "node:assert/strict";
import { after, afterEach, beforeEach, test } from "node:test";
import { Window } from "happy-dom";
import React, { act, lazy, useState, type ReactNode } from "react";
import {
  PageNavigation,
  PageReadScope,
  usePageNavigationPending,
  usePageRead,
} from "../apps/web/src/page-navigation.js";

const browser = new Window({ url: "http://localhost/boards" });
Object.assign(globalThis, {
  window: browser,
  document: browser.document,
  HTMLElement: browser.HTMLElement,
  Node: browser.Node,
  Event: browser.Event,
  MouseEvent: browser.MouseEvent,
  IS_REACT_ACT_ENVIRONMENT: true,
});
const { createRoot } = await import("react-dom/client");
type Root = ReturnType<typeof createRoot>;
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((success, failure) => {
    resolve = success;
    reject = failure;
  });
  return { promise, resolve, reject };
}
let root: Root;
let container: HTMLDivElement;
let navigate: (path: string) => void;
let identify: (identity: string) => void;
let expire: () => void;
let requests: Map<string, ReturnType<typeof deferred<string>>>;
let signals: Map<string, AbortSignal[]>;
let cached: Map<string, string>;
let commits: string[];
let renderDestination: (location: string, identity: string) => ReactNode;
const key = (location: string, identity = "person:team:member:0") =>
  `${identity}/${location}`;
function source(location: string, identity?: string) {
  const pending = deferred<string>();
  requests.set(key(location, identity), pending);
  return pending;
}
function load(location: string, identity: string, signal: AbortSignal) {
  const id = key(location, identity);
  signals.set(id, [...(signals.get(id) ?? []), signal]);
  const request = requests.get(id);
  assert(request, `Missing request source: ${id}`);
  return request.promise;
}
function Page({ location, identity }: { location: string; identity: string }) {
  const id = key(location, identity);
  const primary = usePageRead(cached.has(id) ? null : location, (signal) =>
    load(location, identity, signal),
  );
  const details = usePageRead(
    primary?.status === "fulfilled" && primary.value === "needs details"
      ? `${location}/details`
      : null,
    (signal) => load(`${location}/details`, identity, signal),
  );
  const initial = details ?? primary;
  const [value, setValue] = useState(() =>
    initial?.status === "fulfilled" ? initial.value : cached.get(id),
  );
  const [error, setError] = useState(() =>
    initial?.status === "rejected" ? String(initial.reason) : "",
  );
  const pending = usePageNavigationPending();
  const retry = () => {
    void load(location, identity, new AbortController().signal).then(
      (result) => {
        setValue(result);
        setError("");
      },
      (cause) => setError(String(cause)),
    );
  };
  if (error)
    return (
      <section role="alert">
        Could not load {location}
        <button onClick={retry}>Retry</button>
      </section>
    );
  if (!value) return <p>Unexpected empty page</p>;
  return (
    <main
      data-page={location}
      data-pending={String(pending)}
      ref={(element) => {
        if (element) commits.push(id);
      }}
    >
      <h1>{location}</h1>
      <p>{value}</p>
      <input aria-label="Draft" defaultValue="Keep this draft" />
      <button onClick={retry}>Refresh</button>
    </main>
  );
}
function Shell() {
  const [location, setLocation] = useState("boards");
  const [identity, setIdentity] = useState("person:team:member:0");
  const [expired, setExpired] = useState(false);
  navigate = setLocation;
  identify = setIdentity;
  expire = () => setExpired(true);
  return (
    <PageNavigation location={location}>
      {(displayed) =>
        expired ? (
          <h1>Sign in to continue</h1>
        ) : (
          <PageReadScope scope={identity}>
            {renderDestination(displayed, identity)}
          </PageReadScope>
        )
      }
    </PageNavigation>
  );
}
async function mount() {
  await act(async () => root.render(<Shell />));
}
const page = () => container.querySelector("main");
beforeEach(() => {
  requests = new Map();
  signals = new Map();
  cached = new Map([[key("boards"), "Existing board cards"]]);
  commits = [];
  renderDestination = (location, identity) => (
    <Page
      key={`${location}:${identity}`}
      location={location}
      identity={identity}
    />
  );
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});
after(() => browser.happyDOM.close());

test("retains the existing page and draft until dependent destination reads finish", async () => {
  const task = source("task");
  const details = source("task/details");
  await mount();
  const before = page();
  const input = container.querySelector("input")!;
  input.value = "Unsaved review";
  await act(async () => navigate("task"));
  assert.equal(page(), before);
  assert.equal(page()?.dataset.pending, "true");
  assert(!container.textContent?.includes("Unexpected empty"));
  await act(async () => task.resolve("needs details"));
  assert.equal(page(), before);
  assert.equal(container.querySelector("input"), input);
  assert.equal(input.value, "Unsaved review");
  assert(!commits.includes(key("task")));
  await act(async () => details.resolve("Complete task and discussion"));
  assert.equal(page()?.dataset.page, "task");
  assert.equal(page()?.dataset.pending, "false");
  assert(container.textContent?.includes("Complete task and discussion"));
});

test("only commits the latest destination and aborts an abandoned read", async () => {
  const board = source("board");
  const settings = source("settings");
  await mount();
  await act(async () => navigate("board"));
  await act(async () => navigate("settings"));
  await act(async () => settings.resolve("Account settings"));
  assert.equal(page()?.dataset.page, "settings");
  assert.equal(signals.get(key("board"))?.[0].aborted, true);
  await act(async () => board.resolve("Late board data"));
  assert.equal(page()?.dataset.page, "settings");
  assert(!commits.includes(key("board")));
});

test("returning to the displayed route cancels its pending destination and allows a fresh later visit", async () => {
  const abandoned = source("task");
  await mount();
  const before = page();
  await act(async () => navigate("task"));
  await act(async () => navigate("boards"));
  assert.equal(page(), before);
  assert.equal(page()?.dataset.pending, "false");
  assert.equal(signals.get(key("task"))?.[0].aborted, true);
  await act(async () => abandoned.resolve("Abandoned snapshot"));
  assert.equal(page(), before);
  const current = source("task");
  await act(async () => navigate("task"));
  assert.equal(signals.get(key("task"))?.length, 2);
  assert.equal(page(), before);
  await act(async () => current.resolve("Fresh task"));
  assert(container.textContent?.includes("Fresh task"));
  assert(!container.textContent?.includes("Abandoned snapshot"));
});

test("warm destinations commit without an empty state and normal refreshes do not suspend", async () => {
  cached.set(key("task"), "Cached task");
  await mount();
  await act(async () => navigate("task"));
  assert(container.textContent?.includes("Cached task"));
  assert.equal(signals.size, 0);
  const refreshed = source("task");
  const before = page();
  await act(async () => container.querySelector("button")!.click());
  assert.equal(page(), before);
  assert(container.textContent?.includes("Cached task"));
  assert.equal(page()?.dataset.pending, "false");
  await act(async () => refreshed.resolve("Refreshed task"));
  assert.equal(page(), before);
  assert(container.textContent?.includes("Refreshed task"));
  assert(!container.textContent?.includes("Unexpected empty"));
  await act(async () => navigate("boards"));
  assert(container.textContent?.includes("Existing board cards"));
  assert(!container.textContent?.includes("Unexpected empty"));
});

test("rejected preparation commits error UI once and the mounted page can retry normally", async () => {
  const pending = source("sessions");
  await mount();
  await act(async () => navigate("sessions"));
  assert.equal(page()?.dataset.page, "boards");
  await act(async () => pending.reject(new Error("Connection lost")));
  assert(
    container
      .querySelector('[role="alert"]')
      ?.textContent?.includes("Could not load sessions"),
  );
  assert.equal(signals.get(key("sessions"))?.length, 1);
  const recovered = source("sessions");
  await act(async () => container.querySelector("button")!.click());
  assert.equal(signals.get(key("sessions"))?.length, 2);
  await act(async () => recovered.resolve("Two active sessions"));
  assert(container.textContent?.includes("Two active sessions"));
  assert.equal(page()?.dataset.pending, "false");
});

test("prepares lazy destination code before waiting for its data", async () => {
  const bundle = deferred<{ default: typeof Page }>();
  const LazyPage = lazy(() => bundle.promise);
  renderDestination = (location, identity) =>
    location === "people" ? (
      <LazyPage key={location} location={location} identity={identity} />
    ) : (
      <Page key={location} location={location} identity={identity} />
    );
  const pending = source("people");
  await mount();
  const before = page();
  await act(async () => navigate("people"));
  assert.equal(page(), before);
  assert.equal(signals.size, 0);
  await act(async () => bundle.resolve({ default: Page }));
  assert.equal(page(), before);
  assert.equal(signals.get(key("people"))?.length, 1);
  await act(async () => pending.resolve("Workspace people"));
  assert.equal(page()?.dataset.page, "people");
  assert(container.textContent?.includes("Workspace people"));
});

test("pathname, search and hash identify different destinations", async () => {
  const first = source("board?q=backup#results");
  const second = source("board?q=restore#results");
  await mount();
  await act(async () => navigate("board?q=backup#results"));
  await act(async () => first.resolve("Backup matches"));
  await act(async () => navigate("board?q=restore#results"));
  assert(container.textContent?.includes("Backup matches"));
  await act(async () => second.resolve("Restore matches"));
  assert(container.textContent?.includes("Restore matches"));
  assert.equal(page()?.dataset.page, "board?q=restore#results");
});

test("a different identity or role scope cannot reuse reads on the same route", async () => {
  const firstScope = "person:team:member:1";
  const secondScope = "person:team:viewer:2";
  const first = source("boards", firstScope);
  const second = source("boards", secondScope);
  await mount();
  await act(async () => identify(firstScope));
  await act(async () => first.resolve("Member snapshot"));
  assert(container.textContent?.includes("Member snapshot"));
  await act(async () => identify(secondScope));
  assert.equal(signals.get(key("boards", secondScope))?.length, 1);
  await act(async () => second.resolve("Viewer snapshot"));
  assert(container.textContent?.includes("Viewer snapshot"));
  assert(!container.textContent?.includes("Member snapshot"));
});

test("expiration takes effect during pending navigation and late reads cannot reveal the page", async () => {
  const pending = source("task");
  await mount();
  await act(async () => navigate("task"));
  await act(async () => expire());
  assert(container.textContent?.includes("Sign in to continue"));
  assert.equal(page(), null);
  assert.equal(signals.get(key("task"))?.[0].aborted, true);
  await act(async () => pending.resolve("Private task data"));
  assert(container.textContent?.includes("Sign in to continue"));
  assert(!container.textContent?.includes("Private task data"));
});

test("unmounting aborts destination reads without requiring the reader to respect cancellation", async () => {
  const pending = source("task");
  await mount();
  await act(async () => navigate("task"));
  await act(async () => root.unmount());
  assert.equal(signals.get(key("task"))?.[0].aborted, true);
  pending.resolve("Late ignored result");
  await act(async () => {});
  assert.equal(container.textContent, "");
});

test("a newer scope aborts an older pending same-route read and ignores its late response", async () => {
  const oldScope = "other:team:member:0";
  const newScope = "other:team:viewer:1";
  const oldRead = source("boards", oldScope);
  const newRead = source("boards", newScope);
  await mount();
  await act(async () => identify(oldScope));
  await act(async () => identify(newScope));
  await act(async () => newRead.resolve("Current viewer snapshot"));
  assert.equal(signals.get(key("boards", oldScope))?.[0].aborted, true);
  assert(container.textContent?.includes("Current viewer snapshot"));
  await act(async () => oldRead.resolve("Superseded member snapshot"));
  assert(container.textContent?.includes("Current viewer snapshot"));
  assert(!container.textContent?.includes("Superseded member snapshot"));
});

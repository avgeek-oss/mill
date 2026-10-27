import "./react-test-environment.js";
import assert from "node:assert/strict";
import { after, afterEach, beforeEach, mock, test } from "node:test";
import React, { act, useState } from "react";
import { Window } from "happy-dom";
import { PageNavigation } from "../apps/web/src/page-navigation.js";
import { useDirectoryPreparation } from "../apps/web/src/directory-preparation.js";
import { useMemberSnapshot } from "../apps/web/src/use-member-snapshot.js";
import type { Member } from "../packages/contracts/src/index.js";

const browser = new Window({ url: "http://localhost/boards/one" });
Object.assign(browser, {
  __MILL_RUNTIME_CONFIG__: { apiOrigin: "http://localhost:4321" },
});
Object.assign(globalThis, {
  window: browser,
  document: browser.document,
  HTMLElement: browser.HTMLElement,
  Node: browser.Node,
  Event: browser.Event,
  IS_REACT_ACT_ENVIRONMENT: true,
});
const { createRoot } = await import("react-dom/client");
let root: ReturnType<typeof createRoot>;
let container: HTMLDivElement;
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}
const member = (name: string): Member => ({
  id: name,
  name,
  email: `${name}@example.test`,
  role: "member",
  timeZone: "UTC",
  passkeyEnabled: false,
});
const board = {
  id: "one",
  name: "Engineering",
  prefix: "ENG",
  description: "Work",
  version: 1,
  lastActivityAt: "2026-10-27T00:00:00Z",
  createdBy: null,
  backlogCount: 0,
  activeCount: 0,
  inProgressCount: 0,
  todoCount: 0,
};
beforeEach(() => {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  mock.restoreAll();
});
after(() => browser.happyDOM.close());

test("directory reads start together and same-board queries reuse the committed identity snapshot", async () => {
  const boards = deferred<Response>();
  const members = deferred<Response>();
  const requests: string[] = [];
  mock.method(globalThis, "fetch", (url: string) => {
    requests.push(url);
    return url.includes("/auth/members") ? members.promise : boards.promise;
  });
  let navigate!: (location: string) => void;
  let identify!: (scope: string) => void;
  function Directories({
    location,
    scope,
  }: {
    location: string;
    scope: string;
  }) {
    const read = useDirectoryPreparation(
      scope,
      location.split("?")[0],
      true,
      true,
    );
    return (
      <section>
        <h1>{location}</h1>
        <p>
          {read.boards?.status}:{read.members?.status}
        </p>
      </section>
    );
  }
  function Shell() {
    const [location, setLocation] = useState("/boards/one");
    const [scope, setScope] = useState("person:workspace:member:0");
    navigate = setLocation;
    identify = setScope;
    return (
      <PageNavigation location={location}>
        {(displayed) => <Directories location={displayed} scope={scope} />}
      </PageNavigation>
    );
  }
  await act(async () => root.render(<Shell />));
  assert.equal(
    requests.length,
    2,
    "both independent reads start before either settles",
  );
  await act(async () =>
    boards.resolve(
      Response.json({ items: [board], hasMore: false, nextCursor: null }),
    ),
  );
  assert.equal(container.querySelector("h1"), null);
  await act(async () =>
    members.resolve(
      Response.json({
        items: [member("current")],
        hasMore: false,
        nextCursor: null,
      }),
    ),
  );
  assert.equal(container.querySelector("h1")?.textContent, "/boards/one");
  for (const query of ["q=review", "sort=status", "priority=high", "page=2"]) {
    await act(async () => navigate(`/boards/one?${query}`));
    assert.equal(requests.length, 2, "query changes do not reload directories");
    assert.equal(
      container.querySelector("h1")?.textContent,
      `/boards/one?${query}`,
    );
  }
  await act(async () => navigate("/boards/two"));
  assert.equal(
    requests.length,
    4,
    "another board refreshes shared directories",
  );
  await act(async () => {
    identify("person:workspace:viewer:1");
    navigate("/boards/two?page=2");
  });
  assert.equal(
    requests.length,
    6,
    "a new session or role cannot reuse the old snapshot",
  );
});

test("a prepared membership snapshot supersedes an older refresh without suppressing its session result", async () => {
  let snapshot!: ReturnType<typeof useMemberSnapshot>;
  let prepare!: (read: PromiseSettledResult<Member[]>) => void;
  function Shell() {
    const [prepared, setPrepared] = useState<PromiseSettledResult<Member[]>>({
      status: "fulfilled",
      value: [member("initial")],
    });
    prepare = setPrepared;
    snapshot = useMemberSnapshot(prepared);
    return <p>{snapshot.members.map((item) => item.name).join(",")}</p>;
  }
  await act(async () => root.render(<Shell />));
  const notifications = deferred<number>();
  const publish = snapshot.beginRefresh();
  let sessionUpdate = 0;
  const refresh = Promise.all([
    Promise.resolve([member("stale")]),
    notifications.promise,
  ]).then(([people, revision]) => {
    publish(people);
    sessionUpdate = revision;
  });
  await act(async () =>
    prepare({ status: "fulfilled", value: [member("newer")] }),
  );
  await act(async () => {
    notifications.resolve(2);
    await refresh;
  });
  assert.equal(container.textContent, "newer");
  assert.equal(sessionUpdate, 2, "unrelated session work still publishes");
  let publishFresh!: ReturnType<typeof snapshot.beginRefresh>;
  await act(async () => {
    publishFresh = snapshot.beginRefresh();
    publishFresh([member("fresh")]);
  });
  assert.equal(container.textContent, "fresh");
  const publishBeforeReset = snapshot.beginRefresh();
  await act(async () => snapshot.setMembers([]));
  await act(async () => {
    assert.equal(publishBeforeReset([member("old-account")]), false);
  });
  assert.equal(container.textContent, "");
});

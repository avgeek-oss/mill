import "./react-test-environment.js";
import assert from "node:assert/strict";
import { after, afterEach, beforeEach, test } from "node:test";
import { Window } from "happy-dom";
import React, { act } from "react";
import { ApiError } from "../apps/web/src/api.js";
import { useBoardAccess } from "../apps/web/src/use-board-access.js";
import { navigationCache } from "../apps/web/src/navigation-cache.js";
import { parseBoardUrl } from "../apps/web/src/board-url.js";

const browser = new Window({ url: "http://localhost/boards/board-1" });
Object.assign(globalThis, {
  window: browser,
  document: browser.document,
  HTMLElement: browser.HTMLElement,
  Node: browser.Node,
  Event: browser.Event,
  IS_REACT_ACT_ENVIRONMENT: true,
});
const { createRoot } = await import("react-dom/client");
const board = {
  id: "board-1",
  name: "Private board",
  prefix: "PRV",
  description: "",
  version: 1,
};
const list = parseBoardUrl("/boards/board-1");
let root: ReturnType<typeof createRoot>;
let container: HTMLDivElement;
let access: ReturnType<typeof useBoardAccess>;
let denialEvents: number;
const onDenial = () => denialEvents++;
function RetainedBoard({ initialStatus = 0 }: { initialStatus?: number }) {
  access = useBoardAccess(board.id, initialStatus);
  return (
    <>
      <section role="alert" hidden={!access.accessDenied}>
        Board unavailable
      </section>
      <section
        data-rows
        hidden={access.accessDenied}
        inert={access.accessDenied}
      >
        Retained private task
      </section>
      <output>{access.errorStatus}</output>
    </>
  );
}
beforeEach(() => {
  navigationCache.clear();
  navigationCache.rememberBoardPage(
    board,
    list,
    { items: [], page: 1, total: 0, revision: "snapshot" },
    navigationCache.generation,
  );
  denialEvents = 0;
  window.addEventListener("mill:route-access-denied", onDenial);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  window.removeEventListener("mill:route-access-denied", onDenial);
  container.remove();
});
after(() => browser.happyDOM.close());
const rows = () => container.querySelector<HTMLElement>("[data-rows]")!;
for (const status of [403, 404]) {
  test(`HTTP ${status} keeps retained board data hidden across transient failures until authorized recovery`, async () => {
    await act(async () => root.render(<RetainedBoard />));
    assert.equal(rows().hidden, false);
    assert(navigationCache.boardPage(board.id, list));

    await act(async () =>
      access.failed(new ApiError(status, "Access removed")),
    );
    assert.equal(rows().hidden, true);
    assert.equal(rows().hasAttribute("inert"), true);
    assert.equal(navigationCache.boardPage(board.id, list), null);
    assert.equal(denialEvents, 1);

    await act(async () => access.failed(new ApiError(503, "Unavailable")));
    assert.equal(access.errorStatus, 503);
    assert.equal(rows().hidden, true);
    await act(async () =>
      access.failed(new TypeError("Network request failed")),
    );
    assert.equal(access.errorStatus, -1);
    assert.equal(rows().hidden, true);
    assert.equal(navigationCache.boardPage(board.id, list), null);
    await act(async () => access.clearError());
    assert.equal(rows().hidden, true);
    await act(async () => access.failed(new ApiError(status, "Still denied")));
    assert.equal(denialEvents, 1);

    await act(async () => access.authorized());
    assert.equal(rows().hidden, false);
    assert.equal(access.errorStatus, 0);
    await act(async () =>
      access.failed(new ApiError(status, "Access removed again")),
    );
    assert.equal(rows().hidden, true);
    assert.equal(denialEvents, 2);
  });
}
test("an initially denied board cannot appear during its first transient retry", async () => {
  await act(async () => root.render(<RetainedBoard initialStatus={403} />));
  assert.equal(rows().hidden, true);
  await act(async () => access.failed(new ApiError(503, "Unavailable")));
  assert.equal(rows().hidden, true);
  assert.equal(access.errorStatus, 503);
  await act(async () => access.authorized());
  assert.equal(rows().hidden, false);
});
test("a transient failure on an authorized board retains its visible content", async () => {
  await act(async () => root.render(<RetainedBoard />));
  await act(async () => access.failed(new ApiError(503, "Unavailable")));
  assert.equal(rows().hidden, false);
  assert.equal(access.accessDenied, false);
  assert.equal(access.errorStatus, 503);
  assert(navigationCache.boardPage(board.id, list));
  assert.equal(denialEvents, 0);
});

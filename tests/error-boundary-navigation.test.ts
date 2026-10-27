import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";
import { isValidElement, type ComponentProps } from "react";
import { ErrorBoundary } from "../apps/web/src/error-boundary.js";
import { ErrorPage } from "../apps/web/src/error-page.js";

let assigned: string[];
let pushed: string[];
let events: EventTarget;
beforeEach(() => {
  assigned = [];
  pushed = [];
  events = new EventTarget();
  Object.assign(globalThis, {
    window: {
      location: { assign: (href: string) => assigned.push(href) },
      history: {
        state: { millNavigationIndex: 0 },
        pushState: (_state: unknown, _title: string, href: string) =>
          pushed.push(href),
      },
      dispatchEvent: (event: Event) => events.dispatchEvent(event),
    },
  });
});

for (const loadFailed of [false, true]) {
  test(`failed root boundary recovers with document navigation (chunk failure: ${loadFailed})`, () => {
    const boundary = new ErrorBoundary({ children: null });
    boundary.state = { failed: true, loadFailed };
    const fallback = boundary.render();
    assert(isValidElement<ComponentProps<typeof ErrorPage>>(fallback));
    assert.equal(fallback.type, ErrorPage);
    const router = ErrorPage(fallback.props);
    router.props.navigate("/boards");
    assert.deepEqual(
      assigned,
      ["/boards"],
      "recovery works without App's unmounted route listener",
    );
    assert.deepEqual(pushed, []);
  });
}

test("ordinary resource errors keep guarded client navigation", () => {
  let attempts = 0;
  events.addEventListener("mill:before-navigate", (event) => {
    attempts++;
    event.preventDefault();
  });
  const router = ErrorPage({ code: "403" });
  router.props.navigate("/boards");
  assert.equal(attempts, 1);
  assert.deepEqual(assigned, []);
  assert.deepEqual(pushed, []);
});

test("ordinary error links update history without reloading when departure is allowed", () => {
  const router = ErrorPage({ code: "404" });
  router.props.navigate("/boards");
  assert.deepEqual(assigned, []);
  assert.deepEqual(pushed, ["/boards"]);
});

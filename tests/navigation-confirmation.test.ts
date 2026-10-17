import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";
import { setImmediate } from "node:timers/promises";
import {
  requestNavigation,
  type NavigationRequest,
} from "../apps/web/src/api.js";

let events: EventTarget;
beforeEach(() => {
  events = new EventTarget();
  Object.assign(globalThis, {
    window: { dispatchEvent: (event: Event) => events.dispatchEvent(event) },
  });
});

function decision() {
  let resolve!: (value: boolean) => void;
  const promise = new Promise<boolean>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

function waitFor(choice: Promise<boolean>) {
  events.addEventListener("mill:before-navigate", (event) => {
    event.preventDefault();
    (event as CustomEvent<NavigationRequest>).detail.waitUntil(choice);
  });
}

test("staying cancels navigation and leaving resumes the requested destination once", async () => {
  let choice = decision();
  const destinations: string[] = [];
  events.addEventListener("mill:before-navigate", (event) => {
    event.preventDefault();
    const destination = (event as CustomEvent<NavigationRequest>).detail;
    destinations.push(destination.path);
    destination.waitUntil(choice.promise);
  });
  let resumed = 0;
  assert.equal(
    requestNavigation("/boards/one", () => resumed++),
    false,
  );
  assert.equal(resumed, 0);
  choice.resolve(false);
  await setImmediate();
  assert.equal(resumed, 0);
  choice = decision();
  assert.equal(
    requestNavigation("/boards/one", () => resumed++),
    false,
  );
  choice.resolve(true);
  await setImmediate();
  assert.equal(resumed, 1);
  assert.deepEqual(destinations, ["/boards/one", "/boards/one"]);
});

test("confirmation waits for task saves too, and a failed save prevents leaving", async () => {
  const confirmation = decision();
  const save = decision();
  waitFor(confirmation.promise);
  waitFor(save.promise);
  let resumed = 0;
  assert.equal(
    requestNavigation("/boards/one", () => resumed++),
    false,
  );
  confirmation.resolve(true);
  await setImmediate();
  assert.equal(resumed, 0);
  save.resolve(false);
  await setImmediate();
  assert.equal(resumed, 0);
});

test("all guards must approve and old confirmations cannot resume a newer navigation attempt", async () => {
  const choices = [decision(), decision()];
  let attempt = 0;
  events.addEventListener("mill:before-navigate", (event) => {
    event.preventDefault();
    const destination = (event as CustomEvent<NavigationRequest>).detail;
    destination.waitUntil(choices[attempt++].promise);
    destination.waitUntil(Promise.resolve(true));
  });
  const resumed: string[] = [];
  requestNavigation("/boards/one", () => resumed.push("one"));
  requestNavigation("/boards/two", () => resumed.push("two"));
  choices[0].resolve(true);
  await setImmediate();
  assert.deepEqual(resumed, []);
  choices[1].resolve(true);
  await setImmediate();
  assert.deepEqual(resumed, ["two"]);
});

import "./react-test-environment.js";
import assert from "node:assert/strict";
import { test } from "node:test";
import { Window } from "happy-dom";
import React, { act } from "react";

const browser = new Window({ url: "http://localhost/" });
Object.assign(globalThis, {
  window: browser,
  document: browser.document,
  Node: browser.Node,
  Event: browser.Event,
  IS_REACT_ACT_ENVIRONMENT: true,
  // The root tsconfig does not include the design-system package, so tsx
  // compiles it with the classic JSX runtime, which expects a global React.
  React,
});
// React Aria reaches for many browser globals (element classes, NodeFilter,
// requestAnimationFrame), so expose every one Node does not already define.
for (const name of Object.getOwnPropertyNames(browser)) {
  if (name in globalThis) continue;
  const value: unknown = browser[name as keyof Window];
  Object.assign(globalThis, {
    [name]:
      typeof value === "function" && !/^[A-Z]/.test(name)
        ? value.bind(browser)
        : value,
  });
}
const { createRoot } = await import("react-dom/client");
// The web app's tsconfig typechecks the design-system package; a computed
// specifier keeps the root typecheck, which resolves modules for Node, out of it.
const compatibility = "../packages/web-design-system/src/compatibility.js";
const { Choice, Dialog } = await import(compatibility);

test("choice options announce their description and count with the name", async () => {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(
      <Choice
        label="Status"
        value="open"
        onChange={() => {}}
        isOpen
        items={[
          {
            id: "open",
            name: "Open",
            description: "Work not started",
            endContent: "4",
          },
          { id: "done", name: "Done" },
        ]}
      />,
    );
  });
  const labels = [...document.querySelectorAll('[role="option"]')].map(
    (option) => option.getAttribute("aria-label"),
  );
  assert.deepEqual(labels, ["Open Work not started 4", "Done"]);
  await act(async () => root.unmount());
});

test("dialog titles accept rich content", async () => {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(
      <Dialog
        open
        onClose={() => {}}
        title={
          <>
            Rename <strong>Roadmap</strong>
          </>
        }
      >
        Body
      </Dialog>,
    );
  });
  const heading = document.querySelector('[role="dialog"] h2');
  assert.equal(heading?.textContent, "Rename Roadmap");
  assert.equal(heading?.querySelector("strong")?.textContent, "Roadmap");
  await act(async () => root.unmount());
});

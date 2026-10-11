import assert from "node:assert/strict";
import test from "node:test";
import { listenForAttachmentDrops } from "../apps/web/src/attachment-drop.js";

const image = () => new File(["image"], "sample.png", { type: "image/png" });
function drag(type: string, files: File[] = [], types = ["Files"]) {
  return Object.assign(new Event(type, { cancelable: true }), {
    dataTransfer: {
      types,
      files: {
        length: files.length,
        item: (index: number) => files[index] ?? null,
      },
      dropEffect: "none",
    },
  });
}

test("page drops consume one file once and ignore drops already handled by the modal", () => {
  const target = new EventTarget();
  const received: File[] = [];
  const errors: string[] = [];
  const stop = listenForAttachmentDrops(target, {
    canDrop: () => true,
    onFile: (file) => received.push(file),
    onDragging: () => {},
    onError: (message) => errors.push(message),
  });
  try {
    const handled = drag("drop", [image()]);
    handled.preventDefault();
    target.dispatchEvent(handled);
    assert.equal(received.length, 0);
    const file = image();
    const first = drag("drop", [file]);
    target.dispatchEvent(first);
    target.dispatchEvent(drag("drop", [image()]));
    assert.equal(first.defaultPrevented, true);
    assert.deepEqual(received, [file]);
    assert.deepEqual(errors, []);
  } finally {
    stop();
  }
});

test("blocked page drops prevent browser navigation without starting an upload", () => {
  const target = new EventTarget();
  let allowed = false;
  const received: File[] = [];
  const states: boolean[] = [];
  const stop = listenForAttachmentDrops(target, {
    canDrop: () => allowed,
    onFile: (file) => received.push(file),
    onDragging: (value) => states.push(value),
    onError: assert.fail,
  });
  try {
    target.dispatchEvent(drag("dragenter"));
    const over = drag("dragover");
    target.dispatchEvent(over);
    const drop = drag("drop", [image()]);
    target.dispatchEvent(drop);
    assert.equal(over.defaultPrevented, true);
    assert.equal(over.dataTransfer.dropEffect, "none");
    assert.equal(drop.defaultPrevented, true);
    assert.equal(received.length, 0);
    assert.ok(!states.includes(true));
    allowed = true;
    target.dispatchEvent(drag("drop", [image()]));
    assert.equal(received.length, 1);
  } finally {
    stop();
  }
});

test("multiple files notify once, while text drags retain their normal browser behavior", () => {
  const target = new EventTarget();
  const received: File[] = [];
  const errors: string[] = [];
  const stop = listenForAttachmentDrops(target, {
    canDrop: () => true,
    onFile: (file) => received.push(file),
    onDragging: () => {},
    onError: (message) => errors.push(message),
  });
  try {
    target.dispatchEvent(drag("drop", [image(), image()]));
    assert.deepEqual(errors, ["Choose one file at a time."]);
    const text = drag("drop", [], ["text/plain"]);
    target.dispatchEvent(text);
    assert.equal(text.defaultPrevented, false);
    assert.equal(received.length, 0);
    target.dispatchEvent(drag("drop", [image()]));
    assert.equal(received.length, 1);
  } finally {
    stop();
  }
});

test("nested drag targets keep the highlight until exit, and route cleanup removes all listeners", () => {
  const target = new EventTarget();
  const states: boolean[] = [];
  const received: File[] = [];
  const stop = listenForAttachmentDrops(target, {
    canDrop: () => true,
    onFile: (file) => received.push(file),
    onDragging: (value) => states.push(value),
    onError: assert.fail,
  });
  target.dispatchEvent(drag("dragenter"));
  target.dispatchEvent(drag("dragenter"));
  target.dispatchEvent(drag("dragleave"));
  assert.equal(states.at(-1), true);
  target.dispatchEvent(drag("dragleave"));
  assert.equal(states.at(-1), false);
  target.dispatchEvent(drag("dragenter"));
  target.dispatchEvent(new Event("blur"));
  assert.equal(states.at(-1), false);
  stop();
  const count = states.length;
  target.dispatchEvent(drag("dragenter"));
  target.dispatchEvent(drag("drop", [image()]));
  target.dispatchEvent(new Event("blur"));
  assert.equal(states.length, count);
  assert.deepEqual(received, []);
});

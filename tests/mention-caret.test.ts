import assert from "node:assert/strict";
import test from "node:test";
import { mentionPopupPosition } from "../apps/web/src/mention-caret.js";

const viewport = { left: 0, top: 0, width: 390, height: 844 };

test("mention menu follows the caret and stays inside narrow viewport edges", () => {
  const popup = mentionPopupPosition(
    { left: 362, top: 140, bottom: 160, visible: true },
    viewport,
    180,
  );
  assert.equal(popup.top, 164);
  assert.equal(popup.left, 62);
  assert.equal(popup.width, 320);
  assert.ok(popup.left + popup.width <= viewport.width - 8);
});

test("mention menu flips above the caret near the bottom of the screen", () => {
  const popup = mentionPopupPosition(
    { left: 40, top: 800, bottom: 820, visible: true },
    viewport,
    180,
  );
  assert.equal(popup.top, 616);
  assert.equal(popup.maxHeight, 256);
});

test("mention menu remains scrollable in the viewport reduced by a mobile keyboard", () => {
  const keyboardViewport = { left: 0, top: 100, width: 280, height: 210 };
  const popup = mentionPopupPosition(
    { left: 40, top: 230, bottom: 250, visible: true },
    keyboardViewport,
    240,
  );
  assert.equal(popup.width, 264);
  assert.equal(popup.left, 8);
  assert.equal(popup.top, 108);
  assert.equal(popup.maxHeight, 118);
  assert.ok(popup.top >= keyboardViewport.top + 8);
});

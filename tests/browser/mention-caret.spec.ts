import { expect, test, type Page, type ElementHandle } from "@playwright/test";
import { textareaCaretRect } from "../../apps/web/src/mention-caret.js";

async function editor(page: Page) {
  await page.setContent(
    `<textarea aria-label="Comment" style="position:absolute;left:32px;top:80px;width:240px;height:110px;box-sizing:border-box;border:2px solid black;padding:10px;font:16px/24px monospace;resize:none"></textarea>`,
  );
  return page.getByRole("textbox", { name: "Comment" });
}

test("mention anchor follows multiline and wrapped textarea content", async ({
  page,
}) => {
  const input = await editor(page);
  await input.fill(
    "First line\nA long line that wraps across the textarea\n@Alex",
  );
  const handle =
    (await input.elementHandle()) as ElementHandle<HTMLTextAreaElement>;
  const end = await page.evaluate(textareaCaretRect, handle);
  await input.evaluate((element: HTMLTextAreaElement) =>
    element.setSelectionRange(0, 0),
  );
  const start = await page.evaluate(textareaCaretRect, handle);
  expect(end.top - start.top).toBeCloseTo(72, 0);
  expect(end.left).toBeGreaterThan(start.left);
  expect(start.left).toBeCloseTo(44, 0);
  expect(start.visible).toBe(true);
});

test("mention anchor tracks textarea scrolling and hides when its line is out of view", async ({
  page,
}) => {
  const input = await editor(page);
  await input.fill("First\nSecond\nThird\nFourth\nFifth\n@Alex");
  const handle =
    (await input.elementHandle()) as ElementHandle<HTMLTextAreaElement>;
  const scrolled = await page.evaluate(textareaCaretRect, handle);
  expect(scrolled.visible).toBe(true);
  await input.evaluate((element: HTMLTextAreaElement) => {
    element.scrollTop = 0;
  });
  const hidden = await page.evaluate(textareaCaretRect, handle);
  expect(hidden.top).toBeGreaterThan(scrolled.top);
  expect(hidden.visible).toBe(false);
});

test("content after the caret does not pull the anchor to another wrapped line", async ({
  page,
}) => {
  const input = await editor(page);
  await input.fill(
    "Hello @Alex and the rest of this sentence spans several lines in the textarea",
  );
  await input.evaluate((element: HTMLTextAreaElement) =>
    element.setSelectionRange(11, 11),
  );
  const caret = await page.evaluate(
    textareaCaretRect,
    (await input.elementHandle()) as ElementHandle<HTMLTextAreaElement>,
  );
  expect(caret.left).toBeGreaterThan(130);
  expect(caret.top).toBeLessThan(110);
});

test("caret visibility follows a clipping scroll ancestor and returns after scrolling back", async ({
  page,
}) => {
  await page.setContent(
    `<div aria-label="Task details" style="position:absolute;left:20px;top:80px;width:300px;height:160px;overflow:auto;border:3px solid black"><div style="height:70px"></div><textarea aria-label="Comment" style="width:240px;height:110px;box-sizing:border-box;padding:10px;font:16px/24px monospace;resize:none"></textarea><div style="height:500px"></div></div>`,
  );
  const input = page.getByRole("textbox", { name: "Comment" });
  await input.fill("@Alex");
  const handle =
    (await input.elementHandle()) as ElementHandle<HTMLTextAreaElement>;
  expect((await page.evaluate(textareaCaretRect, handle)).visible).toBe(true);
  await page.getByLabel("Task details").evaluate((element) => {
    element.scrollTop = 100;
  });
  const occluded = await page.evaluate(textareaCaretRect, handle);
  const textarea = (await input.boundingBox())!;
  const container = (await page.getByLabel("Task details").boundingBox())!;
  expect(textarea.y + textarea.height).toBeGreaterThan(container.y);
  expect(occluded.visible).toBe(false);
  await page.getByLabel("Task details").evaluate((element) => {
    element.scrollTop = 0;
  });
  expect((await page.evaluate(textareaCaretRect, handle)).visible).toBe(true);
});

test("caret outside the visible page viewport is not a valid popup anchor", async ({
  page,
}) => {
  const input = await editor(page);
  await input.fill("@Alex");
  await input.evaluate((element) => {
    element.style.top = "-60px";
  });
  expect(
    (
      await page.evaluate(
        textareaCaretRect,
        (await input.elementHandle()) as ElementHandle<HTMLTextAreaElement>,
      )
    ).visible,
  ).toBe(false);
});

test("mobile display-contents ancestors do not clip a visible caret", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.setContent(
    `<div class="task-page-main" style="display:contents;overflow-x:hidden;overflow-y:auto"><textarea aria-label="Comment" style="width:240px;height:110px;padding:10px;font:16px/24px monospace"></textarea></div>`,
  );
  const input = page.getByRole("textbox", { name: "Comment" });
  await input.fill("@Alex");
  const handle =
    (await input.elementHandle()) as ElementHandle<HTMLTextAreaElement>;
  expect((await page.evaluate(textareaCaretRect, handle)).visible).toBe(true);
  await page.locator(".task-page-main").evaluate((element) => {
    element.style.visibility = "hidden";
  });
  expect((await page.evaluate(textareaCaretRect, handle)).visible).toBe(false);
});

import { randomBytes } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { expect, test, type Locator, type Page } from "@playwright/test";
import {
  authenticateBrowserFixture,
  getBrowserBootstrap,
  type BrowserFixtureSession,
} from "../browser-fixture.js";

let fixture: BrowserFixtureSession;
let taskPath: string;
let secondBoardPath: string;

test.beforeAll(async ({ baseURL }) => {
  const bootstrap = await getBrowserBootstrap(baseURL!);
  fixture = bootstrap;
  try {
    const ids: string[] = [];
    for (const name of ["Popover first board", "Popover second board"]) {
      const response = await bootstrap.api.post("/api/boards", {
        data: {
          name,
          prefix: `PM${randomBytes(3).toString("hex").toUpperCase()}`,
        },
      });
      expect(response.status()).toBe(201);
      ids.push((await response.json()).board.id);
    }
    secondBoardPath = `/boards/${ids[1]}`;
    const task = await bootstrap.api.post(`/api/boards/${ids[0]}/tasks`, {
      data: { title: "Popover motion verification" },
    });
    expect(task.status()).toBe(201);
    taskPath = `/boards/${ids[0]}/tasks/${(await task.json()).task.id}`;
    await mkdir("tmp/popover-motion", { recursive: true });
  } finally {
    await bootstrap.api.dispose();
  }
});

async function stableFrames(popover: Locator) {
  const frames = await popover.evaluate(async (element) => {
    const frames: {
      x: number;
      y: number;
      width: number;
      height: number;
      identity: boolean;
      opacity: number;
    }[] = [];
    for (let index = 0; index < 12; index++) {
      const bounds = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      frames.push({
        x: bounds.x,
        y: bounds.y,
        width: bounds.width,
        height: bounds.height,
        identity: new DOMMatrixReadOnly(style.transform).isIdentity,
        opacity: Number(style.opacity),
      });
      await new Promise(requestAnimationFrame);
    }
    return frames;
  });
  const first = frames[0]!;
  for (const [index, frame] of frames.entries()) {
    expect(frame.identity).toBe(true);
    for (const property of ["x", "y", "width", "height"] as const)
      expect(frame[property]).toBeCloseTo(first[property], 1);
    if (index > 0)
      expect(frame.opacity).toBeGreaterThanOrEqual(
        frames[index - 1]!.opacity - 0.001,
      );
  }
  expect(frames.at(-1)!.opacity).toBe(1);
}

async function pauseFade(popover: Locator) {
  return popover.evaluate((element) => {
    const animation = element
      .getAnimations()
      .find((animation) => animation.playState === "running");
    if (!animation) return false;
    animation.pause();
    return true;
  });
}

async function clickWhileOpening(page: Page, popover: Locator, item: Locator) {
  expect(await pauseFade(popover)).toBe(true);
  const bounds = (await item.boundingBox())!;
  await page.mouse.move(
    bounds.x + bounds.width / 2,
    bounds.y + bounds.height / 2,
  );
  await page.mouse.down();
  const before = await item.boundingBox();
  await page.waitForTimeout(50);
  expect(
    await item.evaluate(
      (element) =>
        new DOMMatrixReadOnly(getComputedStyle(element).transform).isIdentity,
    ),
  ).toBe(true);
  expect(await item.boundingBox()).toEqual(before);
  await page.mouse.up();
  await expect(popover).toHaveCount(0, { timeout: 1000 });
  await expect(page.locator('[data-testid="underlay"]')).toHaveCount(0);
}

for (const width of [1280, 390])
  for (const theme of ["light", "dark"] as const)
    test(`breadcrumb popovers stay steady and recover from interrupted motion at ${width}px in ${theme}`, async ({
      browser,
    }) => {
      const context = await browser.newContext({
        viewport: { width, height: 844 },
        isMobile: width === 390,
        hasTouch: width === 390,
        reducedMotion: "no-preference",
      });
      try {
        await context.addInitScript(
          (value) => localStorage.setItem("mill:theme", value),
          theme,
        );
        const page = await context.newPage();
        await authenticateBrowserFixture(page, fixture);
        await page.goto("/settings/api-keys");
        await expect(
          page.getByRole("heading", {
            name: "API keys",
            exact: true,
            level: 1,
          }),
        ).toBeVisible();
        const trigger = page.getByRole("button", {
          name: "Navigate account pages",
          exact: true,
        });
        const popover = page.locator(".breadcrumb-popover");
        const menu = page.getByRole("menu", {
          name: "Navigate account pages",
          exact: true,
        });
        for (let attempt = 0; attempt < 3; attempt++) {
          if (width === 390) await trigger.tap();
          else await trigger.click();
          await expect(menu).toBeVisible();
          await stableFrames(popover);
          await page.keyboard.press("Escape");
          await expect(popover).toHaveCount(0, { timeout: 1000 });
          await expect(trigger).toBeFocused();
        }
        // A paused opening fade must not hold navigation or the modal underlay open.
        await trigger.click();
        await clickWhileOpening(
          page,
          popover,
          menu.getByRole("menuitem", { name: "Preferences", exact: true }),
        );
        await expect(page).toHaveURL(/\/settings\/preferences$/);
        await expect(
          page.getByRole("heading", {
            name: "Preferences",
            exact: true,
            level: 1,
          }),
        ).toBeVisible();
        await expect(trigger).toBeFocused();

        // Reopen the same mounted popover while its dismissal is still in progress.
        await trigger.click();
        await stableFrames(popover);
        await page.keyboard.press("Escape");
        const interrupted = await pauseFade(popover);
        expect(interrupted).toBe(true);
        await trigger.click();
        await expect(menu).toBeVisible();
        await stableFrames(popover);
        await expect(popover).not.toHaveAttribute("data-exiting", "true");
        await menu
          .getByRole("menuitem", { name: "API Keys", exact: true })
          .press("Enter");
        await expect(page).toHaveURL(/\/settings\/api-keys$/);
        await expect(popover).toHaveCount(0, { timeout: 1000 });
        await expect(trigger).toBeFocused();

        for (let attempt = 0; attempt < 8; attempt++) {
          await trigger.click();
          await page.keyboard.press("Escape");
          const bounds = (await trigger.boundingBox())!;
          await page.mouse.click(
            bounds.x + bounds.width / 2,
            bounds.y + bounds.height / 2,
          );
          await page.keyboard.press("Escape");
          await expect(popover).toHaveCount(0, { timeout: 1000 });
          await expect(trigger).toBeFocused();
        }

        await trigger.click();
        await page.goBack();
        await expect(page).toHaveURL(/\/settings\/preferences$/);
        await expect(popover).toHaveCount(0);
        await trigger.click();
        await expect(menu).toBeVisible();
        await page.keyboard.press("Escape");
        await expect(popover).toHaveCount(0);

        await page.goto("/settings/workspace");
        const teamTrigger = page.getByRole("button", {
          name: "Navigate team pages",
          exact: true,
        });
        await teamTrigger.click();
        await stableFrames(popover);
        const membersItem = page.getByRole("menuitem", {
          name: "Members",
          exact: true,
        });
        if (width === 390) await membersItem.tap();
        else await membersItem.click();
        await expect(page).toHaveURL(/\/settings\/members$/);
        await expect(popover).toHaveCount(0, { timeout: 1000 });

        await page.goto(taskPath);
        const boardTrigger = page.getByRole("button", {
          name: "Switch board: Popover first board",
          exact: true,
        });
        await boardTrigger.click();
        await expect(page.getByRole("listbox")).toBeVisible();
        await stableFrames(popover);
        await page.keyboard.press("Escape");
        await expect(popover).toHaveCount(0);
        const boardBounds = (await boardTrigger.boundingBox())!;
        const center = {
          x: boardBounds.x + boardBounds.width / 2,
          y: boardBounds.y + boardBounds.height / 2,
        };
        for (const delay of [0, 20, 50, 0, 20, 50]) {
          await page.mouse.click(center.x, center.y);
          if (delay) await page.waitForTimeout(delay);
          await page.keyboard.press("Escape");
          await page.mouse.click(center.x, center.y);
          await expect
            .poll(() =>
              popover.evaluate((element) =>
                element.contains(document.activeElement),
              ),
            )
            .toBe(true);
          await page.keyboard.press("Escape");
          await expect(popover).toHaveCount(0, { timeout: 1000 });
          await expect(boardTrigger).toBeFocused();
        }
        await boardTrigger.click();
        await page
          .getByRole("searchbox", { name: "Search boards", exact: true })
          .fill("second");
        await expect(page.getByRole("option")).toHaveCount(1);
        await page.screenshot({
          path: `tmp/popover-motion/board-${width}-${theme}.png`,
        });
        await page
          .getByRole("option", { name: "Popover second board", exact: true })
          .click();
        await expect(page).toHaveURL(new RegExp(`${secondBoardPath}$`));
        await expect(popover).toHaveCount(0, { timeout: 1000 });
        await expect(
          page.getByRole("heading", {
            name: "Popover second board",
            exact: true,
            level: 1,
          }),
        ).toBeVisible();
      } finally {
        await context.close();
      }
    });

test("reduced motion dismisses breadcrumb menus without waiting for a fade", async ({
  browser,
}) => {
  const context = await browser.newContext({
    reducedMotion: "reduce",
    viewport: { width: 390, height: 844 },
  });
  try {
    const page = await context.newPage();
    await authenticateBrowserFixture(page, fixture);
    await page.goto("/settings/api-keys");
    const trigger = page.getByRole("button", {
      name: "Navigate account pages",
      exact: true,
    });
    await trigger.press("Space");
    const popover = page.locator(".breadcrumb-popover");
    await expect(popover).toBeVisible();
    expect(await popover.evaluate((el) => el.getAnimations().length)).toBe(0);
    await page.keyboard.press("Escape");
    await expect(popover).toHaveCount(0);
    await expect(trigger).toBeFocused();
  } finally {
    await context.close();
  }
});

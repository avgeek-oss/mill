import { randomBytes } from "node:crypto";
import { mkdir } from "node:fs/promises";
import {
  expect,
  test,
  type APIRequestContext,
  type Locator,
  type Page,
} from "@playwright/test";
import {
  authenticateBrowserFixture,
  getBrowserBootstrap,
  type BrowserFixtureSession,
} from "../browser-fixture.js";

let fixture: BrowserFixtureSession;
let api: APIRequestContext;
let taskPath: string;
let secondBoardPath: string;
const seededBoardIds: string[] = [];

test.beforeAll(async ({ baseURL }) => {
  const bootstrap = await getBrowserBootstrap(baseURL!);
  fixture = bootstrap;
  api = bootstrap.api;
  const ids: string[] = [];
  for (const name of ["Popover first board", "Popover second board"]) {
    const response = await bootstrap.api.post("/api/boards", {
      data: {
        name,
        prefix: `PM${randomBytes(3).toString("hex").toUpperCase()}`,
      },
    });
    expect(response.status()).toBe(201);
    const id = (await response.json()).board.id;
    ids.push(id);
    seededBoardIds.push(id);
  }
  secondBoardPath = `/boards/${ids[1]}`;
  const task = await bootstrap.api.post(`/api/boards/${ids[0]}/tasks`, {
    data: { title: "Popover motion verification" },
  });
  expect(task.status()).toBe(201);
  taskPath = `/boards/${ids[0]}/tasks/${(await task.json()).task.id}`;
  await mkdir("tmp/popover-motion", { recursive: true });
});

test.afterAll(async () => {
  try {
    for (const id of seededBoardIds) {
      const response = await api.get(`/api/boards/${id}`);
      expect(response.status()).toBe(200);
      const { board } = await response.json();
      const removed = await api.delete(`/api/boards/${id}`, {
        data: { version: board.version },
      });
      expect(removed.status()).toBe(200);
    }
  } finally {
    await api?.dispose();
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

async function mobileNavigationMotion(page: Page, theme: "light" | "dark") {
  const toggle = page.getByRole("button", {
    name: "Toggle navigation",
    exact: true,
    includeHidden: true,
  });
  const drawer = page.getByRole("dialog", { name: "Navigation", exact: true });
  const pageNavigation = drawer.getByRole("navigation", {
    name: "Page navigation",
    exact: true,
  });
  for (let attempt = 0; attempt < 3; attempt++) {
    await toggle.tap();
    await expect(
      pageNavigation.getByRole("button", { name: "API Keys", exact: true }),
    ).toBeVisible();
    const frames = await drawer.evaluate(async (element) => {
      const frames: {
        width: number;
        height: number;
        columns: string;
        current: string[];
      }[] = [];
      for (let frame = 0; frame < 12; frame++) {
        const bounds = element.getBoundingClientRect();
        frames.push({
          width: bounds.width,
          height: bounds.height,
          columns: getComputedStyle(element).gridTemplateColumns,
          current: [...element.querySelectorAll('[aria-current="page"]')].map(
            (item) => item.textContent ?? "",
          ),
        });
        await new Promise(requestAnimationFrame);
      }
      return frames;
    });
    for (const frame of frames) expect(frame).toEqual(frames[0]);
    await page.keyboard.press("Escape");
    await expect(drawer).toHaveCount(0, { timeout: 1000 });
    await expect(toggle).toBeFocused();
  }
  await page.addStyleTag({
    content:
      '[role="dialog"][aria-label="Navigation"] { --drawer-enter-duration: 10s !important; }',
  });
  await toggle.click();
  await expect(drawer).toBeVisible();
  expect(
    await drawer.evaluate((element) => {
      const animation = element
        .getAnimations()
        .find((animation) => animation.playState === "running");
      if (!animation) return false;
      animation.pause();
      animation.currentTime =
        Number(animation.effect!.getComputedTiming().duration) * 0.45;
      return true;
    }),
  ).toBe(true);
  const preferences = pageNavigation.getByRole("button", {
    name: "Preferences",
    exact: true,
  });
  const bounds = (await preferences.boundingBox())!;
  await page.mouse.move(
    bounds.x + bounds.width / 2,
    bounds.y + bounds.height / 2,
  );
  const layoutBefore = await preferences.evaluate((element) => ({
    width: (element as HTMLElement).offsetWidth,
    height: (element as HTMLElement).offsetHeight,
  }));
  await page.mouse.down();
  await page.waitForTimeout(50);
  expect(
    await preferences.evaluate(
      (element) =>
        element.matches(":active") ||
        element.getAttribute("data-pressed") === "true",
    ),
  ).toBe(true);
  const pressed = (await preferences.boundingBox())!;
  expect(pressed.width / bounds.width).toBeGreaterThanOrEqual(0.97);
  expect(pressed.width).toBeLessThanOrEqual(bounds.width);
  expect(pressed.height / bounds.height).toBeGreaterThanOrEqual(0.97);
  expect(pressed.height).toBeLessThanOrEqual(bounds.height);
  expect(pressed.x + pressed.width / 2).toBeCloseTo(
    bounds.x + bounds.width / 2,
    1,
  );
  expect(pressed.y + pressed.height / 2).toBeCloseTo(
    bounds.y + bounds.height / 2,
    1,
  );
  expect(
    await preferences.evaluate((element) => ({
      width: (element as HTMLElement).offsetWidth,
      height: (element as HTMLElement).offsetHeight,
    })),
  ).toEqual(layoutBefore);
  await expect(page).toHaveURL(/\/settings\/api-keys$/);
  await page.mouse.up();
  await expect(page).toHaveURL(/\/settings\/preferences$/);
  await expect(drawer).toHaveCount(0, { timeout: 1000 });
  await expect(toggle).toBeFocused();

  await page.addStyleTag({
    content:
      '[role="dialog"][aria-label="Navigation"] { --drawer-enter-duration: 220ms !important; --drawer-exit-duration: 10s !important; } .drawer__backdrop[data-exiting="true"] { transition-duration: 10s !important; }',
  });
  const finishDrawer = () =>
    page.evaluate(() => {
      for (const animation of document.getAnimations()) {
        const target = (animation.effect as KeyframeEffect | null)?.target;
        if (
          target instanceof Element &&
          target.closest(".drawer__content, .drawer__backdrop")
        )
          animation.finish();
      }
    });
  await toggle.click();
  await expect(drawer).toBeVisible();
  await finishDrawer();
  await page.keyboard.press("Escape");
  expect(await pauseFade(drawer)).toBe(true);
  await page.keyboard.press("Control+b");
  await expect(drawer).toBeVisible();
  await expect(
    page.locator('.drawer__content[data-exiting="true"]'),
  ).toHaveCount(0);
  await expect(
    pageNavigation.getByRole("button", { name: "Preferences", exact: true }),
  ).toHaveAttribute("aria-current", "page");
  await finishDrawer();
  await page.keyboard.press("Escape");
  await finishDrawer();
  await expect(drawer).toHaveCount(0);
  await expect(toggle).toBeFocused();
  await page.addStyleTag({
    content:
      '[role="dialog"][aria-label="Navigation"] { --drawer-exit-duration: 180ms !important; } .drawer__backdrop[data-exiting="true"] { transition-duration: 180ms !important; }',
  });
  for (let attempt = 0; attempt < 8; attempt++) {
    await toggle.click();
    await page.keyboard.press("Escape");
    await page.keyboard.press("Control+b");
    await expect(drawer).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(drawer).toHaveCount(0, { timeout: 1000 });
    await expect(toggle).toBeFocused();
  }
  await page.goto("/settings/workspace");
  await toggle.click();
  await pageNavigation
    .getByRole("button", { name: "Members", exact: true })
    .tap();
  await expect(page).toHaveURL(/\/team-settings\/members$/);
  await expect(drawer).toHaveCount(0, { timeout: 1000 });
  await expect(toggle).toBeFocused();
  await page.goto(taskPath);
  await toggle.click();
  await drawer.getByRole("link", { name: "Boards", exact: true }).tap();
  await expect(page).toHaveURL(/\/boards$/);
  await expect(drawer).toHaveCount(0, { timeout: 1000 });
  await page.getByRole("main").locator(`a[href="${secondBoardPath}"]`).tap();
  await expect(page).toHaveURL(new RegExp(`${secondBoardPath}$`));
  await expect(
    page.getByRole("heading", {
      name: "Popover second board",
      exact: true,
      level: 1,
    }),
  ).toBeVisible();
  await page.screenshot({
    path: `tmp/popover-motion/mobile-navigation-${theme}.png`,
    animations: "disabled",
  });
}

for (const width of [1280, 390])
  for (const theme of ["light", "dark"] as const)
    test(`${width === 390 ? "Mobile page navigation" : "Breadcrumb popovers"} stay steady and recover from interrupted motion at ${width}px in ${theme}`, async ({
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
          (value) => localStorage.setItem("avgeek-oss-ui-theme", value),
          theme,
        );
        const page = await context.newPage();
        await authenticateBrowserFixture(page, fixture);
        await page.goto("/settings/api-keys");
        await expect(
          page.getByRole("heading", {
            name: "API Keys",
            exact: true,
            level: 1,
          }),
        ).toBeVisible();
        if (width === 390) {
          await mobileNavigationMotion(page, theme);
          return;
        }
        await expect(
          page.getByRole("button", { name: "Navigate account settings pages" }),
        ).toHaveCount(0);
        await page
          .getByRole("navigation", { name: "Breadcrumb", exact: true })
          .getByRole("link", { name: "Account Settings", exact: true })
          .click();
        await expect(page).toHaveURL(/\/settings\/profile$/);
        await page.goto("/team-settings/members");
        await expect(
          page.getByRole("button", { name: "Navigate team settings pages" }),
        ).toHaveCount(0);
        await page
          .getByRole("navigation", { name: "Breadcrumb", exact: true })
          .getByRole("link", { name: "Team Settings", exact: true })
          .click();
        await expect(page).toHaveURL(/\/team-settings\/general$/);
        const popover = page.locator(".breadcrumb-popover");
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

test("reduced motion dismisses mobile page navigation without waiting for a fade", async ({
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
      name: "Toggle navigation",
      exact: true,
      includeHidden: true,
    });
    await trigger.press("Space");
    const popover = page.getByRole("dialog", {
      name: "Navigation",
      exact: true,
    });
    await expect(popover).toBeVisible();
    expect(await popover.evaluate((el) => el.getAnimations().length)).toBe(0);
    await page.keyboard.press("Escape");
    await expect(popover).toHaveCount(0);
    await expect(trigger).toBeFocused();
  } finally {
    await context.close();
  }
});

import { randomBytes } from "node:crypto";
import { mkdir } from "node:fs/promises";
import {
  expect,
  test,
  type APIRequestContext,
  type Browser,
  type Page,
} from "@playwright/test";
import {
  authenticateBrowserFixture,
  getBrowserBootstrap,
  type BrowserFixtureSession,
} from "../browser-fixture.js";

let fixture: BrowserFixtureSession;
let api: APIRequestContext;
let boardId: string;
let taskId: string;
const taskTitle = "Keep board filters stable while returning to a task";

test.beforeAll(async ({ baseURL }) => {
  const bootstrap = await getBrowserBootstrap(baseURL!);
  fixture = bootstrap;
  api = bootstrap.api;
  const board = await api.post("/api/boards", {
    data: {
      name: "Sidebar exit verification",
      prefix: `NAV${randomBytes(3).toString("hex").toUpperCase()}`,
    },
  });
  expect(board.status()).toBe(201);
  boardId = (await board.json()).board.id;
  const task = await api.post(`/api/boards/${boardId}/tasks`, {
    data: { title: taskTitle },
  });
  expect(task.status()).toBe(201);
  taskId = (await task.json()).task.id;
  await mkdir("tmp/sidebar-exit", { recursive: true });
});
test.afterAll(async () => {
  await api?.dispose();
});

async function createPage(
  browser: Browser,
  width: number,
  theme: "light" | "dark",
  reducedMotion: "reduce" | "no-preference" = "no-preference",
) {
  const context = await browser.newContext({
    viewport: { width, height: 900 },
    isMobile: width === 390,
    hasTouch: width < 1024,
    reducedMotion,
  });
  await context.addInitScript(
    (value) => localStorage.setItem("avgeek-oss-ui-theme", value),
    theme,
  );
  const page = await context.newPage();
  await authenticateBrowserFixture(page, fixture);
  return { context, page };
}

const drawer = (page: Page) =>
  page.getByRole("dialog", { name: "Navigation", exact: true });

async function openNavigation(page: Page) {
  await page
    .getByRole("button", { name: "Toggle navigation", exact: true })
    .click();
  await expect(drawer(page)).toBeVisible();
  await expect
    .poll(() =>
      drawer(page).evaluate(
        (element) =>
          element
            .getAnimations()
            .filter((animation) => animation.playState === "running").length,
      ),
    )
    .toBe(0);
}

async function navigationSnapshot(page: Page) {
  return drawer(page).evaluate((element) => ({
    secondary: element.getAttribute("data-secondary-navigation"),
    width: element.getBoundingClientRect().width,
    columns: getComputedStyle(element).gridTemplateColumns,
    navigation: [...element.querySelectorAll("nav")].map((nav) => ({
      label: nav.getAttribute("aria-label"),
      text: nav.textContent,
      current: [
        ...nav.querySelectorAll('[aria-current="page"], a.bg-default'),
      ].map((link) => link.textContent),
    })),
  }));
}

async function slowExit(page: Page) {
  // Extend native transitions so early, middle and late frames can be inspected deterministically.
  await page.addStyleTag({
    content: `[role="dialog"][aria-label="Navigation"] { --drawer-exit-duration: 10s !important; }
      .drawer__backdrop[data-exiting="true"] { transition-duration: 10s; }`,
  });
}

async function inspectExit(
  page: Page,
  before: Awaited<ReturnType<typeof navigationSnapshot>>,
  screenshot?: string,
) {
  await expect(
    page.locator('.drawer__content[data-exiting="true"]'),
  ).toHaveCount(1);
  await expect
    .poll(() =>
      drawer(page).evaluate((element) => element.getAnimations().length),
    )
    .toBeGreaterThan(0);
  let previousLeft = 0;
  for (const progress of [0.05, 0.45, 0.85]) {
    const count = await page.evaluate((fraction) => {
      const animations = document.getAnimations().filter((animation) => {
        const target = (animation.effect as KeyframeEffect | null)?.target;
        return (
          target instanceof Element &&
          !!target.closest(".drawer__content, .drawer__backdrop")
        );
      });
      for (const animation of animations) {
        animation.pause();
        const duration = Number(animation.effect!.getComputedTiming().duration);
        animation.currentTime = duration * fraction;
      }
      return animations.length;
    }, progress);
    expect(count).toBeGreaterThan(0);
    expect(await navigationSnapshot(page)).toEqual(before);
    const left = (await drawer(page).boundingBox())!.x;
    expect(left).toBeLessThan(previousLeft - 1);
    previousLeft = left;
    if (progress === 0.05 && screenshot)
      await page.screenshot({ path: screenshot, animations: "allow" });
  }
  await page.evaluate(() => {
    for (const animation of document.getAnimations()) {
      const target = (animation.effect as KeyframeEffect | null)?.target;
      if (
        target instanceof Element &&
        target.closest(".drawer__content, .drawer__backdrop")
      )
        animation.finish();
    }
  });
  await expect(drawer(page)).toHaveCount(0);
  const focusState = await page.evaluate(() => ({
    tag: document.activeElement?.tagName,
    id: document.activeElement?.id,
    role: document.activeElement?.getAttribute("role"),
    text: document.activeElement?.textContent?.slice(0, 160),
    connected: document.activeElement?.isConnected,
  }));
  await expect(
    page.getByRole("button", { name: "Toggle navigation", exact: true }),
    JSON.stringify(focusState),
  ).toBeFocused();
}

for (const width of [390, 768])
  for (const theme of ["light", "dark"] as const)
    test(`outgoing account, plain and team navigation stay unchanged at ${width}px in ${theme}`, async ({
      browser,
    }) => {
      const { context, page } = await createPage(browser, width, theme);
      try {
        await page.goto("/settings/profile");
        await expect(
          page.getByRole("heading", { name: "Profile", exact: true }),
        ).toBeVisible();
        await slowExit(page);
        await openNavigation(page);
        const account = await navigationSnapshot(page);
        expect(account.secondary).toBe("true");
        await expect(
          drawer(page).getByRole("button", { name: "Profile", exact: true }),
        ).toHaveAttribute("aria-current", "page");
        await drawer(page)
          .getByRole("link", { name: "Boards", exact: true })
          .click();
        await expect(page).toHaveURL(/\/boards$/);
        await inspectExit(
          page,
          account,
          `tmp/sidebar-exit/account-to-boards-${width}-${theme}.png`,
        );
        await expect(
          page.getByRole("heading", { name: "Boards", exact: true }),
        ).toBeVisible();
        await openNavigation(page);
        const plain = await navigationSnapshot(page);
        expect(plain.secondary).toBe("false");
        await expect(
          drawer(page).getByRole("button", { name: "Profile", exact: true }),
        ).toHaveCount(0);
        await drawer(page)
          .getByRole("link", { name: "Account Settings", exact: true })
          .click();
        await inspectExit(
          page,
          plain,
          `tmp/sidebar-exit/boards-to-account-${width}-${theme}.png`,
        );
        await expect(
          page.getByRole("heading", { name: "Profile", exact: true }),
        ).toBeVisible();
        await openNavigation(page);
        const accountAgain = await navigationSnapshot(page);
        await drawer(page)
          .getByRole("link", { name: "Team Settings", exact: true })
          .click();
        await inspectExit(page, accountAgain);
        await expect(
          page.getByRole("heading", { name: "General", exact: true }),
        ).toBeVisible();
        await openNavigation(page);
        await expect(
          drawer(page).getByRole("navigation", {
            name: "Page navigation",
          }),
        ).toBeVisible();
        await expect(
          drawer(page).getByRole("button", { name: "General", exact: true }),
        ).toHaveAttribute("aria-current", "page");
        await expect(
          drawer(page).getByRole("button", { name: "Profile", exact: true }),
        ).toHaveCount(0);
      } finally {
        await context.close();
      }
    });

for (const theme of ["light", "dark"] as const)
  test(`board filters remain mounted through browser-back exit in ${theme}`, async ({
    browser,
  }) => {
    const { context, page } = await createPage(browser, 390, theme);
    try {
      await page.goto(`/boards/${boardId}/tasks/${taskId}`);
      await expect(
        page.getByRole("heading", { name: taskTitle }),
      ).toBeVisible();
      await page
        .getByRole("button", { name: "Back to board", exact: true })
        .click();
      await expect(
        page.getByRole("button", { name: "Filters", exact: true }),
      ).toBeVisible();
      await slowExit(page);
      await openNavigation(page);
      const filters = drawer(page).getByRole("navigation", {
        name: "Page navigation",
      });
      await expect(
        filters.getByRole("button", { name: /Newest first/ }),
      ).toBeVisible();
      await expect(
        filters.getByRole("button", { name: /All status/ }),
      ).toBeVisible();
      const before = await navigationSnapshot(page);
      await page.goBack();
      await expect(page).toHaveURL(new RegExp(`/tasks/${taskId}$`));
      await expect(
        filters.getByRole("button", { name: /All status/ }),
      ).toBeVisible();
      await inspectExit(
        page,
        before,
        `tmp/sidebar-exit/filters-to-task-390-${theme}.png`,
      );
      await expect(
        page.getByRole("heading", { name: taskTitle }),
      ).toBeVisible();
      await openNavigation(page);
      await expect(drawer(page)).toHaveAttribute(
        "data-secondary-navigation",
        "false",
      );
      await expect(
        drawer(page).getByRole("button", { name: /All status/ }),
      ).toHaveCount(0);
    } finally {
      await context.close();
    }
  });

test("Escape and close keep same-route navigation and restore focus", async ({
  browser,
}) => {
  const { context, page } = await createPage(browser, 390, "dark");
  try {
    await page.goto("/settings/preferences");
    await expect(
      page.getByRole("heading", { name: "Preferences", exact: true }),
    ).toBeVisible();
    await slowExit(page);
    for (const method of ["Escape", "close"] as const) {
      await openNavigation(page);
      const before = await navigationSnapshot(page);
      if (method === "Escape") await page.keyboard.press("Escape");
      else
        await drawer(page)
          .getByRole("button", { name: "Close navigation", exact: true })
          .click();
      await inspectExit(page, before);
      await expect(page).toHaveURL(/\/settings\/preferences$/);
      await expect(
        page.getByRole("heading", { name: "Preferences", exact: true }),
      ).toBeVisible();
    }
    await openNavigation(page);
    await expect(
      drawer(page).getByRole("button", { name: "Preferences", exact: true }),
    ).toHaveAttribute("aria-current", "page");
  } finally {
    await context.close();
  }
});

test("reduced motion navigates and reopens destination without a held exit", async ({
  browser,
}) => {
  const { context, page } = await createPage(browser, 390, "light", "reduce");
  try {
    await page.goto("/settings/profile");
    await openNavigation(page);
    expect(
      await drawer(page).evaluate((element) =>
        Math.max(
          ...getComputedStyle(element)
            .transitionDuration.split(",")
            .map((duration) => Number.parseFloat(duration) * 1000),
        ),
      ),
    ).toBeLessThan(1);
    await drawer(page)
      .getByRole("link", { name: "Boards", exact: true })
      .click();
    await expect(drawer(page)).toHaveCount(0);
    await expect(
      page.getByRole("heading", { name: "Boards", exact: true }),
    ).toBeVisible();
    await openNavigation(page);
    await expect(drawer(page)).toHaveAttribute(
      "data-secondary-navigation",
      "false",
    );
  } finally {
    await context.close();
  }
});

test("desktop navigation updates immediately without a mobile exit snapshot", async ({
  browser,
}) => {
  const { context, page } = await createPage(browser, 1280, "dark");
  try {
    await page.goto("/settings/profile");
    const primary = page.getByRole("navigation", {
      name: "Workspace navigation",
      exact: true,
    });
    await expect(
      page
        .getByRole("navigation", { name: "Page navigation" })
        .getByRole("button", { name: "Profile", exact: true }),
    ).toBeVisible();
    await primary.getByRole("link", { name: "Boards", exact: true }).click();
    await expect(
      page.getByRole("heading", { name: "Boards", exact: true }),
    ).toBeVisible();
    await expect(
      page
        .getByRole("navigation", { name: "Page navigation" })
        .getByRole("button", { name: "Profile", exact: true }),
    ).toHaveCount(0);
    await expect(drawer(page)).toHaveCount(0);
    await primary
      .getByRole("link", { name: "Team Settings", exact: true })
      .click();
    await expect(
      page.getByRole("heading", { name: "General", exact: true }),
    ).toBeVisible();
    await expect(
      page
        .getByRole("navigation", { name: "Page navigation" })
        .getByRole("button", { name: "General", exact: true }),
    ).toBeVisible();
  } finally {
    await context.close();
  }
});

test("reopening during an interrupted exit releases destination navigation", async ({
  browser,
}) => {
  const { context, page } = await createPage(browser, 390, "dark");
  try {
    await page.goto("/settings/profile");
    await openNavigation(page);
    await slowExit(page);
    const before = await navigationSnapshot(page);
    await drawer(page)
      .getByRole("link", { name: "Boards", exact: true })
      .click();
    await expect(
      page.locator('.drawer__content[data-exiting="true"]'),
    ).toHaveCount(1);
    await page.evaluate(() => {
      for (const animation of document.getAnimations()) {
        const target = (animation.effect as KeyframeEffect | null)?.target;
        if (
          target instanceof Element &&
          target.closest(".drawer__content, .drawer__backdrop")
        ) {
          animation.pause();
          animation.currentTime =
            Number(animation.effect!.getComputedTiming().duration) * 0.45;
        }
      }
    });
    expect(await navigationSnapshot(page)).toEqual(before);
    await page.keyboard.press("Control+b");
    await expect(
      page.locator('.drawer__content[data-exiting="true"]'),
    ).toHaveCount(0);
    await expect(drawer(page)).toHaveAttribute(
      "data-secondary-navigation",
      "false",
    );
    await expect(
      drawer(page).getByRole("button", { name: "Profile", exact: true }),
    ).toHaveCount(0);
    await expect(
      drawer(page).getByRole("link", { name: "Boards", exact: true }),
    ).toHaveClass(/\bbg-default\b/);
    await expect(
      page.getByRole("heading", { name: "Boards", exact: true }),
    ).toBeVisible();
    await expect
      .poll(() =>
        drawer(page).evaluate(
          (element) =>
            element
              .getAnimations()
              .filter((animation) => animation.playState === "running").length,
        ),
      )
      .toBe(0);
    const destination = await navigationSnapshot(page);
    await page.keyboard.press("Escape");
    await inspectExit(page, destination);
    await expect(
      page.getByRole("heading", { name: "Boards", exact: true }),
    ).toBeVisible();
  } finally {
    await context.close();
  }
});

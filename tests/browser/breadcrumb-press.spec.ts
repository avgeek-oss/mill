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

test.beforeAll(async ({ baseURL }) => {
  const bootstrap = await getBrowserBootstrap(baseURL!);
  fixture = bootstrap;
  try {
    const board = await bootstrap.api.post("/api/boards", {
      data: {
        name: "Breadcrumb press verification",
        prefix: `BC${randomBytes(3).toString("hex").toUpperCase()}`,
      },
    });
    expect(board.status()).toBe(201);
    const boardId = (await board.json()).board.id;
    const task = await bootstrap.api.post(`/api/boards/${boardId}/tasks`, {
      data: { title: "Keep breadcrumb controls stable while pressing" },
    });
    expect(task.status()).toBe(201);
    taskPath = `/boards/${boardId}/tasks/${(await task.json()).task.id}`;
    await mkdir("tmp/breadcrumb-press", { recursive: true });
  } finally {
    await bootstrap.api.dispose();
  }
});

async function metrics(trigger: Locator) {
  return trigger.evaluate((element) => {
    const style = getComputedStyle(element);
    const bounds = element.getBoundingClientRect();
    return {
      width: bounds.width,
      height: bounds.height,
      identity: new DOMMatrixReadOnly(style.transform).isIdentity,
      transition: style.transitionProperty,
    };
  });
}

async function pressWithoutScaling(
  page: Page,
  trigger: Locator,
  popup: Locator,
) {
  await expect(trigger).toBeVisible();
  const before = await metrics(trigger);
  expect(before.identity).toBe(true);
  expect(before.transition).not.toMatch(/transform|scale|all/);
  const bounds = (await trigger.boundingBox())!;
  await page.mouse.move(
    bounds.x + bounds.width / 2,
    bounds.y + bounds.height / 2,
  );
  await page.mouse.down();
  try {
    await expect
      .poll(() =>
        trigger.evaluate(
          (element) =>
            element.matches(":active") ||
            element.getAttribute("data-pressed") === "true",
        ),
      )
      .toBe(true);
    expect(await metrics(trigger)).toEqual(before);
  } finally {
    await page.mouse.up();
  }
  await expect(popup).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(popup).toHaveCount(0);
  await expect(trigger).toBeFocused();
  await page.keyboard.down("Space");
  try {
    expect(await metrics(trigger)).toEqual(before);
  } finally {
    await page.keyboard.up("Space");
  }
  await expect(popup).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(popup).toHaveCount(0);
  await expect(trigger).toBeFocused();
  expect(
    await trigger.evaluate((element) => {
      const style = getComputedStyle(element);
      return { shadow: style.boxShadow, outline: style.outlineStyle };
    }),
  ).toEqual({ shadow: "none", outline: "none" });
}

async function followWithoutScaling(
  page: Page,
  link: Locator,
  href: string,
  heading: string,
) {
  await expect(link).toBeVisible();
  await expect(link).toHaveAttribute("href", href);
  const before = await metrics(link);
  expect(before.identity).toBe(true);
  const bounds = (await link.boundingBox())!;
  await page.mouse.move(
    bounds.x + bounds.width / 2,
    bounds.y + bounds.height / 2,
  );
  await page.mouse.down();
  try {
    await expect
      .poll(() => link.evaluate((element) => element.matches(":active")))
      .toBe(true);
    expect(await metrics(link)).toEqual(before);
  } finally {
    await page.mouse.up();
  }
  await expect(page).toHaveURL(new URL(href, page.url()).href);
  await expect(
    page.getByRole("heading", { name: heading, exact: true, level: 1 }),
  ).toBeVisible();
}

for (const width of [1280, 390])
  for (const theme of ["light", "dark"] as const)
    test(`breadcrumb links and menus retain their size during pointer and keyboard presses at ${width}px in ${theme}`, async ({
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
        for (const [path, title, category, ancestorHref, ancestorTitle] of [
          [
            "/settings/api-keys",
            "API Keys",
            "Account Settings",
            "/settings/profile",
            "Profile",
          ],
          [
            "/team-settings/members",
            "Members",
            "Team Settings",
            "/team-settings/general",
            "General",
          ],
        ]) {
          await page.goto(path!);
          await expect(
            page.getByRole("heading", { name: title!, exact: true, level: 1 }),
          ).toBeVisible();
          const breadcrumb = page.getByRole("navigation", {
            name: "Breadcrumb",
            exact: true,
          });
          if (width === 390) {
            await expect(breadcrumb).toBeHidden();
            await page
              .getByRole("button", { name: "Toggle navigation", exact: true })
              .click();
            const drawer = page.getByRole("dialog", {
              name: "Navigation",
              exact: true,
            });
            await expect(
              drawer.getByRole("link", {
                name: category!,
                exact: true,
              }),
            ).toBeVisible();
            await page.keyboard.press("Escape");
            await expect(drawer).toHaveCount(0);
            continue;
          }
          const ancestor = breadcrumb.getByRole("link", {
            name: category!,
            exact: true,
          });
          await followWithoutScaling(
            page,
            ancestor,
            ancestorHref!,
            ancestorTitle!,
          );
          await page.goBack();
          await expect(page).toHaveURL(new URL(path!, page.url()).href);
          await expect(
            page.getByRole("heading", { name: title!, exact: true, level: 1 }),
          ).toBeVisible();
          await ancestor.press("Enter");
          await expect(page).toHaveURL(new URL(ancestorHref!, page.url()).href);
          await expect(
            page.getByRole("heading", {
              name: ancestorTitle!,
              exact: true,
              level: 1,
            }),
          ).toBeVisible();
        }
        await page.goto(taskPath);
        await expect(
          page.getByRole("heading", {
            name: "Keep breadcrumb controls stable while pressing",
            exact: true,
          }),
        ).toBeVisible();
        if (width === 1280)
          await pressWithoutScaling(
            page,
            page.getByRole("button", {
              name: "Switch board: Breadcrumb press verification",
              exact: true,
            }),
            page.getByRole("listbox"),
          );
        await page.screenshot({
          path: `tmp/breadcrumb-press/task-${width}-${theme}.png`,
          animations: "disabled",
        });
      } finally {
        await context.close();
      }
    });

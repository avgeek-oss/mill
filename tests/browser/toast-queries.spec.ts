import { expect, test, type Page } from "@playwright/test";
import {
  authenticateBrowserFixture,
  getBrowserBootstrap,
  type BrowserFixtureSession,
} from "../browser-fixture.js";

let fixture: BrowserFixtureSession;
test.beforeAll(async ({ baseURL }) => {
  const bootstrap = await getBrowserBootstrap(baseURL!);
  fixture = bootstrap;
  await bootstrap.api.dispose();
});

function notification(page: Page, text: string) {
  return page
    .locator('[data-slot="toast"]:not([data-exiting="true"])')
    .filter({ hasText: text });
}

async function dismissWithoutHover(page: Page, text: string) {
  const toast = notification(page, text);
  const close = toast.locator('[data-slot="toast-close"]');
  await page.mouse.move(1, 1);
  await expect(close).toBeVisible();
  await expect
    .poll(() =>
      close.evaluate((element) => {
        const style = getComputedStyle(element);
        const rect = element.getBoundingClientRect();
        return (
          style.opacity === "1" &&
          style.pointerEvents !== "none" &&
          rect.width >= 32 &&
          rect.height >= 32
        );
      }),
    )
    .toBe(true);
  await close.focus();
  await expect(close).toBeFocused();
  await close.press("Enter");
  await expect(toast).toHaveCount(0);
}

for (const [width, theme] of [
  [1280, "light"],
  [1280, "dark"],
  [390, "light"],
  [390, "dark"],
] as const) {
  test.describe(`${width}px ${theme} toast feedback`, () => {
    test.use({
      viewport: { width, height: 900 },
      hasTouch: width < 640,
    });
    test.beforeEach(async ({ page }) => {
      await page.addInitScript(
        (value) => localStorage.setItem("avgeek-oss-ui-theme", value),
        theme,
      );
    });

    test("query retries produce one fresh toast per failure and retain recovery actions", async ({
      page,
    }) => {
      await authenticateBrowserFixture(page, fixture);
      let attempts = 0;
      let fail = true;
      const failure = "Your boards could not be loaded. Try again.";
      await page.route("**/api/boards?*", (route) => {
        attempts++;
        return fail
          ? route.fulfill({ status: 503, json: { error: failure } })
          : route.continue();
      });
      await page.goto("/boards");
      for (let attempt = 0; attempt < 2; attempt++) {
        await expect(notification(page, failure)).toBeVisible();
        await expect(notification(page, failure)).toHaveCount(1);
        await expect(
          page.getByRole("main").getByText(failure, { exact: true }),
        ).toHaveCount(0);
        const retry = page.getByRole("button", { name: "Retry", exact: true });
        await expect(retry).toBeVisible();
        await expect(
          page.getByRole("heading", { name: "Your work starts here" }),
        ).toHaveCount(0);
        await dismissWithoutHover(page, failure);
        if (attempt === 0) await retry.click();
      }
      expect(attempts).toBe(2);
      fail = false;
      await page.getByRole("button", { name: "Retry", exact: true }).click();
      await expect(
        page.getByRole("heading", { name: "Your work starts here" }),
      ).toBeVisible();
      await expect(
        page.getByRole("button", { name: "Retry", exact: true }),
      ).toHaveCount(0);
    });

    test("settings list failures keep explanations exclusively in toasts", async ({
      page,
    }) => {
      await authenticateBrowserFixture(page, fixture);
      for (const [path, endpoint] of [
        ["/settings/sessions", "/api/auth/sessions"],
        ["/settings/two-factor", "/api/auth/passkeys"],
        ["/settings/api-keys", "/api/credentials"],
        ["/settings/members", "/api/auth/invitations"],
      ]) {
        const failure = `Could not load ${path.split("/").at(-1)}.`;
        const pattern = `**${endpoint}*`;
        await page.route(pattern, (route) =>
          route.fulfill({ status: 503, json: { error: failure } }),
        );
        await page.goto(path);
        await expect(notification(page, failure)).toHaveCount(1);
        await expect(
          page.getByRole("main").getByText(failure, { exact: true }),
        ).toHaveCount(0);
        await expect(
          page.getByRole("button", { name: "Retry", exact: true }),
        ).toBeVisible();
        await dismissWithoutHover(page, failure);
        await page.unroute(pattern);
      }
    });

    test("MCP configuration copy has toast-only feedback on repeated failures and success", async ({
      page,
    }) => {
      const uncaught: string[] = [];
      page.on("pageerror", (error) => uncaught.push(error.message));
      await page.addInitScript(() => {
        const state = window as Window & { clipboardAllowed?: boolean };
        state.clipboardAllowed = false;
        Object.defineProperty(navigator, "clipboard", {
          configurable: true,
          value: {
            writeText: async () => {
              if (!state.clipboardAllowed) throw new Error("Clipboard denied");
            },
          },
        });
      });
      await authenticateBrowserFixture(page, fixture);
      await page.goto("/settings/mcp");
      const copy = page.getByRole("button", {
        name: "Copy MCP configuration",
        exact: true,
      });
      const failure =
        "Could not copy to the clipboard. Select and copy the text instead.";
      for (let attempt = 0; attempt < 2; attempt++) {
        await copy.click();
        await expect(notification(page, failure)).toHaveCount(1);
        await expect(copy).toHaveText("Copy");
        await expect(
          page.getByRole("main").getByText(failure, { exact: true }),
        ).toHaveCount(0);
        await dismissWithoutHover(page, failure);
      }
      await page.evaluate(() => {
        (window as Window & { clipboardAllowed?: boolean }).clipboardAllowed =
          true;
      });
      await copy.click();
      await expect(notification(page, "Copied to clipboard.")).toHaveCount(1);
      await expect(copy).toHaveText("Copy");
      expect(uncaught).toEqual([]);
    });
  });
}

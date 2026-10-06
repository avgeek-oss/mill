import { expect, test } from "@playwright/test";
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

const preferences = [
  {
    name: "legacy preference",
    legacy: "dark",
    shared: null,
    system: "light",
    expected: "dark",
    mode: "dark",
  },
  {
    name: "shared preference precedence",
    legacy: "dark",
    shared: "light",
    system: "dark",
    expected: "light",
    mode: "light",
  },
  {
    name: "system preference",
    legacy: "light",
    shared: "system",
    system: "dark",
    expected: "dark",
    mode: "system",
  },
  {
    name: "no stored preference",
    legacy: null,
    shared: null,
    system: "light",
    expected: "light",
    mode: "system",
  },
] as const;

for (const width of [1280, 390]) {
  for (const preference of preferences) {
    test(`theme bootstrap applies ${preference.name} before React loads at ${width}px`, async ({
      browser,
    }) => {
      const context = await browser.newContext({
        viewport: { width, height: 900 },
        colorScheme: preference.system,
      });
      try {
        await context.addInitScript(({ legacy, shared }) => {
          if (legacy) localStorage.setItem("mill:theme", legacy);
          if (shared) localStorage.setItem("avgeek-oss-ui-theme", shared);
        }, preference);
        const page = await context.newPage();
        await authenticateBrowserFixture(page, fixture);
        let release!: () => void;
        const held = new Promise<void>((resolve) => {
          release = resolve;
        });
        let started!: () => void;
        const requested = new Promise<void>((resolve) => {
          started = resolve;
        });
        await page.route("**/assets/index-*.js", async (route) => {
          started();
          await held;
          await route.continue();
        });
        try {
          await page.goto("/boards", { waitUntil: "commit" });
          await requested;
          await expect(page.locator("html")).toHaveAttribute(
            "data-theme",
            preference.expected,
          );
          await expect(page.locator("html")).toHaveAttribute(
            "data-theme-mode",
            preference.mode,
          );
          await expect(page.locator("#root")).not.toHaveAttribute(
            "data-mill-entry-started",
            "true",
          );
          expect(
            await page.evaluate(
              () => document.documentElement.style.colorScheme,
            ),
          ).toBe(preference.expected);
          expect(
            await page.evaluate(() =>
              localStorage.getItem("avgeek-oss-ui-theme"),
            ),
          ).toBe(preference.shared ?? preference.legacy);
        } finally {
          release();
          await page.unrouteAll({ behavior: "wait" });
        }
        await expect(
          page.getByRole("heading", { name: "Boards", exact: true, level: 1 }),
        ).toBeVisible();
        await expect(page.locator("html")).toHaveAttribute(
          "data-theme",
          preference.expected,
        );
        await page
          .getByRole("link", { name: "Skip to content", exact: true })
          .focus();
        await page.keyboard.press("Enter");
        await expect(page.locator("#main-content")).toBeFocused();
        await expect(page.getByRole("main")).toHaveCount(1);
      } finally {
        await context.close();
      }
    });
  }
}

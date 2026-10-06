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

for (const width of [1280, 390]) {
  test(`theme colors change together without flickering at ${width}px`, async ({
    browser,
  }) => {
    const context = await browser.newContext({
      viewport: { width, height: 844 },
      isMobile: width === 390,
      hasTouch: width === 390,
    });
    try {
      await context.addInitScript(() => {
        if (!localStorage.getItem("mill:theme"))
          localStorage.setItem("mill:theme", "light");
      });
      const page = await context.newPage();
      await authenticateBrowserFixture(page, fixture);
      await page.goto("/boards");
      await expect(
        page.getByRole("heading", { name: "Boards", exact: true }),
      ).toBeVisible();
      for (const theme of ["dark", "light"] as const) {
        const frames = await page.evaluate(async () => {
          const root = document.documentElement;
          const button = document.querySelector<HTMLButtonElement>(
            '[data-slot="theme-switcher"]',
          )!;
          button.click();
          const samples = [];
          for (let frame = 0; frame < 12; frame++) {
            await new Promise<void>((resolve) =>
              requestAnimationFrame(() => resolve()),
            );
            const rootStyle = getComputedStyle(root);
            const buttonStyle = getComputedStyle(button);
            samples.push({
              theme: root.dataset.theme,
              dark: root.classList.contains("dark"),
              label: button.getAttribute("aria-label"),
              background: rootStyle.backgroundColor,
              foreground: rootStyle.color,
              controlBackground: buttonStyle.backgroundColor,
              controlForeground: buttonStyle.color,
              colorTransitions: document
                .getAnimations()
                .filter(
                  (animation) =>
                    animation instanceof CSSTransition &&
                    /color|shadow/.test(animation.transitionProperty),
                )
                .map(
                  (animation) =>
                    (animation as CSSTransition).transitionProperty,
                ),
            });
          }
          return samples;
        });
        const settled = frames.at(-1)!;
        expect(settled.theme).toBe(theme);
        expect(settled.dark).toBe(theme === "dark");
        expect(settled.label).toBe(
          `Appearance: switch to ${theme === "dark" ? "light" : "dark"} theme`,
        );
        for (const frame of frames) {
          expect(frame).toEqual(settled);
          expect(frame.colorTransitions).toEqual([]);
        }
        await expect(page.locator("html")).not.toHaveClass(/theme-changing/);
        // The pause must be temporary: normal control feedback returns afterward.
        expect(
          await page
            .locator('[data-slot="theme-switcher"]')
            .evaluate(
              (element) => getComputedStyle(element).transitionProperty,
            ),
        ).toContain("background-color");
      }
      await page.emulateMedia({ reducedMotion: "reduce" });
      const switcher = page.getByRole("button", {
        name: "Appearance: switch to dark theme",
      });
      await switcher.press("Enter");
      await page
        .getByRole("button", {
          name: "Appearance: switch to light theme",
        })
        .press("Enter");
      await page
        .getByRole("button", {
          name: "Appearance: switch to dark theme",
        })
        .press("Enter");
      await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
      await expect(page.locator("html")).not.toHaveClass(/theme-changing/);
      // Reload must use the selection saved by the last of the rapid switches.
      await page.reload();
      await expect(
        page.getByRole("button", {
          name: "Appearance: switch to light theme",
        }),
      ).toBeVisible();
      await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
    } finally {
      await context.close();
    }
  });
}

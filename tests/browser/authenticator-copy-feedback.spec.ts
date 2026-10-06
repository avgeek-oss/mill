import { expect, test } from "@playwright/test";
import {
  authenticateBrowserFixture,
  browserBootstrap,
  getBrowserBootstrap,
} from "../browser-fixture.js";

test.use({ trace: "off", screenshot: "off" });

for (const [width, theme] of [
  [1280, "light"],
  [390, "dark"],
] as const) {
  test(`authenticator setup copying reports every failure and awaited success via toast at ${width} ${theme}`, async ({
    page,
    baseURL,
  }) => {
    const fixture = await getBrowserBootstrap(baseURL!);
    await fixture.api.dispose();
    await page.setViewportSize({ width, height: 900 });
    await page.addInitScript((appearance) => {
      localStorage.setItem("avgeek-oss-ui-theme", appearance);
      const state = { attempts: 0, release: () => {} };
      Object.defineProperty(window, "setupCopyTest", { value: state });
      Object.defineProperty(navigator, "clipboard", {
        configurable: true,
        value: {
          writeText: async () => {
            state.attempts++;
            if (state.attempts <= 2) throw new Error("Clipboard unavailable");
            await new Promise<void>((resolve) => {
              state.release = resolve;
            });
          },
        },
      });
    }, theme);
    await authenticateBrowserFixture(page, fixture);
    await page.goto("/settings/two-factor");
    await page
      .getByRole("button", { name: "Set up authenticator", exact: true })
      .click();
    const confirmation = page.getByRole("dialog", { name: "Confirm it’s you" });
    await confirmation
      .getByLabel("Password", { exact: true })
      .fill(browserBootstrap.password);
    await confirmation
      .getByRole("button", { name: "Confirm", exact: true })
      .click();
    await expect(confirmation).toHaveCount(0);
    const copy = page.getByRole("button", {
      name: "Copy setup key",
      exact: true,
    });
    const failure =
      "Could not copy the setup key. Select it and copy it manually.";
    for (let attempt = 0; attempt < 2; attempt++) {
      await copy.click();
      const toast = page
        .locator('[data-slot="toast"]:not([data-exiting="true"])')
        .filter({ hasText: failure });
      await expect(toast).toHaveCount(1);
      await expect(
        page.getByRole("main").getByText(failure, { exact: true }),
      ).toHaveCount(0);
      await expect(copy).toHaveText("Copy");
      await toast.getByRole("button").click();
      await expect(toast).toHaveCount(0);
    }
    await copy.click();
    await expect(copy).toBeDisabled();
    const success = page
      .locator('[data-slot="toast"]:not([data-exiting="true"])')
      .filter({ hasText: "Setup key copied to clipboard." });
    await expect(success).toHaveCount(0);
    await page.evaluate(() => {
      const state = (
        window as unknown as {
          setupCopyTest: { attempts: number; release: () => void };
        }
      ).setupCopyTest;
      if (state.attempts !== 3)
        throw new Error("Unexpected clipboard attempt count");
      state.release();
    });
    await expect(success).toHaveCount(1);
    await expect(copy).toBeEnabled();
    await expect(copy).toHaveText("Copy");
    await expect(
      page
        .getByRole("main")
        .getByText("Setup key copied to clipboard.", { exact: true }),
    ).toHaveCount(0);
    await expect(
      page.getByLabel("Six-digit code", { exact: true }),
    ).toHaveValue("");
  });
}

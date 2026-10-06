import { expect, test, type Page } from "@playwright/test";
import {
  authenticateBrowserFixture,
  getBrowserBootstrap,
  type BrowserFixtureSession,
} from "../browser-fixture.js";

test.use({ trace: "off", screenshot: "off" });

let fixture: BrowserFixtureSession;
test.beforeAll(async ({ baseURL }) => {
  const bootstrap = await getBrowserBootstrap(baseURL!);
  fixture = bootstrap;
  await bootstrap.api.dispose();
});

function notification(page: Page, text: string) {
  return page.locator('[data-slot="toast"]').filter({ hasText: text });
}

for (const width of [1280, 390])
  test(`whitespace-only required names toast and retain the draft at ${width}px`, async ({
    browser,
  }) => {
    const context = await browser.newContext({
      viewport: { width, height: 844 },
      isMobile: width === 390,
      hasTouch: width === 390,
    });
    try {
      const page = await context.newPage();
      await authenticateBrowserFixture(page, fixture);
      await page.goto("/settings/api-keys");
      await page
        .getByRole("button", { name: "Create API key", exact: true })
        .click();
      const dialog = page.getByRole("dialog", {
        name: "Create API key",
        exact: true,
      });
      const name = dialog.getByLabel("Name", { exact: true });
      await name.fill("   ");
      let requests = 0;
      await page.route("**/api/credentials", (route) => {
        if (route.request().method() === "POST") requests++;
        return route.continue();
      });
      for (let attempt = 0; attempt < 2; attempt++) {
        await dialog
          .getByRole("button", { name: "Create key", exact: true })
          .click();
        const alert = notification(page, "Enter a value for Name.");
        await expect(alert).toBeVisible();
        await expect(name).toBeFocused();
        await expect(name).toHaveValue("   ");
        await expect(dialog.getByRole("alert")).toHaveCount(0);
        await expect(alert).toHaveCount(1);
        if (attempt === 0) {
          await expect
            .poll(() =>
              alert.evaluate((element) => {
                const rect = element.getBoundingClientRect();
                return (
                  rect.top >= 0 &&
                  rect.bottom <= window.innerHeight &&
                  element
                    .getAnimations({ subtree: true })
                    .every((animation) => animation.playState !== "running")
                );
              }),
            )
            .toBe(true);
          await page.screenshot({
            path: `tmp/toast-feedback/whitespace-${width}.png`,
          });
        }
        await alert.locator('[data-slot="toast-close"]').click();
        await expect(alert).toHaveCount(0);
      }
      expect(requests).toBe(0);
      await name.fill(`Valid name ${width}`);
      await dialog
        .getByRole("button", { name: "Create key", exact: true })
        .click();
      await expect(
        page.getByRole("dialog", { name: "Copy your API key", exact: true }),
      ).toBeVisible();
      await expect(notification(page, "API key created.")).toBeVisible();
      expect(requests).toBe(1);
    } finally {
      await context.close();
    }
  });

test("API key copy failures toast on every attempt when the clipboard API is unavailable", async ({
  page,
}) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: undefined,
    });
  });
  await authenticateBrowserFixture(page, fixture);
  await page.goto("/settings/api-keys");
  await page
    .getByRole("button", { name: "Create API key", exact: true })
    .click();
  const form = page.getByRole("dialog", {
    name: "Create API key",
    exact: true,
  });
  await form
    .getByLabel("Name", { exact: true })
    .fill("Clipboard failure verification");
  await form.getByRole("button", { name: "Create key", exact: true }).click();
  const result = page.getByRole("dialog", {
    name: "Copy your API key",
    exact: true,
  });
  const failure =
    "Could not copy to the clipboard. Select and copy the text instead.";
  for (let attempt = 0; attempt < 2; attempt++) {
    await result
      .getByRole("button", { name: "Copy code", exact: true })
      .click();
    const toast = notification(page, failure);
    await expect(toast).toBeVisible();
    await expect(result.getByText(failure, { exact: true })).toHaveCount(0);
    await toast.locator('[data-slot="toast-close"]').click();
    await expect(toast).toHaveCount(0);
  }
});

test("profile failures retry with a fresh toast while retaining the draft", async ({
  page,
}) => {
  await authenticateBrowserFixture(page, fixture);
  await page.goto("/settings/profile");
  let attempts = 0;
  await page.route("**/api/auth/profile", (route) => {
    attempts++;
    return route.fulfill({
      status: 503,
      json: { error: "Profile update unavailable. Try again." },
    });
  });
  const form = page.getByRole("main").locator("form");
  await form
    .getByLabel("Your Name", { exact: true })
    .fill("Retained profile draft");
  for (let attempt = 0; attempt < 2; attempt++) {
    await form.getByRole("button", { name: "Save", exact: true }).click();
    const toast = notification(page, "Profile update unavailable. Try again.");
    await expect(toast).toBeVisible();
    await expect(form.getByRole("alert")).toHaveCount(0);
    await expect(form.getByLabel("Your Name", { exact: true })).toHaveValue(
      "Retained profile draft",
    );
    await toast.locator('[data-slot="toast-close"]').click();
    await expect(toast).toHaveCount(0);
  }
  expect(attempts).toBe(2);
});

test("identical synchronous password mismatches produce a toast on every attempt", async ({
  page,
}) => {
  await authenticateBrowserFixture(page, fixture);
  await page.goto("/settings/email-password");
  const form = page.getByRole("main").locator("form");
  await form
    .getByLabel("Current password", { exact: true })
    .fill("Current-only-password-42");
  await form
    .getByLabel("New password", { exact: true })
    .fill("Next-only-password-42");
  await form
    .getByLabel("Confirm new password", { exact: true })
    .fill("Different-only-password-42");
  let passwordRequests = 0;
  await page.route("**/api/auth/password", (route) => {
    passwordRequests++;
    return route.abort();
  });
  for (let attempt = 0; attempt < 2; attempt++) {
    await form.getByRole("button", { name: "Change password" }).click();
    const toast = notification(page, "New passwords do not match");
    await expect(toast).toBeVisible();
    await expect(form.getByRole("alert")).toHaveCount(0);
    await toast.locator('[data-slot="toast-close"]').click();
    await expect(toast).toHaveCount(0);
  }
  expect(passwordRequests).toBe(0);
});

test("invitation creation and delivery failure appear only as toasts alongside the private link", async ({
  page,
  baseURL,
}) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: undefined,
    });
  });
  await authenticateBrowserFixture(page, fixture);
  await page.goto("/settings/members");
  await page.route("**/api/auth/invitations", (route) => {
    if (route.request().method() !== "POST") return route.continue();
    return route.fulfill({
      status: 201,
      json: {
        inviteUrl: `${baseURL}/invite?token=toast-only-disposable-link`,
        emailDelivery: "failed",
      },
    });
  });
  await page
    .getByRole("button", { name: "Invite a person", exact: true })
    .click();
  const form = page.getByRole("dialog", {
    name: "Invite a person",
    exact: true,
  });
  await form
    .getByLabel("Email", { exact: true })
    .fill("toast-feedback@example.test");
  await form.getByRole("button", { name: "Create invitation" }).click();
  const dialog = page.getByRole("dialog", {
    name: "Invitation link",
    exact: true,
  });
  await expect(
    dialog.getByLabel("Invitation link", { exact: true }),
  ).toHaveValue(`${baseURL}/invite?token=toast-only-disposable-link`);
  await expect(notification(page, "Invitation created.")).toBeVisible();
  await expect(
    notification(
      page,
      "The invitation email could not be sent. Share the link directly.",
    ),
  ).toBeVisible();
  await expect(dialog.getByRole("alert")).toHaveCount(0);
  await expect(
    dialog.getByText("Invitation created.", { exact: true }),
  ).toHaveCount(0);
  await expect(
    dialog.getByText(
      "The invitation email could not be sent. Share the link directly.",
      { exact: true },
    ),
  ).toHaveCount(0);
  const copyFailure =
    "The link could not be copied. Select the invitation link and copy it manually.";
  for (let attempt = 0; attempt < 2; attempt++) {
    await dialog
      .getByRole("button", { name: "Copy invitation link", exact: true })
      .click();
    const toast = notification(page, copyFailure);
    await expect(toast).toBeVisible();
    await expect(dialog.getByText(copyFailure, { exact: true })).toHaveCount(0);
    await toast.locator('[data-slot="toast-close"]').click();
    await expect(toast).toHaveCount(0);
  }
});

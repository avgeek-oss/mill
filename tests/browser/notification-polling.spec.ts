import { expect, test } from "@playwright/test";
import {
  authenticateBrowserFixture,
  getBrowserBootstrap,
  getBrowserRoleFixture,
  type BrowserFixtureSession,
} from "../browser-fixture.js";

let fixture: BrowserFixtureSession;
test.beforeEach(async ({ baseURL }) => {
  const bootstrap = await getBrowserBootstrap(baseURL!);
  fixture = bootstrap;
  await bootstrap.api.dispose();
});

const toastSelector = '[data-slot="toast"]:not([data-exiting="true"])';
const failure = "Notifications could not be refreshed. Try again.";

test("notification polling reports an outage once and notifies again after recovery", async ({
  page,
}) => {
  await page.clock.install();
  await authenticateBrowserFixture(page, fixture);
  await page.goto("/boards");
  await expect(
    page.getByRole("heading", { name: "Boards", exact: true }),
  ).toBeVisible();
  let attempts = 0;
  let fail = true;
  await page.route("**/api/notifications?limit=1", (route) => {
    attempts++;
    return fail
      ? route.fulfill({ status: 503, json: { error: failure } })
      : route.continue();
  });
  const feedback = page.locator(toastSelector).filter({ hasText: failure });
  await page.clock.fastForward(30001);
  await expect(feedback).toHaveCount(1);
  await expect(
    page.getByRole("main").getByText(failure, { exact: true }),
  ).toHaveCount(0);
  await feedback.locator('[data-slot="toast-close"]').click();
  await expect(feedback).toHaveCount(0);
  await page.clock.fastForward(30001);
  await expect.poll(() => attempts).toBe(2);
  await expect(feedback).toHaveCount(0);
  fail = false;
  const recovered = page.waitForResponse(
    (response) =>
      response.url().endsWith("/api/notifications?limit=1") &&
      response.status() === 200,
  );
  await page.clock.fastForward(30001);
  await recovered;
  fail = true;
  await page.clock.fastForward(30001);
  await expect(feedback).toHaveCount(1);
  expect(attempts).toBe(4);
});

for (const result of ["success", "failure"] as const)
  test(`a delayed ${result} from notification polling cannot affect another signed-in account`, async ({
    page,
    baseURL,
  }) => {
    const member = await getBrowserRoleFixture(baseURL!, "member");
    await member.api.dispose();
    await page.clock.install();
    await authenticateBrowserFixture(page, fixture);
    await page.goto("/boards");
    await expect(
      page.getByRole("heading", { name: "Boards", exact: true }),
    ).toBeVisible();
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let started!: () => void;
    const pending = new Promise<void>((resolve) => {
      started = resolve;
    });
    let finished!: () => void;
    const settled = new Promise<void>((resolve) => {
      finished = resolve;
    });
    let first = true;
    await page.route("**/api/notifications?limit=1", async (route) => {
      if (!first) return route.continue();
      first = false;
      started();
      await held;
      await route.fulfill(
        result === "success"
          ? { status: 200, json: { unreadCount: 7 } }
          : { status: 503, json: { error: failure } },
      );
      finished();
    });
    try {
      await page.clock.fastForward(30001);
      await pending;
      await page.getByRole("button", { name: /^Account menu for / }).click();
      await page
        .getByRole("menuitem", { name: "Sign out", exact: true })
        .click();
      await expect(
        page.getByRole("heading", { name: "Sign in", exact: true }),
      ).toBeVisible();
      await page
        .getByLabel("Email", { exact: true })
        .fill(member.identity.user.email);
      await page
        .getByLabel("Password", { exact: true })
        .fill("Browser-role-fixture-password-42");
      await page.getByRole("button", { name: "Sign in", exact: true }).click();
      await expect(
        page.getByRole("heading", { name: "Boards", exact: true }),
      ).toBeVisible();
      await expect(
        page.getByRole("button", {
          name: `Account menu for ${member.identity.user.name}`,
        }),
      ).toBeVisible();
      release();
      await settled;
      await page.evaluate(
        () =>
          new Promise<void>((resolve) =>
            requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
          ),
      );
      await expect(
        page.getByRole("button", { name: /^Notifications(?:, \d+ unread)?$/ }),
      ).toHaveAccessibleName("Notifications");
      await expect(
        page.locator(toastSelector).filter({ hasText: failure }),
      ).toHaveCount(0);
    } finally {
      release();
    }
  });

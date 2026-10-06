import { mkdir } from "node:fs/promises";
import { expect, request, test, type Page } from "@playwright/test";
import {
  authenticateBrowserFixture,
  browserBootstrap,
  getBrowserBootstrap,
  type BrowserFixtureSession,
} from "../browser-fixture.js";

function feedbackToast(page: Page, message: string) {
  return page
    .locator(
      '[data-slot="toast"]:not([data-exiting="true"]):not([data-hidden="true"])',
    )
    .filter({ hasText: message })
    .last();
}

let fixture: BrowserFixtureSession;

test.beforeAll(async ({ baseURL }) => {
  const bootstrap = await getBrowserBootstrap(baseURL!);
  fixture = bootstrap;
  await bootstrap.api.dispose();
  const other = await request.newContext({
    baseURL,
    extraHTTPHeaders: { Origin: baseURL! },
  });
  try {
    const response = await other.post("/api/auth/login", {
      data: {
        email: browserBootstrap.email,
        password: browserBootstrap.password,
      },
    });
    expect(response.status()).toBe(200);
  } finally {
    await other.dispose();
  }
  await mkdir("tmp/sessions-table", { recursive: true });
});

for (const width of [1920, 1280, 390]) {
  for (const theme of ["light", "dark"]) {
    test(`sessions table at ${width}px in ${theme}`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
      await page.addInitScript(
        (value) => localStorage.setItem("mill:theme", value),
        theme,
      );
      await authenticateBrowserFixture(page, fixture);
      await page.goto("/settings/sessions");
      await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
      const table = page.getByRole("grid", {
        name: "Active browser sessions",
      });
      await expect(table).toBeVisible();
      const current = table
        .getByRole("row")
        .filter({ hasText: "This browser" });
      await expect(
        current.getByText("Current", { exact: true }).filter({ visible: true }),
      ).toBeVisible();
      await expect(
        current.getByRole("button", { name: "Revoke", exact: true }),
      ).toBeDisabled();
      await expect(
        table
          .getByText("Active", { exact: true })
          .filter({ visible: true })
          .first(),
      ).toBeVisible();
      if (width >= 768) {
        for (const name of [
          "Session",
          "Session ID",
          "Last active",
          "Expires",
          "Status",
          "Actions",
        ])
          await expect(
            table.getByRole("columnheader", { name, exact: true }),
          ).toBeVisible();
        await expect(current.locator("code:visible")).toHaveText(
          /^[a-f0-9]{8}$/,
        );
      } else {
        await expect(table.getByRole("columnheader")).toHaveCount(1);
        await expect(current.locator("time:visible").first()).toBeVisible();
        await expect(current.locator("time:visible").last()).toBeVisible();
      }
      await expect
        .poll(() =>
          page.evaluate(
            () => document.documentElement.scrollWidth <= innerWidth,
          ),
        )
        .toBe(true);
      const colors = await current
        .getByText("Current", { exact: true })
        .filter({ visible: true })
        .evaluate((element) => {
          const chip = element.closest('[data-slot="chip"]')!;
          const reference = document.createElement("span");
          reference.style.color = "var(--accent-soft-foreground)";
          document.body.append(reference);
          const accent = getComputedStyle(reference).color;
          reference.remove();
          return { color: getComputedStyle(chip).color, accent };
        });
      expect(colors.color).toBe(colors.accent);
      await page.screenshot({
        path: `tmp/sessions-table/${width}-${theme}.png`,
        fullPage: true,
      });
      if (width === 1280) {
        const action = current.getByRole("button", {
          name: "Revoke",
          exact: true,
        });
        await action.scrollIntoViewIfNeeded();
        await expect(action).toBeInViewport();
      }
      await page.goto("/settings/profile");
      await expect(
        page.getByRole("link", {
          name: "Edit Gravatar image (opens in a new tab)",
        }),
      ).toHaveAttribute("href", "https://gravatar.com/profile/avatars");
    });
  }
}

test("sessions loading and request failure announce status and retry without a false empty table", async ({
  page,
}) => {
  await authenticateBrowserFixture(page, fixture);
  let release: (() => void) | undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route("**/api/auth/sessions", async (route) => {
    await gate;
    await route.fulfill({
      status: 503,
      contentType: "application/json",
      body: JSON.stringify({ error: "Sessions temporarily unavailable" }),
    });
  });
  await page.goto("/settings/sessions");
  try {
    await expect(
      page.getByText("Loading sessions", { exact: true }),
    ).toBeAttached();
    await expect(
      page.getByText("No active sessions", { exact: true }),
    ).toHaveCount(0);
  } finally {
    release!();
  }
  const region = page.getByRole("region", { name: "Sessions", exact: true });
  await expect(
    feedbackToast(page, "Sessions temporarily unavailable"),
  ).toBeVisible();
  await expect(region.getByRole("alert")).toHaveCount(0);
  await page.unroute("**/api/auth/sessions");
  await region
    .getByRole("button", { name: "Retry sessions", exact: true })
    .click();
  await expect(region.getByText("This browser", { exact: true })).toBeVisible();
});

test("revoking a session requires confirmation, keeps the dialog open after an error toast and retries safely", async ({
  page,
}) => {
  await authenticateBrowserFixture(page, fixture);
  await page.goto("/settings/sessions");
  const region = page.getByRole("region", { name: "Sessions", exact: true });
  const before = (await (await page.request.get("/api/auth/sessions")).json())
    .items;
  const action = region
    .getByRole("button", { name: "Revoke", exact: true })
    .and(page.locator(":enabled"))
    .first();
  await action.click();
  const dialog = page.getByRole("dialog", { name: "Revoke this session?" });
  await dialog
    .getByRole("button", { name: "Keep session", exact: true })
    .click();
  expect(
    (await (await page.request.get("/api/auth/sessions")).json()).items,
  ).toHaveLength(before.length);
  await action.click();
  await page.route("**/api/auth/sessions/*", (route) =>
    route.fulfill({
      status: 503,
      contentType: "application/json",
      body: JSON.stringify({
        error: "Could not revoke this session. Try again.",
      }),
    }),
  );
  await dialog
    .getByRole("button", { name: "Revoke session", exact: true })
    .click();
  await expect(feedbackToast(page, "Could not revoke")).toBeVisible();
  await expect(dialog).toBeVisible();
  await page.unroute("**/api/auth/sessions/*");
  await dialog
    .getByRole("button", { name: "Revoke session", exact: true })
    .click();
  await expect(dialog).toHaveCount(0);
  await expect
    .poll(() => page.evaluate(() => !!document.activeElement?.closest("main")))
    .toBe(true);
  await expect(
    region.getByRole("button", { name: "Revoke", exact: true }),
  ).toHaveCount(before.length - 1);
  await expect(
    region
      .getByRole("row")
      .filter({ hasText: "This browser" })
      .getByRole("button", { name: "Revoke", exact: true }),
  ).toBeDisabled();
  expect((await page.request.get("/api/auth/me")).status()).toBe(200);
});

test("a lost committed revocation response reconciles against the server", async ({
  page,
  baseURL,
}) => {
  const other = await request.newContext({
    baseURL,
    extraHTTPHeaders: { Origin: baseURL! },
  });
  try {
    expect(
      (
        await other.post("/api/auth/login", {
          data: {
            email: browserBootstrap.email,
            password: browserBootstrap.password,
          },
        })
      ).status(),
    ).toBe(200);
    await authenticateBrowserFixture(page, fixture);
    await page.goto("/settings/sessions");
    const before = (await (await page.request.get("/api/auth/sessions")).json())
      .items;
    const region = page.getByRole("region", { name: "Sessions", exact: true });
    await region
      .getByRole("button", { name: "Revoke", exact: true })
      .and(page.locator(":enabled"))
      .first()
      .click();
    await page.route("**/api/auth/sessions/*", async (route) => {
      expect((await route.fetch()).status()).toBe(200);
      await route.abort("failed");
    });
    const dialog = page.getByRole("dialog", { name: "Revoke this session?" });
    await dialog
      .getByRole("button", { name: "Revoke session", exact: true })
      .click();
    await expect(dialog).toHaveCount(0);
    await expect(
      region.getByRole("button", { name: "Revoke", exact: true }),
    ).toHaveCount(before.length - 1);
    expect((await other.get("/api/auth/me")).status()).toBe(401);
    expect((await page.request.get("/api/auth/me")).status()).toBe(200);
  } finally {
    await other.dispose();
  }
});

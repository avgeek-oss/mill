import { randomBytes } from "node:crypto";
import { mkdir } from "node:fs/promises";
import {
  expect,
  test,
  type APIRequestContext,
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
test.beforeAll(async ({ baseURL }) => {
  await mkdir("tmp/toast-feedback", { recursive: true });
  const bootstrap = await getBrowserBootstrap(baseURL!);
  fixture = bootstrap;
  api = bootstrap.api;
  const response = await api.post("/api/boards", {
    data: {
      name: "Toast verification",
      prefix: `TF${randomBytes(3).toString("hex").toUpperCase()}`,
    },
  });
  expect(response.status()).toBe(201);
  boardId = (await response.json()).board.id;
});
test.afterAll(async () => {
  await api?.dispose();
});

function notification(page: Page, text?: string) {
  const notifications = page.locator(
    '[data-slot="toast"]:not([data-exiting="true"])',
  );
  return text ? notifications.filter({ hasText: text }) : notifications;
}

test("losing board access produces one toast and does not repeat feedback from hidden content", async ({
  page,
}) => {
  await authenticateBrowserFixture(page, fixture);
  await page.goto(`/boards/${boardId}`);
  await expect(
    page.getByRole("heading", { name: "Toast verification", exact: true }),
  ).toBeVisible();
  await page.route(`**/api/boards/${boardId}`, (route) =>
    route.fulfill({
      status: 403,
      json: { error: "Board access was revoked." },
    }),
  );
  await page
    .getByRole("searchbox", { name: "Search tasks", exact: true })
    .fill("access check");
  const failure =
    "You do not have access to this board. Ask an administrator or return to your boards.";
  await expect(
    page.getByRole("heading", { name: "Board access required", exact: true }),
  ).toBeVisible();
  await expect(notification(page)).toHaveCount(1);
  await expect(notification(page, failure)).toBeVisible();
  await expect(
    page.getByRole("main").getByText(failure, { exact: true }),
  ).toHaveCount(0);
  await dismiss(page, failure);
  await page.getByRole("button", { name: "Try again", exact: true }).click();
  await expect(notification(page)).toHaveCount(1);
  await expect(notification(page, failure)).toBeVisible();
});
async function dismiss(page: Page, text?: string) {
  const toast = notification(page, text);
  await toast.locator('[data-slot="toast-close"]').click();
  await expect(toast).toHaveCount(0);
}

for (const [width, theme] of [
  [1280, "light"],
  [1280, "dark"],
  [390, "light"],
  [390, "dark"],
] as const) {
  test(`signed-out validation and repeated server errors use only toasts at ${width}px in ${theme}`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.addInitScript(
      (value) => localStorage.setItem("avgeek-oss-ui-theme", value),
      theme,
    );
    await page.goto("/login");
    const email = page.getByLabel("Email", { exact: true });
    const password = page.getByLabel("Password", { exact: true });
    const submit = page.getByRole("button", { name: "Sign in", exact: true });
    let requests = 0;
    const failure = "Sign-in is temporarily unavailable.";
    await page.route("**/api/auth/login", (route) => {
      requests++;
      return route.fulfill({ status: 503, json: { error: failure } });
    });
    for (let attempt = 0; attempt < 2; attempt++) {
      await submit.click();
      await expect(notification(page)).toHaveCount(1);
      await expect(notification(page)).toContainText("Email");
      await expect(email).toBeFocused();
      expect(requests).toBe(0);
      await dismiss(page);
    }
    await email.fill("toast-sign-in@example.test");
    for (let attempt = 0; attempt < 2; attempt++) {
      await password.fill("Submitted-password-42");
      await submit.click();
      await expect(notification(page, failure)).toBeVisible();
      await expect
        .poll(() =>
          notification(page, failure).evaluate((element) => {
            const rect = element.getBoundingClientRect();
            return rect.top >= 0 && rect.bottom <= window.innerHeight - 8;
          }),
        )
        .toBe(true);
      await expect(
        page.locator("form").getByText(failure, { exact: true }),
      ).toHaveCount(0);
      await expect(page.locator("form").getByRole("alert")).toHaveCount(0);
      await expect(email).toHaveValue("toast-sign-in@example.test");
      await expect(password).toHaveValue("");
      await password.focus();
      await expect(notification(page, failure)).toHaveCount(1);
      await dismiss(page, failure);
    }
    expect(requests).toBe(2);
  });

  test(`board modal failure toasts remain usable above the dialog at ${width}px in ${theme}`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.addInitScript(
      (value) => localStorage.setItem("avgeek-oss-ui-theme", value),
      theme,
    );
    await authenticateBrowserFixture(page, fixture);
    await page.goto(`/boards/${boardId}`);
    await page
      .getByRole("button", { name: "Board actions", exact: true })
      .click();
    await page
      .getByRole("menuitem", { name: "Board settings", exact: true })
      .click();
    const dialog = page.getByRole("dialog", {
      name: "Board settings",
      exact: true,
    });
    const name = dialog.getByLabel("Board name", { exact: true });
    await name.fill("Preserved board draft");
    const failure = "Board save unavailable. Retry your changes.";
    let requests = 0;
    await page.route(`**/api/boards/${boardId}`, (route) => {
      if (route.request().method() !== "PATCH") return route.continue();
      requests++;
      return route.fulfill({ status: 503, json: { error: failure } });
    });
    for (let attempt = 0; attempt < 2; attempt++) {
      await dialog
        .getByRole("button", { name: "Save board", exact: true })
        .click();
      await expect(notification(page, failure)).toBeVisible();
      await expect(dialog.getByRole("alert")).toHaveCount(0);
      await expect(dialog.getByText(failure, { exact: true })).toHaveCount(0);
      await expect(name).toHaveValue("Preserved board draft");
      await expect
        .poll(() =>
          notification(page, failure).evaluate((element) => {
            const rect = element.getBoundingClientRect();
            return rect.top >= 0 && rect.bottom <= window.innerHeight - 8;
          }),
        )
        .toBe(true);
      if (attempt === 0)
        await page.screenshot({
          path: `tmp/toast-feedback/board-error-${width}-${theme}.png`,
          animations: "disabled",
        });
      await dismiss(page, failure);
    }
    expect(requests).toBe(2);
    await dialog
      .getByRole("button", { name: "Close dialog", exact: true })
      .click();
    await expect(dialog).toBeHidden();
    expect(
      (await (await api.get(`/api/boards/${boardId}`)).json()).board.name,
    ).toBe("Toast verification");
  });
}

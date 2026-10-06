import { randomBytes } from "node:crypto";
import { mkdir } from "node:fs/promises";
import {
  expect,
  test,
  type APIRequestContext,
  type Locator,
  type Page,
} from "@playwright/test";
import type { Task } from "../../packages/contracts/src/index.js";
import {
  authenticateBrowserFixture,
  getBrowserBootstrap,
  getBrowserRoleFixture,
  type BrowserFixtureSession,
} from "../browser-fixture.js";

let fixture: BrowserFixtureSession;
let api: APIRequestContext;
let boardId: string;

test.beforeAll(async ({ baseURL }) => {
  const bootstrap = await getBrowserBootstrap(baseURL!);
  fixture = bootstrap;
  api = bootstrap.api;
  const response = await api.post("/api/boards", {
    data: {
      name: "Start date verification",
      prefix: `DATE${randomBytes(3).toString("hex").toUpperCase()}`,
    },
  });
  expect(response.status()).toBe(201);
  boardId = (await response.json()).board.id;
  await mkdir("tmp/start-date", { recursive: true });
});

test.afterAll(async () => {
  await api?.dispose();
});

async function sourceTask(title: string): Promise<Task> {
  const response = await api.post(`/api/boards/${boardId}/tasks`, {
    data: {
      title,
      startDate: "2030-01-15",
      dueDate: "2030-01-31",
      priority: "high",
      status: "in_progress",
      type: "bug",
    },
  });
  expect(response.status()).toBe(201);
  return (await response.json()).task;
}

async function readTask(id: string): Promise<Task> {
  const response = await api.get(`/api/tasks/${id}`);
  expect(response.status()).toBe(200);
  return (await response.json()).task;
}

function dateField(page: Page, label: string) {
  return page.locator('[data-slot="date-picker"]').filter({
    has: page.getByText(label, { exact: true }),
  });
}

async function expectDate(
  field: Locator,
  month: number,
  day: number,
  year: number,
) {
  const segments = field.getByRole("spinbutton");
  await expect(segments).toHaveCount(3);
  await expect(segments.nth(0)).toHaveAttribute("aria-valuenow", String(month));
  await expect(segments.nth(1)).toHaveAttribute("aria-valuenow", String(day));
  await expect(segments.nth(2)).toHaveAttribute("aria-valuenow", String(year));
}

async function chooseJanuary16(page: Page) {
  await page
    .getByRole("button", { name: /^Choose start date(?: Start date)?$/ })
    .click();
  await page.getByRole("button", { name: /January 16, 2030/ }).click();
}

for (const width of [1280, 390])
  for (const theme of ["light", "dark"] as const) {
    test(`start date saves independently, retries and clears at ${width}px in ${theme}`, async ({
      browser,
    }) => {
      const task = await sourceTask(`Start date ${width} ${theme}`);
      const context = await browser.newContext({
        viewport: { width, height: 900 },
        isMobile: width === 390,
        hasTouch: width === 390,
        timezoneId: theme === "dark" ? "Pacific/Honolulu" : "Asia/Kolkata",
      });
      try {
        await context.addInitScript(
          (value) => localStorage.setItem("mill:theme", value),
          theme,
        );
        const page = await context.newPage();
        await authenticateBrowserFixture(page, fixture);
        await page.goto(`/boards/${boardId}/tasks/${task.id}`);
        const start = dateField(page, "Start date");
        const due = dateField(page, "Due date");
        await expectDate(start, 1, 15, 2030);
        await expectDate(due, 1, 31, 2030);
        await expect(
          start.getByRole("button", { name: /^Clear start date/ }),
        ).toBeVisible();
        const startBounds = (await start.boundingBox())!;
        const dueBounds = (await due.boundingBox())!;
        if (Math.abs(startBounds.y - dueBounds.y) < 2)
          expect(startBounds.x).toBeLessThan(dueBounds.x);
        else expect(startBounds.y).toBeLessThan(dueBounds.y);
        const writes: Record<string, unknown>[] = [];
        await page.route(`**/api/tasks/${task.id}`, async (route) => {
          if (route.request().method() !== "PATCH") return route.continue();
          const body = route.request().postDataJSON();
          expect(Object.keys(body).sort()).toEqual(["startDate", "version"]);
          writes.push(body);
          if (writes.length === 1)
            return route.fulfill({
              status: 503,
              json: { error: "Could not save the start date." },
            });
          return route.continue();
        });
        await chooseJanuary16(page);
        const error = page.locator("#task-startDate-error");
        await expect(
          page
            .locator('[data-slot="toast"]')
            .filter({ hasText: "Could not save the start date." }),
        ).toContainText("Could not save the start date.");
        await expectDate(start, 1, 16, 2030);
        expect(await readTask(task.id)).toEqual(task);
        const savedResponse = page.waitForResponse(
          (response) =>
            response.url().endsWith(`/api/tasks/${task.id}`) &&
            response.request().method() === "PATCH" &&
            response.status() === 200,
        );
        await error.getByRole("button", { name: "Retry", exact: true }).click();
        await savedResponse;
        await expect(error).toHaveCount(0);
        expect(writes).toHaveLength(2);
        expect(writes[0].startDate).toBe("2030-01-16");
        expect(writes[1].startDate).toBe("2030-01-16");
        const saved = await readTask(task.id);
        expect(saved).toMatchObject({
          startDate: "2030-01-16",
          dueDate: task.dueDate,
          priority: task.priority,
          type: task.type,
          status: task.status,
          identifier: task.identifier,
        });
        await page.reload();
        await expectDate(start, 1, 16, 2030);
        await expectDate(due, 1, 31, 2030);
        await page.screenshot({
          path: `tmp/start-date/task-${width}-${theme}.png`,
          fullPage: true,
          animations: "disabled",
        });
        const cleared = page.waitForResponse(
          (response) =>
            response.url().endsWith(`/api/tasks/${task.id}`) &&
            response.request().method() === "PATCH" &&
            response.status() === 200,
        );
        await start.getByRole("button", { name: /^Clear start date/ }).click();
        await cleared;
        await expect(
          page.locator('[data-slot="date-picker-popover"]'),
        ).toHaveCount(0);
        expect(writes).toHaveLength(3);
        expect(writes[2].startDate).toBeNull();
        expect(await readTask(task.id)).toMatchObject({
          startDate: null,
          dueDate: task.dueDate,
        });
        await page.reload();
        await expect(
          start.getByRole("button", { name: /^Clear start date/ }),
        ).toHaveCount(0);
        await expectDate(due, 1, 31, 2030);
      } finally {
        await context.close();
      }
    });
  }

test("Keep my change resolves a start date conflict without overwriting a concurrent due date", async ({
  page,
}) => {
  const task = await sourceTask("Concurrent start and due dates");
  await authenticateBrowserFixture(page, fixture);
  await page.goto(`/boards/${boardId}/tasks/${task.id}`);
  const start = dateField(page, "Start date");
  const due = dateField(page, "Due date");
  await expectDate(start, 1, 15, 2030);
  let attempts = 0;
  await page.route(`**/api/tasks/${task.id}`, async (route) => {
    if (route.request().method() !== "PATCH") return route.continue();
    const body = route.request().postDataJSON();
    expect(Object.keys(body).sort()).toEqual(["startDate", "version"]);
    expect(body.startDate).toBe("2030-01-16");
    attempts++;
    if (attempts === 1) {
      const external = await api.patch(`/api/tasks/${task.id}`, {
        data: {
          version: task.version,
          startDate: "2030-01-17",
          dueDate: "2030-02-01",
        },
      });
      expect(external.status()).toBe(200);
    }
    await route.continue();
  });
  await chooseJanuary16(page);
  const error = page.locator("#task-startDate-error");
  await expect(
    page
      .locator('[data-slot="toast"]')
      .filter({ hasText: "changed elsewhere" }),
  ).toBeVisible();
  await expect(
    error.getByRole("button", { name: "Keep my change", exact: true }),
  ).toBeVisible();
  await expectDate(start, 1, 16, 2030);
  await expectDate(due, 2, 1, 2030);
  expect(await readTask(task.id)).toMatchObject({
    startDate: "2030-01-17",
    dueDate: "2030-02-01",
  });
  const saved = page.waitForResponse(
    (response) =>
      response.url().endsWith(`/api/tasks/${task.id}`) &&
      response.request().method() === "PATCH" &&
      response.status() === 200,
  );
  await error
    .getByRole("button", { name: "Keep my change", exact: true })
    .click();
  await saved;
  await expect(error).toHaveCount(0);
  expect(attempts).toBe(2);
  await page.reload();
  await expectDate(start, 1, 16, 2030);
  await expectDate(due, 2, 1, 2030);
  expect(await readTask(task.id)).toMatchObject({
    startDate: "2030-01-16",
    dueDate: "2030-02-01",
  });
});

test("Viewers can read start dates but cannot change or clear them", async ({
  page,
  baseURL,
}) => {
  const task = await sourceTask("Viewer start date");
  const viewer = await getBrowserRoleFixture(baseURL!, "viewer");
  try {
    await authenticateBrowserFixture(page, viewer);
    await page.goto(`/boards/${boardId}/tasks/${task.id}`);
    const start = dateField(page, "Start date");
    await expectDate(start, 1, 15, 2030);
    await expect(
      start.getByRole("button", { name: /^Choose start date/ }),
    ).toBeDisabled();
    await expect(
      start.getByRole("button", { name: /^Clear start date/ }),
    ).toHaveCount(0);
    for (const segment of await start.getByRole("spinbutton").all())
      await expect(segment).toBeDisabled();
    const denied = await viewer.api.patch(`/api/tasks/${task.id}`, {
      data: { version: task.version, startDate: "2030-01-16" },
    });
    expect(denied.status()).toBe(403);
    expect(await readTask(task.id)).toEqual(task);
  } finally {
    await viewer.api.dispose();
  }
});

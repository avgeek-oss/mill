import { randomBytes } from "node:crypto";
import { mkdir } from "node:fs/promises";
import {
  expect,
  test,
  type APIRequestContext,
  type Locator,
  type Page,
} from "@playwright/test";
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
      name: "Task type verification",
      prefix: `TYPE${randomBytes(3).toString("hex").toUpperCase()}`,
    },
  });
  expect(response.status()).toBe(201);
  boardId = (await response.json()).board.id;
  await mkdir("tmp/task-types", { recursive: true });
});

test.afterAll(async () => {
  await api?.dispose();
});

async function chooseType(page: Page, scope: Locator, name: "Task" | "Bug") {
  await scope.getByRole("button", { name: /Type$/ }).click();
  const option = page.getByRole("option", { name, exact: true });
  await expect(
    option.locator(
      name === "Bug" ? "svg.text-danger-soft-foreground" : "svg.text-accent",
    ),
  ).toBeVisible();
  await option.click();
  await expect(page.getByRole("listbox")).toBeHidden();
}

for (const width of [1280, 390])
  for (const theme of ["light", "dark"] as const) {
    test(`Task and Bug creation, retry, field saves and table icons at ${width}px in ${theme}`, async ({
      browser,
    }) => {
      const context = await browser.newContext({
        viewport: { width, height: 900 },
        isMobile: width === 390,
        hasTouch: width === 390,
      });
      try {
        await context.addInitScript(
          (value) => localStorage.setItem("mill:theme", value),
          theme,
        );
        const page = await context.newPage();
        await authenticateBrowserFixture(page, fixture);
        await page.goto(`/boards/${boardId}`);
        await page
          .getByRole("button", { name: "New task", exact: true })
          .click();
        const create = page.getByRole("dialog", {
          name: "New task",
          exact: true,
        });
        await expect(
          create
            .getByRole("button", { name: /Type$/ })
            .filter({ hasText: "Task" }),
        ).toBeVisible();
        const title = `Bug reproduction ${width} ${theme}`;
        await create.getByLabel("Title", { exact: true }).fill(title);
        await chooseType(page, create, "Bug");
        const creationRequests: { type: string; key: string | undefined }[] =
          [];
        await page.route(`**/api/boards/${boardId}/tasks`, async (route) => {
          if (route.request().method() !== "POST") return route.continue();
          creationRequests.push({
            type: route.request().postDataJSON().type,
            key: route.request().headers()["idempotency-key"],
          });
          if (creationRequests.length === 1)
            return route.fulfill({
              status: 503,
              json: { error: "Task creation is temporarily unavailable." },
            });
          return route.continue();
        });
        await create
          .getByRole("button", { name: "Create task", exact: true })
          .click();
        await expect(
          page
            .locator('[data-slot="toast"]')
            .filter({ hasText: "Task creation is temporarily unavailable." }),
        ).toBeVisible();
        await expect(
          create
            .getByRole("button", { name: /Type$/ })
            .filter({ hasText: "Bug" }),
        ).toBeVisible();
        await expect(create.getByLabel("Title", { exact: true })).toHaveValue(
          title,
        );
        const created = page.waitForResponse(
          (response) =>
            response.url().endsWith(`/api/boards/${boardId}/tasks`) &&
            response.request().method() === "POST" &&
            response.status() === 201,
        );
        await create
          .getByRole("button", { name: "Create task", exact: true })
          .click();
        const task = (await (await created).json()).task;
        expect(task.type).toBe("bug");
        expect(creationRequests).toHaveLength(2);
        expect(creationRequests[0].key).toBeTruthy();
        expect(creationRequests[1]).toEqual(creationRequests[0]);
        await expect(page).toHaveURL(new RegExp(`/tasks/${task.id}$`));
        const properties = page.getByRole("complementary", {
          name: "Task properties",
        });
        await expect(
          properties
            .getByRole("button", { name: /Type$/ })
            .filter({ hasText: "Bug" }),
        ).toBeVisible();
        const propertyControls = properties.getByRole("button", {
          name: /(?:Type|Status)$/,
        });
        await expect(propertyControls.nth(0)).toHaveAccessibleName(/Type$/);
        await expect(propertyControls.nth(1)).toHaveAccessibleName(/Status$/);
        await page.reload();
        await expect(
          properties
            .getByRole("button", { name: /Type$/ })
            .filter({ hasText: "Bug" }),
        ).toBeVisible();
        await page.screenshot({
          path: `tmp/task-types/task-${width}-${theme}.png`,
          fullPage: true,
        });

        let changes = 0;
        await page.route(`**/api/tasks/${task.id}`, async (route) => {
          if (route.request().method() !== "PATCH") return route.continue();
          const body = route.request().postDataJSON();
          expect(body.type).toBe("task");
          expect(Object.keys(body).sort()).toEqual(["type", "version"]);
          changes++;
          if (changes === 1)
            return route.fulfill({
              status: 503,
              json: { error: "Could not save the task type." },
            });
          return route.continue();
        });
        await chooseType(page, properties, "Task");
        const error = page.locator("#task-type-error");
        await expect(
          page
            .locator('[data-slot="toast"]')
            .filter({ hasText: "Could not save the task type." }),
        ).toContainText("Could not save");
        await expect(
          properties
            .getByRole("button", { name: /Type$/ })
            .filter({ hasText: "Task" }),
        ).toBeVisible();
        expect(
          (await (await api.get(`/api/tasks/${task.id}`)).json()).task.type,
        ).toBe("bug");
        await error.getByRole("button", { name: "Retry", exact: true }).click();
        await expect(error).toHaveCount(0);
        expect(changes).toBe(2);
        await page.reload();
        await expect(
          properties
            .getByRole("button", { name: /Type$/ })
            .filter({ hasText: "Task" }),
        ).toBeVisible();
        const saved = (await (await api.get(`/api/tasks/${task.id}`)).json())
          .task;
        expect(saved.type).toBe("task");
        expect(saved.identifier).toBe(task.identifier);

        await page
          .getByRole("button", { name: "Back to board", exact: true })
          .click();
        const row = page.locator(`[data-key="${task.id}"]`);
        const icon = row.getByRole("img", { name: "Task", exact: true });
        await expect(icon).toBeVisible();
        await expect(icon.locator("svg")).toHaveClass(/text-accent/);
        const idText =
          width < 640
            ? row
                .locator("[data-slot=table-cell-description]")
                .getByText(task.identifier, { exact: true })
            : row.getByRole("link", { name: task.identifier, exact: true });
        await expect(idText).toContainText(task.identifier);
        const identifierFits = await idText.evaluate((element) => {
          const bounds = element.getBoundingClientRect();
          const text = document.createRange();
          text.selectNodeContents(element);
          const textBounds = text.getBoundingClientRect();
          return (
            element.scrollWidth <= element.clientWidth &&
            textBounds.left >= bounds.left - 1 &&
            textBounds.right <= bounds.right + 1
          );
        });
        expect(identifierFits).toBe(true);
        const idLeft = (await idText.boundingBox())!.x;
        const iconBounds = (await icon.boundingBox())!;
        expect(iconBounds.x + iconBounds.width).toBeLessThan(idLeft);
        await page.screenshot({
          path: `tmp/task-types/table-${width}-${theme}.png`,
          fullPage: true,
        });

        await page
          .getByRole("button", { name: "New task", exact: true })
          .click();
        await expect(
          create
            .getByRole("button", { name: /Type$/ })
            .filter({ hasText: "Task" }),
        ).toBeVisible();
        await expect(create.getByLabel("Title", { exact: true })).toHaveValue(
          "",
        );
        await create
          .getByRole("button", { name: "Cancel", exact: true })
          .click();
        const bug = await api.post(`/api/boards/${boardId}/tasks`, {
          data: { title: `Existing bug ${width} ${theme}`, type: "bug" },
        });
        expect(bug.status()).toBe(201);
        const bugTask = (await bug.json()).task;
        await page.reload();
        const bugIcon = page
          .locator(`[data-key="${bugTask.id}"]`)
          .getByRole("img", { name: "Bug", exact: true });
        await expect(bugIcon).toBeVisible();
        await expect(bugIcon.locator("svg")).toHaveClass(
          /text-danger-soft-foreground/,
        );
      } finally {
        await context.close();
      }
    });
  }

test("a task type save preserves a concurrent priority update", async ({
  page,
}) => {
  const response = await api.post(`/api/boards/${boardId}/tasks`, {
    data: { title: "Concurrent type update", priority: "low" },
  });
  expect(response.status()).toBe(201);
  const task = (await response.json()).task;
  await authenticateBrowserFixture(page, fixture);
  await page.goto(`/boards/${boardId}/tasks/${task.id}`);
  const properties = page.getByRole("complementary", {
    name: "Task properties",
  });
  await expect(
    properties
      .getByRole("button", { name: /Type$/ })
      .filter({ hasText: "Task" }),
  ).toBeVisible();
  let attempts = 0;
  await page.route(`**/api/tasks/${task.id}`, async (route) => {
    if (route.request().method() !== "PATCH") return route.continue();
    attempts++;
    const payload = route.request().postDataJSON();
    expect(payload.type).toBe("bug");
    expect(Object.keys(payload).sort()).toEqual(["type", "version"]);
    if (attempts === 1) {
      const external = await api.patch(`/api/tasks/${task.id}`, {
        data: { version: task.version, priority: "high" },
      });
      expect(external.status()).toBe(200);
    }
    await route.continue();
  });
  await chooseType(page, properties, "Bug");
  await expect
    .poll(
      async () =>
        (await (await api.get(`/api/tasks/${task.id}`)).json()).task.type,
    )
    .toBe("bug");
  expect(attempts).toBe(2);
  const saved = (await (await api.get(`/api/tasks/${task.id}`)).json()).task;
  expect(saved.priority).toBe("high");
  await expect(
    properties
      .getByRole("button", { name: /Priority$/ })
      .filter({ hasText: "High" }),
  ).toBeVisible();
  await expect(page.locator("#task-type-error")).toHaveCount(0);
  await page.reload();
  await expect(
    properties
      .getByRole("button", { name: /Type$/ })
      .filter({ hasText: "Bug" }),
  ).toBeVisible();
  await expect(
    properties
      .getByRole("button", { name: /Priority$/ })
      .filter({ hasText: "High" }),
  ).toBeVisible();
});

test("viewers can see task types but cannot change them or create tasks", async ({
  page,
  baseURL,
}) => {
  const response = await api.post(`/api/boards/${boardId}/tasks`, {
    data: { title: "Viewer bug details", type: "bug" },
  });
  expect(response.status()).toBe(201);
  const task = (await response.json()).task;
  const viewer = await getBrowserRoleFixture(baseURL!, "viewer");
  try {
    await authenticateBrowserFixture(page, viewer);
    await page.goto(`/boards/${boardId}/tasks/${task.id}`);
    await expect(
      page
        .getByRole("complementary", { name: "Task properties" })
        .getByRole("button", { name: /Type$/ })
        .filter({ hasText: "Bug" }),
    ).toBeDisabled();
    await page
      .getByRole("button", { name: "Back to board", exact: true })
      .click();
    await expect(
      page.getByRole("button", { name: "New task", exact: true }),
    ).toHaveCount(0);
    await expect(
      page
        .locator(`[data-key="${task.id}"]`)
        .getByRole("img", { name: "Bug", exact: true }),
    ).toBeVisible();
  } finally {
    await viewer.api.dispose();
  }
});

import { randomBytes } from "node:crypto";
import { mkdir } from "node:fs/promises";
import {
  expect,
  test,
  type APIRequestContext,
  type Page,
} from "@playwright/test";
import type {
  Activity,
  Comment,
  Task,
} from "../../packages/contracts/src/index.js";
import {
  authenticateBrowserFixture,
  getBrowserBootstrap,
  getBrowserRoleFixture,
  type BrowserFixtureSession,
} from "../browser-fixture.js";

type TaskDetail = { task: Task; comments: Comment[]; activity: Activity[] };
let fixture: BrowserFixtureSession;
let api: APIRequestContext;
let boardId: string;

test.beforeAll(async ({ baseURL }) => {
  const bootstrap = await getBrowserBootstrap(baseURL!);
  fixture = bootstrap;
  api = bootstrap.api;
  const response = await api.post("/api/boards", {
    data: {
      name: "Duplicate task verification",
      prefix: `COPY${randomBytes(3).toString("hex").toUpperCase()}`,
    },
  });
  expect(response.status()).toBe(201);
  boardId = (await response.json()).board.id;
  await mkdir("tmp/duplicate-task", { recursive: true });
});

test.afterAll(async () => {
  await api?.dispose();
});

async function detail(taskId: string): Promise<TaskDetail> {
  const response = await api.get(`/api/tasks/${taskId}`);
  expect(response.status()).toBe(200);
  return response.json();
}

async function sourceTask(
  title: string,
  type: Task["type"] = "bug",
  priority: Task["priority"] = "urgent",
) {
  const response = await api.post(`/api/boards/${boardId}/tasks`, {
    data: {
      title,
      description:
        "## Reproduction\n\nKeep **Markdown**, spacing, and newlines.\n",
      type,
      priority,
      status: "in_progress",
      assigneeId: fixture.identity.user.id,
      startDate: "2030-01-10",
      dueDate: "2030-01-15",
    },
  });
  expect(response.status()).toBe(201);
  const task = (await response.json()).task as Task;
  const comment = await api.post(`/api/tasks/${task.id}/comments`, {
    data: { body: "This discussion belongs only to the original." },
  });
  expect(comment.status()).toBe(201);
  const source = await detail(task.id);
  expect(source.comments).toHaveLength(1);
  expect(source.activity.length).toBeGreaterThan(1);
  return source;
}

async function openDuplicate(page: Page) {
  await page.getByRole("button", { name: "Task actions", exact: true }).click();
  const menu = page.getByRole("menu", { name: "Task actions" });
  await expect(menu.getByRole("menuitem")).toHaveText([
    "Copy link",
    "Duplicate task",
    "Delete task",
  ]);
  await menu
    .getByRole("menuitem", { name: "Duplicate task", exact: true })
    .click();
  const dialog = page.getByRole("dialog", {
    name: "Duplicate task",
    exact: true,
  });
  await expect(dialog).toBeVisible();
  return dialog;
}

function expectCopiedTask(task: Task, source: Task) {
  expect(task).toMatchObject({
    boardId: source.boardId,
    title: `[Copy] ${source.title}`,
    description: source.description,
    type: source.type,
    priority: source.priority,
    status: "backlog",
    assigneeId: null,
    startDate: null,
    dueDate: null,
    version: 1,
  });
  expect(task.id).not.toBe(source.id);
  expect(task.identifier).not.toBe(source.identifier);
}

for (const width of [1280, 390])
  for (const theme of ["light", "dark"] as const) {
    test(`duplicate previews, cancels and confirms at ${width}px in ${theme}`, async ({
      browser,
    }) => {
      const source = await sourceTask(
        `Original ${width} ${theme}`,
        theme === "dark" ? "bug" : "task",
        theme === "dark" ? "urgent" : "low",
      );
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
        const query = new URLSearchParams({
          q: "Original",
          assigneeId: fixture.identity.user.id,
          priority: source.task.priority,
          status: "in_progress",
          sort: "title",
          page: "2",
          limit: "10",
        }).toString();
        const sourcePath = `/boards/${boardId}/tasks/${source.task.id}?${query}`;
        await page.goto(sourcePath);
        await expect(
          page.getByRole("heading", { name: source.task.title, exact: true }),
        ).toBeVisible();
        const posts: Record<string, unknown>[] = [];
        await page.route(`**/api/boards/${boardId}/tasks`, async (route) => {
          if (route.request().method() === "POST")
            posts.push(route.request().postDataJSON());
          await route.continue();
        });
        let dialog = await openDuplicate(page);
        await expect(dialog.getByLabel("Title", { exact: true })).toHaveValue(
          `[Copy] ${source.task.title}`,
        );
        await expect(
          dialog.getByLabel("Description", { exact: true }),
        ).toHaveValue(source.task.description);
        await expect(
          dialog.getByRole("button", {
            name: theme === "dark" ? "Bug Type" : "Task Type",
          }),
        ).toBeVisible();
        await expect(
          dialog.getByRole("button", {
            name: theme === "dark" ? "Urgent Priority" : "Low Priority",
          }),
        ).toBeVisible();
        await expect(
          dialog.getByRole("button", { name: "Backlog Status" }),
        ).toBeVisible();
        await expect(
          dialog.getByRole("button", { name: "Unassigned Assignee" }),
        ).toBeVisible();
        expect(posts).toHaveLength(0);
        await page.screenshot({
          path: `tmp/duplicate-task/modal-${width}-${theme}.png`,
          fullPage: true,
          animations: "disabled",
        });
        await dialog
          .getByLabel("Title", { exact: true })
          .fill("Discarded duplicate draft");
        await dialog
          .getByLabel("Description", { exact: true })
          .fill("Discarded description");
        await dialog
          .getByRole("button", { name: "Cancel", exact: true })
          .click();
        await expect(dialog).toBeHidden();
        expect(posts).toHaveLength(0);
        await expect(page).toHaveURL(sourcePath);
        expect(await detail(source.task.id)).toEqual(source);

        dialog = await openDuplicate(page);
        await expect(dialog.getByLabel("Title", { exact: true })).toHaveValue(
          `[Copy] ${source.task.title}`,
        );
        await expect(
          dialog.getByLabel("Description", { exact: true }),
        ).toHaveValue(source.task.description);
        const created = page.waitForResponse(
          (response) =>
            response.url().endsWith(`/api/boards/${boardId}/tasks`) &&
            response.request().method() === "POST" &&
            response.status() === 201,
        );
        await dialog
          .getByRole("button", { name: "Create task", exact: true })
          .click();
        const task = (await (await created).json()).task as Task;
        expect(posts).toHaveLength(1);
        expect(posts[0]).toEqual({
          title: `[Copy] ${source.task.title}`,
          description: source.task.description,
          type: source.task.type,
          priority: source.task.priority,
          status: "backlog",
          assigneeId: null,
          startDate: null,
          dueDate: null,
        });
        expectCopiedTask(task, source.task);
        await expect(page).toHaveURL(
          `/boards/${boardId}/tasks/${task.id}?${query}`,
        );
        await page.reload();
        await expect(
          page.getByRole("heading", { name: task.title, exact: true }),
        ).toBeVisible();
        const properties = page.getByRole("complementary", {
          name: "Task properties",
        });
        await expect(
          properties.getByRole("button", { name: "Backlog Status" }),
        ).toBeVisible();
        await expect(
          properties.getByRole("button", { name: "Unassigned Assignee" }),
        ).toBeVisible();
        await expect(
          page.getByText("No comments yet.", { exact: true }),
        ).toBeVisible();
        const saved = await detail(task.id);
        expectCopiedTask(saved.task, source.task);
        expect(saved.comments).toEqual([]);
        expect(saved.activity).toHaveLength(1);
        expect(saved.activity[0]).toMatchObject({
          taskId: task.id,
          action: "task.created",
        });
        expect(await detail(source.task.id)).toEqual(source);
        await page.screenshot({
          path: `tmp/duplicate-task/task-${width}-${theme}.png`,
          fullPage: true,
          animations: "disabled",
        });
        await page
          .getByRole("button", { name: "Back to board", exact: true })
          .click();
        await expect(page).toHaveURL(`/boards/${boardId}?${query}`);
        await page
          .getByRole("button", { name: "New task", exact: true })
          .click();
        const fresh = page.getByRole("dialog", {
          name: "New task",
          exact: true,
        });
        await expect(fresh.getByLabel("Title", { exact: true })).toHaveValue(
          "",
        );
        await expect(
          fresh.getByLabel("Description", { exact: true }),
        ).toHaveValue("");
        await expect(
          fresh.getByRole("button", { name: "Task Type" }),
        ).toBeVisible();
        await expect(
          fresh.getByRole("button", { name: / (Status|Priority)$/ }),
        ).toHaveCount(0);
        await fresh
          .getByRole("button", { name: "Cancel", exact: true })
          .click();
        expect(posts).toHaveLength(1);
      } finally {
        await context.close();
      }
    });
  }

test("a committed duplicate retries with the same key after its response is lost", async ({
  page,
}) => {
  const source = await sourceTask("Lost duplicate response");
  await authenticateBrowserFixture(page, fixture);
  await page.goto(`/boards/${boardId}/tasks/${source.task.id}`);
  const attempts: {
    key: string | undefined;
    replayed: string | undefined;
    task: Task;
  }[] = [];
  await page.route(`**/api/boards/${boardId}/tasks`, async (route) => {
    if (route.request().method() !== "POST") return route.continue();
    const response = await route.fetch();
    expect(response.status()).toBe(201);
    attempts.push({
      key: route.request().headers()["idempotency-key"],
      replayed: response.headers()["idempotency-replayed"],
      task: (await response.json()).task,
    });
    if (attempts.length === 1) return route.abort("connectionfailed");
    await route.fulfill({ response });
  });
  const dialog = await openDuplicate(page);
  const submit = dialog.getByRole("button", {
    name: "Create task",
    exact: true,
  });
  await submit.click();
  await expect(
    page
      .locator('[data-slot="toast"]')
      .filter({ hasText: "could not be reached" }),
  ).toContainText("could not be reached");
  await expect(dialog.getByLabel("Title", { exact: true })).toHaveValue(
    `[Copy] ${source.task.title}`,
  );
  await expect(dialog.getByLabel("Description", { exact: true })).toHaveValue(
    source.task.description,
  );
  await expect(
    dialog.getByRole("button", { name: "Urgent Priority" }),
  ).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Bug Type" })).toBeVisible();
  await expect(
    dialog.getByRole("button", { name: "Backlog Status" }),
  ).toBeVisible();
  await expect(page).toHaveURL(`/boards/${boardId}/tasks/${source.task.id}`);
  await submit.click();
  await expect(
    page.getByRole("heading", {
      name: `[Copy] ${source.task.title}`,
      exact: true,
    }),
  ).toBeVisible();
  expect(attempts).toHaveLength(2);
  expect(attempts[0].key).toBeTruthy();
  expect(attempts[1].key).toBe(attempts[0].key);
  expect(attempts[1].replayed).toBe("true");
  expect(attempts[1].task.id).toBe(attempts[0].task.id);
  expectCopiedTask(attempts[1].task, source.task);
  const tasks = await api.get(
    `/api/boards/${boardId}/tasks?q=${encodeURIComponent(`[Copy] ${source.task.title}`)}`,
  );
  expect(tasks.status()).toBe(200);
  expect((await tasks.json()).items).toHaveLength(1);
  const saved = await detail(attempts[1].task.id);
  expect(saved.activity).toHaveLength(1);
  expect(saved.comments).toEqual([]);
  expect(await detail(source.task.id)).toEqual(source);
});

test("a member can shorten a fully copied maximum-length title before confirming", async ({
  page,
  baseURL,
}) => {
  const member = await getBrowserRoleFixture(baseURL!, "member");
  try {
    const source = await sourceTask(
      "Long original ".padEnd(300, "x"),
      "task",
      "none",
    );
    await authenticateBrowserFixture(page, member);
    await page.goto(`/boards/${boardId}/tasks/${source.task.id}`);
    let posts = 0;
    await page.route(`**/api/boards/${boardId}/tasks`, async (route) => {
      if (route.request().method() === "POST") posts++;
      await route.continue();
    });
    const dialog = await openDuplicate(page);
    const input = dialog.getByLabel("Title", { exact: true });
    await expect(input).toHaveValue(`[Copy] ${source.task.title}`);
    const submit = dialog.getByRole("button", {
      name: "Create task",
      exact: true,
    });
    await submit.click();
    await expect(
      page
        .locator('[data-slot="toast"]')
        .filter({ hasText: "Use 300 characters or fewer for the title." }),
    ).toContainText("Use 300 characters or fewer for the title.");
    expect(posts).toBe(0);
    const title = "[Copy] Shortened original";
    await input.fill(title);
    await dialog
      .getByLabel("Description", { exact: true })
      .fill("A revised description for the copy.");
    await submit.click();
    await expect(
      page.getByRole("heading", { name: title, exact: true }),
    ).toBeVisible();
    expect(posts).toBe(1);
    const copiedId = new URL(page.url()).pathname.split("/tasks/")[1];
    const copied = await detail(copiedId);
    expect(copied.task).toMatchObject({
      title,
      description: "A revised description for the copy.",
      type: "task",
      priority: "none",
      status: "backlog",
      assigneeId: null,
      startDate: null,
      dueDate: null,
    });
    expect(copied.comments).toEqual([]);
    expect(copied.activity).toHaveLength(1);
    expect(copied.activity[0].actorId).toBe(member.identity.user.id);
    expect(await detail(source.task.id)).toEqual(source);
  } finally {
    await member.api.dispose();
  }
});

test("a Viewer can copy the link but cannot duplicate a task", async ({
  page,
  baseURL,
}) => {
  const source = await sourceTask("Viewer duplicate restriction");
  const viewer = await getBrowserRoleFixture(baseURL!, "viewer");
  try {
    await authenticateBrowserFixture(page, viewer);
    await page.goto(`/boards/${boardId}/tasks/${source.task.id}`);
    await page
      .getByRole("button", { name: "Task actions", exact: true })
      .click();
    const menu = page.getByRole("menu", { name: "Task actions" });
    await expect(
      menu.getByRole("menuitem", { name: "Copy link", exact: true }),
    ).toBeVisible();
    await expect(
      menu.getByRole("menuitem", { name: "Duplicate task", exact: true }),
    ).toHaveCount(0);
    await expect(
      menu.getByRole("menuitem", { name: "Delete task", exact: true }),
    ).toHaveCount(0);
    await expect(
      page.getByRole("dialog", { name: "Duplicate task", exact: true }),
    ).toHaveCount(0);
    const denied = await viewer.api.post(`/api/boards/${boardId}/tasks`, {
      data: {
        title: `[Copy] ${source.task.title}`,
        type: source.task.type,
        priority: source.task.priority,
        status: "backlog",
      },
    });
    expect(denied.status()).toBe(403);
    expect(await detail(source.task.id)).toEqual(source);
  } finally {
    await viewer.api.dispose();
  }
});

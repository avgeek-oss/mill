import { randomBytes } from "node:crypto";
import { mkdir, readFile } from "node:fs/promises";
import { expect, test, type APIRequestContext } from "@playwright/test";
import postgres from "postgres";
import {
  authenticateBrowserFixture,
  getBrowserBootstrap,
  type BrowserFixtureSession,
} from "../browser-fixture.js";

let fixture: BrowserFixtureSession;
let api: APIRequestContext;
let boardId: string;
const taskTitles = {
  oldDone: "Completed two days ago, edited today",
  oldWontDo: "Declined two days ago, edited today",
  recentDone: "Completed an hour ago",
  recentWontDo: "Declined an hour ago",
  oldTodo: "Todo since two days ago",
  oldBacklog: "Backlog since two days ago",
};

test.beforeAll(async ({ baseURL }) => {
  const bootstrap = await getBrowserBootstrap(baseURL!);
  fixture = bootstrap;
  api = bootstrap.api;
  const boardResponse = await api.post("/api/boards", {
    data: {
      name: "Terminal status visibility",
      prefix: `TV${randomBytes(4).toString("hex").toUpperCase()}`,
    },
  });
  expect(boardResponse.status()).toBe(201);
  boardId = (await boardResponse.json()).board.id;
  const tasks: { id: string; ageHours: number }[] = [];
  for (const [title, status, ageHours] of [
    [taskTitles.oldDone, "done", 48],
    [taskTitles.oldWontDo, "wont_do", 48],
    [taskTitles.recentDone, "done", 1],
    [taskTitles.recentWontDo, "wont_do", 1],
    [taskTitles.oldTodo, "todo", 48],
    [taskTitles.oldBacklog, "backlog", 48],
  ] as const) {
    const response = await api.post(`/api/boards/${boardId}/tasks`, {
      data: { title, status },
    });
    expect(response.status()).toBe(201);
    tasks.push({ id: (await response.json()).task.id, ageHours });
  }
  if (!process.env.DATABASE_URL) process.loadEnvFile(".env");
  const metadata = JSON.parse(
    await readFile(`tmp/browser-${new URL(baseURL!).port}-schema.json`, "utf8"),
  ) as { schema: string; baseURL: string };
  expect(metadata.schema).toMatch(/^browser_[a-f0-9]{16}$/);
  expect(new URL(metadata.baseURL).origin).toBe(new URL(baseURL!).origin);
  const database = postgres(process.env.DATABASE_URL!, { max: 1 });
  try {
    for (const task of tasks) {
      const rows = await database.unsafe(
        `UPDATE "${metadata.schema}".tasks
         SET status_changed_at = now() - ($1::int * interval '1 hour'),
             updated_at = now()
         WHERE board_id = $2 AND id = $3 RETURNING id`,
        [task.ageHours, boardId, task.id],
      );
      expect(rows).toHaveLength(1);
    }
  } finally {
    await database.end();
  }
  await mkdir("tmp/terminal-status-evidence", { recursive: true });
});

test.afterAll(async () => {
  await api?.dispose();
});

for (const width of [1280, 390]) {
  test(`old terminal tasks require an explicit status filter at ${width}px`, async ({
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
      await page.goto(`/boards/${boardId}`);
      const table = page.getByRole("grid", { name: "Task list", exact: true });
      const expectDefaultTasks = async () => {
        await expect(
          page.getByText("1–4 of 4 tasks", { exact: true }),
        ).toBeVisible();
        await expect(table.getByRole("link")).toHaveCount(4);
        for (const title of [taskTitles.oldDone, taskTitles.oldWontDo])
          await expect(table.getByRole("link", { name: title })).toHaveCount(0);
        for (const title of [
          taskTitles.recentDone,
          taskTitles.recentWontDo,
          taskTitles.oldTodo,
          taskTitles.oldBacklog,
        ])
          await expect(table.getByRole("link", { name: title })).toBeVisible();
      };
      const selectStatus = async (name: string) => {
        if (width === 390)
          await page
            .getByRole("button", { name: "Filters", exact: true })
            .click();
        await page
          .getByRole("navigation", { name: "Filters navigation" })
          .getByRole("button", { name: /Status$/ })
          .click();
        await page.getByRole("option", { name, exact: true }).click();
        if (width === 390)
          await page
            .getByRole("dialog", { name: "Workspace navigation", exact: true })
            .getByRole("button", { name: "Close navigation", exact: true })
            .click();
      };
      await expectDefaultTasks();
      await page.screenshot({
        path: `tmp/terminal-status-evidence/default-${width}.png`,
      });
      for (const [label, status, titles] of [
        ["Done", "done", [taskTitles.oldDone, taskTitles.recentDone]],
        [
          "Won't Do",
          "wont_do",
          [taskTitles.oldWontDo, taskTitles.recentWontDo],
        ],
      ] as const) {
        await selectStatus(label);
        await expect(page).toHaveURL(new RegExp(`status=${status}`));
        await expect(
          page.getByText("1–2 of 2 tasks", { exact: true }),
        ).toBeVisible();
        await expect(table.getByRole("link")).toHaveCount(2);
        for (const title of titles)
          await expect(table.getByRole("link", { name: title })).toBeVisible();
        const filteredURL = page.url();
        await page.reload();
        await expect(page).toHaveURL(filteredURL);
        await expect(table.getByRole("link")).toHaveCount(2);
        for (const title of titles)
          await expect(table.getByRole("link", { name: title })).toBeVisible();
        await page.screenshot({
          path: `tmp/terminal-status-evidence/${status}-${width}.png`,
        });
      }
      await selectStatus("All status");
      await expect(page).toHaveURL(new RegExp(`/boards/${boardId}$`));
      await expectDefaultTasks();
      await page.reload();
      await expectDefaultTasks();
    } finally {
      await context.close();
    }
  });
}

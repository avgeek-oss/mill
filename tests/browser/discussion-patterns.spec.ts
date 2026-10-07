import { randomBytes, randomUUID } from "node:crypto";
import { expect, test, type APIRequestContext } from "@playwright/test";
import type {
  Activity,
  Comment,
  Task,
} from "../../packages/contracts/src/index.js";
import {
  authenticateBrowserFixture,
  getBrowserBootstrap,
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
      name: "Shared discussion patterns",
      prefix: `DS${randomBytes(3).toString("hex").toUpperCase()}`,
    },
  });
  expect(response.status()).toBe(201);
  boardId = (await response.json()).board.id;
});

test.afterAll(async () => {
  await api?.dispose();
});

async function createTask(title: string): Promise<Task> {
  const response = await api.post(`/api/boards/${boardId}/tasks`, {
    data: { title },
  });
  expect(response.status()).toBe(201);
  return (await response.json()).task;
}

for (const [width, theme] of [
  [1280, "light"],
  [390, "dark"],
] as const) {
  test(`shared history retries and independent cursor loading preserve comment drafts at ${width}px in ${theme}`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.addInitScript(
      (value) => localStorage.setItem("avgeek-oss-ui-theme", value),
      theme,
    );
    const task = await createTask(`History patterns ${width}`);
    const activity: Activity[] = [
      { type: "session", name: "Browser owner" },
      { type: "api-key", name: "REST owner" },
      { type: "oauth", name: "MCP owner" },
      { type: "unrecognized", name: "Historical owner" },
    ].map((source, index) => ({
      id: randomUUID(),
      taskId: task.id,
      boardId,
      actorId: fixture.identity.user.id,
      actorName: source.name,
      actorKind: "human",
      action: "task.updated",
      detail:
        index === 3
          ? {}
          : {
              connection: {
                type: source.type,
                requestId: "private-request-id",
              },
              secret: "private-detail-value",
            },
      createdAt: `2026-10-05T10:00:00.00000${4 - index}Z`,
    }));
    const comments: Comment[] = Array.from({ length: 3 }, (_, index) => ({
      id: randomUUID(),
      taskId: task.id,
      authorId: fixture.identity.user.id,
      authorKind: "human",
      authorName: fixture.identity.user.name,
      body: `History comment ${index}`,
      version: 1,
      createdAt: `2026-10-05T10:00:00.00000${4 - index}Z`,
      updatedAt: `2026-10-05T10:00:00.00000${4 - index}Z`,
    }));
    const commentCursors: (string | null)[] = [];
    const activityCursors: (string | null)[] = [];
    let failInitialActivity = true;
    let failMoreActivity = true;
    await page.route(`**/api/tasks/${task.id}/comments?*`, async (route) => {
      const cursor = new URL(route.request().url()).searchParams.get("cursor");
      commentCursors.push(cursor);
      return route.fulfill({
        json: cursor
          ? { items: comments.slice(2), hasMore: false, nextCursor: null }
          : {
              items: comments.slice(0, 2),
              hasMore: true,
              nextCursor: comments[1].id,
            },
      });
    });
    await page.route(`**/api/tasks/${task.id}/activity?*`, async (route) => {
      const cursor = new URL(route.request().url()).searchParams.get("cursor");
      activityCursors.push(cursor);
      if (failInitialActivity || (cursor && failMoreActivity)) {
        failInitialActivity = false;
        if (cursor) failMoreActivity = false;
        return route.fulfill({
          status: 503,
          json: { error: "History temporarily unavailable." },
        });
      }
      return route.fulfill({
        json: cursor
          ? { items: activity.slice(2), hasMore: false, nextCursor: null }
          : {
              items: activity.slice(0, 2),
              hasMore: true,
              nextCursor: activity[1].id,
            },
      });
    });
    await authenticateBrowserFixture(page, fixture);
    await page.goto(`/boards/${boardId}/tasks/${task.id}`);
    const draft = page.getByRole("combobox", { name: "Add a comment" });
    await draft.fill("Keep this independent comment draft");
    await page.getByRole("tab", { name: "Activity", exact: true }).click();
    const history = page.getByRole("tabpanel", {
      name: "Activity",
      exact: true,
    });
    const failureToast = page
      .locator('[data-slot="toast"]')
      .filter({ hasText: "History temporarily unavailable." });
    await expect(failureToast).toBeVisible();
    await expect(history.getByRole("alert")).toHaveCount(0);
    await failureToast.locator('[data-slot="toast-close"]').click();
    await expect(failureToast).toHaveCount(0);
    await expect(
      history.getByText("No task activity found", { exact: true }),
    ).toHaveCount(0);
    await history.getByRole("button", { name: "Retry", exact: true }).click();
    const table = history.getByRole("grid", {
      name: "Task activity",
      exact: true,
    });
    await expect(table.getByRole("row")).toHaveCount(3);
    await expect(
      table.getByRole("columnheader", { name: "Subject", exact: true }),
    ).toBeVisible();
    await expect(table).toContainText("Browser owner");
    await expect(table).toContainText("REST owner");
    await expect(table.getByText("· Browser", { exact: true })).toHaveCount(0);
    await expect(table.getByText("API key", { exact: true })).toHaveCount(0);
    await history
      .getByRole("button", { name: "Load earlier activity" })
      .click();
    const paginationFailureToast = page
      .locator('[data-slot="toast"]')
      .filter({ hasText: "History temporarily unavailable." });
    await expect(paginationFailureToast).toBeVisible();
    await expect(history.getByRole("alert")).toHaveCount(0);
    await paginationFailureToast.locator('[data-slot="toast-close"]').click();
    await expect(paginationFailureToast).toHaveCount(0);
    await expect(table.getByRole("row")).toHaveCount(3);
    await history.getByRole("button", { name: "Retry", exact: true }).click();
    await expect(history.getByRole("alert")).toHaveCount(0);
    await history
      .getByRole("button", { name: "Load earlier activity" })
      .click();
    await expect(table.getByRole("row")).toHaveCount(5);
    await expect(table).toContainText("MCP owner");
    await expect(table).toContainText("Historical owner");
    for (const secret of ["private-request-id", "private-detail-value"])
      await expect(history.getByText(secret, { exact: false })).toHaveCount(0);
    expect(activityCursors.filter(Boolean)).toEqual([
      activity[1].id,
      activity[1].id,
    ]);
    expect(commentCursors).toEqual([null]);
    await page.getByRole("tab", { name: /^Comments/ }).click();
    await expect(draft).toHaveValue("Keep this independent comment draft");
    await page.getByRole("button", { name: "Load more comments" }).click();
    await expect(
      page.getByRole("article", { name: /^Comment by/ }),
    ).toHaveCount(3);
    expect(commentCursors).toEqual([null, comments[1].id]);
    await expect(draft).toHaveValue("Keep this independent comment draft");
  });

  test(`native comment confirmation retains failed deletion for retry at ${width}px in ${theme}`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.addInitScript(
      (value) => localStorage.setItem("avgeek-oss-ui-theme", value),
      theme,
    );
    const task = await createTask(`Comment confirmation ${width}`);
    const response = await api.post(`/api/tasks/${task.id}/comments`, {
      data: { body: "A comment to delete through the shared modal" },
    });
    expect(response.status()).toBe(201);
    const comment = (await response.json()).comment as Comment;
    await authenticateBrowserFixture(page, fixture);
    await page.goto(`/boards/${boardId}/tasks/${task.id}`);
    let attempts = 0;
    const retryKeys: (string | undefined)[] = [];
    await page.route(`**/api/comments/${comment.id}`, async (route) => {
      if (route.request().method() !== "DELETE") return route.continue();
      attempts++;
      retryKeys.push(route.request().headers()["idempotency-key"]);
      if (attempts === 1)
        return route.fulfill({
          status: 503,
          json: { error: "Comment deletion unavailable." },
        });
      return route.continue();
    });
    await page.getByRole("article", { name: /^Comment by/ }).hover();
    await page
      .getByRole("button", {
        name: `Delete comment by ${fixture.identity.user.name}`,
      })
      .click();
    const confirmation = page.getByRole("dialog", {
      name: "Delete comment?",
      exact: true,
    });
    await confirmation
      .getByRole("button", { name: "Delete comment", exact: true })
      .click();
    const failureToast = page
      .locator('[data-slot="toast"]')
      .filter({ hasText: "Comment deletion unavailable." });
    await expect(failureToast).toBeVisible();
    await expect(confirmation).toBeVisible();
    await failureToast.locator('[data-slot="toast-close"]').click();
    await expect(failureToast).toHaveCount(0);
    await expect(confirmation.getByRole("alert")).toHaveCount(0);
    await expect(
      page.getByRole("article", { name: /^Comment by/ }),
    ).toHaveCount(1);
    await confirmation
      .getByRole("button", { name: "Delete comment", exact: true })
      .click();
    await expect(confirmation).toBeHidden();
    await expect(
      page.getByRole("article", { name: /^Comment by/ }),
    ).toHaveCount(0);
    expect(attempts).toBe(2);
    expect(retryKeys[0]).toBeTruthy();
    expect(retryKeys[1]).toBe(retryKeys[0]);
    const persisted = await api.get(`/api/tasks/${task.id}/comments`);
    expect(persisted.ok()).toBeTruthy();
    expect((await persisted.json()).items).toEqual([]);
  });
}

import { randomBytes } from "node:crypto";
import {
  expect,
  test,
  type APIRequestContext,
  type Page,
} from "@playwright/test";
import type { Task } from "../../packages/contracts/src/index.js";
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
      name: "Task feedback verification",
      prefix: `FB${randomBytes(3).toString("hex").toUpperCase()}`,
    },
  });
  expect(response.status()).toBe(201);
  boardId = (await response.json()).board.id;
});

test.afterAll(async () => {
  await api?.dispose();
});

async function sourceTask(title: string): Promise<Task> {
  const response = await api.post(`/api/boards/${boardId}/tasks`, {
    data: { title },
  });
  expect(response.status()).toBe(201);
  return (await response.json()).task;
}

function toastWithMessage(page: Page, message: string) {
  return page.locator('[data-slot="toast"]').filter({ hasText: message });
}

async function dismissToast(page: Page, message: string) {
  const toast = toastWithMessage(page, message);
  await expect(toast).toBeVisible();
  await toast.locator('[data-slot="toast-close"]').click();
  await expect(toast).toHaveCount(0);
}

for (const [width, theme] of [
  [1280, "light"],
  [390, "dark"],
] as const) {
  test(`task field failures toast once per attempt and retain recovery at ${width}px in ${theme}`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.addInitScript(
      (value) => localStorage.setItem("mill:theme", value),
      theme,
    );
    const task = await sourceTask(`Task feedback ${width} ${theme}`);
    await authenticateBrowserFixture(page, fixture);
    await page.goto(`/boards/${boardId}/tasks/${task.id}`);
    await page.getByRole("button", { name: "Edit task details" }).click();
    const edit = page.getByRole("dialog", { name: "Edit task", exact: true });
    const title = edit.getByLabel("Title", { exact: true });
    const failure = "Could not save your task title.";
    let attempts = 0;
    await page.route(`**/api/tasks/${task.id}`, async (route) => {
      if (route.request().method() !== "PATCH") return route.continue();
      attempts++;
      if (attempts <= 2)
        return route.fulfill({ status: 503, json: { error: failure } });
      return route.continue();
    });
    await title.fill("Retained task title draft");
    await expect(toastWithMessage(page, failure)).toBeVisible();
    await expect(edit.getByRole("alert")).toHaveCount(0);
    await expect(edit.getByText(failure, { exact: true })).toHaveCount(0);
    await expect(title).toHaveValue("Retained task title draft");
    await expect(title).toHaveAttribute("aria-invalid", "true");
    await expect(title).not.toHaveAttribute(
      "aria-describedby",
      "task-title-error",
    );
    await title.blur();
    await expect(toastWithMessage(page, failure)).toHaveCount(1);
    expect(attempts).toBe(1);
    await dismissToast(page, failure);
    await edit.getByRole("button", { name: "Retry", exact: true }).click();
    await expect(toastWithMessage(page, failure)).toBeVisible();
    expect(attempts).toBe(2);
    await expect(title).toHaveValue("Retained task title draft");
    await dismissToast(page, failure);
    await edit.getByRole("button", { name: "Retry", exact: true }).click();
    await expect(
      edit.getByRole("button", { name: "Retry", exact: true }),
    ).toHaveCount(0);
    await expect
      .poll(
        async () =>
          (await (await api.get(`/api/tasks/${task.id}`)).json()).task.title,
      )
      .toBe("Retained task title draft");
    await title.fill("");
    const validation = "Enter a task title.";
    await expect(toastWithMessage(page, validation)).toBeVisible();
    await dismissToast(page, validation);
    await edit.getByRole("button", { name: "Retry", exact: true }).click();
    await expect(toastWithMessage(page, validation)).toBeVisible();
    expect(attempts).toBe(3);
    await expect(title).toHaveValue("");
    await edit
      .getByRole("button", { name: "Use saved value", exact: true })
      .click();
    await expect(title).toHaveValue("Retained task title draft");
    await edit.getByRole("button", { name: "Close", exact: true }).click();
    await expect(edit).toBeHidden();
  });

  test(`comment failures, success and unsent-draft warnings use toasts at ${width}px in ${theme}`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.addInitScript(
      (value) => localStorage.setItem("mill:theme", value),
      theme,
    );
    const task = await sourceTask(`Comment feedback ${width} ${theme}`);
    await authenticateBrowserFixture(page, fixture);
    await page.goto(`/boards/${boardId}/tasks/${task.id}`);
    const comment = page.getByRole("combobox", { name: "Add a comment" });
    const send = page.getByRole("button", { name: "Send comment" });
    await expect(send).toBeDisabled();
    const failure = "Could not submit your comment.";
    let attempts = 0;
    await page.route(`**/api/tasks/${task.id}/comments`, async (route) => {
      if (route.request().method() !== "POST") return route.continue();
      attempts++;
      if (attempts <= 2)
        return route.fulfill({ status: 503, json: { error: failure } });
      return route.continue();
    });
    await comment.fill("Retained comment draft");
    await send.click();
    await expect(toastWithMessage(page, failure)).toBeVisible();
    await expect(comment).toHaveValue("Retained comment draft");
    await expect(page.locator("#main-content").getByRole("alert")).toHaveCount(
      0,
    );
    await expect(
      page.locator("#main-content").getByText(failure, { exact: true }),
    ).toHaveCount(0);
    await dismissToast(page, failure);
    await send.click();
    await expect(toastWithMessage(page, failure)).toBeVisible();
    expect(attempts).toBe(2);
    await dismissToast(page, failure);
    await send.click();
    await expect(toastWithMessage(page, "Comment added.")).toBeVisible();
    await expect(comment).toHaveValue("");
    await expect(
      page.getByRole("article", {
        name: `Comment by ${fixture.identity.user.name}`,
      }),
    ).toContainText("Retained comment draft");
    await dismissToast(page, "Comment added.");
    await comment.fill("Unsent draft to clear");
    await page
      .getByRole("button", { name: "Back to board", exact: true })
      .click();
    const warning =
      "You have an unsent comment. Submit it or clear the draft before leaving this task.";
    await expect(toastWithMessage(page, warning)).toBeVisible();
    await expect(page).toHaveURL(new RegExp(`/tasks/${task.id}$`));
    await expect(
      page.locator("#main-content").getByText(warning, { exact: true }),
    ).toHaveCount(0);
    await expect(comment).toHaveValue("Unsent draft to clear");
    await dismissToast(page, warning);
    await page
      .getByRole("button", { name: "Back to board", exact: true })
      .click();
    await expect(toastWithMessage(page, warning)).toBeVisible();
    await page
      .getByRole("button", { name: "Clear draft", exact: true })
      .click();
    await expect(comment).toHaveValue("");
    await page
      .getByRole("button", { name: "Back to board", exact: true })
      .click();
    await expect(page).toHaveURL(`/boards/${boardId}`);
  });
}

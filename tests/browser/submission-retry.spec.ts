import { randomBytes } from "node:crypto";
import {
  expect,
  test,
  type APIRequestContext,
  type Page,
} from "@playwright/test";

import { getBrowserBootstrap } from "../browser-fixture.js";
let boardId = "";
let taskId = "";
let sessionCookies: Awaited<
  ReturnType<APIRequestContext["storageState"]>
>["cookies"] = [];

test.beforeAll(async ({ baseURL }) => {
  const { api } = await getBrowserBootstrap(baseURL!);
  try {
    const response = await api.post("/api/boards", {
      headers: { Origin: baseURL! },
      data: {
        name: "Submission retry verification",
        prefix: `RTRY${randomBytes(3).toString("hex").toUpperCase()}`,
      },
    });
    expect(response.ok()).toBeTruthy();
    const board = (await response.json()).board;
    boardId = board.id;
    const detail = await api
      .get(`/api/boards/${boardId}`)
      .then((r) => r.json());
    const task = await api.post(`/api/boards/${boardId}/tasks`, {
      headers: { Origin: baseURL! },
      data: { title: "Comment retry fixture", columnId: detail.columns[0].id },
    });
    expect(task.ok()).toBeTruthy();
    taskId = (await task.json()).task.id;
    sessionCookies = (await api.storageState()).cookies;
  } finally {
    await api.dispose();
  }
});

async function open(page: Page, task = false) {
  await page.context().addCookies(sessionCookies);
  await page.goto(`/boards/${boardId}${task ? `/tasks/${taskId}` : ""}`);
  await expect(
    page.getByRole("heading", { name: "Submission retry verification" }),
  ).toBeVisible();
}

async function interruptFirstResponse(
  page: Page,
  path: string,
  failure: "connection" | "truncated" | "empty" = "connection",
  lostAttempts = 1,
) {
  const attempts: {
    key: string | undefined;
    replayed: string | undefined;
    body: Record<string, { id: string }>;
  }[] = [];
  await page.route(`**/api${path}`, async (route) => {
    if (route.request().method() !== "POST") return route.continue();
    const response = await route.fetch();
    expect(response.ok()).toBeTruthy();
    attempts.push({
      key: route.request().headers()["idempotency-key"],
      replayed: response.headers()["idempotency-replayed"],
      body: await response.json(),
    });
    if (attempts.length <= lostAttempts) {
      if (failure === "connection") return route.abort("connectionfailed");
      return route.fulfill({
        response,
        status: failure === "empty" ? 200 : response.status(),
        body: failure === "empty" ? "{}" : '{"comment":',
        headers: { ...response.headers(), "content-type": "application/json" },
      });
    }
    await route.fulfill({ response });
  });
  return attempts;
}

test("a committed board retries with the original key after a lost response", async ({
  page,
}) => {
  await open(page);
  const attempts = await interruptFirstResponse(page, "/boards");
  await page
    .getByRole("button", { name: "Create Project", exact: true })
    .click();
  const dialog = page.getByRole("dialog", { name: "Create a board" });
  const name = `Lost board response ${randomBytes(3).toString("hex")}`;
  await dialog.getByLabel("Board name", { exact: true }).fill(name);
  await dialog
    .getByLabel("Task prefix", { exact: true })
    .fill(`BR${randomBytes(3).toString("hex").toUpperCase()}`);
  await dialog
    .getByRole("button", { name: "Create board", exact: true })
    .click();
  await expect(dialog.getByRole("alert")).toContainText("could not be reached");
  await expect(dialog.getByLabel("Board name", { exact: true })).toHaveValue(
    name,
  );
  await dialog
    .getByRole("button", { name: "Create board", exact: true })
    .click();
  await expect(page.getByRole("heading", { name, exact: true })).toBeVisible();
  expect(attempts).toHaveLength(2);
  expect(attempts[0].key).toBeTruthy();
  expect(attempts[1].key).toBe(attempts[0].key);
  expect(attempts[1].replayed).toBe("true");
  expect(attempts[1].body.board.id).toBe(attempts[0].body.board.id);
  const boards = await page.request.get("/api/boards").then((r) => r.json());
  expect(
    boards.items.filter((b: { name: string }) => b.name === name),
  ).toHaveLength(1);
});

test("task retries reuse a committed operation and fresh submissions receive new keys", async ({
  page,
}) => {
  await open(page);
  const attempts = await interruptFirstResponse(
    page,
    `/boards/${boardId}/tasks`,
  );
  const title = `Lost task response ${randomBytes(3).toString("hex")}`;
  await page.getByRole("button", { name: "New task", exact: true }).click();
  await page.getByLabel("Title", { exact: true }).fill(title);
  await page.getByRole("button", { name: "Create task", exact: true }).click();
  await expect(page.getByRole("dialog").getByRole("alert")).toContainText(
    "could not be reached",
  );
  await expect(page.getByLabel("Title", { exact: true })).toHaveValue(title);
  await page.getByRole("button", { name: "Create task", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Save changes", exact: true }),
  ).toBeVisible();
  expect(attempts).toHaveLength(2);
  expect(attempts[1].key).toBe(attempts[0].key);
  expect(attempts[1].replayed).toBe("true");
  expect(attempts[1].body.task.id).toBe(attempts[0].body.task.id);
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Close", exact: true })
    .click();
  await page.getByRole("button", { name: "New task", exact: true }).click();
  await page.getByLabel("Title", { exact: true }).fill(title);
  await page.getByRole("button", { name: "Create task", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Save changes", exact: true }),
  ).toBeVisible();
  expect(attempts).toHaveLength(3);
  expect(attempts[2].key).not.toBe(attempts[0].key);
  expect(attempts[2].body.task.id).not.toBe(attempts[0].body.task.id);
  const tasks = await page.request
    .get(`/api/boards/${boardId}/tasks`)
    .then((r) => r.json());
  expect(
    tasks.items.filter((t: { title: string }) => t.title === title),
  ).toHaveLength(2);
});

test("changing a failed task draft starts a distinct operation", async ({
  page,
}) => {
  await open(page);
  const attempts = await interruptFirstResponse(
    page,
    `/boards/${boardId}/tasks`,
  );
  const title = `Changed draft ${randomBytes(3).toString("hex")}`;
  await page.getByRole("button", { name: "New task", exact: true }).click();
  await page.getByLabel("Title", { exact: true }).fill(title);
  await page.getByRole("button", { name: "Create task", exact: true }).click();
  await expect(page.getByRole("dialog").getByRole("alert")).toContainText(
    "could not be reached",
  );
  await page.getByLabel("Title", { exact: true }).fill(`${title} revised`);
  await page.getByRole("button", { name: "Create task", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Save changes", exact: true }),
  ).toBeVisible();
  expect(attempts).toHaveLength(2);
  expect(attempts[1].key).not.toBe(attempts[0].key);
  expect(attempts[1].replayed).toBeUndefined();
  expect(attempts[1].body.task.id).not.toBe(attempts[0].body.task.id);
  const tasks = await page.request
    .get(`/api/boards/${boardId}/tasks`)
    .then((r) => r.json());
  expect(
    tasks.items.filter(
      (t: { title: string }) =>
        t.title === title || t.title === `${title} revised`,
    ),
  ).toHaveLength(2);
});

test("reverting an unresolved draft reuses its original committed operation", async ({
  page,
}) => {
  await open(page);
  const attempts = await interruptFirstResponse(
    page,
    `/boards/${boardId}/tasks`,
    "connection",
    2,
  );
  const title = `Reverted draft ${randomBytes(3).toString("hex")}`;
  await page.getByRole("button", { name: "New task", exact: true }).click();
  const input = page.getByLabel("Title", { exact: true });
  const submit = page.getByRole("button", { name: "Create task", exact: true });
  await input.fill(title);
  await submit.click();
  await expect(page.getByRole("dialog").getByRole("alert")).toContainText(
    "could not be reached",
  );
  await input.fill(`${title} changed`);
  await submit.click();
  await expect(submit).toBeEnabled();
  await expect(page.getByRole("dialog").getByRole("alert")).toContainText(
    "could not be reached",
  );
  await input.fill(title);
  await submit.click();
  await expect(
    page.getByRole("button", { name: "Save changes", exact: true }),
  ).toBeVisible();
  expect(attempts).toHaveLength(3);
  expect(attempts[1].key).not.toBe(attempts[0].key);
  expect(attempts[2].key).toBe(attempts[0].key);
  expect(attempts[2].replayed).toBe("true");
  expect(attempts[2].body.task.id).toBe(attempts[0].body.task.id);
  const tasks = await page.request
    .get(`/api/boards/${boardId}/tasks`)
    .then((r) => r.json());
  expect(
    tasks.items.filter((task: { title: string }) => task.title === title),
  ).toHaveLength(1);
  expect(
    tasks.items.filter(
      (task: { title: string }) => task.title === `${title} changed`,
    ),
  ).toHaveLength(1);
});

for (const failure of ["connection", "truncated", "empty"] as const) {
  test(`a committed comment survives a ${failure} response and resets its key after acknowledgement`, async ({
    page,
  }) => {
    await open(page, true);
    const attempts = await interruptFirstResponse(
      page,
      `/tasks/${taskId}/comments`,
      failure,
    );
    const text = `Comment ${failure} response ${randomBytes(3).toString("hex")}`;
    const input = page.getByLabel("Add a comment", { exact: true });
    const submit = page.getByRole("button", { name: "Comment", exact: true });
    await input.fill(text);
    await submit.click();
    await expect(page.getByRole("dialog").getByRole("alert")).toContainText(
      failure === "connection"
        ? "could not be reached"
        : failure === "empty"
          ? "response was incomplete"
          : "response could not be read",
    );
    await expect(input).toHaveValue(text);
    await submit.click();
    await expect(input).toHaveValue("");
    expect(attempts).toHaveLength(2);
    expect(attempts[1].key).toBe(attempts[0].key);
    expect(attempts[1].replayed).toBe("true");
    expect(attempts[1].body.comment.id).toBe(attempts[0].body.comment.id);
    let comments = await page.request
      .get(`/api/tasks/${taskId}/comments`)
      .then((r) => r.json());
    expect(
      comments.items.filter((c: { body: string }) => c.body === text),
    ).toHaveLength(1);
    await input.fill(text);
    await submit.click();
    await expect(input).toHaveValue("");
    expect(attempts).toHaveLength(3);
    expect(attempts[2].key).not.toBe(attempts[0].key);
    expect(attempts[2].body.comment.id).not.toBe(attempts[0].body.comment.id);
    comments = await page.request
      .get(`/api/tasks/${taskId}/comments`)
      .then((r) => r.json());
    expect(
      comments.items.filter((c: { body: string }) => c.body === text),
    ).toHaveLength(2);
  });
}

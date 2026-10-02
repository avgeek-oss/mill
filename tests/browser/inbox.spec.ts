import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import postgres from "postgres";
import {
  expect,
  test,
  request as requests,
  type APIRequestContext,
  type Page,
  type Request,
  type Response,
} from "@playwright/test";
import {
  authenticateBrowserFixture,
  getBrowserBootstrap,
  getBrowserRoleFixture,
  type BrowserFixtureSession,
} from "../browser-fixture.js";

test.describe.configure({ mode: "serial" });
test.use({ trace: "off", screenshot: "off" });
const password = "Inbox-only-password-42";
let origin = "";
let admin: APIRequestContext;
let database: ReturnType<typeof postgres>;
let adminId = "";
let boardId = "";
let boardPrefix = "";
type Account = {
  id: string;
  email: string;
  name: string;
  api: APIRequestContext;
  fixture?: BrowserFixtureSession;
};
const contexts: APIRequestContext[] = [];
const seededTasks: string[] = [];

async function json(
  context: APIRequestContext,
  path: string,
  body?: unknown,
  method = "POST",
) {
  const response = await context.fetch(`/api${path}`, {
    method: body === undefined ? "GET" : method,
    headers: { Origin: origin },
    data: body,
  });
  expect(response.ok(), `${path}: ${response.status()}`).toBeTruthy();
  return response.json();
}
async function account(
  name: string,
  role: "member" | "viewer" = "member",
  dedicated = false,
) {
  if (name !== "Private Inbox" && !dedicated) {
    const fixture = await getBrowserRoleFixture(origin, role);
    contexts.push(fixture.api);
    return {
      id: fixture.identity.user.id,
      email: fixture.identity.user.email,
      name,
      api: fixture.api,
      fixture,
    } as Account;
  }
  const email = `private-inbox-${randomUUID()}@example.test`;
  const invitation = await json(admin, "/auth/invitations", { email, role });
  const api = await requests.newContext({ baseURL: origin });
  contexts.push(api);
  const result = await json(api, "/auth/accept-invitation", {
    token: invitation.token,
    name,
    password,
  });
  const who: Account = { id: result.user.id, email, name, api };
  if (dedicated)
    who.fixture = {
      origin,
      identity: await json(api, "/auth/me"),
      storageState: await api.storageState(),
    };
  return who;
}
async function seed(
  who: Account,
  total: number,
  unread = total,
  title = "Review the next step",
) {
  const [number] =
    await database`UPDATE boards SET next_number=next_number+1 WHERE id=${boardId} RETURNING next_number-1 AS number`;
  const [task] =
    await database`INSERT INTO tasks(board_id,status,identifier,title,created_by,assignee_id) VALUES(${boardId},'backlog',${`${boardPrefix}-${number.number}`},${title},${adminId},${who.id}) RETURNING id,identifier`;
  seededTasks.push(task.id);
  await database`INSERT INTO notifications(user_id,task_id,kind,actor_name,created_at,read_at) SELECT ${who.id},${task.id},'mention',${who.name}||' teammate '||sequence,timestamptz '2026-01-01T00:00:00Z'+sequence*interval '1 millisecond',CASE WHEN sequence>${unread} THEN now() ELSE NULL END FROM generate_series(1,${total}) sequence`;
  const items =
    await database`SELECT id,actor_name FROM notifications WHERE user_id=${who.id} ORDER BY created_at DESC,id DESC`;
  return { task, items };
}
async function login(page: Page, who: Account) {
  if (who.fixture) {
    await authenticateBrowserFixture(page, who.fixture);
  } else {
    await page.goto("/");
    await page.getByLabel("Email", { exact: true }).fill(who.email);
    await page.getByLabel("Password", { exact: true }).fill(password);
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
  }
  await page.goto(`/boards/${boardId}`);
  await expect(
    page.getByRole("navigation", { name: "Workspace navigation" }),
  ).toBeVisible();
  await openNotifications(page);
}
async function openNotifications(page: Page) {
  await page
    .getByRole("button", { name: "Open notifications", exact: true })
    .click();
  await expect(inbox(page)).toBeVisible();
}
function inbox(page: Page) {
  return page.getByRole("dialog", { name: "Notifications", exact: true });
}
function taskPage(page: Page) {
  return page.locator(".task-page-layout");
}
function rows(page: Page) {
  return inbox(page).getByRole("listitem");
}
function row(page: Page, actor: string) {
  return rows(page).filter({
    has: page.getByRole("link", {
      name: new RegExp(`${actor} mentioned you`),
    }),
  });
}
async function settled(page: Page) {
  await page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      ),
  );
}

test.beforeAll(async ({ baseURL }) => {
  const bootstrap = await getBrowserBootstrap(baseURL!);
  origin = bootstrap.origin;
  admin = bootstrap.api;
  adminId = bootstrap.identity.user.id;
  if (!process.env.DATABASE_URL) process.loadEnvFile(".env");
  const metadata = JSON.parse(
    await readFile(`tmp/browser-${new URL(origin).port}-schema.json`, "utf8"),
  ) as { schema: string; baseURL: string };
  expect(metadata.schema).toMatch(/^browser_[a-f0-9]{16}$/);
  expect(new URL(metadata.baseURL).origin).toBe(origin);
  database = postgres(process.env.DATABASE_URL!, {
    max: 2,
    transform: postgres.camel,
    connection: { search_path: metadata.schema },
  });
  boardPrefix = `IB${randomUUID().replaceAll("-", "").slice(0, 8).toUpperCase()}`;
  const created = await json(admin, "/boards", {
    name: "Inbox verification",
    prefix: boardPrefix,
  });
  boardId = created.board.id;
  const detail = await json(admin, `/boards/${boardId}`);
  expect(Object.keys(detail)).toEqual(["board"]);
  expect(detail.board.id).toBe(boardId);
  expect(detail.board).not.toHaveProperty("position");
});
test.afterEach(async () => {
  if (seededTasks.length) {
    await database`DELETE FROM notifications WHERE task_id IN ${database(seededTasks)}`;
    await database`DELETE FROM tasks WHERE id IN ${database(seededTasks)} AND board_id=${boardId}`;
    seededTasks.length = 0;
  }
});
test.afterAll(async () => {
  await Promise.all(contexts.map((context) => context.dispose()));
  await admin?.dispose();
  await database?.end();
});

test("the single list reaches older notifications and marks refresh the durable count without affecting another person", async ({
  page,
}, testInfo) => {
  const who = await account("Older Inbox");
  const other = await account("Private Inbox");
  const taskTitle = "Review the next step";
  const { task } = await seed(who, 240, 120, taskTitle);
  await seed(other, 1);
  await login(page, who);
  await expect(rows(page)).toHaveCount(100);
  await expect(
    inbox(page).getByText("Private Inbox teammate 1", { exact: false }),
  ).toHaveCount(0);
  await expect(inbox(page).getByRole("tablist")).toHaveCount(0);
  await expect(inbox(page).getByText("Read", { exact: true })).toHaveCount(100);
  await expect(row(page, "Older Inbox teammate 1")).toHaveCount(0);
  await inbox(page)
    .getByRole("button", { name: "Load older notifications", exact: true })
    .click();
  await expect(rows(page)).toHaveCount(200);
  await inbox(page)
    .getByRole("button", { name: "Load older notifications", exact: true })
    .click();
  await expect(rows(page)).toHaveCount(240);
  const oldest = row(page, "Older Inbox teammate 1");
  await expect(oldest).toBeVisible();
  const link = oldest.getByRole("link");
  await expect(link).toHaveAttribute(
    "href",
    `/boards/${boardId}/tasks/${task.id}`,
  );
  expect(await oldest.locator("a button").count()).toBe(0);
  const expectedURL = `${origin}/boards/${boardId}/tasks/${task.id}`;
  const safeURL = (value: string) => {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:"
      ? `${url.origin}${url.pathname}`
      : `${url.protocol}${url.pathname}`;
  };
  const documents: { url: string; status: number }[] = [];
  const onResponse = (response: Response) => {
    if (
      documents.length < 10 &&
      response.request().isNavigationRequest() &&
      response.request().resourceType() === "document"
    )
      documents.push({
        url: safeURL(response.url()),
        status: response.status(),
      });
  };
  let marks = 0;
  const onRequest = (request: Request) => {
    if (
      request.method() === "PATCH" &&
      new URL(request.url()).pathname === "/api/notifications"
    )
      marks++;
  };
  page.context().on("response", onResponse);
  page.context().on("request", onRequest);
  const popupPromise = page.context().waitForEvent("page");
  let popup: Page | undefined;
  try {
    await link.click({ modifiers: ["ControlOrMeta"] });
    popup = await popupPromise;
    await popup.waitForURL(`**/boards/${boardId}/tasks/${task.id}`);
    await expect(popup).toHaveURL(expectedURL);
    await expect(taskPage(popup)).toBeVisible();
    await expect(
      taskPage(popup).getByRole("heading", { name: taskTitle }),
    ).toBeVisible();
    expect(page.context().pages()).toHaveLength(2);
    expect(marks).toBe(0);
    expect((await json(who.api, "/notifications")).unreadCount).toBe(120);
  } finally {
    page.context().off("response", onResponse);
    page.context().off("request", onRequest);
    const title = popup
      ? taskPage(popup).getByRole("heading", { name: taskTitle })
      : undefined;
    const titleVisible = (await title?.isVisible().catch(() => false)) ?? false;
    const titleMatches = titleVisible
      ? (await title?.textContent({ timeout: 1000 }).catch(() => null)) ===
        taskTitle
      : false;
    await testInfo.attach("notification-native-popup.json", {
      contentType: "application/json",
      body: JSON.stringify({
        expectedURL,
        popupURL: popup ? safeURL(popup.url()) : null,
        parentURL: safeURL(page.url()),
        contextPages: page
          .context()
          .pages()
          .map((contextPage) => ({
            url: safeURL(contextPage.url()),
            isParent: contextPage === page,
            isSelected: contextPage === popup,
          })),
        documents,
        taskTitleVisible: titleVisible,
        taskTitleMatches: titleMatches,
        markRequests: marks,
      }),
    });
    await popup?.close();
  }
  await expect(page).toHaveURL(new RegExp(`/boards/${boardId}$`));
  await expect(
    page.getByLabel("120 unread notifications", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByLabel("Open notifications", { exact: true }),
  ).toHaveAccessibleDescription("120 unread notifications");
  page.context().on("request", onRequest);
  await link.click();
  await expect(page).toHaveURL(expectedURL);
  await expect(taskPage(page)).toBeVisible();
  expect(marks).toBe(1);
  page.context().off("request", onRequest);
  await page.goBack();
  await openNotifications(page);
  await expect(rows(page)).toHaveCount(100);
  for (const count of [200, 240]) {
    await inbox(page)
      .getByRole("button", { name: "Load older notifications", exact: true })
      .click();
    await expect(rows(page)).toHaveCount(count);
  }
  await expect(rows(page)).toHaveCount(240);
  await expect(oldest.getByText("Read", { exact: true })).toBeVisible();
  await expect(
    page.getByLabel("119 unread notifications", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByLabel("Open notifications", { exact: true }),
  ).toHaveAccessibleDescription("119 unread notifications");
  const [marked] =
    await database`SELECT read_at FROM notifications WHERE user_id=${who.id} AND actor_name='Older Inbox teammate 1'`;
  expect(marked.readAt).not.toBeNull();
  await page
    .getByRole("button", { name: "Mark all read", exact: true })
    .click();
  await expect(inbox(page).getByText("Read", { exact: true })).toHaveCount(240);
  await expect(
    inbox(page).getByRole("button", { name: "Mark all read", exact: true }),
  ).toBeDisabled();
  await expect(inbox(page)).toBeFocused();
  await expect(
    page.getByLabel("119 unread notifications", { exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByLabel("Open notifications", { exact: true }),
  ).toHaveAccessibleDescription("");
  const [counts] =
    await database`SELECT count(*) FILTER (WHERE user_id=${who.id} AND read_at IS NULL)::int AS own,count(*) FILTER (WHERE user_id=${other.id} AND read_at IS NULL)::int AS other FROM notifications`;
  expect(counts).toMatchObject({ own: 0, other: 1 });
  await page.reload();
  await openNotifications(page);
  await expect(rows(page)).toHaveCount(100);
  await expect(inbox(page).getByText("Read", { exact: true })).toHaveCount(100);
  await expect(
    inbox(page).getByRole("button", { name: "Mark all read", exact: true }),
  ).toBeDisabled();
});

test("Viewer members and their personal API key preserve notification ownership", async ({
  page,
}) => {
  const who = await account("Viewer Inbox", "viewer");
  const fixture = await seed(who, 3);
  const other = await account("Other personal key notifications");
  const outside = await seed(other, 1);
  const credential = await json(who.api, "/credentials", {
    name: "Viewer Inbox personal key",
  });
  expect(credential.credential.userId).toBe(who.id);
  const read = await admin.get("/api/notifications?limit=100", {
    headers: { Authorization: `Bearer ${credential.token}` },
  });
  expect(read.status()).toBe(200);
  const notifications = await read.json();
  expect(notifications.unreadCount).toBe(3);
  expect(notifications.items.map((item: { id: string }) => item.id)).toEqual(
    fixture.items.map((item) => item.id),
  );
  const marked = await admin.patch("/api/notifications", {
    headers: { Origin: origin, Authorization: `Bearer ${credential.token}` },
    data: { ids: [fixture.items[0]!.id], read: true },
  });
  expect(marked.status()).toBe(200);
  expect(await marked.json()).toEqual({ ok: true, updated: 1 });
  const [ownRead] =
    await database`SELECT read_at FROM notifications WHERE id=${fixture.items[0]!.id}`;
  expect(ownRead.readAt).not.toBeNull();
  const denied = await admin.patch("/api/notifications", {
    headers: { Origin: origin, Authorization: `Bearer ${credential.token}` },
    data: { ids: [outside.items[0]!.id], read: true },
  });
  expect(denied.status()).toBe(403);
  const [unchanged] =
    await database`SELECT read_at FROM notifications WHERE id=${outside.items[0]!.id}`;
  expect(unchanged.readAt).toBeNull();
  await login(page, who);
  await expect(rows(page)).toHaveCount(3);
  const latest = row(page, "Viewer Inbox teammate 3");
  await inbox(page)
    .getByRole("button", { name: "Mark all read", exact: true })
    .click();
  await expect(inbox(page).getByText("Read", { exact: true })).toHaveCount(3);
  expect((await json(who.api, "/notifications")).unreadCount).toBe(0);
  expect((await json(other.api, "/notifications")).unreadCount).toBe(1);
  await latest.getByRole("link").click();
  await expect(page).toHaveURL(
    new RegExp(`/boards/${boardId}/tasks/${fixture.task.id}$`),
  );
  await expect(
    taskPage(page).getByRole("heading", { name: fixture.task.title }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Edit task details" }),
  ).toHaveCount(0);
});

test("opening an unread task marks its notification read and read links do not mark again", async ({
  page,
}) => {
  const who = await account("Opening Inbox");
  const fixture = await seed(who, 2);
  await login(page, who);
  await expect(rows(page)).toHaveCount(2);
  let marks = 0;
  page.on("request", (request) => {
    if (
      request.method() === "PATCH" &&
      new URL(request.url()).pathname === "/api/notifications"
    )
      marks++;
  });
  await row(page, "Opening Inbox teammate 2").getByRole("link").focus();
  await page.keyboard.down("Enter");
  try {
    await settled(page);
    expect((await json(who.api, "/notifications")).unreadCount).toBe(2);
    await expect(page).toHaveURL(new RegExp(`/boards/${boardId}$`));
    await expect(taskPage(page)).toHaveCount(0);
    await expect(
      row(page, "Opening Inbox teammate 2").getByText("Unread", {
        exact: true,
      }),
    ).toBeVisible();
    expect(marks).toBe(0);
  } finally {
    await page.keyboard.up("Enter");
  }
  await expect(page).toHaveURL(
    new RegExp(`/boards/${boardId}/tasks/${fixture.task.id}$`),
  );
  await expect(taskPage(page)).toBeVisible();
  await expect(
    page.getByLabel("1 unread notifications", { exact: true }),
  ).toBeVisible();
  expect(marks).toBe(1);
  const [marked] =
    await database`SELECT read_at FROM notifications WHERE id=${fixture.items[0]!.id}`;
  expect(marked.readAt).not.toBeNull();
  await page.goBack();
  await expect(page).toHaveURL(new RegExp(`/boards/${boardId}$`));
  await openNotifications(page);
  await expect(rows(page)).toHaveCount(2);
  const read = row(page, "Opening Inbox teammate 2");
  await expect(read.getByText("Read", { exact: true })).toBeVisible();
  await read.getByRole("link").click();
  await expect(taskPage(page)).toBeVisible();
  await settled(page);
  expect(marks).toBe(1);
  await page.goto(`/boards/${boardId}`);
  await openNotifications(page);
  await expect(rows(page)).toHaveCount(2);
  await expect(row(page, "Opening Inbox teammate 1")).toBeVisible();
  expect((await json(who.api, "/notifications")).unreadCount).toBe(1);
  await row(page, "Opening Inbox teammate 1").getByRole("link").press("Enter");
  await expect(taskPage(page)).toBeVisible();
  expect((await json(who.api, "/notifications")).unreadCount).toBe(0);
  expect(marks).toBe(2);
});

test("failed task opening retains its row error and retries the original mark before navigating", async ({
  page,
}) => {
  const who = await account("Open retry Inbox");
  const fixture = await seed(who, 2);
  await login(page, who);
  await expect(rows(page)).toHaveCount(2);
  await page.route("**/api/notifications", (route) =>
    route.request().method() === "PATCH" ? route.abort() : route.continue(),
  );
  const latest = row(page, "Open retry Inbox teammate 2");
  await latest.getByRole("link").click();
  await expect(latest.getByRole("alert")).toContainText("could not be reached");
  await expect(page).toHaveURL(new RegExp(`/boards/${boardId}$`));
  await expect(taskPage(page)).toHaveCount(0);
  const [unchanged] =
    await database`SELECT read_at FROM notifications WHERE id=${fixture.items[0]!.id}`;
  expect(unchanged.readAt).toBeNull();
  await page.unroute("**/api/notifications");
  let release!: () => void;
  let started!: () => void;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  const requested = new Promise<void>((resolve) => {
    started = resolve;
  });
  let retries = 0;
  await page.route("**/api/notifications", async (route) => {
    if (route.request().method() !== "PATCH") return route.continue();
    retries++;
    started();
    await pending;
    await route.continue();
  });
  try {
    await latest
      .getByRole("button", { name: "Retry opening task", exact: true })
      .click();
    await requested;
    await expect(latest.getByRole("status")).toHaveText("Opening task…");
    await expect(page).toHaveURL(new RegExp(`/boards/${boardId}$`));
    await expect(taskPage(page)).toHaveCount(0);
    await expect(latest.getByRole("button")).toHaveCount(0);
    await expect(
      inbox(page).getByRole("button", { name: "Mark all read", exact: true }),
    ).toBeDisabled();
    await latest.getByRole("link").click();
    await settled(page);
    expect(retries).toBe(1);
  } finally {
    release();
    await page.unrouteAll({ behavior: "wait" });
  }
  await expect(page).toHaveURL(
    new RegExp(`/boards/${boardId}/tasks/${fixture.task.id}$`),
  );
  await expect(taskPage(page)).toBeVisible();
  await expect(
    page.getByLabel("1 unread notifications", { exact: true }),
  ).toBeVisible();
  const [marked] =
    await database`SELECT read_at FROM notifications WHERE id=${fixture.items[0]!.id}`;
  expect(marked.readAt).not.toBeNull();
});

test("pending task opening cannot navigate after dismissing and reopening the list or a change of person", async ({
  page,
}) => {
  const who = await account("Obsolete open Inbox");
  const other = await account("Other open Inbox", "viewer");
  const fixture = await seed(who, 2);
  await seed(other, 1);
  await login(page, who);
  await expect(rows(page)).toHaveCount(2);
  let release!: () => void;
  let started!: () => void;
  let pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  let requested = new Promise<void>((resolve) => {
    started = resolve;
  });
  await page.route("**/api/notifications", async (route) => {
    if (route.request().method() !== "PATCH") return route.continue();
    const response = await route.fetch();
    started();
    await pending;
    await route.fulfill({ response });
  });
  try {
    await row(page, "Obsolete open Inbox teammate 2").getByRole("link").click();
    await requested;
    await page.keyboard.press("Escape");
    await expect(inbox(page)).toHaveCount(0);
    await openNotifications(page);
    await expect(rows(page)).toHaveCount(2);
    await expect(
      row(page, "Obsolete open Inbox teammate 2").getByText("Read", {
        exact: true,
      }),
    ).toBeVisible();
  } finally {
    release();
    await page.unrouteAll({ behavior: "wait" });
  }
  await expect(
    row(page, "Obsolete open Inbox teammate 2").getByText("Read", {
      exact: true,
    }),
  ).toBeVisible();
  await expect(page).toHaveURL(new RegExp(`/boards/${boardId}$`));
  await expect(taskPage(page)).toHaveCount(0);
  pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  requested = new Promise<void>((resolve) => {
    started = resolve;
  });
  await page.route("**/api/notifications", async (route) => {
    if (route.request().method() !== "PATCH") return route.continue();
    const response = await route.fetch();
    started();
    await pending;
    await route.fulfill({ response }).catch(() => undefined);
  });
  try {
    await row(page, "Obsolete open Inbox teammate 1").getByRole("link").click();
    await requested;
    await login(page, other);
    await expect(rows(page)).toHaveCount(1);
  } finally {
    release();
    await page.unrouteAll({ behavior: "wait" });
  }
  await settled(page);
  await expect(page).toHaveURL(new RegExp(`/boards/${boardId}$`));
  await expect(taskPage(page)).toHaveCount(0);
  await expect(
    row(page, "Other open Inbox teammate 1").getByText("Unread", {
      exact: true,
    }),
  ).toBeVisible();
  const own = await json(who.api, "/notifications");
  const foreign = await json(other.api, "/notifications");
  expect(own.unreadCount).toBe(0);
  expect(foreign.unreadCount).toBe(1);
  expect(
    own.items.every((item: { readAt: string | null }) => item.readAt !== null),
  ).toBe(true);
  expect(fixture.items.length).toBe(2);
});

test("pending, pagination failure and mark failure retain their owning retry states", async ({
  page,
}) => {
  const who = await account("Recovery Inbox");
  await seed(who, 120);
  let release!: () => void;
  let started!: () => void;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  const requested = new Promise<void>((resolve) => {
    started = resolve;
  });
  let held = false;
  await page.route("**/api/notifications?**", async (route) => {
    const url = new URL(route.request().url());
    if (url.searchParams.get("limit") !== "100" || held)
      return route.continue();
    held = true;
    started();
    await pending;
    await route.continue();
  });
  try {
    await login(page, who);
    await requested;
    await expect(inbox(page).locator('[aria-busy="true"]')).toHaveCount(1);
    await expect(
      inbox(page).getByText("Loading notifications…", { exact: true }),
    ).toHaveCount(0);
    await expect(
      inbox(page).getByText("No notifications yet", { exact: true }),
    ).toHaveCount(0);
  } finally {
    release();
    await page.unrouteAll({ behavior: "wait" });
  }
  await expect(rows(page)).toHaveCount(100);
  await page.route("**/api/notifications?**", (route) =>
    new URL(route.request().url()).searchParams.has("cursor")
      ? route.abort()
      : route.continue(),
  );
  await inbox(page)
    .getByRole("button", { name: "Load older notifications", exact: true })
    .click();
  await expect(inbox(page).getByRole("alert")).toContainText(
    "could not be reached",
  );
  await expect(rows(page)).toHaveCount(100);
  await page.unroute("**/api/notifications?**");
  await inbox(page)
    .getByRole("button", { name: "Retry older notifications", exact: true })
    .click();
  await expect(rows(page)).toHaveCount(120);
  await page.route("**/api/notifications", (route) =>
    route.request().method() === "PATCH" ? route.abort() : route.continue(),
  );
  await inbox(page)
    .getByRole("button", { name: "Mark all read", exact: true })
    .click();
  await expect(inbox(page).getByRole("alert")).toContainText(
    "could not be reached",
  );
  const [unchanged] =
    await database`SELECT count(*)::int AS unread FROM notifications WHERE user_id=${who.id} AND read_at IS NULL`;
  expect(unchanged.unread).toBe(120);
  await page.unroute("**/api/notifications");
  let releaseMark!: () => void;
  let markStarted!: () => void;
  const markPending = new Promise<void>((resolve) => {
    releaseMark = resolve;
  });
  const markRequested = new Promise<void>((resolve) => {
    markStarted = resolve;
  });
  await page.route("**/api/notifications", async (route) => {
    if (route.request().method() !== "PATCH") return route.continue();
    markStarted();
    await markPending;
    await route.continue();
  });
  try {
    await inbox(page)
      .getByRole("button", { name: "Retry marking read", exact: true })
      .click();
    await markRequested;
    const marking = inbox(page).getByRole("button", {
      name: "Marking all read…",
      exact: true,
    });
    await expect(marking).toBeDisabled();
    await expect(marking).toHaveText("Marking all read…");
    await expect(page).toHaveURL(new RegExp(`/boards/${boardId}$`));
  } finally {
    releaseMark();
    await page.unrouteAll({ behavior: "wait" });
  }
  await expect(inbox(page).getByText("Read", { exact: true })).toHaveCount(120);
  expect((await json(who.api, "/notifications")).unreadCount).toBe(0);
  const unconfirmed = await seed(who, 1, 1, "Confirm the next notification");
  await page.keyboard.press("Escape");
  await openNotifications(page);
  await expect(rows(page)).toHaveCount(100);
  await page.route("**/api/notifications", async (route) => {
    if (route.request().method() !== "PATCH") return route.continue();
    const response = await route.fetch();
    expect(response.status()).toBe(200);
    await route.fulfill({ response, body: "{}" });
  });
  await inbox(page)
    .getByRole("button", { name: "Mark all read", exact: true })
    .click();
  await expect(inbox(page).getByRole("alert")).toContainText(
    "could not be confirmed",
  );
  const [committed] =
    await database`SELECT read_at FROM notifications WHERE user_id=${who.id} AND task_id=${unconfirmed.task.id}`;
  expect(committed.readAt).not.toBeNull();
  await page.unroute("**/api/notifications");
  await inbox(page)
    .getByRole("button", { name: "Retry marking read", exact: true })
    .click();
  await expect(inbox(page).getByRole("alert")).toHaveCount(0);
  await expect(
    inbox(page).getByRole("button", { name: "Mark all read", exact: true }),
  ).toBeDisabled();
  await page.route("**/api/notifications?**", (route) =>
    new URL(route.request().url()).searchParams.get("limit") === "100"
      ? route.abort()
      : route.continue(),
  );
  await page.reload();
  await openNotifications(page);
  await expect(
    inbox(page).getByText("Notifications could not be loaded", { exact: true }),
  ).toBeVisible();
  await expect(
    inbox(page).getByText("No notifications yet", { exact: true }),
  ).toHaveCount(0);
  await page.unroute("**/api/notifications?**");
  await inbox(page)
    .getByRole("button", { name: "Retry notifications", exact: true })
    .click();
  await expect(rows(page)).toHaveCount(100);
});

test("a delayed real continuation cannot replace or append to the reopened single list", async ({
  page,
}) => {
  const who = await account("Stale Inbox");
  await seed(who, 130, 120);
  await login(page, who);
  await expect(rows(page)).toHaveCount(100);
  let release!: () => void;
  let started!: () => void;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  const requested = new Promise<void>((resolve) => {
    started = resolve;
  });
  await page.route("**/api/notifications?**", async (route) => {
    const url = new URL(route.request().url());
    if (!url.searchParams.has("cursor")) return route.continue();
    const response = await route.fetch();
    started();
    await pending;
    await route.fulfill({ response });
  });
  try {
    await inbox(page)
      .getByRole("button", { name: "Load older notifications", exact: true })
      .click();
    await requested;
    await expect(
      inbox(page).getByRole("button", {
        name: "Load older notifications",
        exact: true,
      }),
    ).toBeDisabled();
    await expect(inbox(page)).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(inbox(page)).toHaveCount(0);
    await openNotifications(page);
    await expect(rows(page)).toHaveCount(100);
    await expect(row(page, "Stale Inbox teammate 130")).toBeVisible();
    const oldResponse = page.waitForResponse((response) =>
      new URL(response.url()).searchParams.has("cursor"),
    );
    release();
    await oldResponse;
    await settled(page);
    await expect(rows(page)).toHaveCount(100);
    await expect(row(page, "Stale Inbox teammate 1")).toHaveCount(0);
    await expect(inbox(page).getByRole("alert")).toHaveCount(0);
  } finally {
    release();
    await page.unrouteAll({ behavior: "wait" });
  }
});

test("notifications stay on the board with bounded wheel scrolling and keyboard dismissal", async ({
  page,
}) => {
  const who = await account("Popover navigation");
  await seed(who, 120);
  await login(page, who);
  await expect(rows(page)).toHaveCount(100);
  await expect(page).toHaveURL(new RegExp(`/boards/${boardId}$`));
  await expect(
    page.getByRole("link", { name: /^Inbox(?: \d+ unread notifications)?$/ }),
  ).toHaveCount(0);
  const trigger = page.getByRole("button", {
    name: "Open notifications",
    exact: true,
  });
  for (const width of [1440, 375]) {
    await page.setViewportSize({ width, height: width === 375 ? 844 : 1000 });
    await expect
      .poll(async () => (await trigger.boundingBox())?.height ?? 0)
      .toBe(32);
    await expect(trigger.locator("svg")).toHaveAttribute("width", "18");
    await expect(inbox(page).getByRole("tablist")).toHaveCount(0);
    const scroller = inbox(page).locator(
      '.scroll-shadow[data-orientation="vertical"]',
    );
    await expect
      .poll(async () => {
        const bounds = await inbox(page).boundingBox();
        return bounds ? bounds.x + bounds.width : Infinity;
      })
      .toBeLessThanOrEqual(width - 15);
    const bounds = await inbox(page).boundingBox();
    expect(bounds).not.toBeNull();
    expect(bounds!.x).toBeGreaterThanOrEqual(15);
    expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(width - 15);
    expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(
      width === 375 ? 833 : 989,
    );
    await scroller.hover();
    await page.mouse.wheel(0, 600);
    await expect
      .poll(() => scroller.evaluate((element) => element.scrollTop))
      .toBeGreaterThan(0);
    await expect(
      inbox(page).getByRole("heading", { name: "Notifications", exact: true }),
    ).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(inbox(page)).toHaveCount(0);
    await expect(trigger).toBeFocused();
    await expect(page).toHaveURL(new RegExp(`/boards/${boardId}$`));
    await trigger.press("Enter");
    await expect(inbox(page)).toBeVisible();
    await expect(rows(page)).toHaveCount(100);
    expect(
      await inbox(page).evaluate((element) =>
        element.contains(document.activeElement),
      ),
    ).toBe(true);
  }
  await page.mouse.click(12, 120);
  await expect(inbox(page)).toHaveCount(0);
  await expect(page).toHaveURL(new RegExp(`/boards/${boardId}$`));
});

test("dismissing a pending task opening keeps the acknowledged read without delayed navigation", async ({
  page,
}) => {
  const who = await account("Dismissed opening");
  const fixture = await seed(who, 1);
  await login(page, who);
  await expect(rows(page)).toHaveCount(1);
  let release!: () => void;
  let started!: () => void;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  const requested = new Promise<void>((resolve) => {
    started = resolve;
  });
  let marks = 0;
  await page.route("**/api/notifications", async (route) => {
    if (route.request().method() !== "PATCH") return route.continue();
    marks++;
    const response = await route.fetch();
    started();
    await pending;
    await route.fulfill({ response });
  });
  try {
    await row(page, "Dismissed opening teammate 1").getByRole("link").click();
    await requested;
    await page.keyboard.press("Escape");
    await expect(inbox(page)).toHaveCount(0);
    await expect(
      page.getByRole("button", { name: "Open notifications", exact: true }),
    ).toBeFocused();
  } finally {
    release();
    await page.unrouteAll({ behavior: "wait" });
  }
  await settled(page);
  await expect(page).toHaveURL(new RegExp(`/boards/${boardId}$`));
  await expect(taskPage(page)).toHaveCount(0);
  const [marked] =
    await database`SELECT read_at FROM notifications WHERE id=${fixture.items[0]!.id}`;
  expect(marked.readAt).not.toBeNull();
  await openNotifications(page);
  const read = row(page, "Dismissed opening teammate 1");
  await expect(read.getByText("Read", { exact: true })).toBeVisible();
  await read.getByRole("link").press("Enter");
  await expect(taskPage(page)).toBeVisible();
  await expect(page).toHaveURL(
    new RegExp(`/boards/${boardId}/tasks/${fixture.task.id}$`),
  );
  expect(marks).toBe(1);
});

test("notification popover full-row links fit desktop and phone in both themes", async ({
  page,
}) => {
  const who = await account("Layout Inbox", "member", true);
  const fixture = await seed(
    who,
    2,
    2,
    "Review the complete notification and its next step ".repeat(5),
  );
  await login(page, who);
  const trigger = page.getByRole("button", {
    name: "Open notifications",
    exact: true,
  });
  for (const width of [1440, 375, 390])
    for (const theme of ["light", "dark"]) {
      await page.setViewportSize({ width, height: width < 600 ? 844 : 1000 });
      await page.evaluate(
        (value) => localStorage.setItem("mill:theme", value),
        theme,
      );
      await page.reload();
      await openNotifications(page);
      await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
      await expect(rows(page)).toHaveCount(2);
      const headerAction = inbox(page).getByRole("button", {
        name: "Mark all read",
        exact: true,
      });
      await expect
        .poll(async () => (await headerAction.boundingBox())?.height ?? 0)
        .toBe(32);
      await expect(inbox(page).getByRole("tablist")).toHaveCount(0);
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth),
      ).toBeLessThanOrEqual(width + 1);
      const first = rows(page).first();
      const layout = await first.evaluate((element) => {
        const link = element.querySelector("a")!;
        const style = getComputedStyle(link);
        const title = element.querySelector("a p")!;
        const dot = link.firstElementChild!;
        const time = element.querySelector("time")!;
        const linkBounds = link.getBoundingClientRect();
        const titleBounds = title.getBoundingClientRect();
        const dotBounds = dot.getBoundingClientRect();
        const firstLineHeight = Number.parseFloat(
          getComputedStyle(title).lineHeight,
        );
        const timeBounds = time.getBoundingClientRect();
        return {
          top: style.paddingTop,
          bottom: style.paddingBottom,
          weight: getComputedStyle(title).fontWeight,
          titleSize: getComputedStyle(title).fontSize,
          dotFirstLineCenterOffset: Math.abs(
            dotBounds.y +
              dotBounds.height / 2 -
              (titleBounds.y + firstLineHeight / 2),
          ),
          linkHeight: linkBounds.height,
          linkCount: element.querySelectorAll("a").length,
          buttonCount: element.querySelectorAll("button").length,
          timeInside:
            timeBounds.x >= linkBounds.x &&
            timeBounds.x + timeBounds.width <= linkBounds.x + linkBounds.width,
          titleTimeOverlap:
            titleBounds.x < timeBounds.right &&
            titleBounds.right > timeBounds.x &&
            titleBounds.y < timeBounds.bottom &&
            titleBounds.bottom > timeBounds.y,
          contentFits: link.scrollWidth <= link.clientWidth,
          stateHidden:
            element.querySelector("a .sr-only")?.textContent?.trim() ===
            "Unread",
        };
      });
      expect(layout.top).toBe(layout.bottom);
      expect(layout.weight).toBe("500");
      expect(layout.titleSize).toBe("14px");
      expect(layout.dotFirstLineCenterOffset).toBeLessThanOrEqual(4);
      expect(layout.linkHeight).toBeGreaterThanOrEqual(44);
      expect(layout.linkCount).toBe(1);
      expect(layout.buttonCount).toBe(0);
      expect(layout.timeInside).toBe(true);
      expect(layout.titleTimeOverlap).toBe(false);
      expect(layout.contentFits).toBe(true);
      expect(layout.stateHidden).toBe(true);
      await page.screenshot({
        path: `tmp/notifications-preview/notifications-${width}-${theme}.png`,
        fullPage: true,
        animations: "disabled",
      });
    }
  await page.setViewportSize({ width: 375, height: 844 });
  await page.evaluate(() => localStorage.setItem("mill:theme", "light"));
  const listResponse = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === "/api/notifications" &&
      new URL(response.url()).searchParams.get("limit") === "100",
  );
  await page.reload();
  await openNotifications(page);
  expect((await listResponse).status()).toBe(200);
  await expect(rows(page)).toHaveCount(2);
  await inbox(page)
    .getByRole("button", { name: "Mark all read", exact: true })
    .click();
  await expect(rows(page)).toHaveCount(2);
  await expect(inbox(page).getByText("Read", { exact: true })).toHaveCount(2);
  await expect(
    inbox(page).getByRole("button", { name: "Mark all read", exact: true }),
  ).toBeDisabled();
  await expect(inbox(page).locator('[data-slot="widget"]')).toHaveCount(1);
  await expect(inbox(page)).toBeFocused();
  await database`DELETE FROM notifications WHERE user_id=${who.id} AND task_id=${fixture.task.id}`;
  await page.keyboard.press("Escape");
  await expect(inbox(page)).toHaveCount(0);
  await expect(trigger).toHaveAttribute("aria-expanded", "false");
  await expect(trigger).toBeFocused();
  await openNotifications(page);
  await expect(
    inbox(page).getByText("No notifications yet", { exact: true }),
  ).toBeVisible();
  await expect(rows(page)).toHaveCount(0);
  await expect(inbox(page)).toBeFocused();
  await page.screenshot({
    path: "tmp/notifications-preview/notifications-empty-375-light.png",
    fullPage: true,
    animations: "disabled",
  });
  await page.route("**/api/notifications?**", (route) =>
    new URL(route.request().url()).searchParams.get("limit") === "100"
      ? route.abort()
      : route.continue(),
  );
  await page.keyboard.press("Escape");
  await expect(inbox(page)).toHaveCount(0);
  await expect(trigger).toHaveAttribute("aria-expanded", "false");
  await expect(trigger).toBeFocused();
  await openNotifications(page);
  await expect(
    inbox(page).getByRole("heading", {
      name: "Notifications could not be loaded",
      exact: true,
    }),
  ).toBeVisible();
  await expect(inbox(page).locator('[data-slot="widget"]')).toHaveCount(1);
  await page.screenshot({
    path: "tmp/notifications-preview/notifications-error-375-light.png",
    fullPage: true,
    animations: "disabled",
  });
  await page.unroute("**/api/notifications?**");
});

test.describe("touch notifications", () => {
  test.use({ hasTouch: true, viewport: { width: 375, height: 844 } });

  test("touch targets retain the compact bell and durable single list in both themes", async ({
    page,
  }) => {
    const who = await account("Touch notifications", "member", true);
    await seed(who, 2);
    await authenticateBrowserFixture(page, who.fixture!);
    await page.goto(`/boards/${boardId}`);
    await expect(
      page.getByRole("heading", { name: "Inbox verification", exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Open navigation", exact: true }),
    ).toBeVisible();
    const touchMedia = await page.evaluate(() => ({
      coarse: matchMedia("(pointer: coarse)").matches,
      noHover: matchMedia("(hover: none)").matches,
      touchPoints: navigator.maxTouchPoints,
    }));
    expect(touchMedia.coarse).toBe(true);
    expect(touchMedia.noHover).toBe(true);
    expect(touchMedia.touchPoints).toBeGreaterThan(0);
    const trigger = page.getByRole("button", {
      name: "Open notifications",
      exact: true,
    });
    for (const theme of ["light", "dark"]) {
      await page.evaluate(
        (value) => localStorage.setItem("mill:theme", value),
        theme,
      );
      await page.reload();
      await trigger.tap();
      await expect(rows(page)).toHaveCount(2);
      await expect(inbox(page).getByRole("tablist")).toHaveCount(0);
      await expect(rows(page).getByRole("button")).toHaveCount(0);
      expect(
        (await rows(page).first().getByRole("link").boundingBox())!.height,
      ).toBeGreaterThanOrEqual(44);
      await expect
        .poll(async () => (await trigger.boundingBox())?.height ?? 0)
        .toBe(44);
      await expect(trigger.locator("svg")).toHaveAttribute("width", "18");
      const markAll = inbox(page).getByRole("button", {
        name: "Mark all read",
        exact: true,
      });
      await expect
        .poll(async () => (await markAll.boundingBox())?.height ?? 0)
        .toBe(44);
      await expect(trigger).toHaveAccessibleDescription(
        "2 unread notifications",
      );
      await page.keyboard.press("Escape");
      await expect(inbox(page)).toHaveCount(0);
      await expect(trigger).toBeFocused();
    }
    await trigger.tap();
    await inbox(page)
      .getByRole("button", { name: "Mark all read", exact: true })
      .tap();
    await expect(inbox(page).getByText("Read", { exact: true })).toHaveCount(2);
    expect((await json(who.api, "/notifications")).unreadCount).toBe(0);
    await expect(trigger).toHaveAccessibleDescription("");
  });
});

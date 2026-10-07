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
    .getByRole("button", { name: /^Notifications(?:, \d+ unread)?$/ })
    .click();
  await expect(inbox(page)).toBeVisible();
}
function inbox(page: Page) {
  return page.getByRole("dialog", { name: "Notifications", exact: true });
}
function taskPage(page: Page) {
  return page.getByRole("region", { name: "Task details", exact: true });
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

for (const [width, theme] of [
  [1280, "light"],
  [1280, "dark"],
  [390, "light"],
  [390, "dark"],
] as const) {
  test(`mark-all refresh preserves receipts and concurrent arrivals at ${width}px in ${theme}`, async ({
    page,
  }) => {
    const who = await account("Receipt snapshot", "member", true);
    const fixture = await seed(who, 120, 119);
    const originalId = fixture.items[0]!.id;
    await database`UPDATE notifications SET read_at=now()-interval '2 hours' WHERE id=${originalId}`;
    const [original] =
      await database`SELECT read_at FROM notifications WHERE id=${originalId}`;
    await page.setViewportSize({ width, height: 900 });
    await page.addInitScript(
      (value) => localStorage.setItem("avgeek-oss-ui-theme", value),
      theme,
    );
    await authenticateBrowserFixture(page, who.fixture!);
    await page.goto(`/boards/${boardId}`);
    await openNotifications(page);
    await expect(rows(page)).toHaveCount(100);
    expect((await json(who.api, "/notifications")).unreadCount).toBe(119);
    await inbox(page)
      .getByRole("button", { name: "Load older notifications", exact: true })
      .click();
    await expect(rows(page)).toHaveCount(120);
    let mutations = 0;
    let arrivalId = "";
    let releaseRefresh!: () => void;
    let refreshStarted!: () => void;
    const pendingRefresh = new Promise<void>((resolve) => {
      releaseRefresh = resolve;
    });
    const requestedRefresh = new Promise<void>((resolve) => {
      refreshStarted = resolve;
    });
    await page.route("**/api/notifications", async (route) => {
      if (route.request().method() !== "PATCH") return route.continue();
      mutations++;
      const response = await route.fetch();
      expect(response.status()).toBe(200);
      const [arrival] =
        await database`INSERT INTO notifications(user_id,task_id,kind,actor_name) VALUES (${who.id},${fixture.task.id},'mention','Arrived after snapshot') RETURNING id`;
      arrivalId = arrival.id;
      await route.fulfill({ response });
    });
    await page.route("**/api/notifications?**", async (route) => {
      const url = new URL(route.request().url());
      if (
        mutations !== 1 ||
        url.searchParams.get("limit") !== "100" ||
        url.searchParams.has("cursor")
      )
        return route.continue();
      const response = await route.fetch();
      expect(response.status()).toBe(200);
      refreshStarted();
      await pendingRefresh;
      await route.fulfill({ response });
    });
    try {
      await inbox(page)
        .getByRole("button", { name: "Mark all read", exact: true })
        .click();
      await requestedRefresh;
      await expect(
        inbox(page).getByRole("button", {
          name: "Marking all read…",
          exact: true,
        }),
      ).toBeDisabled();
      await expect(inbox(page)).toBeFocused();
    } finally {
      releaseRefresh();
    }
    await expect(rows(page)).toHaveCount(121);
    await expect(
      row(page, "Arrived after snapshot").getByText("Unread", { exact: true }),
    ).toHaveCount(1);
    await expect(inbox(page).getByText("Read", { exact: true })).toHaveCount(
      120,
    );
    await expect(
      page.getByRole("button", { name: /^Notifications(?:, \d+ unread)?$/ }),
    ).toHaveAccessibleName("Notifications, 1 unread");
    expect(mutations).toBe(1);
    const receipts =
      await database`SELECT id,read_at FROM notifications WHERE user_id=${who.id}`;
    expect(receipts.find((item) => item.id === originalId)?.readAt).toEqual(
      original.readAt,
    );
    expect(receipts.find((item) => item.id === arrivalId)?.readAt).toBeNull();
    expect((await json(who.api, "/notifications")).unreadCount).toBe(1);
    await expect(inbox(page)).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(inbox(page)).toHaveCount(0);
    await openNotifications(page);
    await expect(
      row(page, "Arrived after snapshot").getByText("Unread", { exact: true }),
    ).toHaveCount(1);
    expect(mutations).toBe(1);
  });
}

test("mark-all refresh preserves focus deliberately moved during the update", async ({
  page,
}) => {
  const who = await account("Focus ownership", "member", true);
  await seed(who, 2);
  await authenticateBrowserFixture(page, who.fixture!);
  await page.goto(`/boards/${boardId}`);
  await openNotifications(page);
  await expect(rows(page)).toHaveCount(2);
  const chosenLink = row(page, "Focus ownership teammate 1").getByRole("link");
  let mutations = 0;
  let releasePatch!: () => void;
  let patchStarted!: () => void;
  const pendingPatch = new Promise<void>((resolve) => {
    releasePatch = resolve;
  });
  const requestedPatch = new Promise<void>((resolve) => {
    patchStarted = resolve;
  });
  let releaseRefresh!: () => void;
  let refreshStarted!: () => void;
  const pendingRefresh = new Promise<void>((resolve) => {
    releaseRefresh = resolve;
  });
  const requestedRefresh = new Promise<void>((resolve) => {
    refreshStarted = resolve;
  });
  await page.route("**/api/notifications", async (route) => {
    if (route.request().method() !== "PATCH") return route.continue();
    mutations++;
    const response = await route.fetch();
    expect(response.status()).toBe(200);
    patchStarted();
    await pendingPatch;
    await route.fulfill({ response });
  });
  await page.route("**/api/notifications?**", async (route) => {
    if (new URL(route.request().url()).searchParams.get("limit") !== "100")
      return route.continue();
    const response = await route.fetch();
    expect(response.status()).toBe(200);
    refreshStarted();
    await pendingRefresh;
    await route.fulfill({ response });
  });
  try {
    await inbox(page)
      .getByRole("button", { name: "Mark all read", exact: true })
      .click();
    await requestedPatch;
    await chosenLink.focus();
    await expect(chosenLink).toBeFocused();
    releasePatch();
    await requestedRefresh;
    await expect(
      inbox(page).getByRole("button", {
        name: "Marking all read…",
        exact: true,
      }),
    ).toBeDisabled();
    await expect(chosenLink).toBeFocused();
  } finally {
    releasePatch();
    releaseRefresh();
  }
  await expect(inbox(page).getByText("Read", { exact: true })).toHaveCount(2);
  await expect(
    inbox(page).getByRole("button", { name: "Mark all read", exact: true }),
  ).toBeDisabled();
  await expect(chosenLink).toBeFocused();
  await expect(page).toHaveURL(new RegExp(`/boards/${boardId}$`));
  await expect(
    page.getByRole("button", { name: /^Notifications(?:, \d+ unread)?$/ }),
  ).toHaveAccessibleName("Notifications");
  await expect(
    page.locator('[data-slot="toast"]:not([data-exiting="true"])'),
  ).toHaveCount(0);
  expect((await json(who.api, "/notifications")).unreadCount).toBe(0);
  expect(mutations).toBe(1);
});

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
    page.getByRole("button", {
      name: "Notifications, 120 unread",
      exact: true,
    }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: /^Notifications(?:, \d+ unread)?$/ }),
  ).toHaveAccessibleName("Notifications, 120 unread");
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
    page.getByRole("button", {
      name: "Notifications, 119 unread",
      exact: true,
    }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: /^Notifications(?:, \d+ unread)?$/ }),
  ).toHaveAccessibleName("Notifications, 119 unread");
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
    page.getByRole("button", {
      name: "Notifications, 119 unread",
      exact: true,
    }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: /^Notifications(?:, \d+ unread)?$/ }),
  ).toHaveAccessibleName("Notifications");
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
  let release!: () => void;
  let started!: () => void;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  const requested = new Promise<void>((resolve) => {
    started = resolve;
  });
  await page.route("**/api/notifications", async (route) => {
    if (route.request().method() !== "PATCH") return route.continue();
    started();
    await pending;
    await route.continue();
  });
  const unreadLink = row(page, "Opening Inbox teammate 2").getByRole("link");
  try {
    await unreadLink.press("Enter");
    await requested;
    await expect(unreadLink).toHaveAttribute("aria-busy", "true");
    expect((await json(who.api, "/notifications")).unreadCount).toBe(2);
    const [pendingReceipt] =
      await database`SELECT read_at FROM notifications WHERE id=${fixture.items[0]!.id}`;
    expect(pendingReceipt.readAt).toBeNull();
    await expect(page).toHaveURL(new RegExp(`/boards/${boardId}$`));
    await expect(taskPage(page)).toHaveCount(0);
    await expect(
      row(page, "Opening Inbox teammate 2").getByText("Unread", {
        exact: true,
      }),
    ).toBeVisible();
    expect(marks).toBe(1);
  } finally {
    release();
    await page.unrouteAll({ behavior: "wait" });
  }
  await expect(page).toHaveURL(
    new RegExp(`/boards/${boardId}/tasks/${fixture.task.id}$`),
  );
  await expect(taskPage(page)).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Notifications, 1 unread", exact: true }),
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

test("failed task opening toasts its error and retries the original mark before navigating", async ({
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
  await expect(
    page
      .locator('[data-slot="toast"]:not([data-exiting="true"])')
      .filter({ hasText: "could not be reached" })
      .first(),
  ).toBeVisible();
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
    await inbox(page)
      .getByRole("button", { name: "Retry opening task", exact: true })
      .click();
    await requested;
    await expect(
      inbox(page).getByRole("status").filter({ hasText: "Opening task…" }),
    ).toHaveCount(1);
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
    page.getByRole("button", { name: "Notifications, 1 unread", exact: true }),
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
    try {
      await expect(
        inbox(page).getByRole("button", { name: "Mark all read", exact: true }),
      ).toBeEnabled();
    } finally {
      await page.unrouteAll({ behavior: "wait" });
    }
  }
  await expect(
    row(page, "Obsolete open Inbox teammate 2").getByText("Read", {
      exact: true,
    }),
  ).toBeVisible();
  await expect(page).toHaveURL(new RegExp(`/boards/${boardId}$`));
  await expect(taskPage(page)).toHaveCount(0);
  await expect(
    inbox(page).getByRole("button", { name: "Mark all read", exact: true }),
  ).toBeEnabled();
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
    const announcement = inbox(page).getByRole("status").filter({
      hasText: "Loading notifications…",
    });
    await expect(announcement).toHaveCount(1);
    await expect(announcement).toHaveClass(/\bsr-only\b/);
    const announcementLayout = await announcement.evaluate((element) => {
      const style = getComputedStyle(element);
      const bounds = element.getBoundingClientRect();
      return {
        position: style.position,
        overflow: style.overflow,
        clipPath: style.clipPath,
        width: bounds.width,
        height: bounds.height,
      };
    });
    expect(announcementLayout.position).toBe("absolute");
    expect(announcementLayout.overflow).toBe("hidden");
    expect(announcementLayout.clipPath).toBe("inset(50%)");
    expect(announcementLayout.width).toBeLessThanOrEqual(1);
    expect(announcementLayout.height).toBeLessThanOrEqual(1);
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
  await expect(
    page
      .locator('[data-slot="toast"]:not([data-exiting="true"])')
      .filter({ hasText: "could not be reached" })
      .first(),
  ).toBeVisible();
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
  await expect(
    page
      .locator('[data-slot="toast"]:not([data-exiting="true"])')
      .filter({ hasText: "could not be reached" })
      .first(),
  ).toBeVisible();
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
  await expect(
    page
      .locator('[data-slot="toast"]:not([data-exiting="true"])')
      .filter({ hasText: "could not be confirmed" })
      .first(),
  ).toBeVisible();
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
    page
      .locator('[data-slot="toast"]:not([data-exiting="true"])')
      .filter({ hasText: "Mill could not be reached" })
      .first(),
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
    name: /^Notifications(?:, \d+ unread)?$/,
  });
  for (const width of [1440, 375]) {
    await page.setViewportSize({ width, height: width === 375 ? 844 : 1000 });
    await expect
      .poll(async () => (await trigger.boundingBox())?.height ?? 0)
      .toBe(width < 768 ? 40 : 36);
    await expect(trigger.locator("svg")).toHaveCSS("width", "16px");
    await expect(inbox(page).getByRole("tablist")).toHaveCount(0);
    const scroller = inbox(page).locator(
      '[data-slot="scroll-shadow"][data-orientation="vertical"]',
    );
    await expect(scroller).toHaveCount(1);
    await expect(scroller).toHaveCSS("max-height", "416px");
    await expect(async () => {
      const bounds = await inbox(page).boundingBox();
      expect(bounds).not.toBeNull();
      expect(bounds!.x).toBeGreaterThanOrEqual(12);
      expect(bounds!.width).toBeLessThanOrEqual(Math.min(384, width - 32));
      expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(width - 12);
      expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(
        width === 375 ? 833 : 989,
      );
    }).toPass({ timeout: 5000 });
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
      page.getByRole("button", { name: /^Notifications(?:, \d+ unread)?$/ }),
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
    name: /^Notifications(?:, \d+ unread)?$/,
  });
  for (const width of [1440, 375, 390])
    for (const theme of ["light", "dark"]) {
      await page.setViewportSize({ width, height: width < 600 ? 844 : 1000 });
      await page.evaluate(
        (value) => localStorage.setItem("avgeek-oss-ui-theme", value),
        theme,
      );
      await page.reload();
      await expect(trigger).toBeVisible();
      const bell = (await trigger.boundingBox())!;
      await page.mouse.move(bell.x + bell.width / 2, bell.y + bell.height / 2);
      await page.mouse.down();
      try {
        await expect(trigger).toHaveCSS("scale", "none");
        await expect(trigger).toHaveCSS("transform", "none");
        expect((await trigger.boundingBox())!.width).toBe(
          width < 768 ? 40 : 36,
        );
        expect((await trigger.boundingBox())!.height).toBe(
          width < 768 ? 40 : 36,
        );
      } finally {
        await page.mouse.up();
      }
      await expect(inbox(page)).toBeVisible();
      await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
      await expect(rows(page)).toHaveCount(2);
      const headerAction = inbox(page).getByRole("button", {
        name: "Mark all read",
        exact: true,
      });
      await expect
        .poll(async () => (await headerAction.boundingBox())?.height ?? 0)
        .toBe(24);
      await expect(inbox(page).getByRole("tablist")).toHaveCount(0);
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth),
      ).toBeLessThanOrEqual(width + 1);
      const first = rows(page).first();
      const layout = await first.evaluate((element) => {
        const link = element.querySelector("a")!;
        const style = getComputedStyle(link);
        const title =
          link.lastElementChild!.firstElementChild!.firstElementChild!;
        const icon = link.firstElementChild!;
        const time = element.querySelector("time")!;
        const linkBounds = link.getBoundingClientRect();
        const titleBounds = title.getBoundingClientRect();
        const iconBounds = icon.getBoundingClientRect();
        const firstLineHeight = Number.parseFloat(
          getComputedStyle(title).lineHeight,
        );
        const timeBounds = time.getBoundingClientRect();
        return {
          top: style.paddingTop,
          bottom: style.paddingBottom,
          weight: getComputedStyle(title).fontWeight,
          titleSize: getComputedStyle(title).fontSize,
          iconFirstLineCenterOffset: Math.abs(
            iconBounds.y +
              iconBounds.height / 2 -
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
          stateLabel:
            link.lastElementChild!.lastElementChild!.textContent?.trim(),
          iconWidth: iconBounds.width,
        };
      });
      expect(layout.top).toBe(layout.bottom);
      expect(layout.weight).toBe("500");
      expect(layout.titleSize).toBe("14px");
      expect(layout.iconFirstLineCenterOffset).toBeLessThanOrEqual(4);
      expect(layout.linkHeight).toBeGreaterThanOrEqual(44);
      expect(layout.linkCount).toBe(1);
      expect(layout.buttonCount).toBe(0);
      expect(layout.timeInside).toBe(true);
      expect(layout.titleTimeOverlap).toBe(false);
      expect(layout.contentFits).toBe(true);
      expect(layout.stateLabel).toBe("Unread");
      expect(layout.iconWidth).toBe(16);
      await page.screenshot({
        path: `tmp/notifications-preview/notifications-${width}-${theme}.png`,
        fullPage: true,
        animations: "disabled",
      });
      await page.keyboard.press("Escape");
      await expect(trigger).toBeFocused();
      await page.keyboard.down("Space");
      try {
        await expect(trigger).toHaveCSS("scale", "none");
        await expect(trigger).toHaveCSS("transform", "none");
      } finally {
        await page.keyboard.up("Space");
      }
      await expect(inbox(page)).toBeVisible();
    }
  await page.setViewportSize({ width: 375, height: 844 });
  await page.evaluate(() =>
    localStorage.setItem("avgeek-oss-ui-theme", "light"),
  );
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
    page
      .locator('[data-slot="toast"]:not([data-exiting="true"])')
      .filter({ hasText: "Mill could not be reached" })
      .first(),
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
      page.getByRole("button", { name: "Toggle navigation", exact: true }),
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
      name: /^Notifications(?:, \d+ unread)?$/,
    });
    for (const theme of ["light", "dark"]) {
      await page.evaluate(
        (value) => localStorage.setItem("avgeek-oss-ui-theme", value),
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
        .toBe(40);
      await expect(trigger.locator("svg")).toHaveCSS("width", "16px");
      const markAll = inbox(page).getByRole("button", {
        name: "Mark all read",
        exact: true,
      });
      await expect
        .poll(async () => (await markAll.boundingBox())?.height ?? 0)
        .toBe(24);
      await expect(trigger).toHaveAccessibleName("Notifications, 2 unread");
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
    await expect(trigger).toHaveAccessibleName("Notifications");
  });
});

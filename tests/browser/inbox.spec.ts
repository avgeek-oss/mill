import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import postgres from "postgres";
import {
  expect,
  test,
  request as requests,
  type APIRequestContext,
  type Page,
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
let columnId = "";
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
async function account(name: string, role: "member" | "viewer" = "member") {
  if (name !== "Private Inbox") {
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
  return { id: result.user.id, email, name, api } as Account;
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
    await database`INSERT INTO tasks(board_id,column_id,identifier,title,created_by,assignee_id,position) VALUES(${boardId},${columnId},${`${boardPrefix}-${number.number}`},${title},${adminId},${who.id},${number.number}) RETURNING id,identifier`;
  seededTasks.push(task.id);
  await database`INSERT INTO notifications(user_id,task_id,kind,actor_name,created_at,read_at) SELECT ${who.id},${task.id},'mention',${who.name}||' teammate '||sequence,timestamptz '2026-01-01T00:00:00Z'+sequence*interval '1 millisecond',CASE WHEN sequence>${unread} THEN now() ELSE NULL END FROM generate_series(1,${total}) sequence`;
  const items =
    await database`SELECT id,actor_name FROM notifications WHERE user_id=${who.id} ORDER BY created_at DESC,id DESC`;
  return { task, items };
}
async function login(page: Page, who: Account) {
  if (who.fixture) {
    await authenticateBrowserFixture(page, who.fixture);
    await page.goto("/");
  } else {
    await page.goto("/");
    await page.getByLabel("Email", { exact: true }).fill(who.email);
    await page.getByLabel("Password", { exact: true }).fill(password);
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
  }
  await expect(
    page.getByRole("navigation", { name: "Workspace navigation" }),
  ).toBeVisible();
  await page.goto("/notifications");
  await expect(
    page.getByRole("heading", { name: "Inbox", exact: true }),
  ).toBeVisible();
}
function inbox(page: Page) {
  return page.getByRole("region", { name: "Notifications", exact: true });
}
function rows(page: Page) {
  return inbox(page).getByRole("listitem");
}
function row(page: Page, actor: string) {
  return rows(page).filter({
    has: page.getByRole("link", {
      name: new RegExp(`${actor} mentioned you in`),
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
  columnId = (await json(admin, `/boards/${boardId}`)).columns[0].id;
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

test("server unread filtering reaches older notifications and marks refresh the count without affecting another person", async ({
  page,
}) => {
  const who = await account("Older Inbox");
  const other = await account("Private Inbox");
  const { task } = await seed(who, 240, 120);
  await seed(other, 1);
  await login(page, who);
  await expect(rows(page)).toHaveCount(100);
  await expect(
    inbox(page).getByText("Private Inbox teammate 1", { exact: false }),
  ).toHaveCount(0);
  const unreadRequest = page.waitForRequest(
    (request) =>
      new URL(request.url()).pathname === "/api/notifications" &&
      new URL(request.url()).searchParams.get("unread") === "true",
  );
  await page.getByRole("tab", { name: "Unread", exact: true }).click();
  await unreadRequest;
  await expect(rows(page)).toHaveCount(100);
  await expect(row(page, "Older Inbox teammate 1")).toHaveCount(0);
  await inbox(page)
    .getByRole("button", { name: "Load older notifications", exact: true })
    .click();
  await expect(rows(page)).toHaveCount(120);
  const oldest = row(page, "Older Inbox teammate 1");
  await expect(oldest).toBeVisible();
  const link = oldest.getByRole("link");
  await expect(link).toHaveAttribute(
    "href",
    `/boards/${boardId}/tasks/${task.id}`,
  );
  expect(await oldest.locator("a button").count()).toBe(0);
  const popupPromise = page.context().waitForEvent("page");
  await link.click({ modifiers: ["ControlOrMeta"] });
  const popup = await popupPromise;
  await popup.waitForURL(`**/boards/${boardId}/tasks/${task.id}`);
  await popup.close();
  await expect(page).toHaveURL(/\/notifications$/);
  await expect(
    page.getByLabel("120 unread notifications", { exact: true }),
  ).toBeVisible();
  await oldest
    .getByRole("button", {
      name: "Mark notification from Older Inbox teammate 1 read",
      exact: true,
    })
    .click();
  await expect(rows(page)).toHaveCount(119);
  await expect(
    page.getByLabel("119 unread notifications", { exact: true }),
  ).toBeVisible();
  const [marked] =
    await database`SELECT read_at FROM notifications WHERE user_id=${who.id} AND actor_name='Older Inbox teammate 1'`;
  expect(marked.readAt).not.toBeNull();
  await page
    .getByRole("button", { name: "Mark all read", exact: true })
    .click();
  await expect(
    inbox(page).getByText("You’re all caught up", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByLabel("119 unread notifications", { exact: true }),
  ).toHaveCount(0);
  const [counts] =
    await database`SELECT count(*) FILTER (WHERE user_id=${who.id} AND read_at IS NULL)::int AS own,count(*) FILTER (WHERE user_id=${other.id} AND read_at IS NULL)::int AS other FROM notifications`;
  expect(counts).toMatchObject({ own: 0, other: 1 });
});

test("Viewer members can read their own inbox and read-only agent credentials cannot mark it", async ({
  page,
}) => {
  const who = await account("Viewer Inbox", "viewer");
  const fixture = await seed(who, 3);
  const credential = await json(who.api, "/credentials", {
    name: "Read-only Inbox",
    scopes: ["read"],
  });
  const denied = await admin.patch("/api/notifications", {
    headers: { Origin: origin, Authorization: `Bearer ${credential.token}` },
    data: { ids: [fixture.items[0]!.id], read: true },
  });
  expect(denied.status()).toBe(403);
  const [unchanged] =
    await database`SELECT read_at FROM notifications WHERE id=${fixture.items[0]!.id}`;
  expect(unchanged.readAt).toBeNull();
  await login(page, who);
  await expect(rows(page)).toHaveCount(3);
  const latest = row(page, "Viewer Inbox teammate 3");
  await latest
    .getByRole("button", {
      name: "Mark notification from Viewer Inbox teammate 3 read",
      exact: true,
    })
    .click();
  await expect(latest.getByText("Read", { exact: true })).toBeVisible();
  await latest.getByRole("link").click();
  await expect(page).toHaveURL(
    new RegExp(`/boards/${boardId}/tasks/${fixture.task.id}$`),
  );
  await expect(
    page.getByRole("dialog").getByLabel("Title", { exact: true }),
  ).toBeDisabled();
});

test("opening an unread task marks its notification read and read links do not mark again", async ({
  page,
}) => {
  const who = await account("Opening Inbox");
  const fixture = await seed(who, 2);
  await login(page, who);
  await page.getByRole("tab", { name: "Unread", exact: true }).click();
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
    await expect(page).toHaveURL(/\/notifications$/);
    await expect(page.getByRole("dialog")).toHaveCount(0);
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
  await expect(page.getByRole("dialog")).toBeVisible();
  await expect(
    page.getByLabel("1 unread notifications", { exact: true }),
  ).toBeVisible();
  expect(marks).toBe(1);
  const [marked] =
    await database`SELECT read_at FROM notifications WHERE id=${fixture.items[0]!.id}`;
  expect(marked.readAt).not.toBeNull();
  await page.goBack();
  await expect(page).toHaveURL(/\/notifications$/);
  await expect(rows(page)).toHaveCount(2);
  const read = row(page, "Opening Inbox teammate 2");
  await expect(read.getByText("Read", { exact: true })).toBeVisible();
  await read.getByRole("link").click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await settled(page);
  expect(marks).toBe(1);
  await page.goto("/notifications");
  await page.getByRole("tab", { name: "Unread", exact: true }).click();
  await expect(rows(page)).toHaveCount(1);
  await expect(row(page, "Opening Inbox teammate 1")).toBeVisible();
  expect((await json(who.api, "/notifications")).unreadCount).toBe(1);
  await row(page, "Opening Inbox teammate 1").getByRole("link").press("Enter");
  await expect(page.getByRole("dialog")).toBeVisible();
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
  await expect(page).toHaveURL(/\/notifications$/);
  await expect(page.getByRole("dialog")).toHaveCount(0);
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
  await page.route("**/api/notifications", async (route) => {
    if (route.request().method() !== "PATCH") return route.continue();
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
    await expect(page).toHaveURL(/\/notifications$/);
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect(
      latest.getByRole("button", {
        name: "Mark notification from Open retry Inbox teammate 2 read",
        exact: true,
      }),
    ).toBeDisabled();
  } finally {
    release();
    await page.unrouteAll({ behavior: "wait" });
  }
  await expect(page).toHaveURL(
    new RegExp(`/boards/${boardId}/tasks/${fixture.task.id}$`),
  );
  await expect(page.getByRole("dialog")).toBeVisible();
  await expect(
    page.getByLabel("1 unread notifications", { exact: true }),
  ).toBeVisible();
  const [marked] =
    await database`SELECT read_at FROM notifications WHERE id=${fixture.items[0]!.id}`;
  expect(marked.readAt).not.toBeNull();
});

test("pending task opening cannot navigate after an obsolete filter cycle or a change of person", async ({
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
    await page.getByRole("tab", { name: "Unread", exact: true }).click();
    await expect(
      page.getByRole("tab", { name: "Unread", exact: true }),
    ).toHaveAttribute("aria-selected", "true");
    await page.getByRole("tab", { name: "All", exact: true }).click();
    await expect(
      page.getByRole("tab", { name: "All", exact: true }),
    ).toHaveAttribute("aria-selected", "true");
  } finally {
    release();
    await page.unrouteAll({ behavior: "wait" });
  }
  await expect(
    row(page, "Obsolete open Inbox teammate 2").getByText("Read", {
      exact: true,
    }),
  ).toBeVisible();
  await expect(page).toHaveURL(/\/notifications$/);
  await expect(page.getByRole("dialog")).toHaveCount(0);
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
  await expect(page).toHaveURL(/\/notifications$/);
  await expect(page.getByRole("dialog")).toHaveCount(0);
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
    await expect(
      inbox(page)
        .getByRole("status")
        .filter({ hasText: "Loading notifications…" }),
    ).toHaveText("Loading notifications…");
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
  const oldest = row(page, "Recovery Inbox teammate 1");
  await page.route("**/api/notifications", (route) =>
    route.request().method() === "PATCH" ? route.abort() : route.continue(),
  );
  await oldest
    .getByRole("button", {
      name: "Mark notification from Recovery Inbox teammate 1 read",
      exact: true,
    })
    .click();
  await expect(oldest.getByRole("alert")).toContainText("could not be reached");
  const [unchanged] =
    await database`SELECT read_at FROM notifications WHERE user_id=${who.id} AND actor_name='Recovery Inbox teammate 1'`;
  expect(unchanged.readAt).toBeNull();
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
    await oldest
      .getByRole("button", { name: "Retry marking read", exact: true })
      .click();
    await markRequested;
    const marking = oldest.getByRole("button", {
      name: "Mark notification from Recovery Inbox teammate 1 read",
      exact: true,
    });
    await expect(marking).toBeDisabled();
    await expect(marking).toHaveText("Marking read…");
    await expect(
      page.getByRole("button", { name: "Mark all read", exact: true }),
    ).toBeDisabled();
  } finally {
    releaseMark();
    await page.unrouteAll({ behavior: "wait" });
  }
  await expect(oldest.getByText("Read", { exact: true })).toBeVisible();
  const unconfirmed = row(page, "Recovery Inbox teammate 2");
  await page.route("**/api/notifications", async (route) => {
    if (route.request().method() !== "PATCH") return route.continue();
    const response = await route.fetch();
    expect(response.status()).toBe(200);
    await route.fulfill({ response, body: "{}" });
  });
  await unconfirmed
    .getByRole("button", {
      name: "Mark notification from Recovery Inbox teammate 2 read",
      exact: true,
    })
    .click();
  await expect(unconfirmed.getByRole("alert")).toContainText(
    "could not be confirmed",
  );
  const [committed] =
    await database`SELECT read_at FROM notifications WHERE user_id=${who.id} AND actor_name='Recovery Inbox teammate 2'`;
  expect(committed.readAt).not.toBeNull();
  await page.unroute("**/api/notifications");
  await unconfirmed
    .getByRole("button", { name: "Retry marking read", exact: true })
    .click();
  await expect(unconfirmed.getByText("Read", { exact: true })).toBeVisible();
  await page.route("**/api/notifications?**", (route) =>
    new URL(route.request().url()).searchParams.get("limit") === "100"
      ? route.abort()
      : route.continue(),
  );
  await page.reload();
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

test("a delayed real unread continuation cannot replace or append to the newer All view", async ({
  page,
}) => {
  const who = await account("Stale Inbox");
  await seed(who, 130, 120);
  await login(page, who);
  await page.getByRole("tab", { name: "Unread", exact: true }).click();
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
    if (
      url.searchParams.get("unread") !== "true" ||
      !url.searchParams.has("cursor")
    )
      return route.continue();
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
    await page.getByRole("tab", { name: "All", exact: true }).click();
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

test("Inbox shared rows fit desktop and phone in both themes with native sibling actions", async ({
  page,
}) => {
  const who = await account("Layout Inbox");
  await seed(
    who,
    2,
    2,
    "Review the complete notification and its next step ".repeat(5),
  );
  await login(page, who);
  for (const width of [1440, 375])
    for (const theme of ["light", "dark"]) {
      await page.setViewportSize({ width, height: width === 375 ? 844 : 1000 });
      await page.evaluate(
        (value) => localStorage.setItem("mill:theme", value),
        theme,
      );
      await page.reload();
      await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
      await expect(rows(page)).toHaveCount(2);
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth),
      ).toBeLessThanOrEqual(width + 1);
      const first = rows(page).first();
      const layout = await first.evaluate((element) => {
        const style = getComputedStyle(element);
        const title = element.querySelector("a p")!;
        const button = element.querySelector("button")!;
        return {
          top: style.paddingTop,
          bottom: style.paddingBottom,
          weight: getComputedStyle(title).fontWeight,
          titleSize: getComputedStyle(title).fontSize,
          buttonHeight: button.getBoundingClientRect().height,
          nested: !!button.closest("a"),
          siblings:
            button.parentElement === element.querySelector("a")!.parentElement,
        };
      });
      expect(layout.top).toBe(layout.bottom);
      expect(layout.weight).toBe("500");
      expect(layout.titleSize).toBe("14px");
      expect(layout.buttonHeight).toBeGreaterThanOrEqual(44);
      expect(layout.nested).toBe(false);
      expect(layout.siblings).toBe(true);
      await page.screenshot({
        path: `tmp/inbox-preview/inbox-${width}-${theme}.png`,
        fullPage: true,
        animations: "disabled",
      });
    }
});

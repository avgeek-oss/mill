import { mkdir, readFile, writeFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { rememberBrowserBootstrap } from "../browser-fixture.js";
import postgres from "postgres";
import {
  chromium,
  expect,
  request,
  test,
  type Locator,
  type Page,
  type Route,
  type BrowserContext,
} from "@playwright/test";
const account = {
  email: "browser-admin@example.test",
  password: "Browser-only-password-42",
  name: "Alex Morgan",
  workspaceName: "Mill browser verification",
};
const baseOrigin = process.env.MILL_BROWSER_BASE_URL ?? "http://localhost:4323";
let workspaceId = "";
let adminUserId = "";
let adminSessionCookies: Awaited<ReturnType<BrowserContext["cookies"]>> = [];
let boardId = "";
let taskId = "";
let sidebarSizingUserId = "";
let layoutInvitationToken = "";
let detailInvitationToken = "";
let sidebarInvitationToken = "";
let lifecycleInvitationUrl = "";
let permissionsInvitationUrl = "";
let sidebarSizingInvitationUrl = "";
const sidebarSizingAccount = {
  email: "browser-sidebar-sizing@example.test",
  password: "Sidebar-sizing-only-password-42",
};
const permissionsAccount = {
  email: "browser-permissions@example.test",
  password: "Permissions-only-password-42",
};
const lifecycleAccount = {
  email: "browser-lifecycle@example.test",
  password: "Lifecycle-only-password-42",
};
async function login(
  page: Page,
  credentials: { email: string; password: string } = account,
) {
  let reusedSession = false;
  if (credentials.email === account.email && adminSessionCookies.length) {
    await page.context().addCookies(adminSessionCookies);
    const session = await page.request.get("/api/auth/me");
    if (session.status() === 401) adminSessionCookies = [];
    else {
      expect(session.ok()).toBeTruthy();
      expect((await session.json()).user.email).toBe(account.email);
      reusedSession = true;
    }
  }
  if (!reusedSession) {
    await page.goto("/");
    await page.getByLabel("Email", { exact: true }).fill(credentials.email);
    await page
      .getByLabel("Password", { exact: true })
      .fill(credentials.password);
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
  } else await page.goto("/");
  if ((page.viewportSize()?.width ?? 0) < 1024) {
    await expect(
      page.getByRole("button", { name: "Toggle navigation", exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole("heading", { name: "Sign in", exact: true }),
    ).toBeHidden();
  } else {
    await expect(
      page.getByRole("navigation", { name: "Workspace navigation" }),
    ).toBeVisible();
  }
  if (credentials.email === account.email) await rememberAdminSession(page);
}
async function rememberAdminSession(page: Page) {
  adminSessionCookies = (await page.context().cookies(baseOrigin)).filter(
    (cookie) => cookie.name === "mill_session",
  );
  expect(adminSessionCookies).toHaveLength(1);
}
async function choose(
  page: Page,
  label: string,
  value: string,
  scope: Page | Locator = page,
) {
  await scope.getByRole("button", { name: new RegExp(`${label}$`) }).click();
  await page.getByRole("option", { name: value, exact: true }).click();
  await expect(page.getByRole("listbox")).toBeHidden();
}
async function openBoardAction(
  page: Page,
  action: "Board settings" | "Delete board",
) {
  await page
    .getByRole("button", { name: "Board actions", exact: true })
    .click();
  const menu = page.getByRole("menu", { name: "Board actions", exact: true });
  await menu.getByRole("menuitem", { name: action, exact: true }).click();
  await expect(menu).toBeHidden();
}
async function submitWhilePending(
  page: Page,
  path: string,
  submit: Locator,
  footerClose: string,
  dialogTitle: string,
  duringPending?: () => Promise<void>,
) {
  let release!: () => void;
  let started!: () => void;
  let continued!: () => void;
  const pending = new Promise<void>((resolve) => (release = resolve));
  const requestStarted = new Promise<void>((resolve) => (started = resolve));
  const requestContinued = new Promise<void>(
    (resolve) => (continued = resolve),
  );
  await page.route(`**/api${path}`, async (route) => {
    if (route.request().method() !== "POST") return route.continue();
    started();
    await pending;
    try {
      await route.continue();
    } finally {
      continued();
    }
  });
  const dialog = page.getByRole("dialog", { name: dialogTitle, exact: true });
  try {
    await submit.click();
    await requestStarted;
    await expect(
      dialog.getByRole("button", { name: "Close dialog", exact: true }),
    ).toBeDisabled();
    await expect(
      dialog.getByRole("button", { name: footerClose, exact: true }),
    ).toBeDisabled();
    await page.keyboard.press("Escape");
    await expect(dialog).toBeVisible();
    await duringPending?.();
  } finally {
    release();
    await requestContinued;
    await page.unroute(`**/api${path}`);
  }
}
async function submitSettingsWhilePending(
  page: Page,
  path: string,
  method: "POST" | "PATCH" | "DELETE",
  submit: Locator,
  duringPending?: () => Promise<void>,
  dialogTitle = "Board settings",
) {
  let release!: () => void;
  let started!: () => void;
  let continued!: () => void;
  let requestEntered = false;
  const pending = new Promise<void>((resolve) => (release = resolve));
  const requestStarted = new Promise<void>((resolve) => (started = resolve));
  const requestContinued = new Promise<void>(
    (resolve) => (continued = resolve),
  );
  const pattern = `**/api${path}`;
  const handler = async (route: Route) => {
    if (route.request().method() !== method) return route.continue();
    requestEntered = true;
    started();
    await pending;
    try {
      await route.continue();
    } finally {
      continued();
    }
  };
  await page.route(pattern, handler);
  try {
    await submit.click();
    await requestStarted;
    await page.evaluate(
      () =>
        new Promise<void>((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
        ),
    );
    const dialog = page.getByRole("dialog", {
      name: dialogTitle,
      exact: true,
    });
    const nativeConfirmation = dialogTitle === "Delete board?";
    await expect(
      nativeConfirmation
        ? dialog.getByRole("button", { name: "Please wait…", exact: true })
        : submit,
    ).toBeDisabled();
    await expect(
      dialog.getByRole("button", {
        name: nativeConfirmation ? "Close" : "Close dialog",
        exact: true,
      }),
    ).toBeDisabled();
    await page.keyboard.press("Escape");
    await expect(dialog).toBeVisible();
    await duringPending?.();
  } finally {
    release();
    if (requestEntered) await requestContinued;
    await page.unroute(pattern, handler);
  }
}
function requestGate() {
  let release!: () => void;
  let enter!: () => void;
  let complete!: () => void;
  let entered = false;
  const pending = new Promise<void>((resolve) => (release = resolve));
  const started = new Promise<void>((resolve) => (enter = resolve));
  const continued = new Promise<void>((resolve) => (complete = resolve));
  return {
    started,
    release,
    async hold(route: Route) {
      entered = true;
      enter();
      await pending;
      try {
        await route.continue();
      } finally {
        complete();
      }
    },
    async finish() {
      release();
      if (entered) await continued;
    },
  };
}
test.describe.configure({ mode: "serial" });
test.beforeEach(async ({ page: _page }, testInfo) => {
  if (!process.env.DATABASE_URL) process.loadEnvFile(".env");
  if (!adminUserId) return;
  const meta = JSON.parse(
    await readFile(
      `tmp/browser-${new URL(baseOrigin).port}-schema.json`,
      "utf8",
    ),
  ) as { schema: string; baseURL: string };
  expect(meta.schema).toMatch(/^browser_[a-f0-9]{16}$/);
  expect(new URL(meta.baseURL).origin).toBe(new URL(baseOrigin).origin);
  const database = postgres(process.env.DATABASE_URL!, { max: 1 });
  try {
    const [window] = await database.unsafe(
      `SELECT count, GREATEST(0, EXTRACT(EPOCH FROM reset_at - now()) * 1000) AS remaining_ms FROM "${meta.schema}".request_limits WHERE key=$1`,
      [`actor:${adminUserId}`],
    );
    if (!window || Number(window.count) < 160) return;
    const waitMs = Math.ceil(Number(window.remaining_ms)) + 100;
    if (waitMs <= 100) return;
    testInfo.setTimeout(testInfo.timeout + waitMs + 5_000);
    await delay(waitMs);
  } finally {
    await database.end();
  }
});
test("first installation, board lifecycle, unassigned task and discussion", async ({
  page,
}, testInfo) => {
  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: "Set up your team", exact: true }),
  ).toBeVisible();
  const setupSubmissions: unknown[] = [];
  const observeSetup = async (route: Route) => {
    setupSubmissions.push(route.request().postDataJSON());
    await route.continue();
  };
  await page.route("**/api/auth/setup", observeSetup);
  await page
    .getByLabel("Team name", { exact: true })
    .fill(account.workspaceName);
  await page.getByLabel("Your Name", { exact: true }).fill(account.name);
  await page.getByLabel("Email", { exact: true }).fill(account.email);
  await page.getByLabel("Password", { exact: true }).fill(account.password);
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Set your preferences", exact: true }),
  ).toBeVisible();
  expect(setupSubmissions).toHaveLength(0);
  await page
    .getByRole("button", { name: "Complete Setup", exact: true })
    .click();
  await expect(
    page.getByRole("navigation", { name: "Workspace navigation" }),
  ).toBeVisible();
  expect(setupSubmissions).toHaveLength(1);
  expect(setupSubmissions[0]).toMatchObject({
    workspaceName: account.workspaceName,
    name: account.name,
    email: account.email,
    password: account.password,
  });
  await page.unroute("**/api/auth/setup", observeSetup);
  const bootstrap = await rememberBrowserBootstrap(page.request, baseOrigin);
  workspaceId = bootstrap.identity.workspace.id;
  adminUserId = bootstrap.identity.user.id;
  await rememberAdminSession(page);
  const onlyBoardResponse = await page.request.post("/api/boards", {
    headers: { Origin: baseOrigin },
    data: { name: "Only board before deletion", prefix: "EMPTY" },
  });
  expect(onlyBoardResponse.ok()).toBeTruthy();
  const onlyBoard = (await onlyBoardResponse.json()).board;
  await page.goto(`/boards/${onlyBoard.id}`);
  await openBoardAction(page, "Delete board");
  await page
    .getByRole("dialog", { name: "Delete board?" })
    .getByRole("button", { name: "Delete board" })
    .click();
  await expect(page).toHaveURL("/boards");
  await expect(
    page.getByRole("button", { name: "Create your first board" }),
  ).toBeVisible();
  await page.screenshot({
    path: "docs/screenshots/empty-board-light.png",
    fullPage: true,
    animations: "disabled",
  });
  expect((await page.request.get(`/api/boards/${onlyBoard.id}`)).status()).toBe(
    404,
  );

  const invite = async (email: string, role: "admin" | "member") => {
    const response = await page.request.post("/api/auth/invitations", {
      headers: { Origin: baseOrigin },
      data: { email, role },
    });
    expect(response.ok()).toBeTruthy();
    return response.json();
  };
  sidebarSizingInvitationUrl = (
    await invite(sidebarSizingAccount.email, "admin")
  ).inviteUrl;
  permissionsInvitationUrl = (await invite(permissionsAccount.email, "admin"))
    .inviteUrl;
  layoutInvitationToken = (await invite("browser-layout@example.test", "admin"))
    .token;
  detailInvitationToken = (
    await invite("browser-detail@example.test", "member")
  ).token;
  sidebarInvitationToken = (
    await invite("browser-sidebar@example.test", "admin")
  ).token;
  lifecycleInvitationUrl = (await invite(lifecycleAccount.email, "admin"))
    .inviteUrl;

  await page.getByRole("button", { name: "Create your first board" }).click();
  await page.getByLabel("Board name", { exact: true }).fill("Release planning");
  await page.getByLabel("Task prefix", { exact: true }).fill("REL");
  await submitWhilePending(
    page,
    "/boards",
    page
      .getByRole("dialog", { name: "Create a board" })
      .getByRole("button", { name: "Create board" }),
    "Cancel",
    "Create a board",
  );
  await expect(
    page.getByRole("heading", { name: "Release planning", exact: true }),
  ).toBeVisible();
  boardId = new URL(page.url()).pathname.split("/boards/")[1];
  const boardRead = requestGate();
  const holdBoard = (route: Route) =>
    route.request().method() === "GET"
      ? boardRead.hold(route)
      : route.continue();
  await page.route(`**/api/boards/${boardId}`, holdBoard);
  let boardResumeAt = 0;
  try {
    await page.reload();
    await boardRead.started;
    await expect(page).toHaveURL(`/boards/${boardId}`);
    await expect(
      page.getByRole("heading", { name: "No tasks yet" }),
    ).toHaveCount(0);
    await expect(
      page.getByRole("button", { name: "Create your first board" }),
    ).toHaveCount(0);
    boardResumeAt = Date.now();
  } finally {
    await boardRead.finish();
    await page.unroute(`**/api/boards/${boardId}`, holdBoard);
  }
  await expect(
    page.getByRole("heading", { name: "Release planning", exact: true }),
  ).toBeVisible();
  await testInfo.attach("held-board-read.json", {
    body: Buffer.from(
      JSON.stringify({
        viewport: "1280x720",
        resumedToHeadingMs: Date.now() - boardResumeAt,
      }),
    ),
    contentType: "application/json",
  });
  await expect(page.getByRole("button", { name: "New task" })).toBeEnabled();
  await page.getByRole("button", { name: "New task" }).click();
  const create = page.getByRole("dialog", { name: "New task" });
  await expect(create).toBeVisible();
  for (const excluded of [
    "Status",
    "Priority",
    "Due date",
    "New checklist item",
  ])
    await expect(create.getByLabel(excluded, { exact: true })).toHaveCount(0);
  await create
    .getByLabel("Title", { exact: true })
    .fill("Prepare the release plan");
  await create
    .getByLabel("Description", { exact: true })
    .fill(
      "## Release\nReview **all journeys**. [Unsafe](javascript:alert(1)) <script>alert(2)</script>",
    );
  await submitWhilePending(
    page,
    `/boards/${boardId}/tasks`,
    create.getByRole("button", { name: "Create task" }),
    "Cancel",
    "New task",
  );
  await expect(page).toHaveURL(
    new RegExp(`/boards/${boardId}/tasks/[0-9a-f-]+$`),
  );
  taskId = new URL(page.url()).pathname.split("/tasks/")[1];
  await expect(
    page.getByRole("heading", { name: "Prepare the release plan" }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Back to board" }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Edit task details" }),
  ).toBeVisible();
  await expect(page.getByRole("link", { name: "Unsafe" })).not.toHaveAttribute(
    "href",
    /javascript:/,
  );
  await expect(page.locator(".markdown script")).toHaveCount(0);
  await expect(page.getByRole("button", { name: /Status$/ })).toContainText(
    "Todo",
  );
  const createdAssignment = (
    await (await page.request.get(`/api/tasks/${taskId}`)).json()
  ).task;
  expect(createdAssignment).not.toHaveProperty("agentId");
  expect(createdAssignment.assigneeId).toBeNull();
  await expect(page.getByRole("button", { name: /Agent$/ })).toHaveCount(0);
  await choose(page, "Status", "In Progress");
  await expect
    .poll(
      async () =>
        (await (await page.request.get(`/api/tasks/${taskId}`)).json()).task
          .status,
    )
    .toBe("in_progress");
  await page.getByRole("button", { name: "Edit task details" }).click();
  const edit = page.getByRole("dialog", { name: "Edit task" });
  await edit
    .getByLabel("Title", { exact: true })
    .fill("Prepare the release and recovery plan");
  await edit
    .getByLabel("Description", { exact: true })
    .fill("## Release\nReview **all journeys** and verify recovery.");
  await edit.getByRole("button", { name: "Close", exact: true }).click();
  await expect(
    page.getByRole("heading", {
      name: "Prepare the release and recovery plan",
    }),
  ).toBeVisible();
  await expect
    .poll(
      async () =>
        (await (await page.request.get(`/api/tasks/${taskId}`)).json()).task
          .description,
    )
    .toContain("verify recovery");

  const send = page.getByRole("button", { name: "Send comment" });
  await expect(send).toBeDisabled();
  const commentInput = page.getByLabel("Add a comment", { exact: true });
  await commentInput.fill("Ready for review.");
  const commentGate = requestGate();
  const holdComment = (route: Route) =>
    route.request().method() === "POST"
      ? commentGate.hold(route)
      : route.continue();
  await page.route(`**/api/tasks/${taskId}/comments`, holdComment);
  try {
    await send.click();
    await commentGate.started;
    await expect(commentInput).toBeDisabled();
    await expect(commentInput).toHaveValue("Ready for review.");
    await expect(send).toBeDisabled();
  } finally {
    await commentGate.finish();
    await page.unroute(`**/api/tasks/${taskId}/comments`, holdComment);
  }
  await expect(
    page.getByRole("article", { name: `Comment by ${account.name}` }),
  ).toContainText("Ready for review.");
  await expect(commentInput).toHaveValue("");
  const comment = page.getByRole("article", {
    name: `Comment by ${account.name}`,
  });
  await expect(
    comment.getByRole("button", { name: /Edit comment/ }),
  ).toHaveCount(0);
  await comment.hover();
  await comment.getByRole("button", { name: /Delete comment by/ }).click();
  const confirmation = page.getByRole("dialog", { name: "Delete comment?" });
  await confirmation.getByRole("button", { name: "Keep comment" }).click();
  await expect(comment).toContainText("Ready for review.");
  await comment.hover();
  await comment.getByRole("button", { name: /Delete comment by/ }).click();
  await confirmation.getByRole("button", { name: "Delete comment" }).click();
  await expect(comment).toHaveCount(0);
  await commentInput.fill("Ready for review.");
  await send.click();
  await expect(comment).toContainText("Ready for review.");
  const firstCommentId = (
    await (await page.request.get(`/api/tasks/${taskId}/comments`)).json()
  ).items[0].id;
  await commentInput.fill("Newest update for reviewers.");
  await send.click();
  const comments = page.locator(".task-comment");
  await expect(comments).toHaveCount(2);
  await expect(comments.first()).toContainText("Newest update for reviewers.");
  await expect(comments.last()).toContainText("Ready for review.");
  const savedComments = (
    await (await page.request.get(`/api/tasks/${taskId}/comments`)).json()
  ).items;
  expect(savedComments).toHaveLength(2);
  expect(savedComments[1].id).toBe(firstCommentId);
  await expect(
    comments.first().locator('time[aria-label^="Commented:"]'),
  ).toBeVisible();
  await page.getByRole("tab", { name: "Activity" }).click();
  await expect(page.getByRole("tabpanel", { name: "Activity" })).toContainText(
    "Added a comment",
  );
  await page.getByRole("tab", { name: /^Comments/ }).click();
  await page.getByRole("button", { name: "Back to board" }).click();
  await expect(page).toHaveURL(`/boards/${boardId}`);
  await expect(page.getByRole("grid", { name: "Task list" })).toContainText(
    "Unassigned",
  );
  await page.getByRole("button", { name: "New task" }).click();
  await create
    .getByLabel("Title", { exact: true })
    .fill("Test database restore");
  await create.getByRole("button", { name: "Create task" }).click();
  await expect(page).toHaveURL(
    new RegExp(`/boards/${boardId}/tasks/[0-9a-f-]+$`),
  );
  await choose(page, "Status", "Done");
  await page.getByRole("button", { name: "Back to board" }).click();
  await expect(page.getByRole("grid", { name: "Task list" })).toContainText(
    "Test database restore",
  );
  await openBoardAction(page, "Board settings");
  const settings = page.getByRole("dialog", { name: "Board settings" });
  await settings
    .getByLabel("Description", { exact: true })
    .fill("Release and recovery work");
  await submitSettingsWhilePending(
    page,
    `/boards/${boardId}`,
    "PATCH",
    settings.getByRole("button", { name: "Save board" }),
  );
  await expect(page.getByText("Board updated.", { exact: true })).toBeVisible();
  await settings.getByRole("button", { name: "Close dialog" }).click();
  const board = (
    await (await page.request.get(`/api/boards/${boardId}`)).json()
  ).board;
  expect(board.description).toBe("Release and recovery work");
  const row = page
    .getByRole("grid", { name: "Task list" })
    .getByRole("row")
    .filter({ hasText: "Prepare the release and recovery plan" });
  await expect(row).toContainText("In Progress");
  await expect(row).toContainText("Unassigned");
  await expect(
    page.getByRole("columnheader", { name: "Agent", exact: true }),
  ).toHaveCount(0);
  await expect(page.getByText("Board updated.", { exact: true })).toBeHidden({
    timeout: 10000,
  });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.screenshot({
    path: "docs/screenshots/desktop-light.png",
    fullPage: true,
    animations: "disabled",
  });
  await page
    .getByRole("button", { name: "Appearance: switch to dark theme" })
    .click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await page.screenshot({
    path: "docs/screenshots/desktop-dark.png",
    fullPage: true,
    animations: "disabled",
  });
  await page
    .getByRole("button", { name: "Appearance: switch to light theme" })
    .click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  await page.goto(`/boards/${boardId}/tasks/${taskId}`);
  await expect(
    page.getByRole("heading", {
      name: "Prepare the release and recovery plan",
    }),
  ).toBeVisible();
  const paneGeometry: Array<Record<string, number | string>> = [];
  for (const width of [1280, 768]) {
    await page.setViewportSize({ width, height: 800 });
    const commentInput = page.getByPlaceholder("Add a comment…", {
      exact: true,
    });
    await commentInput.focus();
    const geometry = await page.evaluate(() => {
      const main = document.querySelector(".task-page-main")!;
      const discussion = main.querySelector(".task-page-discussion")!;
      const properties = document.querySelector(".task-page-properties")!;
      const title = document.querySelector(".task-page-title")!;
      const before = getComputedStyle(discussion, "::before");
      const mainRect = main.getBoundingClientRect();
      return {
        mainLeft:
          mainRect.left + parseFloat(getComputedStyle(main).paddingLeft),
        mainRight: mainRect.right,
        dividerBorder: before.borderTopWidth,
        propertyBorder: getComputedStyle(properties).borderLeftWidth,
        propertiesLeft: properties.getBoundingClientRect().left,
        titleLeft: title.getBoundingClientRect().left,
        documentWidth: document.documentElement.scrollWidth,
        overflowY: getComputedStyle(main).overflowY,
        focusedInputLeft: main
          .querySelector("textarea")!
          .getBoundingClientRect().left,
      };
    });
    expect(geometry.focusedInputLeft - 2).toBeGreaterThanOrEqual(0);
    expect(geometry.overflowY).toBe("visible");
    expect(geometry.propertiesLeft - geometry.mainRight).toBe(32);
    expect(
      Math.abs(geometry.titleLeft - geometry.mainLeft),
    ).toBeLessThanOrEqual(1);
    expect(geometry.dividerBorder).toBe("0px");
    expect(geometry.propertyBorder).toBe("0px");
    expect(geometry.documentWidth).toBeLessThanOrEqual(width);
    paneGeometry.push({ viewportWidth: width, ...geometry });
  }
  await testInfo.attach("task-pane-geometry.json", {
    body: Buffer.from(JSON.stringify(paneGeometry)),
    contentType: "application/json",
  });
  await mkdir("tmp/final-review", { recursive: true });
  await writeFile(
    "tmp/final-review/task-pane-geometry.json",
    `${JSON.stringify(paneGeometry, null, 2)}\n`,
  );
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.locator(".task-page-title")).toBeVisible();
  await expect(page.getByLabel("Task properties")).toBeVisible();
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth),
  ).toBeLessThanOrEqual(390);
  await page.setViewportSize({ width: 1440, height: 900 });
  const desktopTrash = comments
    .first()
    .getByRole("button", { name: /Delete comment by/ });
  await page.mouse.move(0, 0);
  await expect
    .poll(() =>
      desktopTrash.evaluate((element) => getComputedStyle(element).opacity),
    )
    .toBe("0");
  await desktopTrash.focus();
  await expect(desktopTrash).toBeFocused();
  await expect
    .poll(() =>
      desktopTrash.evaluate((element) => getComputedStyle(element).opacity),
    )
    .toBe("1");
  await page
    .getByRole("button", { name: "Appearance: switch to dark theme" })
    .click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await page.screenshot({
    path: "docs/screenshots/task-detail-dark.png",
    fullPage: true,
    animations: "disabled",
  });
  await page
    .getByRole("button", { name: "Appearance: switch to light theme" })
    .click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  await page.screenshot({
    path: "docs/screenshots/task-detail-light.png",
    fullPage: true,
    animations: "disabled",
  });
  for (const excluded of ["Add subtask", "New checklist item", "Edit comment"])
    await expect(page.getByRole("button", { name: excluded })).toHaveCount(0);
  for (const label of ["Labels", "Parent task", "Position"])
    await expect(page.getByLabel(label, { exact: true })).toHaveCount(0);
  const touchBrowser = await chromium.launch({ channel: "chromium" });
  const touch = await touchBrowser.newContext({
    baseURL: baseOrigin,
    storageState: await page.context().storageState(),
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
  });
  try {
    const phone = await touch.newPage();
    await phone.goto(`/boards/${boardId}/tasks/${taskId}`);
    const readTouchMedia = () =>
      phone.evaluate(() => ({
        coarse: matchMedia("(pointer: coarse)").matches,
        noHover: matchMedia("(hover: none)").matches,
        fine: matchMedia("(pointer: fine)").matches,
        hover: matchMedia("(hover: hover)").matches,
        fineHover: matchMedia("(hover: hover) and (pointer: fine)").matches,
        anyCoarse: matchMedia("(any-pointer: coarse)").matches,
        anyFine: matchMedia("(any-pointer: fine)").matches,
        touchPoints: navigator.maxTouchPoints,
      }));
    const touchMedia = await readTouchMedia();
    expect(touchMedia.coarse).toBe(true);
    expect(touchMedia.noHover).toBe(true);
    expect(touchMedia.touchPoints).toBeGreaterThan(0);
    const trash = phone
      .getByRole("article", { name: `Comment by ${account.name}` })
      .first()
      .getByRole("button", { name: /Delete comment by/ });
    await expect(trash).toBeVisible();
    const beforeTap = await readTouchMedia();
    expect(beforeTap.coarse).toBe(true);
    expect(beforeTap.noHover).toBe(true);
    expect(beforeTap.touchPoints).toBeGreaterThan(0);
    const box = await trash.boundingBox();
    const touchDetails = await trash.evaluate((element) => {
      const style = getComputedStyle(element);
      return {
        className: element.className,
        coarse: matchMedia("(pointer: coarse)").matches,
        noHover: matchMedia("(hover: none)").matches,
        fine: matchMedia("(pointer: fine)").matches,
        hover: matchMedia("(hover: hover)").matches,
        fineHover: matchMedia("(hover: hover) and (pointer: fine)").matches,
        anyCoarse: matchMedia("(any-pointer: coarse)").matches,
        width: style.width,
        minWidth: style.minWidth,
        height: style.height,
        minHeight: style.minHeight,
      };
    });
    expect(box?.width, JSON.stringify(touchDetails)).toBe(34);
    expect(box?.height, JSON.stringify(touchDetails)).toBe(34);
    await trash.scrollIntoViewIfNeeded();
    const touchHit = await trash.evaluate((element) => {
      const rect = element.getBoundingClientRect();
      const target = document.elementFromPoint(
        rect.left + rect.width / 2,
        rect.top + rect.height / 2,
      );
      return {
        x: rect.x,
        y: rect.y,
        width: rect.width,
        height: rect.height,
        viewportWidth: window.innerWidth,
        viewportHeight: window.innerHeight,
        pointerEvents: getComputedStyle(element).pointerEvents,
        opacity: getComputedStyle(element).opacity,
        fineHover: matchMedia("(hover: hover) and (pointer: fine)").matches,
        anyCoarse: matchMedia("(any-pointer: coarse)").matches,
        centerHit: element === target || element.contains(target),
        targetClass: target instanceof HTMLElement ? target.className : "",
      };
    });
    await testInfo.attach("comment-touch-hit.json", {
      body: Buffer.from(JSON.stringify(touchHit)),
      contentType: "application/json",
    });
    expect(touchHit.centerHit, JSON.stringify({ beforeTap, touchHit })).toBe(
      true,
    );
    await trash.tap();
    await expect(
      phone.getByRole("dialog", { name: "Delete comment?" }),
    ).toBeVisible();
    await phone
      .getByRole("dialog", { name: "Delete comment?" })
      .getByRole("button", { name: "Keep comment" })
      .tap();
    await phone.screenshot({
      path: "docs/screenshots/task-page-mobile-light.png",
      fullPage: true,
      animations: "disabled",
    });
    await testInfo.attach("touch-media-after-capture.json", {
      body: Buffer.from(
        JSON.stringify({ beforeTap, afterCapture: await readTouchMedia() }),
      ),
      contentType: "application/json",
    });
  } finally {
    await touch.close();
    await touchBrowser.close();
  }
});
test("sidebar header action sizing and removed audit routes stay unavailable", async ({
  page,
  browser,
}) => {
  await page.goto(sidebarSizingInvitationUrl);
  await page
    .getByLabel("Your Name", { exact: true })
    .fill("Sidebar Sizing Review");
  await page
    .getByLabel("Password", { exact: true })
    .fill(sidebarSizingAccount.password);
  await page
    .getByLabel("Confirm password", { exact: true })
    .fill(sidebarSizingAccount.password);
  await page
    .getByRole("button", { name: "Accept invitation", exact: true })
    .click();
  await expect(
    page.getByRole("navigation", { name: "Workspace navigation" }),
  ).toBeVisible();
  const sizingSessionResponse = await page.request.get("/api/auth/me");
  expect(sizingSessionResponse.ok()).toBeTruthy();
  const sizingSession = await sizingSessionResponse.json();
  sidebarSizingUserId = sizingSession.user.id;
  expect(sizingSession.user.email).toBe(sidebarSizingAccount.email);
  expect(sizingSession.user.role).toBe("admin");
  expect(sizingSession.workspace.id).toBe(workspaceId);
  const storageState = await page.context().storageState();
  for (const width of [1280, 390])
    for (const theme of ["light", "dark"]) {
      const context = await browser.newContext({
        baseURL: baseOrigin,
        storageState,
        viewport: { width, height: 844 },
        isMobile: width === 390,
        hasTouch: width === 390,
      });
      try {
        await context.addInitScript(
          (value) => localStorage.setItem("avgeek-oss-ui-theme", value),
          theme,
        );
        const surface = await context.newPage();
        await surface.goto("/boards");
        const toggle = surface.getByRole("button", {
          name: "Toggle navigation",
          exact: true,
          includeHidden: true,
        });
        if (width === 390) {
          await expect(toggle).toHaveAttribute("aria-expanded", "false");
          const touchMedia = await surface.evaluate(() => ({
            coarse: matchMedia("(pointer: coarse)").matches,
            noHover: matchMedia("(hover: none)").matches,
            touchPoints: navigator.maxTouchPoints,
          }));
          expect(touchMedia.coarse).toBe(true);
          expect(touchMedia.noHover).toBe(true);
          expect(touchMedia.touchPoints).toBeGreaterThan(0);
          await toggle.click();
          await expect(toggle).toHaveAttribute("aria-expanded", "true");
          await expect(toggle).toHaveAttribute(
            "aria-controls",
            "application-navigation",
          );
          await expect(
            surface.getByRole("dialog", { name: "Navigation", exact: true }),
          ).toBeVisible();
        }
        const nav = surface.getByRole("navigation", {
          name: "Workspace navigation",
        });
        const create = surface.getByRole("main").getByRole("button", {
          name: "Create board",
          exact: true,
        });
        const reference = nav.getByRole("link", {
          name: "Account settings",
          exact: true,
        });
        await expect(reference).toBeVisible();
        const metrics = async (element: Locator) =>
          element.evaluate((node) => {
            const style = getComputedStyle(node);
            const iconNode = node.querySelector("svg")!;
            const iconStyle = getComputedStyle(iconNode);
            const icon = iconNode.getBoundingClientRect();
            return {
              height: node.getBoundingClientRect().height,
              fontSize: style.fontSize,
              fontWeight: style.fontWeight,
              gap: style.gap,
              padding: style.padding,
              iconCssWidth: iconStyle.width,
              iconCssHeight: iconStyle.height,
              iconGeometry: { width: icon.width, height: icon.height },
            };
          });
        const { iconGeometry: referenceIcon, ...referenceStyles } =
          await metrics(reference);
        if (width === 390) {
          await surface.keyboard.press("Escape");
          await expect(toggle).toHaveAttribute("aria-expanded", "false");
          await expect(toggle).toBeFocused();
        }
        await expect(create).toBeVisible();
        const { iconGeometry: createIcon, ...createStyles } =
          await metrics(create);
        expect(createStyles.height).toBe(32);
        expect(referenceStyles.height).toBe(36);
        expect(referenceStyles.fontSize).toBe("14px");
        expect(referenceStyles.gap).toBe("12px");
        expect(referenceStyles.fontWeight).toBe("400");
        expect(createStyles.iconCssWidth).toBe("16px");
        expect(createStyles.iconCssHeight).toBe("16px");
        for (const dimension of ["width", "height"] as const)
          expect(
            Math.abs(createIcon[dimension] - referenceIcon[dimension]),
          ).toBeLessThanOrEqual(0.001);
        expect((await create.boundingBox())!.height).toBe(32);
        await expect(
          nav.getByRole("link", { name: "Audit history", exact: true }),
        ).toHaveCount(0);
        await surface.goto("/settings/audit");
        await expect(
          surface.getByRole("heading", {
            name: "This page could not be found",
            exact: true,
          }),
        ).toBeVisible();
        expect((await surface.request.get("/api/audit")).status()).toBe(404);
      } finally {
        await context.close();
      }
    }
});
test("keyboard controls, URL filters, task returns, themes and mobile navigation", async ({
  page,
}) => {
  await login(page);
  await page.goto(`/boards/${boardId}/tasks/${taskId}`);
  await expect(
    page.getByRole("heading", {
      name: "Prepare the release and recovery plan",
    }),
  ).toBeVisible();
  const assignee = page.getByRole("button", { name: /Assignee$/ });
  await choose(page, "Assignee", "Sidebar Sizing Review");
  await expect
    .poll(async () => {
      const task = (
        await (await page.request.get(`/api/tasks/${taskId}`)).json()
      ).task;
      return task.assigneeId;
    })
    .toBe(sidebarSizingUserId);
  await choose(page, "Assignee", "Unassigned");
  await expect(assignee).toContainText("Unassigned");
  const status = page.getByRole("button", { name: /Status$/ });
  await status.focus();
  await page.keyboard.press("Enter");
  await page.keyboard.press("d");
  await page.keyboard.press("Enter");
  await expect(page.getByRole("listbox")).toBeHidden();
  await expect(status).toContainText("Done");
  await expect
    .poll(
      async () =>
        (await (await page.request.get(`/api/tasks/${taskId}`)).json()).task
          .status,
    )
    .toBe("done");
  await page.getByRole("button", { name: "Back to board" }).click();
  await page.getByLabel("Search tasks").fill("recovery");
  await expect(page).toHaveURL(new RegExp(`\\?q=recovery`));
  const taskLink = page
    .getByRole("grid", { name: "Task list" })
    .getByRole("link")
    .filter({ hasText: "Prepare the release and recovery plan" });
  await expect(taskLink).toHaveCount(1);
  await expect(taskLink).toHaveAttribute(
    "href",
    new RegExp(`/boards/${boardId}/tasks/${taskId}\\?q=recovery$`),
  );
  await page.reload();
  await expect(page.getByLabel("Search tasks")).toHaveValue("recovery");
  const taskCell = page
    .getByRole("grid", { name: "Task list" })
    .getByRole("rowheader", {
      name: "Prepare the release and recovery plan",
      exact: true,
    });
  await taskCell.focus();
  await expect(taskCell).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(taskLink).toBeFocused();
  await taskLink.press("Enter");
  await expect(
    page.getByRole("heading", {
      name: "Prepare the release and recovery plan",
    }),
  ).toBeFocused();
  await expect(page).toHaveURL(new RegExp(`/tasks/${taskId}\\?q=recovery$`));
  await expect(
    page
      .getByRole("navigation", { name: "Breadcrumb" })
      .getByRole("link", { name: "Release planning" }),
  ).toHaveAttribute("href", `/boards/${boardId}?q=recovery`);
  await page.getByRole("button", { name: "Back to board" }).click();
  await expect(page.getByLabel("Search tasks")).toHaveValue("recovery");
  await page.goBack();
  await expect(
    page.getByRole("heading", {
      name: "Prepare the release and recovery plan",
    }),
  ).toBeVisible();
  await page.goForward();
  await expect(page.getByLabel("Search tasks")).toHaveValue("recovery");
  await page.getByRole("button", { name: "Clear filters" }).click();
  await expect(page).toHaveURL(`/boards/${boardId}`);
  await expect(page.getByRole("grid", { name: "Task list" })).toContainText(
    "Test database restore",
  );
  for (const [width, height, theme] of [
    [1280, 800, "light"],
    [1280, 800, "dark"],
    [390, 844, "light"],
    [390, 844, "dark"],
  ] as const) {
    await page.setViewportSize({ width, height });
    await page.evaluate(
      (value) => localStorage.setItem("avgeek-oss-ui-theme", value),
      theme,
    );
    await page.reload();
    await expect(page.getByRole("grid", { name: "Task list" })).toBeVisible();
    await expect
      .poll(() => page.evaluate(() => document.documentElement.scrollWidth))
      .toBeLessThanOrEqual(width);
    if (width === 390) {
      const toggle = page.getByRole("button", {
        name: "Toggle navigation",
        exact: true,
        includeHidden: true,
      });
      await expect(toggle).toHaveAttribute("aria-expanded", "false");
      await toggle.click();
      await expect(toggle).toHaveAttribute("aria-expanded", "true");
      await expect(toggle).toHaveAttribute(
        "aria-controls",
        "application-navigation",
      );
      const navigation = page.getByRole("dialog", {
        name: "Navigation",
        exact: true,
      });
      await expect(navigation).toBeVisible();
      await expect(
        navigation.getByRole("navigation", {
          name: "Page navigation",
          exact: true,
        }),
      ).toBeVisible();
      await page.keyboard.press("Escape");
      await expect(navigation).toBeHidden();
      await expect(toggle).toHaveAttribute("aria-expanded", "false");
      await expect(toggle).toBeFocused();
    }
  }
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.getByLabel("Search tasks").fill("nonexistent-filter-result");
  await expect(
    page.getByRole("heading", { name: "No tasks match these filters" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Clear filters" }).last().click();
  await expect(page.getByRole("grid", { name: "Task list" })).toContainText(
    "Test database restore",
  );
  const secondBoard = await page.request.post("/api/boards", {
    headers: { Origin: baseOrigin },
    data: { name: "Alpha route", prefix: "ALPHA" },
  });
  expect(secondBoard.ok()).toBeTruthy();
  const otherBoardId = (await secondBoard.json()).board.id;
  await page.goto("/boards");
  await expect(
    page
      .getByRole("main")
      .getByRole("link", { name: "Alpha route", exact: true }),
  ).toBeVisible();
  await page
    .getByRole("main")
    .getByRole("link", { name: "Release planning", exact: true })
    .click();
  const breadcrumb = page.getByRole("navigation", { name: "Breadcrumb" });
  await breadcrumb.getByRole("button", { name: /Switch board/ }).click();
  await page.getByRole("option", { name: "Alpha route" }).click();
  await expect(page).toHaveURL(`/boards/${otherBoardId}`);
  await expect(
    page.getByRole("heading", { name: "Alpha route" }),
  ).toBeVisible();
  await expect(
    breadcrumb.getByRole("link", { name: "Boards", exact: true }),
  ).toHaveAttribute("href", "/boards");
  await expect(
    page.getByRole("navigation", { name: "Boards navigation" }),
  ).toHaveCount(0);
  await breadcrumb.getByRole("button", { name: /Switch board/ }).click();
  await page.getByRole("option", { name: "Release planning" }).click();
  await expect(page).toHaveURL(`/boards/${boardId}`);
});
test("independent task saves preserve a conflicting title draft and recover", async ({
  page,
}) => {
  await login(page);
  await page.goto(`/boards/${boardId}/tasks/${taskId}`);
  await expect(
    page.getByRole("heading", {
      name: "Prepare the release and recovery plan",
    }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Edit task details" }).click();
  const edit = page.getByRole("dialog", { name: "Edit task" });
  const title = edit.getByLabel("Title", { exact: true });
  const task = (await (await page.request.get(`/api/tasks/${taskId}`)).json())
    .task;
  const external = await page.request.patch(`/api/tasks/${taskId}`, {
    headers: { Origin: baseOrigin },
    data: { version: task.version, title: "Another person's update" },
  });
  expect(external.ok()).toBeTruthy();
  await title.fill("My pending draft");
  await expect(
    page
      .locator('[data-slot="toast"]')
      .filter({ hasText: "changed elsewhere" }),
  ).toContainText("changed elsewhere");
  await expect(title).toHaveValue("My pending draft");
  await expect(
    edit.getByRole("button", { name: "Keep my change" }),
  ).toBeVisible();
  await expect(
    edit.getByRole("button", { name: "Use saved value" }),
  ).toBeVisible();
  await edit.getByRole("button", { name: "Close", exact: true }).click();
  await expect(edit).toBeVisible();
  await edit.getByRole("button", { name: "Keep my change" }).click();
  await expect(
    edit.getByRole("button", { name: "Keep my change" }),
  ).toHaveCount(0);
  await edit.getByRole("button", { name: "Close", exact: true }).click();
  await expect(edit).toBeHidden();
  await page.reload();
  await expect(
    page.getByRole("heading", { name: "My pending draft" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Edit task details" }).click();
  await title.fill("Draft to discard");
  const conflicting = await page.request
    .get(`/api/tasks/${taskId}`)
    .then((r) => r.json());
  const update = await page.request.patch(`/api/tasks/${taskId}`, {
    headers: { Origin: baseOrigin },
    data: { version: conflicting.task.version, title: "Saved elsewhere" },
  });
  expect(update.ok()).toBeTruthy();
  await expect(
    edit.getByRole("button", { name: "Use saved value" }),
  ).toBeVisible();
  await edit.getByRole("button", { name: "Use saved value" }).click();
  await expect(title).toHaveValue("Saved elsewhere");
  await edit.getByRole("button", { name: "Close", exact: true }).click();
});

test("expired session preserves task route, and unknown route has recovery", async ({
  page,
}) => {
  await login(page);
  await page.goto(`/boards/${boardId}/tasks/${taskId}`);
  await expect(
    page.getByRole("heading", { name: "Saved elsewhere" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Open notifications" }).click();
  const notifications = page.getByRole("dialog", { name: "Notifications" });
  await expect(notifications).toBeVisible();
  expect(
    await notifications.evaluate((element) =>
      Boolean(element.closest("[data-authenticated-app]")),
    ),
  ).toBe(true);
  await page.keyboard.press("Escape");
  await expect(notifications).toBeHidden();
  const commentDraft = page.getByLabel("Add a comment", { exact: true });
  await commentDraft.fill("Unsent through session expiry");
  await page.getByRole("button", { name: "Edit task details" }).click();
  const edit = page.getByRole("dialog", { name: "Edit task" });
  expect(
    await edit.evaluate((element) =>
      Boolean(element.closest("[data-authenticated-app]")),
    ),
  ).toBe(true);
  const title = edit.getByLabel("Title", { exact: true });
  await page.request.post("/api/auth/logout", {
    headers: { Origin: baseOrigin },
    data: {},
  });
  adminSessionCookies = [];
  await title.fill("Expired title draft");
  await expect(
    page.getByRole("heading", { name: "Sign in", exact: true }),
  ).toBeVisible();
  await expect(edit).toBeHidden();
  await expect(page.locator("[data-authenticated-app]")).toHaveAttribute(
    "inert",
    "",
  );
  await expect(page.locator("[data-authenticated-app]")).toHaveAttribute(
    "hidden",
    "",
  );
  await expect(
    page.getByText("Your session expired. Sign in again to continue."),
  ).toBeVisible();
  await page.getByLabel("Email", { exact: true }).fill(account.email);
  await page.getByLabel("Password", { exact: true }).fill(account.password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(edit).toBeVisible();
  await rememberAdminSession(page);
  await expect(title).toHaveValue("Expired title draft");
  await expect(commentDraft).toHaveValue("Unsent through session expiry");
  await edit.getByRole("button", { name: "Retry" }).click();
  await expect(edit.getByRole("button", { name: "Retry" })).toHaveCount(0);
  await edit.getByRole("button", { name: "Close", exact: true }).click();
  await page.getByRole("button", { name: "Send comment" }).click();
  await expect(commentDraft).toHaveValue("");
  await expect(
    page.getByRole("heading", { name: "Expired title draft" }),
  ).toBeVisible();
  await page.reload();
  await expect(
    page.getByRole("heading", { name: "Expired title draft" }),
  ).toBeVisible();
  await expect(page).toHaveURL(
    new RegExp(`/boards/${boardId}/tasks/${taskId}`),
  );
  await page.goto("/missing-page");
  await expect(
    page.getByRole("heading", { name: "This page could not be found" }),
  ).toBeVisible();
  await page.screenshot({
    path: "docs/screenshots/not-found-light.png",
    fullPage: true,
    animations: "disabled",
  });
  await page.getByRole("button", { name: "Go to boards" }).click();
  await expect(
    page.getByRole("heading", { name: "Release planning" }),
  ).toBeVisible();
  await page.goto(`/boards/${boardId}/tasks/${taskId}`);
  const unsent = page.getByLabel("Add a comment", { exact: true });
  await unsent.fill("Do not sign me out with this draft");
  let logoutRequests = 0;
  page.on("request", (request) => {
    if (
      request.method() === "POST" &&
      new URL(request.url()).pathname === "/api/auth/logout"
    )
      logoutRequests++;
  });
  const signOut = async () => {
    await page
      .getByRole("button", { name: `Account menu for ${account.name}` })
      .click();
    await page.getByRole("menuitem", { name: "Sign out" }).click();
  };
  await signOut();
  await expect(
    page.locator('[data-slot="toast"]').filter({ hasText: "unsent comment" }),
  ).toBeVisible();
  await expect(unsent).toHaveValue("Do not sign me out with this draft");
  expect(logoutRequests).toBe(0);
  await page.getByRole("button", { name: "Clear draft" }).click();
  await signOut();
  await expect(
    page.getByRole("heading", { name: "Sign in", exact: true }),
  ).toBeVisible();
  adminSessionCookies = [];
  expect(logoutRequests).toBe(1);
  const checkOpenPopoverExpiry = async (target: Page) => {
    await target.clock.install();
    await login(target);
    await target.getByRole("button", { name: "Open notifications" }).click();
    const popover = target.getByRole("dialog", { name: "Notifications" });
    await expect(popover).toBeVisible();
    expect(
      await popover.evaluate((element) =>
        Boolean(element.closest("[data-authenticated-app]")),
      ),
    ).toBe(true);
    const revoked = await target.request.post("/api/auth/logout", {
      headers: { Origin: baseOrigin },
      data: {},
    });
    expect(revoked.ok()).toBeTruthy();
    adminSessionCookies = [];
    await target.clock.fastForward(30_100);
    await expect(
      target.getByRole("heading", { name: "Sign in", exact: true }),
    ).toBeVisible();
    await expect(popover).toBeHidden();
    await expect(target.locator("[data-authenticated-app]")).toHaveAttribute(
      "inert",
      "",
    );
    let formFocused = false;
    for (let tab = 0; tab < 8 && !formFocused; tab++) {
      await target.keyboard.press("Tab");
      const focus = await target.evaluate(() => ({
        inHiddenApp: Boolean(
          document.activeElement?.closest("[data-authenticated-app]"),
        ),
        inForm: Boolean(document.activeElement?.closest("form")),
      }));
      expect(focus.inHiddenApp).toBe(false);
      formFocused = focus.inForm;
    }
    expect(formFocused).toBe(true);
    await target.getByLabel("Email", { exact: true }).fill(account.email);
    await target.getByLabel("Password", { exact: true }).fill(account.password);
    await target.getByRole("button", { name: "Sign in", exact: true }).click();
    await expect(popover).toBeVisible();
    await rememberAdminSession(target);
  };
  await checkOpenPopoverExpiry(page);
  const touchBrowser = await chromium.launch({ channel: "chromium" });
  const touch = await touchBrowser.newContext({
    baseURL: baseOrigin,
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
  });
  try {
    const phone = await touch.newPage();
    const touchMedia = await phone.evaluate(() => ({
      coarse: matchMedia("(pointer: coarse)").matches,
      noHover: matchMedia("(hover: none)").matches,
      touchPoints: navigator.maxTouchPoints,
    }));
    expect(touchMedia.coarse).toBe(true);
    expect(touchMedia.noHover).toBe(true);
    expect(touchMedia.touchPoints).toBeGreaterThan(0);
    await checkOpenPopoverExpiry(phone);
  } finally {
    await touch.close();
    await touchBrowser.close();
  }
});

test("reauth masks a revoked board and retries only after access returns", async ({
  page,
}) => {
  await page.clock.install();
  await login(page);
  await page.goto(`/boards/${boardId}`);
  await expect(
    page.getByRole("heading", { name: "Release planning", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Open notifications" }).click();
  await expect(
    page.getByRole("dialog", { name: "Notifications" }),
  ).toBeVisible();
  const revokedSession = await page.request.post("/api/auth/logout", {
    headers: { Origin: baseOrigin },
    data: {},
  });
  expect(revokedSession.ok()).toBeTruthy();
  adminSessionCookies = [];
  await page.clock.fastForward(30_100);
  await expect(
    page.getByRole("heading", { name: "Sign in", exact: true }),
  ).toBeVisible();
  const denyBoard = async (route: Route) => {
    if (route.request().method() !== "GET") return route.continue();
    await route.fulfill({
      status: 403,
      contentType: "application/json",
      body: JSON.stringify({ error: "Board access was revoked" }),
    });
  };
  await page.route(`**/api/boards/${boardId}`, denyBoard);
  await page.getByLabel("Email", { exact: true }).fill(account.email);
  await page.getByLabel("Password", { exact: true }).fill(account.password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Board access required" }),
  ).toBeVisible();
  await rememberAdminSession(page);
  await expect(
    page.getByRole("dialog", { name: "Notifications" }),
  ).toBeHidden();
  await expect(
    page.getByRole("heading", { name: "Release planning", exact: true }),
  ).toHaveCount(0);
  await expect(page.getByRole("grid", { name: "Task list" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "New task" })).toHaveCount(0);
  await page.unroute(`**/api/boards/${boardId}`, denyBoard);
  await page.getByRole("button", { name: "Try again" }).click();
  await expect(
    page.getByRole("heading", { name: "Release planning", exact: true }),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: "New task" })).toBeVisible();
});

test("reauth hides task drafts on access loss and after real deletion", async ({
  page,
}) => {
  await login(page);
  const disposableResponse = await page.request.post(
    `/api/boards/${boardId}/tasks`,
    {
      headers: { Origin: baseOrigin },
      data: { title: "Task access changed during reauthentication" },
    },
  );
  expect(disposableResponse.status()).toBe(201);
  const disposable = (await disposableResponse.json()).task;
  const deleter = await request.newContext({ baseURL: baseOrigin });
  try {
    const separateSession = await deleter.post("/api/auth/login", {
      headers: { Origin: baseOrigin },
      data: { email: account.email, password: account.password },
    });
    expect(separateSession.ok()).toBeTruthy();
    await page.goto(`/boards/${boardId}/tasks/${disposable.id}`);
    await expect(
      page.getByRole("heading", { name: disposable.title }),
    ).toBeVisible();
    const comment = page.getByLabel("Add a comment", { exact: true });
    await comment.fill("Private comment pending on access loss");
    await page.getByRole("button", { name: "Edit task details" }).click();
    const editor = page.getByRole("dialog", { name: "Edit task" });
    const title = editor.getByLabel("Title", { exact: true });
    const expiredForAccess = await page.request.post("/api/auth/logout", {
      headers: { Origin: baseOrigin },
      data: {},
    });
    expect(expiredForAccess.ok()).toBeTruthy();
    adminSessionCookies = [];
    await title.fill("Private title pending on access loss");
    await expect(
      page.getByRole("heading", { name: "Sign in", exact: true }),
    ).toBeVisible();
    const taskReadRoute = (url: URL) =>
      url.pathname === `/api/tasks/${disposable.id}`;
    let deniedTaskReads = 0;
    const denyTask = async (route: Route) => {
      if (route.request().method() !== "GET") return route.continue();
      deniedTaskReads++;
      await route.fulfill({
        status: 403,
        contentType: "application/json",
        body: JSON.stringify({ error: "Task access was revoked" }),
      });
    };
    await page.route(taskReadRoute, denyTask);
    await page.getByLabel("Email", { exact: true }).fill(account.email);
    await page.getByLabel("Password", { exact: true }).fill(account.password);
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
    await expect(
      page.getByRole("heading", { name: "Task access required" }),
    ).toBeVisible();
    expect(deniedTaskReads).toBeGreaterThan(0);
    await rememberAdminSession(page);
    await expect(
      page.getByRole("heading", { name: disposable.title }),
    ).toHaveCount(0);
    await expect(comment).toBeHidden();
    await expect(editor).toBeHidden();
    await expect(
      page.getByRole("button", { name: "Task actions" }),
    ).toHaveCount(0);
    await page.unroute(taskReadRoute, denyTask);
    let releaseRetry!: () => void;
    let retryStarted!: () => void;
    let retryContinued!: () => void;
    const heldRetry = new Promise<void>((resolve) => (releaseRetry = resolve));
    const retryRequest = new Promise<void>(
      (resolve) => (retryStarted = resolve),
    );
    const continuedRetry = new Promise<void>(
      (resolve) => (retryContinued = resolve),
    );
    const holdRetry = async (route: Route) => {
      if (route.request().method() !== "GET") return route.continue();
      retryStarted();
      await heldRetry;
      try {
        await route.continue();
      } finally {
        retryContinued();
      }
    };
    await page.route(taskReadRoute, holdRetry);
    try {
      await page.getByRole("button", { name: "Try again" }).click();
      await retryRequest;
      await expect(
        page.getByRole("heading", { name: "Task access required" }),
      ).toBeVisible();
      await expect(
        page.getByRole("heading", { name: disposable.title }),
      ).toHaveCount(0);
      await expect(
        page.getByRole("button", { name: "Task actions" }),
      ).toHaveCount(0);
    } finally {
      releaseRetry();
      await continuedRetry;
      await page.unroute(taskReadRoute, holdRetry);
    }
    await expect(page.locator(".task-page-title")).toHaveText(
      "Private title pending on access loss",
    );
    await expect(editor).toBeVisible();
    await expect(title).toHaveValue("Private title pending on access loss");
    await expect(comment).toHaveValue("Private comment pending on access loss");

    const expiredForDeletion = await page.request.post("/api/auth/logout", {
      headers: { Origin: baseOrigin },
      data: {},
    });
    expect(expiredForDeletion.ok()).toBeTruthy();
    adminSessionCookies = [];
    await title.fill("Private title pending when task disappears");
    await expect(
      page.getByRole("heading", { name: "Sign in", exact: true }),
    ).toBeVisible();
    const latestTask = await deleter.get(`/api/tasks/${disposable.id}`);
    expect(latestTask.ok()).toBeTruthy();
    const version = (await latestTask.json()).task.version;
    const deleted = await deleter.delete(`/api/tasks/${disposable.id}`, {
      headers: { Origin: baseOrigin },
      data: { version },
    });
    expect(deleted.ok()).toBeTruthy();
    await page.getByLabel("Email", { exact: true }).fill(account.email);
    await page.getByLabel("Password", { exact: true }).fill(account.password);
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
    await expect(
      page.getByRole("heading", { name: "Task unavailable" }),
    ).toBeVisible();
    await rememberAdminSession(page);
    await expect(
      page.getByRole("heading", { name: disposable.title }),
    ).toHaveCount(0);
    await expect(
      page.getByText("Private comment pending on access loss"),
    ).toBeHidden();
    await expect(
      page.getByText("Private title pending when task disappears"),
    ).toBeHidden();
    await expect(editor).toBeHidden();
    await expect(
      page.getByRole("button", { name: "Task actions" }),
    ).toHaveCount(0);
    await page.getByRole("button", { name: "Go to boards" }).click();
    await expect(
      page.getByRole("heading", { name: "Release planning", exact: true }),
    ).toBeVisible();
  } finally {
    await deleter.dispose();
  }
});

test("invitations, viewer permissions, mentions, and personal API keys", async ({
  page,
  browser,
}) => {
  await page.goto(permissionsInvitationUrl);
  await page
    .getByLabel("Your Name", { exact: true })
    .fill("Permissions Review");
  await page
    .getByLabel("Password", { exact: true })
    .fill(permissionsAccount.password);
  await page
    .getByLabel("Confirm password", { exact: true })
    .fill(permissionsAccount.password);
  await page
    .getByRole("button", { name: "Accept invitation", exact: true })
    .click();
  await expect(
    page.getByRole("navigation", { name: "Workspace navigation" }),
  ).toBeVisible();
  const permissionsSession = await page.request.get("/api/auth/me");
  expect(permissionsSession.ok()).toBeTruthy();
  const permissionsIdentity = await permissionsSession.json();
  expect(permissionsIdentity.user.email).toBe(permissionsAccount.email);
  expect(permissionsIdentity.user.role).toBe("admin");
  expect(permissionsIdentity.workspace.id).toBe(workspaceId);
  const bindingBeforeEditResponse = await page.request.get(
    `/api/tasks/${taskId}`,
  );
  expect(bindingBeforeEditResponse.ok()).toBeTruthy();
  const bindingBeforeEdit = (await bindingBeforeEditResponse.json()).task;
  expect(bindingBeforeEdit).not.toHaveProperty("agentId");
  await page.goto(`/boards/${boardId}/tasks/${taskId}`);
  await expect(page.getByRole("button", { name: /Assignee$/ })).toContainText(
    "Unassigned",
  );
  await page.getByRole("button", { name: "Edit task details" }).click();
  const editor = page.getByRole("dialog", { name: "Edit task" });
  const title = editor.getByLabel("Title", { exact: true });
  await expect(title).toHaveValue(bindingBeforeEdit.title);
  const titleWrite = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === `/api/tasks/${taskId}` &&
      response.request().method() === "PATCH" &&
      response.request().postDataJSON().title,
  );
  await title.fill("Release plan reviewed by another human");
  const unrelatedEdit = await titleWrite;
  expect(unrelatedEdit.ok()).toBeTruthy();
  expect(unrelatedEdit.request().postDataJSON()).not.toHaveProperty("agentId");
  expect(unrelatedEdit.request().postDataJSON()).not.toHaveProperty(
    "assigneeId",
  );
  await editor.getByRole("button", { name: "Close", exact: true }).click();
  await choose(page, "Status", "In Review");
  await expect
    .poll(
      async () =>
        (await (await page.request.get(`/api/tasks/${taskId}`)).json()).task
          .status,
    )
    .toBe("in_review");
  const bindingAfterEdit = (
    await (await page.request.get(`/api/tasks/${taskId}`)).json()
  ).task;
  expect(bindingAfterEdit.title).toBe("Release plan reviewed by another human");
  expect(bindingAfterEdit).not.toHaveProperty("agentId");
  expect(bindingAfterEdit.assigneeId).toBeNull();
  await page.goto("/settings/members");
  await page
    .getByRole("button", { name: "Invite a person", exact: true })
    .click();
  await page
    .getByLabel("Email", { exact: true })
    .fill("browser-viewer@example.test");
  await choose(page, "Role", "Viewer");
  const invitationResponse = page.waitForResponse(
    (r) =>
      r.url().endsWith("/api/auth/invitations") &&
      r.request().method() === "POST",
  );
  await page.getByRole("button", { name: "Create invitation" }).click();
  const invitation = await (await invitationResponse).json();
  await expect(
    page
      .getByRole("dialog")
      .getByRole("heading", { name: "Invitation link", exact: true }),
  ).toBeVisible();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Done", exact: true })
    .click();
  const viewerContext = await browser.newContext({ baseURL: baseOrigin });
  const viewer = await viewerContext.newPage();
  await viewer.goto(invitation.inviteUrl);
  await viewer.getByLabel("Your Name", { exact: true }).fill("Jamie Viewer");
  await viewer
    .getByLabel("Password", { exact: true })
    .fill("Viewer-only-password-42");
  await viewer
    .getByLabel("Confirm password", { exact: true })
    .fill("Viewer-only-password-42");
  await viewer.getByRole("button", { name: "Accept invitation" }).click();
  await expect(viewer).toHaveURL("/boards");
  await viewer.goto(`/boards/${boardId}`);
  await expect(
    viewer.getByRole("heading", { name: "Release planning" }),
  ).toBeVisible();
  await expect(
    viewer.getByRole("button", { name: "New task", exact: true }),
  ).toHaveCount(0);
  const viewerUser = await viewer.request
    .get("/api/auth/me")
    .then((r) => r.json());
  await viewer.goto(`/boards/${boardId}/tasks/${taskId}`);
  await expect(
    viewer.getByRole("heading", {
      name: "Release plan reviewed by another human",
    }),
  ).toBeVisible();
  await expect(
    viewer.getByRole("button", { name: "Edit task details" }),
  ).toHaveCount(0);
  const original = await page.request
    .get(`/api/tasks/${taskId}`)
    .then((r) => r.json());
  const reassigned = await page.request.patch(`/api/tasks/${taskId}`, {
    headers: { Origin: baseOrigin },
    data: {
      version: original.task.version,
      assigneeId: viewerUser.user.id,
    },
  });
  expect(reassigned.ok()).toBeTruthy();
  await page.goto(`/boards/${boardId}/tasks/${taskId}`);
  await page.getByLabel("Add a comment").fill("Please review @Jamie");
  const mentions = page.getByRole("listbox", { name: "Mention a person" });
  await expect(
    mentions.getByRole("option", { name: "Jamie Viewer" }),
  ).toBeVisible();
  await mentions.getByRole("option", { name: "Jamie Viewer" }).click();
  await expect(page.getByLabel("Add a comment")).toHaveValue(
    "Please review @Jamie Viewer ",
  );
  await page.getByRole("button", { name: "Send comment", exact: true }).click();
  await expect(
    page.locator(".task-comment").filter({ hasText: "Please review" }),
  ).toBeVisible();
  await viewer.goto(`/boards/${boardId}`);
  await viewer
    .getByRole("button", { name: "Open notifications", exact: true })
    .click();
  const notifications = viewer.getByRole("list", {
    name: "Notification list",
    exact: true,
  });
  await expect(notifications.getByRole("listitem")).toHaveCount(2);
  await expect(notifications.getByText("Unread", { exact: true })).toHaveCount(
    2,
  );
  const marked = viewer.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === "/api/notifications" &&
      response.request().method() === "PATCH",
  );
  await viewer.getByRole("button", { name: "Mark all read" }).click();
  expect((await marked).ok()).toBeTruthy();
  await expect(notifications.getByText("Unread", { exact: true })).toHaveCount(
    0,
  );
  await expect(notifications.getByText("Read", { exact: true })).toHaveCount(2);
  const persisted = await viewer.request.get("/api/notifications");
  expect(persisted.ok()).toBeTruthy();
  const notificationPage = await persisted.json();
  expect(notificationPage.unreadCount).toBe(0);
  expect(notificationPage.items).toHaveLength(2);
  expect(
    notificationPage.items.every(
      (item: { readAt: string | null }) => item.readAt,
    ),
  ).toBe(true);
  await viewer.goto(`/boards/${boardId}/tasks/${taskId}`);
  await expect(
    viewer.getByRole("button", { name: "Edit task details" }),
  ).toHaveCount(0);
  await expect(
    viewer.getByRole("button", { name: "Send comment" }),
  ).toHaveCount(0);
  await viewerContext.close();
  await page.goto("/settings/api-keys");
  await page
    .getByRole("button", { name: "Create API key", exact: true })
    .click();
  const keyForm = page.getByRole("dialog", {
    name: "Create API key",
    exact: true,
  });
  await keyForm.getByLabel("Name", { exact: true }).fill("Review automation");
  const expiry = keyForm.getByRole("button", { name: /Expires after\*$/ });
  await expiry.click();
  await page.getByRole("option", { name: "60 days", exact: true }).click();
  await expect(expiry).toContainText("60 days");
  await expect(page.getByRole("listbox")).toBeHidden();
  for (const removedLabel of ["Agent", "Access", "Board access"])
    await expect(
      keyForm.getByRole("button", { name: new RegExp(`${removedLabel}$`) }),
    ).toHaveCount(0);
  const keyCreationResponse = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === "/api/credentials" &&
      response.request().method() === "POST",
  );
  await keyForm
    .getByRole("button", { name: "Create key", exact: true })
    .click();
  const keyCreation = await keyCreationResponse;
  expect(keyCreation.status()).toBe(201);
  expect(keyCreation.request().postDataJSON()).toEqual({
    name: "Review automation",
    expiresInDays: 60,
  });
  const createdKey = (await keyCreation.json()).credential;
  expect(createdKey).not.toHaveProperty("agentId");
  expect(createdKey).not.toHaveProperty("agentName");
  expect(createdKey.boardIds).toBeNull();
  expect(createdKey.scopes).toEqual([]);
  expect(createdKey.tokenType).toBe("api-key");
  const copyKey = page.getByRole("dialog", {
    name: "Copy your API key",
    exact: true,
  });
  const revealedKey = copyKey.locator('[data-slot="code-block-code"] code');
  await expect(revealedKey).toBeVisible();
  const token = (await revealedKey.innerText()).trim();
  expect(token.length, "A new credential is revealed once").toBeGreaterThan(0);
  await expect(
    copyKey.getByRole("button", { name: "Done", exact: true }),
  ).toBeFocused();
  await copyKey.getByRole("button", { name: "Done", exact: true }).click();
  await expect(copyKey).toBeHidden();
  const personalKey = await request.newContext({
    baseURL: baseOrigin,
    extraHTTPHeaders: { Authorization: `Bearer ${token}`, Origin: baseOrigin },
  });
  try {
    const readableBoards = await personalKey.get("/api/boards");
    expect(readableBoards.ok()).toBeTruthy();
    expect(
      (await readableBoards.json()).items.some(
        (board: { id: string }) => board.id === boardId,
      ),
    ).toBe(true);
    const beforeKeyEditResponse = await personalKey.get(`/api/tasks/${taskId}`);
    expect(beforeKeyEditResponse.ok()).toBeTruthy();
    const beforeKeyEdit = (await beforeKeyEditResponse.json()).task;
    const humanEditResponse = await personalKey.patch(`/api/tasks/${taskId}`, {
      data: { version: beforeKeyEdit.version, status: "done" },
    });
    expect(humanEditResponse.ok()).toBeTruthy();
    const humanEdit = (await humanEditResponse.json()).task;
    expect(humanEdit.status).toBe("done");
    expect(humanEdit.assigneeId).toBe(viewerUser.user.id);
    expect(humanEdit).not.toHaveProperty("agentId");
    const historyResponse = await personalKey.get(
      `/api/tasks/${taskId}/activity`,
    );
    expect(historyResponse.ok()).toBeTruthy();
    const history = (await historyResponse.json()).items;
    expect(history[0].actorId).toBe(permissionsIdentity.user.id);
    expect(history[0].actorName).toBe(permissionsIdentity.user.name);
    expect(history[0].actorKind).toBe("human");
    const forbiddenKeyCreation = await personalKey.post("/api/credentials", {
      data: { name: "A key cannot mint another key", expiresInDays: 30 },
    });
    expect(forbiddenKeyCreation.status()).toBe(403);
    const forbiddenSettings = await personalKey.patch("/api/workspace", {
      data: { name: "A key cannot change team settings" },
    });
    expect(forbiddenSettings.status()).toBe(403);
    const unchangedWorkspace = await page.request.get("/api/auth/me");
    expect(unchangedWorkspace.ok()).toBeTruthy();
    expect((await unchangedWorkspace.json()).workspace.name).toBe(
      permissionsIdentity.workspace.name,
    );
    const forbiddenMcp = await personalKey.post("/mcp", {
      data: { jsonrpc: "2.0", id: 1, method: "tools/list" },
    });
    expect(forbiddenMcp.status()).toBe(403);
    const credentialRow = page
      .getByRole("grid", { name: "API keys", exact: true })
      .getByRole("row")
      .filter({ has: page.getByText("Review automation", { exact: true }) });
    await credentialRow
      .getByRole("button", { name: "Revoke", exact: true })
      .click();
    const revokedDialog = page.getByRole("dialog", {
      name: "Revoke Review automation?",
      exact: true,
    });
    await revokedDialog
      .getByRole("button", { name: "Revoke key", exact: true })
      .click();
    await expect(revokedDialog).toHaveCount(0);
    await expect(
      page
        .locator('[data-slot="toast"]:not([data-exiting="true"])')
        .getByText("Access revoked.", { exact: true }),
    ).toBeVisible();
    await expect(credentialRow).toHaveCount(0);
    await expect(
      credentialRow.getByRole("button", {
        name: "Revoke",
        exact: true,
      }),
    ).toHaveCount(0);
    const credentialsResponse = await page.request.get("/api/credentials");
    expect(credentialsResponse.ok()).toBeTruthy();
    const credentialsPage = await credentialsResponse.json();
    const credential = credentialsPage.items.find(
      (item: { id: string }) => item.id === createdKey.id,
    );
    expect(credential).toBeUndefined();
    expect(
      credentialsPage.items.some(
        (item: { name: string }) =>
          item.name === "A key cannot mint another key",
      ),
    ).toBe(false);
    const revokedRead = await personalKey.get(`/api/boards/${boardId}/tasks`);
    expect(revokedRead.status()).toBe(401);
    await page.reload();
    await expect(
      page.getByRole("heading", { name: "API keys", exact: true, level: 1 }),
    ).toBeVisible();
    await expect(credentialRow).toHaveCount(0);
  } finally {
    await personalKey.dispose();
  }
});

test("a different person cannot inherit an expired task draft", async ({
  page,
}) => {
  await login(page);
  await page.goto(`/boards/${boardId}/tasks/${taskId}`);
  const unsent = page.getByLabel("Add a comment", { exact: true });
  await unsent.fill("Private comment draft from Alex");
  await page.getByRole("button", { name: "Edit task details" }).click();
  const editor = page.getByRole("dialog", { name: "Edit task" });
  const title = editor.getByLabel("Title", { exact: true });
  await page.request.post("/api/auth/logout", {
    headers: { Origin: baseOrigin },
    data: {},
  });
  adminSessionCookies = [];
  await title.fill("Private title draft from Alex");
  await expect(
    page.getByRole("heading", { name: "Sign in", exact: true }),
  ).toBeVisible();
  await page
    .getByLabel("Email", { exact: true })
    .fill(permissionsAccount.email);
  await page
    .getByLabel("Password", { exact: true })
    .fill(permissionsAccount.password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(
    page.getByRole("navigation", { name: "Workspace navigation" }),
  ).toBeVisible();
  await expect(page).not.toHaveURL(/\/tasks\//);
  await expect(editor).toHaveCount(0);
  await expect(page.getByText("Private comment draft from Alex")).toHaveCount(
    0,
  );
  await expect(page.getByText("Private title draft from Alex")).toHaveCount(0);
  await page.goto(`/boards/${boardId}`);
  await expect(
    page.getByRole("heading", { name: "Release planning" }),
  ).toBeVisible();
});

test("task deletion removes discussion permanently, retains other tasks, and retries safely", async ({
  page,
}) => {
  await page.goto(lifecycleInvitationUrl);
  await page.getByLabel("Your Name", { exact: true }).fill("Lifecycle Review");
  await page
    .getByLabel("Password", { exact: true })
    .fill(lifecycleAccount.password);
  await page
    .getByLabel("Confirm password", { exact: true })
    .fill(lifecycleAccount.password);
  await page
    .getByRole("button", { name: "Accept invitation", exact: true })
    .click();
  await expect(
    page.getByRole("navigation", { name: "Workspace navigation" }),
  ).toBeVisible();
  const sessionResponse = await page.request.get("/api/auth/me");
  expect(sessionResponse.ok()).toBeTruthy();
  const session = await sessionResponse.json();
  expect(session.user.email).toBe(lifecycleAccount.email);
  expect(session.user.role).toBe("admin");
  expect(session.workspace.id).toBe(workspaceId);
  expect(session.workspace.name).toBe(account.workspaceName);
  const createTask = async (title: string) => {
    const response = await page.request.post(`/api/boards/${boardId}/tasks`, {
      headers: { Origin: baseOrigin },
      data: { title, assigneeId: session.user.id },
    });
    expect(response.ok()).toBeTruthy();
    return (await response.json()).task;
  };
  const disposable = await createTask("Task to delete permanently");
  const retainedTask = await createTask(
    "Independent task remains after deletion",
  );
  const ids = [disposable.id];
  for (const id of ids) {
    const comment = await page.request.post(`/api/tasks/${id}/comments`, {
      headers: { Origin: baseOrigin },
      data: { body: `Discussion for deletion @${account.email}` },
    });
    expect(comment.ok()).toBeTruthy();
  }
  const { database, schema } = await browserDatabase();
  try {
    for (const table of ["comments", "activity", "notifications"]) {
      const existing = await database.unsafe(
        `SELECT id FROM "${schema}".${table} WHERE task_id=ANY($1::uuid[])`,
        [ids],
      );
      expect(existing.length).toBeGreaterThan(0);
    }
    await page.goto(`/boards/${boardId}/tasks/${disposable.id}`);
    await expect(
      page.getByRole("button", { name: "Archive task", exact: true }),
    ).toHaveCount(0);
    const draft = page.getByLabel("Add a comment", { exact: true });
    await draft.fill("A comment that must not be lost by deletion");
    const deleteRequests: string[] = [];
    page.on("request", (request) => {
      if (
        request.method() === "DELETE" &&
        new URL(request.url()).pathname === `/api/tasks/${disposable.id}`
      )
        deleteRequests.push(request.url());
    });
    await page.getByRole("button", { name: "Task actions" }).click();
    await page.getByRole("menuitem", { name: "Delete task" }).click();
    const confirmation = page.getByRole("dialog", {
      name: "Delete this task?",
      exact: true,
    });
    await expect(confirmation).toHaveCount(0);
    await expect(
      page.locator('[data-slot="toast"]').filter({ hasText: "unsent comment" }),
    ).toBeVisible();
    await expect(draft).toHaveValue(
      "A comment that must not be lost by deletion",
    );
    expect(deleteRequests).toHaveLength(0);
    await page.getByRole("button", { name: "Clear draft" }).click();
    await expect(draft).toHaveValue("");
    await page.getByRole("button", { name: "Task actions" }).click();
    await page.getByRole("menuitem", { name: "Delete task" }).click();
    await expect(confirmation).toContainText("its comments and history");
    await expect(confirmation).toContainText("cannot be undone");
    await confirmation
      .getByRole("button", { name: "Cancel", exact: true })
      .click();
    await expect(confirmation).toBeHidden();
    await expect(
      page.getByRole("button", { name: "Task actions" }),
    ).toBeFocused();
    await page.getByRole("button", { name: "Task actions" }).click();
    await page.getByRole("menuitem", { name: "Delete task" }).click();
    let deletionKey: string | undefined;
    const failure = async (route: Route) => {
      if (route.request().method() !== "DELETE") return route.continue();
      deletionKey = route.request().headers()["idempotency-key"];
      await route.fulfill({
        status: 500,
        contentType: "application/json",
        body: JSON.stringify({
          error: "Task deletion temporarily unavailable",
        }),
      });
    };
    await page.route(`**/api/tasks/${disposable.id}`, failure);
    await confirmation
      .getByRole("button", { name: "Delete task", exact: true })
      .click();
    await expect(
      page
        .locator('[data-slot="toast"]')
        .filter({ hasText: "Task deletion temporarily unavailable" }),
    ).toContainText("Task deletion temporarily unavailable");
    expect(deletionKey).toBeTruthy();
    expect(
      (await page.request.get(`/api/tasks/${disposable.id}`)).ok(),
    ).toBeTruthy();
    await page.unroute(`**/api/tasks/${disposable.id}`, failure);
    let release!: () => void;
    let started!: () => void;
    let continued!: () => void;
    const pending = new Promise<void>((resolve) => (release = resolve));
    const requestStarted = new Promise<void>((resolve) => (started = resolve));
    const requestContinued = new Promise<void>(
      (resolve) => (continued = resolve),
    );
    const delayed = async (route: Route) => {
      if (route.request().method() !== "DELETE") return route.continue();
      expect(route.request().headers()["idempotency-key"]).toBe(deletionKey);
      started();
      await pending;
      try {
        await route.continue();
      } finally {
        continued();
      }
    };
    await page.route(`**/api/tasks/${disposable.id}`, delayed);
    const deletion = page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === `/api/tasks/${disposable.id}` &&
        response.request().method() === "DELETE",
    );
    try {
      await confirmation
        .getByRole("button", { name: "Delete task", exact: true })
        .click();
      await requestStarted;
      await expect(
        confirmation.getByRole("button", { name: "Cancel", exact: true }),
      ).toBeDisabled();
      await expect(
        confirmation.getByRole("button", { name: "Close", exact: true }),
      ).toBeDisabled();
      await expect(
        page.getByRole("button", { name: "Task actions" }),
      ).toBeDisabled();
      await page.keyboard.press("Escape");
      await expect(confirmation).toBeVisible();
    } finally {
      release();
      await requestContinued;
      await page.unroute(`**/api/tasks/${disposable.id}`, delayed);
    }
    expect(await (await deletion).json()).toEqual({ ok: true });
    await expect(page).toHaveURL(`/boards/${boardId}`);
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect(
      page
        .getByRole("grid", { name: "Task list" })
        .getByRole("link")
        .filter({ hasText: "Task to delete permanently" }),
    ).toHaveCount(0);
    for (const id of ids)
      expect((await page.request.get(`/api/tasks/${id}`)).status()).toBe(404);
    const retainedResponse = await page.request.get(
      `/api/tasks/${retainedTask.id}`,
    );
    expect(retainedResponse.ok()).toBeTruthy();
    expect((await retainedResponse.json()).task.title).toBe(
      "Independent task remains after deletion",
    );
    await expect(page.getByRole("grid", { name: "Task list" })).toContainText(
      "Independent task remains after deletion",
    );
    await expect(
      page.getByRole("button", { name: "New task", exact: true }),
    ).toBeFocused();
    for (const table of ["tasks", "comments", "activity", "notifications"]) {
      const rows = await database.unsafe(
        `SELECT id FROM "${schema}".${table} WHERE ${table === "tasks" ? "id" : "task_id"}=ANY($1::uuid[])`,
        [ids],
      );
      expect(rows).toHaveLength(0);
    }
  } finally {
    await database.end();
  }
});

test("board settings keep detail failures recoverable and delete boards permanently", async ({
  page,
}) => {
  await login(page, lifecycleAccount);
  await page.goto(`/boards/${boardId}`);
  await openBoardAction(page, "Board settings");
  const settings = page.getByRole("dialog").filter({
    has: page.getByRole("heading", { name: "Board settings", exact: true }),
  });
  await expect(settings.getByLabel("Task prefix", { exact: true })).toHaveCount(
    0,
  );
  await expect(settings).not.toContainText("The prefix stays fixed");
  await expect(
    settings.getByRole("button", { name: "Delete board", exact: true }),
  ).toHaveCount(0);
  await expect(
    settings.getByRole("heading", { name: "Board details", exact: true }),
  ).toHaveCount(0);
  await expect(settings.getByLabel("New status", { exact: true })).toHaveCount(
    0,
  );
  await expect(settings.getByLabel("Status name", { exact: true })).toHaveCount(
    0,
  );
  await expect(
    settings.getByRole("button", { name: /Board order$/ }),
  ).toHaveCount(0);
  const description = settings.getByLabel("Description", { exact: true });
  await description.fill("A recoverable board settings draft");
  const saveBoard = settings.getByRole("button", {
    name: "Save board",
    exact: true,
  });
  const buttonBounds = (await saveBoard.boundingBox())!;
  const dialogBounds = (await settings.boundingBox())!;
  const bottomGap =
    dialogBounds.y + dialogBounds.height - buttonBounds.y - buttonBounds.height;
  expect(bottomGap).toBeGreaterThanOrEqual(20);
  expect(bottomGap).toBeLessThanOrEqual(24);
  const failure = async (route: Route) => {
    if (route.request().method() !== "PATCH") return route.continue();
    await route.fulfill({
      status: 500,
      contentType: "application/json",
      body: JSON.stringify({ error: "Board update temporarily unavailable" }),
    });
  };
  await page.route(`**/api/boards/${boardId}`, failure);
  await saveBoard.click();
  await expect(
    page
      .locator('[data-slot="toast"]')
      .filter({ hasText: "Board update temporarily unavailable" }),
  ).toContainText("Board update temporarily unavailable");
  await expect(description).toHaveValue("A recoverable board settings draft");
  await expect(settings).toBeVisible();
  await expect(saveBoard).toBeFocused();
  await page.unroute(`**/api/boards/${boardId}`, failure);
  await submitSettingsWhilePending(
    page,
    `/boards/${boardId}`,
    "PATCH",
    saveBoard,
    async () => {
      await expect(description).toBeEnabled();
      await description.click();
      await expect(description).toBeFocused();
    },
  );
  await expect(page.getByText("Board updated.", { exact: true })).toBeVisible();
  await expect(description).toBeFocused();
  const savedDetails = await page.request
    .get(`/api/boards/${boardId}`)
    .then((response) => response.json());
  expect(savedDetails.board.description).toBe(
    "A recoverable board settings draft",
  );
  await expect(
    settings.getByRole("button", { name: "Archive board", exact: true }),
  ).toHaveCount(0);
  await settings
    .getByRole("button", { name: "Close dialog", exact: true })
    .click();
  await expect(page.getByRole("grid", { name: "Task list" })).toContainText(
    "Test database restore",
  );
  await expect(
    page.getByText("A recoverable board settings draft", { exact: true }),
  ).toHaveCount(0);
  const created = await page.request.post("/api/boards", {
    headers: { Origin: baseOrigin },
    data: { name: "Board to delete permanently", prefix: "DELBOARD" },
  });
  expect(created.ok()).toBeTruthy();
  const disposable = (await created.json()).board;
  const rootTaskResponse = await page.request.post(
    `/api/boards/${disposable.id}/tasks`,
    {
      headers: { Origin: baseOrigin },
      data: { title: "Board deletion first task" },
    },
  );
  expect(rootTaskResponse.ok()).toBeTruthy();
  const rootTask = (await rootTaskResponse.json()).task;
  const childResponse = await page.request.post(
    `/api/boards/${disposable.id}/tasks`,
    {
      headers: { Origin: baseOrigin },
      data: { title: "Board deletion second task" },
    },
  );
  expect(childResponse.ok()).toBeTruthy();
  const child = (await childResponse.json()).task;
  const commentResponse = await page.request.post(
    `/api/tasks/${child.id}/comments`,
    {
      headers: { Origin: baseOrigin },
      data: { body: `Delete this board discussion @${account.email}` },
    },
  );
  expect(commentResponse.ok()).toBeTruthy();
  await page.goto(`/boards/${disposable.id}`);
  await openBoardAction(page, "Delete board");
  const deletion = page.getByRole("dialog", {
    name: "Delete board?",
    exact: true,
  });
  await expect(deletion).toContainText("all of its tasks and comments");
  await expect(deletion).toContainText("There is no restore");
  await deletion.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Board actions", exact: true }),
  ).toBeFocused();
  await openBoardAction(page, "Delete board");
  const boardDeletion = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === `/api/boards/${disposable.id}` &&
      response.request().method() === "DELETE",
  );
  await submitSettingsWhilePending(
    page,
    `/boards/${disposable.id}`,
    "DELETE",
    deletion.getByRole("button", { name: "Delete board", exact: true }),
    async () => {
      await expect(
        deletion.getByRole("button", { name: "Cancel", exact: true }),
      ).toBeDisabled();
      await expect(
        deletion.getByRole("button", { name: "Close", exact: true }),
      ).toBeDisabled();
      await expect(deletion).toBeVisible();
    },
    "Delete board?",
  );
  expect(await (await boardDeletion).json()).toEqual({ ok: true });
  await expect(page).toHaveURL("/boards");
  await expect(
    page.getByRole("heading", { name: "Boards", exact: true }),
  ).toBeVisible();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  const nav = page.getByRole("main");
  await expect(
    nav.getByRole("link", { name: disposable.name, exact: true }),
  ).toHaveCount(0);
  await nav.getByRole("link", { name: "Release planning" }).click();
  await expect(page).toHaveURL(`/boards/${boardId}`);
  expect(
    (await page.request.get(`/api/boards/${disposable.id}`)).status(),
  ).toBe(404);
  const { database, schema } = await browserDatabase();
  try {
    for (const table of ["boards", "tasks", "activity"]) {
      const rows = await database.unsafe(
        `SELECT id FROM "${schema}".${table} WHERE ${table === "boards" ? "id" : "board_id"}=$1`,
        [disposable.id],
      );
      expect(rows).toHaveLength(0);
    }
    for (const table of ["comments", "notifications"]) {
      const rows = await database.unsafe(
        `SELECT id FROM "${schema}".${table} WHERE task_id=ANY($1::uuid[])`,
        [[rootTask.id, child.id]],
      );
      expect(rows).toHaveLength(0);
    }
  } finally {
    await database.end();
  }
});

test("long content, fixed statuses, tablet/phone themes and operational errors", async ({
  page,
}) => {
  const accepted = await page.request.post("/api/auth/accept-invitation", {
    headers: { Origin: baseOrigin },
    data: {
      token: layoutInvitationToken,
      name: "Morgan Review",
      password: "Layout-only-password-42",
    },
  });
  expect(accepted.ok()).toBeTruthy();
  await page.goto(`/boards/${boardId}`);
  await expect(
    page.getByRole("heading", { name: "Release planning" }),
  ).toBeVisible();
  const current = await page.request
    .get(`/api/tasks/${taskId}`)
    .then((r) => r.json());
  await page.request.patch(`/api/tasks/${taskId}`, {
    headers: { Origin: baseOrigin },
    data: {
      version: current.task.version,
      title:
        "A long task title that explains the exact work and remains readable across phone tablet and desktop layouts without hiding the task identifier",
      description: (
        "# Scope\n\n" +
        "Detailed review context and links. ".repeat(12) +
        "\n\n"
      ).repeat(8),
    },
  });
  await page.goto(`/boards/${boardId}/tasks/${taskId}`);
  await page.getByRole("button", { name: /Status$/ }).click();
  const list = page.getByRole("listbox");
  await expect(list).toBeVisible();
  await expect(list.getByRole("option")).toHaveText([
    "Backlog",
    "Todo",
    "In Progress",
    "In Review",
    "Done",
    "Won't Do",
  ]);
  await page.screenshot({
    path: "docs/screenshots/task-overlay-light.png",
    fullPage: true,
    animations: "disabled",
  });
  await page.keyboard.press("Escape");
  await expect(
    page.getByRole("heading", { name: /A long task title/ }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Add checklist item" }),
  ).toHaveCount(0);
  for (const [width, height, theme, name] of [
    [1024, 768, "light", "tablet-light"],
    [1024, 768, "dark", "tablet-dark"],
    [390, 844, "light", "mobile-light"],
    [390, 844, "dark", "mobile-dark"],
  ] as const) {
    await page.setViewportSize({ width, height });
    const toggle = page.getByRole("button", {
      name:
        theme === "light"
          ? "Appearance: switch to light theme"
          : "Appearance: switch to dark theme",
    });
    if (await toggle.isVisible()) await toggle.click();
    await expect(
      page.getByRole("heading", { name: /A long task title/ }),
    ).toBeVisible();
    await page.screenshot({
      path: `docs/screenshots/${name}.png`,
      fullPage: true,
      animations: "disabled",
    });
    await expect
      .poll(() => page.evaluate(() => document.documentElement.scrollWidth))
      .toBeLessThanOrEqual(width);
  }
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.getByRole("button", { name: "Back to board" }).click();
  await page.route(`**/api/boards/${boardId}/tasks?**`, (route) =>
    route.abort(),
  );
  await page.reload();
  const networkError = page
    .getByRole("main")
    .locator("section")
    .filter({
      has: page.getByRole("heading", {
        name: "Board unavailable",
        exact: true,
      }),
    });
  await expect(networkError).toBeVisible();
  await expect(networkError.getByText("500", { exact: true })).toHaveCount(0);
  await expect(
    networkError.getByText("Connection", { exact: true }),
  ).toBeVisible();
  await expect(
    page.locator('[data-slot="toast"]').filter({
      hasText:
        "Mill could not be reached. Check your connection and try again.",
    }),
  ).toBeVisible();
  await expect(
    networkError.getByRole("button", { name: "Try again", exact: true }),
  ).toBeVisible();
  await page.screenshot({
    path: "docs/screenshots/network-error.png",
    fullPage: true,
    animations: "disabled",
  });
  await page.unroute(`**/api/boards/${boardId}/tasks?**`);
  await networkError
    .getByRole("button", { name: "Try again", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "Release planning" }),
  ).toBeVisible();
});

async function browserDatabase() {
  if (!process.env.DATABASE_URL) process.loadEnvFile(".env");
  const meta = JSON.parse(
    await readFile(
      `tmp/browser-${new URL(baseOrigin).port}-schema.json`,
      "utf8",
    ),
  ) as { schema: string; baseURL: string };
  expect(meta.schema).toMatch(/^browser_[a-f0-9]{16}$/);
  expect(new URL(meta.baseURL).origin).toBe(new URL(baseOrigin).origin);
  const database = postgres(process.env.DATABASE_URL!, { max: 1 });
  const fixture = await database.unsafe(
    `SELECT id FROM "${meta.schema}".tasks WHERE id=$1`,
    [taskId],
  );
  expect(fixture).toHaveLength(1);
  return { database, schema: meta.schema };
}
test("large-board pagination keeps URL state, recovers a changed page and supports long member selects", async ({
  page,
}, testInfo) => {
  await login(page, {
    email: "browser-layout@example.test",
    password: "Layout-only-password-42",
  });
  const { database, schema } = await browserDatabase();
  let seededTaskIds: string[] = [];
  try {
    await database.begin(async (tx) => {
      await tx.unsafe(
        `INSERT INTO "${schema}".users(id,workspace_id,name,email,password_hash,role) SELECT gen_random_uuid(),u.workspace_id,'Reviewer '||lpad(i::text,3,'0'),'reviewer-'||i||'@example.test',u.password_hash,'viewer' FROM "${schema}".users u CROSS JOIN generate_series(1,20) i WHERE u.email='browser-layout@example.test'`,
      );
      const [board] = await tx.unsafe(
        `SELECT prefix,next_number FROM "${schema}".boards WHERE id=$1 FOR UPDATE`,
        [boardId],
      );
      const seeded = await tx.unsafe(
        `INSERT INTO "${schema}".tasks(board_id,status,identifier,title,created_by) SELECT $1,'todo',$2||'-'||($3::int+i-1),'Scale task '||lpad(i::text,3,'0'),u.id FROM "${schema}".users u CROSS JOIN generate_series(1,105) i WHERE u.email='browser-layout@example.test' RETURNING id`,
        [boardId, board.prefix, board.next_number],
      );
      seededTaskIds = seeded.map((row) => row.id);
      await tx.unsafe(
        `UPDATE "${schema}".boards SET next_number=next_number+105 WHERE id=$1`,
        [boardId],
      );
    });
  } finally {
    await database.end();
  }
  const denseStartAt = Date.now();
  await page.goto(`/boards/${boardId}`);
  await page.getByLabel("Search tasks").fill("Scale task");
  await choose(page, "Sort order", "Title");
  const taskLinks = page
    .getByRole("grid", { name: "Task list" })
    .getByRole("link", { name: /^Scale task / });
  await expect(taskLinks).toHaveCount(25);
  const initialPageReadyMs = Date.now() - denseStartAt;
  await expect(
    page
      .getByRole("navigation", { name: "Task pages" })
      .getByRole("button", { name: "Go to page 1" }),
  ).toHaveAttribute("aria-current", "page");
  await expect(page).toHaveURL(new RegExp(`q=Scale\\+task.*sort=title`));
  await page.getByRole("button", { name: "Next page" }).click();
  await expect(page).toHaveURL(new RegExp(`page=2`));
  await expect(taskLinks).toHaveCount(25);
  await expect(taskLinks.first()).toContainText("Scale task 026");
  await page.reload();
  await expect(page.getByLabel("Search tasks")).toHaveValue("Scale task");
  await expect(taskLinks.first()).toContainText("Scale task 026");
  await choose(page, "Tasks per page", "100 per page");
  const hundredPageStartAt = Date.now();
  await expect(page).toHaveURL(new RegExp(`limit=100`));
  await expect(page).not.toHaveURL(/page=2/);
  await expect(taskLinks).toHaveCount(100);
  const hundredRowsReadyMs = Date.now() - hundredPageStartAt;
  await page.getByRole("button", { name: "Next page" }).click();
  await expect(taskLinks).toHaveCount(5);
  await expect(taskLinks.last()).toContainText("Scale task 105");
  const pageTwoHref = await taskLinks.last().getAttribute("href");
  expect(pageTwoHref).toContain("page=2");
  await taskLinks.last().click();
  await expect(
    page.getByRole("heading", { name: "Scale task 105" }),
  ).toBeVisible();
  await expect(page).toHaveURL(new RegExp(`page=2.*limit=100`));
  await page.getByRole("button", { name: /Assignee$/ }).click();
  const members = page.getByRole("listbox");
  await members.hover();
  await page.mouse.wheel(0, 650);
  await expect
    .poll(() => members.evaluate((el) => el.scrollTop))
    .toBeGreaterThan(0);
  await page
    .getByRole("searchbox", { name: "Search assignee" })
    .fill("Reviewer 020");
  await page.getByRole("option", { name: "Reviewer 020", exact: true }).click();
  await expect(page.getByRole("button", { name: /Assignee$/ })).toContainText(
    "Reviewer 020",
  );
  await expect
    .poll(
      async () =>
        (
          await (
            await page.request.get(
              `/api/tasks/${new URL(page.url()).pathname.split("/tasks/")[1]}`,
            )
          ).json()
        ).task.assigneeId,
    )
    .not.toBeNull();
  await page.getByRole("button", { name: "Edit task details" }).click();
  const edit = page.getByRole("dialog", { name: "Edit task" });
  await edit
    .getByLabel("Title", { exact: true })
    .fill("Scale task 105 reviewed");
  await edit.getByRole("button", { name: "Close", exact: true }).click();
  await page.getByRole("button", { name: "Back to board" }).click();
  await expect(page).toHaveURL(new RegExp(`page=2.*limit=100`));
  await expect(taskLinks.last()).toContainText("Scale task 105 reviewed");
  await page.getByRole("button", { name: "Previous page" }).click();
  await expect(taskLinks).toHaveCount(100);
  const displayedIds = await taskLinks.evaluateAll((links) =>
    links.map(
      (link) =>
        new URL(link.getAttribute("href")!, location.origin).pathname.split(
          "/tasks/",
        )[1],
    ),
  );
  expect(new Set(displayedIds).size).toBe(100);
  expect(displayedIds.every((id) => seededTaskIds.includes(id))).toBe(true);
  await expect(page.getByLabel("Search tasks")).toHaveValue("Scale task");
  await testInfo.attach("dense-board-interactions.json", {
    body: Buffer.from(
      JSON.stringify({
        viewport: "1280x720",
        seededTasks: seededTaskIds.length,
        seededAdditionalMembers: 20,
        initialFilteredPageReadyMs: initialPageReadyMs,
        hundredRowsReadyMs,
        verifiedPageSize: displayedIds.length,
      }),
    ),
    contentType: "application/json",
  });
});
test("a real isolated database fault renders 500 and reload recovery", async ({
  page,
}) => {
  await login(page, {
    email: "browser-layout@example.test",
    password: "Layout-only-password-42",
  });
  const { database, schema } = await browserDatabase();
  let renamed = false;
  try {
    await database.unsafe(
      `ALTER TABLE "${schema}".tasks RENAME TO tasks_fault`,
    );
    renamed = true;
    await page.goto(`/boards/${boardId}`);
    await expect(
      page.getByRole("heading", { name: "Mill could not load this page" }),
    ).toBeVisible();
    const serverError = page
      .getByRole("main")
      .locator("section")
      .filter({
        has: page.getByRole("heading", {
          name: "Mill could not load this page",
          exact: true,
        }),
      });
    await expect(serverError.getByText("500", { exact: true })).toBeVisible();
    await page.screenshot({
      path: "docs/screenshots/server-error.png",
      fullPage: true,
      animations: "disabled",
    });
  } finally {
    if (renamed)
      await database.unsafe(
        `ALTER TABLE "${schema}".tasks_fault RENAME TO tasks`,
      );
    await database.end();
  }
  await page.getByRole("button", { name: "Try again", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Release planning" }),
  ).toBeVisible();
  await expect(
    page
      .getByRole("grid", { name: "Task list" })
      .getByRole("row")
      .filter({ has: page.getByRole("link") }),
  ).toHaveCount(25);
});

test("task load failures preserve the deep link and recover without creating a task", async ({
  page,
}, testInfo) => {
  const accepted = await page.request.post("/api/auth/accept-invitation", {
    headers: { Origin: baseOrigin },
    data: {
      token: detailInvitationToken,
      name: "Detail Review",
      password: "Detail-only-password-42",
    },
  });
  expect(accepted.ok()).toBeTruthy();
  const savedResponse = await page.request.get(`/api/tasks/${taskId}`);
  expect(savedResponse.ok()).toBeTruthy();
  const savedTitle = (await savedResponse.json()).task.title as string;
  let creations = 0;
  page.on("request", (request) => {
    if (
      request.method() === "POST" &&
      new URL(request.url()).pathname === `/api/boards/${boardId}/tasks`
    )
      creations++;
  });
  const fail = (route: Route) => route.abort("failed");
  await page.route(`**/api/tasks/${taskId}*`, fail);
  await page.goto(`/boards/${boardId}/tasks/${taskId}`);
  await expect(
    page.getByRole("heading", { name: "Task unavailable" }),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: "Try again" })).toBeEnabled();
  await expect(page.getByRole("button", { name: "Create task" })).toHaveCount(
    0,
  );
  await expect(page).toHaveURL(
    new RegExp(`/boards/${boardId}/tasks/${taskId}$`),
  );
  expect(creations).toBe(0);
  await page.unroute(`**/api/tasks/${taskId}*`, fail);
  await page.getByRole("button", { name: "Try again" }).click();
  await expect(
    page.getByRole("button", { name: "Edit task details" }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", {
      name: savedTitle,
    }),
  ).toBeVisible();
  const inaccessible = (route: Route) =>
    route.fulfill({
      status: 403,
      contentType: "application/json",
      body: JSON.stringify({ error: "Access denied" }),
    });
  await page.route(`**/api/tasks/${taskId}*`, inaccessible);
  await page.reload();
  await expect(
    page.getByRole("heading", { name: "Task access required" }),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: "Create task" })).toHaveCount(
    0,
  );
  await page.unroute(`**/api/tasks/${taskId}*`, inaccessible);
  await page.getByRole("button", { name: "Try again" }).click();
  await expect(
    page.getByRole("heading", {
      name: savedTitle,
    }),
  ).toBeVisible();
  const delayed = requestGate();
  const holdTask = (route: Route) =>
    route.request().method() === "GET" ? delayed.hold(route) : route.continue();
  await page.route(`**/api/tasks/${taskId}*`, holdTask);
  let taskResumeAt = 0;
  try {
    await page.reload();
    await delayed.started;
    await expect(page).toHaveURL(
      new RegExp(`/boards/${boardId}/tasks/${taskId}$`),
    );
    await expect(page.getByRole("button", { name: "Create task" })).toHaveCount(
      0,
    );
    taskResumeAt = Date.now();
  } finally {
    await delayed.finish();
    await page.unroute(`**/api/tasks/${taskId}*`, holdTask);
  }
  await expect(
    page.getByRole("heading", {
      name: savedTitle,
    }),
  ).toBeVisible();
  await testInfo.attach("held-task-read.json", {
    body: Buffer.from(
      JSON.stringify({
        viewport: "1280x720",
        resumedToHeadingMs: Date.now() - taskResumeAt,
      }),
    ),
    contentType: "application/json",
  });
  await page.goto(
    `/boards/${boardId}/tasks/00000000-0000-4000-8000-000000000000`,
  );
  await expect(
    page.getByRole("heading", { name: "Task unavailable" }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Go to boards" }),
  ).toBeVisible();
  expect(creations).toBe(0);
});

test("overview autoloads every board, retries directory failures, and keeps mutations consistent across held refreshes", async ({
  page,
}) => {
  const { database, schema } = await browserDatabase();
  const fixtureBoardIds: string[] = [];
  try {
    const [board] = await database.unsafe(
      `SELECT workspace_id FROM "${schema}".boards WHERE id=$1`,
      [boardId],
    );
    expect(board).toBeTruthy();
    for (let i = 1; i <= 234; i++) {
      const [created] = await database.unsafe(
        `INSERT INTO "${schema}".boards(workspace_id,name,prefix) VALUES ($1,$2,$3) RETURNING id`,
        [
          board.workspace_id,
          `Directory board ${String(i).padStart(3, "0")}`,
          `DIR${i}`,
        ],
      );
      fixtureBoardIds.push(created.id);
    }
    const accepted = await page.request.post("/api/auth/accept-invitation", {
      headers: { Origin: baseOrigin },
      data: {
        token: sidebarInvitationToken,
        name: "Sidebar Review",
        password: "Sidebar-only-password-42",
      },
    });
    expect(accepted.ok()).toBeTruthy();
    const initial = await page.request
      .get("/api/boards?directory=true&limit=100")
      .then((r) => r.json());
    const main = page.getByRole("main");
    const cards = main.getByRole("link", { name: /^Directory board / });
    const create = main.getByRole("button", {
      name: "Create board",
      exact: true,
    });
    const checkOverview = async (count: number) => {
      await expect(page).toHaveURL("/boards");
      await expect(cards).toHaveCount(count);
      await expect(create).toBeVisible();
      await expect(
        page.getByRole("navigation", { name: "Boards navigation" }),
      ).toHaveCount(0);
      await expect(
        main.getByRole("button", { name: "Load more boards", exact: true }),
      ).toHaveCount(0);
    };
    const checkSwitcher = async (name: string, absent: string[] = []) => {
      const breadcrumb = page.getByRole("navigation", { name: "Breadcrumb" });
      await expect(
        breadcrumb.getByRole("link", { name: "Boards", exact: true }),
      ).toHaveAttribute("href", "/boards");
      await breadcrumb.getByRole("button", { name: /Switch board/ }).click();
      await expect(
        page.getByRole("option", { name: /^Directory board / }),
      ).toHaveCount(234);
      await expect(
        page.getByRole("option", { name, exact: true }),
      ).toBeVisible();
      for (const oldName of absent)
        await expect(
          page.getByRole("option", { name: oldName, exact: true }),
        ).toHaveCount(0);
      await page.getByRole("listbox").press("Escape");
      await expect(page.getByRole("listbox")).toBeHidden();
    };
    const continuation = requestGate();
    let heldInitial = false;
    const holdInitial = async (route: Route) => {
      if (
        !new URL(route.request().url()).searchParams.has("cursor") ||
        heldInitial
      )
        return route.continue();
      heldInitial = true;
      return continuation.hold(route);
    };
    await page.route("**/api/boards?**", holdInitial);
    try {
      await page.goto("/boards");
      await continuation.started;
      await expect(cards).toHaveCount(
        initial.items.filter((item: { name: string }) =>
          item.name.startsWith("Directory board "),
        ).length,
      );
      const anchor = initial.items.at(-1);
      const renamed = await page.request.patch(`/api/boards/${anchor.id}`, {
        headers: { Origin: baseOrigin },
        data: { version: anchor.version, name: "Directory board 999" },
      });
      expect(renamed.ok()).toBeTruthy();
    } finally {
      await continuation.finish();
      await page.unroute("**/api/boards?**", holdInitial);
    }
    // A stale continuation restarts from the first page and loads every board.
    await checkOverview(234);
    const abortContinuation = async (route: Route) => {
      if (!new URL(route.request().url()).searchParams.has("cursor"))
        return route.continue();
      await route.abort("failed");
    };
    await page.route("**/api/boards?**", abortContinuation);
    await page.reload();
    await expect(
      page
        .locator('[data-slot="toast"]')
        .filter({ hasText: "could not be reached" }),
    ).toContainText("could not be reached");
    const updatedFirst = await page.request
      .get("/api/boards?directory=true&limit=100")
      .then((r) => r.json());
    await expect(cards).toHaveCount(
      updatedFirst.items.filter((item: { name: string }) =>
        item.name.startsWith("Directory board "),
      ).length,
    );
    await expect(create).toBeVisible();
    await page.unroute("**/api/boards?**", abortContinuation);
    await main.getByRole("button", { name: "Retry", exact: true }).click();
    await checkOverview(234);
    await expect(main.getByRole("alert")).toHaveCount(0);
    await page
      .getByRole("navigation", { name: "Workspace navigation" })
      .getByRole("button", { name: /^Account menu for / })
      .click();
    await page
      .getByRole("menu")
      .getByRole("menuitem", { name: "Profile", exact: true })
      .click();
    await expect(
      page.getByRole("heading", { name: "Profile", exact: true }),
    ).toBeVisible();
    await page
      .getByRole("navigation", { name: "Workspace navigation" })
      .getByRole("link", { name: "Boards", exact: true })
      .click();
    await checkOverview(234);
    const createBoard = async (name: string, prefix: string) => {
      await create.click();
      const dialog = page.getByRole("dialog", {
        name: "Create a board",
        exact: true,
      });
      await dialog.getByLabel("Board name", { exact: true }).fill(name);
      await dialog.getByLabel("Task prefix", { exact: true }).fill(prefix);
      const response = page.waitForResponse(
        (r) =>
          new URL(r.url()).pathname === "/api/boards" &&
          r.request().method() === "POST",
      );
      await dialog
        .getByRole("button", { name: "Create board", exact: true })
        .click();
      const created = (await (await response).json()).board;
      fixtureBoardIds.push(created.id);
      await expect(dialog).toBeHidden();
      await expect(
        page.getByRole("heading", { name, exact: true }),
      ).toBeVisible();
      return created;
    };
    const created = await createBoard(
      "Z Created beyond the first page",
      "LATE",
    );
    await checkSwitcher(created.name);
    const refreshFirst = requestGate();
    const refreshSecond = requestGate();
    let heldFirst = false,
      heldSecond = false;
    const holdRenameRefresh = async (route: Route) => {
      const url = new URL(route.request().url());
      if (url.searchParams.get("directory") !== "true") return route.continue();
      if (!url.searchParams.has("cursor") && !heldFirst) {
        heldFirst = true;
        return refreshFirst.hold(route);
      }
      if (url.searchParams.has("cursor") && !heldSecond) {
        heldSecond = true;
        return refreshSecond.hold(route);
      }
      return route.continue();
    };
    await page.route("**/api/boards?**", holdRenameRefresh);
    try {
      await openBoardAction(page, "Board settings");
      const settings = page.getByRole("dialog", {
        name: "Board settings",
        exact: true,
      });
      await settings
        .getByLabel("Board name", { exact: true })
        .fill("Z Saved beyond the first page");
      await settings
        .getByRole("button", { name: "Save board", exact: true })
        .click();
      await refreshFirst.started;
      await expect(settings).toBeVisible();
      await expect(
        settings.getByRole("button", { name: "Save board", exact: true }),
      ).toBeEnabled();
      await settings
        .getByRole("button", { name: "Close dialog", exact: true })
        .click();
      await expect(settings).toBeHidden();
      expect(
        (await (await page.request.get(`/api/boards/${created.id}`)).json())
          .board.name,
      ).toBe("Z Saved beyond the first page");
      await expect(
        page.getByRole("navigation", { name: "Breadcrumb" }),
      ).toContainText("Z Saved beyond the first page");
      await checkSwitcher("Z Saved beyond the first page", [created.name]);
      await refreshFirst.finish();
      await refreshSecond.started;
      await checkSwitcher("Z Saved beyond the first page", [created.name]);
    } finally {
      await refreshFirst.finish();
      await refreshSecond.finish();
      await page.unroute("**/api/boards?**", holdRenameRefresh);
    }
    await checkSwitcher("Z Saved beyond the first page", [created.name]);
    const current = await page.request
      .get(`/api/boards/${created.id}`)
      .then((r) => r.json());
    const renamed = await page.request.patch(`/api/boards/${created.id}`, {
      headers: { Origin: baseOrigin },
      data: {
        version: current.board.version,
        name: "Z Server-renamed later board",
      },
    });
    expect(renamed.ok()).toBeTruthy();
    await page.reload();
    await checkSwitcher("Z Server-renamed later board", [
      created.name,
      "Z Saved beyond the first page",
    ]);
    await openBoardAction(page, "Delete board");
    await page
      .getByRole("dialog", { name: "Delete board?", exact: true })
      .getByRole("button", { name: "Delete board", exact: true })
      .click();
    await checkOverview(234);
    await expect(
      main.getByRole("link", {
        name: "Z Server-renamed later board",
        exact: true,
      }),
    ).toHaveCount(0);
    expect((await page.request.get(`/api/boards/${created.id}`)).status()).toBe(
      404,
    );

    // A creation continuation finishing after deletion cannot resurrect a card.
    const creationContinuation = requestGate();
    const deletionFirst = requestGate();
    const deletionContinuation = requestGate();
    let deleting = false,
      heldCreation = false,
      heldDeletionFirst = false,
      heldDeletionContinuation = false;
    const holdMutationRefreshes = async (route: Route) => {
      const url = new URL(route.request().url());
      if (url.searchParams.get("directory") !== "true") return route.continue();
      if (!deleting && url.searchParams.has("cursor") && !heldCreation) {
        heldCreation = true;
        return creationContinuation.hold(route);
      }
      if (deleting && !url.searchParams.has("cursor") && !heldDeletionFirst) {
        heldDeletionFirst = true;
        return deletionFirst.hold(route);
      }
      if (
        deleting &&
        url.searchParams.has("cursor") &&
        !heldDeletionContinuation
      ) {
        heldDeletionContinuation = true;
        return deletionContinuation.hold(route);
      }
      return route.continue();
    };
    await page.route("**/api/boards?**", holdMutationRefreshes);
    try {
      const pendingBoard = await createBoard(
        "Z Deleted during creation refresh",
        "PENDING",
      );
      await creationContinuation.started;
      await checkSwitcher(pendingBoard.name);
      await openBoardAction(page, "Delete board");
      deleting = true;
      const response = page.waitForResponse(
        (r) =>
          new URL(r.url()).pathname === `/api/boards/${pendingBoard.id}` &&
          r.request().method() === "DELETE",
      );
      await page
        .getByRole("dialog", { name: "Delete board?", exact: true })
        .getByRole("button", { name: "Delete board", exact: true })
        .click();
      expect(await (await response).json()).toEqual({ ok: true });
      await deletionFirst.started;
      await expect(page.getByRole("dialog")).toHaveCount(0);
      await checkOverview(234);
      await expect(
        main.getByRole("link", { name: pendingBoard.name, exact: true }),
      ).toHaveCount(0);
      await creationContinuation.finish();
      await checkOverview(234);
      await expect(
        main.getByRole("link", { name: pendingBoard.name, exact: true }),
      ).toHaveCount(0);
      await deletionFirst.finish();
      await deletionContinuation.started;
      await checkOverview(234);
      await expect(
        main.getByRole("link", { name: pendingBoard.name, exact: true }),
      ).toHaveCount(0);
      await deletionContinuation.finish();
      await checkOverview(234);
      await expect(
        main.getByRole("link", { name: pendingBoard.name, exact: true }),
      ).toHaveCount(0);
      expect(
        (await page.request.get(`/api/boards/${pendingBoard.id}`)).status(),
      ).toBe(404);
    } finally {
      await creationContinuation.finish();
      await deletionFirst.finish();
      await deletionContinuation.finish();
      await page.unroute("**/api/boards?**", holdMutationRefreshes);
    }
  } finally {
    try {
      if (fixtureBoardIds.length) {
        await database.begin(async (tx) => {
          expect(
            await tx.unsafe(
              `SELECT id FROM "${schema}".tasks WHERE board_id=ANY($1::uuid[])`,
              [fixtureBoardIds],
            ),
          ).toHaveLength(0);
          await tx.unsafe(
            `DELETE FROM "${schema}".boards WHERE id=ANY($1::uuid[])`,
            [fixtureBoardIds],
          );
        });
        expect(
          await database.unsafe(
            `SELECT id FROM "${schema}".boards WHERE id=$1`,
            [boardId],
          ),
        ).toHaveLength(1);
      }
    } finally {
      await database.end();
    }
  }
});

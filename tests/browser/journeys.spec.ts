import { readFile } from "node:fs/promises";
import { rememberBrowserBootstrap } from "../browser-fixture.js";
import postgres from "postgres";
import {
  expect,
  request,
  test,
  type Locator,
  type Page,
  type Route,
  type Response,
} from "@playwright/test";
const account = {
  email: "browser-admin@example.test",
  password: "Browser-only-password-42",
  name: "Alex Morgan",
  workspaceName: "Mill browser verification",
};
const baseOrigin = process.env.MILL_BROWSER_BASE_URL ?? "http://localhost:4323";
let workspaceId = "";
let boardId = "";
let taskId = "";
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
  await page.goto("/");
  await page.getByLabel("Email", { exact: true }).fill(credentials.email);
  await page.getByLabel("Password", { exact: true }).fill(credentials.password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(
    page.getByRole("navigation", { name: "Workspace navigation" }),
  ).toBeVisible();
}
async function choose(page: Page, label: string, value: string) {
  await page.getByRole("button", { name: new RegExp(`${label}$`) }).click();
  await page.getByRole("option", { name: value, exact: true }).click();
}
async function submitWhilePending(
  page: Page,
  path: string,
  submit: Locator,
  footerClose: string,
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
  try {
    await submit.click();
    await requestStarted;
    await expect(
      page
        .getByRole("dialog")
        .getByRole("button", { name: "Close dialog", exact: true }),
    ).toBeDisabled();
    await expect(
      page
        .getByRole("dialog")
        .getByRole("button", { name: footerClose, exact: true }),
    ).toBeDisabled();
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog")).toBeVisible();
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
    await expect(submit).toBeDisabled();
    await expect(
      dialog.getByRole("button", { name: "Close dialog", exact: true }),
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
test("first installation and complete board/task workflow", async ({
  page,
}) => {
  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: "Create your workspace" }),
  ).toBeVisible();
  await page.getByLabel("Workspace name").fill(account.workspaceName);
  await page.getByLabel("Your name").fill(account.name);
  await page.getByLabel("Email", { exact: true }).fill(account.email);
  await page.getByLabel("Password", { exact: true }).fill(account.password);
  await page
    .getByLabel("Confirm password", { exact: true })
    .fill(account.password);
  await page
    .getByRole("button", { name: "Create workspace", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Create your first board" }),
  ).toBeVisible();
  const bootstrap = await rememberBrowserBootstrap(page.request, baseOrigin);
  workspaceId = bootstrap.identity.workspace.id;
  const onlyBoardResponse = await page.request.post("/api/boards", {
    headers: { Origin: baseOrigin },
    data: { name: "Only board before deletion", prefix: "EMPTY" },
  });
  expect(onlyBoardResponse.ok()).toBeTruthy();
  const onlyBoard = (await onlyBoardResponse.json()).board;
  const phantomReads: string[] = [];
  const recordPhantomRead = (response: Response) => {
    if (
      new URL(response.url()).pathname === `/api/boards/${onlyBoard.id}` &&
      response.status() === 404
    )
      phantomReads.push(response.url());
  };
  page.on("response", recordPhantomRead);
  try {
    await page.goto(`/boards/${onlyBoard.id}`);
    await page
      .getByRole("button", { name: "Board settings", exact: true })
      .click();
    await page
      .getByRole("dialog", { name: "Board settings", exact: true })
      .getByRole("button", { name: "Delete board", exact: true })
      .click();
    await page
      .getByRole("dialog", { name: "Delete board?", exact: true })
      .getByRole("button", { name: "Delete board", exact: true })
      .click();
    await expect(page).toHaveURL("/");
    await expect(
      page.getByRole("heading", { name: "Your work starts here", exact: true }),
    ).toBeVisible();
    await expect(
      page
        .getByRole("navigation", { name: "Workspace navigation" })
        .getByRole("link", { name: onlyBoard.name, exact: true }),
    ).toHaveCount(0);
    await page.reload();
    await expect(page).toHaveURL("/");
    await expect(
      page.getByRole("button", {
        name: "Create your first board",
        exact: true,
      }),
    ).toBeVisible();
    expect(phantomReads).toHaveLength(0);
    const emptyBoards = await page.request
      .get("/api/boards?directory=true&limit=100")
      .then((response) => response.json());
    expect(emptyBoards.items).toHaveLength(0);
    expect(
      (await page.request.get(`/api/boards/${onlyBoard.id}`)).status(),
    ).toBe(404);
  } finally {
    page.off("response", recordPhantomRead);
  }
  const sidebarSizingInvitation = await page.request.post(
    "/api/auth/invitations",
    {
      headers: { Origin: baseOrigin },
      data: { email: sidebarSizingAccount.email, role: "admin" },
    },
  );
  expect(sidebarSizingInvitation.ok()).toBeTruthy();
  sidebarSizingInvitationUrl = (await sidebarSizingInvitation.json()).inviteUrl;
  const permissionsInvitation = await page.request.post(
    "/api/auth/invitations",
    {
      headers: { Origin: baseOrigin },
      data: { email: permissionsAccount.email, role: "admin" },
    },
  );
  expect(permissionsInvitation.ok()).toBeTruthy();
  permissionsInvitationUrl = (await permissionsInvitation.json()).inviteUrl;
  const layoutInvitation = await page.request
    .post("/api/auth/invitations", {
      headers: { Origin: baseOrigin },
      data: { email: "browser-layout@example.test", role: "admin" },
    })
    .then((r) => r.json());
  layoutInvitationToken = layoutInvitation.token;
  const detailInvitation = await page.request
    .post("/api/auth/invitations", {
      headers: { Origin: baseOrigin },
      data: { email: "browser-detail@example.test", role: "member" },
    })
    .then((r) => r.json());
  detailInvitationToken = detailInvitation.token;
  const sidebarInvitation = await page.request
    .post("/api/auth/invitations", {
      headers: { Origin: baseOrigin },
      data: { email: "browser-sidebar@example.test", role: "admin" },
    })
    .then((r) => r.json());
  sidebarInvitationToken = sidebarInvitation.token;
  const lifecycleInvitation = await page.request
    .post("/api/auth/invitations", {
      headers: { Origin: baseOrigin },
      data: { email: lifecycleAccount.email, role: "admin" },
    })
    .then((r) => r.json());
  lifecycleInvitationUrl = lifecycleInvitation.inviteUrl;
  await page.getByRole("button", { name: "Create your first board" }).click();
  await page.getByLabel("Board name", { exact: true }).fill("Release planning");
  await page.getByLabel("Task prefix", { exact: true }).fill("REL");
  await submitWhilePending(
    page,
    "/boards",
    page
      .getByRole("dialog")
      .getByRole("button", { name: "Create board", exact: true }),
    "Cancel",
  );
  await expect(
    page.getByRole("heading", { name: "Release planning" }),
  ).toBeVisible();
  boardId = page.url().split("/boards/")[1];
  await page.screenshot({
    path: "docs/screenshots/empty-board-light.png",
    fullPage: true,
    animations: "disabled",
  });
  await page.getByRole("button", { name: "New task", exact: true }).click();
  await page
    .getByLabel("Title", { exact: true })
    .fill("Prepare the release checklist");
  await page
    .getByLabel("Description", { exact: true })
    .fill(
      "## Release\nReview **all journeys**. [Unsafe](javascript:alert(1)) <script>alert(2)</script>",
    );
  await page.getByLabel("New checklist item").fill("Verify installation");
  await page.getByRole("button", { name: "Add checklist item" }).click();
  await submitWhilePending(
    page,
    `/boards/${boardId}/tasks`,
    page
      .getByRole("dialog")
      .getByRole("button", { name: "Create task", exact: true }),
    "Close",
  );
  await expect(
    page.getByRole("dialog").getByRole("heading", { name: "REL-1" }),
  ).toBeVisible();
  taskId = page.url().split("/tasks/")[1];
  await page
    .getByLabel("Title", { exact: true })
    .fill("Prepare the release and recovery checklist");
  await choose(page, "Status", "In progress");
  await page.getByRole("button", { name: "Save changes" }).click();
  await expect(
    page.getByRole("status").filter({ hasText: "Changes saved" }),
  ).toBeVisible();
  await page.getByRole("tab", { name: "Preview", exact: true }).click();
  await expect(page.getByRole("link", { name: "Unsafe" })).not.toHaveAttribute(
    "href",
    /javascript:/,
  );
  await expect(page.locator(".markdown script")).toHaveCount(0);
  await page.getByRole("tab", { name: "Write", exact: true }).click();
  await page
    .getByLabel("Description", { exact: true })
    .fill(
      "## Release\nReview **all journeys** and verify the recovery procedure.",
    );
  await page.getByRole("button", { name: "Save changes" }).click();
  await expect(
    page.getByRole("status").filter({ hasText: "Changes saved" }),
  ).toBeVisible();
  await page
    .getByLabel("Add a comment", { exact: true })
    .fill("Ready for review.");
  await submitWhilePending(
    page,
    `/tasks/${taskId}/comments`,
    page.getByRole("button", { name: "Comment", exact: true }),
    "Close",
  );
  await expect(page.locator(".comment")).toContainText("Ready for review.");
  await page
    .locator(".comment")
    .getByRole("button", { name: "Edit", exact: true })
    .click();
  await page
    .getByLabel("Edit comment", { exact: true })
    .fill("Ready for keyboard review.");
  await page
    .getByLabel("Edit comment", { exact: true })
    .press("ControlOrMeta+Enter");
  await expect(page.locator(".comment")).toContainText(
    "Ready for keyboard review.",
  );
  await expect(page.locator(".comment")).toContainText(account.name);
  await page
    .locator(".comment")
    .getByRole("button", { name: "Delete", exact: true })
    .click();
  const commentConfirmation = page.getByRole("dialog").filter({
    has: page.getByRole("heading", { name: "Delete comment?", exact: true }),
  });
  await commentConfirmation
    .getByRole("button", { name: "Keep comment", exact: true })
    .click();
  await expect(page.locator(".comment")).toContainText(
    "Ready for keyboard review.",
  );
  await page
    .locator(".comment")
    .getByRole("button", { name: "Delete", exact: true })
    .click();
  await commentConfirmation
    .getByRole("button", { name: "Delete comment", exact: true })
    .click();
  await expect(page.getByRole("dialog").getByRole("status")).toContainText(
    "Comment deleted.",
  );
  await expect(page.locator(".comment")).toHaveCount(0);
  await page
    .getByLabel("Add a comment", { exact: true })
    .fill("Ready for review.");
  await page.getByRole("button", { name: "Comment", exact: true }).click();
  await page
    .locator(".checkbox")
    .filter({
      has: page.getByRole("checkbox", {
        name: "Verify installation",
        exact: true,
      }),
    })
    .locator(".checkbox__content")
    .click();
  await page.getByRole("button", { name: "Save changes", exact: true }).click();
  await expect(
    page.getByRole("checkbox", { name: "Verify installation", exact: true }),
  ).toBeChecked();
  await page.getByRole("button", { name: "Add subtask" }).click();
  await expect(
    page.getByRole("dialog").getByRole("heading", { name: "New subtask" }),
  ).toBeVisible();
  await page.getByLabel("Title", { exact: true }).fill("Test database restore");
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Create task", exact: true })
    .click();
  await expect(
    page.getByRole("dialog").getByRole("heading", { name: "REL-2" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Close", exact: true }).click();
  await page
    .getByRole("button", { name: "Board settings", exact: true })
    .click();
  await page.getByLabel("New status").fill("Review");
  await submitSettingsWhilePending(
    page,
    `/boards/${boardId}/columns`,
    "POST",
    page.getByRole("button", { name: "Add status", exact: true }),
  );
  await expect(page.getByLabel("Status name").nth(3)).toHaveValue("Review");
  await expect(
    page.getByRole("button", { name: "Add status", exact: true }),
  ).toBeFocused();
  await submitSettingsWhilePending(
    page,
    "/columns/*",
    "PATCH",
    page.getByRole("button", { name: "Move Review earlier", exact: true }),
  );
  await expect(
    page.getByRole("button", { name: "Move Review earlier" }),
  ).toBeFocused();
  await page.getByRole("button", { name: "Close dialog", exact: true }).click();
  await expect(page.getByRole("region", { name: "In progress" })).toContainText(
    "Prepare the release and recovery checklist",
  );
  await page.screenshot({
    path: "docs/screenshots/desktop-light.png",
    fullPage: true,
    animations: "disabled",
  });
  await page
    .getByRole("button", { name: "Appearance: switch to dark theme" })
    .click();
  await page.screenshot({
    path: "docs/screenshots/desktop-dark.png",
    fullPage: true,
    animations: "disabled",
  });
  await page.reload();
  await expect(
    page.getByRole("heading", { name: "Release planning" }),
  ).toBeVisible();
  await page.goto(`/boards/${boardId}/tasks/${taskId}`);
  await expect(page.getByRole("dialog")).toContainText("Test database restore");
  await expect(
    page.getByRole("checkbox", { name: "Verify installation", exact: true }),
  ).toBeChecked();
  await page.getByRole("tab", { name: "Activity", exact: true }).click();
  const activity = page.getByRole("tabpanel", {
    name: "Activity",
    exact: true,
  });
  await expect(activity).toContainText("Alex Morgan");
  await expect(activity).toContainText("created this task");
  await expect(activity).toContainText("updated this task");
  await expect(activity).toContainText("added a comment");
  await page.getByRole("tab", { name: /^Comments/ }).click();
  await page.screenshot({
    path: "docs/screenshots/task-detail-dark.png",
    fullPage: true,
    animations: "disabled",
  });
});
test("sidebar action sizing matches navigation and removed audit routes stay unavailable", async ({
  page,
  browser,
}) => {
  await page.goto(sidebarSizingInvitationUrl);
  await page.getByLabel("Your name").fill("Sidebar Sizing Review");
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
          (value) => localStorage.setItem("mill:theme", value),
          theme,
        );
        const surface = await context.newPage();
        await surface.goto(`/boards/${boardId}`);
        if (width === 390)
          await surface
            .getByRole("button", { name: "Open navigation", exact: true })
            .click();
        const nav = surface.getByRole("navigation", {
          name: "Workspace navigation",
        });
        const create = nav.getByRole("button", {
          name: "Create Project",
          exact: true,
        });
        const reference = nav.getByRole("link", {
          name: "Agent access",
          exact: true,
        });
        await expect(create).toBeVisible();
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
        const { iconGeometry: createIcon, ...createStyles } =
          await metrics(create);
        const { iconGeometry: referenceIcon, ...referenceStyles } =
          await metrics(reference);
        expect(createStyles).toEqual(referenceStyles);
        expect(createStyles.iconCssWidth).toBe("16px");
        expect(createStyles.iconCssHeight).toBe("16px");
        for (const dimension of ["width", "height"] as const)
          expect(
            Math.abs(createIcon[dimension] - referenceIcon[dimension]),
          ).toBeLessThanOrEqual(0.001);
        expect((await create.boundingBox())!.height).toBe(
          width === 390 ? 44 : 36,
        );
        await expect(
          nav.getByRole("link", { name: "Audit history", exact: true }),
        ).toHaveCount(0);
        if (width === 390) await surface.keyboard.press("Escape");
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
test("keyboard task movement, filters, mobile columns, and overlay search scrolling", async ({
  page,
}) => {
  await login(page);
  await page.goto(`/boards/${boardId}/tasks/${taskId}`);
  await page.getByRole("button", { name: /Status$/ }).focus();
  await page.keyboard.press("Enter");
  await page.keyboard.press("d");
  await page.keyboard.press("Enter");
  await page.getByRole("button", { name: "Save changes" }).click();
  await expect(
    page.getByRole("status").filter({ hasText: "Changes saved" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Close", exact: true }).click();
  await page.getByLabel("Search tasks").fill("recovery");
  await expect(page.locator(".task-card")).toHaveCount(1);
  await page.getByRole("button", { name: "List view" }).click();
  await expect(page.getByRole("grid", { name: "Task list" })).toContainText(
    "Prepare the release and recovery checklist",
  );
  const taskLink = page
    .getByRole("grid", { name: "Task list" })
    .getByRole("link")
    .filter({ hasText: "Prepare the release and recovery checklist" });
  await expect(taskLink).toHaveAttribute(
    "href",
    `/boards/${boardId}/tasks/${taskId}`,
  );
  await taskLink.click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.getByRole("button", { name: "Close", exact: true }).click();
  await expect(page.getByLabel("Search tasks")).toHaveValue("recovery");
  await expect(page.getByRole("grid", { name: "Task list" })).not.toContainText(
    "Test database restore",
  );
  await taskLink.focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.goBack();
  await expect(page.getByRole("dialog")).not.toBeVisible();
  await expect(page.getByLabel("Search tasks")).toHaveValue("recovery");
  await expect(page.getByRole("grid", { name: "Task list" })).toBeVisible();
  await page.getByRole("button", { name: "Clear filters" }).click();
  await expect(page.getByRole("grid", { name: "Task list" })).toContainText(
    "Test database restore",
  );
  for (const view of ["List view", "Kanban view"]) {
    await page.getByRole("button", { name: view, exact: true }).click();
    const before = await page.locator(".board-toolbar").boundingBox();
    await page.getByLabel("Search tasks").fill("nonexistent-filter-result");
    await expect(
      page.getByRole("heading", {
        name: "No tasks match these filters",
        exact: true,
      }),
    ).toBeVisible();
    await expect(
      page.getByText("Adjust or clear your filters to see existing tasks.", {
        exact: true,
      }),
    ).toBeVisible();
    const filtered = await page.locator(".board-toolbar").boundingBox();
    expect(filtered?.height).toBe(before?.height);
    expect(filtered?.y).toBe(before?.y);
    await page
      .getByRole("button", { name: "Clear filters", exact: true })
      .last()
      .click();
    if (view === "List view")
      await expect(page.getByRole("grid", { name: "Task list" })).toContainText(
        "Test database restore",
      );
    else
      await expect(
        page.locator(".task-card").filter({ hasText: "Test database restore" }),
      ).toBeVisible();
    const restored = await page.locator(".board-toolbar").boundingBox();
    expect(restored?.height).toBe(before?.height);
  }
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole("button", { name: "Kanban view" }).click();
  await choose(page, "Board column", "Done (1)");
  await page.getByRole("button", { name: "Open navigation" }).click();
  await expect(
    page
      .getByRole("dialog", { name: "Workspace navigation" })
      .getByRole("button", { name: "Close navigation" }),
  ).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(
    page.getByRole("button", { name: "Open navigation" }),
  ).toBeFocused();
  await page
    .getByRole("button", { name: "Appearance: switch to dark theme" })
    .click();
  await expect(page.getByRole("region", { name: "Done" })).toBeVisible();
  await page.screenshot({
    path: "docs/screenshots/mobile-dark.png",
    fullPage: true,
    animations: "disabled",
  });
  await page.getByRole("button", { name: "Open navigation" }).click();
  await page
    .getByRole("button", { name: `Account menu for ${account.name}` })
    .click();
  await page
    .getByRole("menuitem", { name: "Account security", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "Account security" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Open navigation" }).click();
  await page
    .getByRole("button", { name: `Account menu for ${account.name}` })
    .click();
  await page.getByRole("menuitem", { name: "Profile", exact: true }).click();
  await page.getByRole("button", { name: /Time zone$/ }).click();
  const menu = page.getByRole("listbox");
  await expect(menu).toBeVisible();
  await menu.evaluate((el) => {
    el.scrollTop = el.scrollHeight;
  });
  await expect
    .poll(() => menu.evaluate((el) => el.scrollTop))
    .toBeGreaterThan(0);
  await page.getByRole("searchbox", { name: /Search/ }).fill("Calcutta");
  await page
    .getByRole("option", { name: "Asia/Calcutta", exact: true })
    .click();
  await page.getByRole("button", { name: "Save preferences" }).click();
  await expect(page.getByRole("status")).toContainText("Preferences saved");
  await page.screenshot({
    path: "docs/screenshots/mobile-profile.png",
    fullPage: true,
    animations: "disabled",
  });
});
test("concurrent task edits show conflict with draft preserved and reload recovery", async ({
  page,
}) => {
  await login(page);
  await page.goto(`/boards/${boardId}/tasks/${taskId}`);
  await page.getByLabel("Title", { exact: true }).fill("My pending draft");
  const task = await page.request
    .get(`/api/tasks/${taskId}`)
    .then((r) => r.json());
  await page.request.patch(`/api/tasks/${taskId}`, {
    headers: { Origin: baseOrigin },
    data: { version: task.task.version, title: "Another person’s update" },
  });
  await page.getByRole("button", { name: "Save changes" }).click();
  await expect(page.getByRole("alert")).toBeVisible();
  await expect(page.getByLabel("Title", { exact: true })).toHaveValue(
    "My pending draft",
  );
  await page.getByRole("button", { name: "Reload task" }).click();
  await expect(page.getByLabel("Title", { exact: true })).toHaveValue(
    "Another person’s update",
  );
  await page.getByRole("button", { name: "Close", exact: true }).click();
});
test("expired sessions preserve task route and dedicated not-found uses shared actions", async ({
  page,
}) => {
  await login(page);
  await page.goto(`/boards/${boardId}/tasks/${taskId}`);
  await expect(page.getByLabel("Title", { exact: true })).toBeVisible();
  await page.request.post("/api/auth/logout", {
    headers: { Origin: baseOrigin },
    data: {},
  });
  await page.getByLabel("Title", { exact: true }).fill("Expired draft");
  await page.getByRole("button", { name: "Save changes" }).click();
  await expect(
    page.getByRole("heading", { name: "Sign in to Mill" }),
  ).toBeVisible();
  await expect(
    page.getByText("Your session expired. Sign in again to continue."),
  ).toBeVisible();
  await page.getByLabel("Email", { exact: true }).fill(account.email);
  await page.getByLabel("Password", { exact: true }).fill(account.password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
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
});

test("invitations, viewer permissions, mentions, and scoped credentials", async ({
  page,
  browser,
}) => {
  await page.goto(permissionsInvitationUrl);
  await page.getByLabel("Your name").fill("Permissions Review");
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
      .getByRole("heading", { name: "Invitation created", exact: true }),
  ).toBeVisible();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Done", exact: true })
    .click();
  const viewerContext = await browser.newContext();
  const viewer = await viewerContext.newPage();
  await viewer.goto(invitation.inviteUrl);
  await viewer.getByLabel("Your name").fill("Jamie Viewer");
  await viewer
    .getByLabel("Password", { exact: true })
    .fill("Viewer-only-password-42");
  await viewer
    .getByLabel("Confirm password", { exact: true })
    .fill("Viewer-only-password-42");
  await viewer.getByRole("button", { name: "Accept invitation" }).click();
  await expect(
    viewer.getByRole("heading", { name: "Release planning" }),
  ).toBeVisible();
  await expect(
    viewer.getByRole("button", { name: "New task", exact: true }),
  ).toHaveCount(0);
  const viewerUser = await viewer.request
    .get("/api/auth/me")
    .then((r) => r.json());
  const original = await page.request
    .get(`/api/tasks/${taskId}`)
    .then((r) => r.json());
  await page.request.patch(`/api/tasks/${taskId}`, {
    headers: { Origin: baseOrigin },
    data: { version: original.task.version, assigneeId: viewerUser.user.id },
  });
  await page.goto(`/boards/${boardId}/tasks/${taskId}`);
  await page
    .getByLabel("Add a comment")
    .fill("Please review @browser-viewer@example.test");
  await page.getByRole("button", { name: "Comment", exact: true }).click();
  await expect(page.locator(".comment-list")).toContainText("Please review");
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
  await expect(viewer.getByLabel("Title", { exact: true })).toBeDisabled();
  await expect(
    viewer.getByRole("button", { name: "Save changes" }),
  ).toHaveCount(0);
  await viewerContext.close();
  await page.goto("/settings/agents");
  await page
    .getByRole("button", { name: "Create credential", exact: true })
    .click();
  await page.getByLabel("Name", { exact: true }).fill("Review agent");
  await choose(page, "Access", "Read only");
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Create credential", exact: true })
    .click();
  await expect(page.getByLabel("Credential", { exact: true })).not.toHaveValue(
    "",
  );
  const token = await page
    .getByLabel("Credential", { exact: true })
    .inputValue();
  const agent = await request.newContext({
    baseURL: baseOrigin,
    extraHTTPHeaders: { Authorization: `Bearer ${token}`, Origin: baseOrigin },
  });
  try {
    const forbiddenWrite = await agent.post(`/api/boards/${boardId}/tasks`, {
      data: { title: "Read-only token cannot create this task" },
    });
    expect(forbiddenWrite.status()).toBe(403);
    await page
      .getByRole("dialog")
      .getByRole("button", { name: "Done", exact: true })
      .click();
    await page
      .getByRole("button", { name: "Revoke Review agent", exact: true })
      .click();
    await page
      .getByRole("dialog")
      .getByRole("button", { name: "Revoke credential", exact: true })
      .click();
    const revokedDialog = page.getByRole("dialog", {
      name: "Revoke credential?",
      exact: true,
    });
    await expect(revokedDialog.getByRole("status")).toHaveText(
      "Credential revoked.",
    );
    await revokedDialog
      .getByRole("button", { name: "Done", exact: true })
      .click();
    const credentialRow = page
      .getByRole("grid", { name: "Credentials", exact: true })
      .getByRole("row")
      .filter({ hasText: "Review agent" });
    await expect(
      credentialRow.getByRole("gridcell", { name: "Revoked", exact: true }),
    ).toBeVisible();
    const credentialsResponse = await page.request.get("/api/credentials");
    expect(credentialsResponse.ok()).toBeTruthy();
    const credentialsPage = await credentialsResponse.json();
    const credential = credentialsPage.items.find(
      (item: { name: string }) => item.name === "Review agent",
    );
    expect(credential).toBeDefined();
    expect(credential.revokedAt).not.toBeNull();
    const revokedRead = await agent.get(`/api/boards/${boardId}/tasks`);
    expect(revokedRead.status()).toBe(401);
  } finally {
    await agent.dispose();
  }
});

test("task deletion removes descendants and discussion permanently and retries safely", async ({
  page,
}) => {
  await page.goto(lifecycleInvitationUrl);
  await page.getByLabel("Your name").fill("Lifecycle Review");
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
  const createTask = async (title: string, parentId?: string) => {
    const response = await page.request.post(`/api/boards/${boardId}/tasks`, {
      headers: { Origin: baseOrigin },
      data: { title, parentId, assigneeId: session.user.id },
    });
    expect(response.ok()).toBeTruthy();
    return (await response.json()).task;
  };
  const parent = await createTask("Task to delete permanently");
  const child = await createTask("Child to delete permanently", parent.id);
  const grandchild = await createTask(
    "Grandchild to delete permanently",
    child.id,
  );
  const ids = [parent.id, child.id, grandchild.id];
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
    await page.goto(`/boards/${boardId}/tasks/${parent.id}`);
    await expect(
      page.getByRole("button", { name: "Archive task", exact: true }),
    ).toHaveCount(0);
    await page
      .getByRole("button", { name: "Delete task", exact: true })
      .click();
    const confirmation = page.getByRole("dialog", {
      name: "Delete this task?",
      exact: true,
    });
    await expect(confirmation).toContainText(
      "all of its subtasks, and their comments",
    );
    await expect(confirmation).toContainText("There is no restore");
    await confirmation
      .getByRole("button", { name: "Keep task", exact: true })
      .click();
    await expect(confirmation).toBeHidden();
    await expect(
      page.getByRole("button", { name: "Delete task", exact: true }),
    ).toBeFocused();
    await page
      .getByRole("button", { name: "Delete task", exact: true })
      .click();
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
    await page.route(`**/api/tasks/${parent.id}`, failure);
    await confirmation
      .getByRole("button", { name: "Delete task", exact: true })
      .click();
    await expect(confirmation.getByRole("alert")).toContainText(
      "Task deletion temporarily unavailable",
    );
    expect(deletionKey).toBeTruthy();
    expect(
      (await page.request.get(`/api/tasks/${parent.id}`)).ok(),
    ).toBeTruthy();
    await page.unroute(`**/api/tasks/${parent.id}`, failure);
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
    await page.route(`**/api/tasks/${parent.id}`, delayed);
    const deletion = page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === `/api/tasks/${parent.id}` &&
        response.request().method() === "DELETE",
    );
    try {
      await confirmation
        .getByRole("button", { name: "Delete task", exact: true })
        .click();
      await requestStarted;
      await expect(
        confirmation.getByRole("button", { name: "Keep task", exact: true }),
      ).toBeDisabled();
      await expect(
        confirmation.getByRole("button", { name: "Close dialog", exact: true }),
      ).toBeDisabled();
      await expect(
        page.getByRole("button", {
          name: "Close",
          exact: true,
          includeHidden: true,
        }),
      ).toBeDisabled();
      await page.keyboard.press("Escape");
      await expect(confirmation).toBeVisible();
    } finally {
      release();
      await requestContinued;
      await page.unroute(`**/api/tasks/${parent.id}`, delayed);
    }
    expect(await (await deletion).json()).toEqual({ ok: true });
    await expect(page).toHaveURL(`/boards/${boardId}`);
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect(
      page.locator(".task-card").filter({ hasText: "to delete permanently" }),
    ).toHaveCount(0);
    for (const id of ids)
      expect((await page.request.get(`/api/tasks/${id}`)).status()).toBe(404);
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

test("board settings keep status failures recoverable and delete boards permanently", async ({
  page,
}) => {
  await login(page, lifecycleAccount);
  await page.goto(`/boards/${boardId}`);
  await page
    .getByRole("button", { name: "Board settings", exact: true })
    .click();
  const settings = page.getByRole("dialog").filter({
    has: page.getByRole("heading", { name: "Board settings", exact: true }),
  });
  await expect(settings.getByLabel("Task prefix", { exact: true })).toHaveCount(
    0,
  );
  await expect(settings).toContainText("The prefix stays fixed");
  await settings.getByLabel("New status", { exact: true }).fill("Queue");
  await settings
    .getByRole("button", { name: "Add status", exact: true })
    .click();
  const row = settings.locator(".column-editor").last();
  await expect(row.getByLabel("Status name", { exact: true })).toHaveValue(
    "Queue",
  );
  await row.getByLabel("Status name", { exact: true }).fill("Ready for review");
  await row.getByRole("button", { name: /Status color$/ }).click();
  await page.getByRole("option", { name: "Blue", exact: true }).click();
  const saveStatus = row.getByRole("button", { name: "Save", exact: true });
  const newStatus = settings.getByLabel("New status", { exact: true });
  await submitSettingsWhilePending(
    page,
    "/columns/*",
    "PATCH",
    saveStatus,
    async () => {
      await expect(newStatus).toBeEnabled();
      await newStatus.click();
      await expect(newStatus).toBeFocused();
    },
  );
  await expect(settings.getByRole("status")).toContainText("Status updated.");
  await expect(saveStatus).toBeDisabled();
  await expect(newStatus).toBeFocused();
  await expect(row).toContainText("Blue");
  const populatedStatus = settings.locator(".column-editor").nth(1);
  await expect(
    populatedStatus.getByLabel("Status name", { exact: true }),
  ).toHaveValue("In progress");
  await populatedStatus
    .getByRole("button", { name: "Delete", exact: true })
    .click();
  const confirmation = page.getByRole("dialog").filter({
    has: page.getByRole("heading", { name: "Delete status?", exact: true }),
  });
  await confirmation
    .getByRole("button", { name: "Delete status", exact: true })
    .click();
  await expect(confirmation.getByRole("alert")).toContainText(
    "Choose another status for the tasks in this status",
  );
  await expect(confirmation).toBeVisible();
  await confirmation.getByRole("button", { name: /Move tasks to$/ }).click();
  await page.getByRole("option", { name: "Done", exact: true }).click();
  await confirmation
    .getByRole("button", { name: "Delete status", exact: true })
    .click();
  await expect(confirmation).not.toBeVisible();
  await expect(
    settings.getByRole("button", { name: "Add status", exact: true }),
  ).toBeFocused();
  await expect(settings.getByLabel("Status name", { exact: true })).toHaveCount(
    4,
  );
  await expect(
    settings.getByRole("button", { name: "Archive board", exact: true }),
  ).toHaveCount(0);
  await settings
    .getByRole("button", { name: "Close dialog", exact: true })
    .click();
  await expect(page.getByRole("region", { name: "Done" })).toContainText(
    "Test database restore",
  );
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
      data: { title: "Board deletion parent" },
    },
  );
  expect(rootTaskResponse.ok()).toBeTruthy();
  const rootTask = (await rootTaskResponse.json()).task;
  const childResponse = await page.request.post(
    `/api/boards/${disposable.id}/tasks`,
    {
      headers: { Origin: baseOrigin },
      data: { title: "Board deletion child", parentId: rootTask.id },
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
  await page
    .getByRole("button", { name: "Board settings", exact: true })
    .click();
  await settings
    .getByRole("button", { name: "Delete board", exact: true })
    .click();
  const deletion = page.getByRole("dialog", {
    name: "Delete board?",
    exact: true,
  });
  await expect(deletion).toContainText(
    "statuses, tasks, subtasks, and comments",
  );
  await expect(deletion).toContainText("There is no restore");
  await deletion
    .getByRole("button", { name: "Keep board", exact: true })
    .click();
  await expect(
    settings.getByRole("button", { name: "Delete board", exact: true }),
  ).toBeFocused();
  await settings
    .getByRole("button", { name: "Delete board", exact: true })
    .click();
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
        deletion.getByRole("button", { name: "Keep board", exact: true }),
      ).toBeDisabled();
      await expect(
        deletion.getByRole("button", { name: "Close dialog", exact: true }),
      ).toBeDisabled();
      await expect(deletion).toBeVisible();
    },
    "Delete board?",
  );
  expect(await (await boardDeletion).json()).toEqual({ ok: true });
  await expect(page).toHaveURL(`/boards/${boardId}`);
  await expect(page.getByRole("dialog")).toHaveCount(0);
  const nav = page.getByRole("navigation", { name: "Workspace navigation" });
  await expect(
    nav.getByRole("link", { name: disposable.name, exact: true }),
  ).toHaveCount(0);
  expect(
    (await page.request.get(`/api/boards/${disposable.id}`)).status(),
  ).toBe(404);
  const { database, schema } = await browserDatabase();
  try {
    for (const table of ["boards", "columns", "tasks", "activity"]) {
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

test("long content, many statuses, tablet/phone themes and operational errors", async ({
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
      checklist: Array.from({ length: 25 }, (_, i) => ({
        id: crypto.randomUUID(),
        text: `Verify case ${i + 1}: long checklist content wraps without hiding the remove action or checkbox.`,
        done: i < 3,
      })),
    },
  });
  for (let i = 0; i < 12; i++)
    await page.request.post(`/api/boards/${boardId}/columns`, {
      headers: { Origin: baseOrigin },
      data: { name: `Additional status ${i + 1}`, color: "gray" },
    });
  await page.goto(`/boards/${boardId}/tasks/${taskId}`);
  await page.getByRole("button", { name: /Status$/ }).click();
  const list = page.getByRole("listbox");
  await expect(list).toBeVisible();
  await list.hover();
  await page.mouse.wheel(0, 700);
  await expect
    .poll(() => list.evaluate((el) => el.scrollTop))
    .toBeGreaterThan(0);
  await page.screenshot({
    path: "docs/screenshots/task-overlay-light.png",
    fullPage: true,
    animations: "disabled",
  });
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "Close", exact: true }).click();
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
    if (width < 700) {
      await page.getByRole("button", { name: /Board column$/ }).click();
      await page.getByRole("option", { name: /^Done \(\d+\)$/ }).click();
    }
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
  await expect(
    networkError.getByText(
      "Mill could not be reached. Check your connection and try again.",
      { exact: true },
    ),
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
test("larger boards preserve pagination and filters while many-member selects scroll", async ({
  page,
}) => {
  await login(page, {
    email: "browser-layout@example.test",
    password: "Layout-only-password-42",
  });
  const { database, schema } = await browserDatabase();
  try {
    await database.begin(async (tx) => {
      await tx.unsafe(
        `INSERT INTO "${schema}".users(id,workspace_id,name,email,password_hash,role) SELECT gen_random_uuid(),u.workspace_id,'Reviewer '||lpad(i::text,3,'0'),'reviewer-'||i||'@example.test',u.password_hash,'viewer' FROM "${schema}".users u CROSS JOIN generate_series(1,20) i WHERE u.email='browser-layout@example.test'`,
      );
      const [board] = await tx.unsafe(
        `SELECT prefix,next_number FROM "${schema}".boards WHERE id=$1 FOR UPDATE`,
        [boardId],
      );
      const [column] = await tx.unsafe(
        `SELECT id FROM "${schema}".columns WHERE board_id=$1 ORDER BY position LIMIT 1`,
        [boardId],
      );
      await tx.unsafe(
        `INSERT INTO "${schema}".tasks(board_id,column_id,identifier,title,created_by,position) SELECT $1,$2,$3||'-'||($4::int+i-1),'Scale task '||lpad(i::text,3,'0'),u.id,i-1 FROM "${schema}".users u CROSS JOIN generate_series(1,105) i WHERE u.email='browser-layout@example.test'`,
        [boardId, column.id, board.prefix, board.next_number],
      );
      await tx.unsafe(
        `UPDATE "${schema}".boards SET next_number=next_number+105 WHERE id=$1`,
        [boardId],
      );
    });
  } finally {
    await database.end();
  }
  await page.goto(`/boards/${boardId}`);
  const filtered = page.waitForResponse(
    (response) =>
      response.url().includes(`/api/boards/${boardId}/tasks?`) &&
      new URL(response.url()).searchParams.get("q") === "Scale task",
  );
  await page.getByLabel("Search tasks").fill("Scale task");
  await (await filtered).finished();
  await expect(page.locator(".task-card")).toHaveCount(100);
  await page.getByRole("button", { name: "Load more tasks" }).click();
  await expect(page.locator(".task-card")).toHaveCount(105);
  await page
    .locator(".task-card")
    .filter({ hasText: "Scale task 105" })
    .click();
  await page
    .getByLabel("Title", { exact: true })
    .fill("Scale task 105 reviewed");
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
  await page.getByRole("button", { name: "Save changes" }).click();
  await expect(
    page.getByRole("status").filter({ hasText: "Changes saved" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Close", exact: true }).click();
  await expect(page.getByLabel("Search tasks")).toHaveValue("Scale task");
  await expect(page.locator(".task-card")).toHaveCount(105);
  await expect(
    page.locator(".task-card").filter({ hasText: "Scale task 105 reviewed" }),
  ).toBeVisible();
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
      page.getByRole("heading", { name: "Something went wrong" }),
    ).toBeVisible();
    const serverError = page
      .getByRole("main")
      .locator("section")
      .filter({
        has: page.getByRole("heading", {
          name: "Something went wrong",
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
  await expect(page.locator(".task-card")).toHaveCount(100);
});

test("existing-task load failures preserve identity and recover without creating a task", async ({
  page,
}) => {
  const accepted = await page.request.post("/api/auth/accept-invitation", {
    headers: { Origin: baseOrigin },
    data: {
      token: detailInvitationToken,
      name: "Detail Review",
      password: "Detail-only-password-42",
    },
  });
  expect(accepted.ok()).toBeTruthy();
  let creations = 0;
  page.on("request", (request) => {
    if (
      request.method() === "POST" &&
      new URL(request.url()).pathname === `/api/boards/${boardId}/tasks`
    )
      creations++;
  });
  const { database, schema } = await browserDatabase();
  let renamed = false;
  try {
    await database.unsafe(
      `ALTER TABLE "${schema}".comments RENAME TO comments_fault`,
    );
    renamed = true;
    await page.goto(`/boards/${boardId}/tasks/${taskId}`);
    const dialog = page.getByRole("dialog");
    await expect(dialog).toContainText("Unable to load this task");
    await expect(dialog.getByLabel("Title", { exact: true })).toHaveCount(0);
    await expect(
      dialog.getByRole("button", { name: /Save changes|Create task/ }),
    ).toHaveCount(0);
    await expect(
      dialog.getByRole("button", { name: "Reload task", exact: true }),
    ).toBeEnabled();
    expect(page.url()).toContain(`/tasks/${taskId}`);
    expect(creations).toBe(0);
  } finally {
    if (renamed)
      await database.unsafe(
        `ALTER TABLE "${schema}".comments_fault RENAME TO comments`,
      );
    await database.end();
  }
  await page.getByRole("button", { name: "Reload task", exact: true }).click();
  await expect(page.getByLabel("Title", { exact: true })).not.toHaveValue("");
  await expect(
    page.getByRole("button", { name: "Save changes", exact: true }),
  ).toBeVisible();
  await page.route(`**/api/tasks/${taskId}`, (route) => route.abort("failed"));
  await page.reload();
  await expect(page.getByRole("dialog")).toContainText(
    "Unable to load this task",
  );
  await expect(
    page
      .getByRole("dialog")
      .getByRole("button", { name: "Create task", exact: true }),
  ).toHaveCount(0);
  await page.unroute(`**/api/tasks/${taskId}`);
  await page.getByRole("button", { name: "Reload task", exact: true }).click();
  await expect(page.getByLabel("Title", { exact: true })).not.toHaveValue("");
  expect(creations).toBe(0);
});

test("sidebar autoloads every board, retries directory failures, and keeps Create Project last", async ({
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
        `INSERT INTO "${schema}".boards(workspace_id,name,prefix,position) VALUES ($1,$2,$3,$4) RETURNING id`,
        [
          board.workspace_id,
          `Directory board ${String(i).padStart(3, "0")}`,
          `DIR${i}`,
          1000 + i,
        ],
      );
      fixtureBoardIds.push(created.id);
      await database.unsafe(
        `INSERT INTO "${schema}".columns(board_id,name,position) VALUES ($1,'Backlog',0)`,
        [created.id],
      );
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
      .then((response) => response.json());
    const firstCount = initial.items.filter((item: { name: string }) =>
      item.name.startsWith("Directory board "),
    ).length;
    let release!: () => void;
    let started!: () => void;
    let continued!: () => void;
    let held = false;
    const pending = new Promise<void>((resolve) => (release = resolve));
    const requestStarted = new Promise<void>((resolve) => (started = resolve));
    const requestContinued = new Promise<void>(
      (resolve) => (continued = resolve),
    );
    const delayContinuation = async (route: Route) => {
      const url = new URL(route.request().url());
      if (!url.searchParams.has("cursor") || held) return route.continue();
      expect(url.searchParams.get("directory")).toBe("true");
      held = true;
      started();
      await pending;
      try {
        await route.continue();
      } finally {
        continued();
      }
    };
    await page.route("**/api/boards?**", delayContinuation);
    const nav = page.getByRole("navigation", { name: "Workspace navigation" });
    const section = nav.locator("section").filter({
      has: page.getByRole("heading", { name: "Boards", exact: true }),
    });
    const directoryLinks = section.getByRole("link", {
      name: /^Directory board /,
    });
    try {
      await page.goto(`/boards/${boardId}`);
      await requestStarted;
      await expect(directoryLinks).toHaveCount(firstCount);
      const anchor = initial.items.at(-1);
      const moved = await page.request.patch(`/api/boards/${anchor.id}`, {
        headers: { Origin: baseOrigin },
        data: { version: anchor.version, beforeId: null },
      });
      expect(moved.ok()).toBeTruthy();
    } finally {
      release();
      await requestContinued;
      await page.unroute("**/api/boards?**", delayContinuation);
    }
    // The stale continuation restarts the directory, then loads every page.
    await expect(directoryLinks).toHaveCount(234);
    await expect(
      section.getByRole("heading", { name: "Boards", exact: true }),
    ).toBeVisible();
    await expect(
      nav.getByRole("button", { name: "Boards", exact: true }),
    ).toHaveCount(0);
    await expect(
      nav.getByRole("button", { name: /Board collection$/ }),
    ).toHaveCount(0);
    await expect(
      nav.getByRole("button", { name: "Load more boards", exact: true }),
    ).toHaveCount(0);
    await expect(section.locator("a,button").last()).toHaveText(
      "Create Project",
    );
    const abortContinuation = async (route: Route) => {
      if (!new URL(route.request().url()).searchParams.has("cursor"))
        return route.continue();
      await route.abort("failed");
    };
    await page.route("**/api/boards?**", abortContinuation);
    await page.reload();
    await expect(nav.getByRole("alert")).toContainText("could not be reached");
    const updatedFirst = await page.request
      .get("/api/boards?directory=true&limit=100")
      .then((response) => response.json());
    const retainedCount = updatedFirst.items.filter((item: { name: string }) =>
      item.name.startsWith("Directory board "),
    ).length;
    await expect(directoryLinks).toHaveCount(retainedCount);
    await expect(section.locator("a,button").last()).toHaveText(
      "Create Project",
    );
    await page.unroute("**/api/boards?**", abortContinuation);
    await nav
      .getByRole("button", { name: "Retry loading boards", exact: true })
      .click();
    await expect(directoryLinks).toHaveCount(234);
    await expect(nav.getByRole("alert")).toHaveCount(0);
    await nav.getByRole("button", { name: /^Account menu for / }).click();
    await page
      .getByRole("menu")
      .getByRole("menuitem", { name: "Profile", exact: true })
      .click();
    await expect(directoryLinks).toHaveCount(234);
    await expect(section.locator("a,button").last()).toHaveText(
      "Create Project",
    );
    await nav
      .getByRole("button", { name: "Create Project", exact: true })
      .click();
    const dialog = page.getByRole("dialog");
    await dialog
      .getByLabel("Board name", { exact: true })
      .fill("Created beyond the first page");
    await dialog.getByLabel("Task prefix", { exact: true }).fill("LATE");
    const creation = page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === "/api/boards" &&
        response.request().method() === "POST",
    );
    await dialog
      .getByRole("button", { name: "Create board", exact: true })
      .click();
    const created = await (await creation).json();
    expect(created.board.id).toMatch(/^[0-9a-f-]{36}$/);
    fixtureBoardIds.push(created.board.id);
    await expect(
      page.getByRole("heading", {
        name: "Created beyond the first page",
        exact: true,
      }),
    ).toBeVisible();
    await expect(
      nav.getByRole("link", {
        name: "Created beyond the first page",
        exact: true,
      }),
    ).toBeVisible();
    await expect(directoryLinks).toHaveCount(234);
    await expect(section.locator("a,button").last()).toHaveText(
      "Create Project",
    );
    await expect(
      nav.getByRole("status").filter({ hasText: "Loading boards" }),
    ).toHaveCount(0);
    let releaseRefreshFirst!: () => void;
    let releaseRefreshSecond!: () => void;
    let refreshFirstStarted!: () => void;
    let refreshSecondStarted!: () => void;
    let refreshFirstContinued!: () => void;
    let refreshSecondContinued!: () => void;
    let firstRefreshHeld = false;
    let secondRefreshHeld = false;
    const holdRefreshFirst = new Promise<void>(
      (resolve) => (releaseRefreshFirst = resolve),
    );
    const holdRefreshSecond = new Promise<void>(
      (resolve) => (releaseRefreshSecond = resolve),
    );
    const refreshFirstRequest = new Promise<void>(
      (resolve) => (refreshFirstStarted = resolve),
    );
    const refreshSecondRequest = new Promise<void>(
      (resolve) => (refreshSecondStarted = resolve),
    );
    const refreshFirstComplete = new Promise<void>(
      (resolve) => (refreshFirstContinued = resolve),
    );
    const refreshSecondComplete = new Promise<void>(
      (resolve) => (refreshSecondContinued = resolve),
    );
    const holdRefresh = async (route: Route) => {
      const url = new URL(route.request().url());
      if (url.searchParams.get("directory") !== "true") return route.continue();
      if (!url.searchParams.has("cursor") && !firstRefreshHeld) {
        firstRefreshHeld = true;
        refreshFirstStarted();
        await holdRefreshFirst;
        try {
          await route.continue();
        } finally {
          refreshFirstContinued();
        }
      } else if (url.searchParams.has("cursor") && !secondRefreshHeld) {
        secondRefreshHeld = true;
        refreshSecondStarted();
        await holdRefreshSecond;
        try {
          await route.continue();
        } finally {
          refreshSecondContinued();
        }
      } else await route.continue();
    };
    await page.route("**/api/boards?**", holdRefresh);
    try {
      await page
        .getByRole("button", { name: "Board settings", exact: true })
        .click();
      const boardSettings = page.getByRole("dialog", {
        name: "Board settings",
        exact: true,
      });
      await boardSettings
        .getByLabel("Board name", { exact: true })
        .fill("Saved beyond the first page");
      await boardSettings
        .getByRole("button", { name: "Save board", exact: true })
        .click();
      await refreshFirstRequest;
      await expect(boardSettings.getByRole("status")).toContainText(
        "Board updated.",
      );
      await boardSettings
        .getByRole("button", { name: "Close dialog", exact: true })
        .click();
      await expect(directoryLinks).toHaveCount(234);
      await expect(
        nav.getByRole("link", {
          name: "Created beyond the first page",
          exact: true,
        }),
      ).toBeVisible();
      await expect(section.locator("a,button").last()).toHaveText(
        "Create Project",
      );
      releaseRefreshFirst();
      await refreshFirstComplete;
      await refreshSecondRequest;
      await expect(directoryLinks).toHaveCount(234);
      await expect(
        nav.getByRole("link", {
          name: "Created beyond the first page",
          exact: true,
        }),
      ).toBeVisible();
      await expect(section.locator("a,button").last()).toHaveText(
        "Create Project",
      );
    } finally {
      releaseRefreshFirst();
      releaseRefreshSecond();
      if (firstRefreshHeld) await refreshFirstComplete;
      if (secondRefreshHeld) await refreshSecondComplete;
      await page.unroute("**/api/boards?**", holdRefresh);
    }
    await expect(
      nav.getByRole("link", {
        name: "Saved beyond the first page",
        exact: true,
      }),
    ).toBeVisible();
    const current = await page.request
      .get(`/api/boards/${created.board.id}`)
      .then((response) => response.json());
    const renamed = await page.request.patch(
      `/api/boards/${created.board.id}`,
      {
        headers: { Origin: baseOrigin },
        data: {
          version: current.board.version,
          name: "Server-renamed later board",
        },
      },
    );
    expect(renamed.ok()).toBeTruthy();
    await page.reload();
    await expect(
      nav.getByRole("link", {
        name: "Server-renamed later board",
        exact: true,
      }),
    ).toBeVisible();
    await expect(
      nav.getByRole("link", {
        name: "Created beyond the first page",
        exact: true,
      }),
    ).toHaveCount(0);
    await expect(directoryLinks).toHaveCount(234);
    await page
      .getByRole("button", { name: "Board settings", exact: true })
      .click();
    await page
      .getByRole("dialog", { name: "Board settings", exact: true })
      .getByRole("button", { name: "Delete board", exact: true })
      .click();
    await page
      .getByRole("dialog", { name: "Delete board?", exact: true })
      .getByRole("button", { name: "Delete board", exact: true })
      .click();
    await expect(
      nav.getByRole("link", {
        name: "Server-renamed later board",
        exact: true,
      }),
    ).toHaveCount(0);
    await expect(directoryLinks).toHaveCount(234);
    await expect(section.locator("a,button").last()).toHaveText(
      "Create Project",
    );
    expect(
      (await page.request.get(`/api/boards/${created.board.id}`)).status(),
    ).toBe(404);
    await expect(
      nav.getByRole("status").filter({ hasText: "Loading boards" }),
    ).toHaveCount(0);
    const creationContinuation = requestGate();
    const deletionFirstPage = requestGate();
    const deletionContinuation = requestGate();
    let deletingPendingBoard = false;
    let heldCreationContinuation = false;
    let heldDeletionFirst = false;
    let heldDeletionContinuation = false;
    const delayPendingBoardPages = async (route: Route) => {
      const url = new URL(route.request().url());
      if (url.searchParams.get("directory") !== "true") return route.continue();
      if (
        !deletingPendingBoard &&
        url.searchParams.has("cursor") &&
        !heldCreationContinuation
      ) {
        heldCreationContinuation = true;
        return creationContinuation.hold(route);
      }
      if (
        deletingPendingBoard &&
        !url.searchParams.has("cursor") &&
        !heldDeletionFirst
      ) {
        heldDeletionFirst = true;
        return deletionFirstPage.hold(route);
      }
      if (
        deletingPendingBoard &&
        url.searchParams.has("cursor") &&
        !heldDeletionContinuation
      ) {
        heldDeletionContinuation = true;
        return deletionContinuation.hold(route);
      }
      return route.continue();
    };
    await page.route("**/api/boards?**", delayPendingBoardPages);
    try {
      await nav
        .getByRole("button", { name: "Create Project", exact: true })
        .click();
      const pendingCreationDialog = page.getByRole("dialog");
      await pendingCreationDialog
        .getByLabel("Board name", { exact: true })
        .fill("Deleted during creation refresh");
      await pendingCreationDialog
        .getByLabel("Task prefix", { exact: true })
        .fill("PENDING");
      const pendingCreation = page.waitForResponse(
        (response) =>
          new URL(response.url()).pathname === "/api/boards" &&
          response.request().method() === "POST",
      );
      await pendingCreationDialog
        .getByRole("button", { name: "Create board", exact: true })
        .click();
      const pendingBoard = (await (await pendingCreation).json()).board;
      fixtureBoardIds.push(pendingBoard.id);
      await creationContinuation.started;
      await expect(
        page.getByRole("heading", { name: pendingBoard.name, exact: true }),
      ).toBeVisible();
      await expect(
        nav.getByRole("link", { name: pendingBoard.name, exact: true }),
      ).toBeVisible();
      await expect(directoryLinks).toHaveCount(234);
      await expect(
        nav.getByRole("link", { name: "Directory board 234", exact: true }),
      ).toBeVisible();
      await expect(section.locator("a,button").last()).toHaveText(
        "Create Project",
      );
      await page
        .getByRole("button", { name: "Board settings", exact: true })
        .click();
      await page
        .getByRole("dialog", { name: "Board settings", exact: true })
        .getByRole("button", { name: "Delete board", exact: true })
        .click();
      deletingPendingBoard = true;
      const pendingDeletion = page.waitForResponse(
        (response) =>
          new URL(response.url()).pathname ===
            `/api/boards/${pendingBoard.id}` &&
          response.request().method() === "DELETE",
      );
      await page
        .getByRole("dialog", { name: "Delete board?", exact: true })
        .getByRole("button", { name: "Delete board", exact: true })
        .click();
      expect(await (await pendingDeletion).json()).toEqual({ ok: true });
      await deletionFirstPage.started;
      await expect(page.getByRole("dialog")).toHaveCount(0);
      await expect(
        nav.getByRole("link", { name: pendingBoard.name, exact: true }),
      ).toHaveCount(0);
      await expect(directoryLinks).toHaveCount(234);
      await expect(
        nav.getByRole("link", { name: "Directory board 234", exact: true }),
      ).toBeVisible();
      await creationContinuation.finish();
      await expect(
        nav.getByRole("link", { name: pendingBoard.name, exact: true }),
      ).toHaveCount(0);
      await expect(directoryLinks).toHaveCount(234);
      await deletionFirstPage.finish();
      await deletionContinuation.started;
      await expect(
        nav.getByRole("link", { name: pendingBoard.name, exact: true }),
      ).toHaveCount(0);
      await expect(directoryLinks).toHaveCount(234);
      await expect(
        nav.getByRole("link", { name: "Directory board 234", exact: true }),
      ).toBeVisible();
      await expect(section.locator("a,button").last()).toHaveText(
        "Create Project",
      );
      await deletionContinuation.finish();
      await expect(
        nav.getByRole("status").filter({ hasText: "Loading boards" }),
      ).toHaveCount(0);
      await expect(
        nav.getByRole("link", { name: pendingBoard.name, exact: true }),
      ).toHaveCount(0);
      await expect(directoryLinks).toHaveCount(234);
      await expect(
        nav.getByRole("link", { name: "Directory board 234", exact: true }),
      ).toBeVisible();
      await expect(section.locator("a,button").last()).toHaveText(
        "Create Project",
      );
      expect(
        (await page.request.get(`/api/boards/${pendingBoard.id}`)).status(),
      ).toBe(404);
    } finally {
      await creationContinuation.finish();
      await deletionFirstPage.finish();
      await deletionContinuation.finish();
      await page.unroute("**/api/boards?**", delayPendingBoardPages);
    }
  } finally {
    try {
      if (fixtureBoardIds.length) {
        await database.begin(async (tx) => {
          const tasks = await tx.unsafe(
            `SELECT id FROM "${schema}".tasks WHERE board_id=ANY($1::uuid[])`,
            [fixtureBoardIds],
          );
          expect(tasks).toHaveLength(0);
          await tx.unsafe(
            `DELETE FROM "${schema}".boards WHERE id=ANY($1::uuid[])`,
            [fixtureBoardIds],
          );
        });
        const retained = await database.unsafe(
          `SELECT id FROM "${schema}".boards WHERE id=$1`,
          [boardId],
        );
        expect(retained).toHaveLength(1);
      }
    } finally {
      await database.end();
    }
  }
});

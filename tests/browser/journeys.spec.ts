import { readFile } from "node:fs/promises";
import postgres from "postgres";
import { expect, test, type Page } from "@playwright/test";
const account = {
  email: "browser-admin@example.test",
  password: "Browser-only-password-42",
  name: "Alex Morgan",
  workspaceName: "Mill browser verification",
};
const baseOrigin = process.env.MILL_BROWSER_BASE_URL ?? "http://localhost:4323";
let boardId = "";
let taskId = "";
let layoutInvitationToken = "";
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
    .getByRole("button", { name: "Create workspace", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Create your first board" }),
  ).toBeVisible();
  const layoutInvitation = await page.request
    .post("/api/auth/invitations", {
      headers: { Origin: baseOrigin },
      data: { email: "browser-layout@example.test", role: "admin" },
    })
    .then((r) => r.json());
  layoutInvitationToken = layoutInvitation.token;
  await page.getByRole("button", { name: "Create your first board" }).click();
  await page.getByLabel("Board name", { exact: true }).fill("Release planning");
  await page.getByLabel("Task prefix", { exact: true }).fill("REL");
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Create board", exact: true })
    .click();
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
    .getByLabel("Markdown description", { exact: true })
    .fill(
      "## Release\nReview **all journeys**. [Unsafe](javascript:alert(1)) <script>alert(2)</script>",
    );
  await page.getByLabel("New checklist item").fill("Verify installation");
  await page.getByRole("button", { name: "Add checklist item" }).click();
  await page.getByRole("button", { name: "Create task", exact: true }).click();
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
  await page.getByRole("button", { name: "Preview", exact: true }).click();
  await expect(page.getByRole("link", { name: "Unsafe" })).not.toHaveAttribute(
    "href",
    /javascript:/,
  );
  await expect(page.locator(".markdown script")).toHaveCount(0);
  await page.getByRole("button", { name: "Write", exact: true }).click();
  await page
    .getByLabel("Markdown description")
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
  await page.getByRole("button", { name: "Comment", exact: true }).click();
  await expect(page.locator(".comment")).toContainText("Ready for review.");
  await page.getByRole("button", { name: "Add subtask" }).click();
  await expect(
    page.getByRole("dialog").getByRole("heading", { name: "New subtask" }),
  ).toBeVisible();
  await page.getByLabel("Title", { exact: true }).fill("Test database restore");
  await page.getByRole("button", { name: "Create task", exact: true }).click();
  await expect(
    page.getByRole("dialog").getByRole("heading", { name: "REL-2" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Close", exact: true }).click();
  await page
    .getByRole("button", { name: "Board settings", exact: true })
    .click();
  await page.getByLabel("New status").fill("Review");
  await page.getByRole("button", { name: "Add status" }).click();
  await expect(page.getByLabel("Status name").nth(3)).toHaveValue("Review");
  await expect(
    page.getByRole("button", { name: "Add status", exact: true }),
  ).toBeFocused();
  await page.getByRole("button", { name: "Move Review earlier" }).click();
  await expect(
    page.getByRole("button", { name: "Move Review earlier" }),
  ).toBeFocused();
  await page.getByRole("button", { name: "Done", exact: true }).click();
  await expect(page.getByRole("region", { name: "In progress" })).toContainText(
    "Prepare the release and recovery checklist",
  );
  await page.screenshot({
    path: "docs/screenshots/desktop-light.png",
    fullPage: true,
    animations: "disabled",
  });
  await page.getByRole("button", { name: "Use dark theme" }).click();
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
  await page.screenshot({
    path: "docs/screenshots/task-detail-dark.png",
    fullPage: true,
    animations: "disabled",
  });
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
  await expect(page.getByRole("table", { name: "Task list" })).toContainText(
    "Prepare the release and recovery checklist",
  );
  await page.getByRole("button", { name: "Clear filters" }).click();
  await expect(page.getByRole("table", { name: "Task list" })).toContainText(
    "Test database restore",
  );
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole("button", { name: "Kanban view" }).click();
  await choose(page, "Board column", "Done (1)");
  await page.getByRole("button", { name: "Open navigation" }).click();
  await expect(
    page.getByRole("button", { name: "Close navigation" }),
  ).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(
    page.getByRole("button", { name: "Open navigation" }),
  ).toBeFocused();
  await page.getByRole("button", { name: "Open navigation" }).click();
  await page.getByRole("button", { name: "Use dark theme" }).click();
  await page.getByRole("button", { name: "Close navigation" }).click();
  await expect(page.getByRole("region", { name: "Done" })).toBeVisible();
  await page.screenshot({
    path: "docs/screenshots/mobile-dark.png",
    fullPage: true,
    animations: "disabled",
  });
  await page.getByRole("button", { name: "Open navigation" }).click();
  await page.getByRole("link", { name: "Account security" }).click();
  await expect(
    page.getByRole("heading", { name: "Account security" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Open navigation" }).click();
  await page.getByRole("link", { name: account.name }).click();
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
  await login(page);
  await page.goto("/settings/members");
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
  await expect(page.getByRole("status")).toContainText("Invitation created");
  const viewerContext = await browser.newContext();
  const viewer = await viewerContext.newPage();
  await viewer.goto(invitation.inviteUrl);
  await viewer.getByLabel("Your name").fill("Jamie Viewer");
  await viewer
    .getByLabel("Password", { exact: true })
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
  await viewer.goto("/notifications");
  await expect(viewer.locator(".notification")).toHaveCount(2);
  await viewer.getByRole("button", { name: "Mark all read" }).click();
  await expect(viewer.locator(".notification.unread")).toHaveCount(0);
  await viewer.goto(`/boards/${boardId}/tasks/${taskId}`);
  await expect(viewer.getByLabel("Title", { exact: true })).toBeDisabled();
  await expect(
    viewer.getByRole("button", { name: "Save changes" }),
  ).toHaveCount(0);
  await viewerContext.close();
  await page.goto("/settings/agents");
  await page.getByLabel("Name", { exact: true }).fill("Review agent");
  await choose(page, "Permissions", "Read tasks");
  await page.getByRole("button", { name: "Create credential" }).click();
  await expect(page.getByLabel("Token · shown once")).not.toHaveValue("");
  await page.getByRole("button", { name: "Revoke", exact: true }).click();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Confirm", exact: true })
    .click();
  await expect(page.getByText("Revoked", { exact: true })).toBeVisible();
});

test("task archive, delete, and restoration stay reversible", async ({
  page,
}) => {
  await login(page);
  await page.goto(`/boards/${boardId}/tasks/${taskId}`);
  await page.getByRole("button", { name: "Archive task", exact: true }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await choose(page, "Task view", "Archived tasks");
  await page
    .locator(".task-card")
    .filter({ hasText: "Another person’s update" })
    .click();
  await page.getByRole("button", { name: "Restore from archive" }).click();
  await choose(page, "Task view", "Active tasks");
  await page
    .locator(".task-card")
    .filter({ hasText: "Another person’s update" })
    .click();
  await page.getByRole("button", { name: "Delete task", exact: true }).click();
  await page
    .getByRole("dialog")
    .filter({ has: page.getByRole("heading", { name: "Delete this task?" }) })
    .getByRole("button", { name: "Delete task", exact: true })
    .click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await choose(page, "Task view", "Deleted tasks");
  await page.locator(".task-card").click();
  await page.getByRole("button", { name: "Restore task", exact: true }).click();
  await choose(page, "Task view", "Active tasks");
  await expect(
    page.locator(".task-card").filter({ hasText: "Another person’s update" }),
  ).toBeVisible();
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
    if (width < 700)
      await page.getByRole("button", { name: "Open navigation" }).click();
    const toggle = page.getByRole("button", {
      name: theme === "light" ? "Use light theme" : "Use dark theme",
    });
    if (await toggle.isVisible()) await toggle.click();
    if (width < 700)
      await page.getByRole("button", { name: "Close navigation" }).click();
    if (width < 700) await choose(page, "Board column", "Done (1)");
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
  await expect(page.getByRole("alert")).toContainText("could not be reached");
  await page.screenshot({
    path: "docs/screenshots/network-error.png",
    fullPage: true,
    animations: "disabled",
  });
  await page.unroute(`**/api/boards/${boardId}/tasks?**`);
  await page.reload();
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
    await expect(page.locator(".error-page")).toContainText("500");
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

import { readFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import postgres from "postgres";
import {
  expect,
  request as apiRequests,
  test,
  type APIRequestContext,
  type Browser,
  type Locator,
  type Page,
} from "@playwright/test";
import { Secret, TOTP } from "otpauth";
import { getBrowserBootstrap } from "../browser-fixture.js";

// Secret reveal steps must not enter automatic failure artifacts.
process.env.PLAYWRIGHT_NO_COPY_PROMPT = "1";
test.use({ trace: "off", screenshot: "off" });

const password = "Settings-only-password-42";
type Account = { email: string; name: string; password: string; id: string };
let origin = "";
let admin: Account;
let adminApi: APIRequestContext;
let board: { id: string; name: string };
let columnId = "";

async function json(
  api: APIRequestContext,
  path: string,
  data?: unknown,
  method = "POST",
) {
  const result = await api.fetch(`/api${path}`, {
    method: data === undefined ? "GET" : method,
    headers: { Origin: origin },
    data,
  });
  expect(
    result.ok(),
    `${method} ${path}: status ${result.status()}`,
  ).toBeTruthy();
  return result.json();
}
async function createAccount(
  email: string,
  name: string,
  role: "admin" | "member" | "viewer" = "member",
): Promise<Account> {
  const invitation = await json(adminApi, "/auth/invitations", { email, role });
  const temporary = await apiRequests.newContext({ baseURL: origin });
  try {
    const accepted = await json(temporary, "/auth/accept-invitation", {
      token: invitation.token,
      name,
      password,
    });
    return { email, name, password, id: accepted.user.id };
  } finally {
    await temporary.dispose();
  }
}
async function login(page: Page, account: Account) {
  await page.goto(`${origin}/`);
  await page.getByLabel("Email", { exact: true }).fill(account.email);
  await page.getByLabel("Password", { exact: true }).fill(account.password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(
    page.getByRole("navigation", { name: "Workspace navigation" }),
  ).toBeVisible();
}
async function choose(
  page: Page,
  label: string,
  value: string,
  scope: Page | Locator = page,
) {
  await scope.getByRole("button", { name: new RegExp(`${label}$`) }).click();
  await page.getByRole("option", { name: value, exact: true }).click();
}
async function accountAction(
  page: Page,
  action: "Profile" | "Account security" | "Sign out",
) {
  await page.getByRole("button", { name: /^Account menu for / }).click();
  await page
    .getByRole("menu")
    .getByRole("menuitem", { name: action, exact: true })
    .click();
}
async function signOut(page: Page) {
  await accountAction(page, "Sign out");
  await expect(
    page.getByRole("heading", { name: "Sign in to Mill" }),
  ).toBeVisible();
}
async function confirmPassword(page: Page, value = password) {
  const dialog = page.getByRole("dialog", { name: /Confirm it/ });
  await expect(dialog).toBeVisible();
  await dialog.getByLabel("Password", { exact: true }).fill(value);
  await dialog.getByRole("button", { name: "Confirm", exact: true }).click();
}
async function contextPage(browser: Browser) {
  const context = await browser.newContext({ baseURL: origin });
  return { context, page: await context.newPage() };
}

test.describe.configure({ mode: "serial" });
test.beforeAll(async ({ playwright, baseURL }) => {
  const fixture = await getBrowserBootstrap(baseURL!);
  origin = fixture.origin;
  const root = fixture.api;
  adminApi = root;
  const invitation = await json(root, "/auth/invitations", {
    email: "settings-admin@example.test",
    role: "admin",
  });
  adminApi = await playwright.request.newContext({ baseURL: origin });
  const accepted = await json(adminApi, "/auth/accept-invitation", {
    token: invitation.token,
    name: "Casey Settings",
    password,
  });
  admin = {
    email: "settings-admin@example.test",
    name: "Casey Settings",
    password,
    id: accepted.user.id,
  };
  await root.dispose();
  const created = await json(adminApi, "/boards", {
    name: "Settings verification",
    prefix: "SET",
    description: "Independent account and administration verification",
  });
  board = created.board;
  const detail = await json(adminApi, `/boards/${board.id}`);
  columnId = detail.columns[0].id;
});
test.afterAll(async () => {
  await adminApi?.dispose();
});

test("profile preferences persist, UTC remains selectable, and a wrong current password leaves the session intact", async ({
  page,
}) => {
  await login(page, admin);
  await accountAction(page, "Profile");
  await page.getByLabel("Name", { exact: true }).click();
  await expect(page.getByLabel("Name", { exact: true })).toBeFocused();
  await choose(page, "Time zone", "UTC");
  await page
    .getByRole("button", { name: "Save preferences", exact: true })
    .click();
  await expect(
    page
      .getByRole("region", { name: "Profile details", exact: true })
      .getByRole("status"),
  ).toContainText("Preferences saved");
  await expect(
    page.getByRole("checkbox", { name: "Task assignments", exact: true }),
  ).toBeChecked();
  await page.getByText("Task assignments", { exact: true }).click();
  await expect(
    page.getByRole("checkbox", { name: "Task assignments", exact: true }),
  ).not.toBeChecked();
  await expect(
    page.getByRole("checkbox", { name: "Mentions in comments", exact: true }),
  ).toBeChecked();
  await page.getByLabel("Name", { exact: true }).fill("Unsaved profile draft");
  await page
    .getByRole("button", { name: "Save notifications", exact: true })
    .click();
  await expect(
    page
      .getByRole("region", { name: "Notifications", exact: true })
      .getByRole("status"),
  ).toContainText("Notifications saved");
  expect((await json(page.request, "/auth/me")).user.name).toBe(admin.name);
  await expect(page.getByLabel("Name", { exact: true })).toHaveValue(
    "Unsaved profile draft",
  );
  await page.reload();
  await expect(page.getByRole("button", { name: /Time zone$/ })).toContainText(
    "UTC",
  );
  await expect(
    page.getByLabel("Task assignments", { exact: true }),
  ).not.toBeChecked();
  const profile = await json(page.request, "/auth/me");
  expect(profile.user.notificationPreferences).toEqual({
    assignments: false,
    mentions: true,
  });
  expect(profile.user.timeZone).toBe("UTC");
  await accountAction(page, "Account security");
  await page
    .getByLabel("Current password", { exact: true })
    .fill("An incorrect password");
  await page
    .getByLabel("New password", { exact: true })
    .fill("Unused password change attempt 42!");
  await page
    .getByLabel("Confirm new password", { exact: true })
    .fill("Unused password change attempt 42!");
  await page
    .getByRole("button", { name: "Change password", exact: true })
    .click();
  await expect(page.getByRole("alert")).toContainText(
    "current password is incorrect",
  );
  expect((await page.request.get("/api/auth/me")).status()).toBe(200);
  await expect(page.getByText("This device", { exact: true })).toBeVisible();
  await page.screenshot({
    path: "docs/screenshots/account-security.png",
    fullPage: true,
    animations: "disabled",
  });
});

test("real browser passkey enrollment and sign-in prefer the passkey with working authenticator fallback", async ({
  page,
  context,
}) => {
  const account = await createAccount(
    "settings-security@example.test",
    "Security Casey",
  );
  await login(page, account);
  const cdp = await context.newCDPSession(page);
  await cdp.send("WebAuthn.enable");
  const { authenticatorId } = await cdp.send(
    "WebAuthn.addVirtualAuthenticator",
    {
      options: {
        protocol: "ctap2",
        transport: "internal",
        hasResidentKey: true,
        hasUserVerification: true,
        isUserVerified: true,
        automaticPresenceSimulation: true,
      },
    },
  );
  await accountAction(page, "Account security");
  await page.getByRole("button", { name: "Add passkey", exact: true }).click();
  await confirmPassword(page);
  await expect(
    page
      .getByRole("region", { name: "Passkeys", exact: true })
      .getByRole("status")
      .filter({ hasText: "Passkey added" }),
  ).toContainText("Passkey added");
  await expect(page.getByText("My passkey", { exact: false })).toBeVisible();
  const credentials = await cdp.send("WebAuthn.getCredentials", {
    authenticatorId,
  });
  expect(credentials.credentials.length).toBe(1);
  await page
    .getByRole("button", { name: "Set up authenticator", exact: true })
    .click();
  await confirmPassword(page);
  const authenticator = page.getByRole("region", {
    name: "Authenticator",
    exact: true,
  });
  const secret = (
    await authenticator.locator("code.secret").innerText()
  ).trim();
  const totp = new TOTP({ issuer: "Mill", secret: Secret.fromBase32(secret) });
  await page
    .getByLabel("Six-digit code", { exact: true })
    .fill(totp.generate());
  await page
    .getByRole("button", { name: "Verify authenticator", exact: true })
    .click();
  await expect(
    page.getByRole("dialog", { name: "Save your recovery codes" }),
  ).toBeVisible();
  const recoveryText = (
    await page.locator(".recovery-codes").innerText()
  ).trim();
  expect(recoveryText.split("\n").length).toBe(10);
  const recoveryDialog = page.getByRole("dialog", {
    name: "Save your recovery codes",
    exact: true,
  });
  const target = await cdp.send("Target.getTargetInfo");
  await cdp.send("Browser.setPermission", {
    permission: { name: "clipboard-write" },
    setting: "denied",
    origin,
    browserContextId: target.targetInfo.browserContextId,
  });
  await recoveryDialog.getByRole("button", { name: "Copy codes" }).click();
  await expect(recoveryDialog.getByRole("alert")).toContainText(
    "Copy the codes manually",
  );
  await context.grantPermissions(["clipboard-read", "clipboard-write"], {
    origin,
  });
  await recoveryDialog.getByRole("button", { name: "Copy codes" }).click();
  await expect(recoveryDialog.getByRole("status")).toHaveText(
    "Recovery codes copied.",
  );
  const copiedCodes = await page.evaluate(() => navigator.clipboard.readText());
  expect(copiedCodes.split("\n").length).toBe(10);
  expect(
    copiedCodes === recoveryText,
    "Clipboard exactly matches the generated recovery codes",
  ).toBe(true);
  await page.getByRole("button", { name: "I saved these codes" }).click();
  await expect(
    page.getByText("Recovery codes copied.", { exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByText("Authenticator enabled", { exact: true }),
  ).toBeVisible();
  await signOut(page);
  await page
    .getByRole("button", { name: "Sign in with a passkey", exact: true })
    .click();
  await expect(
    page.getByRole("navigation", { name: "Workspace navigation" }),
  ).toBeVisible();
  await signOut(page);
  await cdp.send("WebAuthn.setResponseOverrideBits", {
    authenticatorId,
    isBogusSignature: true,
  });
  await page.getByLabel("Email", { exact: true }).fill(account.email);
  await page.getByLabel("Password", { exact: true }).fill(password);
  const loginResult = page.waitForResponse(
    (r) =>
      r.url().endsWith("/api/auth/login") && r.request().method() === "POST",
  );
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  expect((await (await loginResult).json()).preferredMethod).toBe("passkey");
  await expect(
    page.getByRole("heading", { name: "Verify your sign-in" }),
  ).toBeVisible();
  await expect(page.getByRole("alert")).toContainText(
    "passkey could not be verified",
  );
  await expect(
    page.getByRole("button", { name: /Other verification method$/ }),
  ).toContainText("Authenticator code");
  await page
    .getByLabel("Six-digit code", { exact: true })
    .fill(totp.generate({ timestamp: Date.now() + 30000 }));
  await page.getByRole("button", { name: "Verify", exact: true }).click();
  await expect(
    page.getByRole("navigation", { name: "Workspace navigation" }),
  ).toBeVisible();
  const user = await json(page.request, "/auth/me");
  expect(user.user.totpEnabled).toBe(true);
  expect(user.user.passkeyCount).toBe(1);
  await cdp.send("WebAuthn.setResponseOverrideBits", { authenticatorId });
  await cdp.detach();
});

test("UI invitations admit viewer and member roles, show read-only controls and revoke pending access", async ({
  page,
  browser,
}) => {
  await login(page, admin);
  await page.getByRole("link", { name: "People", exact: true }).click();
  async function invitation(email: string, role: string) {
    await page
      .getByRole("button", { name: "Invite a person", exact: true })
      .click();
    const dialog = page.getByRole("dialog", {
      name: "Invite a person",
      exact: true,
    });
    await dialog.getByLabel("Email", { exact: true }).fill(email);
    await choose(page, "Role", role, dialog);
    await dialog
      .getByRole("button", { name: "Create invitation", exact: true })
      .click();
    const created = page.getByRole("dialog", {
      name: "Invitation created",
      exact: true,
    });
    await expect(created).toBeVisible();
    const url = await created
      .getByLabel("Invitation link", { exact: true })
      .inputValue();
    await created.getByRole("button", { name: "Done", exact: true }).click();
    return url;
  }
  for (const role of ["Viewer", "Member"]) {
    const url = await invitation(
      `settings-${role.toLowerCase()}@example.test`,
      role,
    );
    const { context, page: person } = await contextPage(browser);
    try {
      await person.goto(url);
      await expect(
        person.getByRole("heading", { name: "Join your workspace" }),
      ).toBeVisible();
      await person
        .getByLabel("Your name", { exact: true })
        .fill(`${role} Settings`);
      await person.getByLabel("Password", { exact: true }).fill(password);
      await person
        .getByLabel("Confirm password", { exact: true })
        .fill(password);
      await person
        .getByRole("button", { name: "Accept invitation", exact: true })
        .click();
      await expect(
        person.getByRole("navigation", { name: "Workspace navigation" }),
      ).toBeVisible();
      await person.goto(`/boards/${board.id}`);
      await expect(
        person.getByRole("heading", { name: board.name, exact: true }),
      ).toBeVisible();
      if (role === "Viewer") {
        await expect(
          person.getByRole("button", { name: "New task", exact: true }),
        ).toHaveCount(0);
        await person.goto("/settings/members");
        await expect(
          person.getByRole("heading", {
            name: "Administrator access required",
          }),
        ).toBeVisible();
      } else {
        await person
          .getByRole("button", { name: "New task", exact: true })
          .click();
        await person
          .getByLabel("Title", { exact: true })
          .fill("Member created a real task");
        await person
          .getByRole("dialog")
          .getByRole("button", { name: "Create task", exact: true })
          .click();
        await expect(
          person.getByRole("dialog").getByRole("heading", { name: /^SET-/ }),
        ).toBeVisible();
        await expect(person.getByLabel("Title", { exact: true })).toHaveValue(
          "Member created a real task",
        );
      }
    } finally {
      await context.close();
    }
  }
  await invitation("settings-pending@example.test", "Member");
  const pending = page
    .getByRole("region", { name: "Invitations", exact: true })
    .getByRole("row")
    .filter({ hasText: "settings-pending@example.test" });
  await pending
    .getByRole("button", {
      name: "Revoke invitation for settings-pending@example.test",
      exact: true,
    })
    .click();
  const revoke = page.getByRole("dialog", {
    name: "Revoke invitation for settings-pending@example.test?",
    exact: true,
  });
  await revoke
    .getByRole("button", { name: "Revoke invitation", exact: true })
    .click();
  await expect(revoke.getByRole("status")).toContainText("Invitation revoked");
  await revoke.getByRole("button", { name: "Done", exact: true }).click();
  await expect(pending).toContainText("Revoked");
  await page.reload();
  await expect(
    page
      .getByRole("region", { name: "Workspace members", exact: true })
      .getByRole("row")
      .filter({ hasText: "Viewer Settings" }),
  ).toContainText("Viewer");
  await expect(
    page
      .getByRole("region", { name: "Workspace members", exact: true })
      .getByRole("row")
      .filter({ hasText: "Member Settings" }),
  ).toContainText("Member");
  await page.screenshot({
    path: "docs/screenshots/people.png",
    fullPage: true,
    animations: "disabled",
  });
});

test("assignment and mention notifications open the correct task and preferences prevent new assignment alerts", async ({
  page,
}) => {
  const recipient = await createAccount(
    "settings-inbox@example.test",
    "Inbox Settings",
  );
  const task = await json(adminApi, `/boards/${board.id}/tasks`, {
    columnId,
    title: "Review notification delivery",
    assigneeId: recipient.id,
  });
  await json(adminApi, `/tasks/${task.task.id}/comments`, {
    body: `Please review this @${recipient.email}.`,
  });
  await login(page, recipient);
  await expect(
    page.getByRole("heading", { name: board.name, exact: true }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Open notifications", exact: true })
    .click();
  const notificationsList = page.getByRole("list", {
    name: "Notification list",
    exact: true,
  });
  const notificationItems = notificationsList.getByRole("listitem");
  const unreadItems = notificationItems.filter({
    has: page.getByText("Unread", { exact: true }),
  });
  await expect(notificationItems).toHaveCount(2);
  await expect(unreadItems).toHaveCount(2);
  await expect(notificationItems).toContainText([
    /mentioned you/i,
    /assigned.*you/i,
  ]);
  await page.screenshot({
    path: "docs/screenshots/notifications.png",
    fullPage: true,
    animations: "disabled",
  });
  await expect(
    page.getByRole("tablist", { name: "Notifications filter" }),
  ).toHaveCount(0);
  await page
    .getByRole("list", { name: "Notification list", exact: true })
    .getByRole("listitem")
    .filter({ hasText: /mentioned you/i })
    .getByRole("link")
    .click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await expect(page.getByLabel("Title", { exact: true })).toHaveValue(
    "Review notification delivery",
  );
  await page.getByRole("button", { name: "Close", exact: true }).click();
  await page
    .getByRole("button", { name: "Open notifications", exact: true })
    .click();
  await expect(unreadItems).toHaveCount(1);
  await page.getByRole("button", { name: "Mark all read" }).click();
  await expect(unreadItems).toHaveCount(0);
  await expect(notificationItems).toHaveCount(2);
  await expect(
    page.getByRole("button", { name: "Mark all read", exact: true }),
  ).toBeDisabled();
  await page.keyboard.press("Escape");
  await accountAction(page, "Profile");
  await expect(
    page.getByRole("checkbox", { name: "Task assignments", exact: true }),
  ).toBeChecked();
  await page.getByText("Task assignments", { exact: true }).click();
  await expect(
    page.getByRole("checkbox", { name: "Task assignments", exact: true }),
  ).not.toBeChecked();
  await page
    .getByRole("button", { name: "Save notifications", exact: true })
    .click();
  await expect(
    page
      .getByRole("region", { name: "Notifications", exact: true })
      .getByRole("status"),
  ).toContainText("Notifications saved");
  await json(adminApi, `/boards/${board.id}/tasks`, {
    columnId,
    title: "Assignment preference excludes this alert",
    assigneeId: recipient.id,
  });
  await page
    .getByRole("button", { name: "Open notifications", exact: true })
    .click();
  await expect(unreadItems).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Mark all read", exact: true }),
  ).toBeDisabled();
  const notifications = await json(page.request, "/notifications");
  expect(notifications.items).toHaveLength(2);
  expect(notifications.unreadCount).toBe(0);
  await expect(notificationItems).toHaveCount(2);
  await expect(unreadItems).toHaveCount(0);
});

test("a scoped credential created through the interface works on its board and loses access when revoked", async ({
  page,
  playwright,
}) => {
  await login(page, admin);
  await page.getByRole("link", { name: "Agent access", exact: true }).click();
  await page
    .getByRole("button", { name: "Create credential", exact: true })
    .click();
  const create = page.getByRole("dialog", {
    name: "Create credential",
    exact: true,
  });
  await create.getByLabel("Name", { exact: true }).fill("Settings board agent");
  await choose(page, "Access", "Read and write", create);
  await choose(page, "Board access", board.name, create);
  await create.getByLabel("Expires in days", { exact: true }).fill("7");
  await create
    .getByRole("button", { name: "Create credential", exact: true })
    .click();
  const success = page.getByRole("dialog", {
    name: "Copy your credential",
    exact: true,
  });
  await expect(success).toBeVisible();
  const token = await success
    .getByLabel("Credential", { exact: true })
    .inputValue();
  await success.getByRole("button", { name: "Done", exact: true }).click();
  const agent = await playwright.request.newContext({
    baseURL: origin,
    extraHTTPHeaders: { Authorization: `Bearer ${token}`, Origin: origin },
  });
  try {
    const tasks = await agent.get(`/api/boards/${board.id}/tasks`);
    expect(tasks.status()).toBe(200);
    const created = await agent.post(`/api/boards/${board.id}/tasks`, {
      data: { columnId, title: "A scoped external agent created this task" },
    });
    expect(created.status()).toBe(201);
    const other = await json(adminApi, "/boards", {
      name: "Agent denied board",
      prefix: "DEN",
    });
    expect(
      (await agent.get(`/api/boards/${other.board.id}/tasks`)).status(),
    ).toBe(403);
    await page.reload();
    await expect(page.getByLabel("Credential", { exact: true })).toHaveCount(0);
    const row = page
      .getByRole("region", { name: "Credentials", exact: true })
      .getByRole("row")
      .filter({ hasText: "Settings board agent" });
    await row
      .getByRole("button", { name: "Revoke Settings board agent", exact: true })
      .click();
    const revoke = page.getByRole("dialog", { name: "Revoke credential?" });
    await revoke
      .getByRole("button", { name: "Revoke credential", exact: true })
      .click();
    await expect(revoke.getByRole("status")).toContainText(
      "Credential revoked",
    );
    await revoke.getByRole("button", { name: "Done", exact: true }).click();
    await expect(row).toContainText("Revoked");
    expect((await agent.get(`/api/boards/${board.id}/tasks`)).status()).toBe(
      401,
    );
  } finally {
    await agent.dispose();
  }
});

test("workspace export downloads actual data and the selected file imports with tasks and comments intact", async ({
  page,
}, testInfo) => {
  await login(page, admin);
  const task = await json(adminApi, `/boards/${board.id}/tasks`, {
    columnId,
    title: "Portable export browser proof",
    description: "Data crosses the actual file picker.",
  });
  await json(adminApi, `/tasks/${task.task.id}/comments`, {
    body: "This comment survives export and import.",
  });
  await page
    .getByRole("link", { name: "Export and import", exact: true })
    .click();
  const downloaded = page.waitForEvent("download");
  await page
    .getByRole("button", { name: "Download export", exact: true })
    .click();
  const download = await downloaded;
  expect(download.suggestedFilename()).toMatch(/^mill-export-.*\.json$/);
  const exportedPath = testInfo.outputPath("workspace-export.json");
  await download.saveAs(exportedPath);
  const exported = JSON.parse(await readFile(exportedPath, "utf8"));
  expect(exported.format).toBe("mill-portable");
  expect(
    exported.tasks.some(
      (t: { title: string }) => t.title === "Portable export browser proof",
    ),
  ).toBe(true);
  expect(
    exported.comments.some(
      (c: { body: string }) =>
        c.body === "This comment survives export and import.",
    ),
  ).toBe(true);
  const content = JSON.stringify(exported);
  expect(
    /passwordHash|password_hash|tokenHash|encryptedSecret|recoveryCodes/.test(
      content,
    ),
    "Portable export excludes credential fields",
  ).toBe(false);
  await page.getByLabel("Choose Mill export").setInputFiles(exportedPath);
  await page
    .getByRole("region", { name: "Import workspace data", exact: true })
    .getByRole("button", { name: "Import", exact: true })
    .click();
  const importResponse = page.waitForResponse(
    (response) =>
      response.url().endsWith("/api/import") &&
      response.request().method() === "POST",
  );
  await page
    .getByRole("dialog", { name: "Import workspace data?" })
    .getByRole("button", { name: "Import", exact: true })
    .click();
  const imported = await (await importResponse).json();
  const complete = page.getByRole("dialog", { name: "Import completed" });
  await expect(complete.getByRole("status")).toContainText("Import completed");
  await expect(complete.getByRole("status")).not.toContainText(
    "[object Object]",
  );
  await complete.getByRole("button", { name: "Done", exact: true }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  const boards = await json(page.request, "/boards");
  const restored = boards.items.find(
    (item: { id: string; name: string }) =>
      item.name === board.name && imported.imported.boardIds.includes(item.id),
  );
  expect(restored).toBeTruthy();
  expect(restored.id).not.toBe(board.id);
  await page.goto(`/boards/${restored.id}`);
  await page.getByLabel("Search tasks").fill("Portable export browser proof");
  await expect(page.locator(".task-card")).toHaveCount(1);
  await page.locator(".task-card").click();
  await expect(page.getByRole("dialog")).toContainText(
    "This comment survives export and import.",
  );
  expect((await page.request.get("/api/auth/me")).status()).toBe(200);
});

test("session management revokes another browser without signing out the current device", async ({
  page,
  browser,
}) => {
  const account = await createAccount(
    "settings-sessions@example.test",
    "Session Settings",
  );
  await login(page, account);
  const { context, page: other } = await contextPage(browser);
  try {
    await login(other, account);
    await accountAction(page, "Account security");
    const sessionSection = page.getByRole("region", {
      name: "Sessions",
      exact: true,
    });
    const sessions = await json(page.request, "/auth/sessions");
    const current = sessions.items.find((s: { current: boolean }) => s.current);
    expect(current).toBeTruthy();
    await sessionSection
      .getByRole("button", { name: "Sign out", exact: true })
      .first()
      .click();
    await expect(
      sessionSection.getByRole("status").filter({ hasText: "Session revoked" }),
    ).toContainText("Session revoked");
    await sessionSection
      .getByRole("button", { name: "Sign out", exact: true })
      .first()
      .click();
    await expect(
      sessionSection.getByRole("button", { name: "Sign out", exact: true }),
    ).toHaveCount(0);
    expect((await other.request.get("/api/auth/me")).status()).toBe(401);
    expect((await page.request.get("/api/auth/me")).status()).toBe(200);
    await other.reload();
    await expect(
      other.getByRole("heading", { name: "Sign in to Mill" }),
    ).toBeVisible();
  } finally {
    await context.close();
  }
});

async function browserDatabase() {
  if (!process.env.DATABASE_URL) process.loadEnvFile(".env");
  const metadata = JSON.parse(
    await readFile(`tmp/browser-${new URL(origin).port}-schema.json`, "utf8"),
  ) as { schema: string; baseURL: string };
  expect(metadata.schema).toMatch(/^browser_[a-f0-9]{16}$/);
  expect(new URL(metadata.baseURL).origin).toBe(origin);
  const database = postgres(process.env.DATABASE_URL!, { max: 1 });
  const workspace = await database.unsafe(
    `SELECT id FROM "${metadata.schema}".workspace`,
  );
  expect(workspace).toHaveLength(1);
  return { database, schema: metadata.schema };
}

test("passkey-only reauthentication and sign-in cancel safely, retry fresh ceremonies, and submit passwords with Enter", async ({
  page,
  context,
}) => {
  const account = await createAccount(
    "settings-retry@example.test",
    "Passkey Retry",
  );
  await login(page, account);
  const cdp = await context.newCDPSession(page);
  await cdp.send("WebAuthn.enable");
  const { authenticatorId } = await cdp.send(
    "WebAuthn.addVirtualAuthenticator",
    {
      options: {
        protocol: "ctap2",
        transport: "internal",
        hasResidentKey: true,
        hasUserVerification: true,
        isUserVerified: true,
        automaticPresenceSimulation: true,
      },
    },
  );
  await accountAction(page, "Account security");
  await page.getByRole("button", { name: "Add passkey", exact: true }).click();
  let dialog = page.getByRole("dialog", {
    name: "Confirm it’s you",
    exact: true,
  });
  await dialog.getByRole("button", { name: "Confirm", exact: true }).click();
  await expect(dialog.getByLabel("Password", { exact: true })).toBeFocused();
  await dialog.getByLabel("Password", { exact: true }).fill(password);
  await dialog.getByLabel("Password", { exact: true }).press("Enter");
  await expect(
    page.getByRole("region", { name: "Passkeys", exact: true }),
  ).toContainText("My passkey");
  expect(
    (await cdp.send("WebAuthn.getCredentials", { authenticatorId })).credentials
      .length,
  ).toBe(1);
  await cdp.send("WebAuthn.setAutomaticPresenceSimulation", {
    authenticatorId,
    enabled: false,
  });
  await page
    .getByRole("button", { name: "Set up authenticator", exact: true })
    .click();
  dialog = page.getByRole("dialog", { name: "Confirm it’s you", exact: true });
  await dialog.getByLabel("Password", { exact: true }).fill(password);
  const reauthResponse = page.waitForResponse(
    (r) =>
      r.url().endsWith("/api/auth/reauth") && r.request().method() === "POST",
  );
  const firstOptions = page.waitForResponse((r) =>
    r.url().endsWith("/api/auth/passkeys/authenticate/options"),
  );
  await dialog.getByLabel("Password", { exact: true }).press("Enter");
  const challenge = await (await reauthResponse).json();
  expect(challenge.methods).toEqual(["passkey"]);
  expect(challenge.preferredMethod).toBe("passkey");
  const initialCeremony = await (await firstOptions).json();
  await dialog.getByRole("button", { name: "Cancel passkey request" }).click();
  await expect(dialog.getByRole("alert")).toContainText("cancelled");
  await expect(
    dialog.getByRole("button", { name: /Verification method$/ }),
  ).toHaveCount(0);
  await expect(dialog.getByLabel("Recovery code", { exact: true })).toHaveCount(
    0,
  );
  await expect(
    dialog.getByRole("button", { name: "Confirm", exact: true }),
  ).toHaveCount(0);
  await cdp.send("WebAuthn.setAutomaticPresenceSimulation", {
    authenticatorId,
    enabled: true,
  });
  const nextOptions = page.waitForResponse((r) =>
    r.url().endsWith("/api/auth/passkeys/authenticate/options"),
  );
  await dialog
    .getByRole("button", { name: "Try passkey again", exact: true })
    .click();
  const retried = await (await nextOptions).json();
  expect(
    retried.challengeId === initialCeremony.challengeId,
    "Retry retains the same authentication request",
  ).toBe(true);
  expect(
    retried.options.challenge !== initialCeremony.options.challenge,
    "Retry issues a fresh passkey challenge",
  ).toBe(true);
  await expect(dialog).toHaveCount(0);
  await expect(
    page
      .getByRole("region", { name: "Authenticator", exact: true })
      .locator("code.secret"),
  ).toBeVisible();
  await page
    .getByRole("region", { name: "Authenticator", exact: true })
    .getByRole("button", { name: "Cancel", exact: true })
    .click();
  await signOut(page);
  await cdp.send("WebAuthn.setAutomaticPresenceSimulation", {
    authenticatorId,
    enabled: false,
  });
  await page.getByLabel("Email", { exact: true }).fill(account.email);
  await page.getByLabel("Password", { exact: true }).fill(password);
  const loginResponse = page.waitForResponse(
    (r) =>
      r.url().endsWith("/api/auth/login") && r.request().method() === "POST",
  );
  await page.getByLabel("Password", { exact: true }).press("Enter");
  expect((await (await loginResponse).json()).methods).toEqual(["passkey"]);
  await page.getByRole("button", { name: "Cancel passkey request" }).click();
  await expect(page.getByRole("alert")).toContainText("cancelled");
  await expect(page.getByLabel("Recovery code", { exact: true })).toHaveCount(
    0,
  );
  await expect(
    page.getByRole("button", { name: "Verify", exact: true }),
  ).toHaveCount(0);
  await cdp.send("WebAuthn.setAutomaticPresenceSimulation", {
    authenticatorId,
    enabled: true,
  });
  await page
    .getByRole("button", { name: "Try passkey again", exact: true })
    .click();
  await expect(
    page.getByRole("navigation", { name: "Workspace navigation" }),
  ).toBeVisible();
  expect((await json(page.request, "/auth/me")).user.passkeyCount).toBe(1);
  await cdp.detach();
});

test("invitation and recovery forms gate links, reveal passwords, require confirmation, and submit with Enter", async ({
  page,
  browser,
}, testInfo) => {
  const email = "settings-links@example.test";
  const invitation = await json(adminApi, "/auth/invitations", {
    email,
    role: "member",
  });
  await json(
    adminApi,
    `/auth/invitations/${invitation.invitation.id}`,
    {},
    "DELETE",
  );
  await page.goto(invitation.inviteUrl);
  await expect(page.getByRole("alert")).toContainText("invalid or expired");
  await expect(page.getByLabel("Your name", { exact: true })).toHaveCount(0);
  await expect(page.getByLabel("Password", { exact: true })).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Accept invitation", exact: true }),
  ).toHaveCount(0);
  await expect(page.getByLabel("Invitation code", { exact: true })).toHaveCount(
    0,
  );
  const valid = await json(adminApi, "/auth/invitations", {
    email,
    role: "member",
  });
  await page.goto(valid.inviteUrl);
  await expect(page.getByLabel("Your name", { exact: true })).toBeVisible();
  await expect(page.getByLabel("Invitation code", { exact: true })).toHaveCount(
    0,
  );
  await page.getByLabel("Your name", { exact: true }).fill("Identity Links");
  await page.getByLabel("Password", { exact: true }).fill(password);
  await page
    .getByLabel("Confirm password", { exact: true })
    .fill("A different password");
  await page.getByLabel("Confirm password", { exact: true }).press("Enter");
  await expect(page.getByRole("alert")).toContainText("passwords do not match");
  await page
    .getByRole("button", { name: "Show password", exact: true })
    .first()
    .click();
  await expect(page.getByLabel("Password", { exact: true })).toHaveAttribute(
    "type",
    "text",
  );
  await page
    .getByRole("button", { name: "Hide password", exact: true })
    .click();
  await expect(page.getByLabel("Password", { exact: true })).toHaveAttribute(
    "type",
    "password",
  );
  await page.getByLabel("Confirm password", { exact: true }).fill(password);
  await page.getByLabel("Confirm password", { exact: true }).press("Enter");
  await expect(
    page.getByRole("navigation", { name: "Workspace navigation" }),
  ).toBeVisible();
  await signOut(page);
  const { database, schema } = await browserDatabase();
  await database.end();
  const result = await promisify(execFile)(
    process.execPath,
    [
      "--env-file-if-exists=.env",
      "--import",
      "tsx",
      "apps/api/src/auth/recovery-cli.ts",
      "--email",
      email,
    ],
    { env: { ...process.env, MILL_DB_SCHEMA: schema, MILL_BASE_URL: origin } },
  );
  const recoveryURL = result.stdout.match(/https?:\/\/[^\s]+/)?.[0];
  expect(
    Boolean(recoveryURL),
    "Operator recovery provides a private link",
  ).toBe(true);
  await page.goto(recoveryURL!);
  await expect(page.getByLabel("Recovery code", { exact: true })).toHaveCount(
    0,
  );
  const nextPassword = "Recovered-browser-password-42";
  await page.getByLabel("Password", { exact: true }).fill(nextPassword);
  await page.getByLabel("Confirm password", { exact: true }).fill(nextPassword);
  await page.getByLabel("Confirm password", { exact: true }).press("Enter");
  await expect(page.getByRole("status")).toContainText(
    "password has been reset",
  );
  await expect(page).toHaveURL(`${origin}/`);
  await page.getByLabel("Email", { exact: true }).fill(email);
  await page.getByLabel("Password", { exact: true }).fill(nextPassword);
  await page.getByLabel("Password", { exact: true }).press("Enter");
  await expect(
    page.getByRole("navigation", { name: "Workspace navigation" }),
  ).toBeVisible();
  await accountAction(page, "Profile");
  await expect(page.getByLabel("Name", { exact: true })).toHaveValue(
    "Identity Links",
  );
  await page.screenshot({
    path: testInfo.outputPath("profile-desktop-light.png"),
    fullPage: true,
    animations: "disabled",
  });
  await page
    .getByRole("button", { name: /Appearance: switch to dark/ })
    .click();
  await page.screenshot({
    path: testInfo.outputPath("profile-desktop-dark.png"),
    fullPage: true,
    animations: "disabled",
  });
  const phone = await browser.newContext({
    baseURL: origin,
    viewport: { width: 390, height: 844 },
    hasTouch: true,
    isMobile: true,
    storageState: await page.context().storageState(),
  });
  try {
    const mobile = await phone.newPage();
    await mobile.goto("/settings/profile");
    await expect(mobile.getByLabel("Name", { exact: true })).toBeVisible();
    expect(
      await mobile.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    ).toBe(true);
    const labels = await mobile
      .locator('[data-slot="checkbox-content"]')
      .evaluateAll((elements) =>
        elements.map((element) => ({
          height: element.getBoundingClientRect().height,
          tick: element
            .querySelector('[data-slot="checkbox-control"]')
            ?.getBoundingClientRect().height,
        })),
      );
    expect(labels).toHaveLength(2);
    expect(
      labels.every((label) => label.height >= 44 && label.tick === 16),
    ).toBe(true);
    await mobile.screenshot({
      path: testInfo.outputPath("profile-phone-dark.png"),
      fullPage: true,
      animations: "disabled",
    });
    await mobile
      .getByRole("button", { name: /Appearance: switch to light/ })
      .click();
    await mobile.screenshot({
      path: testInfo.outputPath("profile-phone-light.png"),
      fullPage: true,
      animations: "disabled",
    });
  } finally {
    await phone.close();
  }
});

test("passkeys and sessions distinguish independent PostgreSQL pending and failure states and recover through their own retry action", async ({
  page,
}) => {
  const account = await createAccount(
    "settings-lists@example.test",
    "Independent Lists",
  );
  await login(page, account);
  await accountAction(page, "Profile");
  await expect(page.getByLabel("Email", { exact: true })).toHaveValue(
    account.email,
  );
  const { database, schema } = await browserDatabase();
  let renamedKeys = false;
  let renamedAgent = false;
  let releaseLock: (() => void) | undefined;
  let lockTransaction: Promise<unknown> | undefined;
  try {
    let acquired: (() => void) | undefined;
    const lockAcquired = new Promise<void>((resolve) => {
      acquired = resolve;
    });
    const lockReleased = new Promise<void>((resolve) => {
      releaseLock = resolve;
    });
    lockTransaction = database.begin(async (tx) => {
      await tx.unsafe(
        `LOCK TABLE "${schema}".passkeys IN ACCESS EXCLUSIVE MODE`,
      );
      acquired!();
      await lockReleased;
    });
    await lockAcquired;
    await accountAction(page, "Account security");
    const keys = page.getByRole("region", { name: "Passkeys", exact: true });
    const sessions = page.getByRole("region", {
      name: "Sessions",
      exact: true,
    });
    await expect(keys.getByRole("status")).toHaveText("Loading passkeys…");
    await expect(
      keys.getByText("No passkeys added.", { exact: true }),
    ).toHaveCount(0);
    await expect(
      sessions.getByText("This device", { exact: true }),
    ).toBeVisible();
    releaseLock!();
    await lockTransaction;
    lockTransaction = undefined;
    await expect(
      keys.getByText("No passkeys added.", { exact: true }),
    ).toBeVisible();
    await accountAction(page, "Profile");
    await database.unsafe(
      `ALTER TABLE "${schema}".passkeys RENAME TO passkeys_list_fault`,
    );
    renamedKeys = true;
    await accountAction(page, "Account security");
    await expect(keys.getByRole("alert")).toBeVisible();
    await expect(
      keys.getByText("No passkeys added.", { exact: true }),
    ).toHaveCount(0);
    await expect(
      sessions.getByText("This device", { exact: true }),
    ).toBeVisible();
    await database.unsafe(
      `ALTER TABLE "${schema}".passkeys_list_fault RENAME TO passkeys`,
    );
    renamedKeys = false;
    await keys
      .getByRole("button", { name: "Retry passkeys", exact: true })
      .click();
    await expect(
      keys.getByText("No passkeys added.", { exact: true }),
    ).toBeVisible();
    await accountAction(page, "Profile");
    await database.unsafe(
      `ALTER TABLE "${schema}".sessions RENAME COLUMN user_agent TO user_agent_list_fault`,
    );
    renamedAgent = true;
    await accountAction(page, "Account security");
    await expect(sessions.getByRole("alert")).toBeVisible();
    await expect(
      sessions.getByText("No active sessions.", { exact: true }),
    ).toHaveCount(0);
    await expect(
      keys.getByText("No passkeys added.", { exact: true }),
    ).toBeVisible();
    await database.unsafe(
      `ALTER TABLE "${schema}".sessions RENAME COLUMN user_agent_list_fault TO user_agent`,
    );
    renamedAgent = false;
    await sessions
      .getByRole("button", { name: "Retry sessions", exact: true })
      .click();
    await expect(
      sessions.getByText("This device", { exact: true }),
    ).toBeVisible();
  } finally {
    releaseLock?.();
    if (lockTransaction) await lockTransaction;
    if (renamedKeys)
      await database.unsafe(
        `ALTER TABLE "${schema}".passkeys_list_fault RENAME TO passkeys`,
      );
    if (renamedAgent)
      await database.unsafe(
        `ALTER TABLE "${schema}".sessions RENAME COLUMN user_agent_list_fault TO user_agent`,
      );
    await database.end();
  }
});

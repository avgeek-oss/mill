import { readFile } from "node:fs/promises";
import {
  expect,
  request as apiRequests,
  test,
  type APIRequestContext,
  type Browser,
  type Page,
} from "@playwright/test";
import { Secret, TOTP } from "otpauth";

const bootstrap = {
  workspaceName: "Mill browser verification",
  name: "Alex Morgan",
  email: "browser-admin@example.test",
  password: "Browser-only-password-42",
};
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
async function choose(page: Page, label: string, value: string) {
  await page.getByRole("button", { name: new RegExp(`${label}$`) }).click();
  await page.getByRole("option", { name: value, exact: true }).click();
}
async function signOut(page: Page) {
  await page
    .getByRole("button", { name: "Sign out", exact: true })
    .last()
    .click();
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
  origin = baseURL!;
  const root = await playwright.request.newContext({ baseURL: origin });
  const status = await json(root, "/auth/status");
  if (status.setupRequired) await json(root, "/auth/setup", bootstrap);
  else
    await json(root, "/auth/login", {
      email: bootstrap.email,
      password: bootstrap.password,
    });
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
  await page.getByRole("link", { name: admin.name }).click();
  await page.getByLabel("Name", { exact: true }).click();
  await expect(page.getByLabel("Name", { exact: true })).toBeFocused();
  await choose(page, "Time zone", "UTC");
  await page.getByLabel("Task assignments", { exact: true }).uncheck();
  await page.getByLabel("Mentions in comments", { exact: true }).check();
  await page.getByRole("button", { name: "Save preferences" }).click();
  await expect(page.getByRole("status")).toContainText("Preferences saved");
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
  await page
    .getByRole("link", { name: "Account security", exact: true })
    .click();
  await page
    .getByLabel("Current password", { exact: true })
    .fill("An incorrect password");
  await page
    .getByLabel("New password", { exact: true })
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
  await page
    .getByRole("link", { name: "Account security", exact: true })
    .click();
  await page.getByRole("button", { name: "Add passkey", exact: true }).click();
  await confirmPassword(page);
  await expect(page.getByRole("status")).toContainText("Passkey added");
  await expect(page.getByText("My passkey", { exact: false })).toBeVisible();
  const credentials = await cdp.send("WebAuthn.getCredentials", {
    authenticatorId,
  });
  expect(credentials.credentials).toHaveLength(1);
  await page
    .getByRole("button", { name: "Set up authenticator", exact: true })
    .click();
  await confirmPassword(page);
  const authenticator = page.locator(".settings-section").filter({
    has: page.getByRole("heading", { name: "Authenticator", exact: true }),
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
  expect(
    (await page.locator(".recovery-codes").innerText()).trim().split("\n"),
  ).toHaveLength(10);
  await page.getByRole("button", { name: "I saved these codes" }).click();
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
    await page.getByLabel("Email", { exact: true }).fill(email);
    await choose(page, "Role", role);
    await page
      .getByRole("button", { name: "Create invitation", exact: true })
      .click();
    await expect(page.getByRole("status")).toContainText("Invitation created");
    return page.getByLabel("Invitation link", { exact: true }).inputValue();
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
    .locator(".settings-section")
    .filter({
      has: page.getByRole("heading", { name: "Invitations", exact: true }),
    })
    .locator(".row.space-between")
    .filter({ hasText: "settings-pending@example.test" });
  await pending.getByRole("button", { name: "Revoke", exact: true }).click();
  await expect(pending).toContainText("Revoked");
  await page.reload();
  await expect(
    page.locator(".member-row").filter({ hasText: "Viewer Settings" }),
  ).toContainText("Viewer");
  await expect(
    page.locator(".member-row").filter({ hasText: "Member Settings" }),
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
  await page.getByRole("link", { name: /^Inbox(?: \d+)?$/ }).click();
  await expect(page.locator("article.notification.unread")).toHaveCount(2);
  await expect(page.locator("article.notification")).toContainText([
    /mentioned you/i,
    /assigned.*you/i,
  ]);
  await page.getByRole("button", { name: "Unread", exact: true }).click();
  await page
    .locator("article.notification")
    .filter({ hasText: /mentioned you/i })
    .getByRole("button", { name: "Open task", exact: true })
    .click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await expect(page.getByLabel("Title", { exact: true })).toHaveValue(
    "Review notification delivery",
  );
  await page.getByRole("button", { name: "Close", exact: true }).click();
  await page.getByRole("link", { name: /^Inbox(?: \d+)?$/ }).click();
  await expect(page.locator("article.notification.unread")).toHaveCount(1);
  await page.getByRole("button", { name: "Mark all read" }).click();
  await page.getByRole("button", { name: "Unread", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "You’re all caught up" }),
  ).toBeVisible();
  await page.getByRole("link", { name: recipient.name }).click();
  await page.getByLabel("Task assignments", { exact: true }).uncheck();
  await page.getByRole("button", { name: "Save preferences" }).click();
  await expect(page.getByRole("status")).toContainText("Preferences saved");
  await json(adminApi, `/boards/${board.id}/tasks`, {
    columnId,
    title: "Assignment preference excludes this alert",
    assigneeId: recipient.id,
  });
  await page.getByRole("link", { name: /^Inbox(?: \d+)?$/ }).click();
  await page.getByRole("button", { name: "Unread", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "You’re all caught up" }),
  ).toBeVisible();
  const notifications = await json(page.request, "/notifications");
  expect(notifications.items).toHaveLength(2);
  expect(notifications.unreadCount).toBe(0);
  await page.getByRole("button", { name: "All", exact: true }).click();
  await page.screenshot({
    path: "docs/screenshots/inbox.png",
    fullPage: true,
    animations: "disabled",
  });
});

test("a scoped credential created through the interface works on its board and loses access when revoked", async ({
  page,
  playwright,
}) => {
  await login(page, admin);
  await page.getByRole("link", { name: "Agent access", exact: true }).click();
  await page.getByLabel("Name", { exact: true }).fill("Settings board agent");
  await choose(page, "Permissions", "Read and write tasks");
  await choose(page, "Board access", board.name);
  await page.getByLabel("Expires in days", { exact: true }).fill("7");
  await page
    .getByRole("button", { name: "Create credential", exact: true })
    .click();
  await expect(page.getByRole("status")).toContainText("Credential created");
  const token = await page
    .getByLabel("Token · shown once", { exact: true })
    .inputValue();
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
    await expect(
      page.getByLabel("Token · shown once", { exact: true }),
    ).toHaveCount(0);
    const row = page
      .locator(".settings-section")
      .filter({
        has: page.getByRole("heading", { name: "Credentials", exact: true }),
      })
      .locator(".row.space-between")
      .filter({ hasText: "Settings board agent" });
    await row.getByRole("button", { name: "Revoke", exact: true }).click();
    await page
      .getByRole("dialog", { name: "Revoke credential?" })
      .getByRole("button", { name: "Confirm", exact: true })
      .click();
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
  expect(content).not.toMatch(
    /passwordHash|password_hash|tokenHash|encryptedSecret|recoveryCodes/,
  );
  await page.getByLabel("Choose Mill export").setInputFiles(exportedPath);
  const importResponse = page.waitForResponse(
    (response) =>
      response.url().endsWith("/api/import") &&
      response.request().method() === "POST",
  );
  await page
    .getByRole("dialog", { name: "Import workspace data?" })
    .getByRole("button", { name: "Confirm", exact: true })
    .click();
  const imported = await (await importResponse).json();
  await expect(page.getByRole("status")).toContainText("Import completed");
  await expect(page.getByRole("status")).not.toContainText("[object Object]");
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
    await page
      .getByRole("link", { name: "Account security", exact: true })
      .click();
    const sessionSection = page.locator(".settings-section").filter({
      has: page.getByRole("heading", { name: "Sessions", exact: true }),
    });
    const sessions = await json(page.request, "/auth/sessions");
    const current = sessions.items.find((s: { current: boolean }) => s.current);
    expect(current).toBeTruthy();
    await sessionSection
      .getByRole("button", { name: "Sign out", exact: true })
      .first()
      .click();
    await expect(page.getByRole("status")).toContainText("Session revoked");
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

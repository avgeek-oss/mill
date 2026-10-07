import { createHash } from "node:crypto";
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

function feedbackToast(page: Page, message: string) {
  return page
    .locator(
      '[data-slot="toast"]:not([data-exiting="true"]):not([data-hidden="true"])',
    )
    .filter({ hasText: message })
    .last();
}

// Secret reveal steps must not enter automatic failure artifacts.
process.env.PLAYWRIGHT_NO_COPY_PROMPT = "1";
test.use({ trace: "off", screenshot: "off" });

const password = "Settings-only-password-42";
type Account = { email: string; name: string; password: string; id: string };
let origin = "";
let admin: Account;
let adminApi: APIRequestContext;
let board: { id: string; name: string };

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
  action:
    "Profile" | "Preferences" | "Auth & Security" | "My API Keys" | "Sign out",
) {
  const trigger = page.getByRole("button", { name: /^Account menu for / });
  if (!(await trigger.isVisible()))
    await page
      .getByRole("button", { name: "Toggle navigation", exact: true })
      .click();
  await trigger.click();
  await page
    .getByRole("menu")
    .getByRole("menuitem", { name: action, exact: true })
    .click();
  await expect(page.locator('[data-slot="dropdown-popover"]')).toHaveCount(0);
}
async function signOut(page: Page) {
  await accountAction(page, "Sign out");
  await expect(
    page.getByRole("heading", { name: "Sign in", exact: true }),
  ).toBeVisible();
}
async function confirmPassword(page: Page, value = password) {
  const dialog = page.getByRole("dialog", { name: /Confirm it/ });
  await expect(dialog).toBeVisible();
  await dialog.getByLabel("Password", { exact: true }).fill(value);
  await dialog.getByRole("button", { name: "Confirm", exact: true }).click();
  await expect(dialog).toHaveCount(0);
}
async function beginPasskeyEnrollment(page: Page, name: string) {
  await page.getByRole("button", { name: "Add passkey", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Add passkey", exact: true });
  await dialog.getByLabel("Name", { exact: true }).fill(name);
  await dialog.getByRole("button", { name: "Continue", exact: true }).click();
  await expect(
    page.getByRole("dialog", { name: "Confirm it’s you", exact: true }),
  ).toBeVisible();
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
});
test.afterAll(async () => {
  await adminApi?.dispose();
});

test("profile preferences persist, UTC remains selectable, and a wrong current password leaves the session intact", async ({
  page,
}, testInfo) => {
  const avatarRequests = new Set<string>();
  await page.route("https://www.gravatar.com/avatar/**", async (route) => {
    avatarRequests.add(route.request().url());
    await route.fulfill({ status: 404, body: "" });
  });
  await login(page, admin);
  await accountAction(page, "Profile");
  const avatar = page
    .getByRole("region", { name: "Profile image", exact: true })
    .getByRole("link", {
      name: "Edit Gravatar image (opens in a new tab)",
      exact: true,
    })
    .locator('[role="img"]');
  await expect(avatar).toBeVisible();
  await expect(avatar.getByText("CS", { exact: true })).toBeVisible();
  const gravatar = `https://www.gravatar.com/avatar/${createHash("sha256").update(admin.email.trim().toLowerCase()).digest("hex")}?s=160&d=404&r=g`;
  await expect.poll(() => avatarRequests.has(gravatar)).toBe(true);
  await page.getByLabel("Your Name", { exact: true }).click();
  await expect(page.getByLabel("Your Name", { exact: true })).toBeFocused();
  await page
    .getByLabel("Your Name", { exact: true })
    .fill("Casey Profile Updated");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(feedbackToast(page, "Changes saved")).toBeVisible();
  await page.reload();
  await expect(page.getByLabel("Your Name", { exact: true })).toHaveValue(
    "Casey Profile Updated",
  );
  await page.getByLabel("Your Name", { exact: true }).fill(admin.name);
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect
    .poll(async () => (await json(page.request, "/auth/me")).user.name)
    .toBe(admin.name);
  await page
    .getByLabel("Your Name", { exact: true })
    .fill("Unsaved profile draft");
  await accountAction(page, "Preferences");
  await page.getByRole("button", { name: /Time zone/ }).click();
  await page
    .getByRole("searchbox", { name: "Search time zones" })
    .fill("Colombo");
  const colombo = page.getByRole("option", {
    name: "Asia/Colombo +05:30",
    exact: true,
  });
  await expect(colombo).toContainText("+05:30");
  await colombo.click();
  await expect(page.getByRole("button", { name: /Time zone/ })).toContainText(
    "+05:30",
  );
  await page.getByRole("button", { name: /Time zone/ }).click();
  await page.getByRole("searchbox", { name: "Search time zones" }).fill("UTC");
  await expect(
    page.getByRole("option", { name: "UTC +00:00", exact: true }),
  ).toContainText("+00:00");
  await page.getByRole("option", { name: "UTC +00:00", exact: true }).click();
  await page.getByRole("button", { name: /Time format/ }).click();
  await page.getByRole("option", { name: "2:30 PM", exact: true }).click();
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(feedbackToast(page, "Preferences updated")).toBeVisible();
  await expect(page.getByRole("checkbox", { name: /email/i })).toHaveCount(0);
  await expect(
    page.getByText("Email delivery is unavailable for this installation.", {
      exact: true,
    }),
  ).toHaveCount(0);
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
  await page
    .getByRole("button", { name: "Save notifications", exact: true })
    .click();
  await expect(feedbackToast(page, "Notifications saved.")).toBeVisible();
  expect((await json(page.request, "/auth/me")).user.name).toBe(admin.name);
  await expect(page.getByLabel("Your Name", { exact: true })).toHaveCount(0);
  await page.reload();
  await expect(page.getByRole("button", { name: /Time zone/ })).toContainText(
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
  expect(profile.user.timeFormat).toBe("12-hour");
  expect(profile.user.dateFormat).toBe("day-short-month-year");
  const notifications = page.getByRole("region", {
    name: "Notifications",
    exact: true,
  });
  const checkbox = notifications.getByRole("checkbox", {
    name: "Task assignments",
    exact: true,
  });
  const originalTheme = await page.locator("html").getAttribute("data-theme");
  for (const width of [1280, 390]) {
    await page.setViewportSize({ width, height: 844 });
    for (const theme of ["light", "dark"]) {
      if ((await page.locator("html").getAttribute("data-theme")) !== theme) {
        await page
          .getByRole("button", {
            name: new RegExp(`Appearance: switch to ${theme}`),
          })
          .click();
      }
      await expect(checkbox).not.toBeChecked();
      const control = notifications
        .locator('[data-slot="checkbox-control"]')
        .first();
      await expect
        .poll(() =>
          control.evaluate((element) => {
            const background = getComputedStyle(element).backgroundColor;
            const surface = getComputedStyle(
              element.closest(".widget__content")!,
            ).backgroundColor;
            return background !== surface && background !== "rgba(0, 0, 0, 0)";
          }),
        )
        .toBe(true);
      await checkbox.focus();
      await checkbox.press("Space");
      await expect(checkbox).toBeChecked();
      await checkbox.press("Space");
      await expect(checkbox).not.toBeChecked();
      await notifications
        .getByRole("heading", { name: "Notifications", exact: true })
        .click();
      await notifications.screenshot({
        path: testInfo.outputPath(
          `notification-checkbox-${width}-${theme}.png`,
        ),
        animations: "disabled",
      });
    }
  }
  await page.setViewportSize({ width: 1280, height: 720 });
  if (
    (await page.locator("html").getAttribute("data-theme")) !== originalTheme
  ) {
    await page
      .getByRole("button", {
        name: new RegExp(`Appearance: switch to ${originalTheme}`),
      })
      .click();
  }
  await accountAction(page, "Auth & Security");
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
  await expect(
    feedbackToast(page, "current password is incorrect"),
  ).toBeVisible();
  expect((await page.request.get("/api/auth/me")).status()).toBe(200);
  await page.goto("/settings/sessions");
  await expect(page.getByText("This browser", { exact: true })).toBeVisible();
  await page.screenshot({
    path: testInfo.outputPath("sessions-after-password-failure.png"),
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
  await page.goto("/settings/two-factor");
  await beginPasskeyEnrollment(page, "My passkey");
  await confirmPassword(page);
  await expect(feedbackToast(page, "Passkey added")).toBeVisible();
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
    await authenticator
      .locator('[data-slot="code-block-code"] code')
      .innerText()
  ).trim();
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
  await authenticator
    .getByRole("button", { name: "Copy setup key", exact: true })
    .click();
  const copiedKey = await page.evaluate(() => navigator.clipboard.readText());
  expect(
    copiedKey === secret,
    "The copied setup key matches the authenticator key",
  ).toBe(true);
  await page.context().clearPermissions();
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
    await page
      .getByRole("list", { name: "Recovery codes", exact: true })
      .innerText()
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
  await expect(
    feedbackToast(page, "Could not copy recovery codes"),
  ).toBeVisible();
  await feedbackToast(page, "Could not copy recovery codes")
    .locator('[data-slot="toast-close"]')
    .click();
  await expect(
    feedbackToast(page, "Could not copy recovery codes"),
  ).toHaveCount(0);
  await recoveryDialog.getByRole("button", { name: "Copy codes" }).click();
  await expect(
    feedbackToast(page, "Could not copy recovery codes"),
  ).toBeVisible();
  await context.grantPermissions(["clipboard-read", "clipboard-write"], {
    origin,
  });
  await recoveryDialog.getByRole("button", { name: "Copy codes" }).click();
  await expect(feedbackToast(page, "Recovery codes copied")).toBeVisible();
  const copiedCodes = await page.evaluate(() => navigator.clipboard.readText());
  expect(copiedCodes.trimEnd().split("\n").length).toBe(10);
  expect(
    copiedCodes === recoveryText + "\n",
    "Clipboard exactly matches the generated recovery codes",
  ).toBe(true);
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  await expect(recoveryDialog).toHaveCount(0);
  await expect(
    page.getByText("Authenticator enabled", { exact: true }),
  ).toBeVisible();
  await signOut(page);
  await page
    .getByRole("button", { name: "Sign in with Passkey", exact: true })
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
  await expect(
    feedbackToast(page, "passkey could not be verified"),
  ).toBeVisible();
  const authenticatorFallback = page.getByRole("button", {
    name: "Use an authenticator code",
    exact: true,
  });
  await expect(authenticatorFallback).toBeEnabled();
  await authenticatorFallback.click();
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
  await page.goto("/settings/two-factor");
  const passkeys = page.getByRole("grid", { name: "Passkeys", exact: true });
  await passkeys.getByRole("button", { name: "Remove", exact: true }).click();
  const removal = page.getByRole("dialog", {
    name: "Remove passkey?",
    exact: true,
  });
  await expect(removal).toBeVisible();
  await expect(
    page.getByRole("dialog", { name: "Confirm it’s you", exact: true }),
  ).toHaveCount(0);
  await removal.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(removal).toHaveCount(0);
  expect((await json(page.request, "/auth/me")).user.passkeyCount).toBe(1);
  await passkeys.getByRole("button", { name: "Remove", exact: true }).click();
  await removal.getByRole("button", { name: "Confirm", exact: true }).click();
  await confirmPassword(page);
  await expect(removal).toHaveCount(0);
  await expect(
    page.getByText("No passkeys added", { exact: true }),
  ).toBeVisible();
  expect((await json(page.request, "/auth/me")).user.passkeyCount).toBe(0);
  expect((await json(page.request, "/auth/me")).user.totpEnabled).toBe(true);
  await cdp.detach();
});

test("UI invitations admit viewer and member roles, show read-only controls and revoke pending access", async ({
  page,
  browser,
}) => {
  await login(page, admin);
  const workspaceName = (await json(adminApi, "/auth/me")).workspace.name;
  await page.getByRole("link", { name: "Team settings", exact: true }).click();
  await page
    .getByRole("navigation", { name: "Page navigation", exact: true })
    .getByRole("button", { name: "Members", exact: true })
    .click();
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
      name: "Invitation link",
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
        person.getByRole("heading", {
          name: `Join ${workspaceName}`,
          exact: true,
        }),
      ).toBeVisible();
      await person
        .getByLabel("Your Name", { exact: true })
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
      const personalNavigation = person.getByRole("navigation", {
        name: "Workspace navigation",
        exact: true,
      });
      await expect(
        personalNavigation.getByRole("link", {
          name: "Account settings",
          exact: true,
        }),
      ).toBeVisible();
      await expect(
        personalNavigation.getByRole("link", {
          name: "Team settings",
          exact: true,
        }),
      ).toHaveCount(0);
      await expect(
        personalNavigation.getByRole("link", { name: "People", exact: true }),
      ).toHaveCount(0);
      await person.goto("/settings/profile");
      await expect(
        person.getByRole("heading", { name: "Profile", exact: true, level: 1 }),
      ).toBeVisible();
      await expect(
        personalNavigation.getByRole("link", {
          name: "Account settings",
          exact: true,
        }),
      ).toHaveAttribute("aria-current", "page");
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
          person.getByRole("heading", {
            name: "Member created a real task",
            exact: true,
          }),
        ).toBeVisible();
        await expect(person).toHaveURL(
          new RegExp(`/boards/${board.id}/tasks/`),
        );
        const created = await json(person.request, `/boards/${board.id}/tasks`);
        expect(
          created.items.some(
            (task: { title: string; identifier: string }) =>
              task.title === "Member created a real task" &&
              /^SET-/.test(task.identifier),
          ),
        ).toBe(true);
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
  await expect(revoke).toHaveCount(0);
  await expect(feedbackToast(page, "Invitation revoked.")).toBeVisible();
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
    status: "todo",
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
    .getByRole("button", { name: /^Notifications(?:, \d+ unread)?$/ })
    .click();
  const notificationsList = page
    .getByRole("dialog", { name: "Notifications", exact: true })
    .getByRole("list");
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
    .getByRole("dialog", { name: "Notifications", exact: true })
    .getByRole("list")
    .getByRole("listitem")
    .filter({ hasText: /mentioned you/i })
    .getByRole("link")
    .click();
  await expect(
    page.getByRole("heading", { name: "Review notification delivery" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Back to board" }).click();
  await page
    .getByRole("button", { name: /^Notifications(?:, \d+ unread)?$/ })
    .click();
  await expect(unreadItems).toHaveCount(1);
  await page.getByRole("button", { name: "Mark all read" }).click();
  await expect(unreadItems).toHaveCount(0);
  await expect(notificationItems).toHaveCount(2);
  await expect(
    page.getByRole("button", { name: "Mark all read", exact: true }),
  ).toBeDisabled();
  await page.keyboard.press("Escape");
  await accountAction(page, "Preferences");
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
  await expect(feedbackToast(page, "Notifications saved.")).toBeVisible();
  await json(adminApi, `/boards/${board.id}/tasks`, {
    status: "todo",
    title: "Assignment preference excludes this alert",
    assigneeId: recipient.id,
  });
  await page
    .getByRole("button", { name: /^Notifications(?:, \d+ unread)?$/ })
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

test("a personal API key uses current human permissions and loses access when revoked", async ({
  page,
  playwright,
}) => {
  await login(page, admin);
  await accountAction(page, "My API Keys");
  await page
    .getByRole("button", { name: "Create API key", exact: true })
    .click();
  const create = page.getByRole("dialog", {
    name: "Create API key",
    exact: true,
  });
  await create
    .getByLabel("Name", { exact: true })
    .fill("Settings personal API key");
  await expect(create.getByRole("textbox")).toHaveCount(1);
  await expect(
    create.getByRole("button", { name: /(?:Agent|Access|Board access)$/ }),
  ).toHaveCount(0);
  await create.getByRole("button", { name: /Expires after\*$/ }).click();
  await expect(page.getByRole("option")).toHaveText([
    "30 days",
    "60 days",
    "90 days",
    "365 days",
  ]);
  await page.getByRole("option", { name: "90 days", exact: true }).click();
  await create.getByRole("button", { name: "Create key", exact: true }).click();
  const success = page.getByRole("dialog", {
    name: "Copy your API key",
    exact: true,
  });
  await expect(success).toBeVisible();
  const token = await success
    .locator('[data-slot="code-block-code"] code')
    .innerText();
  await success.getByRole("button", { name: "Done", exact: true }).click();
  const key = await playwright.request.newContext({
    baseURL: origin,
    extraHTTPHeaders: { Authorization: `Bearer ${token}`, Origin: origin },
  });
  try {
    const tasks = await key.get(`/api/boards/${board.id}/tasks`);
    expect(tasks.status()).toBe(200);
    const created = await key.post(`/api/boards/${board.id}/tasks`, {
      data: {
        status: "todo",
        title: "A personal API key created this task",
      },
    });
    expect(created.status()).toBe(201);
    const other = await json(adminApi, "/boards", {
      name: "Another permitted board",
      prefix: "KEY",
    });
    expect(
      (await key.get(`/api/boards/${other.board.id}/tasks`)).status(),
    ).toBe(200);
    expect((await key.get("/api/auth/me")).status()).toBe(403);
    expect((await key.get("/api/credentials")).status()).toBe(403);
    await page.reload();
    await expect(
      page.locator('[data-slot="code-block-code"] code'),
    ).toHaveCount(0);
    const row = page
      .getByRole("region", { name: "API keys", exact: true })
      .getByRole("row")
      .filter({ hasText: "Settings personal API key" });
    await row.getByRole("button", { name: "Revoke", exact: true }).click();
    const revoke = page.getByRole("dialog", {
      name: "Revoke Settings personal API key?",
    });
    await revoke
      .getByRole("button", { name: "Revoke key", exact: true })
      .click();
    await expect(revoke).toHaveCount(0);
    await expect(feedbackToast(page, "Access revoked.")).toBeVisible();
    await expect(row).toHaveCount(0);
    expect((await key.get(`/api/boards/${board.id}/tasks`)).status()).toBe(401);
  } finally {
    await key.dispose();
  }
});

test("team settings persist without backup or portable data surfaces", async ({
  page,
}) => {
  await login(page, admin);
  await expect(
    page.getByRole("link", { name: "Export and import", exact: true }),
  ).toHaveCount(0);
  await page.getByRole("link", { name: "Team settings", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "General", exact: true, level: 1 }),
  ).toBeVisible();
  const name = page.getByRole("textbox", { name: /^Team name/ });
  await name.fill("Settings workspace verification");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(feedbackToast(page, "Changes saved")).toBeVisible();
  expect((await json(page.request, "/auth/me")).workspace.name).toBe(
    "Settings workspace verification",
  );
  await page.reload();
  await expect(name).toHaveValue("Settings workspace verification");
  await expect(page.getByText("Backups", { exact: true })).toHaveCount(0);
  await expect(
    page.getByRole("link", { name: "backup and recovery guide", exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("main").locator('[data-slot="widget-header"]'),
  ).toHaveText("Team details");
  await page.goto("/settings/data");
  await expect(
    page.getByRole("heading", {
      name: "This page could not be found",
      exact: true,
      level: 1,
    }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Download export", exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByLabel("Choose Mill export", { exact: true }),
  ).toHaveCount(0);
  expect((await page.request.get("/api/export")).status()).toBe(404);
  expect(
    (
      await page.request.post("/api/import", {
        headers: { Origin: origin },
        data: {},
      })
    ).status(),
  ).toBe(404);
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
    await page.goto("/settings/sessions");
    const sessionSection = page.getByRole("region", {
      name: "Sessions",
      exact: true,
    });
    const sessions = await json(page.request, "/auth/sessions");
    const current = sessions.items.find((s: { current: boolean }) => s.current);
    expect(current).toBeTruthy();
    await sessionSection
      .getByRole("button", { name: "Revoke", exact: true })
      .and(page.locator(":enabled"))
      .first()
      .click();
    await page
      .getByRole("dialog", { name: "Revoke session?" })
      .getByRole("button", { name: "Revoke session", exact: true })
      .click();
    await expect(feedbackToast(page, "Session revoked")).toBeVisible();
    await sessionSection
      .getByRole("button", { name: "Revoke", exact: true })
      .and(page.locator(":enabled"))
      .first()
      .click();
    await page
      .getByRole("dialog", { name: "Revoke session?" })
      .getByRole("button", { name: "Revoke session", exact: true })
      .click();
    await expect(
      sessionSection.getByRole("button", { name: "Revoke", exact: true }),
    ).toHaveCount(1);
    await expect(
      sessionSection.getByRole("button", { name: "Revoke", exact: true }),
    ).toBeDisabled();
    expect((await other.request.get("/api/auth/me")).status()).toBe(401);
    expect((await page.request.get("/api/auth/me")).status()).toBe(200);
    await other.reload();
    await expect(
      other.getByRole("heading", { name: "Sign in", exact: true }),
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
  await page.goto("/settings/two-factor");
  await beginPasskeyEnrollment(page, "My passkey");
  let dialog = page.getByRole("dialog", {
    name: "Confirm it’s you",
    exact: true,
  });
  await dialog.getByRole("button", { name: "Confirm", exact: true }).click();
  await expect(dialog.getByLabel("Password", { exact: true })).toBeFocused();
  await dialog.getByLabel("Password", { exact: true }).fill(password);
  await dialog.getByLabel("Password", { exact: true }).press("Enter");
  await expect(
    page.getByRole("grid", { name: "Passkeys", exact: true }),
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
  await expect(feedbackToast(page, "cancelled")).toBeVisible();
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
      .locator('[data-slot="code-block-code"] code'),
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
  await expect(feedbackToast(page, "cancelled")).toContainText("cancelled");
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
  await expect(feedbackToast(page, "invalid or expired")).toBeVisible();
  await expect(page.getByLabel("Your Name", { exact: true })).toHaveCount(0);
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
  await expect(page.getByLabel("Your Name", { exact: true })).toBeVisible();
  await expect(page.getByLabel("Invitation code", { exact: true })).toHaveCount(
    0,
  );
  await page.getByLabel("Your Name", { exact: true }).fill("Identity Links");
  await page.getByLabel("Password", { exact: true }).fill(password);
  await page
    .getByLabel("Confirm password", { exact: true })
    .fill("A different password");
  await page.getByLabel("Confirm password", { exact: true }).press("Enter");
  await expect(feedbackToast(page, "passwords do not match")).toBeVisible();
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
  await expect(page).toHaveURL(`${origin}/`);
  await expect(
    page.getByRole("heading", { name: "Sign in", exact: true }),
  ).toBeVisible();
  await expect(
    feedbackToast(page, "Password reset. Sign in to continue."),
  ).toContainText("Password reset. Sign in to continue.");
  await page.getByLabel("Email", { exact: true }).fill(email);
  await page.getByLabel("Password", { exact: true }).fill(password);
  await page.getByLabel("Password", { exact: true }).press("Enter");
  await expect(
    feedbackToast(page, "email address or password is incorrect"),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Sign in", exact: true }),
  ).toBeVisible();
  await page.getByLabel("Password", { exact: true }).fill(nextPassword);
  await page.getByLabel("Password", { exact: true }).press("Enter");
  await expect(
    page.getByRole("navigation", { name: "Workspace navigation" }),
  ).toBeVisible();
  await accountAction(page, "Profile");
  await expect(page.getByLabel("Your Name", { exact: true })).toHaveValue(
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
    const touchMedia = await mobile.evaluate(() => ({
      coarse: matchMedia("(pointer: coarse)").matches,
      noHover: matchMedia("(hover: none)").matches,
      touchPoints: navigator.maxTouchPoints,
    }));
    expect(touchMedia.coarse).toBe(true);
    expect(touchMedia.noHover).toBe(true);
    expect(touchMedia.touchPoints).toBeGreaterThan(0);
    await expect(mobile.getByLabel("Your Name", { exact: true })).toBeVisible();
    expect(
      await mobile.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    ).toBe(true);
    await mobile.goto("/settings/preferences");
    await expect(
      mobile.getByRole("heading", {
        name: "Preferences",
        exact: true,
        level: 1,
      }),
    ).toBeVisible();
    const labels = await mobile
      .locator('[data-slot="checkbox-content"]')
      .evaluateAll((elements) =>
        elements.map((element) => ({
          name: element.textContent?.trim(),
          height: element.getBoundingClientRect().height,
          tick: element
            .querySelector('[data-slot="checkbox-control"]')
            ?.getBoundingClientRect().height,
        })),
      );
    expect(labels).toHaveLength(2);
    for (const label of labels) {
      expect(
        label.height,
        `${label.name} has a touch target at least 44px high`,
      ).toBeGreaterThanOrEqual(44);
      expect(label.tick, `${label.name} keeps the native 16px control`).toBe(
        16,
      );
    }
    await mobile.screenshot({
      path: testInfo.outputPath("preferences-phone-dark.png"),
      fullPage: true,
      animations: "disabled",
    });
    await mobile
      .getByRole("button", { name: /Appearance: switch to light/ })
      .click();
    await mobile.screenshot({
      path: testInfo.outputPath("preferences-phone-light.png"),
      fullPage: true,
      animations: "disabled",
    });
    await mobile.screenshot({
      path: testInfo.outputPath("preferences-phone.png"),
      fullPage: true,
      animations: "disabled",
    });
  } finally {
    await phone.close();
  }
});

test("focused passkey and session pages distinguish PostgreSQL pending and failure states and recover through their own retry action", async ({
  page,
}) => {
  const account = await createAccount(
    "settings-lists@example.test",
    "Independent Lists",
  );
  await login(page, account);
  await accountAction(page, "Auth & Security");
  await expect(page.getByLabel("Current email", { exact: true })).toHaveValue(
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
    await page
      .getByRole("navigation", {
        name: "Page navigation",
        exact: true,
      })
      .getByRole("button", { name: "Two-factor Auth", exact: true })
      .click();
    const keys = page.getByRole("grid", { name: "Passkeys", exact: true });
    const sessions = page.getByRole("region", {
      name: "Sessions",
      exact: true,
    });
    const loading = page
      .getByRole("status")
      .filter({ hasText: "Loading passkeys" });
    await expect(loading).toBeAttached();
    await expect(loading).toHaveClass(/sr-only/);
    await expect(loading).toHaveCSS("width", "1px");
    await expect(loading).toHaveCSS("height", "1px");
    await expect(keys).toHaveCount(0);
    await expect(
      page.getByText("No passkeys added", { exact: true }),
    ).toHaveCount(0);
    await expect(sessions).toHaveCount(0);
    await expect(
      page.getByRole("region", { name: "Authenticator", exact: true }),
    ).toBeVisible();
    releaseLock!();
    await lockTransaction;
    lockTransaction = undefined;
    await expect(
      page.getByText("No passkeys added", { exact: true }),
    ).toBeVisible();
    await accountAction(page, "Profile");
    await database.unsafe(
      `ALTER TABLE "${schema}".passkeys RENAME TO passkeys_list_fault`,
    );
    renamedKeys = true;
    await page
      .getByRole("navigation", {
        name: "Page navigation",
        exact: true,
      })
      .getByRole("button", { name: "Two-factor Auth", exact: true })
      .click();
    await expect(
      feedbackToast(page, "Mill could not complete this request"),
    ).toBeVisible();
    await expect(page.getByRole("main").getByRole("alert")).toHaveCount(0);
    await expect(keys).toHaveCount(0);
    await expect(
      page.getByText("No passkeys added", { exact: true }),
    ).toHaveCount(0);
    await expect(sessions).toHaveCount(0);
    await expect(
      page.getByRole("region", { name: "Authenticator", exact: true }),
    ).toBeVisible();
    await database.unsafe(
      `ALTER TABLE "${schema}".passkeys_list_fault RENAME TO passkeys`,
    );
    renamedKeys = false;
    await page.getByRole("button", { name: "Retry", exact: true }).click();
    await expect(
      page.getByText("No passkeys added", { exact: true }),
    ).toBeVisible();
    await accountAction(page, "Profile");
    await database.unsafe(
      `ALTER TABLE "${schema}".sessions RENAME COLUMN user_agent TO user_agent_list_fault`,
    );
    renamedAgent = true;
    await page
      .getByRole("navigation", {
        name: "Page navigation",
        exact: true,
      })
      .getByRole("button", { name: "Sessions", exact: true })
      .click();
    await expect(
      feedbackToast(page, "Mill could not complete this request"),
    ).toBeVisible();
    await expect(sessions.getByRole("alert")).toHaveCount(0);
    await expect(
      sessions.getByText("No sessions", { exact: true }),
    ).toHaveCount(0);
    await expect(keys).toHaveCount(0);
    await database.unsafe(
      `ALTER TABLE "${schema}".sessions RENAME COLUMN user_agent_list_fault TO user_agent`,
    );
    renamedAgent = false;
    await sessions.getByRole("button", { name: "Retry", exact: true }).click();
    await expect(
      sessions.getByText("This browser", { exact: true }),
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

import { expect, test, type Page } from "@playwright/test";

test.use({ trace: "off", screenshot: "off" });

function alerts(page: Page) {
  return page.locator(
    '[data-slot="toast"]:not([data-exiting="true"]):not([data-hidden="true"])',
  );
}
async function clearAlerts(page: Page) {
  for (const alert of await alerts(page).all())
    await alert.locator('[data-slot="toast-close"]').click();
  await expect(alerts(page)).toHaveCount(0);
}
async function signedOut(page: Page, emailDeliveryConfigured = true) {
  await page.route("**/api/auth/status", (route) =>
    route.fulfill({
      json: { setupRequired: false, emailDeliveryConfigured },
    }),
  );
  await page.route("**/api/auth/me", (route) =>
    route.fulfill({
      status: 401,
      json: { error: { code: "UNAUTHORIZED", message: "Sign in required" } },
    }),
  );
}

for (const [width, theme] of [
  [1280, "light"],
  [390, "dark"],
] as const) {
  test(`reset requests preserve drafts and advance only after validated acknowledgement at ${width} ${theme}`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.addInitScript(
      (appearance) => localStorage.setItem("avgeek-oss-ui-theme", appearance),
      theme,
    );
    await signedOut(page);
    const submissions: unknown[] = [];
    await page.route("**/api/auth/password-reset/request", (route) => {
      submissions.push(route.request().postDataJSON());
      return route.fulfill({
        json: submissions.length === 1 ? {} : { status: true },
      });
    });
    await page.goto("/");
    await page.getByRole("button", { name: "Forgot password?" }).click();
    await page.getByRole("button", { name: "Send reset link" }).click();
    await expect(alerts(page)).toHaveCount(1);
    expect(submissions).toHaveLength(0);
    await clearAlerts(page);
    await page
      .getByLabel("Email", { exact: true })
      .fill("unknown@example.test");
    await page.getByRole("button", { name: "Send reset link" }).click();
    await expect(alerts(page)).toContainText("response was incomplete");
    await expect(page.getByLabel("Email", { exact: true })).toHaveValue(
      "unknown@example.test",
    );
    await expect(page.locator('form [role="alert"]')).toHaveCount(0);
    await clearAlerts(page);
    await page.getByRole("button", { name: "Send reset link" }).click();
    await expect(page.getByLabel("Email", { exact: true })).toHaveCount(0);
    await expect(
      page.getByText("If an account exists for that email", { exact: false }),
    ).toBeVisible();
    await expect(alerts(page)).toHaveCount(1);
    await expect(alerts(page)).toContainText(
      "Password reset request received.",
    );
    expect(submissions).toEqual([
      { email: "unknown@example.test" },
      { email: "unknown@example.test" },
    ]);
  });
}

test("an SMTP invitation requires verified email proof before password acceptance", async ({
  page,
}) => {
  await signedOut(page);
  await page.route("**/api/auth/invitation?*", (route) =>
    route.fulfill({
      json: {
        invitation: {
          email: "invited@example.test",
          role: "member",
          workspaceName: "Review team",
        },
        verificationRequired: true,
      },
    }),
  );
  let requests = 0;
  await page.route("**/api/auth/invitation/verification/request", (route) => {
    requests++;
    return route.fulfill({
      json: {
        status: true,
        resendAvailableAt: Date.now() + 60000,
        expiresAt: new Date(Date.now() + 600000).toISOString(),
      },
    });
  });
  const proofs: unknown[] = [];
  await page.route("**/api/auth/invitation/verification/confirm", (route) => {
    proofs.push(route.request().postDataJSON());
    return route.fulfill({
      json: proofs.length === 1 ? {} : { verificationToken: "p".repeat(43) },
    });
  });
  const acceptances: unknown[] = [];
  await page.route("**/api/auth/accept-invitation", (route) => {
    acceptances.push(route.request().postDataJSON());
    return route.fulfill({ status: 503, json: { error: "Try again" } });
  });
  await page.goto(`/invite?token=${"i".repeat(43)}`);
  await expect(page.getByLabel("Password", { exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "Verify email to continue" }).click();
  await expect(page.getByLabel("Your Name", { exact: true })).toBeVisible();
  expect(requests).toBe(1);
  expect(acceptances).toHaveLength(0);
  await clearAlerts(page);
  await page.getByLabel("Your Name", { exact: true }).fill("Invited reviewer");
  await page.getByLabel("Email verification code").fill("123456");
  await page.getByRole("button", { name: "Verify and continue" }).click();
  await expect(alerts(page)).toContainText("response was incomplete");
  await expect(page.getByLabel("Your Name", { exact: true })).toHaveValue(
    "Invited reviewer",
  );
  await expect(page.getByLabel("Email verification code")).toHaveValue(
    "123456",
  );
  expect(acceptances).toHaveLength(0);
  await clearAlerts(page);
  await page.getByRole("button", { name: "Verify and continue" }).click();
  await expect(
    page.getByRole("heading", { name: "Choose your password" }),
  ).toBeVisible();
  await expect(page.getByLabel("Your Name", { exact: true })).toHaveCount(0);
  expect(acceptances).toHaveLength(0);
  await clearAlerts(page);
  await page
    .getByLabel("Password", { exact: true })
    .fill("Invited-password-42");
  await page
    .getByLabel("Confirm password", { exact: true })
    .fill("Invited-password-42");
  await page.getByRole("button", { name: "Set password" }).click();
  await expect(alerts(page)).toHaveCount(1);
  await expect(page.getByLabel("Password", { exact: true })).toHaveValue(
    "Invited-password-42",
  );
  expect(acceptances).toEqual([
    {
      token: "i".repeat(43),
      name: "Invited reviewer",
      verificationToken: "p".repeat(43),
      password: "Invited-password-42",
    },
  ]);
});

test("a recovery fragment is removed before an explicit password reset, and malformed acknowledgement keeps the draft", async ({
  page,
}) => {
  await signedOut(page, false);
  const resets: unknown[] = [];
  await page.route("**/api/auth/recovery/reset", (route) => {
    resets.push(route.request().postDataJSON());
    return route.fulfill({ json: resets.length === 1 ? {} : { ok: true } });
  });
  await page.goto(`/recover#${"r".repeat(43)}`);
  await expect(
    page.getByRole("heading", { name: "Choose a new password" }),
  ).toBeVisible();
  expect(new URL(page.url()).hash).toBe("");
  expect(resets).toHaveLength(0);
  await page
    .getByLabel("Password", { exact: true })
    .fill("Recovery-password-42");
  await page
    .getByLabel("Confirm password", { exact: true })
    .fill("Recovery-password-42");
  await page.getByRole("button", { name: "Reset password" }).click();
  await expect(alerts(page)).toContainText("response was incomplete");
  await expect(page.getByLabel("Password", { exact: true })).toHaveValue(
    "Recovery-password-42",
  );
  await clearAlerts(page);
  await page.getByRole("button", { name: "Reset password" }).click();
  await expect(
    page.getByRole("heading", { name: "Sign in", exact: true }),
  ).toBeVisible();
  await expect(alerts(page)).toContainText(
    "Password reset. Sign in to continue.",
  );
  expect(resets).toEqual([
    { token: "r".repeat(43), password: "Recovery-password-42" },
    { token: "r".repeat(43), password: "Recovery-password-42" },
  ]);
});

test("recovery opens over an existing session and preserves a different account's valid session", async ({
  page,
}) => {
  await signedOut(page, false);
  await page.route("**/api/auth/me", (route) =>
    route.fulfill({
      json: {
        user: {
          id: "current-browser-user",
          name: "Current browser user",
          email: "current-browser@example.test",
          emailVerified: true,
          role: "member",
          timeZone: "UTC",
          dateFormat: "day-short-month-year",
          timeFormat: "24-hour",
          passkeyCount: 0,
          notificationPreferences: { assignments: true, mentions: true },
        },
        workspace: { id: "current-workspace", name: "Current workspace" },
      },
    }),
  );
  for (const path of ["boards", "auth/members"])
    await page.route(`**/api/${path}?*`, (route) =>
      route.fulfill({ json: { items: [], hasMore: false, nextCursor: null } }),
    );
  await page.route("**/api/notifications?*", (route) =>
    route.fulfill({ json: { unreadCount: 0 } }),
  );
  let resetRequests = 0;
  await page.route("**/api/auth/recovery/reset", (route) => {
    resetRequests++;
    return route.fulfill({ json: { ok: true } });
  });
  await page.goto(`/recover#${"r".repeat(43)}`);
  await expect(
    page.getByRole("heading", { name: "Choose a new password" }),
  ).toBeVisible();
  expect(resetRequests).toBe(0);
  await page
    .getByLabel("Password", { exact: true })
    .fill("Other-account-password-42");
  await page
    .getByLabel("Confirm password", { exact: true })
    .fill("Other-account-password-42");
  await page.getByRole("button", { name: "Reset password" }).click();
  await expect(
    page.getByRole("heading", { name: "Boards", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Sign in", exact: true }),
  ).toHaveCount(0);
  expect(resetRequests).toBe(1);
});

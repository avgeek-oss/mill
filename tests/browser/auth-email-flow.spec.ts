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

const confirmationId = "11111111-1111-4111-8111-111111111111";
const confirmationToken = "c".repeat(43);
const browserSession = {
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
};
async function signedIn(
  page: Page,
  current = () => browserSession as typeof browserSession | null,
) {
  await signedOut(page);
  await page.route("**/api/auth/me", (route) =>
    current()
      ? route.fulfill({ json: current() })
      : route.fulfill({ status: 401, json: { error: "Sign in required" } }),
  );
  for (const path of ["boards", "auth/members"])
    await page.route(`**/api/${path}?*`, (route) =>
      route.fulfill({ json: { items: [], hasMore: false, nextCursor: null } }),
    );
  await page.route("**/api/notifications?*", (route) =>
    route.fulfill({ json: { unreadCount: 0 } }),
  );
}

for (const [width, theme] of [
  [1280, "light"],
  [1280, "dark"],
  [390, "light"],
  [390, "dark"],
] as const)
  for (const purpose of ["verify-email", "email-change"] as const) {
    test(`explicit ${purpose} confirmation preserves retry and single toast ownership at ${width} ${theme}`, async ({
      page,
    }) => {
      await page.setViewportSize({ width, height: 900 });
      await page.addInitScript(
        (appearance) => localStorage.setItem("avgeek-oss-ui-theme", appearance),
        theme,
      );
      await signedOut(page);
      let attempts = 0;
      let release = () => {};
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      const path =
        purpose === "verify-email" ? "/verify-email" : "/confirm-email-change";
      const endpoint =
        purpose === "verify-email" ? "email-verification" : "email-change";
      const confirmLabel =
        purpose === "verify-email" ? "Confirm email" : "Confirm email change";
      await page.route(`**/api/auth/${endpoint}/confirm`, async (route) => {
        attempts++;
        expect(route.request().postDataJSON()).toEqual({
          id: confirmationId,
          token: confirmationToken,
        });
        if (attempts === 1) await held;
        await route.fulfill(
          attempts <= 2
            ? {
                status: 503,
                json: {
                  error: {
                    code: "UNAVAILABLE",
                    message: "Confirmation unavailable. Try again.",
                  },
                },
              }
            : { json: attempts === 3 ? {} : { ok: true } },
        );
      });
      await page.goto(`${path}#${confirmationId}.${confirmationToken}`);
      await expect(
        page.getByRole("button", { name: confirmLabel, exact: true }),
      ).toBeVisible();
      expect(new URL(page.url()).hash).toBe("");
      expect(attempts).toBe(0);
      await expect(page.locator("body")).not.toContainText(confirmationToken);
      await page
        .getByRole("button", { name: confirmLabel, exact: true })
        .click();
      await expect(
        page.getByText("Checking confirmation link…", { exact: true }),
      ).toBeVisible();
      await expect(
        page.getByRole("button", { name: "← Back to Sign In", exact: true }),
      ).toBeDisabled();
      await page.keyboard.press("Enter");
      expect(attempts).toBe(1);
      release();
      await expect(alerts(page)).toHaveCount(1);
      await expect(alerts(page)).toContainText(
        "Confirmation unavailable. Try again.",
      );
      await expect(
        page.getByRole("button", { name: "Retry confirmation" }),
      ).toBeVisible();
      await expect(page.locator('main [role="alert"]')).toHaveCount(0);
      await clearAlerts(page);
      await page.getByRole("button", { name: "Retry confirmation" }).click();
      await expect(alerts(page)).toHaveCount(1);
      await expect(alerts(page)).toContainText(
        "Confirmation unavailable. Try again.",
      );
      await clearAlerts(page);
      await page.getByRole("button", { name: "Retry confirmation" }).click();
      await expect(alerts(page)).toHaveCount(1);
      await expect(alerts(page)).toContainText("response was incomplete");
      await clearAlerts(page);
      await page.getByRole("button", { name: "Retry confirmation" }).click();
      await expect(
        page.getByText("Sign in to continue.", { exact: true }),
      ).toBeVisible();
      await expect(
        page.getByRole("button", { name: "Retry confirmation" }),
      ).toHaveCount(0);
      await expect(alerts(page)).toHaveCount(1);
      await expect(alerts(page)).toContainText(
        purpose === "verify-email"
          ? "Email verified."
          : "Email address changed.",
      );
      expect(attempts).toBe(4);
      await page
        .getByRole("button", { name: "← Back to Sign In", exact: true })
        .click();
      await expect(
        page.getByRole("heading", { name: "Sign in", exact: true }),
      ).toBeVisible();
    });
  }

test("an incomplete public confirmation emits one toast, scrubs the fragment, and offers no mutation or retry", async ({
  page,
}) => {
  await signedOut(page);
  let confirmations = 0;
  await page.route("**/api/auth/email-verification/confirm", (route) => {
    confirmations++;
    return route.fulfill({ json: { ok: true } });
  });
  await page.goto("/verify-email#incomplete");
  await expect(
    page.getByRole("heading", { name: "Verify your email" }),
  ).toBeVisible();
  await expect(alerts(page)).toHaveCount(1);
  await expect(alerts(page)).toContainText("confirmation link is incomplete");
  expect(new URL(page.url()).hash).toBe("");
  await expect(
    page.getByRole("button", { name: "Confirm email", exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Retry confirmation" }),
  ).toHaveCount(0);
  expect(confirmations).toBe(0);
});

test("verification requests retain the email on malformed acknowledgement and keep account existence neutral", async ({
  page,
}) => {
  await signedOut(page);
  const addresses: string[] = [];
  await page.route("**/api/auth/verification-email", (route) => {
    addresses.push(route.request().postDataJSON().email);
    return route.fulfill({
      json: addresses.length === 1 ? {} : { status: true },
    });
  });
  await page.goto("/");
  await expect(
    page.getByRole("button", { name: "Need a new verification email?" }),
  ).toHaveCount(0);
  await page.goto("/verification-email");
  await page.getByLabel("Email", { exact: true }).fill("known@example.test");
  await page.getByRole("button", { name: "Send verification link" }).click();
  await expect(alerts(page)).toHaveCount(1);
  await expect(alerts(page)).toContainText("response was incomplete");
  await expect(page.getByLabel("Email", { exact: true })).toHaveValue(
    "known@example.test",
  );
  await clearAlerts(page);
  await page.getByRole("button", { name: "Send verification link" }).click();
  const neutralInstructions = page.getByText(
    "If an account needs email verification",
    { exact: false },
  );
  await expect(neutralInstructions).toBeVisible();
  const copy = await neutralInstructions.textContent();
  await expect(alerts(page)).toHaveCount(1);
  await expect(alerts(page)).toContainText("Verification request received.");
  await clearAlerts(page);
  await page.getByRole("button", { name: "Request another link" }).click();
  await expect(page.getByLabel("Email", { exact: true })).toHaveValue(
    "known@example.test",
  );
  await page.getByLabel("Email", { exact: true }).fill("unknown@example.test");
  await page.getByRole("button", { name: "Send verification link" }).click();
  await expect(neutralInstructions).toHaveText(copy!);
  await expect(alerts(page)).toHaveCount(1);
  await expect(alerts(page)).toContainText("Verification request received.");
  expect(addresses).toEqual([
    "known@example.test",
    "known@example.test",
    "unknown@example.test",
  ]);
});

test("a lost email-change acknowledgement checks revocation without claiming successful confirmation", async ({
  page,
}) => {
  let session: typeof browserSession | null = browserSession;
  await signedIn(page, () => session);
  let attempts = 0;
  await page.route("**/api/auth/email-change/confirm", (route) => {
    attempts++;
    session = null;
    return route.fulfill({ json: {} });
  });
  await page.goto(
    `/confirm-email-change#${confirmationId}.${confirmationToken}`,
  );
  await expect(
    page.getByRole("button", { name: "Confirm email change", exact: true }),
  ).toBeVisible();
  expect(attempts).toBe(0);
  await page
    .getByRole("button", { name: "Confirm email change", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Retry confirmation" }),
  ).toBeVisible();
  await expect(alerts(page)).toHaveCount(1);
  await expect(alerts(page)).toContainText("response was incomplete");
  await expect(
    page.getByText("Sign in to continue.", { exact: true }),
  ).toHaveCount(0);
  await expect(alerts(page)).not.toContainText("Email address changed.");
  await page
    .getByRole("button", { name: "← Back to Sign In", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "Sign in", exact: true }),
  ).toBeVisible();
  expect(attempts).toBe(1);
});

test("a public email change for another account preserves the browser's valid session", async ({
  page,
}) => {
  await signedIn(page);
  await page.route("**/api/auth/email-change/confirm", (route) =>
    route.fulfill({ json: { ok: true } }),
  );
  await page.goto(
    `/confirm-email-change#${confirmationId}.${confirmationToken}`,
  );
  await page
    .getByRole("button", { name: "Confirm email change", exact: true })
    .click();
  await expect(
    page.getByText("Sign in to continue.", { exact: true }),
  ).toBeVisible();
  await expect(alerts(page)).toHaveCount(1);
  await expect(alerts(page)).toContainText("Email address changed.");
  await page
    .getByRole("button", { name: "← Back to Sign In", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "Boards", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Sign in", exact: true }),
  ).toHaveCount(0);
});

for (const width of [1280, 390])
  for (const theme of ["light", "dark"] as const)
    test(`invitation resend preserves drafts, prevents competing verification, and has one outcome toast at ${width} ${theme}`, async ({
      page,
    }) => {
      await page.setViewportSize({ width, height: 900 });
      await page.addInitScript(
        (appearance) => localStorage.setItem("avgeek-oss-ui-theme", appearance),
        theme,
      );
      await signedOut(page);
      await page.route("**/api/auth/invitation?*", (route) =>
        route.fulfill({
          json: {
            invitation: {
              email: "invited@example.test",
              role: "member",
              workspaceName: "Resend team",
            },
            verificationRequired: true,
          },
        }),
      );
      let requests = 0;
      let verifications = 0;
      let release = () => {};
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      await page.route(
        "**/api/auth/invitation/verification/request",
        async (route) => {
          requests++;
          if (requests === 5) await held;
          await route.fulfill(
            requests === 2 || requests === 3
              ? {
                  status: 503,
                  json: { error: "Cannot request code. Try again." },
                }
              : {
                  json:
                    requests === 4
                      ? {}
                      : {
                          status: true,
                          resendAvailableAt:
                            Date.now() + (requests === 5 ? 60000 : -1),
                          expiresAt: new Date(
                            Date.now() + 600000,
                          ).toISOString(),
                        },
                },
          );
        },
      );
      await page.route(
        "**/api/auth/invitation/verification/confirm",
        (route) => {
          verifications++;
          return route.fulfill({
            status: 400,
            json: { error: "Do not verify while resending" },
          });
        },
      );
      await page.goto(`/invite?token=${"i".repeat(43)}`);
      await page
        .getByRole("button", { name: "Verify email to continue" })
        .click();
      await expect(page.getByLabel("Your Name", { exact: true })).toBeVisible();
      await clearAlerts(page);
      await page
        .getByLabel("Your Name", { exact: true })
        .fill("Retained reviewer");
      await page.getByLabel("Email verification code").fill("123456");
      for (let attempt = 0; attempt < 3; attempt++) {
        await page
          .getByRole("button", { name: "Resend code", exact: true })
          .click();
        await expect(alerts(page)).toHaveCount(1);
        await expect(alerts(page)).toContainText(
          attempt < 2
            ? "Cannot request code. Try again."
            : "response was incomplete",
        );
        await expect(page.getByLabel("Your Name", { exact: true })).toHaveValue(
          "Retained reviewer",
        );
        await expect(page.getByLabel("Email verification code")).toHaveValue(
          "123456",
        );
        await clearAlerts(page);
      }
      await page
        .getByRole("button", { name: "Resend code", exact: true })
        .click();
      await expect(
        page.getByLabel("Your Name", { exact: true }),
      ).toBeDisabled();
      await expect(
        page.getByRole("button", { name: "Verify and continue" }),
      ).toBeDisabled();
      await page.keyboard.press("Enter");
      expect(requests).toBe(5);
      expect(verifications).toBe(0);
      release();
      await expect(alerts(page)).toHaveCount(1);
      await expect(alerts(page)).toContainText("Verification code requested.");
      await expect(
        page.getByRole("button", { name: /^Resend in \d+s$/ }),
      ).toBeDisabled();
      await expect(page.getByLabel("Your Name", { exact: true })).toHaveValue(
        "Retained reviewer",
      );
      await expect(page.getByLabel("Email verification code")).toHaveValue(
        "123456",
      );
      expect(requests).toBe(5);
      expect(verifications).toBe(0);
    });

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

import { randomBytes } from "node:crypto";
import {
  expect,
  request,
  test,
  type APIRequestContext,
  type Page,
} from "@playwright/test";
import { getBrowserBootstrap } from "../browser-fixture.js";

// Account security and token values must not enter failure artifacts.
test.use({ trace: "off", screenshot: "off" });
const password = "Email-settings-browser-password-42";
let admin: APIRequestContext;
let origin = "";

test.beforeAll(async ({ baseURL }) => {
  const fixture = await getBrowserBootstrap(baseURL!);
  admin = fixture.api;
  origin = fixture.origin;
});
test.afterAll(async () => {
  await admin?.dispose();
});

function alerts(page: Page) {
  return page.locator(
    '[data-slot="toast"]:not([data-exiting="true"]):not([data-hidden="true"])',
  );
}
async function clearAlerts(page: Page) {
  while (await alerts(page).count()) {
    await alerts(page).last().locator('[data-slot="toast-close"]').click();
    await expect(alerts(page)).toHaveCount(0);
  }
}
async function account(page: Page, configured = true) {
  const email = `email-settings-${randomBytes(5).toString("hex")}@example.test`;
  const invitation = await admin.post("/api/auth/invitations", {
    headers: { Origin: origin },
    data: { email, role: "member" },
  });
  expect(invitation.ok()).toBe(true);
  const api = await request.newContext({ baseURL: origin });
  try {
    const accepted = await api.post("/api/auth/accept-invitation", {
      headers: { Origin: origin },
      data: {
        token: (await invitation.json()).token,
        name: "Account email review",
        password,
      },
    });
    expect(accepted.ok()).toBe(true);
    await page.context().addCookies((await api.storageState()).cookies);
  } finally {
    await api.dispose();
  }
  // Exercise the published UI capability branches independently of the runner's SMTP config.
  await page.route("**/api/auth/status", async (route) => {
    const response = await route.fetch();
    await route.fulfill({
      response,
      json: {
        ...(await response.json()),
        emailDeliveryConfigured: configured,
      },
    });
  });
  return email;
}
async function confirmPassword(page: Page, value = password) {
  const identity = page.getByRole("dialog", {
    name: "Confirm it’s you",
    exact: true,
  });
  await expect(identity).toBeVisible();
  await identity.getByLabel("Password", { exact: true }).fill(value);
  await identity.getByRole("button", { name: "Confirm", exact: true }).click();
}
function failure(message: string) {
  return {
    status: 503,
    json: { error: { code: "REQUEST_FAILED", message } },
  };
}
type Pending = { email: string; expiresAt: string };
async function emailService(page: Page) {
  const current = await page.request.get("/api/auth/me");
  expect(current.ok()).toBe(true);
  const ownerId: string = (await current.json()).user.id;
  const state = {
    pending: null as Pending | null,
    requests: 0,
    cancellations: 0,
    lookups: 0,
    failedLookups: 0,
    failedRequests: 0,
    failedCancellations: 0,
    loseRequestResponse: false,
    loseCancelResponse: false,
  };
  await page.route("**/api/auth/email-change", async (route) => {
    expect(route.request().headers()["x-mill-user-id"]).toBe(ownerId);
    switch (route.request().method()) {
      case "GET":
        state.lookups++;
        if (state.failedLookups-- > 0)
          return route.fulfill(failure("Email settings could not load."));
        return route.fulfill({ json: { pending: state.pending } });
      case "POST": {
        state.requests++;
        if (state.failedRequests-- > 0)
          return route.fulfill(
            failure("Email confirmation could not be queued."),
          );
        const email = String(route.request().postDataJSON().email)
          .trim()
          .toLowerCase();
        if (state.pending?.email !== email)
          state.pending = {
            email,
            expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
          };
        if (state.loseRequestResponse) {
          state.loseRequestResponse = false;
          return route.abort("connectionfailed");
        }
        return route.fulfill({ json: { pending: state.pending } });
      }
      case "DELETE":
        state.cancellations++;
        if (state.failedCancellations-- > 0)
          return route.fulfill(failure("Email change could not be canceled."));
        state.pending = null;
        if (state.loseCancelResponse) {
          state.loseCancelResponse = false;
          return route.abort("connectionfailed");
        }
        return route.fulfill({ json: { ok: true } });
      default:
        return route.continue();
    }
  });
  return state;
}

for (const width of [1280, 390]) {
  for (const theme of ["light", "dark"]) {
    test(`email change retains drafts and retries in its identity dialog at ${width}px in ${theme}`, async ({
      page,
    }) => {
      await page.setViewportSize({ width, height: 844 });
      await page.addInitScript((value) => {
        localStorage.setItem("avgeek-oss-ui-theme", value);
      }, theme);
      const currentEmail = await account(page);
      const service = await emailService(page);
      service.failedLookups = 1;
      await page.goto("/settings/email-password");
      await expect(alerts(page)).toContainText(
        "Email settings could not load.",
      );
      await expect(
        page.getByLabel("New email address", { exact: true }),
      ).toHaveCount(0);
      await clearAlerts(page);
      await page.getByRole("button", { name: "Retry", exact: true }).click();
      const draft = "new-address@example.test";
      const input = page.getByLabel("New email address", { exact: true });
      await input.fill(draft);
      service.failedRequests = 2;
      await page
        .getByRole("button", { name: "Send confirmation", exact: true })
        .click();
      await confirmPassword(page, "Incorrect-password-42");
      await expect(alerts(page)).toHaveCount(1);
      expect(service.requests).toBe(0);
      await expect(input).toHaveValue(draft);
      await expect(input).toBeDisabled();
      await clearAlerts(page);
      await confirmPassword(page);
      const retry = page.getByRole("dialog", {
        name: "Retry security change?",
        exact: true,
      });
      await expect(retry).toBeVisible();
      await expect(alerts(page)).toHaveCount(1);
      await expect(alerts(page)).toContainText(
        "Email confirmation could not be queued.",
      );
      await expect(retry.getByRole("alert")).toHaveCount(0);
      await clearAlerts(page);
      await retry.getByRole("button", { name: "Retry", exact: true }).click();
      await expect(alerts(page)).toHaveCount(1);
      await expect(input).toHaveValue(draft);
      expect(service.requests).toBe(2);
      await clearAlerts(page);
      service.loseRequestResponse = true;
      await retry.getByRole("button", { name: "Retry", exact: true }).click();
      await expect(retry).toHaveCount(0);
      await expect(input).toBeEnabled();
      await expect(input).toHaveValue(draft);
      await expect(
        page.getByLabel("Current email", { exact: true }),
      ).toHaveValue(currentEmail);
      await expect(
        page.getByText(`Waiting for confirmation at ${draft}.`, {
          exact: false,
        }),
      ).toBeVisible();
      await expect(alerts(page)).toHaveCount(1);
      await expect(alerts(page)).toContainText("Confirmation email queued.");
      expect(service.requests).toBe(3);
      expect(service.lookups).toBe(3);
      await clearAlerts(page);
      service.failedCancellations = 1;
      await page
        .getByRole("button", { name: "Cancel email change", exact: true })
        .click();
      await expect(alerts(page)).toHaveCount(1);
      await expect(alerts(page)).toContainText(
        "Email change could not be canceled.",
      );
      await expect(
        page.getByText(`Waiting for confirmation at ${draft}.`, {
          exact: false,
        }),
      ).toBeVisible();
      await clearAlerts(page);
      service.loseCancelResponse = true;
      await page
        .getByRole("button", { name: "Cancel email change", exact: true })
        .click();
      await expect(
        page.getByRole("button", { name: "Cancel email change", exact: true }),
      ).toHaveCount(0);
      await expect(alerts(page)).toHaveCount(1);
      await expect(alerts(page)).toContainText("Email change canceled.");
      expect(service.cancellations).toBe(2);
      await page.reload();
      await expect(
        page.getByLabel("Current email", { exact: true }),
      ).toHaveValue(currentEmail);
      await expect(
        page.getByRole("button", { name: "Cancel email change", exact: true }),
      ).toHaveCount(0);
    });
  }
}

test("unconfigured email delivery shows the actual verification status and read-only guidance", async ({
  page,
}) => {
  const currentEmail = await account(page, false);
  let isVerified = false;
  let emailLookups = 0;
  await page.route("**/api/auth/me", async (route) => {
    const response = await route.fetch();
    const data = await response.json();
    await route.fulfill({
      response,
      json: { ...data, user: { ...data.user, emailVerified: isVerified } },
    });
  });
  await page.route("**/api/auth/email-change", (route) => {
    emailLookups++;
    return route.continue();
  });
  await page.goto("/settings/email-password");
  await expect(page.getByLabel("Current email", { exact: true })).toHaveValue(
    currentEmail,
  );
  await expect(page.getByText("Unverified", { exact: true })).toBeVisible();
  await expect(
    page.getByText(
      /Email changes and verification are unavailable until email delivery is configured/,
    ),
  ).toBeVisible();
  await expect(
    page.getByLabel("New email address", { exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("button", {
      name: "Unverified email. Resend confirmation email",
      exact: true,
    }),
  ).toHaveCount(0);
  expect(emailLookups).toBe(0);
  isVerified = true;
  await page.reload();
  await expect(page.getByText("Verified", { exact: true })).toBeVisible();
  expect(emailLookups).toBe(0);
});

test("verification resend reports every failed attempt in a toast and keeps its dialog and cooldown", async ({
  page,
}) => {
  await account(page);
  await emailService(page);
  await page.route("**/api/auth/me", async (route) => {
    const response = await route.fetch();
    const data = await response.json();
    await route.fulfill({
      response,
      json: { ...data, user: { ...data.user, emailVerified: false } },
    });
  });
  const current = await page.request.get("/api/auth/me");
  expect(current.ok()).toBe(true);
  const ownerId: string = (await current.json()).user.id;
  let requests = 0;
  let deliveries = 0;
  let resendAvailableAt = 0;
  await page.route("**/api/auth/email-verification/request", async (route) => {
    expect(route.request().headers()["x-mill-user-id"]).toBe(ownerId);
    requests++;
    if (requests <= 2)
      return route.fulfill(failure("Verification email could not be queued."));
    if (!resendAvailableAt) {
      deliveries++;
      resendAvailableAt = Date.now() + 60_000;
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: '{"status":',
      });
    }
    return route.fulfill({ json: { status: true, resendAvailableAt } });
  });
  await page.goto("/settings/email-password");
  const unverified = page.getByRole("button", {
    name: "Unverified email. Resend confirmation email",
    exact: true,
  });
  await unverified.click();
  const verification = page.getByRole("dialog", {
    name: "Verify your email",
    exact: true,
  });
  for (let attempt = 0; attempt < 3; attempt++) {
    await verification
      .getByRole("button", { name: "Send confirmation", exact: true })
      .click();
    await expect(alerts(page)).toHaveCount(1);
    await expect(verification).toBeVisible();
    await expect(verification.getByRole("alert")).toHaveCount(0);
    await expect(
      verification.getByRole("button", {
        name: "Send confirmation",
        exact: true,
      }),
    ).toBeEnabled();
    await clearAlerts(page);
  }
  await verification
    .getByRole("button", { name: "Send confirmation", exact: true })
    .click();
  await expect(verification).toHaveCount(0);
  await expect(alerts(page)).toHaveCount(1);
  await expect(alerts(page)).toContainText("Verification email queued.");
  expect(deliveries).toBe(1);
  expect(requests).toBe(4);
  await unverified.click();
  await expect(
    verification.getByRole("button", { name: /^Resend in \d+s$/ }),
  ).toBeDisabled();
  await verification
    .getByRole("button", { name: "Cancel", exact: true })
    .click();
  expect(requests).toBe(4);
});

test("canceling a passkey email ceremony retains the email draft and an expired session cannot mutate it", async ({
  page,
}) => {
  await account(page);
  const service = await emailService(page);
  const cdp = await page.context().newCDPSession(page);
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
  await page.goto("/settings/passkeys");
  await page.getByRole("button", { name: "Add passkey", exact: true }).click();
  const enrollment = page.getByRole("dialog", {
    name: "Add passkey",
    exact: true,
  });
  await enrollment
    .getByLabel("Name", { exact: true })
    .fill("Email verification passkey");
  await enrollment
    .getByRole("button", { name: "Continue", exact: true })
    .click();
  await confirmPassword(page);
  await page
    .getByRole("dialog", { name: "Save recovery codes", exact: true })
    .getByRole("button", { name: "Continue", exact: true })
    .click();
  await page.goto("/settings/email-password");
  await clearAlerts(page);
  await cdp.send("WebAuthn.setAutomaticPresenceSimulation", {
    authenticatorId,
    enabled: false,
  });
  const draft = "passkey-email-change@example.test";
  const input = page.getByLabel("New email address", { exact: true });
  await input.fill(draft);
  const identity = page.getByRole("dialog", {
    name: "Confirm it’s you",
    exact: true,
  });
  for (let attempt = 0; attempt < 2; attempt++) {
    await page
      .getByRole("button", { name: "Send confirmation", exact: true })
      .click();
    await confirmPassword(page);
    await expect(
      identity.getByRole("button", { name: "Try passkey again", exact: true }),
    ).toBeDisabled();
    await identity.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(identity).toHaveCount(0);
    await expect(input).toHaveValue(draft);
    await expect(input).toBeEnabled();
    await expect(alerts(page)).toHaveCount(1);
    await expect(alerts(page)).toContainText("Identity confirmation canceled.");
    expect(service.requests).toBe(0);
    await clearAlerts(page);
  }
  await page
    .getByRole("button", { name: "Send confirmation", exact: true })
    .click();
  await confirmPassword(page);
  await expect(
    identity.getByRole("button", { name: "Try passkey again", exact: true }),
  ).toBeDisabled();
  const logout = await page.request.post("/api/auth/logout", {
    headers: { Origin: origin },
    data: {},
  });
  expect(logout.ok()).toBe(true);
  expect((await page.request.get("/api/auth/me")).status()).toBe(401);
  await page.evaluate(() => window.dispatchEvent(new Event("mill:expired")));
  await cdp.send("WebAuthn.setAutomaticPresenceSimulation", {
    authenticatorId,
    enabled: true,
  });
  await expect(
    page.getByRole("heading", { name: "Sign in", exact: true }),
  ).toBeVisible();
  await expect(identity).toHaveCount(0);
  expect(service.requests).toBe(0);
});

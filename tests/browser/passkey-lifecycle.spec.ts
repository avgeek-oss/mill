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
const password = "Passkey-lifecycle-browser-password-42";
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
    const count = await alerts(page).count();
    await page
      .locator(
        '[data-slot="toast"][data-frontmost="true"]:not([data-exiting="true"])',
      )
      .locator('[data-slot="toast-close"]')
      .click();
    await expect(alerts(page)).toHaveCount(count - 1);
  }
}
async function account(page: Page) {
  const email = `passkey-lifecycle-${randomBytes(5).toString("hex")}@example.test`;
  const invitation = await admin.post("/api/auth/invitations", {
    headers: { Origin: origin },
    data: { email, role: "member" },
  });
  expect(
    invitation.ok(),
    `Fixture invitation returned HTTP ${invitation.status()}`,
  ).toBe(true);
  const api = await request.newContext({ baseURL: origin });
  try {
    const accepted = await api.post("/api/auth/accept-invitation", {
      headers: { Origin: origin },
      data: {
        token: (await invitation.json()).token,
        name: "Passkey lifecycle review",
        password,
      },
    });
    expect(
      accepted.ok(),
      `Fixture invitation acceptance returned HTTP ${accepted.status()}`,
    ).toBe(true);
    await page.context().addCookies((await api.storageState()).cookies);
  } finally {
    await api.dispose();
  }
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
test("passkey enrollment aborts its held ceremony on expiry and preserves the name for a fresh confirmed retry", async ({
  page,
}) => {
  const email = await account(page);
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
        automaticPresenceSimulation: false,
      },
    },
  );
  let registrations = 0;
  await page.route("**/api/auth/passkeys/register/verify", (route) => {
    if (route.request().method() === "POST") registrations++;
    return route.continue();
  });
  await page.goto("/settings/passkeys");
  await page.getByRole("button", { name: "Add passkey", exact: true }).click();
  const enrollment = page.getByRole("dialog", {
    name: "Add passkey",
    exact: true,
  });
  const name = "Retained passkey enrollment";
  await enrollment.getByLabel("Name", { exact: true }).fill(name);
  await enrollment
    .getByRole("button", { name: "Continue", exact: true })
    .click();
  const firstOptions = page.waitForResponse((response) =>
    response.url().endsWith("/api/auth/passkeys/register/options"),
  );
  await confirmPassword(page);
  const firstChallenge = (await (await firstOptions).json()).challengeId;
  await expect(enrollment.getByLabel("Name", { exact: true })).toBeDisabled();
  expect(registrations).toBe(0);
  const logout = await page.request.post("/api/auth/logout", {
    headers: { Origin: origin },
    data: {},
  });
  expect(logout.ok()).toBe(true);
  expect((await page.request.get("/api/auth/me")).status()).toBe(401);
  await page.evaluate(() => window.dispatchEvent(new Event("mill:expired")));
  await expect(
    page.getByRole("heading", { name: "Sign in", exact: true }),
  ).toBeVisible();
  await page.getByLabel("Email", { exact: true }).fill(email);
  await page.getByLabel("Password", { exact: true }).fill(password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(enrollment).toBeVisible();
  await expect(enrollment.getByLabel("Name", { exact: true })).toHaveValue(
    name,
  );
  await expect(
    enrollment.getByRole("button", { name: "Continue", exact: true }),
  ).toBeEnabled();
  await expect(
    page.getByRole("dialog", { name: "Confirm it’s you", exact: true }),
  ).toHaveCount(0);
  expect(registrations).toBe(0);
  await clearAlerts(page);
  await cdp.send("WebAuthn.setAutomaticPresenceSimulation", {
    authenticatorId,
    enabled: true,
  });
  await enrollment
    .getByRole("button", { name: "Continue", exact: true })
    .click();
  const freshOptions = page.waitForResponse((response) =>
    response.url().endsWith("/api/auth/passkeys/register/options"),
  );
  await confirmPassword(page);
  expect((await (await freshOptions).json()).challengeId).not.toBe(
    firstChallenge,
  );
  const recovery = page.getByRole("dialog", {
    name: "Save recovery codes",
    exact: true,
  });
  await recovery.getByRole("button", { name: "Continue", exact: true }).click();
  await expect(
    page.getByRole("grid", { name: "Passkeys", exact: true }),
  ).toContainText(name);
  expect(registrations).toBe(1);
  await expect(alerts(page)).toContainText("Passkey added");
});

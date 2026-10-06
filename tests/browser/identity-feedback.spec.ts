import {
  expect,
  request,
  test,
  type APIRequestContext,
  type Page,
} from "@playwright/test";
import { getBrowserBootstrap } from "../browser-fixture.js";

test.use({ trace: "off", screenshot: "off" });

const password = "Identity-feedback-password-42";
let origin = "";
let admin: APIRequestContext;
test.beforeAll(async ({ baseURL }) => {
  const fixture = await getBrowserBootstrap(baseURL!);
  origin = fixture.origin;
  admin = fixture.api;
});
test.afterAll(async () => {
  await admin?.dispose();
});

function alerts(page: Page) {
  return page.locator('[data-slot="toast"]:not([data-exiting="true"])');
}

for (const width of [1280, 390])
  for (const theme of ["light", "dark"] as const) {
    test(`canceling pending passkey confirmation toasts once per attempt at ${width}px in ${theme}`, async ({
      browser,
    }) => {
      const invitation = await admin.post("/api/auth/invitations", {
        headers: { Origin: origin },
        data: {
          email: `identity-feedback-${width}-${theme}@example.test`,
          role: "member",
        },
      });
      expect(invitation.ok()).toBe(true);
      const account = await request.newContext({ baseURL: origin });
      const accepted = await account.post("/api/auth/accept-invitation", {
        headers: { Origin: origin },
        data: {
          token: (await invitation.json()).token,
          name: "Identity feedback review",
          password,
        },
      });
      expect(accepted.ok()).toBe(true);
      const context = await browser.newContext({
        baseURL: origin,
        storageState: await account.storageState(),
        viewport: { width, height: 844 },
        isMobile: width === 390,
        hasTouch: width === 390,
      });
      await account.dispose();
      try {
        await context.addInitScript((value) => {
          localStorage.setItem("avgeek-oss-ui-theme", value);
        }, theme);
        const page = await context.newPage();
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
        await page.goto("/settings/passkeys");
        await page
          .getByRole("button", { name: "Add passkey", exact: true })
          .click();
        const enrollment = page.getByRole("dialog", {
          name: "Add passkey",
          exact: true,
        });
        await enrollment
          .getByLabel("Name", { exact: true })
          .fill("Feedback passkey");
        await enrollment
          .getByRole("button", { name: "Continue", exact: true })
          .click();
        const identity = page.getByRole("dialog", {
          name: "Confirm it’s you",
          exact: true,
        });
        await identity.getByLabel("Password", { exact: true }).fill(password);
        await identity
          .getByRole("button", { name: "Confirm", exact: true })
          .click();
        await page
          .getByRole("dialog", { name: "Save recovery codes", exact: true })
          .getByRole("button", { name: "Continue", exact: true })
          .click();
        await expect(
          page.getByRole("grid", { name: "Passkeys", exact: true }),
        ).toContainText("Feedback passkey");
        while (await alerts(page).count()) {
          await alerts(page)
            .last()
            .locator('[data-slot="toast-close"]')
            .click();
          await expect(alerts(page)).toHaveCount(0);
        }
        await cdp.send("WebAuthn.setAutomaticPresenceSimulation", {
          authenticatorId,
          enabled: false,
        });
        await page
          .getByRole("button", { name: "More actions", exact: true })
          .click();
        await page
          .getByRole("menuitem", {
            name: "Replace recovery codes",
            exact: true,
          })
          .click();
        const replacement = page.getByRole("dialog", {
          name: "Replace recovery codes?",
          exact: true,
        });
        let mutations = 0;
        await page.route("**/api/auth/passkeys/recovery-codes", (route) => {
          if (route.request().method() === "POST") mutations++;
          return route.continue();
        });
        const challenges = new Set<string>();
        for (let attempt = 0; attempt < 2; attempt++) {
          await replacement
            .getByRole("button", { name: "Confirm", exact: true })
            .click();
          await identity.getByLabel("Password", { exact: true }).fill(password);
          const options = page.waitForResponse((response) =>
            response.url().endsWith("/api/auth/passkeys/authenticate/options"),
          );
          await identity.getByLabel("Password", { exact: true }).press("Enter");
          const ceremony = await (await options).json();
          expect(challenges.has(ceremony.challengeId)).toBe(false);
          challenges.add(ceremony.challengeId);
          await expect(
            identity.getByRole("button", {
              name: "Try passkey again",
              exact: true,
            }),
          ).toBeDisabled();
          await identity
            .getByRole("button", { name: "Cancel", exact: true })
            .click();
          await expect(identity).toHaveCount(0);
          await expect(replacement).toBeVisible();
          await expect(
            replacement.getByRole("button", { name: "Confirm", exact: true }),
          ).toBeEnabled();
          await expect(alerts(page)).toHaveCount(1);
          await expect(alerts(page)).toContainText(
            "Identity confirmation canceled.",
          );
          await expect(replacement.getByRole("alert")).toHaveCount(0);
          await alerts(page).locator('[data-slot="toast-close"]').click();
          await expect(alerts(page)).toHaveCount(0);
        }
        expect(mutations).toBe(0);
        await expect(
          page.getByRole("grid", { name: "Passkeys", exact: true }),
        ).toContainText("Feedback passkey");
        await cdp.send("WebAuthn.setAutomaticPresenceSimulation", {
          authenticatorId,
          enabled: true,
        });
        let releaseVerification = () => {};
        const verificationHeld = new Promise<void>((resolve) => {
          releaseVerification = resolve;
        });
        let verificationStarted = () => {};
        const verifying = new Promise<void>((resolve) => {
          verificationStarted = resolve;
        });
        await page.route(
          "**/api/auth/passkeys/authenticate/verify",
          async (route) => {
            verificationStarted();
            await verificationHeld;
            await route.continue();
          },
        );
        await replacement
          .getByRole("button", { name: "Confirm", exact: true })
          .click();
        await identity.getByLabel("Password", { exact: true }).fill(password);
        await identity.getByLabel("Password", { exact: true }).press("Enter");
        await verifying;
        try {
          await expect(
            identity.getByRole("button", {
              name: "Try passkey again",
              exact: true,
            }),
          ).toBeDisabled();
          await expect(
            identity.getByRole("button", { name: "Cancel", exact: true }),
          ).toBeDisabled();
          await expect(
            identity.locator('[data-slot="modal-close-trigger"]'),
          ).toBeDisabled();
          await page.keyboard.press("Escape");
          await expect(identity).toBeVisible();
          expect(mutations).toBe(0);
          await expect(alerts(page)).toHaveCount(0);
        } finally {
          releaseVerification();
        }
        await expect(
          page.getByRole("dialog", {
            name: "Save recovery codes",
            exact: true,
          }),
        ).toBeVisible();
        expect(mutations).toBe(1);
      } finally {
        await context.close();
      }
    });

    test(`incomplete invitation explains failure only in a toast at ${width}px in ${theme}`, async ({
      browser,
    }) => {
      const context = await browser.newContext({
        baseURL: origin,
        viewport: { width, height: 844 },
        isMobile: width === 390,
        hasTouch: width === 390,
      });
      try {
        await context.addInitScript((value) => {
          localStorage.setItem("avgeek-oss-ui-theme", value);
        }, theme);
        const page = await context.newPage();
        const failure =
          "This invitation link is incomplete. Ask your administrator for a new link.";
        for (let attempt = 0; attempt < 2; attempt++) {
          await page.goto("/invite");
          await expect(
            page.getByRole("heading", {
              name: "Join your workspace",
              exact: true,
            }),
          ).toBeVisible();
          await expect(alerts(page)).toHaveCount(1);
          await expect(alerts(page)).toContainText(failure);
          await expect(
            page.getByRole("main").getByText(failure, { exact: true }),
          ).toHaveCount(0);
          await expect(
            page.getByText(/This invitation may have expired/),
          ).toHaveCount(0);
          await alerts(page).locator('[data-slot="toast-close"]').click();
          await expect(alerts(page)).toHaveCount(0);
          await page.getByRole("button", { name: "Back to Sign In" }).click();
          await expect(
            page.getByRole("heading", { name: "Sign in", exact: true }),
          ).toBeVisible();
        }
      } finally {
        await context.close();
      }
    });
  }

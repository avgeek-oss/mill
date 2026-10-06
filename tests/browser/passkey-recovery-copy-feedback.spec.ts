import { expect, request, test } from "@playwright/test";
import { getBrowserBootstrap } from "../browser-fixture.js";

test.use({ trace: "off", screenshot: "off" });

for (const width of [1280, 390])
  for (const theme of ["light", "dark"] as const) {
    test(`passkey recovery copying reports every failure and awaited success via toast at ${width}px in ${theme}`, async ({
      browser,
      baseURL,
    }) => {
      const fixture = await getBrowserBootstrap(baseURL!);
      const password = "Recovery-copy-password-42";
      const invitation = await fixture.api.post("/api/auth/invitations", {
        headers: { Origin: fixture.origin },
        data: {
          email: `recovery-copy-${width}-${theme}@example.test`,
          role: "member",
        },
      });
      expect(
        invitation.ok(),
        `Fixture invitation returned HTTP ${invitation.status()}`,
      ).toBe(true);
      const account = await request.newContext({ baseURL: fixture.origin });
      const accepted = await account.post("/api/auth/accept-invitation", {
        headers: { Origin: fixture.origin },
        data: {
          token: (await invitation.json()).token,
          name: "Recovery copy review",
          password,
        },
      });
      expect(
        accepted.ok(),
        `Fixture invitation acceptance returned HTTP ${accepted.status()}`,
      ).toBe(true);
      const context = await browser.newContext({
        baseURL: fixture.origin,
        storageState: await account.storageState(),
        viewport: { width, height: 900 },
        isMobile: width === 390,
        hasTouch: width === 390,
      });
      await account.dispose();
      await fixture.api.dispose();
      try {
        await context.addInitScript((appearance) => {
          localStorage.setItem("avgeek-oss-ui-theme", appearance);
          const state = { attempts: 0, text: "", release: () => {} };
          Object.defineProperty(window, "recoveryCopyTest", { value: state });
          Object.defineProperty(navigator, "clipboard", {
            configurable: true,
            value: {
              writeText: async (value: string) => {
                state.attempts++;
                if (state.attempts <= 2)
                  throw new Error("Clipboard unavailable");
                state.text = value;
                await new Promise<void>((resolve) => {
                  state.release = resolve;
                });
              },
            },
          });
        }, theme);
        const page = await context.newPage();
        const cdp = await context.newCDPSession(page);
        await cdp.send("WebAuthn.enable");
        await cdp.send("WebAuthn.addVirtualAuthenticator", {
          options: {
            protocol: "ctap2",
            transport: "internal",
            hasResidentKey: true,
            hasUserVerification: true,
            isUserVerified: true,
            automaticPresenceSimulation: true,
          },
        });
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
          .fill("Recovery copy passkey");
        await enrollment
          .getByRole("button", { name: "Continue", exact: true })
          .click();
        const confirmation = page.getByRole("dialog", {
          name: "Confirm it’s you",
          exact: true,
        });
        await confirmation
          .getByLabel("Password", { exact: true })
          .fill(password);
        await confirmation
          .getByRole("button", { name: "Confirm", exact: true })
          .click();
        const recovery = page.getByRole("dialog", {
          name: "Save recovery codes",
          exact: true,
        });
        await expect(recovery).toBeVisible();
        const codes = recovery.getByRole("list", {
          name: "Recovery codes",
          exact: true,
        });
        await expect(codes.getByRole("listitem")).toHaveCount(10);
        const activeToasts = page.locator(
          '[data-slot="toast"]:not([data-exiting="true"])',
        );
        while (await activeToasts.count()) {
          const count = await activeToasts.count();
          await activeToasts
            .last()
            .locator('[data-slot="toast-close"]')
            .click();
          await expect(activeToasts).toHaveCount(count - 1);
        }
        const copy = recovery.getByRole("button", {
          name: "Copy codes",
          exact: true,
        });
        const failure = "Could not copy recovery codes";
        for (let attempt = 0; attempt < 2; attempt++) {
          await copy.click();
          await expect(activeToasts).toHaveCount(1);
          await expect(activeToasts).toContainText(failure);
          await expect(
            recovery.getByText(failure, { exact: true }),
          ).toHaveCount(0);
          await expect(recovery.getByRole("alert")).toHaveCount(0);
          await expect(codes.getByRole("listitem")).toHaveCount(10);
          await expect(copy).toBeEnabled();
          await expect(copy).toHaveText("Copy codes");
          await activeToasts.locator('[data-slot="toast-close"]').click();
          await expect(activeToasts).toHaveCount(0);
        }
        await copy.click();
        await expect(copy).toBeDisabled();
        await expect(activeToasts).toHaveCount(0);
        await copy.press("Enter");
        const correctPendingCopy = await page.evaluate(() => {
          const state = (
            window as unknown as {
              recoveryCopyTest: {
                attempts: number;
                text: string;
                release: () => void;
              };
            }
          ).recoveryCopyTest;
          const text =
            Array.from(
              document.querySelectorAll('[aria-label="Recovery codes"] li'),
            )
              .map((element) => element.textContent)
              .join("\n") + "\n";
          const correct = state.attempts === 3 && state.text === text;
          state.release();
          return correct;
        });
        expect(
          correctPendingCopy,
          "One pending copy holds exactly the displayed recovery codes",
        ).toBe(true);
        await expect(activeToasts).toHaveCount(1);
        await expect(activeToasts).toContainText("Recovery codes copied");
        await expect(
          recovery.getByText("Recovery codes copied", { exact: true }),
        ).toHaveCount(0);
        await expect(copy).toBeEnabled();
        await expect(copy).toHaveText("Copy codes");
        await expect(codes.getByRole("listitem")).toHaveCount(10);
        await recovery
          .getByRole("button", { name: "Continue", exact: true })
          .click();
        await expect(recovery).toHaveCount(0);
      } finally {
        await context.close();
      }
    });
  }

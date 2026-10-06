import {
  expect,
  request,
  test,
  type APIRequestContext,
  type Page,
} from "@playwright/test";
import { getBrowserBootstrap } from "../browser-fixture.js";

test.use({ trace: "off", screenshot: "off" });

const password = "Profile-feedback-password-42";
const expiredFeedback = "Your session expired. Sign in again to continue.";

function alerts(page: Page) {
  return page.locator('[data-slot="toast"]:not([data-exiting="true"])');
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

async function createAccount(
  admin: APIRequestContext,
  origin: string,
  email: string,
) {
  const invitation = await admin.post("/api/auth/invitations", {
    headers: { Origin: origin },
    data: { email, role: "member" },
  });
  expect(
    invitation.ok(),
    `Fixture invitation returned HTTP ${invitation.status()}`,
  ).toBe(true);
  const account = await request.newContext({ baseURL: origin });
  const accepted = await account.post("/api/auth/accept-invitation", {
    headers: { Origin: origin },
    data: {
      token: (await invitation.json()).token,
      name: "Profile feedback review",
      password,
    },
  });
  expect(
    accepted.ok(),
    `Fixture invitation acceptance returned HTTP ${accepted.status()}`,
  ).toBe(true);
  return account;
}

async function expire(page: Page, origin: string) {
  const logout = await page.request.post("/api/auth/logout", {
    headers: { Origin: origin },
    data: {},
  });
  expect(logout.ok()).toBe(true);
  await page.evaluate(() => window.dispatchEvent(new Event("mill:expired")));
  await expect(
    page.getByRole("heading", { name: "Sign in", exact: true }),
  ).toBeVisible();
  await expect(alerts(page)).toHaveCount(1);
  await expect(alerts(page)).toContainText(expiredFeedback);
  await clearAlerts(page);
}

async function signIn(page: Page, email: string, heading: string) {
  await page.getByLabel("Email", { exact: true }).fill(email);
  await page.getByLabel("Password", { exact: true }).fill(password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: heading, exact: true }),
  ).toBeVisible();
}

async function releaseOldOperation(page: Page) {
  await page.evaluate(async () => {
    (
      window as unknown as { profileSuspensionTest: { release: () => void } }
    ).profileSuspensionTest.release();
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  });
}

for (const [width, theme] of [
  [1280, "light"],
  [390, "dark"],
] as const) {
  for (const lateOutcome of ["success", "failure"] as const) {
    test(`profile save ignores late ${lateOutcome} after expiry and preserves its draft at ${width}px in ${theme}`, async ({
      browser,
      baseURL,
    }) => {
      const fixture = await getBrowserBootstrap(baseURL!);
      const email = `profile-suspension-${width}-${lateOutcome}@example.test`;
      const account = await createAccount(fixture.api, fixture.origin, email);
      const context = await browser.newContext({
        baseURL: fixture.origin,
        storageState: await account.storageState(),
        viewport: { width, height: 900 },
        isMobile: width === 390,
        hasTouch: width === 390,
      });
      await account.dispose();
      await fixture.api.dispose();
      const failure = "Profile save unavailable. Retry your name change.";
      try {
        await context.addInitScript(
          ({ appearance, outcome, currentError }) => {
            localStorage.setItem("avgeek-oss-ui-theme", appearance);
            const state = { calls: 0, reads: 0, release: () => {} };
            Object.defineProperty(window, "profileSuspensionTest", {
              value: state,
            });
            const nativeFetch = window.fetch.bind(window);
            window.fetch = async (...args: Parameters<typeof fetch>) => {
              const [input, options] = args;
              const url =
                typeof input === "string"
                  ? input
                  : input instanceof URL
                    ? input.href
                    : input.url;
              if (url.endsWith("/api/auth/me")) state.reads++;
              if (
                !url.endsWith("/api/auth/profile") ||
                options?.method !== "PATCH"
              )
                return nativeFetch(...args);
              state.calls++;
              if (state.calls === 1)
                return new Promise<Response>((resolve) => {
                  state.release = () =>
                    resolve(
                      outcome === "success"
                        ? Response.json({ ok: true })
                        : Response.json(
                            { error: "The old profile save failed." },
                            { status: 503 },
                          ),
                    );
                });
              if (state.calls <= 3)
                return Response.json({ error: currentError }, { status: 503 });
              return nativeFetch(...args);
            };
          },
          { appearance: theme, outcome: lateOutcome, currentError: failure },
        );
        const page = await context.newPage();
        await page.goto("/settings/profile");
        const name = page.getByLabel("Your Name", { exact: true });
        const save = page.getByRole("button", { name: "Save", exact: true });
        const draft = `Retained profile ${width} ${lateOutcome}`;
        await name.fill(draft);
        await save.click();
        await expect(
          page.getByRole("button", { name: "Saving…", exact: true }),
        ).toBeDisabled();
        await expect
          .poll(() =>
            page.evaluate(
              () =>
                (
                  window as unknown as {
                    profileSuspensionTest: { calls: number };
                  }
                ).profileSuspensionTest.calls,
            ),
          )
          .toBe(1);
        await expire(page, fixture.origin);
        await signIn(page, email, "Profile");
        await expect(name).toHaveValue(draft);
        await expect(name).toBeEnabled();
        await expect(save).toBeEnabled();
        const readsBeforeOldReceipt = await page.evaluate(
          () =>
            (window as unknown as { profileSuspensionTest: { reads: number } })
              .profileSuspensionTest.reads,
        );
        await releaseOldOperation(page);
        await expect(alerts(page)).toHaveCount(0);
        await expect(page).toHaveURL(/\/settings\/profile$/);
        await expect(name).toHaveValue(draft);
        expect(
          await page.evaluate(
            () =>
              (
                window as unknown as {
                  profileSuspensionTest: { reads: number };
                }
              ).profileSuspensionTest.reads,
          ),
        ).toBe(readsBeforeOldReceipt);
        for (let attempt = 0; attempt < 2; attempt++) {
          await save.click();
          await expect(alerts(page)).toHaveCount(1);
          await expect(alerts(page)).toContainText(failure);
          await expect(
            page.getByRole("main").getByText(failure, { exact: true }),
          ).toHaveCount(0);
          await expect(name).toHaveValue(draft);
          await expect(name).toBeEnabled();
          await expect(save).toBeEnabled();
          await clearAlerts(page);
        }
        await save.click();
        await expect(alerts(page)).toHaveCount(1);
        await expect(alerts(page)).toContainText("Changes saved");
        await expect(name).toHaveValue(draft);
        await expect(save).toBeDisabled();
        const me = await page.request.get("/api/auth/me");
        expect(me.ok()).toBe(true);
        expect((await me.json()).user.name).toBe(draft);
        expect(
          await page.evaluate(
            () =>
              (
                window as unknown as {
                  profileSuspensionTest: { calls: number };
                }
              ).profileSuspensionTest.calls,
          ),
        ).toBe(4);
      } finally {
        await context.close();
      }
    });
  }
}

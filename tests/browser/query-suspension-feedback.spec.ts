import { expect, request, test, type Page } from "@playwright/test";
import { getBrowserBootstrap } from "../browser-fixture.js";

test.use({ trace: "off", screenshot: "off" });

const password = "Query-suspension-password-42";
const expiredFeedback = "Your session expired. Sign in again to continue.";
const activeFailure = "The current sessions read failed. Try again.";

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
}

async function signIn(page: Page, email: string) {
  await page.getByLabel("Email", { exact: true }).fill(email);
  await page.getByLabel("Password", { exact: true }).fill(password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Sessions", exact: true }),
  ).toBeVisible();
}

async function releaseOldRead(page: Page) {
  await page.evaluate(async () => {
    const state = (
      window as unknown as {
        querySuspensionTest: { release: () => void; probe: Promise<void> };
      }
    ).querySuspensionTest;
    state.release();
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    await state.probe;
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  });
}

for (const [width, theme] of [
  [1280, "light"],
  [390, "dark"],
] as const)
  for (const releaseAt of ["expired", "resumed"] as const) {
    test(`old sessions read failure released while ${releaseAt} stays silent and active retries toast at ${width}px in ${theme}`, async ({
      browser,
      baseURL,
    }) => {
      const fixture = await getBrowserBootstrap(baseURL!);
      const email = `query-suspension-${width}-${theme}-${releaseAt}@example.test`;
      const invitation = await fixture.api.post("/api/auth/invitations", {
        headers: { Origin: fixture.origin },
        data: { email, role: "member" },
      });
      expect(invitation.ok()).toBe(true);
      const account = await request.newContext({ baseURL: fixture.origin });
      const accepted = await account.post("/api/auth/accept-invitation", {
        headers: { Origin: fixture.origin },
        data: {
          token: (await invitation.json()).token,
          name: "Query suspension review",
          password,
        },
      });
      expect(accepted.ok()).toBe(true);
      const initialSessions = await account.get("/api/auth/sessions");
      expect(initialSessions.ok()).toBe(true);
      const initial = (await initialSessions.json()).items.find(
        (item: { current: boolean }) => item.current,
      );
      expect(typeof initial.id).toBe("string");
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
        await context.addInitScript(
          ({ appearance, lateRelease, currentFailure }) => {
            localStorage.setItem("avgeek-oss-ui-theme", appearance);
            const state = {
              reads: 0,
              aborts: 0,
              release: () => {},
              trackProbe: false,
              probe: Promise.resolve(),
            };
            Object.defineProperty(window, "querySuspensionTest", {
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
              if (url.endsWith("/api/auth/me") && state.trackProbe) {
                state.trackProbe = false;
                const probe = nativeFetch(...args);
                state.probe = probe.then(() => {});
                return probe;
              }
              if (!url.endsWith("/api/auth/sessions"))
                return nativeFetch(...args);
              state.reads++;
              if (state.reads === 2) {
                options?.signal?.addEventListener(
                  "abort",
                  () => {
                    state.aborts++;
                  },
                  { once: true },
                );
                // Deliver a completed read after its caller has aborted it.
                return new Promise<Response>((resolve) => {
                  state.release = () => {
                    state.trackProbe = lateRelease === "expired";
                    resolve(
                      lateRelease === "expired"
                        ? Response.json(
                            { error: "This old sessions request expired." },
                            { status: 401 },
                          )
                        : new Response("{incomplete", {
                            status: 200,
                            headers: { "Content-Type": "application/json" },
                          }),
                    );
                  };
                });
              }
              if (state.reads === 3 || state.reads === 4)
                return Response.json(
                  { error: currentFailure },
                  { status: 503 },
                );
              return nativeFetch(...args);
            };
          },
          {
            appearance: theme,
            lateRelease: releaseAt,
            currentFailure: activeFailure,
          },
        );
        const page = await context.newPage();
        const grid = page.getByRole("grid", { name: "Sessions", exact: true });
        await page.goto("/settings/sessions");
        await expect(grid).toContainText(initial.id);
        await expire(page, fixture.origin);
        await clearAlerts(page);
        await signIn(page, email);
        await expect
          .poll(() =>
            page.evaluate(
              () =>
                (
                  window as unknown as {
                    querySuspensionTest: { reads: number };
                  }
                ).querySuspensionTest.reads,
            ),
          )
          .toBe(2);
        await expect(grid).toContainText(initial.id);
        await expect(
          page.getByRole("region", { name: "Sessions", exact: true }),
        ).toHaveAttribute("aria-busy", "true");
        await expire(page, fixture.origin);
        await expect
          .poll(() =>
            page.evaluate(
              () =>
                (
                  window as unknown as {
                    querySuspensionTest: { aborts: number };
                  }
                ).querySuspensionTest.aborts,
            ),
          )
          .toBe(1);
        if (releaseAt === "expired") {
          await releaseOldRead(page);
          await expect(alerts(page)).toHaveCount(1);
          await expect(alerts(page)).toContainText(expiredFeedback);
          await expect(
            alerts(page).filter({
              hasText: "This old sessions request expired.",
            }),
          ).toHaveCount(0);
        }
        await clearAlerts(page);
        await signIn(page, email);
        await expect(alerts(page)).toHaveCount(1);
        await expect(alerts(page)).toContainText(activeFailure);
        await expect(
          page.getByRole("main").getByText(activeFailure, { exact: true }),
        ).toHaveCount(0);
        await expect(grid).toContainText(initial.id);
        await expect(
          page.getByRole("button", { name: "Retry", exact: true }),
        ).toBeEnabled();
        await clearAlerts(page);
        if (releaseAt === "resumed") {
          await releaseOldRead(page);
          await expect(alerts(page)).toHaveCount(0);
          await expect(
            page.getByRole("button", { name: "Retry", exact: true }),
          ).toBeEnabled();
          await expect(grid).toContainText(initial.id);
        }
        await page.getByRole("button", { name: "Retry", exact: true }).click();
        await expect(alerts(page)).toHaveCount(1);
        await expect(alerts(page)).toContainText(activeFailure);
        await expect(grid).toContainText(initial.id);
        await expect(
          page.getByRole("button", { name: "Retry", exact: true }),
        ).toBeEnabled();
        await clearAlerts(page);
        await page.getByRole("button", { name: "Retry", exact: true }).click();
        const refreshed = await page.request.get("/api/auth/sessions");
        expect(refreshed.ok()).toBe(true);
        const current = (await refreshed.json()).items.find(
          (item: { current: boolean }) => item.current,
        );
        expect(current.id).not.toBe(initial.id);
        await expect(grid).toContainText(current.id);
        await expect(grid).not.toContainText(initial.id);
        await expect(
          page.getByRole("button", { name: "Retry", exact: true }),
        ).toHaveCount(0);
        await expect(alerts(page)).toHaveCount(0);
        await expect(
          page.getByRole("region", { name: "Sessions", exact: true }),
        ).toHaveAttribute("aria-busy", "false");
        await expect
          .poll(() =>
            page.evaluate(
              () =>
                (
                  window as unknown as {
                    querySuspensionTest: { reads: number };
                  }
                ).querySuspensionTest.reads,
            ),
          )
          .toBe(5);
      } finally {
        await context.close();
      }
    });
  }

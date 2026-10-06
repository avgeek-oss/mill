import {
  expect,
  request,
  test,
  type APIRequestContext,
  type Page,
} from "@playwright/test";
import { getBrowserBootstrap } from "../browser-fixture.js";

test.use({ trace: "off", screenshot: "off" });

const password = "Direct-feedback-password-42";
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
  expect(invitation.ok()).toBe(true);
  const account = await request.newContext({ baseURL: origin });
  const accepted = await account.post("/api/auth/accept-invitation", {
    headers: { Origin: origin },
    data: {
      token: (await invitation.json()).token,
      name: "Direct feedback review",
      password,
    },
  });
  expect(accepted.ok()).toBe(true);
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
      window as unknown as { directSuspensionTest: { release: () => void } }
    ).directSuspensionTest.release();
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  });
}

for (const [width, theme] of [
  [1280, "light"],
  [390, "dark"],
] as const) {
  for (const lateOutcome of ["success", "failure"] as const) {
    test(`board settings ignores late ${lateOutcome} after expiry and preserves retries at ${width}px in ${theme}`, async ({
      browser,
      baseURL,
    }) => {
      const fixture = await getBrowserBootstrap(baseURL!);
      const email = `settings-direct-${width}-${lateOutcome}@example.test`;
      const account = await createAccount(fixture.api, fixture.origin, email);
      const title = `Settings lifecycle ${width} ${lateOutcome}`;
      const created = await account.post("/api/boards", {
        headers: { Origin: fixture.origin },
        data: { name: title },
      });
      expect(created.ok()).toBe(true);
      const boardId = (await created.json()).board.id as string;
      const context = await browser.newContext({
        baseURL: fixture.origin,
        storageState: await account.storageState(),
        viewport: { width, height: 900 },
        isMobile: width === 390,
        hasTouch: width === 390,
      });
      await account.dispose();
      await fixture.api.dispose();
      const failure = "Board settings unavailable. Retry your changes.";
      try {
        await context.addInitScript(
          ({ appearance, id, outcome, currentError }) => {
            localStorage.setItem("avgeek-oss-ui-theme", appearance);
            const state = { calls: 0, release: () => {} };
            Object.defineProperty(window, "directSuspensionTest", {
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
              if (
                !url.endsWith(`/api/boards/${id}`) ||
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
                            { error: "The old board settings save failed." },
                            { status: 503 },
                          ),
                    );
                });
              if (state.calls <= 3)
                return Response.json({ error: currentError }, { status: 503 });
              return nativeFetch(...args);
            };
          },
          {
            appearance: theme,
            id: boardId,
            outcome: lateOutcome,
            currentError: failure,
          },
        );
        const page = await context.newPage();
        await page.goto(`/boards/${boardId}`);
        await page
          .getByRole("button", { name: "Board actions", exact: true })
          .click();
        await page
          .getByRole("menuitem", { name: "Board settings", exact: true })
          .click();
        const dialog = page.getByRole("dialog", {
          name: "Board settings",
          exact: true,
        });
        const draft = `Retained settings ${width} ${lateOutcome}`;
        await dialog.getByLabel("Board name", { exact: true }).fill(draft);
        await dialog
          .getByLabel("Description", { exact: true })
          .fill("Keep this board settings draft.");
        await dialog
          .getByRole("button", { name: "Save board", exact: true })
          .click();
        await expect
          .poll(() =>
            page.evaluate(
              () =>
                (
                  window as unknown as {
                    directSuspensionTest: { calls: number };
                  }
                ).directSuspensionTest.calls,
            ),
          )
          .toBe(1);
        await expire(page, fixture.origin);
        await expect(dialog).toHaveCount(0);
        await signIn(page, email, title);
        await expect(dialog).toBeVisible();
        await expect(
          dialog.getByLabel("Board name", { exact: true }),
        ).toHaveValue(draft);
        await expect(
          dialog.getByLabel("Description", { exact: true }),
        ).toHaveValue("Keep this board settings draft.");
        await expect(
          dialog.getByRole("button", { name: "Save board", exact: true }),
        ).toBeEnabled();
        await releaseOldOperation(page);
        await expect(alerts(page)).toHaveCount(0);
        await expect(page).toHaveURL(new RegExp(`/boards/${boardId}$`));
        await expect(
          page.getByRole("heading", { name: title, exact: true }),
        ).toBeVisible();
        await expect(
          dialog.getByLabel("Board name", { exact: true }),
        ).toHaveValue(draft);
        for (let attempt = 0; attempt < 2; attempt++) {
          await dialog
            .getByRole("button", { name: "Save board", exact: true })
            .click();
          await expect(alerts(page)).toHaveCount(1);
          await expect(alerts(page)).toContainText(failure);
          await expect(dialog.getByText(failure, { exact: true })).toHaveCount(
            0,
          );
          await expect(
            dialog.getByLabel("Board name", { exact: true }),
          ).toHaveValue(draft);
          await expect(
            dialog.getByRole("button", { name: "Save board", exact: true }),
          ).toBeEnabled();
          await clearAlerts(page);
        }
        await dialog
          .getByRole("button", { name: "Save board", exact: true })
          .click();
        await expect(alerts(page)).toHaveCount(1);
        await expect(alerts(page)).toContainText("Board updated.");
        await expect(
          page.getByRole("heading", { name: draft, exact: true }),
        ).toBeVisible();
        expect(
          await page.evaluate(
            () =>
              (window as unknown as { directSuspensionTest: { calls: number } })
                .directSuspensionTest.calls,
          ),
        ).toBe(4);
      } finally {
        await context.close();
      }
    });

    test(`task clipboard ignores late ${lateOutcome} after expiry and reports current retries at ${width}px in ${theme}`, async ({
      browser,
      baseURL,
    }) => {
      const fixture = await getBrowserBootstrap(baseURL!);
      const email = `clipboard-direct-${width}-${lateOutcome}@example.test`;
      const account = await createAccount(fixture.api, fixture.origin, email);
      const created = await account.post("/api/boards", {
        headers: { Origin: fixture.origin },
        data: { name: `Clipboard lifecycle ${width} ${lateOutcome}` },
      });
      expect(created.ok()).toBe(true);
      const boardId = (await created.json()).board.id as string;
      const title = `Clipboard task ${width} ${lateOutcome}`;
      const task = await account.post(`/api/boards/${boardId}/tasks`, {
        headers: { Origin: fixture.origin },
        data: { title },
      });
      expect(task.ok()).toBe(true);
      const taskId = (await task.json()).task.id as string;
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
          ({ appearance, outcome }) => {
            localStorage.setItem("avgeek-oss-ui-theme", appearance);
            const state = {
              calls: 0,
              release: () => {},
              texts: [] as string[],
            };
            Object.defineProperty(window, "directSuspensionTest", {
              value: state,
            });
            Object.defineProperty(navigator, "clipboard", {
              configurable: true,
              value: {
                writeText: (text: string) => {
                  state.calls++;
                  state.texts.push(text);
                  if (state.calls === 1)
                    return new Promise<void>((resolve, reject) => {
                      state.release = () =>
                        outcome === "success"
                          ? resolve()
                          : reject(
                              new Error("The old clipboard attempt failed."),
                            );
                    });
                  if (state.calls <= 3)
                    return Promise.reject(new Error("Clipboard unavailable."));
                  return Promise.resolve();
                },
              },
            });
          },
          { appearance: theme, outcome: lateOutcome },
        );
        const page = await context.newPage();
        const taskPath = `/boards/${boardId}/tasks/${taskId}`;
        await page.goto(taskPath);
        const copy = async () => {
          await page
            .getByRole("button", { name: "Task actions", exact: true })
            .click();
          await page
            .getByRole("menuitem", { name: "Copy link", exact: true })
            .click();
        };
        await copy();
        await expect
          .poll(() =>
            page.evaluate(
              () =>
                (
                  window as unknown as {
                    directSuspensionTest: { calls: number };
                  }
                ).directSuspensionTest.calls,
            ),
          )
          .toBe(1);
        await expire(page, fixture.origin);
        await signIn(page, email, title);
        await releaseOldOperation(page);
        await expect(alerts(page)).toHaveCount(0);
        await expect(page).toHaveURL(`${fixture.origin}${taskPath}`);
        for (let attempt = 0; attempt < 2; attempt++) {
          await copy();
          await expect(alerts(page)).toHaveCount(1);
          await expect(alerts(page)).toContainText(
            "Copy the task link from your address bar.",
          );
          await expect(
            page
              .getByRole("main")
              .getByText("Copy the task link from your address bar.", {
                exact: true,
              }),
          ).toHaveCount(0);
          await clearAlerts(page);
        }
        await copy();
        await expect(alerts(page)).toHaveCount(1);
        await expect(alerts(page)).toContainText("Link copied.");
        expect(
          await page.evaluate(
            () =>
              (
                window as unknown as {
                  directSuspensionTest: { texts: string[] };
                }
              ).directSuspensionTest.texts,
          ),
        ).toEqual(Array(4).fill(`${fixture.origin}${taskPath}`));
      } finally {
        await context.close();
      }
    });
  }
}

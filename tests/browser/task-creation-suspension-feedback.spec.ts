import {
  expect,
  request,
  test,
  type APIRequestContext,
  type Page,
} from "@playwright/test";
import { getBrowserBootstrap } from "../browser-fixture.js";

test.use({ trace: "off", screenshot: "off" });

const password = "Task-creation-feedback-password-42";
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
      name: "Task creation review",
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
      window as unknown as {
        taskCreationSuspensionTest: { release: () => void };
      }
    ).taskCreationSuspensionTest.release();
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  });
}

for (const [width, theme] of [
  [1280, "light"],
  [390, "dark"],
] as const) {
  for (const mode of ["new", "duplicate"] as const) {
    for (const lateOutcome of ["success", "failure"] as const) {
      test(`${mode} task retains its draft and ignores late ${lateOutcome} across expiry at ${width}px in ${theme}`, async ({
        browser,
        baseURL,
      }) => {
        const fixture = await getBrowserBootstrap(baseURL!);
        const email = `task-creation-${mode}-${lateOutcome}-${width}@example.test`;
        const account = await createAccount(fixture.api, fixture.origin, email);
        const boardTitle = `Creation lifecycle ${mode} ${lateOutcome} ${width}`;
        const board = await account.post("/api/boards", {
          headers: { Origin: fixture.origin },
          data: { name: boardTitle },
        });
        expect(board.ok()).toBe(true);
        const boardId = (await board.json()).board.id as string;
        const sourceTitle = `Original ${mode} ${lateOutcome} ${width}`;
        const sourceDescription =
          "Retain this source description through expiry.";
        const created = await account.post(`/api/boards/${boardId}/tasks`, {
          headers: { Origin: fixture.origin },
          data: {
            title: sourceTitle,
            description: sourceDescription,
            type: "bug",
            priority: "high",
            status: "in_progress",
          },
        });
        expect(created.ok()).toBe(true);
        const receipt = await created.json();
        const sourceId = receipt.task.id as string;
        const context = await browser.newContext({
          baseURL: fixture.origin,
          storageState: await account.storageState(),
          viewport: { width, height: 900 },
          isMobile: width === 390,
          hasTouch: width === 390,
        });
        await account.dispose();
        await fixture.api.dispose();
        const failure = "Task creation unavailable. Retry your draft.";
        try {
          await context.addInitScript(
            ({ appearance, id, outcome, oldReceipt, currentError }) => {
              localStorage.setItem("avgeek-oss-ui-theme", appearance);
              const state = {
                calls: 0,
                aborts: 0,
                release: () => {},
                key: "",
                payload: "",
                retainedRequest: true,
              };
              Object.defineProperty(window, "taskCreationSuspensionTest", {
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
                  !url.endsWith(`/api/boards/${id}/tasks`) ||
                  options?.method !== "POST"
                )
                  return nativeFetch(...args);
                state.calls++;
                const key =
                  new Headers(options.headers).get("Idempotency-Key") ?? "";
                const payload = String(options.body);
                if (state.calls === 1) {
                  state.key = key;
                  state.payload = payload;
                  options.signal?.addEventListener(
                    "abort",
                    () => {
                      state.aborts++;
                    },
                    { once: true },
                  );
                  return new Promise<Response>((resolve) => {
                    state.release = () =>
                      resolve(
                        outcome === "success"
                          ? Response.json(oldReceipt)
                          : Response.json(
                              { error: "The old task create failed." },
                              { status: 503 },
                            ),
                      );
                  });
                }
                state.retainedRequest &&=
                  key.length > 0 &&
                  key === state.key &&
                  payload === state.payload;
                if (state.calls <= 3)
                  return Response.json(
                    { error: currentError },
                    { status: 503 },
                  );
                return nativeFetch(...args);
              };
            },
            {
              appearance: theme,
              id: boardId,
              outcome: lateOutcome,
              oldReceipt: receipt,
              currentError: failure,
            },
          );
          const page = await context.newPage();
          const originalPath =
            mode === "new"
              ? `/boards/${boardId}`
              : `/boards/${boardId}/tasks/${sourceId}`;
          await page.goto(originalPath);
          if (mode === "new") {
            await page
              .getByRole("button", { name: "New task", exact: true })
              .click();
          } else {
            await page
              .getByRole("button", { name: "Task actions", exact: true })
              .click();
            await page
              .getByRole("menuitem", { name: "Duplicate task", exact: true })
              .click();
          }
          const dialog = page.getByRole("dialog", {
            name: mode === "new" ? "New task" : "Duplicate task",
            exact: true,
          });
          const draft =
            mode === "new"
              ? `Retained new task ${width} ${lateOutcome}`
              : `[Copy] ${sourceTitle}`;
          const description =
            mode === "new"
              ? "Retain this new task description through expiry."
              : sourceDescription;
          if (mode === "new") {
            await dialog.getByLabel("Title", { exact: true }).fill(draft);
            await dialog
              .getByLabel("Description", { exact: true })
              .fill(description);
          }
          const expectDraft = async () => {
            await expect(
              dialog.getByLabel("Title", { exact: true }),
            ).toHaveValue(draft);
            await expect(
              dialog.getByLabel("Description", { exact: true }),
            ).toHaveValue(description);
            await expect(
              dialog.getByRole("button", { name: /Type$/ }),
            ).toContainText(mode === "new" ? "Task" : "Bug");
            if (mode === "duplicate") {
              await expect(
                dialog.getByRole("button", { name: /Priority$/ }),
              ).toContainText("High");
              await expect(
                dialog.getByRole("button", { name: /Status$/ }),
              ).toContainText("Backlog");
            }
          };
          const submit = dialog.getByRole("button", {
            name: "Create task",
            exact: true,
          });
          await expectDraft();
          await submit.click();
          await expect(submit).toBeDisabled();
          await expect
            .poll(() =>
              page.evaluate(
                () =>
                  (
                    window as unknown as {
                      taskCreationSuspensionTest: { calls: number };
                    }
                  ).taskCreationSuspensionTest.calls,
              ),
            )
            .toBe(1);
          await expire(page, fixture.origin);
          await expect
            .poll(() =>
              page.evaluate(
                () =>
                  (
                    window as unknown as {
                      taskCreationSuspensionTest: { aborts: number };
                    }
                  ).taskCreationSuspensionTest.aborts,
              ),
            )
            .toBe(1);
          await signIn(page, email, mode === "new" ? boardTitle : sourceTitle);
          await expect(dialog).toBeVisible();
          await expectDraft();
          await expect(submit).toBeEnabled();
          await expect(
            dialog.getByLabel("Title", { exact: true }),
          ).toBeEnabled();
          for (let attempt = 0; attempt < 2; attempt++) {
            await submit.click();
            await expect(alerts(page)).toHaveCount(1);
            await expect(alerts(page)).toContainText(failure);
            await expect(
              dialog.getByText(failure, { exact: true }),
            ).toHaveCount(0);
            await expectDraft();
            await expect(submit).toBeEnabled();
            await clearAlerts(page);
            if (attempt === 0) {
              await releaseOldOperation(page);
              await expect(alerts(page)).toHaveCount(0);
              await expect(dialog).toBeVisible();
              await expectDraft();
              await expect(page).toHaveURL(`${fixture.origin}${originalPath}`);
            }
          }
          await submit.click();
          await expect(dialog).toHaveCount(0);
          await expect(alerts(page)).toHaveCount(1);
          await expect(alerts(page)).toContainText("Task created.");
          await expect(
            page.getByRole("heading", { name: draft, exact: true }),
          ).toBeVisible();
          await expect(page).toHaveURL(
            new RegExp(`/boards/${boardId}/tasks/[a-f0-9-]+$`),
          );
          const state = await page.evaluate(() => {
            const state = (
              window as unknown as {
                taskCreationSuspensionTest: {
                  calls: number;
                  retainedRequest: boolean;
                };
              }
            ).taskCreationSuspensionTest;
            return {
              calls: state.calls,
              retainedRequest: state.retainedRequest,
            };
          });
          expect(state).toEqual({ calls: 4, retainedRequest: true });
        } finally {
          await context.close();
        }
      });
    }
  }
}

import {
  expect,
  request,
  test,
  type APIRequestContext,
  type Page,
} from "@playwright/test";
import { getBrowserBootstrap } from "../browser-fixture.js";

test.use({ trace: "off", screenshot: "off" });

const password = "Board-suspension-password-42";
const expiredFeedback = "Your session expired. Sign in again to continue.";
const currentFailure = "Board creation is temporarily unavailable. Try again.";

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
      name: "Board suspension review",
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
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (
            window as unknown as {
              boardSuspensionTest: { aborts: number };
            }
          ).boardSuspensionTest.aborts,
      ),
    )
    .toBe(1);
  await clearAlerts(page);
}

async function signIn(page: Page, email: string) {
  await page.getByLabel("Email", { exact: true }).fill(email);
  await page.getByLabel("Password", { exact: true }).fill(password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Boards", exact: true }),
  ).toBeVisible();
}

async function signOutFromMenu(page: Page) {
  await expect(
    page.getByRole("heading", { name: "Boards", exact: true }),
  ).toBeVisible();
  const toggle = page.getByRole("button", {
    name: "Toggle navigation",
    exact: true,
  });
  await expect(toggle).toBeVisible();
  if ((await toggle.getAttribute("aria-expanded")) !== "true")
    await toggle.click();
  await expect(toggle).toHaveAttribute("aria-expanded", "true");
  const trigger = page.getByRole("button", { name: /^Account menu for / });
  await expect(trigger).toBeVisible();
  await trigger.click();
  await page.getByRole("menuitem", { name: "Sign out", exact: true }).click();
}

async function releaseOldOperation(page: Page) {
  await page.evaluate(async () => {
    (
      window as unknown as { boardSuspensionTest: { release: () => void } }
    ).boardSuspensionTest.release();
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  });
}

for (const [width, theme] of [
  [1280, "light"],
  [390, "dark"],
] as const) {
  test(`expired board creation keeps the same owner's draft and retries without stale feedback at ${width}px in ${theme}`, async ({
    browser,
    baseURL,
  }) => {
    const fixture = await getBrowserBootstrap(baseURL!);
    const email = `board-suspension-${width}-${theme}@example.test`;
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
    try {
      await context.addInitScript(
        ({ appearance, failure }) => {
          localStorage.setItem("avgeek-oss-ui-theme", appearance);
          const state = {
            calls: 0,
            aborts: 0,
            release: () => {},
            key: "",
            payload: "",
            preservedRequest: true,
          };
          Object.defineProperty(window, "boardSuspensionTest", {
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
            if (!url.endsWith("/api/boards") || options?.method !== "POST")
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
              // Return the response even after the initiating request was canceled.
              return new Promise<Response>((resolve) => {
                state.release = () =>
                  resolve(
                    Response.json(
                      { error: "The old board request failed." },
                      { status: 503 },
                    ),
                  );
              });
            }
            state.preservedRequest &&=
              key.length > 0 && key === state.key && payload === state.payload;
            if (state.calls <= 3)
              return Response.json({ error: failure }, { status: 503 });
            return nativeFetch(...args);
          };
        },
        { appearance: theme, failure: currentFailure },
      );
      const page = await context.newPage();
      await page.goto("/boards");
      await page
        .getByRole("button", { name: "Create Board", exact: true })
        .click();
      const dialog = page.getByRole("dialog", {
        name: "Create a board",
        exact: true,
      });
      const draft = `Retained ${theme} board ${width}`;
      const prefix = `B${width}${theme[0].toUpperCase()}`;
      await dialog.getByLabel("Board name", { exact: true }).fill(draft);
      await dialog
        .getByLabel("Description", { exact: true })
        .fill("Keep this description through expiry.");
      await dialog.getByLabel("Task prefix", { exact: true }).fill(prefix);
      await dialog
        .getByRole("button", { name: "Create board", exact: true })
        .click();
      await expect(
        dialog.getByRole("button", { name: "Creating…", exact: true }),
      ).toBeDisabled();
      await expect
        .poll(() =>
          page.evaluate(
            () =>
              (window as unknown as { boardSuspensionTest: { calls: number } })
                .boardSuspensionTest.calls,
          ),
        )
        .toBe(1);
      await expire(page, fixture.origin);
      await signIn(page, email);
      await expect(dialog).toBeVisible();
      await expect(
        dialog.getByLabel("Board name", { exact: true }),
      ).toHaveValue(draft);
      await expect(
        dialog.getByLabel("Description", { exact: true }),
      ).toHaveValue("Keep this description through expiry.");
      await expect(
        dialog.getByLabel("Task prefix", { exact: true }),
      ).toHaveValue(prefix);
      await expect(
        dialog.getByRole("button", { name: "Create board", exact: true }),
      ).toBeEnabled();
      await releaseOldOperation(page);
      await expect(alerts(page)).toHaveCount(0);
      await expect(page).toHaveURL(/\/boards$/);
      await expect(
        dialog.getByLabel("Board name", { exact: true }),
      ).toHaveValue(draft);
      for (let attempt = 0; attempt < 2; attempt++) {
        await dialog
          .getByRole("button", { name: "Create board", exact: true })
          .click();
        await expect(alerts(page)).toHaveCount(1);
        await expect(alerts(page)).toContainText(currentFailure);
        await expect(
          dialog.getByText(currentFailure, { exact: true }),
        ).toHaveCount(0);
        await expect(
          dialog.getByLabel("Board name", { exact: true }),
        ).toHaveValue(draft);
        await expect(
          dialog.getByRole("button", { name: "Create board", exact: true }),
        ).toBeEnabled();
        await clearAlerts(page);
      }
      await dialog
        .getByRole("button", { name: "Create board", exact: true })
        .click();
      await expect(dialog).toHaveCount(0);
      await expect(page).toHaveURL(/\/boards\/[a-f0-9-]+$/);
      await expect(
        page.getByRole("heading", { name: draft, exact: true }),
      ).toBeVisible();
      expect(
        await page.evaluate(
          () =>
            (
              window as unknown as {
                boardSuspensionTest: {
                  preservedRequest: boolean;
                  calls: number;
                };
              }
            ).boardSuspensionTest.preservedRequest,
        ),
      ).toBe(true);
      await expect(
        alerts(page).filter({ hasText: currentFailure }),
      ).toHaveCount(0);
      await expect(
        alerts(page).filter({ hasText: "The old board request failed." }),
      ).toHaveCount(0);
    } finally {
      await context.close();
    }
  });

  test(`switching accounts discards the old board draft and ignores its late receipt at ${width}px in ${theme}`, async ({
    browser,
    baseURL,
  }) => {
    const fixture = await getBrowserBootstrap(baseURL!);
    const oldEmail = `board-old-owner-${width}-${theme}@example.test`;
    const newEmail = `board-new-owner-${width}-${theme}@example.test`;
    const oldAccount = await createAccount(
      fixture.api,
      fixture.origin,
      oldEmail,
    );
    const nextAccount = await createAccount(
      fixture.api,
      fixture.origin,
      newEmail,
    );
    await nextAccount.dispose();
    const oldDraft = `Old owner board ${width} ${theme}`;
    const prefix = `O${width}${theme[0].toUpperCase()}`;
    const created = await oldAccount.post("/api/boards", {
      headers: { Origin: fixture.origin },
      data: {
        name: oldDraft,
        description: "Old owner description",
        prefix,
      },
    });
    expect(created.ok()).toBe(true);
    const receipt = await created.json();
    const context = await browser.newContext({
      baseURL: fixture.origin,
      storageState: await oldAccount.storageState(),
      viewport: { width, height: 900 },
      isMobile: width === 390,
      hasTouch: width === 390,
    });
    await oldAccount.dispose();
    await fixture.api.dispose();
    try {
      await context.addInitScript(
        ({ appearance, oldReceipt }) => {
          localStorage.setItem("avgeek-oss-ui-theme", appearance);
          const state = { calls: 0, aborts: 0, release: () => {} };
          Object.defineProperty(window, "boardSuspensionTest", {
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
            if (!url.endsWith("/api/boards") || options?.method !== "POST")
              return nativeFetch(...args);
            state.calls++;
            options.signal?.addEventListener(
              "abort",
              () => {
                state.aborts++;
              },
              { once: true },
            );
            // A valid receipt must not revive the former owner's create flow.
            return new Promise<Response>((resolve) => {
              state.release = () => resolve(Response.json(oldReceipt));
            });
          };
        },
        { appearance: theme, oldReceipt: receipt },
      );
      const page = await context.newPage();
      await page.goto("/boards");
      await page
        .getByRole("button", { name: "Create Board", exact: true })
        .click();
      const dialog = page.getByRole("dialog", {
        name: "Create a board",
        exact: true,
      });
      await dialog.getByLabel("Board name", { exact: true }).fill(oldDraft);
      await dialog
        .getByLabel("Description", { exact: true })
        .fill("Old owner description");
      await dialog.getByLabel("Task prefix", { exact: true }).fill(prefix);
      await dialog
        .getByRole("button", { name: "Create board", exact: true })
        .click();
      await expect
        .poll(() =>
          page.evaluate(
            () =>
              (window as unknown as { boardSuspensionTest: { calls: number } })
                .boardSuspensionTest.calls,
          ),
        )
        .toBe(1);
      await expire(page, fixture.origin);
      await signIn(page, newEmail);
      await expect(dialog).toHaveCount(0);
      await page
        .getByRole("button", { name: "Create Board", exact: true })
        .click();
      await expect(
        dialog.getByLabel("Board name", { exact: true }),
      ).toHaveValue("");
      await expect(
        dialog.getByLabel("Description", { exact: true }),
      ).toHaveValue("");
      await expect(
        dialog.getByLabel("Task prefix", { exact: true }),
      ).toHaveValue("");
      const newDraft = "A fresh draft for the new owner";
      await dialog.getByLabel("Board name", { exact: true }).fill(newDraft);
      await releaseOldOperation(page);
      await expect(page).toHaveURL(/\/(?:boards)?$/);
      await expect(dialog).toBeVisible();
      await expect(
        dialog.getByLabel("Board name", { exact: true }),
      ).toHaveValue(newDraft);
      await expect(
        dialog.getByRole("button", { name: "Create board", exact: true }),
      ).toBeEnabled();
      await expect(alerts(page)).toHaveCount(0);
      expect(
        await page.evaluate(
          () =>
            (window as unknown as { boardSuspensionTest: { calls: number } })
              .boardSuspensionTest.calls,
        ),
      ).toBe(1);
    } finally {
      await context.close();
    }
  });
  test(`expired sign-out cannot report stale failure or remove the resumed session at ${width}px in ${theme}`, async ({
    browser,
    baseURL,
  }) => {
    const fixture = await getBrowserBootstrap(baseURL!);
    const email = `logout-suspension-${width}-${theme}@example.test`;
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
    const failure = "Sign out is temporarily unavailable. Try again.";
    try {
      await context.addInitScript(
        ({ appearance, currentError }) => {
          localStorage.setItem("avgeek-oss-ui-theme", appearance);
          const state = { calls: 0, aborts: 0, release: () => {} };
          Object.defineProperty(window, "boardSuspensionTest", {
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
            if (!url.endsWith("/api/auth/logout") || options?.method !== "POST")
              return nativeFetch(...args);
            state.calls++;
            if (state.calls === 1) {
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
                    Response.json(
                      { error: "The old sign-out request failed." },
                      { status: 503 },
                    ),
                  );
              });
            }
            if (state.calls <= 3)
              return Response.json({ error: currentError }, { status: 503 });
            return nativeFetch(...args);
          };
        },
        { appearance: theme, currentError: failure },
      );
      const page = await context.newPage();
      await page.goto("/boards");
      await test.step("Begin the held sign-out through the native account menu", () =>
        signOutFromMenu(page));
      await expect
        .poll(() =>
          page.evaluate(
            () =>
              (window as unknown as { boardSuspensionTest: { calls: number } })
                .boardSuspensionTest.calls,
          ),
        )
        .toBe(1);
      await test.step("Expire the real session and cancel the held request", () =>
        expire(page, fixture.origin));
      await test.step("Sign in again with the same owner", () =>
        signIn(page, email));
      await test.step("Deliver the aborted sign-out failure", () =>
        releaseOldOperation(page));
      await expect(alerts(page)).toHaveCount(0);
      await expect(
        page.getByRole("heading", { name: "Boards", exact: true }),
      ).toBeVisible();
      expect((await page.request.get("/api/auth/me")).ok()).toBe(true);
      for (let attempt = 0; attempt < 2; attempt++) {
        await test.step(`Active sign-out retry ${attempt + 1}`, () =>
          signOutFromMenu(page));
        await expect(alerts(page)).toHaveCount(1);
        await expect(alerts(page)).toContainText(failure);
        await expect(
          page.getByRole("main").getByText(failure, { exact: true }),
        ).toHaveCount(0);
        await expect(
          page.getByRole("heading", { name: "Boards", exact: true }),
        ).toBeVisible();
        expect((await page.request.get("/api/auth/me")).ok()).toBe(true);
        await clearAlerts(page);
      }
      await test.step("Complete a fresh real sign-out", () =>
        signOutFromMenu(page));
      await expect(
        page.getByRole("heading", { name: "Sign in", exact: true }),
      ).toBeVisible();
      expect(
        await page.evaluate(
          () =>
            (window as unknown as { boardSuspensionTest: { calls: number } })
              .boardSuspensionTest.calls,
        ),
      ).toBe(4);
      await expect(
        alerts(page).filter({ hasText: "The old sign-out request failed." }),
      ).toHaveCount(0);
    } finally {
      await context.close();
    }
  });
}

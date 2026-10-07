import {
  expect,
  request,
  test,
  type APIRequestContext,
  type Page,
} from "@playwright/test";
import { getBrowserBootstrap } from "../browser-fixture.js";

test.use({ trace: "off", screenshot: "off" });
const password = "Comment-lifecycle-password-42";
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
      name: "Comment lifecycle review",
      password,
    },
  });
  expect(accepted.ok()).toBe(true);
  return account;
}
async function expireAndReturn(
  page: Page,
  origin: string,
  email: string,
  title: string,
) {
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
  await page.getByLabel("Email", { exact: true }).fill(email);
  await page.getByLabel("Password", { exact: true }).fill(password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: title, exact: true }),
  ).toBeVisible();
}

type MutationTestState = {
  calls: number;
  aborts: number;
  ready: boolean;
  navigationSettled: boolean | null;
  releaseOld: () => void;
  releaseFresh: () => void;
  keys: string[];
  payloads: string[];
  replayed: string | null;
};

for (const [width, theme] of [
  [1280, "light"],
  [390, "dark"],
] as const) {
  for (const lateOutcome of ["success", "failure"] as const) {
    for (const action of ["create", "delete"] as const) {
      test(`comment ${action} cancels ignored transport and retries late ${lateOutcome} at ${width}px in ${theme}`, async ({
        browser,
        baseURL,
      }) => {
        const fixture = await getBrowserBootstrap(baseURL!);
        const email = `comment-${action}-${lateOutcome}-${width}@example.test`;
        const account = await createAccount(fixture.api, fixture.origin, email);
        const board = await account.post("/api/boards", {
          headers: { Origin: fixture.origin },
          data: { name: `Comment lifecycle ${action} ${lateOutcome} ${width}` },
        });
        expect(board.ok()).toBe(true);
        const boardId = (await board.json()).board.id as string;
        const title = `Comment lifecycle task ${action} ${lateOutcome} ${width}`;
        const taskResponse = await account.post(
          `/api/boards/${boardId}/tasks`,
          { headers: { Origin: fixture.origin }, data: { title } },
        );
        expect(taskResponse.ok()).toBe(true);
        const taskId = (await taskResponse.json()).task.id as string;
        const body = `Retained comment ${action} ${lateOutcome} ${width}`;
        let commentId = "";
        if (action === "delete") {
          const seed = await account.post(`/api/tasks/${taskId}/comments`, {
            headers: { Origin: fixture.origin },
            data: { body },
          });
          expect(seed.ok()).toBe(true);
          commentId = (await seed.json()).comment.id;
        }
        const context = await browser.newContext({
          baseURL: fixture.origin,
          storageState: await account.storageState(),
          viewport: { width, height: 900 },
          isMobile: width === 390,
          hasTouch: width === 390,
        });
        await account.dispose();
        await fixture.api.dispose();
        const failure = "The current comment action is unavailable. Retry it.";
        try {
          await context.addInitScript(
            ({
              appearance,
              id,
              target,
              operation,
              outcome,
              currentFailure,
            }) => {
              localStorage.setItem("avgeek-oss-ui-theme", appearance);
              const state: MutationTestState = {
                calls: 0,
                aborts: 0,
                ready: false,
                navigationSettled: null,
                releaseOld: () => {},
                releaseFresh: () => {},
                keys: [],
                payloads: [],
                replayed: null,
              };
              Object.defineProperty(window, "commentSuspensionTest", {
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
                const path =
                  operation === "create"
                    ? `/api/tasks/${id}/comments`
                    : `/api/comments/${target}`;
                const method = operation === "create" ? "POST" : "DELETE";
                if (!url.endsWith(path) || options?.method !== method)
                  return nativeFetch(...args);
                state.calls++;
                state.keys.push(
                  new Headers(options.headers).get("Idempotency-Key") ?? "",
                );
                state.payloads.push(String(options.body));
                if (state.calls === 1) {
                  options.signal?.addEventListener(
                    "abort",
                    () => state.aborts++,
                    { once: true },
                  );
                  const committed = await nativeFetch(input, {
                    ...options,
                    signal: undefined,
                  });
                  if (!committed.ok)
                    throw new Error("Fixture comment action did not commit.");
                  state.ready = true;
                  return new Promise<Response>((resolve) => {
                    state.releaseOld = () =>
                      resolve(
                        outcome === "success"
                          ? committed
                          : Response.json(
                              { error: "The obsolete comment action failed." },
                              { status: 503 },
                            ),
                      );
                  });
                }
                if (state.calls === 2)
                  return new Promise<Response>((resolve) => {
                    state.releaseFresh = () =>
                      resolve(
                        Response.json(
                          { error: currentFailure },
                          { status: 503 },
                        ),
                      );
                  });
                if (state.calls === 3)
                  return Response.json(
                    { error: currentFailure },
                    { status: 503 },
                  );
                const response = await nativeFetch(...args);
                state.replayed = response.headers.get("Idempotency-Replayed");
                return response;
              };
            },
            {
              appearance: theme,
              id: taskId,
              target: commentId,
              operation: action,
              outcome: lateOutcome,
              currentFailure: failure,
            },
          );
          const page = await context.newPage();
          const taskPath = `/boards/${boardId}/tasks/${taskId}`;
          await page.goto(taskPath);
          const draft = page.getByLabel("Add a comment", { exact: true });
          const dialog = page.getByRole("dialog", {
            name: "Delete comment?",
            exact: true,
          });
          if (action === "create") await draft.fill(body);
          else {
            const comment = page.getByRole("article").filter({ hasText: body });
            const remove = comment.getByRole("button", {
              name: /Delete comment by/,
            });
            if (width === 1280) await comment.hover();
            await expect(remove).toBeVisible();
            await expect(remove).toBeEnabled();
            await remove.click();
            await expect(dialog).toBeVisible();
          }
          const submit =
            action === "create"
              ? page.getByRole("button", { name: "Send comment", exact: true })
              : dialog.getByRole("button", {
                  name: "Delete comment",
                  exact: true,
                });
          await submit.click();
          await expect
            .poll(() =>
              page.evaluate(
                () =>
                  (
                    window as unknown as {
                      commentSuspensionTest: MutationTestState;
                    }
                  ).commentSuspensionTest.ready,
              ),
            )
            .toBe(true);
          await page.evaluate(() => {
            const state = (
              window as unknown as { commentSuspensionTest: MutationTestState }
            ).commentSuspensionTest;
            window.dispatchEvent(
              new CustomEvent("mill:before-navigate", {
                cancelable: true,
                detail: {
                  waitUntil: (result: Promise<boolean>) => {
                    void result.then((value) => {
                      state.navigationSettled = value;
                    });
                  },
                },
              }),
            );
          });
          await expireAndReturn(page, fixture.origin, email, title);
          await expect
            .poll(() =>
              page.evaluate(
                () =>
                  (
                    window as unknown as {
                      commentSuspensionTest: MutationTestState;
                    }
                  ).commentSuspensionTest.aborts,
              ),
            )
            .toBe(1);
          await expect
            .poll(() =>
              page.evaluate(
                () =>
                  (
                    window as unknown as {
                      commentSuspensionTest: MutationTestState;
                    }
                  ).commentSuspensionTest.navigationSettled,
              ),
            )
            .toBe(false);
          await expect(submit).toBeEnabled();
          if (action === "create") await expect(draft).toHaveValue(body);
          else await expect(dialog).toBeVisible();
          await submit.click();
          await expect
            .poll(() =>
              page.evaluate(
                () =>
                  (
                    window as unknown as {
                      commentSuspensionTest: MutationTestState;
                    }
                  ).commentSuspensionTest.calls,
              ),
            )
            .toBe(2);
          await expect(submit).toBeDisabled();
          await page.evaluate(async () => {
            (
              window as unknown as { commentSuspensionTest: MutationTestState }
            ).commentSuspensionTest.releaseOld();
            await new Promise<void>((resolve) => setTimeout(resolve, 0));
          });
          await expect(submit).toBeDisabled();
          await expect(alerts(page)).toHaveCount(0);
          await expect(page).toHaveURL(`${fixture.origin}${taskPath}`);
          if (action === "create") await expect(draft).toHaveValue(body);
          else await expect(dialog).toBeVisible();
          await page.evaluate(() =>
            (
              window as unknown as { commentSuspensionTest: MutationTestState }
            ).commentSuspensionTest.releaseFresh(),
          );
          await expect(alerts(page)).toHaveCount(1);
          await expect(alerts(page)).toContainText(failure);
          await expect(submit).toBeEnabled();
          await clearAlerts(page);
          await submit.click();
          await expect(alerts(page)).toHaveCount(1);
          await expect(alerts(page)).toContainText(failure);
          await expect(submit).toBeEnabled();
          await clearAlerts(page);
          await submit.click();
          await expect(alerts(page)).toHaveCount(1);
          await expect(alerts(page)).toContainText(
            action === "create" ? "Comment added." : "Comment deleted.",
          );
          if (action === "create") await expect(draft).toHaveValue("");
          else await expect(dialog).toBeHidden();
          const state = await page.evaluate(() => {
            const value = (
              window as unknown as { commentSuspensionTest: MutationTestState }
            ).commentSuspensionTest;
            return {
              keys: value.keys,
              payloads: value.payloads,
              replayed: value.replayed,
            };
          });
          expect(state.keys[0]).toBeTruthy();
          expect(state.keys).toEqual(Array(4).fill(state.keys[0]));
          expect(state.payloads).toEqual(Array(4).fill(state.payloads[0]));
          expect(state.replayed).toBe("true");
          const comments = await page.request.get(
            `/api/tasks/${taskId}/comments`,
          );
          expect(comments.ok()).toBe(true);
          expect(
            (await comments.json()).items.filter(
              (item: { body: string }) => item.body === body,
            ),
          ).toHaveLength(action === "create" ? 1 : 0);
        } finally {
          await context.close();
        }
      });
    }
  }
}

for (const lateOutcome of ["success", "failure"] as const) {
  test(`comment query ignores late ${lateOutcome} after expiry and retains current rows`, async ({
    browser,
    baseURL,
  }) => {
    const fixture = await getBrowserBootstrap(baseURL!);
    const email = `comment-query-${lateOutcome}@example.test`;
    const account = await createAccount(fixture.api, fixture.origin, email);
    const board = await account.post("/api/boards", {
      headers: { Origin: fixture.origin },
      data: { name: `Query comments ${lateOutcome}` },
    });
    expect(board.ok()).toBe(true);
    const boardId = (await board.json()).board.id as string;
    const title = `Comment query task ${lateOutcome}`;
    const task = await account.post(`/api/boards/${boardId}/tasks`, {
      headers: { Origin: fixture.origin },
      data: { title },
    });
    expect(task.ok()).toBe(true);
    const taskId = (await task.json()).task.id as string;
    const body = "Keep the current server comment";
    const comment = await account.post(`/api/tasks/${taskId}/comments`, {
      headers: { Origin: fixture.origin },
      data: { body },
    });
    expect(comment.ok()).toBe(true);
    const context = await browser.newContext({
      baseURL: fixture.origin,
      storageState: await account.storageState(),
      viewport: { width: 1280, height: 900 },
    });
    await account.dispose();
    await fixture.api.dispose();
    try {
      await context.addInitScript(
        ({ id, outcome }) => {
          const state = { calls: 0, aborts: 0, release: () => {} };
          Object.defineProperty(window, "commentQueryTest", { value: state });
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
              !url.includes(`/api/tasks/${id}/comments?`) ||
              options?.method !== "GET"
            )
              return nativeFetch(...args);
            state.calls++;
            if (state.calls !== 1) return nativeFetch(...args);
            options.signal?.addEventListener("abort", () => state.aborts++, {
              once: true,
            });
            return new Promise<Response>((resolve) => {
              state.release = () =>
                resolve(
                  outcome === "success"
                    ? Response.json({
                        items: [],
                        hasMore: false,
                        nextCursor: null,
                      })
                    : Response.json(
                        { error: "The obsolete comments query failed." },
                        { status: 503 },
                      ),
                );
            });
          };
        },
        { id: taskId, outcome: lateOutcome },
      );
      const page = await context.newPage();
      await page.goto(`/boards/${boardId}/tasks/${taskId}`);
      await expect
        .poll(() =>
          page.evaluate(
            () =>
              (window as unknown as { commentQueryTest: { calls: number } })
                .commentQueryTest.calls,
          ),
        )
        .toBe(1);
      await expireAndReturn(page, fixture.origin, email, title);
      await expect
        .poll(() =>
          page.evaluate(
            () =>
              (window as unknown as { commentQueryTest: { aborts: number } })
                .commentQueryTest.aborts,
          ),
        )
        .toBe(1);
      const row = page.getByRole("article").filter({ hasText: body });
      await expect(row).toBeVisible();
      await page.evaluate(async () => {
        (
          window as unknown as { commentQueryTest: { release: () => void } }
        ).commentQueryTest.release();
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
      });
      await expect(row).toBeVisible();
      await expect(alerts(page)).toHaveCount(0);
      await expect(
        page.getByLabel("Add a comment", { exact: true }),
      ).toBeEnabled();
    } finally {
      await context.close();
    }
  });
}

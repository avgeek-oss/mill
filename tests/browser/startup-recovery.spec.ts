import { randomBytes } from "node:crypto";
import {
  expect,
  test,
  type APIRequestContext,
  type Page,
} from "@playwright/test";

import {
  authenticateBrowserFixture,
  getBrowserBootstrap,
  getBrowserRoleFixture,
} from "../browser-fixture.js";
let origin = "";
let boardId = "";
let sessionCookies: Awaited<
  ReturnType<APIRequestContext["storageState"]>
>["cookies"] = [];

test.beforeAll(async ({ baseURL }) => {
  origin = baseURL!;
  const { api } = await getBrowserBootstrap(origin);
  try {
    const response = await api.post("/api/boards", {
      headers: { Origin: origin },
      data: {
        name: "Recovery verification",
        prefix: `RCV${randomBytes(3).toString("hex").toUpperCase()}`,
      },
    });
    expect(response.ok()).toBeTruthy();
    boardId = (await response.json()).board.id;
    sessionCookies = (await api.storageState()).cookies;
  } finally {
    await api.dispose();
  }
});

async function authenticate(page: Page) {
  await page.context().addCookies(sessionCookies);
  expect((await page.request.get("/api/auth/me")).status()).toBe(200);
}

for (const failure of ["server", "network"] as const) {
  test(`${failure} failure during session lookup shows a working startup retry`, async ({
    page,
  }) => {
    await authenticate(page);
    let failLookup = true;
    await page.route("**/api/auth/me", async (route) => {
      if (!failLookup) return route.continue();
      failLookup = false;
      if (failure === "network") return route.abort("connectionfailed");
      await route.fulfill({
        status: 500,
        contentType: "application/json",
        body: JSON.stringify({ error: "Session lookup temporarily failed." }),
      });
    });
    await page.goto(`/boards/${boardId}`);
    await expect(
      page.getByRole("heading", { name: "Mill could not load" }),
    ).toBeVisible();
    await expect(
      page.getByRole("heading", { name: "Sign in to Mill" }),
    ).toHaveCount(0);

    let resume!: () => void;
    const blocked = new Promise<void>((resolve) => {
      resume = resolve;
    });
    await page.route("**/api/auth/status", async (route) => {
      await blocked;
      await route.continue();
    });
    try {
      await page.getByRole("button", { name: "Try again" }).click();
      await expect(page.getByRole("main")).toHaveAttribute("aria-busy", "true");
      await expect(
        page.getByText("Opening Mill…", { exact: true }),
      ).toHaveCount(0);
      await expect(page.getByRole("button", { name: "Try again" })).toHaveCount(
        0,
      );
    } finally {
      resume();
    }
    await expect(
      page.getByRole("navigation", { name: "Workspace navigation" }),
    ).toBeVisible();
    await expect(
      page.getByRole("heading", { name: "Recovery verification" }),
    ).toBeVisible();
    expect((await page.request.get("/api/auth/me")).status()).toBe(200);
  });
}

test("an unauthenticated session still opens the sign-in form", async ({
  page,
}) => {
  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: "Sign in to Mill" }),
  ).toBeVisible();
  await expect(page.getByLabel("Password", { exact: true })).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Mill could not load" }),
  ).toHaveCount(0);
});

for (const action of ["Reload", "Go to boards"]) {
  test(`a failed page module recovers through ${action}`, async ({ page }) => {
    await authenticate(page);
    let failModule = true;
    await page.route("**/assets/board-*.js", async (route) => {
      if (!failModule) return route.continue();
      failModule = false;
      await route.abort("connectionfailed");
    });
    await page.goto(`/boards/${boardId}`);
    await expect(
      page.getByRole("heading", { name: "Something went wrong" }),
    ).toBeVisible();
    const navigation = page.waitForRequest(
      (request) =>
        request.isNavigationRequest() && request.frame() === page.mainFrame(),
    );
    await page.getByRole("button", { name: action, exact: true }).click();
    await navigation;
    await expect(
      page.getByRole("navigation", { name: "Workspace navigation" }),
    ).toBeVisible();
    await expect(
      page.getByRole("heading", { name: "Something went wrong" }),
    ).toHaveCount(0);
    await expect(page).toHaveURL(/\/boards\/[^/]+$/);
  });
}

test("phone actions and fields retain touch targets and readable input text", async ({
  browser,
}) => {
  const context = await browser.newContext({
    baseURL: origin,
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
  });
  try {
    const page = await context.newPage();
    await authenticate(page);
    await page.goto("/settings/workspace");
    await expect(
      page.getByRole("textbox", { name: "Name", exact: true }),
    ).toBeVisible();
    for (const name of [
      "Open navigation",
      "Open notifications",
      /^Appearance:/,
      "Update",
    ]) {
      const control = page.getByRole("button", {
        name,
        exact: typeof name === "string",
      });
      const bounds = await control.boundingBox();
      expect(bounds).not.toBeNull();
      expect(bounds!.height).toBeGreaterThanOrEqual(44);
      expect(bounds!.width).toBeGreaterThanOrEqual(44);
    }
    const inputSize = await page
      .getByRole("textbox", { name: "Name", exact: true })
      .evaluate((element) =>
        Number.parseFloat(getComputedStyle(element).fontSize),
      );
    expect(inputSize).toBeGreaterThanOrEqual(16);
    await page
      .getByRole("button", { name: "Open navigation", exact: true })
      .click();
    await expect(
      page.getByRole("dialog", { name: "Workspace navigation" }),
    ).toBeVisible();
    const close = page
      .getByRole("dialog", { name: "Workspace navigation" })
      .getByRole("button", { name: "Close navigation", exact: true });
    const bounds = await close.boundingBox();
    expect(bounds!.height).toBeGreaterThanOrEqual(44);
    expect(bounds!.width).toBeGreaterThanOrEqual(44);
  } finally {
    await context.close();
  }
});

test("missing pages have a primary recovery action in both themes and viewport sizes", async ({
  browser,
}, testInfo) => {
  for (const width of [1280, 390]) {
    for (const theme of ["light", "dark"]) {
      const context = await browser.newContext({
        baseURL: origin,
        viewport: { width, height: 844 },
        isMobile: width === 390,
        hasTouch: width === 390,
      });
      try {
        await context.addCookies(sessionCookies);
        await context.addInitScript((value) => {
          localStorage.setItem("mill:theme", value);
        }, theme);
        const page = await context.newPage();
        await page.goto("/missing-review-page");
        const heading = page.getByRole("heading", {
          name: "This page could not be found",
          exact: true,
        });
        await expect(heading).toBeVisible();
        await expect(
          page.getByRole("button", { name: "Reload", exact: true }),
        ).toHaveCount(0);
        const action = page.getByRole("button", {
          name: "Go to boards",
          exact: true,
        });
        expect(
          await heading.evaluate((element) =>
            Number.parseFloat(getComputedStyle(element).fontSize),
          ),
        ).toBe(width === 390 ? 24 : 30);
        expect(
          await page.evaluate(
            () => document.documentElement.scrollWidth <= innerWidth,
          ),
        ).toBe(true);
        if (width === 390) {
          const bounds = await action.boundingBox();
          expect(bounds!.height).toBeGreaterThanOrEqual(44);
        }
        await page.screenshot({
          path: testInfo.outputPath(`missing-${width}-${theme}.png`),
        });
        await action.focus();
        await page.keyboard.press("Enter");
        await expect(page).toHaveURL(/\/boards\/[^/]+$/);
        await expect(heading).toHaveCount(0);
      } finally {
        await context.close();
      }
    }
  }
});

test("board read failure retries without a transient placeholder or empty state", async ({
  page,
}, testInfo) => {
  await authenticate(page);
  let failed = false;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route(`**/api/boards/${boardId}`, async (route) => {
    if (!failed) {
      failed = true;
      return route.fulfill({
        status: 503,
        json: { error: "Board temporarily unavailable." },
      });
    }
    await gate;
    await route.continue();
  });
  try {
    await page.goto(`/boards/${boardId}`);
    await expect(
      page.getByRole("heading", { name: "Something went wrong", exact: true }),
    ).toBeVisible();
    await page.screenshot({
      path: testInfo.outputPath("board-read-failed.png"),
    });
    await page.getByRole("button", { name: "Try again", exact: true }).click();
    await expect(
      page.getByRole("heading", { name: "Recovery verification", exact: true }),
    ).toBeVisible();
    await expect(page.getByText("Loading tasks…", { exact: true })).toHaveCount(
      0,
    );
    await expect(page.getByText("No tasks yet", { exact: true })).toHaveCount(
      0,
    );
    await expect(
      page.getByRole("button", { name: "New task", exact: true }),
    ).toHaveCount(0);
    await expect(
      page.getByRole("button", { name: "Board actions", exact: true }),
    ).toBeDisabled();
    await expect(
      page.getByRole("button", { name: "Try again", exact: true }),
    ).toHaveCount(0);
    await page.screenshot({
      path: testInfo.outputPath("board-read-pending.png"),
    });
    release();
    await expect(
      page.getByRole("heading", { name: "Recovery verification", exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole("status", { name: "Loading tasks…" }),
    ).toHaveCount(0);
    await expect(
      page.getByRole("heading", { name: "Something went wrong", exact: true }),
    ).toHaveCount(0);
  } finally {
    release();
  }
});

test("limited roles see permission recovery without administrative data requests", async ({
  browser,
}, testInfo) => {
  for (const role of ["member", "viewer"] as const) {
    const fixture = await getBrowserRoleFixture(origin, role);
    try {
      for (const width of [1280, 390]) {
        for (const theme of ["light", "dark"]) {
          const context = await browser.newContext({
            baseURL: origin,
            viewport: { width, height: 844 },
            isMobile: width === 390,
            hasTouch: width === 390,
          });
          try {
            await context.addInitScript(
              (value) => localStorage.setItem("mill:theme", value),
              theme,
            );
            const page = await context.newPage();
            await authenticateBrowserFixture(page, fixture);
            const administrativeReads: string[] = [];
            page.on("request", (request) => {
              if (
                request.method() === "GET" &&
                /\/api\/(audit|export|auth\/invitations)(?:\?|$)/.test(
                  request.url(),
                )
              )
                administrativeReads.push(request.url());
            });
            for (const section of ["members", "workspace"]) {
              await page.goto(`/settings/${section}`);
              await expect(
                page.getByRole("heading", {
                  name: "Administrator access required",
                  exact: true,
                }),
              ).toBeVisible();
              expect(
                await page.evaluate(
                  () => document.documentElement.scrollWidth <= innerWidth,
                ),
              ).toBe(true);
            }
            expect(administrativeReads).toEqual([]);
            await page.screenshot({
              path: testInfo.outputPath(
                `permission-${role}-${width}-${theme}.png`,
              ),
            });
            await page.goto("/settings/workspace");
            const action = page.getByRole("link", {
              name: "Go to boards",
              exact: true,
            });
            await action.focus();
            await page.keyboard.press("Enter");
            await expect(page).toHaveURL(/\/boards\/[^/]+$/);
            for (const section of ["audit", "data"]) {
              await page.goto(`/settings/${section}`);
              await expect(
                page.getByRole("heading", {
                  name: "This page could not be found",
                  exact: true,
                }),
              ).toBeVisible();
            }
            await expect(
              page.getByRole("link", { name: "Audit history", exact: true }),
            ).toHaveCount(0);
            await expect(
              page.getByRole("link", {
                name: "Export and import",
                exact: true,
              }),
            ).toHaveCount(0);
            expect((await page.request.get("/api/audit")).status()).toBe(404);
            expect((await page.request.get("/api/export")).status()).toBe(404);
            expect(
              (
                await page.request.post("/api/import", {
                  headers: { Origin: origin },
                  data: {},
                })
              ).status(),
            ).toBe(404);
          } finally {
            await context.close();
          }
        }
      }
    } finally {
      await fixture.api.dispose();
    }
  }
});

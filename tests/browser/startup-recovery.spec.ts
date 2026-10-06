import { randomBytes } from "node:crypto";
import {
  chromium,
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

async function expectBoardsOverview(page: Page) {
  await expect(page).toHaveURL("/boards");
  await expect(
    page.getByRole("heading", { name: "Boards", exact: true }),
  ).toBeVisible();
  await expect(
    page
      .getByRole("main")
      .getByRole("link", { name: "Recovery verification", exact: true })
      .and(page.locator(`a[href="/boards/${boardId}"]`)),
  ).toHaveAttribute("href", `/boards/${boardId}`);
}

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

async function expectTouchContext(page: Page) {
  const input = await page.evaluate(() => ({
    coarse: matchMedia("(pointer: coarse)").matches,
    noHover: matchMedia("(hover: none)").matches,
    touchPoints: navigator.maxTouchPoints,
  }));
  expect(input.coarse).toBe(true);
  expect(input.noHover).toBe(true);
  expect(input.touchPoints).toBeGreaterThan(0);
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
    await expect(page.locator('[data-slot="toast"]')).toHaveCount(1);
    await expect(page.getByRole("main").getByRole("alert")).toHaveCount(0);
    await expect(page.getByRole("heading", { name: "Sign in" })).toHaveCount(0);

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
  await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible();
  await expect(page.getByLabel("Password", { exact: true })).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Mill could not load" }),
  ).toHaveCount(0);
});

test("cold sign-in and board routes reach usable controls on a throttled connection", async ({
  browser,
}, testInfo) => {
  test.setTimeout(90000);
  expect(browser.browserType().name()).toBe("chromium");
  const coldBrowser = await chromium.launch({ channel: "chromium" });
  try {
    for (const scenario of ["sign-in", "board"] as const) {
      const context = await coldBrowser.newContext({
        baseURL: origin,
        viewport: { width: 1280, height: 800 },
      });
      try {
        if (scenario === "board") await context.addCookies(sessionCookies);
        const page = await context.newPage();
        const connection = await context.newCDPSession(page);
        await connection.send("Network.enable");
        await connection.send("Network.setCacheDisabled", {
          cacheDisabled: true,
        });
        await connection.send("Network.emulateNetworkConditions", {
          offline: false,
          latency: 150,
          downloadThroughput: 200_000,
          uploadThroughput: 93_750,
        });
        await page.goto(scenario === "board" ? `/boards/${boardId}` : "/", {
          waitUntil: "commit",
        });
        if (scenario === "board") {
          await expect(
            page.getByRole("heading", { name: "Recovery verification" }),
          ).toBeVisible({ timeout: 30000 });
          await expect(
            page.getByRole("button", { name: "New task", exact: true }),
          ).toBeVisible();
        } else {
          await expect(
            page.getByRole("heading", { name: "Sign in" }),
          ).toBeVisible({ timeout: 30000 });
          await expect(
            page.getByLabel("Password", { exact: true }),
          ).toBeVisible();
        }
        const observation = await page.evaluate(() => {
          const resources = performance.getEntriesByType(
            "resource",
          ) as PerformanceResourceTiming[];
          const bytes = (pattern: RegExp) =>
            resources
              .filter((resource) =>
                pattern.test(new URL(resource.name).pathname),
              )
              .reduce((sum, resource) => sum + resource.transferSize, 0);
          const navigation = performance.getEntriesByType("navigation")[0] as
            PerformanceNavigationTiming | undefined;
          return {
            usableByMs: Math.round(performance.now()),
            htmlTransferBytes: navigation?.transferSize ?? 0,
            entryJsTransferBytes: bytes(/^\/assets\/index-[^/]+\.js$/),
            cssTransferBytes: bytes(/^\/assets\/index-[^/]+\.css$/),
            routeJsTransferBytes: bytes(/^\/assets\/(?!index-)[^/]+\.js$/),
            bootstrapJsTransferBytes: bytes(/^\/startup-recovery\.js$/),
            finePointer: matchMedia("(pointer: fine)").matches,
            hover: matchMedia("(hover: hover)").matches,
          };
        });
        expect(observation.finePointer).toBe(true);
        expect(observation.hover).toBe(true);
        expect(observation.entryJsTransferBytes).toBeGreaterThan(0);
        expect(observation.cssTransferBytes).toBeGreaterThan(0);
        const result = {
          scenario,
          throttling: "1.6 Mbps down, 750 kbps up, 150 ms latency",
          ...observation,
        };
        console.log(`cold-load ${JSON.stringify(result)}`);
        await testInfo.attach(`cold-${scenario}.json`, {
          body: JSON.stringify(result, null, 2),
          contentType: "application/json",
        });
      } finally {
        await context.close();
      }
    }
  } finally {
    await coldBrowser.close();
  }
});

test("a failed application entry shows recovery before React starts", async ({
  page,
}) => {
  let failEntry = true;
  await page.route("**/assets/index-*.js", async (route) => {
    if (!failEntry) return route.continue();
    failEntry = false;
    await route.abort("connectionfailed");
  });
  await page.route("**/assets/*.css", (route) =>
    route.abort("connectionfailed"),
  );

  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: "Mill could not start" }),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: "Reload Mill" })).toBeVisible();
  await expect(page.locator('[data-slot="toast"]')).toContainText(
    "The application did not load.",
  );
  await expect(page.locator('[data-slot="toast"]')).toHaveCSS(
    "position",
    "fixed",
  );
  await expect(page.getByRole("main").getByRole("alert")).toHaveCount(0);
  await expect(page.getByRole("main")).not.toContainText(
    "The application did not load.",
  );
  await page.getByRole("button", { name: "Dismiss notification" }).click();
  await expect(page.locator('[data-slot="toast"]')).toHaveCount(0);
  await page.unroute("**/assets/*.css");
  await expect(page.getByRole("heading", { name: "Sign in" })).toHaveCount(0);

  await page.getByRole("button", { name: "Reload Mill" }).click();
  await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible();
});

test("a held application entry offers recovery and can still finish loading", async ({
  page,
}) => {
  test.setTimeout(45000);
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route("**/assets/index-*.js", async (route) => {
    await blocked;
    await route.continue();
  });

  try {
    await page.goto("/", { waitUntil: "commit" });
    await expect(
      page.getByRole("heading", { name: "Mill could not start" }),
    ).toBeVisible({ timeout: 20000 });
    release();
    await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible();
    await expect(
      page.getByRole("heading", { name: "Mill could not start" }),
    ).toHaveCount(0);
  } finally {
    release();
  }
});

test("a slow sign-in chunk does not show entry recovery after React starts", async ({
  page,
}) => {
  test.setTimeout(45000);
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route("**/assets/auth-*.js", async (route) => {
    await blocked;
    await route.continue();
  });

  try {
    await page.goto("/", { waitUntil: "commit" });
    await expect(page.locator("#root")).toHaveAttribute(
      "data-mill-entry-started",
      "true",
    );
    await page.waitForTimeout(16000);
    await expect(
      page.getByRole("heading", { name: "Mill could not start" }),
    ).toHaveCount(0);
    release();
    await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible();
  } finally {
    release();
  }
});

test("a stale entry reloads once to the current application build", async ({
  page,
}) => {
  const staleEntry = "/assets/index-stale.js";
  let firstHtml = true;
  let navigations = 0;
  page.on("request", (request) => {
    if (request.isNavigationRequest() && request.frame() === page.mainFrame())
      navigations++;
  });
  await page.route(
    (url) => url.pathname === "/",
    async (route) => {
      const response = await route.fetch();
      if (!firstHtml) return route.fulfill({ response });
      firstHtml = false;
      const html = await response.text();
      const staleHtml = html.replace(
        /src="\/assets\/index-[^"]+\.js"/,
        `src="${staleEntry}"`,
      );
      expect(staleHtml).not.toBe(html);
      await route.fulfill({ response, body: staleHtml });
    },
  );

  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible();
  expect(navigations).toBe(2);
  expect(
    await page.evaluate(() => sessionStorage.getItem("mill:entry-reload")),
  ).toBe(new URL(staleEntry, origin).href);
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
      page.getByRole("heading", { name: "Unable to open this page" }),
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
      page.getByRole("heading", { name: "Unable to open this page" }),
    ).toHaveCount(0);
    if (action === "Reload") {
      await expect(page).toHaveURL(`/boards/${boardId}`);
      await expect(
        page.getByRole("heading", {
          name: "Recovery verification",
          exact: true,
        }),
      ).toBeVisible();
    } else await expectBoardsOverview(page);
  });
}

test("phone actions remain compact and fields retain readable input text", async () => {
  const phoneBrowser = await chromium.launch({ channel: "chromium" });
  const context = await phoneBrowser.newContext({
    baseURL: origin,
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
  });
  try {
    const page = await context.newPage();
    await authenticate(page);
    await page.goto("/settings/workspace");
    await expectTouchContext(page);
    await expect(
      page.getByRole("textbox", { name: /^Team name/ }),
    ).toBeVisible();
    for (const name of [
      "Toggle navigation",
      "Open notifications",
      /^Appearance:/,
      "Save",
    ]) {
      const control = page.getByRole("button", {
        name,
        exact: typeof name === "string",
      });
      const bounds = await control.boundingBox();
      expect(bounds).not.toBeNull();
      const expectedSize = name === "Save" || name instanceof RegExp ? 40 : 32;
      expect(bounds!.height).toBe(expectedSize);
      expect(bounds!.width).toBeGreaterThanOrEqual(expectedSize);
    }
    const inputSize = await page
      .getByRole("textbox", { name: /^Team name/ })
      .evaluate((element) =>
        Number.parseFloat(getComputedStyle(element).fontSize),
      );
    expect(inputSize).toBeGreaterThanOrEqual(16);
    await page
      .getByRole("button", { name: "Toggle navigation", exact: true })
      .click();
    await expect(
      page.getByRole("dialog", { name: "Navigation", exact: true }),
    ).toBeVisible();
    const close = page
      .getByRole("dialog", { name: "Navigation", exact: true })
      .getByRole("button", { name: "Close navigation", exact: true });
    const bounds = await close.boundingBox();
    expect(bounds!.height).toBeCloseTo(44, 2);
    expect(bounds!.width).toBeCloseTo(44, 2);
  } finally {
    await context.close();
    await phoneBrowser.close();
  }
});

test("missing pages have a primary recovery action in both themes and viewport sizes", async ({
  browser,
}, testInfo) => {
  for (const width of [1280, 390]) {
    for (const theme of ["light", "dark"]) {
      const touchBrowser =
        width === 390 ? await chromium.launch({ channel: "chromium" }) : null;
      const context = await (touchBrowser ?? browser).newContext({
        baseURL: origin,
        viewport: { width, height: 844 },
        isMobile: width === 390,
        hasTouch: width === 390,
      });
      try {
        await context.addCookies(sessionCookies);
        await context.addInitScript((value) => {
          localStorage.setItem("avgeek-oss-ui-theme", value);
        }, theme);
        const page = await context.newPage();
        await page.goto("/missing-review-page");
        if (width === 390) await expectTouchContext(page);
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
          await expectTouchContext(page);
          const bounds = await action.boundingBox();
          expect(bounds!.height).toBe(40);
        }
        await page.screenshot({
          path: testInfo.outputPath(`missing-${width}-${theme}.png`),
        });
        await action.focus();
        await page.keyboard.press("Enter");
        await expectBoardsOverview(page);
        await expect(heading).toHaveCount(0);
      } finally {
        await context.close();
        await touchBrowser?.close();
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
      page.locator('[data-slot="toast"]').filter({
        hasText: "Board temporarily unavailable.",
      }),
    ).toBeVisible();
    await expect(page.getByRole("main").getByRole("alert")).toHaveCount(0);
    await page.screenshot({
      path: testInfo.outputPath("board-read-failed.png"),
    });
    await page.getByRole("button", { name: "Retry", exact: true }).click();
    await expect(
      page.getByRole("heading", { name: "Recovery verification", exact: true }),
    ).toBeVisible();
    await expect(page.getByText("Loading tasks…", { exact: true })).toHaveClass(
      /\bsr-only\b/,
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
      page.getByRole("button", { name: "Retry", exact: true }),
    ).toHaveCount(0);
    await page.screenshot({
      path: testInfo.outputPath("board-read-pending.png"),
    });
    release();
    await expect(
      page.getByRole("heading", { name: "Recovery verification", exact: true }),
    ).toBeVisible();
    await expect(page.getByText("Loading tasks…", { exact: true })).toHaveCount(
      0,
    );
    await expect(
      page.getByRole("heading", {
        name: "Mill could not load this page",
        exact: true,
      }),
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
          const touchBrowser =
            width === 390
              ? await chromium.launch({ channel: "chromium" })
              : null;
          const context = await (touchBrowser ?? browser).newContext({
            baseURL: origin,
            viewport: { width, height: 844 },
            isMobile: width === 390,
            hasTouch: width === 390,
          });
          try {
            await context.addInitScript(
              (value) => localStorage.setItem("avgeek-oss-ui-theme", value),
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
              if (width === 390) await expectTouchContext(page);
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
            await expectBoardsOverview(page);
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
            await touchBrowser?.close();
          }
        }
      }
    } finally {
      await fixture.api.dispose();
    }
  }
});

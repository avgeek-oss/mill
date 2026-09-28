import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import postgres from "postgres";
import {
  expect,
  request,
  test,
  type APIRequestContext,
  type Page,
} from "@playwright/test";
import {
  authenticateBrowserFixture,
  browserBootstrap as bootstrap,
  getBrowserBootstrap,
  getBrowserRoleFixture,
  type BrowserFixtureSession,
} from "../browser-fixture.js";

test.use({ trace: "off" });
test.describe.configure({ mode: "serial" });
const agentName = "AuditAssistant".repeat(8);
const agentActor = `${bootstrap.name} via ${agentName}`;
let origin: string;
let admin: APIRequestContext;
let database: ReturnType<typeof postgres>;
let readOnlyAgent: APIRequestContext;
let adminSession: BrowserFixtureSession;

async function json(client: APIRequestContext, path: string, data?: unknown) {
  const response = await client.fetch(`/api${path}`, {
    method: data === undefined ? "GET" : "POST",
    headers: { Origin: origin },
    data,
  });
  expect(response.ok(), `${path}: status ${response.status()}`).toBe(true);
  return response.json();
}
async function signIn(page: Page) {
  await authenticateBrowserFixture(page, adminSession);
  await page.goto("/");
  await expect(
    page.getByRole("button", { name: "Open notifications", exact: true }),
  ).toBeVisible();
}
async function openAudit(page: Page) {
  await page.goto("/settings/audit");
  await expect(
    page.getByRole("heading", { name: "Audit history", exact: true }),
  ).toBeVisible();
  return page.getByRole("region", { name: "Workspace activity", exact: true });
}

test.beforeAll(async ({ baseURL }) => {
  origin = baseURL!;
  if (!process.env.DATABASE_URL) process.loadEnvFile(".env");
  const metadata = JSON.parse(
    await readFile(`tmp/browser-${new URL(origin).port}-schema.json`, "utf8"),
  ) as { schema: string; baseURL: string };
  expect(metadata.schema).toMatch(/^browser_[a-f0-9]{16}$/);
  expect(metadata.baseURL).toBe(origin);
  database = postgres(process.env.DATABASE_URL!, {
    max: 1,
    connection: { search_path: metadata.schema },
  });
  const fixture = await getBrowserBootstrap(origin);
  admin = fixture.api;
  adminSession = fixture;
  const { user } = fixture.identity;
  const { board } = await json(admin, "/boards", {
    name: "Audit verification",
    prefix: "AUD",
  });
  const { token } = await json(admin, "/credentials", {
    name: agentName,
    scopes: ["read", "write"],
    boardIds: [board.id],
    expiresInDays: 1,
  });
  const agent = await request.newContext({
    baseURL: origin,
    extraHTTPHeaders: { Authorization: `Bearer ${token}` },
  });
  try {
    await json(agent, `/boards/${board.id}/tasks`, {
      title: "Real agent audit event",
    });
  } finally {
    await agent.dispose();
  }
  const readOnly = await json(admin, "/credentials", {
    name: "Read-only audit verification",
    scopes: ["read"],
    expiresInDays: 1,
  });
  readOnlyAgent = await request.newContext({
    baseURL: origin,
    extraHTTPHeaders: { Authorization: `Bearer ${readOnly.token}` },
  });
  const rows = Array.from({ length: 115 }, (_, index) => ({
    id: randomUUID(),
    actor_id: user.id,
    actor_name:
      index === 114
        ? "Earliest audit verification event"
        : `Audit person ${String(index).padStart(3, "0")}`,
    actor_kind: "human",
    action: "task.updated",
    detail: database.json({}),
    created_at: new Date(Date.UTC(2020, 0, 1) - index * 1000),
  }));
  await database`INSERT INTO activity ${database(rows)}`;
});
test.afterAll(async () => {
  await readOnlyAgent?.dispose();
  await admin?.dispose();
  await database?.end();
});

test("pending, actual response loss, retry, and empty database history stay distinct", async ({
  page,
}) => {
  await signIn(page);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let first = true;
  await page.route("**/api/audit?*", async (route) => {
    if (!first) return route.continue();
    first = false;
    const response = await route.fetch();
    expect(response.status()).toBe(200);
    await gate;
    await route.abort("failed");
  });
  const region = await openAudit(page);
  try {
    await expect(
      region.getByRole("status").filter({ hasText: "Loading activity…" }),
    ).toHaveText("Loading activity…");
    await expect(region.getByText("No workspace activity yet")).toHaveCount(0);
    await expect(region.getByRole("grid")).toHaveCount(0);
  } finally {
    release();
  }
  await expect(region.getByRole("alert")).toContainText(
    "Mill could not be reached",
  );
  await expect(region.getByText("No workspace activity yet")).toHaveCount(0);
  await region
    .getByRole("button", { name: "Retry loading activity", exact: true })
    .click();
  await expect(region.getByRole("grid").locator("tbody tr")).toHaveCount(100);
  const activity = await database`DELETE FROM activity RETURNING *`;
  const authentication = await database`DELETE FROM auth_audit RETURNING *`;
  try {
    await openAudit(page);
    await expect(
      region.getByRole("heading", { name: "No workspace activity yet" }),
    ).toBeVisible();
    await expect(region.getByRole("status")).toHaveCount(0);
    await expect(region.getByRole("alert")).toHaveCount(0);
    await expect(region.getByRole("grid")).toHaveCount(0);
  } finally {
    if (activity.length)
      await database`INSERT INTO activity ${database(activity.map((row) => ({ ...row, detail: database.json(row.detail) })))}`;
    if (authentication.length)
      await database`INSERT INTO auth_audit ${database(authentication.map((row) => ({ ...row, detail: database.json(row.detail) })))}`;
  }
});

test("real cursor continuation preserves 100 rows during failure and retries the same older page", async ({
  page,
}) => {
  await signIn(page);
  const region = await openAudit(page);
  const rows = region.getByRole("grid").locator("tbody tr");
  await expect(rows).toHaveCount(100);
  await expect(
    region.getByText("Earliest audit verification event", { exact: true }),
  ).toHaveCount(0);
  const cursors: string[] = [];
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let loseResponse = true;
  await page.route("**/api/audit?*", async (route) => {
    const cursor = new URL(route.request().url()).searchParams.get("cursor");
    if (!cursor) return route.continue();
    cursors.push(cursor);
    if (!loseResponse) return route.continue();
    loseResponse = false;
    const response = await route.fetch();
    expect(response.status()).toBe(200);
    expect((await response.json()).items.length).toBeGreaterThan(0);
    await gate;
    await route.abort("failed");
  });
  await region
    .getByRole("button", { name: "Load older activity", exact: true })
    .click();
  try {
    await expect(
      region.getByRole("status").filter({ hasText: "Loading older activity…" }),
    ).toHaveText("Loading older activity…");
    await expect(
      region.getByRole("button", { name: "Loading…", exact: true }),
    ).toBeDisabled();
    await expect(rows).toHaveCount(100);
  } finally {
    release();
  }
  await expect(region.getByRole("alert")).toContainText(
    "Mill could not be reached",
  );
  await expect(rows).toHaveCount(100);
  await region
    .getByRole("button", { name: "Retry loading older activity", exact: true })
    .click();
  await expect.poll(() => rows.count()).toBeGreaterThan(100);
  expect(cursors).toHaveLength(2);
  expect(cursors[0]).toBe(cursors[1]);
  for (let page = 0; page < 10; page++) {
    const continuation = region.getByRole("button", {
      name: "Load older activity",
      exact: true,
    });
    if (!(await continuation.isVisible())) break;
    const count = await rows.count();
    await continuation.click();
    await expect.poll(() => rows.count()).toBeGreaterThan(count);
  }
  await expect(
    region.getByText("Earliest audit verification event", { exact: true }),
  ).toBeVisible();
  await expect(region).toContainText("All activity loaded.");
  expect(await rows.count()).toBeGreaterThan(115);
  await expect(
    region.getByRole("button", { name: "Load older activity" }),
  ).toHaveCount(0);
  const actorNames = await rows
    .locator("td:first-child span.font-medium")
    .allTextContents();
  const seededNames = actorNames.filter(
    (name) =>
      name.startsWith("Audit person ") ||
      name === "Earliest audit verification event",
  );
  expect(seededNames).toHaveLength(115);
  expect(new Set(seededNames).size).toBe(115);
});

test("member, viewer, and read-only agent requests cannot read administrative history", async ({
  browser,
}) => {
  expect((await readOnlyAgent.get("/api/audit?limit=100")).status()).toBe(403);
  for (const role of ["member", "viewer"] as const) {
    const fixture = await getBrowserRoleFixture(origin, role);
    const client = fixture.api;
    let context;
    try {
      expect((await client.get("/api/audit?limit=100")).status()).toBe(403);
      context = await browser.newContext({
        baseURL: origin,
        storageState: fixture.storageState,
      });
      const page = await context.newPage();
      let auditRequests = 0;
      page.on("request", (request) => {
        if (new URL(request.url()).pathname === "/api/audit") auditRequests++;
      });
      await page.goto("/settings/audit");
      await expect(
        page.getByRole("heading", {
          name: "Administrator access required",
          exact: true,
        }),
      ).toBeVisible();
      await expect(
        page.getByRole("grid", { name: "Audit history" }),
      ).toHaveCount(0);
      expect(auditRequests).toBe(0);
    } finally {
      await context?.close();
      await client.dispose();
    }
  }
});

test("an older response cannot replace a fresh history after navigation", async ({
  page,
}) => {
  await signIn(page);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let captured!: () => void;
  const ready = new Promise<void>((resolve) => {
    captured = resolve;
  });
  let first = true;
  let eventId = "";
  await page.route("**/api/audit?*", async (route) => {
    if (!first) return route.continue();
    first = false;
    const response = await route.fetch();
    const body = await response.json();
    eventId = body.items[0].id;
    captured();
    await gate;
    await route.fulfill({ response });
  });
  const region = await openAudit(page);
  try {
    await ready;
    await page.getByRole("link", { name: "People", exact: true }).click();
    await expect(
      page.getByRole("heading", { name: "People", exact: true }),
    ).toBeVisible();
    await database`UPDATE auth_audit SET actor_name='Fresh audit response actor' WHERE id=${eventId}`;
    await database`UPDATE activity SET actor_name='Fresh audit response actor' WHERE id=${eventId}`;
    await page
      .getByRole("link", { name: "Audit history", exact: true })
      .click();
    await expect(
      region.getByText("Fresh audit response actor", { exact: true }),
    ).toBeVisible();
  } finally {
    release();
  }
  await expect(region.getByRole("grid").locator("tbody tr")).toHaveCount(100);
  await expect(
    region.getByText("Fresh audit response actor", { exact: true }),
  ).toBeVisible();
});

test("long real agent rows retain readable hierarchy in both themes on desktop and mobile", async ({
  page,
  browser,
}) => {
  for (const width of [1440, 390]) {
    const phone =
      width === 390
        ? await browser.newContext({
            baseURL: origin,
            viewport: { width, height: 844 },
            isMobile: true,
            hasTouch: true,
          })
        : null;
    const viewportPage = phone ? await phone.newPage() : page;
    try {
      if (!phone) await viewportPage.setViewportSize({ width, height: 900 });
      await signIn(viewportPage);
      await openAudit(viewportPage);
      const table = viewportPage.getByRole("grid", {
        name: "Audit history",
        exact: true,
      });
      const row = table.getByRole("row").filter({
        has: viewportPage.getByText(agentActor, { exact: true }),
      });
      const longAction = table.getByRole("row").filter({
        has: viewportPage.getByText(`Created agent credential “${agentName}”`, {
          exact: true,
        }),
      });
      await expect(row).toBeVisible();
      await expect(row.getByText("Agent", { exact: true })).toBeVisible();
      await expect(
        row.getByText("Created task AUD-1 · Real agent audit event", {
          exact: true,
        }),
      ).toBeVisible();
      for (const theme of ["light", "dark"]) {
        await viewportPage.evaluate((value) => {
          localStorage.setItem("mill:theme", value);
        }, theme);
        await viewportPage.reload();
        await expect(viewportPage.locator("html")).toHaveAttribute(
          "data-theme",
          theme,
        );
        await expect(row).toBeVisible();
        await expect(longAction).toBeVisible();
        const usedWidths = await table.evaluate((element) => {
          const headers = [...element.querySelectorAll("th")];
          return {
            table: element.getBoundingClientRect().width,
            event: headers[0].getBoundingClientRect().width,
            recorded: headers[1].getBoundingClientRect().width,
          };
        });
        expect(
          Math.abs(usedWidths.recorded - (phone ? 128 : 192)),
        ).toBeLessThanOrEqual(1);
        expect(
          Math.abs(usedWidths.event - (usedWidths.table - usedWidths.recorded)),
        ).toBeLessThanOrEqual(1);
        const dimensions = await viewportPage.evaluate(() => ({
          width: document.documentElement.scrollWidth,
          viewport: window.innerWidth,
        }));
        expect(dimensions.width).toBeLessThanOrEqual(dimensions.viewport + 1);
        const hierarchy = await row.evaluate((element) => {
          const actor = element.querySelector("span.font-medium")!;
          const description = element.querySelector("span.text-sm.text-muted")!;
          const cells = [...element.querySelectorAll("td")];
          return {
            actorSize: parseFloat(getComputedStyle(actor).fontSize),
            actorWeight: getComputedStyle(actor).fontWeight,
            secondarySize: parseFloat(getComputedStyle(description).fontSize),
            secondaryWeight: getComputedStyle(description).fontWeight,
            padding: cells.map((cell) => ({
              top: getComputedStyle(cell).paddingTop,
              bottom: getComputedStyle(cell).paddingBottom,
            })),
            time: element.querySelector("time")?.getAttribute("datetime"),
            timeSize: parseFloat(
              getComputedStyle(element.querySelector("time")!).fontSize,
            ),
            contentBounds: cells.flatMap((cell) => {
              const bounds = cell.getBoundingClientRect();
              return [
                ...cell.querySelectorAll(
                  "span.font-medium, span.text-sm.text-muted, time, [data-slot='chip']",
                ),
              ].map((content) => {
                const box = content.getBoundingClientRect();
                return {
                  inside:
                    box.left >= bounds.left - 1 &&
                    box.right <= bounds.right + 1,
                  label: content.textContent,
                };
              });
            }),
          };
        });
        expect(hierarchy.actorSize).toBe(hierarchy.secondarySize);
        expect(hierarchy.secondarySize).toBeGreaterThanOrEqual(14);
        expect(Number(hierarchy.actorWeight)).toBeGreaterThanOrEqual(500);
        expect(Number(hierarchy.actorWeight)).toBeGreaterThan(
          Number(hierarchy.secondaryWeight),
        );
        expect(hierarchy.time).toBeTruthy();
        expect(Math.round(hierarchy.timeSize)).toBe(12);
        for (const padding of hierarchy.padding)
          expect(padding.top).toBe(padding.bottom);
        for (const content of hierarchy.contentBounds)
          expect(content.inside, content.label ?? "row content").toBe(true);
        const longActionFits = await longAction.evaluate((element) => {
          const cell = element.querySelector("td")!;
          const bounds = cell.getBoundingClientRect();
          return [...cell.querySelectorAll("span")].every((content) => {
            const box = content.getBoundingClientRect();
            return box.left >= bounds.left - 1 && box.right <= bounds.right + 1;
          });
        });
        expect(longActionFits).toBe(true);
        const continuation = viewportPage.getByRole("button", {
          name: "Load older activity",
          exact: true,
        });
        const actionBounds = await continuation.boundingBox();
        expect(actionBounds).toBeTruthy();
        expect(actionBounds!.x).toBeGreaterThanOrEqual(0);
        expect(actionBounds!.x + actionBounds!.width).toBeLessThanOrEqual(
          width,
        );
        expect(actionBounds!.height).toBeGreaterThanOrEqual(phone ? 44 : 32);
        await viewportPage.screenshot({
          path: `tmp/audit-settings/${width === 390 ? "mobile" : "desktop"}-${theme}.png`,
        });
      }
    } finally {
      await phone?.close();
    }
  }
});

import { createHash, randomBytes, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import postgres from "postgres";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import {
  expect,
  request,
  test,
  type APIRequestContext,
  type Page,
} from "@playwright/test";
import { getBrowserBootstrap } from "../browser-fixture.js";

// OAuth codes and redirect query values must not enter automatic failure artifacts.
process.env.PLAYWRIGHT_NO_COPY_PROMPT = "1";
test.use({ trace: "off", screenshot: "off" });
test.describe.configure({ mode: "serial" });
const password = "Consent-browser-password-42";
let origin: string;
let admin: APIRequestContext;
let active: { id: string; name: string; version: number };
let selected: { id: string; name: string; version: number };
let deleted: { id: string; name: string; version: number };

async function json(
  api: APIRequestContext,
  path: string,
  body?: unknown,
  method = body === undefined ? "GET" : "POST",
) {
  const response = await api.fetch(path, {
    method,
    headers: { Origin: origin },
    data: body,
  });
  expect(response.ok(), `${method} ${path}: ${response.status()}`).toBe(true);
  return response.json();
}
async function account(page: Page, role: "member" | "viewer" = "member") {
  const email = `consent-${randomUUID()}@example.test`;
  const invitation = await json(admin, "/api/auth/invitations", {
    email,
    role,
  });
  const api = await request.newContext({ baseURL: origin });
  const accepted = await json(api, "/api/auth/accept-invitation", {
    token: invitation.token,
    name: "Consent operator",
    password,
  });
  await page.goto("/");
  await page.getByLabel("Email", { exact: true }).fill(email);
  await page.getByLabel("Password", { exact: true }).fill(password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(
    page.getByRole("navigation", { name: "Workspace navigation" }),
  ).toBeVisible();
  return { api, email, id: accepted.user.id };
}
async function grant(api: APIRequestContext, name: string, scope = "read") {
  const callback = `${origin}/consent-return?app=${encodeURIComponent(name)}`;
  const client = await json(api, "/oauth/register", {
    client_name: name,
    redirect_uris: [callback],
    token_endpoint_auth_method: "none",
  });
  const verifier = randomBytes(32).toString("base64url");
  const state = randomUUID();
  const response = await api.get(
    `/oauth/authorize?${new URLSearchParams({
      response_type: "code",
      client_id: client.client_id,
      redirect_uri: callback,
      resource: `${origin}/mcp`,
      scope,
      state,
      code_challenge: createHash("sha256").update(verifier).digest("base64url"),
      code_challenge_method: "S256",
    })}`,
    { maxRedirects: 0 },
  );
  expect(response.status()).toBe(302);
  const url = new URL(response.headers().location);
  const id = url.searchParams.get("request")!;
  expect(id.length > 0).toBe(true);
  return {
    id,
    url: url.href,
    callback,
    verifier,
    state,
    clientId: client.client_id,
  };
}
function gate() {
  let release!: () => void;
  const wait = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { wait, release };
}
async function clientCallback(page: Page) {
  await page.route("**/consent-return?**", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: "<main><h1>Client connection returned</h1></main>",
    }),
  );
}
async function database() {
  if (!process.env.DATABASE_URL) process.loadEnvFile(".env");
  const metadata = JSON.parse(
    await readFile(`tmp/browser-${new URL(origin).port}-schema.json`, "utf8"),
  ) as { schema: string; baseURL: string };
  expect(metadata.schema).toMatch(/^browser_[a-f0-9]{16}$/);
  expect(metadata.baseURL).toBe(origin);
  return {
    sql: postgres(process.env.DATABASE_URL!, { max: 1 }),
    schema: metadata.schema,
  };
}
test.beforeAll(async ({ baseURL }) => {
  const fixture = await getBrowserBootstrap(baseURL!);
  origin = fixture.origin;
  admin = fixture.api;
  active = (
    await json(admin, "/api/boards", {
      name: "Consent active board",
      prefix: "CA",
    })
  ).board;
  selected = (
    await json(admin, "/api/boards", {
      name: "Consent selected board",
      prefix: "CAR",
    })
  ).board;
  deleted = (
    await json(admin, "/api/boards", {
      name: "Consent removed board",
      prefix: "CD",
    })
  ).board;
  await json(
    admin,
    `/api/boards/${deleted.id}`,
    { version: deleted.version },
    "DELETE",
  );
});
test.afterAll(async () => {
  await admin?.dispose();
});

test("a member connects directly as themselves without an Agent and can revoke the connection", async ({
  page,
}) => {
  const operator = await account(page);
  const sdk = new Client({ name: "human-consent-verification", version: "1" });
  try {
    await clientCallback(page);
    const connection = await grant(
      operator.api,
      "Member connection",
      "read write",
    );
    await page.goto(connection.url);
    await expect(page.getByRole("button", { name: /Agent$/ })).toHaveCount(0);
    await expect(
      page.getByRole("link", { name: "Agents", exact: true }),
    ).toHaveCount(0);
    await expect(page.getByText(operator.email, { exact: true })).toBeVisible();
    const allow = page.getByRole("button", {
      name: "Allow access",
      exact: true,
    });
    await expect(allow).toBeEnabled();
    const decision = page.waitForResponse(
      (response) =>
        response.url().endsWith(`/api/oauth/consent/${connection.id}`) &&
        response.request().method() === "POST",
    );
    await allow.click();
    expect((await decision).request().postDataJSON()).toEqual({ allow: true });
    await page.waitForURL(/\/consent-return\?/);
    const returned = new URL(page.url());
    const exchange = await operator.api.post("/oauth/token", {
      form: {
        grant_type: "authorization_code",
        client_id: connection.clientId,
        code: returned.searchParams.get("code")!,
        redirect_uri: connection.callback,
        code_verifier: connection.verifier,
        resource: `${origin}/mcp`,
      },
    });
    expect(exchange.status()).toBe(200);
    const token = (await exchange.json()).access_token;
    await sdk.connect(
      new StreamableHTTPClientTransport(new URL(`${origin}/mcp`), {
        requestInit: { headers: { Authorization: `Bearer ${token}` } },
      }),
    );
    const created = await sdk.callTool({
      name: "create_task",
      arguments: {
        boardId: active.id,
        title: "Direct member connection task",
        idempotencyKey: `browser-${randomUUID()}`,
      },
    });
    expect(created.isError).toBe(false);
    const task = (created.structuredContent as { task: { id: string } }).task;
    expect(task).not.toHaveProperty("agentId");
    const activity = await json(admin, `/api/tasks/${task.id}/activity`);
    expect(
      activity.items.some(
        (item: { actorId: string; actorKind: string }) =>
          item.actorId === operator.id && item.actorKind === "oauth",
      ),
    ).toBe(true);
    const credentials = (await json(operator.api, "/api/credentials")).items;
    const credential = credentials.find(
      (item: { tokenType: string }) => item.tokenType === "oauth",
    );
    expect(credential).toBeTruthy();
    expect(credential).not.toHaveProperty("agentId");
    await json(
      operator.api,
      `/api/credentials/${credential.id}`,
      undefined,
      "DELETE",
    );
    await expect(
      sdk.callTool({ name: "get_board", arguments: { boardId: active.id } }),
    ).rejects.toThrow();
  } finally {
    await sdk.close();
    await operator.api.dispose();
  }
});

test("denial needs no identity selection and returns only an access-denied decision", async ({
  page,
}) => {
  const operator = await account(page);
  try {
    await clientCallback(page);
    const connection = await grant(operator.api, "Denied member connection");
    await page.goto(connection.url);
    await expect(page.getByRole("button", { name: /Agent$/ })).toHaveCount(0);
    await page.getByRole("button", { name: "Deny", exact: true }).click();
    await page.waitForURL(/\/consent-return\?/);
    const returned = new URL(page.url());
    expect(returned.searchParams.get("error")).toBe("access_denied");
    expect(returned.searchParams.has("code")).toBe(false);
    expect((await json(operator.api, "/api/credentials")).items).toHaveLength(
      0,
    );
  } finally {
    await operator.api.dispose();
  }
});

test("delayed real details for request A cannot enable or replace request B and denial stays bound to B", async ({
  page,
}) => {
  const operator = await account(page);
  const a = await grant(operator.api, "Delayed app A");
  const b = await grant(operator.api, "Current app B");
  const hold = gate();
  const received = gate();
  try {
    await clientCallback(page);
    await page.route(`**/api/oauth/consent/${a.id}`, async (route) => {
      const response = await route.fetch();
      received.release();
      await hold.wait;
      await route.fulfill({ response }).catch(() => undefined);
    });
    await page.goto(a.url);
    await received.wait;
    await expect(
      page.getByRole("region", { name: "Connection request", exact: true }),
    ).toHaveAttribute("aria-busy", "true");
    await expect(
      page.getByText("Loading connection…", { exact: true }),
    ).toHaveCount(0);
    await expect(
      page.getByRole("button", { name: "Allow access", exact: true }),
    ).toHaveCount(0);
    await expect(
      page.getByRole("button", { name: "Deny", exact: true }),
    ).toHaveCount(0);
    await page.evaluate((url) => {
      window.history.pushState({}, "", url);
      window.dispatchEvent(new Event("mill:navigate"));
    }, b.url);
    await expect(
      page.getByText("Current app B", { exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Allow access", exact: true }),
    ).toBeEnabled();
    hold.release();
    await expect(page.getByText("Delayed app A", { exact: true })).toHaveCount(
      0,
    );
    const decided = page.waitForResponse(
      (response) =>
        response.url().endsWith(`/api/oauth/consent/${b.id}`) &&
        response.request().method() === "POST",
    );
    await page.getByRole("button", { name: "Deny", exact: true }).click();
    const response = await decided;
    expect(response.request().postDataJSON()).toEqual({ allow: false });
    await page.waitForURL(/\/consent-return\?/);
    const returned = new URL(page.url());
    expect(returned.searchParams.get("error")).toBe("access_denied");
    expect(returned.searchParams.get("state") === b.state).toBe(true);
    expect(returned.searchParams.has("code")).toBe(false);
    expect(
      (await operator.api.get(`/api/oauth/consent/${a.id}`)).status(),
    ).toBe(200);
    expect(
      (await operator.api.get(`/api/oauth/consent/${b.id}`)).status(),
    ).toBe(400);
  } finally {
    hold.release();
    await operator.api.dispose();
  }
});

test("a delayed old decision cannot redirect a new request and scoped consent grants only the selected board", async ({
  page,
  playwright,
}) => {
  const operator = await account(page);
  const a = await grant(operator.api, "Previous connection A");
  const b = await grant(
    operator.api,
    "Selected board connection",
    "read write",
  );
  const hold = gate();
  const received = gate();
  try {
    await clientCallback(page);
    await page.route(`**/api/oauth/consent/${a.id}`, async (route) => {
      if (route.request().method() !== "POST") return route.continue();
      const response = await route.fetch();
      received.release();
      await hold.wait;
      await route.fulfill({ response }).catch(() => undefined);
    });
    await page.goto(a.url);
    await expect(
      page.getByRole("button", { name: "Allow access", exact: true }),
    ).toBeEnabled();
    await page
      .getByRole("button", { name: "Allow access", exact: true })
      .click();
    await received.wait;
    await expect(
      page.getByText("Allowing access…", { exact: true }),
    ).toBeVisible();
    await page.evaluate((url) => {
      window.history.pushState({}, "", url);
      window.dispatchEvent(new Event("mill:navigate"));
    }, b.url);
    await expect(
      page.getByText("Selected board connection", { exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Allow access", exact: true }),
    ).toBeEnabled();
    hold.release();
    await page.getByRole("button", { name: /Approved boards$/ }).click();
    await expect(
      page.getByRole("option", { name: deleted.name, exact: true }),
    ).toHaveCount(0);
    await page
      .getByRole("option", { name: selected.name, exact: true })
      .click();
    const decided = page.waitForResponse(
      (response) =>
        response.url().endsWith(`/api/oauth/consent/${b.id}`) &&
        response.request().method() === "POST",
    );
    await page
      .getByRole("button", { name: "Allow access", exact: true })
      .click();
    expect((await decided).request().postDataJSON()).toEqual({
      allow: true,
      boardIds: [selected.id],
    });
    await page.waitForURL(/\/consent-return\?/);
    const returned = new URL(page.url());
    expect(returned.searchParams.get("state") === b.state).toBe(true);
    expect(returned.searchParams.has("code")).toBe(true);
    const exchange = await operator.api.post("/oauth/token", {
      form: {
        grant_type: "authorization_code",
        client_id: b.clientId,
        code: returned.searchParams.get("code")!,
        redirect_uri: b.callback,
        code_verifier: b.verifier,
        resource: `${origin}/mcp`,
      },
    });
    expect(exchange.status()).toBe(200);
    const token = (await exchange.json()).access_token;
    const client = await playwright.request.newContext({
      baseURL: origin,
      extraHTTPHeaders: { Authorization: `Bearer ${token}` },
    });
    const sdk = new Client({
      name: "consent-browser-verification",
      version: "1",
    });
    try {
      await sdk.connect(
        new StreamableHTTPClientTransport(new URL(`${origin}/mcp`), {
          requestInit: { headers: { Authorization: `Bearer ${token}` } },
        }),
      );
      const permitted = await sdk.callTool({
        name: "get_board",
        arguments: { boardId: selected.id },
      });
      expect(permitted.isError).toBe(false);
      expect(
        (permitted.structuredContent as { board: { id: string } }).board.id,
      ).toBe(selected.id);
      const outside = await sdk.callTool({
        name: "get_board",
        arguments: { boardId: active.id },
      });
      expect(outside.isError).toBe(true);
      for (const path of [`/api/boards/${selected.id}`, "/api/auth/me"]) {
        const requestId = `consent-rest-${randomUUID()}`;
        const rest = await client.get(path, {
          headers: { "X-Request-ID": requestId },
        });
        expect(rest.status()).toBe(403);
        expect(rest.headers()["x-request-id"]).toBe(requestId);
        expect(await rest.json()).toEqual({
          error: {
            code: "FORBIDDEN",
            message: "OAuth credentials use MCP",
            requestId,
          },
        });
      }
    } finally {
      await sdk.close();
      await client.dispose();
    }
  } finally {
    hold.release();
    await operator.api.dispose();
  }
});

test("consent completes a coherent large directory after rename, deletion and creation invalidate its snapshot", async ({
  page,
}) => {
  const operator = await account(page);
  try {
    const fixture = await database();
    try {
      await fixture.sql.unsafe(
        `INSERT INTO "${fixture.schema}".boards(workspace_id,name,prefix) SELECT (SELECT id FROM "${fixture.schema}".workspace),'Consent directory fixture '||n,'CDF'||n FROM generate_series(1,105)n`,
      );
    } finally {
      await fixture.sql.end();
    }
    const renamed = (
      await json(admin, "/api/boards", {
        name: "Original consent board name",
        prefix: "OCB",
      })
    ).board;
    const removed = (
      await json(admin, "/api/boards", {
        name: "Removed during consent lookup",
        prefix: "RCL",
      })
    ).board;
    const renamedName = "Current consent board name";
    let created: { id: string; name: string } | null = null;
    let transitioned = false;
    await page.route("**/api/boards?directory=true&cursor=*", async (route) => {
      if (transitioned) return route.continue();
      transitioned = true;
      await json(
        admin,
        `/api/boards/${renamed.id}`,
        { version: renamed.version, name: renamedName },
        "PATCH",
      );
      expect(
        await json(
          admin,
          `/api/boards/${removed.id}`,
          { version: removed.version },
          "DELETE",
        ),
      ).toEqual({ ok: true });
      created = (
        await json(admin, "/api/boards", {
          name: "Created during consent lookup",
          prefix: "CCL",
        })
      ).board;
      const requestId = `consent-directory-${randomUUID()}`;
      const response = await route.fetch({
        headers: { ...route.request().headers(), "X-Request-ID": requestId },
      });
      expect(response.status()).toBe(409);
      expect(response.headers()["x-request-id"]).toBe(requestId);
      expect(await response.json()).toEqual({
        error: {
          code: "board_list_changed",
          message: "Board list changed. Reload boards to continue.",
          requestId,
        },
      });
      await route.fulfill({ response });
    });
    await clientCallback(page);
    const connection = await grant(
      operator.api,
      "Complete directory connection",
    );
    await page.goto(connection.url);
    await expect(
      page.getByRole("button", { name: "Allow access", exact: true }),
    ).toBeEnabled();
    expect(transitioned).toBe(true);
    await page.getByRole("button", { name: /Approved boards$/ }).click();
    for (const name of [
      active.name,
      selected.name,
      renamedName,
      created!.name,
    ]) {
      await expect(page.getByRole("option", { name, exact: true })).toHaveCount(
        1,
      );
    }
    for (const name of [renamed.name, removed.name, deleted.name]) {
      await expect(page.getByRole("option", { name, exact: true })).toHaveCount(
        0,
      );
    }
    const search = page.getByRole("searchbox", {
      name: "Search approved boards",
    });
    await search.fill("Consent directory fixture 105");
    await expect(
      page.getByRole("option", {
        name: "Consent directory fixture 105",
        exact: true,
      }),
    ).toHaveCount(1);
    await search.fill(created!.name);
    await page
      .getByRole("option", { name: created!.name, exact: true })
      .click();
    const decided = page.waitForResponse(
      (response) =>
        response.url().endsWith(`/api/oauth/consent/${connection.id}`) &&
        response.request().method() === "POST",
    );
    await page
      .getByRole("button", { name: "Allow access", exact: true })
      .click();
    const response = await decided;
    expect(response.status()).toBe(200);
    expect(response.request().postDataJSON()).toEqual({
      allow: true,
      boardIds: [created!.id],
    });
    await page.waitForURL(/\/consent-return\?/);
    const returned = new URL(page.url());
    expect(returned.searchParams.get("state") === connection.state).toBe(true);
    expect(returned.searchParams.has("code")).toBe(true);
  } finally {
    await operator.api.dispose();
  }
});

test("Viewer edit access and unsupported requested permissions remain unavailable while Deny stays usable", async ({
  page,
}) => {
  const operator = await account(page, "viewer");
  try {
    await clientCallback(page);
    const write = await grant(
      operator.api,
      "Viewer edit request",
      "read write",
    );
    await page.goto(write.url);
    await expect(
      page
        .locator('[data-slot="toast"]:not([data-exiting="true"])')
        .filter({ hasText: "Viewer role" }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Allow access", exact: true }),
    ).toBeDisabled();
    await page.getByRole("button", { name: "Deny", exact: true }).click();
    await page.waitForURL(/\/consent-return\?/);
    expect(new URL(page.url()).searchParams.get("error")).toBe("access_denied");
    const unsupported = await grant(operator.api, "Unsupported scope request");
    const { sql, schema } = await database();
    try {
      await sql.unsafe(
        `UPDATE "${schema}".oauth_requests SET scope='read admin' WHERE id=$1`,
        [unsupported.id],
      );
    } finally {
      await sql.end();
    }
    await page.goto(unsupported.url);
    await expect(
      page
        .locator('[data-slot="toast"]:not([data-exiting="true"])')
        .filter({ hasText: "unsupported permissions" }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Allow access", exact: true }),
    ).toBeDisabled();
    await page.getByRole("button", { name: "Deny", exact: true }).click();
    await page.waitForURL(/\/consent-return\?/);
    expect(new URL(page.url()).searchParams.has("code")).toBe(false);
    const credentials = await json(operator.api, "/api/credentials");
    expect(credentials.items).toHaveLength(0);
  } finally {
    await operator.api.dispose();
  }
});

test("phone consent in both themes keeps long context readable and supports keyboard choice, scrolling and denial", async ({
  page,
  browser,
}, testInfo) => {
  const operator = await account(page);
  try {
    for (const theme of ["light", "dark"] as const) {
      const connection = await grant(
        operator.api,
        `Planning assistant with a long app name for release notes and team tasks in ${theme} mode`,
      );
      const context = await browser.newContext({
        baseURL: origin,
        viewport: { width: 390, height: 844 },
        hasTouch: true,
        isMobile: true,
        colorScheme: theme,
        storageState: await page.context().storageState(),
      });
      try {
        await context.addInitScript((value) => {
          localStorage.setItem("mill:theme", value);
        }, theme);
        const mobile = await context.newPage();
        const touchMedia = await mobile.evaluate(() => ({
          coarse: matchMedia("(pointer: coarse)").matches,
          noHover: matchMedia("(hover: none)").matches,
          touchPoints: navigator.maxTouchPoints,
        }));
        expect(touchMedia.coarse).toBe(true);
        expect(touchMedia.noHover).toBe(true);
        expect(touchMedia.touchPoints).toBeGreaterThan(0);
        await clientCallback(mobile);
        await mobile.goto(connection.url);
        await expect(
          mobile.getByRole("button", { name: "Allow access", exact: true }),
        ).toBeEnabled();
        await expect(mobile.locator("html")).toHaveAttribute(
          "data-theme",
          theme,
        );
        if (theme === "dark")
          await expect(mobile.locator("html")).toHaveClass(/\bdark\b/);
        else await expect(mobile.locator("html")).not.toHaveClass(/\bdark\b/);
        await expect(
          mobile.getByText("Unverified app.", { exact: false }),
        ).toBeVisible();
        await expect(
          mobile.getByText(operator.email, { exact: true }),
        ).toBeVisible();
        const choice = mobile.getByRole("button", { name: /Approved boards$/ });
        await choice.focus();
        await mobile.keyboard.press("Enter");
        const option = mobile.getByRole("option", {
          name: selected.name,
          exact: true,
        });
        await expect(option).toBeVisible();
        const search = mobile.getByLabel("Search approved boards", {
          exact: true,
        });
        await search.fill(selected.name);
        await search.press("ArrowDown");
        await search.press("Enter");
        await expect(choice).toContainText(selected.name);
        const summary = mobile.getByText("Connection details", { exact: true });
        await summary.focus();
        await mobile.keyboard.press("Enter");
        await expect(
          mobile.getByText("Administrative access is excluded.", {
            exact: true,
          }),
        ).toBeVisible();
        expect(
          await mobile.evaluate(
            () => document.documentElement.scrollWidth <= window.innerWidth,
          ),
        ).toBe(true);
        const deny = mobile.getByRole("button", { name: "Deny", exact: true });
        await deny.focus();
        await expect(deny).toBeInViewport();
        const coarseInput = () =>
          mobile.evaluate(
            () =>
              matchMedia("(pointer: coarse)").matches &&
              navigator.maxTouchPoints > 0,
          );
        expect(await coarseInput(), "Phone uses coarse touch input").toBe(true);
        const bounds = await deny.boundingBox();
        expect(bounds?.height ?? 0).toBe(34);
        // A full-page resize clears Chromium touch emulation on tall pages.
        await mobile.screenshot({
          path: testInfo.outputPath(`consent-phone-${theme}.png`),
          animations: "disabled",
        });
        expect(await coarseInput(), "Capture retains coarse touch input").toBe(
          true,
        );
        await mobile
          .getByRole("heading", { name: "Connect to Mill", exact: true })
          .scrollIntoViewIfNeeded();
        await mobile.screenshot({
          path: testInfo.outputPath(`consent-phone-${theme}-context.png`),
          animations: "disabled",
        });
        expect(
          await coarseInput(),
          "Context capture retains coarse touch input",
        ).toBe(true);
        await deny.scrollIntoViewIfNeeded();
        await deny.focus();
        await expect(deny).toBeInViewport();
        await mobile.keyboard.press("Enter");
        await mobile.waitForURL(/\/consent-return\?/);
        expect(new URL(mobile.url()).searchParams.get("error")).toBe(
          "access_denied",
        );
        expect(new URL(mobile.url()).searchParams.has("code")).toBe(false);
      } finally {
        await context.close();
      }
    }
  } finally {
    await operator.api.dispose();
  }
});

test("malformed trust and role enums cannot suppress the warning or enable decisions and retry uses real details", async ({
  page,
}) => {
  const operator = await account(page);
  try {
    await clientCallback(page);
    for (const field of ["clientTrust", "role"] as const) {
      const connection = await grant(
        operator.api,
        `Malformed ${field} details`,
      );
      let corrupt = true;
      await page.route(
        `**/api/oauth/consent/${connection.id}`,
        async (route) => {
          if (route.request().method() !== "GET" || !corrupt)
            return route.continue();
          const response = await route.fetch();
          const body = await response.json();
          if (field === "clientTrust") body.clientTrust = [body.clientTrust];
          else body.user.role = [body.user.role];
          corrupt = false;
          await route.fulfill({ response, json: body });
        },
      );
      await page.goto(connection.url);
      await expect(
        page
          .locator('[data-slot="toast"]:not([data-exiting="true"])')
          .filter({ hasText: "details were incomplete" }),
      ).toBeVisible();
      await expect(
        page.getByRole("button", { name: "Allow access", exact: true }),
      ).toHaveCount(0);
      await expect(
        page.getByRole("button", { name: "Deny", exact: true }),
      ).toHaveCount(0);
      await page
        .getByRole("button", { name: "Retry connection", exact: true })
        .click();
      await expect(
        page.getByText("Unverified app.", { exact: false }),
      ).toBeVisible();
      await expect(
        page.getByRole("button", { name: "Allow access", exact: true }),
      ).toBeEnabled();
      await page.getByRole("button", { name: "Deny", exact: true }).click();
      await page.waitForURL(/\/consent-return\?/);
      expect(new URL(page.url()).searchParams.get("error")).toBe(
        "access_denied",
      );
    }
  } finally {
    await operator.api.dispose();
  }
});

test("malformed decision acknowledgements cannot navigate, claim success, or change the registered callback", async ({
  page,
}) => {
  const operator = await account(page);
  try {
    await clientCallback(page);
    for (const fault of [
      "missing-code",
      "changed-query",
      "wrong-issuer",
      "userinfo",
      "fragment",
      "wrong-denial",
    ] as const) {
      const connection = await grant(operator.api, `Acknowledgement ${fault}`);
      await page.route(
        `**/api/oauth/consent/${connection.id}`,
        async (route) => {
          if (route.request().method() !== "POST") return route.continue();
          const response = await route.fetch();
          const body = await response.json();
          const target = new URL(body.redirectTo);
          if (fault === "missing-code") target.searchParams.delete("code");
          if (fault === "changed-query")
            target.searchParams.set("app", "A different application");
          if (fault === "wrong-issuer")
            target.searchParams.set("iss", "https://another-mill.example.test");
          if (fault === "userinfo") target.username = "unexpected-user";
          if (fault === "fragment") target.hash = "unexpected-fragment";
          if (fault === "wrong-denial")
            target.searchParams.set("error", "not-access-denied");
          await route.fulfill({ response, json: { redirectTo: target.href } });
        },
      );
      await page.goto(connection.url);
      await expect(
        page.getByRole("button", { name: "Allow access", exact: true }),
      ).toBeEnabled();
      await page
        .getByRole("button", {
          name: fault === "wrong-denial" ? "Deny" : "Allow access",
          exact: true,
        })
        .click();
      await expect(
        page
          .locator('[data-slot="toast"]:not([data-exiting="true"])')
          .filter({ hasText: "response could not be confirmed" }),
      ).toBeVisible();
      expect(new URL(page.url()).pathname).toBe("/oauth/consent");
      await expect(
        page.getByText(/Access (allowed|denied)\. Returning/),
      ).toHaveCount(0);
      await expect(
        page.getByRole("button", { name: "Allow access", exact: true }),
      ).toBeDisabled();
      await expect(
        page.getByRole("button", { name: "Deny", exact: true }),
      ).toBeDisabled();
    }
  } finally {
    await operator.api.dispose();
  }
});

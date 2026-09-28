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
let archived: { id: string; name: string; version: number };
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
      body: "<main><h1>Agent connection returned</h1></main>",
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
  archived = (
    await json(admin, "/api/boards", {
      name: "Consent archived board",
      prefix: "CAR",
    })
  ).board;
  await json(
    admin,
    `/api/boards/${archived.id}`,
    { version: archived.version, archived: true },
    "PATCH",
  );
  deleted = (
    await json(admin, "/api/boards", {
      name: "Consent removed board",
      prefix: "CD",
    })
  ).board;
  await json(
    admin,
    `/api/boards/${deleted.id}`,
    { version: deleted.version, deleted: true },
    "PATCH",
  );
});
test.afterAll(async () => {
  await admin?.dispose();
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
      page.getByRole("status").filter({ hasText: "Loading connection" }),
    ).toBeVisible();
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

test("a delayed old decision cannot redirect a new request and archived board consent grants only the selected board", async ({
  page,
  playwright,
}) => {
  const operator = await account(page);
  const a = await grant(operator.api, "Previous connection A");
  const b = await grant(operator.api, "Archived board agent", "read write");
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
      page.getByText("Archived board agent", { exact: true }),
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
      .getByRole("option", { name: `${archived.name} (archived)`, exact: true })
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
      boardIds: [archived.id],
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
    const agent = await playwright.request.newContext({
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
        arguments: { boardId: archived.id },
      });
      expect(permitted.isError).toBe(false);
      expect(
        (permitted.structuredContent as { board: { id: string } }).board.id,
      ).toBe(archived.id);
      const outside = await sdk.callTool({
        name: "get_board",
        arguments: { boardId: active.id },
      });
      expect(outside.isError).toBe(true);
      expect((await agent.get(`/api/boards/${archived.id}`)).status()).toBe(
        401,
      );
      expect((await agent.get("/api/auth/me")).status()).toBe(401);
    } finally {
      await sdk.close();
      await agent.dispose();
    }
  } finally {
    hold.release();
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
      page.getByRole("alert").filter({ hasText: "Viewer role" }),
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
      page.getByRole("alert").filter({ hasText: "unsupported permissions" }),
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
        await clientCallback(mobile);
        await mobile.goto(connection.url);
        await expect(
          mobile.getByRole("button", { name: "Allow access", exact: true }),
        ).toBeEnabled();
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
          name: `${archived.name} (archived)`,
          exact: true,
        });
        await expect(option).toBeVisible();
        const search = mobile.getByLabel("Search approved boards", {
          exact: true,
        });
        await search.fill(archived.name);
        await search.press("ArrowDown");
        await search.press("Enter");
        await expect(choice).toContainText("archived");
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
        expect(bounds?.height ?? 0).toBeGreaterThanOrEqual(44);
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
        page.getByRole("alert").filter({ hasText: "details were incomplete" }),
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
          .getByRole("alert")
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

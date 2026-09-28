import { createHash, randomBytes } from "node:crypto";
import { readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  request,
  type APIRequestContext,
  type APIResponse,
  type Page,
} from "@playwright/test";

export const browserBootstrap = {
  workspaceName: "Mill browser verification",
  name: "Alex Morgan",
  email: "browser-admin@example.test",
  password: "Browser-only-password-42",
};

type StorageState = Awaited<ReturnType<APIRequestContext["storageState"]>>;
export type BrowserFixtureIdentity = {
  user: {
    id: string;
    name: string;
    email: string;
    role: "admin" | "member" | "viewer";
  };
  workspace: { id: string; name: string };
};
export type BrowserFixtureSession = {
  origin: string;
  identity: BrowserFixtureIdentity;
  storageState: StorageState;
};
export type BrowserBootstrapFixture = BrowserFixtureSession & {
  api: APIRequestContext;
};
type Sandbox = { origin: string; schema: string; cachePath: string };
type ExpectedAccount = {
  email: string;
  role: BrowserFixtureIdentity["user"]["role"];
};
type CachedSession = {
  origin: string;
  schema: string;
  userId: string;
  workspaceId: string;
  storageState: StorageState;
};

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

async function sandboxFor(baseURL: string): Promise<Sandbox> {
  const url = new URL(baseURL);
  if (
    !["http:", "https:"].includes(url.protocol) ||
    !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  )
    throw new Error("Browser fixtures require an isolated loopback origin");
  const origin = url.origin;
  const port = url.port || (url.protocol === "https:" ? "443" : "80");
  const metadata: unknown = JSON.parse(
    await readFile(resolve("tmp", `browser-${port}-schema.json`), "utf8"),
  );
  if (
    !record(metadata) ||
    typeof metadata.schema !== "string" ||
    !/^browser_[a-f0-9]{16}$/.test(metadata.schema) ||
    typeof metadata.baseURL !== "string" ||
    new URL(metadata.baseURL).origin !== origin
  )
    throw new Error(
      "Browser fixtures require matching isolated-schema metadata",
    );
  const originKey = createHash("sha256")
    .update(origin)
    .digest("hex")
    .slice(0, 16);
  return {
    origin,
    schema: metadata.schema,
    cachePath: resolve(
      "tmp",
      `browser-${metadata.schema}-${originKey}-bootstrap.json`,
    ),
  };
}

function requireSuccess(response: APIResponse, operation: string) {
  if (!response.ok())
    throw new Error(`${operation} failed (HTTP ${response.status()})`);
}

async function validatedIdentity(
  api: APIRequestContext,
  origin: string,
  expected?: Pick<CachedSession, "userId" | "workspaceId">,
  account: ExpectedAccount = { email: browserBootstrap.email, role: "admin" },
): Promise<BrowserFixtureIdentity | null> {
  const response = await api.get(`${origin}/api/auth/me`);
  if (response.status() === 401) return null;
  requireSuccess(response, "Browser fixture session validation");
  const identity: unknown = await response.json();
  if (
    !record(identity) ||
    !record(identity.user) ||
    !record(identity.workspace) ||
    typeof identity.user.id !== "string" ||
    typeof identity.user.name !== "string" ||
    identity.user.email !== account.email ||
    identity.user.role !== account.role ||
    typeof identity.workspace.id !== "string" ||
    typeof identity.workspace.name !== "string" ||
    (expected &&
      (identity.user.id !== expected.userId ||
        identity.workspace.id !== expected.workspaceId))
  )
    throw new Error("Browser fixture session is not the expected account");
  return identity as BrowserFixtureIdentity;
}

function sessionState(state: StorageState, origin: string): StorageState {
  const hostname = new URL(origin).hostname.replace(/^\[|\]$/g, "");
  const cookies = state.cookies.filter(
    (cookie) =>
      cookie.name === "mill_session" &&
      cookie.domain.replace(/^\./, "") === hostname &&
      cookie.path === "/",
  );
  if (cookies.length !== 1)
    throw new Error("Browser fixture requires one real Mill session cookie");
  return { cookies, origins: [] };
}

async function saveSession(
  sandbox: Sandbox,
  api: APIRequestContext,
  identity: BrowserFixtureIdentity,
): Promise<StorageState> {
  const storageState = sessionState(await api.storageState(), sandbox.origin);
  const cache: CachedSession = {
    origin: sandbox.origin,
    schema: sandbox.schema,
    userId: identity.user.id,
    workspaceId: identity.workspace.id,
    storageState,
  };
  const temporary = `${sandbox.cachePath}.${randomBytes(8).toString("hex")}.tmp`;
  try {
    await writeFile(temporary, JSON.stringify(cache), {
      mode: 0o600,
      flag: "wx",
    });
    await rename(temporary, sandbox.cachePath);
  } finally {
    await rm(temporary, { force: true });
  }
  return storageState;
}

async function cachedSession(sandbox: Sandbox): Promise<CachedSession | null> {
  let contents: string;
  try {
    const info = await stat(sandbox.cachePath);
    if (!info.isFile() || (info.mode & 0o777) !== 0o600)
      throw new Error(
        "Browser fixture session cache must be a private 0600 file",
      );
    contents = await readFile(sandbox.cachePath, "utf8");
  } catch (error) {
    if (record(error) && error.code === "ENOENT") return null;
    throw error;
  }
  const cache: unknown = JSON.parse(contents);
  if (
    !record(cache) ||
    cache.origin !== sandbox.origin ||
    cache.schema !== sandbox.schema ||
    typeof cache.userId !== "string" ||
    typeof cache.workspaceId !== "string" ||
    !record(cache.storageState) ||
    !Array.isArray(cache.storageState.cookies) ||
    !Array.isArray(cache.storageState.origins)
  )
    throw new Error(
      "Browser fixture session cache does not match this installation",
    );
  return cache as CachedSession;
}

export async function rememberBrowserBootstrap(
  api: APIRequestContext,
  baseURL: string,
): Promise<BrowserFixtureSession> {
  const sandbox = await sandboxFor(baseURL);
  const identity = await validatedIdentity(api, sandbox.origin);
  if (!identity)
    throw new Error(
      "Complete the real bootstrap sign-in before recording its session",
    );
  const storageState = await saveSession(sandbox, api, identity);
  return { origin: sandbox.origin, identity, storageState };
}

export async function getBrowserBootstrap(
  baseURL: string,
): Promise<BrowserBootstrapFixture> {
  const sandbox = await sandboxFor(baseURL);
  const cache = await cachedSession(sandbox);
  if (cache) {
    const api = await request.newContext({
      baseURL: sandbox.origin,
      extraHTTPHeaders: { Origin: sandbox.origin },
      storageState: cache.storageState,
    });
    try {
      const identity = await validatedIdentity(api, sandbox.origin, cache);
      if (identity)
        return {
          api,
          origin: sandbox.origin,
          identity,
          storageState: sessionState(await api.storageState(), sandbox.origin),
        };
    } catch (error) {
      await api.dispose();
      throw error;
    }
    await api.dispose();
    await rm(sandbox.cachePath, { force: true });
  }
  const api = await request.newContext({
    baseURL: sandbox.origin,
    extraHTTPHeaders: { Origin: sandbox.origin },
  });
  try {
    const statusResponse = await api.get("/api/auth/status");
    requireSuccess(statusResponse, "Browser fixture installation lookup");
    const status: unknown = await statusResponse.json();
    if (!record(status) || typeof status.setupRequired !== "boolean")
      throw new Error(
        "Browser fixture installation lookup returned invalid data",
      );
    const authentication = await api.post(
      status.setupRequired ? "/api/auth/setup" : "/api/auth/login",
      {
        data: status.setupRequired
          ? browserBootstrap
          : {
              email: browserBootstrap.email,
              password: browserBootstrap.password,
            },
      },
    );
    requireSuccess(authentication, "Browser fixture bootstrap authentication");
    const identity = await validatedIdentity(
      api,
      sandbox.origin,
      cache ?? undefined,
    );
    if (!identity)
      throw new Error(
        "Browser fixture bootstrap authentication did not create a session",
      );
    const storageState = await saveSession(sandbox, api, identity);
    return { api, origin: sandbox.origin, identity, storageState };
  } catch (error) {
    await api.dispose();
    throw error;
  }
}

export async function authenticateBrowserFixture(
  page: Page,
  fixture: BrowserFixtureSession,
) {
  await sandboxFor(fixture.origin);
  await page.context().clearCookies();
  await page
    .context()
    .addCookies(sessionState(fixture.storageState, fixture.origin).cookies);
  const identity = await validatedIdentity(
    page.request,
    fixture.origin,
    {
      userId: fixture.identity.user.id,
      workspaceId: fixture.identity.workspace.id,
    },
    fixture.identity.user,
  );
  if (!identity)
    throw new Error("The real browser fixture session has expired");
}

export async function getBrowserRoleFixture(
  baseURL: string,
  role: "member" | "viewer",
): Promise<BrowserBootstrapFixture> {
  const sandbox = await sandboxFor(baseURL);
  sandbox.cachePath = sandbox.cachePath.replace(
    /-bootstrap\.json$/,
    `-${role}.json`,
  );
  const account = {
    email: `browser-fixture-${role}@example.test`,
    name: `Browser fixture ${role}`,
    password: "Browser-role-fixture-password-42",
    role,
  };
  const cache = await cachedSession(sandbox);
  const api = await request.newContext({
    baseURL: sandbox.origin,
    extraHTTPHeaders: { Origin: sandbox.origin },
    ...(cache ? { storageState: cache.storageState } : {}),
  });
  try {
    if (cache) {
      const identity = await validatedIdentity(
        api,
        sandbox.origin,
        cache,
        account,
      );
      if (identity)
        return {
          api,
          origin: sandbox.origin,
          identity,
          storageState: sessionState(await api.storageState(), sandbox.origin),
        };
      await rm(sandbox.cachePath, { force: true });
    }
    const bootstrap = await getBrowserBootstrap(baseURL);
    let invitationToken: string | undefined;
    try {
      const response = await bootstrap.api.get("/api/auth/members");
      requireSuccess(response, "Browser fixture role account lookup");
      const members: unknown = await response.json();
      if (!record(members) || !Array.isArray(members.items))
        throw new Error(
          "Browser fixture role account lookup returned invalid data",
        );
      const existing = members.items.find(
        (item: unknown) => record(item) && item.email === account.email,
      );
      if (existing) {
        if (!record(existing) || existing.role !== role)
          throw new Error("A pooled browser fixture account changed role");
      } else {
        if (cache)
          throw new Error("A pooled browser fixture account was removed");
        const invitation = await bootstrap.api.post("/api/auth/invitations", {
          data: { email: account.email, role },
        });
        requireSuccess(invitation, "Browser fixture role invitation");
        const invited: unknown = await invitation.json();
        if (!record(invited) || typeof invited.token !== "string")
          throw new Error(
            "Browser fixture role invitation returned invalid data",
          );
        invitationToken = invited.token;
      }
    } finally {
      await bootstrap.api.dispose();
    }
    const authentication = await api.post(
      invitationToken ? "/api/auth/accept-invitation" : "/api/auth/login",
      {
        data: invitationToken
          ? {
              token: invitationToken,
              name: account.name,
              password: account.password,
            }
          : { email: account.email, password: account.password },
      },
    );
    requireSuccess(authentication, "Browser fixture role authentication");
    const identity = await validatedIdentity(
      api,
      sandbox.origin,
      cache ?? undefined,
      account,
    );
    if (!identity)
      throw new Error(
        "Browser fixture role authentication did not create a session",
      );
    const storageState = await saveSession(sandbox, api, identity);
    return { api, origin: sandbox.origin, identity, storageState };
  } catch (error) {
    await api.dispose();
    throw error;
  }
}

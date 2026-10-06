import { randomBytes } from "node:crypto";
import postgres from "postgres";
process.env.DATABASE_URL ??=
  "postgres://mill:mill-test-disposable@127.0.0.1:55432/mill";
process.env.MILL_BASE_URL ??= "http://localhost:4321";
process.env.MILL_SECRET ??=
  "mill-integration-only-32-byte-secret-never-production";
process.env.ALLOW_INSECURE_LOCALHOST = "true";
process.env.NODE_ENV = "test";
process.env.MILL_DB_SCHEMA ??= `test_${randomBytes(8).toString("hex")}`;
const admin = postgres(process.env.DATABASE_URL, { max: 1 });
await admin.unsafe(
  `CREATE SCHEMA IF NOT EXISTS "${process.env.MILL_DB_SCHEMA}"`,
);
await admin.end();
const { sql } = await import("../packages/database/src/index.js");
const { migrate } = await import("../packages/database/src/migrate.js");
await migrate();
export { sql };
export async function resetDatabase() {
  const rows =
    await sql`SELECT tablename FROM pg_tables WHERE schemaname=${process.env.MILL_DB_SCHEMA!} AND tablename<>'mill_migrations'`;
  if (rows.length)
    await sql.unsafe(
      `TRUNCATE ${rows.map((r) => `"${r.tablename}"`).join(",")} RESTART IDENTITY CASCADE`,
    );
}
export async function cleanupDatabase() {
  await sql.unsafe(`DROP SCHEMA "${process.env.MILL_DB_SCHEMA}" CASCADE`);
  await sql.end();
}
export async function request(
  path: string,
  options: {
    method?: string;
    body?: unknown;
    token?: string;
    cookie?: string;
    headers?: Record<string, string>;
  } = {},
) {
  const { app } = await import("../apps/api/src/app.js");
  const headers: Record<string, string> = {
    Origin: process.env.MILL_BASE_URL!,
    "Content-Type": "application/json",
    ...options.headers,
  };
  if (options.token) headers.Authorization = `Bearer ${options.token}`;
  if (options.cookie) headers.Cookie = options.cookie;
  return app.request(path, {
    method: options.method ?? (options.body ? "POST" : "GET"),
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
}
export async function setupUser(overrides: Record<string, unknown> = {}) {
  const response = await request("/api/auth/setup", {
    body: {
      workspaceName: "Test workspace",
      name: "Admin",
      email: "admin@example.test",
      password: "Secure test passphrase 42!",
      ...overrides,
    },
  });
  const body = await response.json();
  if (!response.ok) throw new Error(`Setup failed: ${JSON.stringify(body)}`);
  const cookie = response.headers.get("set-cookie")?.split(";")[0] ?? "";
  return { cookie, body, user: body.user };
}

export async function setupOAuth(
  cookie: string,
  input: {
    scopes?: ("read" | "write")[];
    boardIds?: string[];
    idempotencyKey?: string;
  } = {},
) {
  const { digest, secret } =
    await import("../apps/api/src/external/protocol.js");
  const { app } = await import("../apps/api/src/app.js");
  const redirectUri = "http://127.0.0.1:4182/callback";
  const resource = `${process.env.MILL_BASE_URL}/mcp`;
  const registered = await request("/oauth/register", {
    body: {
      client_name: "Integration MCP client",
      redirect_uris: [redirectUri],
      token_endpoint_auth_method: "none",
    },
  });
  if (registered.status !== 201)
    throw new Error(`OAuth registration failed: ${registered.status}`);
  const client = (await registered.json()) as { client_id: string };
  const verifier = secret();
  const state = secret();
  const authorization = await request(
    `/oauth/authorize?${new URLSearchParams({
      response_type: "code",
      client_id: client.client_id,
      redirect_uri: redirectUri,
      resource,
      scope: (input.scopes ?? ["read", "write"]).join(" "),
      state,
      code_challenge: digest(verifier),
      code_challenge_method: "S256",
    })}`,
  );
  if (authorization.status !== 302)
    throw new Error(`OAuth authorization failed: ${authorization.status}`);
  const requestId = new URL(
    authorization.headers.get("location")!,
  ).searchParams.get("request");
  if (!requestId)
    throw new Error("OAuth authorization did not create a consent request");
  const approval = await request(`/api/oauth/consent/${requestId}`, {
    cookie,
    ...(input.idempotencyKey
      ? { headers: { "Idempotency-Key": input.idempotencyKey } }
      : {}),
    body: {
      allow: true,
      ...(input.boardIds ? { boardIds: input.boardIds } : {}),
    },
  });
  if (!approval.ok)
    throw new Error(`OAuth approval failed: ${approval.status}`);
  const callback = new URL(
    ((await approval.json()) as { redirectTo: string }).redirectTo,
  );
  if (callback.searchParams.get("state") !== state)
    throw new Error("OAuth state did not match");
  const code = callback.searchParams.get("code");
  if (!code) throw new Error("OAuth approval did not return a code");
  const exchange = await app.request("/oauth/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      client_id: client.client_id,
      redirect_uri: redirectUri,
      resource,
      code,
      code_verifier: verifier,
    }),
  });
  if (!exchange.ok)
    throw new Error(`OAuth exchange failed: ${exchange.status}`);
  const issued = (await exchange.json()) as { access_token: string };
  const [credential] = await sql<
    {
      id: string;
      userId: string;
      scopes: string[];
      tokenType: string;
    }[]
  >`
    SELECT c.id,c.user_id,c.scopes,c.token_type
    FROM credentials c WHERE c.token_hash=${digest(issued.access_token)}`;
  if (!credential) throw new Error("OAuth credential was not persisted");
  return { token: issued.access_token, credential };
}

export async function callMcpTool(
  token: string,
  name: string,
  args: Record<string, unknown> = {},
) {
  const { app } = await import("../apps/api/src/app.js");
  const response = await app.request("/mcp", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name, arguments: args },
    }),
  });
  const payload = (await response.json()) as {
    result?: {
      isError?: boolean;
      structuredContent?: Record<string, unknown>;
      content: { type: string; text?: string }[];
    };
    error?: unknown;
  };
  return { response, result: payload.result, error: payload.error };
}

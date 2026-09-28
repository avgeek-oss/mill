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

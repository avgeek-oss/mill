import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import postgres from "postgres";
if (!process.env.DATABASE_URL) process.loadEnvFile(".env");
if (!process.env.DATABASE_URL)
  throw new Error("Set DATABASE_URL for the isolated screenshot database");
const schema = `docs_screenshot_${randomBytes(8).toString("hex")}`;
const admin = postgres(process.env.DATABASE_URL, { max: 1 });
await admin.unsafe(`CREATE SCHEMA "${schema}"`);
const port = process.env.MILL_SCREENSHOT_PORT ?? "4323";
const baseURL = process.env.MILL_SCREENSHOT_BASE_URL ?? "http://localhost:4323";
const metadata = resolve("tmp", `docs-screenshot-${port}-schema.json`);
await mkdir(resolve("tmp"), { recursive: true });
const metadataDraft = `${metadata}.${schema}.tmp`;
await writeFile(metadataDraft, JSON.stringify({ schema, baseURL }), {
  mode: 0o600,
});
await rename(metadataDraft, metadata);
const child = spawn(
  process.execPath,
  ["--import", "tsx", "apps/api/src/index.ts"],
  {
    stdio: "inherit",
    env: {
      ...process.env,
      MILL_DB_SCHEMA: schema,
      MILL_BASE_URL: baseURL,
      PORT: port,
      NODE_ENV: "test",
      ALLOW_INSECURE_LOCALHOST: "true",
    },
  },
);
for (const signal of ["SIGTERM", "SIGINT"] as const)
  process.once(signal, () => child.kill(signal));
const code = await new Promise<number>((resolve) =>
  child.once("exit", (code) => resolve(code ?? 0)),
);
await admin.unsafe(`DROP SCHEMA "${schema}" CASCADE`);
await admin.end();
await rm(metadata, { force: true });
process.exitCode = code;

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
const webPort = process.env.MILL_SCREENSHOT_PORT ?? "4323";
const apiPort = process.env.MILL_SCREENSHOT_API_PORT ?? "4324";
const webURL = `http://localhost:${webPort}`;
const apiURL = `http://localhost:${apiPort}`;
const metadata = resolve("tmp", `docs-screenshot-${webPort}-schema.json`);
await mkdir(resolve("tmp"), { recursive: true });
const metadataDraft = `${metadata}.${schema}.tmp`;
await writeFile(
  metadataDraft,
  JSON.stringify({ schema, baseURL: webURL, apiURL }),
  {
    mode: 0o600,
  },
);
await rename(metadataDraft, metadata);
const environment = {
  ...process.env,
  MILL_WEB_URL: webURL,
  MILL_API_URL: apiURL,
  NODE_ENV: "test",
};
const api = spawn(
  process.execPath,
  ["--import", "tsx", "apps/api/src/index.ts"],
  {
    stdio: "inherit",
    env: { ...environment, MILL_DB_SCHEMA: schema, PORT: apiPort },
  },
);
const web = spawn(
  process.execPath,
  ["--import", "tsx", "apps/web-server/src/index.ts"],
  {
    stdio: "inherit",
    env: { ...environment, PORT: webPort },
  },
);
const stop = () => {
  api.kill("SIGTERM");
  web.kill("SIGTERM");
};
for (const signal of ["SIGTERM", "SIGINT"] as const) process.once(signal, stop);
const exits = [api, web].map(
  (child) =>
    new Promise<number>((resolveExit) =>
      child.once("exit", (code) => resolveExit(code ?? 0)),
    ),
);
const first = await Promise.race(exits);
stop();
await Promise.all(
  exits.map((promise) =>
    Promise.race([
      promise,
      new Promise((resolveExit) => setTimeout(resolveExit, 5000)),
    ]),
  ),
);
await admin.unsafe(`DROP SCHEMA "${schema}" CASCADE`);
await admin.end();
await rm(metadata, { force: true });
process.exitCode = first;

import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import {
  mkdir,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { createConnection } from "node:net";
import { createRequire } from "node:module";
import { relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";

const root = fileURLToPath(new URL("../", import.meta.url));
const require = createRequire(import.meta.url);
const pause = (milliseconds) =>
  new Promise((resolvePause) => setTimeout(resolvePause, milliseconds));

function configuration() {
  const configuredPort = process.env.MILL_BROWSER_PORT;
  const url = new URL(
    process.env.MILL_BROWSER_BASE_URL ??
      `http://localhost:${configuredPort ?? "4323"}`,
  );
  if (
    url.protocol !== "http:" ||
    !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  )
    throw new Error("Browser verification requires a loopback HTTP origin");
  const port = Number(url.port || "80");
  if (
    !Number.isInteger(port) ||
    port < 1 ||
    port > 65535 ||
    (configuredPort && Number(configuredPort) !== port)
  )
    throw new Error("MILL_BROWSER_PORT must match MILL_BROWSER_BASE_URL");
  return { origin: url.origin, port };
}

async function distribution() {
  const directory = resolve(root, "apps/web/dist");
  const files = [];
  async function walk(path) {
    for (const entry of await readdir(path, { withFileTypes: true })) {
      const target = resolve(path, entry.name);
      if (entry.isDirectory()) await walk(target);
      else if (entry.isFile()) {
        const bytes = await readFile(target);
        files.push({
          path: relative(directory, target).replaceAll("\\", "/"),
          bytes: bytes.length,
          sha256: createHash("sha256").update(bytes).digest("hex"),
        });
      } else
        throw new Error(
          "Frontend verification does not allow linked build files",
        );
    }
  }
  await walk(directory);
  files.sort((a, b) => a.path.localeCompare(b.path, "en"));
  if (!files.some((file) => file.path === "index.html"))
    throw new Error("Build the frontend before browser verification");
  return {
    directory: "apps/web/dist",
    sha256: createHash("sha256").update(JSON.stringify(files)).digest("hex"),
    files,
  };
}

async function listenerAt(host, port) {
  return new Promise((resolveListener, reject) => {
    const socket = createConnection({ host, port });
    socket.setTimeout(1000);
    socket.once("connect", () => {
      socket.destroy();
      resolveListener(true);
    });
    socket.once("error", (error) => {
      socket.destroy();
      if (
        [
          "ECONNREFUSED",
          "EAFNOSUPPORT",
          "ENETUNREACH",
          "EADDRNOTAVAIL",
        ].includes(error.code)
      )
        resolveListener(false);
      else reject(new Error(`Cannot verify browser port: ${error.code}`));
    });
    socket.once("timeout", () => {
      socket.destroy();
      reject(new Error("Browser port inspection timed out"));
    });
  });
}

async function requireUnusedPort(port) {
  const listeners = await Promise.all([
    listenerAt("127.0.0.1", port),
    listenerAt("::1", port),
  ]);
  if (listeners.some(Boolean))
    throw new Error(`Browser port ${port} already has a listener`);
}

async function metadataAt(path, origin) {
  let contents;
  try {
    contents = await readFile(path, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
  let metadata;
  try {
    metadata = JSON.parse(contents);
  } catch {
    throw new Error("Browser server metadata is invalid");
  }
  if (
    !metadata ||
    typeof metadata.schema !== "string" ||
    !/^browser_[a-f0-9]{16}$/.test(metadata.schema) ||
    metadata.baseURL !== origin
  )
    throw new Error("Browser server metadata does not match this isolated run");
  return metadata;
}

async function requireMissingMetadata(path) {
  try {
    await stat(path);
  } catch (error) {
    if (error.code === "ENOENT") return;
    throw error;
  }
  throw new Error("An earlier browser installation still has server metadata");
}

function databaseConnection() {
  if (!process.env.DATABASE_URL) {
    try {
      process.loadEnvFile(resolve(root, ".env"));
    } catch {
      throw new Error(
        "Set DATABASE_URL or provide .env for browser verification",
      );
    }
  }
  if (!process.env.DATABASE_URL)
    throw new Error("Set DATABASE_URL for browser verification");
  return process.env.DATABASE_URL;
}

async function requireRemovedSchema(schema, databaseURL) {
  let database;
  let removed = false;
  let failed = false;
  try {
    database = postgres(databaseURL, {
      max: 1,
      connect_timeout: 5,
      connection: {
        statement_timeout: 3000,
        default_transaction_read_only: "on",
      },
      onnotice: () => {},
    });
    const [row] = await database`
      SELECT EXISTS (
        SELECT 1 FROM pg_catalog.pg_namespace WHERE nspname = ${schema}
      ) AS present
    `;
    removed = row?.present === false;
  } catch {
    failed = true;
  } finally {
    if (database) {
      try {
        await database.end({ timeout: 5 });
      } catch {
        failed = true;
      }
    }
  }
  if (failed)
    throw new Error(
      "PostgreSQL did not confirm isolated browser schema removal",
    );
  if (!removed)
    throw new Error(
      "The observed isolated browser schema remains in PostgreSQL",
    );
}

async function verifyCleanup(metadataPath, schema, port, databaseURL) {
  await requireUnusedPort(port);
  await requireMissingMetadata(metadataPath);
  if (!schema || !/^browser_[a-f0-9]{16}$/.test(schema))
    throw new Error("No isolated browser schema was observed");
  const leftovers = (await readdir(resolve(root, "tmp"))).filter((name) =>
    name.startsWith(`browser-${schema}-`),
  );
  if (leftovers.length)
    throw new Error("The isolated browser session cache was not removed");
  await requireRemovedSchema(schema, databaseURL);
}

async function runFile(
  file,
  config,
  evidence,
  expectedDistribution,
  databaseURL,
) {
  const slug = file.replace(/\.spec\.ts$/, "");
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(slug))
    throw new Error("Browser spec names must have a safe artifact basename");
  const report = resolve(evidence, slug);
  const output = resolve(root, "test-results", slug);
  const metadataPath = resolve(
    root,
    "tmp",
    `browser-${config.port}-schema.json`,
  );
  const result = {
    file: `tests/browser/${file}`,
    startedAt: new Date().toISOString(),
    exitCode: null,
    signal: null,
    schema: null,
    log: `playwright-report/${slug}.log`,
    output: `test-results/${slug}`,
    cleanupVerified: false,
    databaseSchemaRemoved: false,
    errors: [],
  };
  await rm(report, { recursive: true, force: true });
  await rm(output, { recursive: true, force: true });
  await mkdir(report, { recursive: true });
  const log = createWriteStream(resolve(evidence, `${slug}.log`), {
    mode: 0o600,
  });
  let logError;
  log.on("error", (error) => {
    logError = error;
  });
  let monitoring;
  try {
    await requireUnusedPort(config.port);
    await requireMissingMetadata(metadataPath);
    if ((await distribution()).sha256 !== expectedDistribution.sha256)
      throw new Error("The frontend distribution changed during verification");
    if (interrupted) throw new Error("Browser verification was interrupted");
    const child = spawn(
      process.execPath,
      [
        require.resolve("@playwright/test/cli"),
        "test",
        result.file,
        "--workers=1",
        `--output=${output}`,
        "--reporter=list,html",
      ],
      {
        cwd: root,
        stdio: ["ignore", "pipe", "pipe"],
        env: {
          ...process.env,
          MILL_BROWSER_PORT: String(config.port),
          MILL_BROWSER_BASE_URL: config.origin,
          PLAYWRIGHT_HTML_OUTPUT_DIR: report,
          PLAYWRIGHT_HTML_OPEN: "never",
          PLAYWRIGHT_NO_COPY_PROMPT: "1",
        },
      },
    );
    activeChild = child;
    for (const [source, destination] of [
      [child.stdout, process.stdout],
      [child.stderr, process.stderr],
    ]) {
      source.pipe(destination, { end: false });
      source.pipe(log, { end: false });
    }
    let closed = false;
    const monitorErrors = new Set();
    monitoring = (async () => {
      while (!closed) {
        try {
          const metadata = await metadataAt(metadataPath, config.origin);
          if (metadata) {
            if (result.schema && result.schema !== metadata.schema)
              monitorErrors.add("Browser schema changed during a single file");
            else result.schema = metadata.schema;
          }
        } catch (error) {
          monitorErrors.add(error.message);
        }
        await pause(100);
      }
    })();
    try {
      const completion = await new Promise((resolveChild, reject) => {
        child.once("error", reject);
        child.once("close", (exitCode, signal) =>
          resolveChild({ exitCode, signal }),
        );
      });
      result.exitCode = completion.exitCode;
      result.signal = completion.signal;
      if (completion.exitCode !== 0)
        result.errors.push(
          `Playwright exited ${completion.exitCode ?? completion.signal}`,
        );
    } finally {
      closed = true;
      await monitoring;
      activeChild = null;
    }
    result.errors.push(...monitorErrors);
    await verifyCleanup(metadataPath, result.schema, config.port, databaseURL);
    result.cleanupVerified = true;
    result.databaseSchemaRemoved = true;
    if ((await distribution()).sha256 !== expectedDistribution.sha256)
      throw new Error("The frontend distribution changed during verification");
  } catch (error) {
    result.errors.push(error.message);
  } finally {
    await new Promise((resolveLog) => log.end(resolveLog));
    if (logError)
      result.errors.push("Browser verification log could not be retained");
    result.finishedAt = new Date().toISOString();
    await writeFile(
      resolve(report, "result.json"),
      JSON.stringify(result, null, 2),
    );
  }
  return result;
}

let activeChild = null;
let interrupted = false;
for (const signal of ["SIGINT", "SIGTERM"])
  process.once(signal, () => {
    interrupted = true;
    activeChild?.kill("SIGINT");
  });

async function main() {
  if (process.argv.slice(2).length) {
    if (process.argv.length === 3 && process.argv[2] === "--help") {
      console.log(
        "Usage: node tools/browser-verify.mjs\nBuild first. Runs every browser spec sequentially in a fresh isolated installation.\nUse pnpm exec playwright test <file> for focused checks.",
      );
      return;
    }
    throw new Error(
      "The complete browser verifier does not accept test filters",
    );
  }
  const config = configuration();
  const databaseURL = databaseConnection();
  const files = (await readdir(resolve(root, "tests/browser")))
    .filter((file) => file.endsWith(".spec.ts"))
    .sort((a, b) => a.localeCompare(b, "en"));
  const journeys = files.filter((file) =>
    /^(?:00[-_])?journeys\.spec\.ts$/.test(file),
  );
  if (journeys.length !== 1)
    throw new Error(
      "Exactly one real first-installation journey spec is required",
    );
  files.splice(files.indexOf(journeys[0]), 1);
  files.unshift(journeys[0]);
  const evidence = resolve(root, "playwright-report");
  await mkdir(evidence, { recursive: true });
  await mkdir(resolve(root, "tmp"), { recursive: true });
  const builtDistribution = await distribution();
  const manifest = {
    startedAt: new Date().toISOString(),
    origin: config.origin,
    isolation: "one fresh browser-server schema per spec file",
    distribution: builtDistribution,
    results: [],
  };
  const saveManifest = () =>
    writeFile(
      resolve(evidence, "verification.json"),
      JSON.stringify(manifest, null, 2),
    );
  await saveManifest();
  for (const file of files) {
    if (interrupted) break;
    console.log(`\nVerifying ${file} in a fresh installation`);
    const result = await runFile(
      file,
      config,
      evidence,
      builtDistribution,
      databaseURL,
    );
    manifest.results.push(result);
    await saveManifest();
    if (result.errors.length)
      console.error(`FAIL ${file}: ${result.errors.join("; ")}`);
    else console.log(`PASS ${file}; isolated installation cleaned`);
  }
  manifest.finishedAt = new Date().toISOString();
  manifest.interrupted = interrupted;
  manifest.passed =
    !interrupted &&
    manifest.results.length === files.length &&
    manifest.results.every((result) => result.errors.length === 0);
  await saveManifest();
  process.exitCode = interrupted ? 130 : manifest.passed ? 0 : 1;
}

await main().catch((error) => {
  console.error(`Browser verification failed: ${error.message}`);
  process.exitCode = 1;
});

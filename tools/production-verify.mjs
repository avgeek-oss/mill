import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { githubPackagesToken } from "./package-registry.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const runId = `${Date.now()}-${randomBytes(4).toString("hex")}`;
const project = `mill-verify-${runId}`;
const recoveryProject = `${project}-restore`;
const image = `mill:verify-${runId}`;
const scannerCache = `${project}-scanner-cache`;
const evidence = resolve(root, "tmp", "verification", project);
const privateDirectory = await mkdtemp(join(tmpdir(), "mill-verify-"));
const controller = new AbortController();
for (const signal of ["SIGINT", "SIGTERM"])
  process.once(signal, () => controller.abort());
const secrets = [
  randomBytes(32).toString("hex"),
  randomBytes(48).toString("hex"),
  `${randomBytes(32).toString("base64url")}Aa1!`,
];
let packageToken;
const results = [];
const projects = [];
await mkdir(evidence, { recursive: true, mode: 0o700 });
function redact(value) {
  for (const secret of secrets) value = value.replaceAll(secret, "[redacted]");
  return value;
}
async function run(
  name,
  command,
  args,
  extraEnv = {},
  timeout = 120_000,
  cleanup = false,
) {
  const started = Date.now();
  let output = "";
  let exitCode;
  try {
    const child = spawn(command, args, {
      cwd: root,
      env: {
        ...process.env,
        ...(packageToken ? { NODE_AUTH_TOKEN: packageToken } : {}),
        ...extraEnv,
      },
      stdio: ["ignore", "pipe", "pipe"],
      signal: cleanup ? undefined : controller.signal,
    });
    const timer = setTimeout(() => child.kill("SIGTERM"), timeout);
    child.stdout.on("data", (data) => {
      output += data;
    });
    child.stderr.on("data", (data) => {
      output += data;
    });
    exitCode = await new Promise((resolveCode, reject) => {
      child.once("error", reject);
      child.once("close", resolveCode);
    }).finally(() => clearTimeout(timer));
    assert.equal(exitCode, 0, `${name} must pass`);
    console.log(`PASS ${name}`);
    return output.trim();
  } finally {
    await writeFile(join(evidence, `${name}.log`), redact(output), {
      mode: 0o600,
    });
    results.push({
      step: name,
      exitCode: exitCode ?? null,
      elapsedMs: Date.now() - started,
    });
    await writeFile(
      join(evidence, "results.json"),
      JSON.stringify({ project, image, results }, null, 2),
      { mode: 0o600 },
    );
  }
}
async function port() {
  const server = createServer();
  await new Promise((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolveListen);
  });
  const number = server.address().port;
  await new Promise((resolveClose, reject) =>
    server.close((error) => (error ? reject(error) : resolveClose())),
  );
  return number;
}
function databaseArguments(configuration, statement) {
  return [
    ...configuration.compose,
    "exec",
    "-T",
    "postgres",
    "psql",
    "-U",
    "mill",
    "-d",
    "mill",
    "-v",
    "ON_ERROR_STOP=1",
    "--tuples-only",
    "--no-align",
    "-c",
    statement,
  ];
}
async function configuration(name, targetPort, publicOrigin) {
  const envFile = join(privateDirectory, `${name}.env`);
  await writeFile(
    envFile,
    [
      `POSTGRES_PASSWORD=${secrets[0]}`,
      `MILL_SECRET=${secrets[1]}`,
      `MILL_BASE_URL=${publicOrigin ?? `http://127.0.0.1:${targetPort}`}`,
      `MILL_PORT=${targetPort}`,
      "MILL_BIND_ADDRESS=127.0.0.1",
      `ALLOW_INSECURE_LOCALHOST=${publicOrigin ? "false" : "true"}`,
      `MILL_IMAGE=${image}`,
      `SOURCE_COMMIT=${sourceRevision}${sourceDirty ? "-dirty" : ""}`,
      "",
    ].join("\n"),
    { mode: 0o600 },
  );
  const compose = [
    "compose",
    "--project-name",
    name,
    "--env-file",
    envFile,
    "--file",
    "docker-compose.yml",
  ];
  projects.push(compose);
  return {
    envFile,
    compose,
    url: publicOrigin ?? `http://127.0.0.1:${targetPort}`,
  };
}
const state = join(evidence, "fixture-state.json");
const backup = join(privateDirectory, "mill.dump");
const staticManifest = join(evidence, "static-content-manifest.json");
let primary;
let secureProxy;
let sourceRevision;
let sourceDirty;
try {
  packageToken = await githubPackagesToken();
  secrets.push(packageToken);
  sourceRevision = await run("source-revision", "git", ["rev-parse", "HEAD"]);
  sourceDirty = Boolean(
    await run("source-working-tree", "git", ["status", "--porcelain"]),
  );
  await run("docker-required", "docker", [
    "info",
    "--format",
    "{{.ServerVersion}}",
  ]);
  const architecture = (value) =>
    ({ x86_64: "amd64", aarch64: "arm64" })[value] ?? value;
  const hostArchitecture = architecture(
    await run("docker-native-architecture", "docker", [
      "info",
      "--format",
      "{{.Architecture}}",
    ]),
  );
  if (process.env.MILL_VERIFY_EXPECT_ARCH)
    assert.equal(
      hostArchitecture,
      process.env.MILL_VERIFY_EXPECT_ARCH,
      "Production gate must run on the requested native architecture",
    );
  primary = await configuration(project, await port());
  await run("compose-configuration", "docker", [
    ...primary.compose,
    "config",
    "--quiet",
  ]);
  await run(
    "production-image-build",
    "docker",
    [...primary.compose, "build", "--pull", "mill"],
    {},
    1_800_000,
  );
  assert.equal(
    architecture(
      await run("production-image-architecture", "docker", [
        "image",
        "inspect",
        image,
        "--format",
        "{{.Architecture}}",
      ]),
    ),
    hostArchitecture,
    "The exercised production image must use the Docker host's native architecture",
  );
  await run(
    "fresh-production-start",
    "docker",
    [
      ...primary.compose,
      "up",
      "--no-build",
      "--detach",
      "--wait",
      "--wait-timeout",
      "180",
    ],
    {},
    240_000,
  );
  const builtStaticManifest = await run(
    "production-static-manifest",
    "docker",
    [
      ...primary.compose,
      "exec",
      "-T",
      "--env",
      "MILL_STATIC_MODE=manifest",
      "--env",
      "MILL_STATIC_ROOT=/app/apps/web/dist",
      "mill",
      "node",
      "--input-type=module",
      "-e",
      await readFile(resolve(root, "tools/static-smoke.mjs"), "utf8"),
    ],
  );
  const staticContent = JSON.parse(builtStaticManifest);
  assert.equal(staticContent.format, "mill-static-content-v1");
  await writeFile(staticManifest, JSON.stringify(staticContent, null, 2), {
    mode: 0o600,
  });
  const verifyEnv = {
    MILL_VERIFY_URL: primary.url,
    MILL_VERIFY_PASSWORD: secrets[2],
    MILL_VERIFY_STATE: state,
    MILL_VERIFY_OAUTH_TOKEN_FILE: join(privateDirectory, "oauth-token"),
    MILL_VERIFY_STATIC_MANIFEST: staticManifest,
  };
  await run("fresh-install-journey", "node", ["tools/install-smoke.mjs"], {
    ...verifyEnv,
    MILL_VERIFY_MODE: "fresh",
  });
  const user = await run("image-non-root", "docker", [
    "image",
    "inspect",
    image,
    "--format",
    "{{.Config.User}}",
  ]);
  assert.equal(user, "node");
  await run("runtime-production-dependencies", "docker", [
    ...primary.compose,
    "exec",
    "-T",
    "mill",
    "node",
    "--input-type=module",
    "-e",
    "import assert from 'node:assert/strict';import{existsSync}from'node:fs';assert.equal(existsSync('/app/node_modules/typescript'),false);assert.equal(existsSync('/usr/local/lib/node_modules/npm'),false);",
  ]);
  await run(
    "persistent-container-recreation",
    "docker",
    [
      ...primary.compose,
      "up",
      "--no-build",
      "--force-recreate",
      "--detach",
      "--wait",
      "mill",
    ],
    {},
    240_000,
  );
  await run(
    "restart-persistence",
    "node",
    ["tools/install-smoke.mjs"],
    verifyEnv,
  );
  await run("database-fault-stop", "docker", [
    ...primary.compose,
    "stop",
    "--timeout",
    "10",
    "postgres",
  ]);
  await run(
    "database-fault-health",
    "node",
    ["tools/health-smoke.mjs", "unavailable"],
    verifyEnv,
    15_000,
  );
  await run(
    "database-fault-restart",
    "docker",
    [
      ...primary.compose,
      "up",
      "--detach",
      "--wait",
      "--wait-timeout",
      "120",
      "postgres",
    ],
    {},
    150_000,
  );
  await run(
    "database-recovered-health",
    "node",
    ["tools/health-smoke.mjs", "recovered"],
    verifyEnv,
    15_000,
  );
  await run(
    "database-recovered-persistence",
    "node",
    ["tools/install-smoke.mjs"],
    verifyEnv,
  );
  const baselineChecksum = createHash("sha256")
    .update(
      await readFile(
        join(root, "packages/database/migrations/001_initial.sql"),
      ),
    )
    .digest("hex");
  const installedMigrations = JSON.parse(
    await run(
      "baseline-migration-record",
      "docker",
      databaseArguments(
        primary,
        "SELECT json_agg(json_build_object('name',name,'checksum',checksum) ORDER BY name)::text FROM mill_migrations",
      ),
    ),
  );
  assert.deepEqual(installedMigrations, [
    { name: "001_initial.sql", checksum: baselineChecksum },
  ]);
  const schemaShape = JSON.parse(
    await run(
      "baseline-current-schema",
      "docker",
      databaseArguments(
        primary,
        `SELECT json_build_object(
    'retiredTables',(SELECT count(*) FROM pg_tables WHERE schemaname=current_schema() AND tablename IN ('columns','agents','agent_boards','agent_members','retired_task_checklists','auth_audit')),
    'removedTaskColumns',(SELECT count(*) FROM information_schema.columns WHERE table_schema=current_schema() AND table_name='tasks' AND column_name IN ('agent_id','checklist','parent_id','column_id','position','labels','archived','deleted_at'))
  )::text`,
      ),
    ),
  );
  assert.deepEqual(schemaShape, {
    retiredTables: 0,
    removedTaskColumns: 0,
  });
  await run("packaged-idempotent-concurrent-migrations", "docker", [
    ...primary.compose,
    "exec",
    "-T",
    "mill",
    "node",
    "--input-type=module",
    "-e",
    `import {migrate} from '/app/dist/packages/database/src/migrate.js';import{closeDatabase}from'/app/dist/packages/database/src/index.js';try{await Promise.all([migrate(),migrate()])}finally{await closeDatabase()}`,
  ]);
  await run("packaged-checksum-protection", "docker", [
    ...primary.compose,
    "exec",
    "-T",
    "mill",
    "node",
    "--input-type=module",
    "-e",
    `import assert from 'node:assert/strict';import{mkdtemp,readFile,writeFile,rm}from'node:fs/promises';import{tmpdir}from'node:os';import{join}from'node:path';const directory=await mkdtemp(join(tmpdir(),'mill-checksum-'));process.env.MILL_MIGRATIONS_DIR=directory;const{migrate}=await import('/app/dist/packages/database/src/migrate.js');const{closeDatabase}=await import('/app/dist/packages/database/src/index.js');try{await writeFile(join(directory,'001_initial.sql'),(await readFile('/app/packages/database/migrations/001_initial.sql','utf8'))+'\\n-- altered checksum\\n');await assert.rejects(migrate(),/Migration changed: 001_initial.sql/)}finally{await closeDatabase();await rm(directory,{recursive:true,force:true})}`,
  ]);
  await run("backup-quiesce-application", "docker", [
    ...primary.compose,
    "stop",
    "mill",
  ]);
  const tables = JSON.parse(
    await run(
      "backup-table-inventory",
      "docker",
      databaseArguments(
        primary,
        "SELECT json_agg(tablename ORDER BY tablename)::text FROM pg_tables WHERE schemaname=current_schema()",
      ),
    ),
  );
  assert.ok(tables.length > 20);
  for (const table of tables) assert.match(table, /^[a-z_]+$/);
  const contentQuery = `SELECT jsonb_build_object(${tables.map((table) => `'${table}',(SELECT COALESCE(jsonb_agg(content ORDER BY content::text),'[]'::jsonb) FROM (SELECT to_jsonb(record) AS content FROM ${table} record) rows)`).join(",")})::text`;
  const savedData = JSON.parse(
    await run(
      "backup-retained-data",
      "docker",
      databaseArguments(primary, contentQuery),
    ),
  );
  await run("current-baseline-backup", "bash", [
    "tools/backup.sh",
    "--project",
    project,
    "--env-file",
    primary.envFile,
    "--output",
    backup,
  ]);
  const recovery = await configuration(
    recoveryProject,
    Number(new URL(primary.url).port),
  );
  await run(
    "empty-restore-postgres",
    "docker",
    [...recovery.compose, "up", "--detach", "--wait", "postgres"],
    {},
    240_000,
  );
  await run(
    "current-baseline-restore",
    "bash",
    [
      "tools/restore.sh",
      "--project",
      recoveryProject,
      "--confirm-project",
      recoveryProject,
      "--env-file",
      recovery.envFile,
      "--input",
      backup,
    ],
    {},
    240_000,
  );
  assert.deepEqual(
    JSON.parse(
      await run(
        "restored-data-before-traffic",
        "docker",
        databaseArguments(recovery, contentQuery),
      ),
    ),
    savedData,
  );
  await run(
    "restored-api-oauth-mcp-persistence",
    "node",
    ["tools/install-smoke.mjs"],
    { ...verifyEnv, MILL_VERIFY_URL: recovery.url },
    240_000,
  );
  await run(
    "restored-ready-health",
    "node",
    ["tools/health-smoke.mjs", "recovered"],
    { ...verifyEnv, MILL_VERIFY_URL: recovery.url },
    15_000,
  );
  const proxyKey = join(privateDirectory, "localhost.key");
  const proxyCertificate = join(privateDirectory, "localhost.crt");
  await run("https-proxy-certificate", "openssl", [
    "req",
    "-x509",
    "-newkey",
    "rsa:2048",
    "-nodes",
    "-sha256",
    "-days",
    "1",
    "-keyout",
    proxyKey,
    "-out",
    proxyCertificate,
    "-subj",
    "/CN=localhost",
    "-addext",
    "subjectAltName=IP:127.0.0.1",
  ]);
  const proxyBackendPort = await port();
  secureProxy = createHttpsServer(
    { key: await readFile(proxyKey), cert: await readFile(proxyCertificate) },
    (request, response) => {
      const upstream = httpRequest(
        {
          hostname: "127.0.0.1",
          port: proxyBackendPort,
          path: request.url,
          method: request.method,
          headers: { ...request.headers, "x-forwarded-proto": "https" },
        },
        (upstreamResponse) => {
          response.writeHead(
            upstreamResponse.statusCode,
            upstreamResponse.headers,
          );
          upstreamResponse.pipe(response);
        },
      );
      upstream.on("error", () => {
        response.writeHead(502);
        response.end();
      });
      request.pipe(upstream);
    },
  );
  await new Promise((resolveListen, reject) => {
    secureProxy.once("error", reject);
    secureProxy.listen(0, "127.0.0.1", resolveListen);
  });
  const proxyOrigin = `https://127.0.0.1:${secureProxy.address().port}`;
  const proxyProject = `${project}-https`;
  const proxyInstall = await configuration(
    proxyProject,
    proxyBackendPort,
    proxyOrigin,
  );
  await run(
    "https-proxy-production-start",
    "docker",
    [
      ...proxyInstall.compose,
      "up",
      "--no-build",
      "--detach",
      "--wait",
      "--wait-timeout",
      "180",
    ],
    {},
    240_000,
  );
  await run(
    "https-proxy-install-journey",
    "node",
    ["tools/install-smoke.mjs"],
    {
      ...verifyEnv,
      MILL_VERIFY_URL: proxyOrigin,
      MILL_VERIFY_STATE: join(evidence, "https-proxy-fixture-state.json"),
      MILL_VERIFY_OAUTH_TOKEN_FILE: join(privateDirectory, "https-oauth-token"),
      MILL_VERIFY_MODE: "fresh",
      NODE_EXTRA_CA_CERTS: proxyCertificate,
    },
    240_000,
  );
  await run(
    "production-image-security",
    "docker",
    [
      "run",
      "--rm",
      "--name",
      `${project}-scanner`,
      "--label",
      `mill.verification=${project}`,
      "--cpus",
      "2",
      "--memory",
      "2g",
      "--volume",
      "/var/run/docker.sock:/var/run/docker.sock",
      "--volume",
      `${scannerCache}:/root/.cache/trivy`,
      "--volume",
      `${evidence}:/verification`,
      "aquasec/trivy:0.74.0@sha256:62b1e65e8869bc4b4c6aa4fa2b21595256c7c2f6018a9d9ad61caf87187c1969",
      "image",
      "--scanners",
      "vuln",
      "--severity",
      "HIGH,CRITICAL",
      "--exit-code",
      "1",
      "--format",
      "json",
      "--output",
      "/verification/image-vulnerabilities.json",
      image,
    ],
    {},
    600_000,
  );
  const fixture = JSON.parse(await readFile(state, "utf8"));
  await writeFile(
    join(evidence, "evidence.json"),
    JSON.stringify(
      {
        project,
        image,
        sourceRevision,
        sourceDirty,
        primaryUrl: primary.url,
        fixture,
        baseline: {
          name: "001_initial.sql",
          checksum: baselineChecksum,
          verifiedMigrationRows: installedMigrations,
        },
        staticContent: {
          manifest: "static-content-manifest.json",
          resources: staticContent.resources.length,
        },
        restore:
          "Fresh current-schema custom-format PostgreSQL backup restored into an isolated empty project; all rows match before traffic, followed by real REST/OAuth/MCP persistence checks at the retained resource origin.",
        prelaunchCompatibility:
          "Historical prelaunch ledgers are rejected without modification. Conversion requires the explicitly guarded prelaunch conversion tool and a verified backup; this fresh-install gate does not claim a historical upgrade.",
        httpsProxy: {
          origin: proxyOrigin,
          project: proxyProject,
          certificate: "disposable trusted loopback certificate",
        },
        completedAt: new Date().toISOString(),
      },
      null,
      2,
    ),
    { mode: 0o600 },
  );
  console.log(`Production verification evidence: ${evidence}`);
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
  if (primary) {
    await run(
      "failure-container-state",
      "docker",
      [...primary.compose, "ps", "--all"],
      {},
      30_000,
      true,
    ).catch(() => {});
  }
} finally {
  if (secureProxy?.listening) {
    secureProxy.closeAllConnections();
    await new Promise((resolveClose) => secureProxy.close(resolveClose));
  }
  for (const [index, compose] of projects.entries()) {
    await run(
      `cleanup-project-${index}`,
      "docker",
      [...compose, "down", "--volumes", "--remove-orphans", "--timeout", "20"],
      {},
      60_000,
      true,
    ).catch((error) => {
      console.error(error.message);
      process.exitCode = 1;
    });
  }
  const imageId = await run(
    "cleanup-image-inventory",
    "docker",
    ["image", "ls", "--quiet", image],
    {},
    30_000,
    true,
  ).catch(() => "");
  if (imageId)
    await run(
      "cleanup-image",
      "docker",
      ["image", "rm", image],
      {},
      60_000,
      true,
    ).catch((error) => {
      console.error(error.message);
      process.exitCode = 1;
    });
  const scannerId = await run(
    "cleanup-scanner-inventory",
    "docker",
    [
      "container",
      "ls",
      "--all",
      "--quiet",
      "--filter",
      `label=mill.verification=${project}`,
    ],
    {},
    30_000,
    true,
  ).catch(() => "");
  if (scannerId)
    await run(
      "cleanup-scanner",
      "docker",
      ["container", "rm", "--force", scannerId],
      {},
      30_000,
      true,
    ).catch((error) => {
      console.error(error.message);
      process.exitCode = 1;
    });
  const cache = await run(
    "cleanup-cache-inventory",
    "docker",
    ["volume", "ls", "--quiet", "--filter", `name=^${scannerCache}$`],
    {},
    30_000,
    true,
  ).catch(() => "");
  if (cache)
    await run(
      "cleanup-scanner-cache",
      "docker",
      ["volume", "rm", scannerCache],
      {},
      30_000,
      true,
    ).catch((error) => {
      console.error(error.message);
      process.exitCode = 1;
    });
  await rm(privateDirectory, { recursive: true, force: true });
}

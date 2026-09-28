import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

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
const results = [];
const projects = [];
await mkdir(evidence, { recursive: true });
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
      env: { ...process.env, ...extraEnv },
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
async function configuration(name, targetPort) {
  const envFile = join(privateDirectory, `${name}.env`);
  await writeFile(
    envFile,
    [
      `POSTGRES_PASSWORD=${secrets[0]}`,
      `MILL_SECRET=${secrets[1]}`,
      `MILL_BASE_URL=http://127.0.0.1:${targetPort}`,
      `MILL_PORT=${targetPort}`,
      "MILL_BIND_ADDRESS=127.0.0.1",
      "ALLOW_INSECURE_LOCALHOST=true",
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
  return { envFile, compose, url: `http://127.0.0.1:${targetPort}` };
}
const state = join(evidence, "fixture-state.json");
const backup = join(privateDirectory, "mill.dump");
let primary;
let sourceRevision;
let sourceDirty;
try {
  sourceRevision = await run("source-revision", "git", ["rev-parse", "HEAD"]);
  sourceDirty = Boolean(
    await run("source-working-tree", "git", ["status", "--porcelain"]),
  );
  await run("docker-required", "docker", [
    "info",
    "--format",
    "{{.ServerVersion}}",
  ]);
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
  const verifyEnv = {
    MILL_VERIFY_URL: primary.url,
    MILL_VERIFY_PASSWORD: secrets[2],
    MILL_VERIFY_STATE: state,
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
  await run("backup-full-database", "bash", [
    "tools/backup.sh",
    "--project",
    project,
    "--env-file",
    primary.envFile,
    "--output",
    backup,
  ]);
  await run("upgrade-stop", "docker", [...primary.compose, "stop", "mill"]);
  // This reconstructs the exact pre-004 local schema, not a historical release image.
  await run("earlier-local-schema", "docker", [
    ...primary.compose,
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
    "-c",
    "BEGIN; DROP TABLE api_idempotency; DROP TABLE request_limits; DELETE FROM mill_migrations WHERE name='004_http.sql'; COMMIT;",
  ]);
  await run(
    "automatic-schema-upgrade",
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
    "upgrade-persistence",
    "node",
    ["tools/install-smoke.mjs"],
    verifyEnv,
  );
  const migrationCount = await run("upgrade-migration-record", "docker", [
    ...primary.compose,
    "exec",
    "-T",
    "postgres",
    "psql",
    "-U",
    "mill",
    "-d",
    "mill",
    "--tuples-only",
    "--no-align",
    "-c",
    "SELECT count(*) FROM mill_migrations WHERE name='004_http.sql' AND checksum IS NOT NULL",
  ]);
  assert.equal(migrationCount, "1");
  const recovery = await configuration(recoveryProject, await port());
  await run(
    "empty-recovery-postgres",
    "docker",
    [...recovery.compose, "up", "--detach", "--wait", "postgres"],
    {},
    240_000,
  );
  await run(
    "restore-full-database",
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
  await run("restored-data-journey", "node", ["tools/install-smoke.mjs"], {
    ...verifyEnv,
    MILL_VERIFY_URL: recovery.url,
  });
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
        schemaUpgrade:
          "Reconstructed pre-004 local schema with real task/comment/member data, then automatic packaged migration 004",
        restore:
          "Custom-format pg_dump restored transactionally into a separate empty project; password login and task/comment/member read verified",
        cookieLimit:
          "Explicitly forwarded disposable cookies on loopback HTTP; this does not prove browser Secure-cookie policy or physical passkeys",
        completedAt: new Date().toISOString(),
      },
      null,
      2,
    ),
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

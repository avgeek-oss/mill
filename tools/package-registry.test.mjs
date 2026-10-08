import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { githubPackagesToken } from "./package-registry.mjs";

async function fixture(t, source) {
  const home = await mkdtemp(join(tmpdir(), "mill-registry-test-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  if (source !== undefined)
    await writeFile(join(home, ".npmrc"), source, { mode: 0o600 });
  return home;
}

test("explicit build credentials take precedence over stored registry login", async (t) => {
  const home = await fixture(
    t,
    "//npm.pkg.github.com/:_authToken=stored-test-token\n",
  );
  assert.equal(
    await githubPackagesToken({
      home,
      env: { NODE_AUTH_TOKEN: " supplied-test-token " },
    }),
    "supplied-test-token",
  );
});

test("stored login resolves only the GitHub Packages credential and supports npm environment placeholders", async (t) => {
  const home = await fixture(
    t,
    '//registry.npmjs.org/:_authToken=unrelated-test-token\n//npm.pkg.github.com/:_authToken="${PACKAGE_TEST_TOKEN}"\n',
  );
  assert.equal(
    await githubPackagesToken({
      home,
      env: { PACKAGE_TEST_TOKEN: "github-test-token" },
    }),
    "github-test-token",
  );
  const alternate = join(home, "alternate.npmrc");
  await writeFile(
    alternate,
    "//npm.pkg.github.com/:_authToken=alternate-test-token\n",
  );
  assert.equal(
    await githubPackagesToken({
      home,
      env: { NPM_CONFIG_USERCONFIG: alternate },
    }),
    "alternate-test-token",
  );
});

test("missing, unrelated, and multiline credentials fail without exposing their values", async (t) => {
  const home = await fixture(
    t,
    "//registry.npmjs.org/:_authToken=unrelated-test-token\n",
  );
  await assert.rejects(
    githubPackagesToken({ home, env: {} }),
    (error) =>
      error.message.includes("GitHub Packages authentication is required") &&
      !error.message.includes("unrelated-test-token"),
  );
  await assert.rejects(
    githubPackagesToken({
      home,
      env: { NODE_AUTH_TOKEN: "test-token\ninjected-config" },
    }),
    (error) =>
      error.message.includes("single token") &&
      !error.message.includes("test-token"),
  );
});

test("command wrapper passes stored credentials through the environment without printing or persisting them", async (t) => {
  const home = await fixture(
    t,
    "//npm.pkg.github.com/:_authToken=wrapper-test-token\n",
  );
  const wrapper = fileURLToPath(
    new URL("./with-package-token.mjs", import.meta.url),
  );
  const child = spawn(
    process.execPath,
    [
      wrapper,
      process.execPath,
      "--input-type=module",
      "-e",
      'import {readFileSync,statSync} from "node:fs"; if (process.env.NODE_AUTH_TOKEN !== "wrapper-test-token") process.exit(2); const config=process.env.NPM_CONFIG_USERCONFIG; if (!readFileSync(config,"utf8").includes("wrapper-test-token") || (statSync(config).mode & 0o777) !== 0o600) process.exit(3); console.log(config); process.exit(42);',
    ],
    {
      env: {
        ...process.env,
        NODE_AUTH_TOKEN: "",
        NPM_CONFIG_USERCONFIG: join(home, ".npmrc"),
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let output = "";
  child.stdout.on("data", (chunk) => {
    output += chunk;
  });
  child.stderr.on("data", (chunk) => {
    output += chunk;
  });
  const exit = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", resolve);
  });
  assert.equal(exit, 42);
  assert.ok(!output.includes("wrapper-test-token"));
  await assert.rejects(readFile(output.trim()), { code: "ENOENT" });
  assert.equal(
    await readFile(join(home, ".npmrc"), "utf8"),
    "//npm.pkg.github.com/:_authToken=wrapper-test-token\n",
  );
});

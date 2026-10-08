import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";

const digest = "a".repeat(64);
const api = `ghcr.io/avgeek-oss/mill-api@sha256:${digest}`;
const web = `ghcr.io/avgeek-oss/mill-web@sha256:${digest}`;
for (const [name, inputs, message] of [
  ["API alone", { MILL_VERIFY_API_IMAGE: api }, /requires both/],
  ["UI alone", { MILL_VERIFY_WEB_IMAGE: web }, /requires both/],
  [
    "swapped components",
    { MILL_VERIFY_API_IMAGE: web, MILL_VERIFY_WEB_IMAGE: api },
    /immutable Mill api GHCR digest/,
  ],
  [
    "mutable image tag",
    {
      MILL_VERIFY_API_IMAGE: "ghcr.io/avgeek-oss/mill-api:1.0.1",
      MILL_VERIFY_WEB_IMAGE: web,
    },
    /immutable Mill api GHCR digest/,
  ],
  [
    "retired combined image input",
    { MILL_VERIFY_RELEASE_IMAGE: `ghcr.io/avgeek-oss/mill@sha256:${digest}` },
    /MILL_VERIFY_RELEASE_IMAGE is retired/,
  ],
])
  test(`production verification refuses ${name} before accessing Docker`, () => {
    const env = { ...process.env };
    delete env.MILL_VERIFY_API_IMAGE;
    delete env.MILL_VERIFY_WEB_IMAGE;
    delete env.MILL_VERIFY_RELEASE_IMAGE;
    const result = spawnSync(
      process.execPath,
      ["tools/production-verify.mjs"],
      { encoding: "utf8", env: { ...env, ...inputs } },
    );
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, message);
    assert.equal(result.stdout, "");
  });

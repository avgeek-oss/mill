import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { isNewestRelease } from "./release-latest.mjs";

test("a release is Latest only when no newer stable release is published", () => {
  assert.equal(isNewestRelease("v1.0.6", []), true);
  assert.equal(isNewestRelease("v1.0.6", ["v1.0.5", "v0.9.12"]), true);
  // Compares numerically, not as text.
  assert.equal(isNewestRelease("v1.0.10", ["v1.0.9"]), true);
  assert.equal(isNewestRelease("v1.0.5", ["v1.0.6"]), false);
  assert.equal(isNewestRelease("v1.2.0", ["v1.10.0"]), false);
  assert.equal(isNewestRelease("v1.9.9", ["v2.0.0"]), false);
  // The release itself and unrelated tags do not block it.
  assert.equal(isNewestRelease("v1.0.6", ["v1.0.6", "nightly"]), true);
  assert.throws(() => isNewestRelease("1.0.6", []), /not a stable release/);
  assert.throws(() => isNewestRelease("v1.0.6-rc.1", []), /not a stable/);
});

test("the release workflows read the gh release list output and print true or false", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "mill-release-latest-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = join(directory, "releases.json");
  const run = async (tag, releases) => {
    await writeFile(file, JSON.stringify(releases));
    return spawnSync(
      process.execPath,
      [new URL("./release-latest.mjs", import.meta.url).pathname, tag, file],
      { encoding: "utf8" },
    );
  };
  const newer = await run("v1.0.5", [{ tagName: "v1.0.6" }]);
  assert.equal(newer.status, 0);
  assert.equal(newer.stdout, "false\n");
  const newest = await run("v1.0.7", [
    { tagName: "v1.0.6" },
    { tagName: "v1.0.1" },
  ]);
  assert.equal(newest.status, 0);
  assert.equal(newest.stdout, "true\n");
  const broken = await run("v1.0.7", { tagName: "v1.0.6" });
  assert.notEqual(broken.status, 0);
  assert.equal(broken.stdout, "");
});

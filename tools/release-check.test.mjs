import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

test("private packaging requires the latest exact-commit CI result, rejects failed reruns and active jobs", async () => {
  const directory = await mkdtemp(join(tmpdir(), "mill-release-check-"));
  const commit = "a".repeat(40);
  const file = join(directory, "checks.json");
  const check = (id, conclusion, extra = {}) => ({
    id,
    name: "Required CI",
    head_sha: commit,
    app: { slug: "github-actions" },
    started_at: `2026-09-28T10:0${id}:00Z`,
    status: "completed",
    conclusion,
    ...extra,
  });
  try {
    const run = async (checks) => {
      await writeFile(file, JSON.stringify([{ check_runs: checks }]));
      return spawnSync(
        process.execPath,
        ["tools/release-check.mjs", "--commit", commit, "--checks", file],
        { encoding: "utf8" },
      );
    };
    assert.equal(
      (await run([check(1, "success"), check(2, "success")])).status,
      0,
    );
    assert.notEqual(
      (await run([check(1, "success"), check(2, "failure")])).status,
      0,
    );
    assert.notEqual(
      (
        await run([
          check(1, "success"),
          check(2, null, { status: "queued", started_at: null }),
        ])
      ).status,
      0,
    );
    assert.notEqual(
      (await run([check(1, "success", { head_sha: "b".repeat(40) })])).status,
      0,
    );
    assert.notEqual(
      (await run([check(1, "success", { app: { slug: "other-app" } })])).status,
      0,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

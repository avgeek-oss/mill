import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

test("configuration generator makes private unique secrets and refuses overwrite or remote HTTP", async () => {
  const directory = await mkdtemp(join(tmpdir(), "mill-env-test-"));
  try {
    const file = join(directory, "test.env");
    let result = spawnSync(
      process.execPath,
      ["tools/init-env.mjs", "--file", file],
      { encoding: "utf8" },
    );
    assert.equal(result.status, 0, result.stderr);
    const contents = await readFile(file, "utf8");
    assert.match(contents, /^POSTGRES_PASSWORD=[a-f0-9]{64}$/m);
    assert.match(contents, /^MILL_SECRET=[a-f0-9]{96}$/m);
    const password = /^POSTGRES_PASSWORD=(.+)$/m.exec(contents)[1];
    assert.match(contents, /^MILL_BASE_URL=http:\/\/localhost:4321$/m);
    assert.ok(
      contents.includes(
        `DATABASE_URL=postgres://mill:${password}@127.0.0.1:55432/mill`,
      ),
    );
    assert.notEqual(/^MILL_SECRET=(.+)$/m.exec(contents)[1], password);
    assert.deepEqual(
      contents
        .trim()
        .split("\n")
        .map((line) => line.split("=")[0])
        .sort(),
      ["DATABASE_URL", "MILL_BASE_URL", "MILL_SECRET", "POSTGRES_PASSWORD"],
    );
    assert.equal((await stat(file)).mode & 0o777, 0o600);
    result = spawnSync(
      process.execPath,
      ["tools/init-env.mjs", "--file", file],
      { encoding: "utf8" },
    );
    assert.notEqual(result.status, 0);
    assert.equal(await readFile(file, "utf8"), contents);
    result = spawnSync(
      process.execPath,
      [
        "tools/init-env.mjs",
        "--file",
        join(directory, "remote.env"),
        "--base-url",
        "http://tasks.example.invalid",
      ],
      { encoding: "utf8" },
    );
    assert.notEqual(result.status, 0);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("restore requires explicit project confirmation before invoking Docker", () => {
  const result = spawnSync(
    "bash",
    [
      "tools/restore.sh",
      "--project",
      "mill-production",
      "--confirm-project",
      "mill-other",
      "--env-file",
      ".env",
      "--input",
      "backup.dump",
    ],
    { encoding: "utf8" },
  );
  assert.equal(result.status, 2);
  assert.match(result.stderr, /matching --confirm-project/);
});

test("backup requires an explicit project and output before invoking Docker", () => {
  const result = spawnSync("bash", ["tools/backup.sh"], { encoding: "utf8" });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /explicit Compose project/);
});

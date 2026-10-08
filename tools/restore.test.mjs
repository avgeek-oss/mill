import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import test from "node:test";

for (const failRestore of [false, true])
  test(`restore ${failRestore ? "leaves both services stopped after database failure" : "quiesces and resumes both services around a transactional restore"}`, async () => {
    const directory = await mkdtemp(join(tmpdir(), "mill-restore-test-"));
    try {
      const log = join(directory, "docker.log");
      const docker = join(directory, "docker");
      const envFile = join(directory, "recovery.env");
      const backup = join(directory, "backup.dump");
      const overlay = join(directory, "images.yml");
      await writeFile(overlay, "services: {}\n");
      await writeFile(
        envFile,
        "DATABASE_URL=postgres://mill:disposable@postgres:5432/mill\nMILL_SECRET=disposable-test-secret\nMILL_BASE_URL=http://localhost:4321\nPOSTGRES_PASSWORD=disposable\n",
      );
      await writeFile(backup, "disposable test backup");
      await writeFile(
        docker,
        `#!${process.execPath}\nimport { appendFileSync } from 'node:fs';\nconst args = process.argv.slice(2);\nappendFileSync(process.env.MILL_RESTORE_DOCKER_LOG, JSON.stringify(args)+'\\n');\nif(args.some(arg=>arg.includes('SELECT count(*)'))) console.log('0');\nif(process.env.MILL_RESTORE_TEST_FAIL==='true' && args.some(arg=>arg.includes('--single-transaction'))) process.exit(1);\n`,
      );
      await chmod(docker, 0o700);
      const result = spawnSync(
        "bash",
        [
          "tools/restore.sh",
          "--project",
          "mill-recovery",
          "--confirm-project",
          "mill-recovery",
          "--env-file",
          envFile,
          "--compose-file",
          overlay,
          "--input",
          backup,
        ],
        {
          encoding: "utf8",
          env: {
            ...process.env,
            PATH: `${directory}${delimiter}${process.env.PATH}`,
            MILL_RESTORE_DOCKER_LOG: log,
            MILL_RESTORE_TEST_FAIL: String(failRestore),
          },
        },
      );
      assert.equal(result.status, failRestore ? 1 : 0, result.stderr);
      const calls = (await readFile(log, "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      const stop = calls.findIndex((args) => args.includes("stop"));
      const restore = calls.findIndex((args) =>
        args.some((arg) => arg.includes("--single-transaction")),
      );
      assert.ok(stop >= 0 && restore > stop);
      assert.ok(
        calls.every((args) =>
          args.some((arg) => arg.endsWith("docker-compose.postgres.yml")),
        ),
      );
      assert.ok(calls.every((args) => args.includes(overlay)));
      assert.deepEqual(calls[stop].slice(-3), ["stop", "api", "web"]);
      assert.ok(calls[restore].includes("postgres"));
      const start = calls.findIndex((args) => args.includes("up"));
      if (failRestore) assert.equal(start, -1);
      else {
        assert.ok(start > restore);
        assert.deepEqual(calls[start].slice(-2), ["api", "web"]);
        assert.ok(calls[start].includes("--wait"));
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

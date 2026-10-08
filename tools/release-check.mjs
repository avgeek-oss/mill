import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const args = new Map();
for (let index = 2; index < process.argv.length; index += 2)
  args.set(process.argv[index], process.argv[index + 1]);
const commit = args.get("--commit");
const file = args.get("--checks");
assert.ok(
  commit && /^[a-f0-9]{40}$/.test(commit) && file,
  "Supply exact source commit and check-run pages",
);
const pages = JSON.parse(await readFile(file, "utf8"));
const checks = pages
  .flatMap((page) => page.check_runs)
  .filter(
    (check) =>
      check.name === "Required CI" &&
      check.head_sha === commit &&
      check.app?.slug === "github-actions",
  );
assert.ok(checks.length, "The exact source commit needs a Required CI result");
assert.ok(
  checks.every((check) => check.status === "completed"),
  "Required CI is still queued or running on this source commit",
);
checks.sort((left, right) => {
  const a = left.started_at ?? left.created_at ?? left.completed_at ?? "";
  const b = right.started_at ?? right.created_at ?? right.completed_at ?? "";
  return a.localeCompare(b) || left.id - right.id;
});
assert.equal(
  checks.at(-1).conclusion,
  "success",
  "The latest Required CI run must succeed; an older success is insufficient",
);
console.log(`PASS Latest Required CI succeeded for ${commit}`);

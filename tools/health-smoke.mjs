import assert from "node:assert/strict";

const origin = process.env.MILL_VERIFY_URL;
const mode = process.argv[2];
assert.ok(
  origin && ["unavailable", "recovered"].includes(mode),
  "Supply loopback verification URL and health mode",
);
const url = new URL(origin);
assert.ok(
  ["localhost", "127.0.0.1"].includes(url.hostname) && url.protocol === "http:",
  "Health fault verification targets disposable loopback only",
);
const live = await fetch(`${origin}/health/live`, {
  signal: AbortSignal.timeout(4_000),
});
assert.equal(
  live.status,
  200,
  "Liveness remains healthy independently of PostgreSQL",
);
const ready = await fetch(`${origin}/health/ready`, {
  signal: AbortSignal.timeout(8_000),
});
assert.equal(
  ready.status,
  mode === "unavailable" ? 503 : 200,
  "Readiness reflects the bounded PostgreSQL dependency check",
);
console.log(
  `PASS Liveness 200 and readiness ${ready.status} while PostgreSQL is ${mode}`,
);

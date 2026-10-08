import { test } from "node:test";
import assert from "node:assert/strict";
import { PasswordOperationGate } from "../apps/api/src/auth/password.js";
import { HttpError } from "../apps/api/src/http.js";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

test("password capacity rejects overload before work starts, serves queued work in order, and recovers from failures", async () => {
  const gate = new PasswordOperationGate(2, 2);
  const first = deferred();
  const second = deferred();
  const starts: number[] = [];
  let active = 0;
  let maximum = 0;
  const run = (id: number, wait: Promise<void>, fail = false) =>
    gate.run(async () => {
      starts.push(id);
      maximum = Math.max(maximum, ++active);
      try {
        await wait;
        if (fail) throw new Error("Verification failed");
        return id;
      } finally {
        active--;
      }
    });
  const a = run(1, first.promise, true);
  const rejected = assert.rejects(a, /Verification failed/);
  const b = run(2, second.promise);
  const c = run(3, Promise.resolve());
  const d = run(4, Promise.resolve());
  await assert.rejects(run(5, Promise.resolve()), (error: unknown) => {
    assert.ok(error instanceof HttpError);
    assert.equal(error.status, 503);
    assert.equal(error.code, "AUTHENTICATION_BUSY");
    assert.equal(error.responseHeaders["Retry-After"], "1");
    return true;
  });
  assert.deepEqual(starts, [1, 2]);
  first.resolve();
  await rejected;
  assert.equal(await c, 3);
  assert.equal(await d, 4);
  second.resolve();
  assert.equal(await b, 2);
  assert.equal(await run(6, Promise.resolve()), 6);
  assert.equal(maximum, 2);
  assert.deepEqual(starts, [1, 2, 3, 4, 6]);
});

test("password capacity can reject waiting work entirely and always releases a synchronous throw", async () => {
  const gate = new PasswordOperationGate(1, 0);
  await assert.rejects(
    gate.run(() => {
      throw new Error("Synchronous failure");
    }),
    /Synchronous failure/,
  );
  const wait = deferred();
  const active = gate.run(() => wait.promise);
  await assert.rejects(
    gate.run(async () => undefined),
    { code: "AUTHENTICATION_BUSY" },
  );
  wait.resolve();
  await active;
  assert.equal(await gate.run(async () => "free"), "free");
  for (const [active, waiting] of [
    [0, 1],
    [1, -1],
    [Infinity, 1],
    [1, 0.5],
  ])
    assert.throws(
      () => new PasswordOperationGate(active!, waiting!),
      RangeError,
    );
});

import { after, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import {
  cleanupDatabase,
  request,
  resetDatabase,
  setupUser,
  sql,
} from "./support.js";
beforeEach(resetDatabase);
after(cleanupDatabase);
test("origin checks reject cross-site cookie changes and allow authenticated same-origin writes", async () => {
  const { cookie } = await setupUser();
  const result = await request("/api/boards", {
    cookie,
    body: { name: "Origin board", prefix: "ORG" },
    headers: { Origin: "https://attacker.example" },
  });
  assert.equal(result.status, 403);
  assert.equal(
    (
      await request("/api/boards", {
        cookie,
        body: { name: "Origin board", prefix: "ORG" },
      })
    ).status,
    201,
  );
});
test("concurrent retries create one board and key reuse with another payload fails", async () => {
  const { cookie } = await setupUser();
  const options = {
    cookie,
    body: { name: "Retries", prefix: "RETRY" },
    headers: { "Idempotency-Key": "integration-retry-001" },
  };
  const results = await Promise.all([
    request("/api/boards", options),
    request("/api/boards", options),
  ]);
  assert.equal(results.filter((r) => r.status === 201).length >= 1, true);
  const replay = await request("/api/boards", options);
  assert.equal(replay.status, 201);
  assert.equal(replay.headers.get("Idempotency-Replayed"), "true");
  const list = await (await request("/api/boards", { cookie })).json();
  assert.equal(list.items.length, 1);
  const conflict = await request("/api/boards", {
    ...options,
    body: { name: "Different", prefix: "DIFF" },
  });
  assert.equal(conflict.status, 409);
});
test("authenticated throttling returns Retry-After and survives separate requests", async () => {
  const { cookie, user } = await setupUser();
  await sql`INSERT INTO request_limits (key,count,reset_at) VALUES (${`actor:${user.id}`},240,now()+interval '1 minute') ON CONFLICT(key) DO UPDATE SET count=240`;
  const response = await request("/api/boards", { cookie });
  assert.equal(response.status, 429);
  assert.equal(response.headers.get("Retry-After"), "60");
});
test("retry identity includes the query string", async () => {
  const { cookie } = await setupUser();
  const base = {
    cookie,
    body: { name: "Query retry", prefix: "QUERY" },
    headers: { "Idempotency-Key": "integration-query-001" },
  };
  assert.equal((await request("/api/boards?source=one", base)).status, 201);
  assert.equal((await request("/api/boards?source=two", base)).status, 409);
});
test("failed retry response persistence rolls back the mutation and permits safe retry", async () => {
  const { cookie } = await setupUser();
  await sql.unsafe(
    "CREATE FUNCTION reject_retry_persistence() RETURNS trigger AS $$ BEGIN RAISE EXCEPTION 'Injected retry persistence failure'; END; $$ LANGUAGE plpgsql",
  );
  await sql.unsafe(
    "CREATE TRIGGER reject_retry BEFORE UPDATE ON api_idempotency FOR EACH ROW EXECUTE FUNCTION reject_retry_persistence()",
  );
  const options = {
    cookie,
    body: { name: "Atomic retry", prefix: "ATOMIC" },
    headers: { "Idempotency-Key": "integration-atomic-001" },
  };
  assert.equal((await request("/api/boards", options)).status, 500);
  assert.equal((await sql`SELECT * FROM boards`).length, 0);
  assert.equal((await sql`SELECT * FROM api_idempotency`).length, 0);
  await sql.unsafe("DROP TRIGGER reject_retry ON api_idempotency");
  assert.equal((await request("/api/boards", options)).status, 201);
  assert.equal((await sql`SELECT * FROM boards`).length, 1);
});
test("successful empty DELETE responses replay as 204 with an empty body", async () => {
  const { Hono } = await import("hono");
  const { idempotency } = await import("../apps/api/src/middleware.js");
  const { user } = await setupUser();
  const harness = new Hono<import("../apps/api/src/http.js").Env>();
  harness.use("*", async (c, next) => {
    c.set("actor", {
      userId: user.id,
      name: user.name,
      role: "admin",
      kind: "human",
      scopes: ["read", "write"],
    });
    await next();
  });
  harness.use("*", idempotency);
  harness.delete("/api/empty", (c) => c.body(null, 204));
  for (const replay of [false, true]) {
    const response = await harness.request("/api/empty", {
      method: "DELETE",
      headers: { "Idempotency-Key": "integration-empty-001" },
    });
    assert.equal(response.status, 204);
    assert.equal(await response.text(), "");
    assert.equal(
      response.headers.get("Idempotency-Replayed"),
      replay ? "true" : null,
    );
  }
});
test("retry records encrypt credential issuance secrets", async () => {
  const { cookie } = await setupUser();
  const options = {
    cookie,
    body: { name: "Retry credential", scopes: ["read"], expiresInDays: 1 },
    headers: { "Idempotency-Key": "integration-secret-001" },
  };
  const response = await request("/api/credentials", options);
  assert.equal(response.status, 201);
  const result = await response.json();
  const [stored] =
    await sql`SELECT response::text AS text FROM api_idempotency WHERE key='integration-secret-001'`;
  assert.equal(stored.text.includes(result.token), false);
  const replay = await request("/api/credentials", options);
  assert.equal(replay.status, 201);
  assert.equal((await replay.json()).token, result.token);
  assert.equal((await sql`SELECT * FROM credentials`).length, 1);
});

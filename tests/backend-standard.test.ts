import { after, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import {
  cleanupDatabase,
  request,
  resetDatabase,
  setupOAuth,
  setupUser,
  sql,
  callMcpTool,
} from "./support.js";
import {
  hashToken,
  rateLimit,
  clearAuthRateLimit,
} from "../apps/api/src/auth/security.js";
import { app } from "../apps/api/src/app.js";
import { registerPasskey } from "./passkey-support.js";
import { runPasswordOperation } from "../apps/api/src/auth/password.js";
import { config } from "../apps/api/src/config.js";
beforeEach(resetDatabase);
after(cleanupDatabase);
const password = "Secure test passphrase 42!";

test("overloaded password work returns a typed retryable failure without creating a session, then recovers", async () => {
  const { user } = await setupUser();
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const options = config();
  const queued = Array.from(
    {
      length:
        options.MILL_PASSWORD_VERIFY_CONCURRENCY +
        options.MILL_PASSWORD_VERIFY_QUEUE_LIMIT,
    },
    () => runPasswordOperation(() => held),
  );
  const before = (await sql`SELECT id FROM sessions WHERE user_id=${user.id}`)
    .length;
  try {
    const busy = await request("/api/auth/login", {
      body: { email: user.email, password },
    });
    assert.equal(busy.status, 503);
    assert.equal((await busy.json()).error.code, "AUTHENTICATION_BUSY");
    assert.equal(busy.headers.get("Retry-After"), "1");
    assert.equal(
      (await sql`SELECT id FROM sessions WHERE user_id=${user.id}`).length,
      before,
    );
  } finally {
    release();
    await Promise.all(queued);
  }
  assert.equal(
    (
      await request("/api/auth/login", {
        body: { email: user.email, password },
      })
    ).status,
    200,
  );
});

test("generic failures have safe request IDs and stable codes without exposing internal errors or credentials", async () => {
  for (const path of ["/api/boards", "/api/credentials"]) {
    const response = await request(path, {
      headers: { "X-Request-Id": "accepted-request-1" },
    });
    assert.equal(response.status, 401);
    assert.equal(response.headers.get("Cache-Control"), "no-store");
    assert.deepEqual(await response.json(), {
      error: {
        code: "UNAUTHORIZED",
        message: "Sign in to continue",
        requestId: "accepted-request-1",
      },
    });
  }
  const missing = await request("/api/unknown", {
    headers: { "X-Request-Id": "private value invalid" },
  });
  const error = (await missing.json()).error;
  assert.equal(error.code, "NOT_FOUND");
  assert.match(error.requestId, /^[0-9a-f-]{36}$/);
  assert.equal(missing.headers.get("X-Request-Id"), error.requestId);
  const { cookie } = await setupUser();
  await sql.unsafe(
    "CREATE FUNCTION fail_board_insert() RETURNS trigger AS $$ BEGIN RAISE EXCEPTION 'private database credential'; END; $$ LANGUAGE plpgsql",
  );
  await sql.unsafe(
    "CREATE TRIGGER fail_board_insert BEFORE INSERT ON boards FOR EACH ROW EXECUTE FUNCTION fail_board_insert()",
  );
  const failed = await request("/api/boards", {
    cookie,
    body: { name: "Failure", prefix: "FAIL" },
  });
  assert.equal(failed.status, 500);
  const payload = await failed.json();
  assert.equal(payload.error.code, "INTERNAL_ERROR");
  assert.equal(
    JSON.stringify(payload).includes("private database credential"),
    false,
  );
  assert.equal((await sql`SELECT id FROM boards`).length, 0);
  await sql.unsafe("DROP TRIGGER fail_board_insert ON boards");
  await sql.unsafe("DROP FUNCTION fail_board_insert()");
});

test("stale identity has a typed step-up signal and strict requests cannot silently mutate omitted fields", async () => {
  const { cookie, user } = await setupUser();
  const before = (
    await sql`SELECT name,password_hash FROM users WHERE id=${user.id}`
  )[0];
  for (const [path, body, method] of [
    ["/api/auth/profile", { name: "Changed", role: "admin" }, "PATCH"],
    ["/api/auth/reauth", { password, ignored: "extra" }, "POST"],
    [
      "/api/auth/invitations",
      { email: "new@example.test", role: "member", ignored: true },
      "POST",
    ],
    ["/api/auth/passkeys/authenticate/options", { ignored: true }, "POST"],
  ] as const) {
    const response = await request(path, { cookie, body, method });
    assert.equal(response.status, 400, path);
    assert.equal(typeof (await response.json()).error.message, "string");
  }
  assert.deepEqual(
    (await sql`SELECT name,password_hash FROM users WHERE id=${user.id}`)[0],
    before,
  );
  assert.equal((await sql`SELECT id FROM invitations`).length, 0);
  await sql`UPDATE sessions SET authenticated_at=now()-interval '11 minutes' WHERE user_id=${user.id}`;
  const stale = await request("/api/auth/passkeys/register/options", {
    cookie,
    body: {},
  });
  assert.equal(stale.status, 403);
  assert.equal((await stale.json()).error.code, "REAUTHENTICATION_REQUIRED");
  assert.equal((await sql`SELECT token_hash FROM auth_challenges`).length, 0);
});

test("successful password authentication clears only its account bucket, with remaining-window Retry-After and expired cleanup", async () => {
  const { user } = await setupUser();
  const key = hashToken(`login-email:${user.email}`);
  await sql`INSERT INTO auth_rate_limits(key,attempts,window_start) VALUES(${key},9,now()),('expired',10,now()-interval '3 days'),('active-other',5,now())`;
  const successful = await request("/api/auth/login", {
    body: { email: user.email, password },
  });
  assert.equal(successful.status, 200);
  assert.equal(
    (await sql`SELECT key FROM auth_rate_limits WHERE key=${key}`).length,
    0,
  );
  assert.equal(
    (await sql`SELECT key FROM auth_rate_limits WHERE key='expired'`).length,
    0,
  );
  assert.equal(
    (
      await sql`SELECT attempts FROM auth_rate_limits WHERE key='active-other'`
    )[0].attempts,
    5,
  );
  const cookie = successful.headers.get("set-cookie")!.split(";")[0]!;
  await sql`INSERT INTO auth_rate_limits(key,attempts,window_start) VALUES(${hashToken(`reauth:${user.id}`)},9,now())`;
  assert.equal(
    (await request("/api/auth/reauth", { cookie, body: { password } })).status,
    200,
  );
  assert.equal(
    (
      await sql`SELECT key FROM auth_rate_limits WHERE key=${hashToken(`reauth:${user.id}`)}`
    ).length,
    0,
  );
  await sql`INSERT INTO auth_rate_limits(key,attempts,window_start) VALUES(${key},10,now()-interval '5 minutes')`;
  const rejected = await request("/api/auth/login", {
    body: { email: user.email, password: "wrong" },
  });
  assert.equal(rejected.status, 429);
  assert.equal((await rejected.json()).error.code, "AUTH_RATE_LIMITED");
  assert.ok(
    Number(rejected.headers.get("Retry-After")) >= 590 &&
      Number(rejected.headers.get("Retry-After")) <= 600,
  );
  await clearAuthRateLimit(`login-email:${user.email}`);
  await rateLimit("direct-subject", 1, 300);
});

test("password proof alone does not clear throttling until a one-time second factor completes", async () => {
  const { cookie, user } = await setupUser();
  const passkey = await registerPasskey(cookie, user.id);
  const codes = passkey.recoveryCodes;
  const key = hashToken(`login-email:${user.email}`);
  await sql`INSERT INTO auth_rate_limits(key,attempts,window_start) VALUES(${key},8,now())`;
  const pending = await (
    await request("/api/auth/login", { body: { email: user.email, password } })
  ).json();
  assert.equal(pending.requiresSecondFactor, true);
  assert.equal(
    (await sql`SELECT attempts FROM auth_rate_limits WHERE key=${key}`)[0]
      .attempts,
    9,
  );
  const failed = await request("/api/auth/passkeys/recovery/verify", {
    body: {
      challengeId: pending.challengeId,
      code: "invalid recovery",
    },
  });
  assert.equal(failed.status, 400);
  assert.equal(
    (await sql`SELECT attempts FROM auth_rate_limits WHERE key=${key}`)[0]
      .attempts,
    9,
  );
  const complete = await request("/api/auth/passkeys/recovery/verify", {
    body: {
      challengeId: pending.challengeId,
      code: codes[0],
    },
  });
  assert.equal(complete.status, 200);
  assert.equal(
    (await sql`SELECT key FROM auth_rate_limits WHERE key=${key}`).length,
    0,
  );
  assert.equal(
    (
      await request("/api/auth/passkeys/recovery/verify", {
        body: {
          challengeId: pending.challengeId,
          code: codes[0],
        },
      })
    ).status,
    400,
  );
});

test("OAuth retains its protocol errors while durable task history distinguishes browser, API key and MCP owners", async () => {
  const malformed = await app.request("/oauth/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: "grant_type=invalid",
  });
  const protocol = await malformed.json();
  assert.equal(typeof protocol.error, "string");
  assert.equal(typeof protocol.error_description, "string");
  const { cookie, user } = await setupUser();
  const { board } = await (
    await request("/api/boards", {
      cookie,
      body: { name: "Attribution", prefix: "TRACE" },
    })
  ).json();
  const { task } = await (
    await request(`/api/boards/${board.id}/tasks`, {
      cookie,
      body: { title: "Original" },
      headers: { "X-Request-Id": "browser-operation" },
    })
  ).json();
  const key = await (
    await request("/api/credentials", {
      cookie,
      body: { name: "Personal key" },
    })
  ).json();
  const edited = await request(`/api/tasks/${task.id}`, {
    token: key.token,
    method: "PATCH",
    body: { version: task.version, title: "API edit" },
    headers: { "X-Request-Id": "api-operation" },
  });
  assert.equal(edited.status, 200);
  const oauth = await setupOAuth(cookie, { boardIds: [board.id] });
  const changed = await callMcpTool(oauth.token, "update_task", {
    taskId: task.id,
    version: (await edited.json()).task.version,
    title: "MCP edit",
  });
  assert.equal(changed.result?.isError, false);
  await request(`/api/credentials/${key.credential.id}`, {
    cookie,
    method: "DELETE",
  });
  const events =
    await sql`SELECT actor_id,detail FROM activity WHERE task_id=${task.id} ORDER BY created_at,id`;
  assert.deepEqual(
    events.map((event) => event.detail.connection.type),
    ["session", "api-key", "oauth"],
  );
  assert.equal(events[0]!.detail.connection.requestId, "browser-operation");
  assert.equal(events[1]!.detail.connection.requestId, "api-operation");
  assert.equal(
    events[2]!.detail.connection.requestId,
    changed.response.headers.get("X-Request-Id"),
  );
  assert.ok(
    events.every(
      (event) =>
        event.actorId === user.id &&
        typeof event.detail.connection.requestId === "string",
    ),
  );
  assert.equal(JSON.stringify(events).includes(key.token), false);
  assert.equal(JSON.stringify(events).includes(oauth.token), false);
  const [historical] =
    await sql`INSERT INTO activity(task_id,board_id,actor_id,actor_name,actor_kind,action,detail) VALUES(${task.id},${board.id},${user.id},${user.name},'human','task.updated','{"fields":["title"]}') RETURNING detail`;
  const history = await (
    await request(`/api/tasks/${task.id}/activity`, { cookie })
  ).json();
  assert.ok(
    history.items.some(
      (event: { detail: unknown }) =>
        JSON.stringify(event.detail) === JSON.stringify(historical!.detail),
    ),
  );
  assert.equal(historical!.detail.connection, undefined);
});

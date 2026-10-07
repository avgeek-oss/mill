import { after, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server, type Socket } from "node:net";
import {
  cleanupDatabase,
  request,
  resetDatabase,
  setupUser,
  sql,
} from "./support.js";
import {
  deliverEmailBatch,
  sendSmtpMessage,
  startEmailWorker,
} from "../apps/api/src/auth/email-outbox.js";
import { createOperatorRecovery } from "../apps/api/src/auth/recovery.js";
import { registerPasskey } from "./passkey-support.js";
const password = "Another secure passphrase 42!";
const mailEnv = [
  "MILL_SMTP_HOST",
  "MILL_SMTP_PORT",
  "MILL_SMTP_SECURE",
  "MILL_SMTP_USER",
  "MILL_SMTP_PASSWORD",
  "MILL_SMTP_FROM",
];
const previous = Object.fromEntries(mailEnv.map((k) => [k, process.env[k]]));
function smtp(enabled = true) {
  process.env.MILL_SMTP_HOST = enabled ? "127.0.0.1" : "";
  process.env.MILL_SMTP_FROM = enabled ? "mill@example.test" : "";
  process.env.MILL_SMTP_PORT = "2525";
  process.env.MILL_SMTP_SECURE = "false";
  process.env.MILL_SMTP_USER = "";
  process.env.MILL_SMTP_PASSWORD = "";
}
beforeEach(async () => {
  smtp();
  await resetDatabase();
});
after(async () => {
  for (const k of mailEnv) {
    if (previous[k] === undefined) delete process.env[k];
    else process.env[k] = previous[k];
  }
  await cleanupDatabase();
});
async function json(response: Response, status = 200) {
  assert.equal(response.status, status, await response.clone().text());
  return response.json();
}
async function delivered() {
  const messages: { to: string; subject: string; text: string }[] = [];
  await deliverEmailBatch(async (m) => {
    messages.push(m);
  });
  return messages;
}
function link(text: string, path: string) {
  const match = text.match(new RegExp(`${path}#([A-Za-z0-9_.-]+)`));
  assert.ok(match, text);
  const [id, token] = match[1].split(".");
  return { id, token };
}
async function change(cookie: string, email = "new@example.test") {
  return json(
    await request("/api/auth/email-change", { cookie, body: { email } }),
  );
}
async function invite(cookie: string, email = "invitee@example.test") {
  return json(
    await request("/api/auth/invitations", {
      cookie,
      body: { email, role: "member" },
    }),
    201,
  );
}
async function invitationCode(token: string) {
  await json(
    await request("/api/auth/invitation/verification/request", {
      body: { token },
    }),
  );
  const mails = await delivered();
  const code = mails
    .find(
      (m) =>
        m.subject.includes("verification code") ||
        m.subject === "Verify your Mill invitation",
    )
    ?.text.match(/code is (\d{6})/)?.[1];
  assert.ok(code);
  return code;
}

test("capability and historical verification facts are truthful, with private-link fallback", async () => {
  smtp(false);
  const u = await setupUser();
  assert.equal(u.user.emailVerified, false);
  assert.equal(
    (await json(await request("/api/auth/status"))).emailDeliveryConfigured,
    false,
  );
  assert.equal(
    (
      await request("/api/auth/email-verification/request", {
        cookie: u.cookie,
        body: {},
      })
    ).status,
    503,
  );
  const i = await invite(u.cookie);
  assert.equal(i.emailDelivery, "unavailable");
  assert.equal(
    (await json(await request(`/api/auth/invitation?token=${i.token}`)))
      .verificationRequired,
    false,
  );
  assert.equal((await sql`SELECT id FROM email_outbox`).length, 0);
  await json(
    await request("/api/auth/accept-invitation", {
      body: { token: i.token, name: "Invitee", password },
    }),
    201,
  );
});

test("public resend and reset are neutral for unknown, verified, disabled and unverified accounts, uniform limits and no session cookies", async () => {
  const u = await setupUser();
  await sql`UPDATE users SET email_verified=true WHERE id=${u.user.id}`;
  const emails = [
    "unknown@example.test",
    u.user.email,
    "disabled@example.test",
    "unverified@example.test",
  ];
  await sql`INSERT INTO users(id,workspace_id,name,email,role,password_hash,disabled_at) SELECT gen_random_uuid(),workspace_id,'Disabled','disabled@example.test','member',password_hash,now() FROM users WHERE id=${u.user.id}`;
  await sql`INSERT INTO users(id,workspace_id,name,email,role,password_hash) SELECT gen_random_uuid(),workspace_id,'Unverified','unverified@example.test','member',password_hash FROM users WHERE id=${u.user.id}`;
  for (const path of [
    "/api/auth/verification-email",
    "/api/auth/password-reset/request",
  ]) {
    for (const email of emails) {
      const started = Date.now();
      const res = await request(path, { cookie: u.cookie, body: { email } });
      assert.deepEqual(await json(res), { status: true });
      assert.equal(res.headers.has("set-cookie"), false);
      assert.ok(Date.now() - started >= 480);
      const blocked = await request(path, { body: { email } });
      assert.equal(blocked.status, 429);
      assert.ok(Number(blocked.headers.get("retry-after")) >= 1);
    }
  }
  const rows = await sql`SELECT payload FROM email_outbox`;
  assert.equal(JSON.stringify(rows).includes("recover#"), false);
  assert.equal(JSON.stringify(rows).includes("verify-email#"), false);
});

test("verification is browser-owned, encrypted, purpose-bound and consumed once under concurrent confirmation", async () => {
  const u = await setupUser();
  assert.equal(
    (await request("/api/auth/email-verification/request", { body: {} }))
      .status,
    401,
  );
  const r = await json(
    await request("/api/auth/email-verification/request", {
      cookie: u.cookie,
      body: {},
    }),
  );
  assert.ok(r.resendAvailableAt > Date.now());
  const again = await json(
    await request("/api/auth/email-verification/request", {
      cookie: u.cookie,
      body: {},
    }),
  );
  assert.equal(again.resendAvailableAt, r.resendAvailableAt);
  assert.equal((await sql`SELECT id FROM email_outbox`).length, 1);
  const [before] = await sql`SELECT payload FROM email_outbox`;
  assert.equal(before.payload.includes(u.user.email), false);
  const messages = await delivered();
  const confirmation = link(messages[0].text, "/verify-email");
  assert.equal(
    (await request("/api/auth/email-change/confirm", { body: confirmation }))
      .status,
    400,
  );
  const results = await Promise.all([
    request("/api/auth/email-verification/confirm", { body: confirmation }),
    request("/api/auth/email-verification/confirm", { body: confirmation }),
  ]);
  assert.deepEqual(results.map((r) => r.status).sort(), [200, 400]);
  assert.equal(
    (await json(await request("/api/auth/me", { cookie: u.cookie }))).user
      .emailVerified,
    true,
  );
  assert.equal((await sql`SELECT payload FROM email_outbox`)[0].payload, null);
  assert.equal(
    (await sql`SELECT token_hash FROM email_requests`)[0].tokenHash,
    null,
  );
});

test("email change requires recent passkey proof and pending request reuse survives lost responses", async () => {
  const u = await setupUser();
  await registerPasskey(u.cookie, u.user.id);
  await sql`UPDATE sessions SET passkey_authenticated_at=now()-interval '11 minutes' WHERE user_id=${u.user.id}`;
  assert.equal(
    (
      await request("/api/auth/email-change", {
        cookie: u.cookie,
        body: { email: "new@example.test" },
      })
    ).status,
    403,
  );
  // Test fixture provides actual recent passkey-proof state, not a client-supplied field.
  await sql`UPDATE sessions SET passkey_authenticated_at=now() WHERE user_id=${u.user.id}`;
  const first = await change(u.cookie);
  const repeat = await change(u.cookie);
  assert.deepEqual(repeat, first);
  assert.deepEqual(
    await json(await request("/api/auth/email-change", { cookie: u.cookie })),
    first,
  );
  assert.equal((await sql`SELECT id FROM email_outbox`).length, 1);
  const proof = link((await delivered())[0].text, "/confirm-email-change");
  await sql`UPDATE users SET security_epoch=security_epoch+1 WHERE id=${u.user.id}`;
  assert.equal(
    (await request("/api/auth/email-change/confirm", { body: proof })).status,
    400,
  );
});

test("cancelled changes cannot confirm and successful confirmation atomically invalidates sessions and owned grants", async () => {
  const u = await setupUser();
  await change(u.cookie);
  const first = link((await delivered())[0].text, "/confirm-email-change");
  await json(
    await request("/api/auth/email-change", {
      cookie: u.cookie,
      method: "DELETE",
      body: {},
    }),
  );
  assert.equal(
    (await request("/api/auth/email-change/confirm", { body: first })).status,
    400,
  );
  await change(u.cookie);
  const second = link((await delivered())[0].text, "/confirm-email-change");
  const { credential } = await json(
    await request("/api/credentials", {
      cookie: u.cookie,
      body: { name: "Owned" },
    }),
    201,
  );
  const id = credential.id;
  await json(await request("/api/auth/email-change/confirm", { body: second }));
  assert.equal(
    (await request("/api/auth/me", { cookie: u.cookie })).status,
    401,
  );
  const [updated] =
    await sql`SELECT email,email_verified FROM users WHERE id=${u.user.id}`;
  assert.equal(updated.email, "new@example.test");
  assert.equal(updated.emailVerified, true);
  assert.ok(
    (await sql`SELECT revoked_at FROM credentials WHERE id=${id}`)[0].revokedAt,
  );
  assert.equal(
    (await request("/api/auth/email-change/confirm", { body: second })).status,
    400,
  );
});

test("SMTP invitation requires verified code before atomic final signup, binds name and rejects replay", async () => {
  const u = await setupUser();
  const i = await invite(u.cookie);
  assert.equal(i.emailDelivery, "queued");
  assert.equal(
    (await json(await request(`/api/auth/invitation?token=${i.token}`)))
      .verificationRequired,
    true,
  );
  assert.equal(
    (
      await request("/api/auth/accept-invitation", {
        body: { token: i.token, name: "Invitee", password },
      })
    ).status,
    400,
  );
  const code = await invitationCode(i.token);
  const proof = await json(
    await request("/api/auth/invitation/verification/confirm", {
      body: { token: i.token, name: "Verified name", code },
    }),
  );
  assert.equal(
    (await sql`SELECT id FROM users WHERE email='invitee@example.test'`).length,
    0,
  );
  assert.equal(
    (
      await request("/api/auth/accept-invitation", {
        body: {
          token: i.token,
          name: "Different name",
          password,
          verificationToken: proof.verificationToken,
        },
      })
    ).status,
    400,
  );
  const body = {
    token: i.token,
    name: "Verified name",
    password,
    verificationToken: proof.verificationToken,
  };
  const results = await Promise.all([
    request("/api/auth/accept-invitation", { body }),
    request("/api/auth/accept-invitation", { body }),
  ]);
  assert.deepEqual(results.map((r) => r.status).sort(), [201, 400]);
  assert.equal(
    (
      await sql`SELECT email_verified FROM users WHERE email='invitee@example.test'`
    )[0].emailVerified,
    true,
  );
});

test("wrong invitation codes exhaust durable five-attempt budget; expired or demoted proofs fail", async () => {
  const u = await setupUser(),
    i = await invite(u.cookie),
    code = await invitationCode(i.token);
  for (let n = 0; n < 5; n++)
    assert.equal(
      (
        await request("/api/auth/invitation/verification/confirm", {
          body: {
            token: i.token,
            name: "Invitee",
            code: code === "000000" ? "111111" : "000000",
          },
        })
      ).status,
      400,
    );
  assert.equal((await sql`SELECT attempts FROM email_requests`)[0].attempts, 5);
  assert.equal(
    (
      await request("/api/auth/invitation/verification/confirm", {
        body: { token: i.token, name: "Invitee", code },
      })
    ).status,
    400,
  );
  const j = await invite(u.cookie, "other@example.test"),
    otherCode = await invitationCode(j.token);
  const proof = await json(
    await request("/api/auth/invitation/verification/confirm", {
      body: { token: j.token, name: "Invitee", code: otherCode },
    }),
  );
  await sql`UPDATE users SET role='member' WHERE id=${u.user.id}`;
  assert.equal(
    (
      await request("/api/auth/accept-invitation", {
        body: {
          token: j.token,
          name: "Invitee",
          password,
          verificationToken: proof.verificationToken,
        },
      })
    ).status,
    400,
  );
});

test("reset requests preserve passkeys and stale operator or emailed recovery links cannot outlive a security change", async () => {
  const u = await setupUser();
  await registerPasskey(u.cookie, u.user.id);
  await json(
    await request("/api/auth/password-reset/request", {
      body: { email: u.user.email },
    }),
  );
  const mail = (await delivered())[0];
  const token = mail.text.match(/\/recover#([A-Za-z0-9_-]{43})/)![1];
  await json(
    await request("/api/auth/recovery/reset", { body: { token, password } }),
  );
  assert.equal((await sql`SELECT id FROM passkeys`).length, 1);
  assert.equal((await sql`SELECT id FROM sessions`).length, 0);
  const operator = await createOperatorRecovery(u.user.email, true);
  await sql`UPDATE users SET security_epoch=security_epoch+1 WHERE id=${u.user.id}`;
  assert.equal(
    (
      await request("/api/auth/recovery/reset", {
        body: { token: operator, password },
      })
    ).status,
    400,
  );
  assert.equal((await sql`SELECT id FROM passkeys`).length, 1);
});

test("outbox retries are bounded, expired leases recover, and revoked/expired requests never send", async () => {
  const u = await setupUser();
  await json(
    await request("/api/auth/email-verification/request", {
      cookie: u.cookie,
      body: {},
    }),
  );
  await sql`UPDATE email_outbox SET lease_token=gen_random_uuid(),lease_until=now()-interval '1 second'`;
  let calls = 0;
  for (let n = 0; n < 5; n++) {
    await sql`UPDATE email_outbox SET available_at=now()-interval '1 second'`;
    await deliverEmailBatch(async () => {
      calls++;
      throw new Error("secret SMTP password should never persist");
    });
  }
  assert.equal(calls, 5);
  const [row] = await sql`SELECT * FROM email_outbox`;
  assert.equal(row.state, "failed");
  assert.equal(row.payload, null);
  assert.equal(row.lastError, "delivery_failed");
  assert.equal(row.attempts, 5);
  await sql`UPDATE email_requests SET consumed_at=now()`;
  await sql`DELETE FROM auth_rate_limits`;
  await json(
    await request("/api/auth/email-verification/request", {
      cookie: u.cookie,
      body: {},
    }),
  );
  await sql`UPDATE users SET disabled_at=now() WHERE id=${u.user.id}`;
  assert.deepEqual(await delivered(), []);
  assert.equal(
    (
      await sql`SELECT state,payload FROM email_outbox ORDER BY created_at DESC LIMIT 1`
    )[0].state,
    "cancelled",
  );
});

async function smtpFixture() {
  const messages: string[] = [],
    sockets = new Set<Socket>();
  const server: Server = createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.write("220 local SMTP\r\n");
    let pending = "",
      data = false,
      message = "";
    socket.on("data", (chunk) => {
      pending += chunk.toString();
      let index;
      while ((index = pending.indexOf("\r\n")) >= 0) {
        const line = pending.slice(0, index);
        pending = pending.slice(index + 2);
        if (data) {
          if (line === ".") {
            messages.push(message);
            message = "";
            data = false;
            socket.write("250 accepted\r\n");
          } else message += line + "\r\n";
        } else if (/^EHLO|^HELO/.test(line))
          socket.write("250-local\r\n250 8BITMIME\r\n");
        else if (/^MAIL FROM|^RCPT TO/.test(line)) socket.write("250 ok\r\n");
        else if (line === "DATA") {
          data = true;
          socket.write("354 send data\r\n");
        } else if (line === "QUIT") {
          socket.end("221 bye\r\n");
        } else socket.write("250 ok\r\n");
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  process.env.MILL_SMTP_PORT = String(address.port);
  return {
    messages,
    async close() {
      for (const s of sockets) s.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
test("real loopback SMTP handoff carries a usable verification link and clears encrypted durable payload", async () => {
  const server = await smtpFixture();
  try {
    const u = await setupUser();
    await json(
      await request("/api/auth/email-verification/request", {
        cookie: u.cookie,
        body: {},
      }),
    );
    assert.equal(await deliverEmailBatch(), 1);
    assert.equal(server.messages.length, 1);
    const raw = server.messages[0]
      .replace(/=\r\n/g, "")
      .replace(/=([0-9A-F]{2})/g, (_match, hex) =>
        String.fromCharCode(parseInt(hex, 16)),
      );
    const proof = link(raw, "/verify-email");
    await json(
      await request("/api/auth/email-verification/confirm", { body: proof }),
    );
    assert.equal(
      (await sql`SELECT state,payload FROM email_outbox`)[0].state,
      "delivered",
    );
    assert.equal(
      (await sql`SELECT state,payload FROM email_outbox`)[0].payload,
      null,
    );
  } finally {
    await server.close();
  }
});

test("real SMTP password reset rejects expired and replayed links and replaces credentials", async () => {
  const server = await smtpFixture();
  try {
    const u = await setupUser();
    const issueReset = async () => {
      await json(
        await request("/api/auth/password-reset/request", {
          body: { email: u.user.email },
        }),
      );
      assert.equal(await deliverEmailBatch(), 1);
      const raw = server.messages
        .at(-1)!
        .replace(/=\r\n/g, "")
        .replace(/=([0-9A-F]{2})/g, (_match, hex) =>
          String.fromCharCode(parseInt(hex, 16)),
        );
      const token = raw.match(/\/recover#([A-Za-z0-9_-]{43})/)?.[1];
      assert.ok(token);
      const [stored] = await sql`SELECT token_hash FROM account_recovery`;
      assert.notEqual(stored.tokenHash, token);
      return token;
    };
    const expiredToken = await issueReset();
    await sql`UPDATE account_recovery SET expires_at=now()-interval '1 second'`;
    assert.equal(
      (
        await request("/api/auth/recovery/reset", {
          body: { token: expiredToken, password },
        })
      ).status,
      400,
    );
    assert.equal(
      (await request("/api/auth/me", { cookie: u.cookie })).status,
      200,
    );
    await sql`DELETE FROM auth_rate_limits`;
    const token = await issueReset();
    const attempts = await Promise.all([
      request("/api/auth/recovery/reset", { body: { token, password } }),
      request("/api/auth/recovery/reset", { body: { token, password } }),
    ]);
    assert.deepEqual(
      attempts.map((response) => response.status).sort(),
      [200, 400],
    );
    assert.equal(
      (await request("/api/auth/me", { cookie: u.cookie })).status,
      401,
    );
    assert.equal(
      (
        await request("/api/auth/login", {
          body: { email: u.user.email, password: "Secure test passphrase 42!" },
        })
      ).status,
      401,
    );
    await json(
      await request("/api/auth/login", {
        body: { email: u.user.email, password },
      }),
    );
    assert.equal(
      (await sql`SELECT token_hash FROM account_recovery`).length,
      0,
    );
    assert.equal(server.messages.length, 2);
    assert.ok(
      (await sql`SELECT payload FROM email_outbox`).every(
        (row) => row.payload === null,
      ),
    );
  } finally {
    await server.close();
  }
});

test("retained UI intent cannot mutate a different browser account or authorize through an API key", async () => {
  const u = await setupUser();
  const credential = (
    await json(
      await request("/api/credentials", {
        cookie: u.cookie,
        body: { name: "Identity test" },
      }),
      201,
    )
  ).token;
  for (const [path, method, body] of [
    ["/api/auth/email-change", "POST", { email: "intent@example.test" }],
    ["/api/auth/email-change", "GET", undefined],
    ["/api/auth/email-change", "DELETE", {}],
    ["/api/auth/email-verification/request", "POST", {}],
  ] as const) {
    const changed = await request(path, {
      cookie: u.cookie,
      method,
      ...(body ? { body } : {}),
      headers: { "X-Mill-User-Id": "11111111-1111-4111-8111-111111111111" },
    });
    assert.equal(changed.status, 409);
    assert.equal((await changed.json()).error.code, "ACCOUNT_IDENTITY_CHANGED");
    const api = await request(path, {
      token: credential,
      method,
      ...(body ? { body } : {}),
      headers: { "X-Mill-User-Id": u.user.id },
    });
    assert.equal(api.status, 403);
  }
  assert.equal((await sql`SELECT id FROM email_requests`).length, 0);
  assert.equal((await sql`SELECT id FROM email_outbox`).length, 0);
  await json(
    await request("/api/auth/email-change", {
      cookie: u.cookie,
      headers: { "X-Mill-User-Id": u.user.id },
      body: { email: "valid-intent@example.test" },
    }),
  );
});

test("expiry cleanup removes sensitive pending payloads even when SMTP is disabled, and simultaneous workers deliver one claimed message", async () => {
  const u = await setupUser();
  await json(
    await request("/api/auth/email-verification/request", {
      cookie: u.cookie,
      body: {},
    }),
  );
  let calls = 0;
  await Promise.all([
    deliverEmailBatch(async () => {
      calls++;
      await new Promise((r) => setTimeout(r, 20));
    }),
    deliverEmailBatch(async () => {
      calls++;
    }),
  ]);
  assert.equal(calls, 1);
  await sql`UPDATE email_requests SET consumed_at=now()`;
  await sql`DELETE FROM auth_rate_limits`;
  await json(
    await request("/api/auth/email-verification/request", {
      cookie: u.cookie,
      body: {},
    }),
  );
  await sql`UPDATE email_outbox SET expires_at=now()-interval '1 second' WHERE state='pending'`;
  await sql`UPDATE email_requests SET expires_at=now()-interval '1 second' WHERE consumed_at IS NULL`;
  smtp(false);
  assert.equal(await deliverEmailBatch(), 0);
  assert.equal(
    (await sql`SELECT payload FROM email_outbox WHERE state='cancelled'`)[0]
      .payload,
    null,
  );
  assert.equal(
    (
      await sql`SELECT token_hash FROM email_requests ORDER BY created_at DESC LIMIT 1`
    )[0].tokenHash,
    null,
  );
});

test("held SMTP delivery leaves unrelated authenticated board reads and writes responsive", async () => {
  smtp(false);
  const owner = await setupUser(),
    i = await invite(owner.cookie, "other-admin@example.test");
  const response = await request("/api/auth/accept-invitation", {
    body: { token: i.token, name: "Other admin", password },
  });
  await json(response, 201);
  const cookie = response.headers.get("set-cookie")!.split(";")[0];
  smtp();
  await json(
    await request("/api/auth/email-verification/request", {
      cookie: owner.cookie,
      body: {},
    }),
  );
  let release!: () => void, ready!: () => void;
  const held = new Promise<void>((r) => {
      release = r;
    }),
    started = new Promise<void>((r) => {
      ready = r;
    });
  const sending = deliverEmailBatch(async () => {
    ready();
    await held;
  });
  await started;
  async function responsive(promise: Promise<Response>) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        promise,
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(
            () => reject(new Error("Unrelated operation blocked behind SMTP")),
            1500,
          );
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }
  try {
    await json(await responsive(request("/api/boards", { cookie })));
    await json(
      await responsive(
        request("/api/auth/email-change", { cookie: owner.cookie }),
      ),
    );
    await json(
      await responsive(
        request("/api/boards", {
          cookie,
          body: { name: "Available during SMTP", prefix: "MAIL" },
        }),
      ),
      201,
    );
  } finally {
    release();
    await sending;
  }
});

test("delivery waiting for identity authority rechecks cancellation before any SMTP handoff", async () => {
  const u = await setupUser();
  await json(
    await request("/api/auth/email-verification/request", {
      cookie: u.cookie,
      body: {},
    }),
  );
  let release!: () => void, ready!: (pid: number) => void;
  const hold = new Promise<void>((r) => {
      release = r;
    }),
    started = new Promise<number>((r) => {
      ready = r;
    });
  const cancel = sql.begin(async (tx) => {
    await tx`SELECT id FROM users WHERE id=${u.user.id} FOR NO KEY UPDATE`;
    ready((await tx`SELECT pg_backend_pid() AS pid`)[0].pid);
    await hold;
    await tx`UPDATE email_requests SET consumed_at=now()`;
    await tx`UPDATE email_outbox SET state='cancelled',payload=null,lease_token=null,lease_until=null`;
  });
  const pid = await started;
  let sends = 0;
  const sending = deliverEmailBatch(async () => {
    sends++;
  });
  try {
    const deadline = Date.now() + 5000;
    let waiting = false;
    while (Date.now() < deadline) {
      const [row] =
        await sql`SELECT count(*)::int AS count FROM pg_stat_activity WHERE ${pid}=ANY(pg_blocking_pids(pid))`;
      if (row.count > 0) {
        waiting = true;
        break;
      }
      await new Promise((r) => setTimeout(r, 10));
    }
    assert.equal(waiting, true);
  } finally {
    release();
    await cancel;
    await sending;
  }
  assert.equal(sends, 0);
});

test("expired invitation completion proof cannot create an account", async () => {
  const u = await setupUser(),
    i = await invite(u.cookie),
    code = await invitationCode(i.token);
  const proof = await json(
    await request("/api/auth/invitation/verification/confirm", {
      body: { token: i.token, name: "Expired proof", code },
    }),
  );
  await sql`UPDATE email_requests SET expires_at=now()-interval '1 second'`;
  assert.equal(
    (
      await request("/api/auth/accept-invitation", {
        body: {
          token: i.token,
          name: "Expired proof",
          password,
          verificationToken: proof.verificationToken,
        },
      })
    ).status,
    400,
  );
  assert.equal(
    (await sql`SELECT id FROM users WHERE email='invitee@example.test'`).length,
    0,
  );
});

test("SMTP has an absolute deadline, closes a stalled peer socket, and retries without holding workspace authority", async () => {
  const sockets = new Set<Socket>();
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.write("220 stalled fixture\r\n");
    socket.on("data", () => {});
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  process.env.MILL_SMTP_PORT = String(address.port);
  try {
    const u = await setupUser();
    await json(
      await request("/api/auth/email-verification/request", {
        cookie: u.cookie,
        body: {},
      }),
    );
    const started = Date.now();
    assert.equal(
      await deliverEmailBatch((message) => sendSmtpMessage(message, 100)),
      1,
    );
    assert.ok(Date.now() - started < 2000);
    const [row] = await sql`SELECT state,attempts,last_error FROM email_outbox`;
    assert.equal(row.state, "pending");
    assert.equal(row.attempts, 1);
    assert.equal(row.lastError, "delivery_failed");
    await json(
      await request("/api/boards", {
        cookie: u.cookie,
        body: { name: "Available after timeout", prefix: "WAIT" },
      }),
      201,
    );
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(sockets.size, 0);
  } finally {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((r) => server.close(() => r()));
  }
});

test("cancellation after SMTP initiation returns promptly, invalidates the proof and cannot be retried by a late failure", async () => {
  const u = await setupUser();
  await change(u.cookie);
  let release!: () => void,
    ready!: () => void,
    text = "";
  const held = new Promise<void>((r) => {
      release = r;
    }),
    started = new Promise<void>((r) => {
      ready = r;
    });
  let calls = 0;
  const sending = deliverEmailBatch(async (message) => {
    calls++;
    text = message.text;
    ready();
    await held;
    throw new Error("late SMTP failure");
  });
  await started;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const cancel = await Promise.race([
      request("/api/auth/email-change", {
        cookie: u.cookie,
        method: "DELETE",
        body: {},
      }),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error("Cancellation blocked behind SMTP")),
          1500,
        );
      }),
    ]);
    await json(cancel);
    assert.equal(
      (
        await request("/api/auth/email-change/confirm", {
          body: link(text, "/confirm-email-change"),
        })
      ).status,
      400,
    );
  } finally {
    clearTimeout(timer);
    release();
    await sending;
  }
  assert.equal(calls, 1);
  assert.equal(
    (await sql`SELECT state,payload FROM email_outbox`)[0].state,
    "cancelled",
  );
  assert.equal(
    (await sql`SELECT state,payload FROM email_outbox`)[0].payload,
    null,
  );
  assert.equal(
    await deliverEmailBatch(async () => {
      calls++;
    }),
    0,
  );
  assert.equal(calls, 1);
});

test("a stale sender cannot overwrite a replacement lease delivery receipt", async () => {
  const u = await setupUser();
  await json(
    await request("/api/auth/email-verification/request", {
      cookie: u.cookie,
      body: {},
    }),
  );
  let release!: () => void, ready!: () => void;
  const held = new Promise<void>((r) => {
      release = r;
    }),
    started = new Promise<void>((r) => {
      ready = r;
    });
  const old = deliverEmailBatch(async () => {
    ready();
    await held;
    throw new Error("old lease result");
  });
  await started;
  try {
    await sql`UPDATE email_outbox SET lease_until=now()-interval '1 second'`;
    assert.equal(await deliverEmailBatch(async () => {}), 1);
  } finally {
    release();
    await old;
  }
  const [row] =
    await sql`SELECT state,attempts,payload,last_error FROM email_outbox`;
  assert.equal(row.state, "delivered");
  assert.equal(row.attempts, 2);
  assert.equal(row.payload, null);
  assert.equal(row.lastError, null);
});

test("worker shutdown finishes only the current send and leaves the next queued message unclaimed", async () => {
  const u = await setupUser();
  await json(
    await request("/api/auth/email-verification/request", {
      cookie: u.cookie,
      body: {},
    }),
  );
  await change(u.cookie);
  let release!: () => void,
    ready!: () => void,
    calls = 0;
  const held = new Promise<void>((resolve) => {
      release = resolve;
    }),
    started = new Promise<void>((resolve) => {
      ready = resolve;
    });
  const stop = startEmailWorker(async () => {
    calls++;
    ready();
    await held;
  });
  let stopping: Promise<void> | undefined;
  try {
    await started;
    stopping = stop();
    assert.equal(calls, 1);
    release();
    await stopping;
    const rows =
      await sql`SELECT state,attempts,payload,lease_token,lease_until FROM email_outbox ORDER BY created_at,id`;
    assert.equal(rows.length, 2);
    assert.equal(rows[0].state, "delivered");
    assert.equal(rows[0].attempts, 1);
    assert.equal(rows[0].payload, null);
    assert.equal(rows[1].state, "pending");
    assert.equal(rows[1].attempts, 0);
    assert.equal(typeof rows[1].payload, "string");
    assert.equal(rows[1].leaseToken, null);
    assert.equal(rows[1].leaseUntil, null);
    assert.equal(calls, 1);
  } finally {
    release();
    await (stopping ?? stop());
  }
});

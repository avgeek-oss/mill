import { after, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID, randomBytes } from "node:crypto";
import {
  cleanupDatabase,
  request,
  resetDatabase,
  setupUser,
  setupOAuth,
  sql,
} from "./support.js";
import { registerPasskey, virtualPasskey } from "./passkey-support.js";
import { createOperatorRecovery } from "../apps/api/src/auth/recovery.js";
import { hashPassword, hashToken } from "../apps/api/src/auth/security.js";

beforeEach(resetDatabase);
after(cleanupDatabase);
const password = "Secure test passphrase 42!";
const origin = process.env.MILL_BASE_URL!;
const cookie = (response: Response) =>
  response.headers.get("set-cookie")?.split(";")[0] ?? "";
async function invite(
  adminCookie: string,
  email: string,
  role: "admin" | "member" | "viewer" = "member",
) {
  const invitation = await request("/api/auth/invitations", {
    cookie: adminCookie,
    body: { email, role },
  });
  assert.equal(invitation.status, 201);
  const data = await invitation.json();
  const accepted = await request("/api/auth/accept-invitation", {
    body: { token: data.token, name: email.split("@")[0], password },
  });
  assert.equal(accepted.status, 201);
  return {
    cookie: cookie(accepted),
    user: (await accepted.json()).user,
    invitation: data,
  };
}

test("first setup is atomic, has no default account, and stores only password/session hashes", async () => {
  assert.deepEqual(await (await request("/api/auth/status")).json(), {
    setupRequired: true,
  });
  const input = {
    workspaceName: "Team",
    name: "Admin",
    email: "ADMIN@example.test",
    password,
    dateFormat: "year-month-day",
    timeFormat: "12-hour",
    timeZone: "Asia/Kolkata",
  };
  const responses = await Promise.all([
    request("/api/auth/setup", { body: input }),
    request("/api/auth/setup", { body: input }),
  ]);
  assert.deepEqual(responses.map((r) => r.status).sort(), [201, 409]);
  const good = responses.find((r) => r.status === 201)!;
  const result = await good.json();
  assert.equal(result.user.email, "admin@example.test");
  assert.equal(result.user.dateFormat, "year-month-day");
  assert.equal(result.user.timeFormat, "12-hour");
  assert.equal(result.user.timeZone, "Asia/Kolkata");
  assert.equal(JSON.stringify(result).includes("password"), false);
  const [stored] = await sql`SELECT password_hash FROM users`;
  assert.match(stored.passwordHash, /^scrypt:/);
  const [session] = await sql`SELECT token_hash FROM sessions`;
  assert.equal(session.tokenHash, hashToken(cookie(good).split("=")[1]));
  assert.match(good.headers.get("set-cookie")!, /HttpOnly/);
  assert.match(good.headers.get("set-cookie")!, /SameSite=Lax/i);
  assert.deepEqual(await (await request("/api/auth/status")).json(), {
    setupRequired: false,
  });
});
test("setup rejects invalid preferences before creating any account and defaults omitted formats", async () => {
  const input = {
    workspaceName: "Team",
    name: "Admin",
    email: "admin@example.test",
    password,
  };
  for (const invalid of [
    { dateFormat: "unsupported" },
    { timeFormat: "unsupported" },
    { timeZone: "invented/timezone" },
    { unexpected: true },
  ]) {
    assert.equal(
      (await request("/api/auth/setup", { body: { ...input, ...invalid } }))
        .status,
      400,
    );
    assert.equal(
      (await sql`SELECT count(*)::int AS count FROM workspace`)[0].count,
      0,
    );
    assert.equal(
      (await sql`SELECT count(*)::int AS count FROM users`)[0].count,
      0,
    );
  }
  const response = await request("/api/auth/setup", { body: input });
  assert.equal(response.status, 201);
  const { user } = await response.json();
  assert.equal(user.dateFormat, "day-short-month-year");
  assert.equal(user.timeFormat, "24-hour");
  assert.equal(user.timeZone, "UTC");
});

test("login rejects invalid credentials and supports session list, revocation and sign out", async () => {
  const admin = await setupUser();
  assert.equal(
    (
      await request("/api/auth/login", {
        body: { email: admin.user.email, password: "incorrect" },
      })
    ).status,
    401,
  );
  const login = await request("/api/auth/login", {
    body: { email: admin.user.email, password },
  });
  assert.equal(login.status, 200);
  const secondCookie = cookie(login);
  const sessions = (
    await (await request("/api/auth/sessions", { cookie: admin.cookie })).json()
  ).items;
  assert.equal(sessions.length, 2);
  assert.equal(JSON.stringify(sessions).includes("token"), false);
  const other = sessions.find((s: { current: boolean }) => !s.current);
  assert.equal(
    (
      await request(`/api/auth/sessions/${other.id}`, {
        method: "DELETE",
        cookie: admin.cookie,
      })
    ).status,
    200,
  );
  assert.equal(
    (await request("/api/auth/me", { cookie: secondCookie })).status,
    401,
  );
  assert.equal(
    (await request("/api/auth/logout", { body: {}, cookie: admin.cookie }))
      .status,
    200,
  );
  assert.equal(
    (await request("/api/auth/me", { cookie: admin.cookie })).status,
    401,
  );
});
test("password login is persistently rate limited across attempts", async () => {
  await setupUser();
  for (let i = 0; i < 10; i++)
    assert.equal(
      (
        await request("/api/auth/login", {
          body: { email: "admin@example.test", password: "wrong" },
        })
      ).status,
      401,
    );
  assert.equal(
    (
      await request("/api/auth/login", {
        body: { email: "admin@example.test", password },
      })
    ).status,
    429,
  );
});
test("profiles validate time zones, preserve omitted preferences and reject API-key account access", async () => {
  const admin = await setupUser();
  const changed = await request("/api/auth/profile", {
    method: "PATCH",
    cookie: admin.cookie,
    body: {
      name: "Pat",
      timeZone: "Asia/Kolkata",
      dateFormat: "month-day-year",
      timeFormat: "12-hour",
      notificationPreferences: { assignments: false, mentions: true },
    },
  });
  assert.equal(changed.status, 200);
  const data = await changed.json();
  assert.equal(data.user.timeZone, "Asia/Kolkata");
  assert.equal(data.user.dateFormat, "month-day-year");
  assert.equal(data.user.timeFormat, "12-hour");
  const preserved = await (
    await request("/api/auth/profile", {
      method: "PATCH",
      cookie: admin.cookie,
      body: { name: "Pat Updated" },
    })
  ).json();
  assert.equal(preserved.user.dateFormat, "month-day-year");
  assert.equal(preserved.user.timeFormat, "12-hour");
  assert.equal(preserved.user.timeZone, "Asia/Kolkata");
  for (const body of [
    { dateFormat: "invented" },
    { timeFormat: "invented" },
    { unsupported: true },
  ]) {
    assert.equal(
      (
        await request("/api/auth/profile", {
          method: "PATCH",
          cookie: admin.cookie,
          body,
        })
      ).status,
      400,
    );
  }
  assert.deepEqual(data.user.notificationPreferences, {
    assignments: false,
    mentions: true,
  });
  assert.equal(
    (
      await request("/api/auth/profile", {
        method: "PATCH",
        cookie: admin.cookie,
        body: { timeZone: "invented/timezone" },
      })
    ).status,
    400,
  );
  assert.equal(
    (
      await request("/api/auth/profile", {
        method: "PATCH",
        cookie: admin.cookie,
        body: { timeZone: "" },
      })
    ).status,
    400,
  );
  const credential = await (
    await request("/api/credentials", {
      cookie: admin.cookie,
      body: {
        name: "Personal API key",
      },
    })
  ).json();
  assert.equal(
    (await request("/api/auth/me", { token: credential.token })).status,
    403,
  );
  assert.equal(
    (await request("/api/auth/sessions", { token: credential.token })).status,
    403,
  );
  assert.equal(
    (await request("/api/auth/members", { token: credential.token })).status,
    403,
  );
  assert.equal(
    (
      await request("/api/auth/invitations", {
        token: credential.token,
        body: { email: "x@example.test", role: "admin" },
      })
    ).status,
    403,
  );
});
test("concurrent profile changes preserve each independently supplied preference", async () => {
  const admin = await setupUser();
  const responses = await Promise.all([
    request("/api/auth/profile", {
      cookie: admin.cookie,
      method: "PATCH",
      body: { dateFormat: "year-month-day" },
    }),
    request("/api/auth/profile", {
      cookie: admin.cookie,
      method: "PATCH",
      body: { timeFormat: "12-hour", timeZone: "Asia/Kathmandu" },
    }),
  ]);
  assert.deepEqual(
    responses.map((response) => response.status),
    [200, 200],
  );
  const { user } = await (
    await request("/api/auth/me", { cookie: admin.cookie })
  ).json();
  assert.equal(user.dateFormat, "year-month-day");
  assert.equal(user.timeFormat, "12-hour");
  assert.equal(user.timeZone, "Asia/Kathmandu");
});

test("date and time preferences remain scoped to the signed-in user", async () => {
  const admin = await setupUser();
  const member = await invite(admin.cookie, "preferences-member@example.test");
  const changed = await request("/api/auth/profile", {
    cookie: member.cookie,
    method: "PATCH",
    body: {
      dateFormat: "year-month-day",
      timeFormat: "12-hour",
      timeZone: "Asia/Kathmandu",
    },
  });
  assert.equal(changed.status, 200);
  const reloaded = await (
    await request("/api/auth/me", { cookie: member.cookie })
  ).json();
  assert.equal(reloaded.user.dateFormat, "year-month-day");
  assert.equal(reloaded.user.timeFormat, "12-hour");
  assert.equal(reloaded.user.timeZone, "Asia/Kathmandu");
  const other = await (
    await request("/api/auth/me", { cookie: admin.cookie })
  ).json();
  assert.equal(other.user.dateFormat, "day-short-month-year");
  assert.equal(other.user.timeFormat, "24-hour");
  assert.equal(other.user.timeZone, "UTC");
  assert.equal(
    (
      await request("/api/auth/profile", {
        cookie: member.cookie,
        method: "PATCH",
        body: { userId: admin.user.id, dateFormat: "month-day-year" },
      })
    ).status,
    400,
  );
});

test("profiles expose only in-app notification preferences and reject email delivery settings", async () => {
  const admin = await setupUser();
  await sql`UPDATE users SET notification_preferences=${sql.json({ assignments: false, mentions: true, email: true })} WHERE id=${admin.user.id}`;
  const preferences = { assignments: false, mentions: true };
  const identity = await (
    await request("/api/auth/me", { cookie: admin.cookie })
  ).json();
  assert.deepEqual(identity.user.notificationPreferences, preferences);
  const unsupported = await request("/api/auth/profile", {
    method: "PATCH",
    cookie: admin.cookie,
    body: { notificationPreferences: { ...preferences, email: false } },
  });
  assert.equal(unsupported.status, 400);
  const changed = await request("/api/auth/profile", {
    method: "PATCH",
    cookie: admin.cookie,
    body: { timeZone: "UTC" },
  });
  assert.equal(changed.status, 200);
  assert.deepEqual(
    (await changed.json()).user.notificationPreferences,
    preferences,
  );
  const [stored] =
    await sql`SELECT notification_preferences FROM users WHERE id=${admin.user.id}`;
  assert.deepEqual(stored.notificationPreferences, preferences);
});
test("invitations are one-time, expiring, revocable and only administrators can issue them", async () => {
  const admin = await setupUser();
  const member = await invite(admin.cookie, "member@example.test");
  assert.equal(member.invitation.emailDelivery, "unavailable");
  assert.equal(
    (
      await request("/api/auth/accept-invitation", {
        body: { token: member.invitation.token, name: "Repeat", password },
      })
    ).status,
    400,
  );
  assert.equal(
    (
      await request("/api/auth/invitations", {
        cookie: member.cookie,
        body: { email: "other@example.test", role: "member" },
      })
    ).status,
    403,
  );
  const inv = await (
    await request("/api/auth/invitations", {
      cookie: admin.cookie,
      body: { email: "expired@example.test", role: "viewer" },
    })
  ).json();
  await sql`UPDATE invitations SET expires_at=now()-interval '1 minute' WHERE id=${inv.invitation.id}`;
  assert.equal(
    (
      await request("/api/auth/accept-invitation", {
        body: { token: inv.token, name: "Expired", password },
      })
    ).status,
    400,
  );
  const rev = await (
    await request("/api/auth/invitations", {
      cookie: admin.cookie,
      body: { email: "revoked@example.test", role: "viewer" },
    })
  ).json();
  assert.equal(
    (
      await request(`/api/auth/invitations/${rev.invitation.id}`, {
        method: "DELETE",
        cookie: admin.cookie,
      })
    ).status,
    200,
  );
  assert.equal(
    (
      await request("/api/auth/accept-invitation", {
        body: { token: rev.token, name: "Revoked", password },
      })
    ).status,
    400,
  );
  const list = await (
    await request("/api/auth/invitations", { cookie: admin.cookie })
  ).json();
  assert.equal(JSON.stringify(list).includes("token"), false);
  assert.equal(
    list.items.some((item: { id: string }) => item.id === inv.invitation.id),
    false,
  );
  assert.equal(
    list.items.some((item: { id: string }) => item.id === rev.invitation.id),
    true,
  );
  assert.equal(
    list.items.some(
      (item: { id: string }) => item.id === member.invitation.invitation.id,
    ),
    true,
  );
});
test("expired invitations do not consume list pages, and an expired cursor still reaches older invitations", async () => {
  const admin = await setupUser();
  const ids = Array.from({ length: 4 }, () => randomUUID());
  for (const [index, id] of ids.entries()) {
    await sql`INSERT INTO invitations(id,email,role,token_hash,invited_by,created_at,expires_at)
      VALUES(${id},${`pagination-${index}@example.test`},'viewer',${randomUUID()},${admin.user.id},now()-${index}*interval '1 minute',now()+interval '1 day')`;
  }
  await sql`UPDATE invitations SET expires_at=now()-interval '1 second' WHERE id IN (${ids[0]},${ids[2]})`;
  const first = await (
    await request("/api/auth/invitations?limit=1", { cookie: admin.cookie })
  ).json();
  assert.deepEqual(
    first.items.map((item: { id: string }) => item.id),
    [ids[1]],
  );
  assert.equal(first.hasMore, true);
  assert.equal(first.nextCursor, ids[1]);
  await sql`UPDATE invitations SET expires_at=now()-interval '1 second' WHERE id=${ids[1]}`;
  const next = await (
    await request(`/api/auth/invitations?limit=1&cursor=${first.nextCursor}`, {
      cookie: admin.cookie,
    })
  ).json();
  assert.deepEqual(
    next.items.map((item: { id: string }) => item.id),
    [ids[3]],
  );
  assert.equal(next.hasMore, false);
  assert.equal(next.nextCursor, null);
  assert.equal((await sql`SELECT id FROM invitations`).length, 4);
});
test("last administrator protection survives concurrent demotion and member removal revokes access", async () => {
  const admin = await setupUser();
  assert.equal(
    (
      await request(`/api/auth/members/${admin.user.id}`, {
        method: "DELETE",
        cookie: admin.cookie,
      })
    ).status,
    409,
  );
  const second = await invite(admin.cookie, "second@example.test", "admin");
  const responses = await Promise.all([
    request(`/api/auth/members/${admin.user.id}`, {
      method: "PATCH",
      cookie: admin.cookie,
      body: { role: "member" },
    }),
    request(`/api/auth/members/${second.user.id}`, {
      method: "PATCH",
      cookie: second.cookie,
      body: { role: "member" },
    }),
  ]);
  assert.deepEqual(responses.map((r) => r.status).sort(), [200, 409]);
  const [remaining] =
    await sql`SELECT id FROM users WHERE role='admin' AND disabled_at IS NULL`;
  const adminCookie =
    remaining.id === admin.user.id ? admin.cookie : second.cookie;
  const member = await invite(adminCookie, "disabled@example.test");
  const credential = await (
    await request("/api/credentials", {
      cookie: member.cookie,
      body: {
        name: "Member API key",
      },
    })
  ).json();
  assert.equal(
    (
      await request(`/api/auth/members/${member.user.id}`, {
        method: "DELETE",
        cookie: adminCookie,
      })
    ).status,
    200,
  );
  assert.equal(
    (await request("/api/auth/me", { cookie: member.cookie })).status,
    401,
  );
  assert.equal(
    (await request("/api/boards", { token: credential.token })).status,
    401,
  );
  const rejoined = await invite(adminCookie, "disabled@example.test");
  assert.equal(rejoined.user.id, member.user.id);
});
test("passkey recovery is atomic, single-use, digest-only and cannot approve security changes", async () => {
  const admin = await setupUser();
  const passkey = await registerPasskey(admin.cookie, admin.user.id);
  const stored = await sql`SELECT code_hash FROM recovery_codes`;
  assert.equal(stored.length, 10);
  assert.equal(stored[0].codeHash.length, 64);
  assert.ok(
    stored.every((row) => !passkey.recoveryCodes.includes(row.codeHash)),
  );
  const login = async () =>
    await (
      await request("/api/auth/login", {
        body: { email: admin.user.email, password },
      })
    ).json();
  const first = await login();
  const second = await login();
  assert.deepEqual(first.methods, ["passkey"]);
  assert.equal(first.recoveryAvailable, true);
  const results = await Promise.all(
    [first, second].map((challenge) =>
      request("/api/auth/passkeys/recovery/verify", {
        body: {
          challengeId: challenge.challengeId,
          code: passkey.recoveryCodes[0],
        },
      }),
    ),
  );
  assert.deepEqual(results.map((result) => result.status).sort(), [200, 400]);
  const recovered = results.find((result) => result.status === 200)!;
  const recoveryCookie = cookie(recovered);
  assert.equal(
    (await request("/api/auth/me", { cookie: recoveryCookie })).status,
    200,
  );
  const deniedKey = await request("/api/credentials", {
    cookie: recoveryCookie,
    body: { name: "Recovery key" },
  });
  assert.equal(deniedKey.status, 403);
  assert.equal(
    (await deniedKey.json()).error.code,
    "REAUTHENTICATION_REQUIRED",
  );
  await assert.rejects(
    setupOAuth(recoveryCookie),
    /OAuth approval failed: 403/,
  );
  assert.equal((await sql`SELECT * FROM credentials`).length, 0);
  const [pendingConsent] =
    await sql`SELECT id FROM oauth_requests WHERE consumed_at IS NULL`;
  assert.equal(
    (
      await request(`/api/oauth/consent/${pendingConsent.id}`, {
        cookie: recoveryCookie,
        body: { allow: false },
      })
    ).status,
    200,
  );
  for (const path of [
    "/api/auth/passkeys/register/options",
    "/api/auth/passkeys/recovery-codes",
  ])
    assert.equal(
      (await request(path, { cookie: recoveryCookie, body: {} })).status,
      403,
    );
  assert.equal(
    (
      await request(`/api/auth/passkeys/${passkey.id}`, {
        cookie: recoveryCookie,
        method: "DELETE",
      })
    ).status,
    403,
  );
  assert.equal(
    (
      await request("/api/auth/password", {
        cookie: recoveryCookie,
        body: {
          currentPassword: password,
          password: "New secure recovery password 42!",
        },
      })
    ).status,
    403,
  );
  const pending = await login();
  assert.equal(
    (
      await request("/api/auth/passkeys/recovery/verify", {
        body: {
          challengeId: pending.challengeId,
          code: passkey.recoveryCodes[0],
        },
      })
    ).status,
    400,
  );
  const [count] = await sql`SELECT count(*)::int AS total FROM recovery_codes`;
  assert.equal(count.total, 9);
  const reauth = await (
    await request("/api/auth/reauth", {
      cookie: recoveryCookie,
      body: { password },
    })
  ).json();
  assert.equal(reauth.recoveryAvailable, false);
  assert.equal(
    (
      await request("/api/auth/passkeys/recovery/verify", {
        cookie: recoveryCookie,
        body: {
          challengeId: reauth.challengeId,
          code: passkey.recoveryCodes[1],
        },
      })
    ).status,
    400,
  );
  const proofOptions = await (
    await request("/api/auth/passkeys/authenticate/options", {
      cookie: recoveryCookie,
      body: { challengeId: reauth.challengeId },
    })
  ).json();
  assert.equal(
    (
      await request("/api/auth/passkeys/authenticate/verify", {
        cookie: recoveryCookie,
        body: {
          challengeId: proofOptions.challengeId,
          response: passkey.authentication(proofOptions.options.challenge),
        },
      })
    ).status,
    200,
  );
  assert.equal(
    (
      await request("/api/credentials", {
        cookie: recoveryCookie,
        body: { name: "Approved key" },
      })
    ).status,
    201,
  );
  assert.ok(
    (
      await setupOAuth(recoveryCookie, {
        idempotencyKey: "passkey-oauth-replay-001",
      })
    ).token,
  );
  const [approvedConsent] =
    await sql`SELECT id FROM oauth_requests WHERE code_hash IS NOT NULL`;
  await sql`UPDATE sessions SET authenticated_at=now()-interval '11 minutes'`;
  const deniedReplay = await request(
    `/api/oauth/consent/${approvedConsent.id}`,
    {
      cookie: recoveryCookie,
      body: { allow: true },
      headers: { "Idempotency-Key": "passkey-oauth-replay-001" },
    },
  );
  assert.equal(deniedReplay.status, 403);
  assert.equal(
    (await deniedReplay.json()).error.code,
    "REAUTHENTICATION_REQUIRED",
  );
});
test("passkey ceremonies verify real signatures and origin and require passkeys after password proof", async () => {
  const admin = await setupUser();
  const passkey = await registerPasskey(admin.cookie, admin.user.id);
  const login = await request("/api/auth/login", {
    body: { email: admin.user.email, password },
  });
  assert.equal(login.headers.get("set-cookie"), null);
  const challenge = await login.json();
  assert.equal(challenge.preferredMethod, "passkey");
  assert.deepEqual(challenge.methods, ["passkey"]);
  const options = await (
    await request("/api/auth/passkeys/authenticate/options", {
      body: { challengeId: challenge.challengeId },
    })
  ).json();
  const wrongOrigin = await request("/api/auth/passkeys/authenticate/verify", {
    body: {
      challengeId: options.challengeId,
      response: passkey.authentication(
        options.options.challenge,
        "https://untrusted.example",
      ),
    },
  });
  assert.equal(wrongOrigin.status, 400);
  const proof = passkey.authentication(options.options.challenge);
  const verified = await request("/api/auth/passkeys/authenticate/verify", {
    body: { challengeId: options.challengeId, response: proof },
  });
  assert.equal(verified.status, 200, JSON.stringify(await verified.json()));
  assert.equal(
    (await request("/api/auth/me", { cookie: cookie(verified) })).status,
    200,
  );
  assert.equal(
    (
      await request("/api/auth/passkeys/authenticate/verify", {
        body: { challengeId: options.challengeId, response: proof },
      })
    ).status,
    400,
  );
  const fallback = await (
    await request("/api/auth/login", {
      body: { email: admin.user.email, password },
    })
  ).json();
  assert.equal(
    (
      await request("/api/auth/second-factor", {
        body: {
          challengeId: fallback.challengeId,
          method: "totp",
          code: "000000",
        },
      })
    ).status,
    404,
  );
  const direct = await (
    await request("/api/auth/passkeys/authenticate/options", { body: {} })
  ).json();
  assert.equal(
    (
      await request("/api/auth/passkeys/authenticate/verify", {
        body: {
          challengeId: direct.challengeId,
          response: passkey.authentication(direct.options.challenge),
        },
      })
    ).status,
    200,
  );
});
test("passkey registration cannot cross sessions and expired challenges do not authenticate", async () => {
  const admin = await setupUser();
  const passkey = virtualPasskey(admin.user.id);
  const options = await (
    await request("/api/auth/passkeys/register/options", {
      cookie: admin.cookie,
      body: {},
    })
  ).json();
  const login = await request("/api/auth/login", {
    body: { email: admin.user.email, password },
  });
  const response = {
    challengeId: options.challengeId,
    name: "Test",
    response: passkey.registration(options.options.challenge),
  };
  assert.equal(
    (
      await request("/api/auth/passkeys/register/verify", {
        cookie: cookie(login),
        body: response,
      })
    ).status,
    400,
  );
  assert.equal(
    (
      await request("/api/auth/passkeys/register/verify", {
        cookie: admin.cookie,
        body: {
          ...response,
          response: passkey.registration(
            options.options.challenge,
            "https://untrusted.example",
          ),
        },
      })
    ).status,
    400,
  );
  await sql`UPDATE auth_challenges SET expires_at=now()-interval '1 minute'`;
  assert.equal(
    (
      await request("/api/auth/passkeys/register/verify", {
        cookie: admin.cookie,
        body: response,
      })
    ).status,
    400,
  );
});
test("security settings require recent identity verification and passkey reauthentication is session-bound", async () => {
  const admin = await setupUser();
  await sql`UPDATE sessions SET authenticated_at=now()-interval '11 minutes'`;
  assert.equal(
    (
      await request("/api/auth/passkeys/register/options", {
        cookie: admin.cookie,
        body: {},
      })
    ).status,
    403,
  );
  assert.equal(
    (
      await request("/api/auth/reauth", {
        cookie: admin.cookie,
        body: { password },
      })
    ).status,
    200,
  );
  const passkey = await registerPasskey(admin.cookie, admin.user.id);
  const other = await (
    await request("/api/auth/passkeys/authenticate/options", { body: {} })
  ).json();
  const otherLogin = await request("/api/auth/passkeys/authenticate/verify", {
    body: {
      challengeId: other.challengeId,
      response: passkey.authentication(other.options.challenge),
    },
  });
  const otherCookie = cookie(otherLogin);
  await sql`UPDATE sessions SET authenticated_at=now()-interval '11 minutes',passkey_authenticated_at=null`;
  const challenge = await (
    await request("/api/auth/reauth", {
      cookie: admin.cookie,
      body: { password },
    })
  ).json();
  const options = await (
    await request("/api/auth/passkeys/authenticate/options", {
      cookie: admin.cookie,
      body: { challengeId: challenge.challengeId },
    })
  ).json();
  const response = passkey.authentication(options.options.challenge);
  assert.equal(
    (
      await request("/api/auth/passkeys/authenticate/verify", {
        body: { challengeId: options.challengeId, response },
      })
    ).status,
    401,
  );
  assert.equal(
    (
      await request("/api/auth/passkeys/authenticate/verify", {
        cookie: otherCookie,
        body: { challengeId: options.challengeId, response },
      })
    ).status,
    403,
  );
  assert.equal(
    (
      await request("/api/auth/passkeys/authenticate/verify", {
        cookie: admin.cookie,
        body: { challengeId: options.challengeId, response },
      })
    ).status,
    200,
  );
  assert.equal(
    (
      await request("/api/auth/passkeys/register/options", {
        cookie: admin.cookie,
        body: {},
      })
    ).status,
    200,
  );
  assert.equal(
    (
      await request("/api/auth/passkeys/recovery-codes", {
        cookie: admin.cookie,
        body: {},
      })
    ).status,
    200,
  );
});
test("password changes revoke other sessions and API keys, preserving the current session", async () => {
  const admin = await setupUser();
  const secondCookie = cookie(
    await request("/api/auth/login", {
      body: { email: admin.user.email, password },
    }),
  );
  const credential = await (
    await request("/api/credentials", {
      cookie: admin.cookie,
      body: {
        name: "Personal API key",
      },
    })
  ).json();
  const changed = await request("/api/auth/password", {
    cookie: admin.cookie,
    body: {
      currentPassword: password,
      password: "A new secure passphrase 2026!",
    },
  });
  assert.equal(changed.status, 200);
  assert.equal(
    (await request("/api/auth/me", { cookie: admin.cookie })).status,
    200,
  );
  assert.equal(
    (await request("/api/auth/me", { cookie: secondCookie })).status,
    401,
  );
  assert.equal(
    (await request("/api/boards", { token: credential.token })).status,
    401,
  );
  assert.equal(
    (
      await request("/api/auth/login", {
        body: { email: admin.user.email, password },
      })
    ).status,
    401,
  );
  assert.equal(
    (
      await request("/api/auth/login", {
        body: {
          email: admin.user.email,
          password: "A new secure passphrase 2026!",
        },
      })
    ).status,
    200,
  );
});
test("operator recovery links expire, are single-use, revoke credentials and can recover lost MFA", async () => {
  const admin = await setupUser();
  await registerPasskey(admin.cookie, admin.user.id);
  const credential = await (
    await request("/api/credentials", {
      cookie: admin.cookie,
      body: {
        name: "Personal API key",
      },
    })
  ).json();
  const token = await createOperatorRecovery(admin.user.email, true);
  const [stored] = await sql`SELECT token_hash FROM account_recovery`;
  assert.equal(stored.tokenHash, hashToken(token));
  const reset = await request("/api/auth/recovery/reset", {
    body: { token, password: "Recovered secure passphrase 42!" },
  });
  assert.equal(reset.status, 200);
  assert.equal(
    (await request("/api/auth/recovery/reset", { body: { token, password } }))
      .status,
    400,
  );
  assert.equal(
    (await request("/api/auth/me", { cookie: admin.cookie })).status,
    401,
  );
  assert.equal(
    (await request("/api/boards", { token: credential.token })).status,
    401,
  );
  const login = await request("/api/auth/login", {
    body: {
      email: admin.user.email,
      password: "Recovered secure passphrase 42!",
    },
  });
  assert.equal(login.status, 200);
  assert.equal((await login.json()).user.passkeyCount, 0);
  const expired = await createOperatorRecovery(admin.user.email);
  await sql`UPDATE account_recovery SET expires_at=now()-interval '1 minute'`;
  assert.equal(
    (
      await request("/api/auth/recovery/reset", {
        body: { token: expired, password },
      })
    ).status,
    400,
  );
});
test("a stale password proof cannot create a session after a concurrent security reset", async () => {
  const admin = await setupUser();
  const newHash = await hashPassword("Recovered concurrent password 42!");
  let pending: Promise<Response>;
  await sql.begin(async (tx) => {
    const [{ pid }] = await tx`SELECT pg_backend_pid() AS pid`;
    await tx`SELECT id FROM workspace FOR UPDATE`;
    await tx`SELECT id FROM users WHERE id=${admin.user.id} FOR UPDATE`;
    pending = request("/api/auth/login", {
      body: { email: admin.user.email, password },
    });
    let blocked = false;
    for (let attempts = 0; attempts < 100; attempts++) {
      const [waiting] =
        await sql`SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE ${pid}=ANY(pg_blocking_pids(pid))) AS blocked`;
      if (waiting.blocked) {
        blocked = true;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(
      blocked,
      true,
      "Login reached the locked workspace authority before its security-state recheck",
    );
    await tx`UPDATE users SET password_hash=${newHash},security_epoch=security_epoch+1 WHERE id=${admin.user.id}`;
    await tx`DELETE FROM sessions WHERE user_id=${admin.user.id}`;
  });
  assert.equal((await pending!).status, 401);
  const [count] = await sql`SELECT count(*)::int AS total FROM sessions`;
  assert.equal(count.total, 0);
});
test("passkeys require user verification and a valid signature, and revocation terminates other sessions", async () => {
  const admin = await setupUser();
  const passkey = await registerPasskey(admin.cookie, admin.user.id);
  const challenge = await (
    await request("/api/auth/passkeys/authenticate/options", { body: {} })
  ).json();
  const noVerification = passkey.authentication(
    challenge.options.challenge,
    origin,
    0x01,
  );
  assert.equal(
    (
      await request("/api/auth/passkeys/authenticate/verify", {
        body: { challengeId: challenge.challengeId, response: noVerification },
      })
    ).status,
    400,
  );
  const invalid = passkey.authentication(challenge.options.challenge);
  invalid.response.signature = randomBytes(64).toString("base64url");
  assert.equal(
    (
      await request("/api/auth/passkeys/authenticate/verify", {
        body: { challengeId: challenge.challengeId, response: invalid },
      })
    ).status,
    400,
  );
  const valid = await request("/api/auth/passkeys/authenticate/verify", {
    body: {
      challengeId: challenge.challengeId,
      response: passkey.authentication(challenge.options.challenge),
    },
  });
  assert.equal(valid.status, 200);
  const otherCookie = cookie(valid);
  assert.equal(
    (
      await request(`/api/auth/passkeys/${passkey.id}`, {
        method: "DELETE",
        cookie: admin.cookie,
      })
    ).status,
    200,
  );
  assert.equal(
    (await request("/api/auth/me", { cookie: otherCookie })).status,
    401,
  );
  assert.equal(
    (await (await request("/api/auth/me", { cookie: admin.cookie })).json())
      .user.passkeyCount,
    0,
  );
  const revoked = await (
    await request("/api/auth/passkeys/authenticate/options", { body: {} })
  ).json();
  assert.equal(
    (
      await request("/api/auth/passkeys/authenticate/verify", {
        body: {
          challengeId: revoked.challengeId,
          response: passkey.authentication(revoked.options.challenge),
        },
      })
    ).status,
    400,
  );
});
test("last passkey removal clears recovery codes and restores password-only sign-in", async () => {
  const admin = await setupUser();
  const passkey = await registerPasskey(admin.cookie, admin.user.id);
  assert.equal(
    (
      await request(`/api/auth/passkeys/${passkey.id}`, {
        cookie: admin.cookie,
        method: "DELETE",
      })
    ).status,
    200,
  );
  const [count] = await sql`SELECT count(*)::int AS total FROM recovery_codes`;
  assert.equal(count.total, 0);
  assert.equal(
    (
      await request("/api/auth/passkeys/recovery-codes", {
        cookie: admin.cookie,
        body: {},
      })
    ).status,
    403,
  );
  const login = await request("/api/auth/login", {
    body: { email: admin.user.email, password },
  });
  assert.ok((await login.json()).user);
});
test("replacing passkey recovery codes requires fresh passkey proof and invalidates previous codes", async () => {
  const admin = await setupUser();
  assert.equal(
    (
      await request("/api/auth/passkeys/recovery-codes", {
        cookie: admin.cookie,
        body: {},
      })
    ).status,
    403,
  );
  const passkey = await registerPasskey(admin.cookie, admin.user.id);
  await sql`UPDATE sessions SET passkey_authenticated_at=now()-interval '11 minutes'`;
  assert.equal(
    (
      await request("/api/auth/passkeys/recovery-codes", {
        cookie: admin.cookie,
        body: {},
      })
    ).status,
    403,
  );
  const staleRegistration = await request(
    "/api/auth/passkeys/register/options",
    { cookie: admin.cookie, body: {} },
  );
  assert.equal(staleRegistration.status, 403);
  assert.equal(
    (await staleRegistration.json()).error.code,
    "REAUTHENTICATION_REQUIRED",
  );
  assert.equal(
    (
      await request("/api/credentials", {
        cookie: admin.cookie,
        body: { name: "Expired passkey proof" },
      })
    ).status,
    403,
  );
  const options = await (
    await request("/api/auth/passkeys/authenticate/options", {
      cookie: admin.cookie,
      body: {},
    })
  ).json();
  assert.equal(
    (
      await request("/api/auth/passkeys/authenticate/verify", {
        cookie: admin.cookie,
        body: {
          challengeId: options.challengeId,
          response: passkey.authentication(options.options.challenge),
        },
      })
    ).status,
    200,
  );
  const regenerated = await request("/api/auth/passkeys/recovery-codes", {
    cookie: admin.cookie,
    body: {},
  });
  assert.equal(regenerated.status, 200);
  const codes = (await regenerated.json()).recoveryCodes;
  assert.equal(codes.length, 10);
  const challenge = await (
    await request("/api/auth/login", {
      body: { email: admin.user.email, password },
    })
  ).json();
  assert.equal(
    (
      await request("/api/auth/passkeys/recovery/verify", {
        body: {
          challengeId: challenge.challengeId,
          code: passkey.recoveryCodes[0],
        },
      })
    ).status,
    400,
  );
  assert.equal(
    (
      await request("/api/auth/passkeys/recovery/verify", {
        body: { challengeId: challenge.challengeId, code: codes[0] },
      })
    ).status,
    200,
  );
});
test("TOTP endpoints are absent and account metadata exposes only passkey security", async () => {
  const admin = await setupUser();
  for (const endpoint of ["setup", "verify", "disable", "recovery-codes"])
    assert.equal(
      (
        await request(`/api/auth/totp/${endpoint}`, {
          cookie: admin.cookie,
          body: {},
        })
      ).status,
      404,
    );
  assert.equal("totpEnabled" in admin.user, false);
  const [table] =
    await sql`SELECT EXISTS(SELECT 1 FROM information_schema.tables WHERE table_schema=${process.env.MILL_DB_SCHEMA!} AND table_name='authenticators') AS present`;
  assert.equal(table.present, false);
});

test("passkey and recovery proofs cannot cross account ownership or expired password challenges", async () => {
  const admin = await setupUser();
  const member = await invite(admin.cookie, "member-passkey@example.test");
  const adminKey = await registerPasskey(admin.cookie, admin.user.id);
  const memberKey = await registerPasskey(member.cookie, member.user.id);
  const login = await (
    await request("/api/auth/login", {
      body: { email: admin.user.email, password },
    })
  ).json();
  const options = await (
    await request("/api/auth/passkeys/authenticate/options", {
      body: { challengeId: login.challengeId },
    })
  ).json();
  assert.equal(
    (
      await request("/api/auth/passkeys/authenticate/verify", {
        body: {
          challengeId: options.challengeId,
          response: memberKey.authentication(options.options.challenge),
        },
      })
    ).status,
    400,
  );
  assert.equal(
    (
      await request("/api/auth/passkeys/recovery/verify", {
        body: {
          challengeId: login.challengeId,
          code: memberKey.recoveryCodes[0],
        },
      })
    ).status,
    400,
  );
  assert.equal((await sql`SELECT * FROM recovery_codes`).length, 20);
  await sql`UPDATE auth_challenges SET expires_at=now()-interval '1 minute' WHERE token_hash=${hashToken(login.challengeId)}`;
  assert.equal(
    (
      await request("/api/auth/passkeys/recovery/verify", {
        body: {
          challengeId: login.challengeId,
          code: adminKey.recoveryCodes[0],
        },
      })
    ).status,
    400,
  );
  assert.equal((await sql`SELECT * FROM recovery_codes`).length, 20);
});

test("challenge purposes cannot authorize a different operation and concurrent recovery consumes one challenge once", async () => {
  const admin = await setupUser();
  const key = virtualPasskey(admin.user.id);
  const registration = await (
    await request("/api/auth/passkeys/register/options", {
      cookie: admin.cookie,
      body: {},
    })
  ).json();
  assert.equal(
    (
      await request("/api/auth/passkeys/authenticate/options", {
        cookie: admin.cookie,
        body: { challengeId: registration.challengeId },
      })
    ).status,
    400,
  );
  assert.equal(
    (
      await request("/api/auth/passkeys/authenticate/verify", {
        cookie: admin.cookie,
        body: {
          challengeId: registration.challengeId,
          response: key.authentication(registration.options.challenge),
        },
      })
    ).status,
    400,
  );
  const registered = await request("/api/auth/passkeys/register/verify", {
    cookie: admin.cookie,
    body: {
      challengeId: registration.challengeId,
      name: "New passkey",
      response: key.registration(registration.options.challenge),
    },
  });
  assert.equal(registered.status, 200);
  const codes = (await registered.json()).recoveryCodes;
  const login = await (
    await request("/api/auth/login", {
      body: { email: admin.user.email, password },
    })
  ).json();
  assert.equal(
    (
      await request("/api/auth/passkeys/register/verify", {
        cookie: admin.cookie,
        body: {
          challengeId: login.challengeId,
          name: "Another passkey",
          response: key.registration(registration.options.challenge),
        },
      })
    ).status,
    400,
  );
  const attempts = await Promise.all(
    codes.slice(0, 2).map((code: string) =>
      request("/api/auth/passkeys/recovery/verify", {
        body: { challengeId: login.challengeId, code },
      }),
    ),
  );
  assert.deepEqual(attempts.map((result) => result.status).sort(), [200, 400]);
  assert.equal((await sql`SELECT * FROM recovery_codes`).length, 9);
});

test("expired browser cookies do not prevent a fresh passkey sign-in", async () => {
  const admin = await setupUser();
  const passkey = await registerPasskey(admin.cookie, admin.user.id);
  await sql`UPDATE sessions SET expires_at=now()-interval '1 minute'`;
  const optionsResponse = await request(
    "/api/auth/passkeys/authenticate/options",
    { cookie: admin.cookie, body: {} },
  );
  assert.equal(optionsResponse.status, 200);
  const options = await optionsResponse.json();
  const login = await request("/api/auth/passkeys/authenticate/verify", {
    cookie: admin.cookie,
    body: {
      challengeId: options.challengeId,
      response: passkey.authentication(options.options.challenge),
    },
  });
  assert.equal(login.status, 200);
  assert.equal(
    (await request("/api/auth/me", { cookie: cookie(login) })).status,
    200,
  );
});

test("member directory reports actual passkey status, excludes disabled members and invalidates cursors after factor changes", async () => {
  const admin = await setupUser();
  const viewer = await invite(
    admin.cookie,
    "viewer-status@example.test",
    "viewer",
  );
  const removed = await invite(admin.cookie, "removed-status@example.test");
  await registerPasskey(removed.cookie, removed.user.id);
  assert.equal(
    (
      await request(`/api/auth/members/${removed.user.id}`, {
        cookie: admin.cookie,
        method: "DELETE",
      })
    ).status,
    200,
  );
  const before = await (
    await request("/api/auth/members?limit=1", { cookie: admin.cookie })
  ).json();
  assert.equal(before.items[0].id, admin.user.id);
  assert.equal(before.items[0].passkeyEnabled, false);
  assert.ok(before.nextCursor);
  const key = await registerPasskey(admin.cookie, admin.user.id);
  assert.equal(
    (
      await request(
        `/api/auth/members?limit=1&cursor=${encodeURIComponent(before.nextCursor)}`,
        { cookie: admin.cookie },
      )
    ).status,
    409,
  );
  const directory = await (
    await request("/api/auth/members", { cookie: viewer.cookie })
  ).json();
  assert.deepEqual(
    directory.items.map((member: { id: string; passkeyEnabled: boolean }) => ({
      id: member.id,
      passkeyEnabled: member.passkeyEnabled,
    })),
    [
      { id: admin.user.id, passkeyEnabled: true },
      { id: viewer.user.id, passkeyEnabled: false },
    ],
  );
  assert.equal((await request("/api/auth/members")).status, 401);
  assert.equal(
    (
      await request(`/api/auth/passkeys/${key.id}`, {
        cookie: admin.cookie,
        method: "DELETE",
      })
    ).status,
    200,
  );
  const after = await (
    await request("/api/auth/members", { cookie: viewer.cookie })
  ).json();
  assert.equal(
    after.items.find((member: { id: string }) => member.id === admin.user.id)
      .passkeyEnabled,
    false,
  );
});

import { after, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import {
  createHash,
  generateKeyPairSync,
  randomBytes,
  sign,
} from "node:crypto";
import {
  cleanupDatabase,
  request,
  resetDatabase,
  setupUser,
  sql,
} from "./support.js";
import { isoCBOR } from "@simplewebauthn/server/helpers";
import { Secret, TOTP } from "otpauth";
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
async function totpSetup(adminCookie: string) {
  const setup = await request("/api/auth/totp/setup", {
    method: "POST",
    body: {},
    cookie: adminCookie,
  });
  assert.equal(setup.status, 200);
  const data = await setup.json();
  const totp = new TOTP({
    issuer: "Mill",
    secret: Secret.fromBase32(data.secret),
  });
  const enrollmentCode = totp.generate();
  const confirmed = await request("/api/auth/totp/verify", {
    cookie: adminCookie,
    body: { code: enrollmentCode },
  });
  assert.equal(confirmed.status, 200);
  return {
    totp,
    enrollmentCode,
    secret: data.secret,
    recoveryCodes: (await confirmed.json()).recoveryCodes as string[],
  };
}
function virtualPasskey(userId: string) {
  const keyPair = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const jwk = keyPair.publicKey.export({ format: "jwk" });
  const cose = isoCBOR.encode(
    new Map<number, number | Uint8Array>([
      [1, 2],
      [3, -7],
      [-1, 1],
      [-2, Buffer.from(jwk.x!, "base64url")],
      [-3, Buffer.from(jwk.y!, "base64url")],
    ]),
  );
  const id = randomBytes(32);
  const rpHash = createHash("sha256").update(new URL(origin).hostname).digest();
  const clientData = (
    type: string,
    challenge: string,
    expectedOrigin = origin,
  ) =>
    Buffer.from(
      JSON.stringify({
        type,
        challenge,
        origin: expectedOrigin,
        crossOrigin: false,
      }),
    );
  let counter = 0;
  return {
    id: id.toString("base64url"),
    registration(challenge: string, expectedOrigin = origin) {
      const length = Buffer.alloc(2);
      length.writeUInt16BE(id.length);
      const authenticatorData = Buffer.concat([
        rpHash,
        Buffer.from([0x45]),
        Buffer.alloc(4),
        Buffer.alloc(16),
        length,
        id,
        cose,
      ]);
      const attestation = isoCBOR.encode(
        new Map<string, string | Map<string, string> | Uint8Array>([
          ["fmt", "none"],
          ["attStmt", new Map()],
          ["authData", authenticatorData],
        ]),
      );
      return {
        id: id.toString("base64url"),
        rawId: id.toString("base64url"),
        type: "public-key",
        clientExtensionResults: {},
        authenticatorAttachment: "platform",
        response: {
          clientDataJSON: clientData(
            "webauthn.create",
            challenge,
            expectedOrigin,
          ).toString("base64url"),
          attestationObject: Buffer.from(attestation).toString("base64url"),
          transports: ["internal"],
        },
      };
    },
    authentication(challenge: string, expectedOrigin = origin, flags = 0x05) {
      const count = Buffer.alloc(4);
      count.writeUInt32BE(++counter);
      const authenticatorData = Buffer.concat([
        rpHash,
        Buffer.from([flags]),
        count,
      ]);
      const client = clientData("webauthn.get", challenge, expectedOrigin);
      const signature = sign(
        "sha256",
        Buffer.concat([
          authenticatorData,
          createHash("sha256").update(client).digest(),
        ]),
        keyPair.privateKey,
      );
      return {
        id: id.toString("base64url"),
        rawId: id.toString("base64url"),
        type: "public-key",
        clientExtensionResults: {},
        response: {
          clientDataJSON: client.toString("base64url"),
          authenticatorData: authenticatorData.toString("base64url"),
          signature: signature.toString("base64url"),
          userHandle: Buffer.from(userId).toString("base64url"),
        },
      };
    },
  };
}
async function registerPasskey(adminCookie: string, userId: string) {
  const passkey = virtualPasskey(userId);
  const options = await (
    await request("/api/auth/passkeys/register/options", {
      cookie: adminCookie,
      body: {},
    })
  ).json();
  const registered = await request("/api/auth/passkeys/register/verify", {
    cookie: adminCookie,
    body: {
      challengeId: options.challengeId,
      name: "Test passkey",
      response: passkey.registration(options.options.challenge),
    },
  });
  assert.equal(registered.status, 200, JSON.stringify(await registered.json()));
  return passkey;
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
  };
  const responses = await Promise.all([
    request("/api/auth/setup", { body: input }),
    request("/api/auth/setup", { body: input }),
  ]);
  assert.deepEqual(responses.map((r) => r.status).sort(), [201, 409]);
  const good = responses.find((r) => r.status === 201)!;
  const result = await good.json();
  assert.equal(result.user.email, "admin@example.test");
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
      notificationPreferences: { assignments: false, mentions: true },
    },
  });
  assert.equal(changed.status, 200);
  const data = await changed.json();
  assert.equal(data.user.timeZone, "Asia/Kolkata");
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
test("authenticator enrollment encrypts secrets, verifies codes and prevents code/recovery replay", async () => {
  const admin = await setupUser();
  const factor = await totpSetup(admin.cookie);
  const [stored] = await sql`SELECT encrypted_secret FROM authenticators`;
  assert.equal(stored.encryptedSecret.includes(factor.secret), false);
  assert.equal(
    (await request("/api/auth/totp/setup", { cookie: admin.cookie, body: {} }))
      .status,
    409,
  );
  const first = await (
    await request("/api/auth/login", {
      body: { email: admin.user.email, password },
    })
  ).json();
  assert.equal(first.preferredMethod, "totp");
  assert.equal(
    (
      await request("/api/auth/second-factor", {
        body: {
          challengeId: first.challengeId,
          method: "totp",
          code: factor.enrollmentCode,
        },
      })
    ).status,
    400,
  );
  const verified = await request("/api/auth/second-factor", {
    body: {
      challengeId: first.challengeId,
      method: "recovery",
      code: factor.recoveryCodes[0],
    },
  });
  assert.equal(verified.status, 200);
  assert.equal(
    (await request("/api/auth/me", { cookie: cookie(verified) })).status,
    200,
  );
  assert.equal(
    (
      await request("/api/auth/second-factor", {
        body: {
          challengeId: first.challengeId,
          method: "recovery",
          code: factor.recoveryCodes[1],
        },
      })
    ).status,
    400,
  );
  const second = await (
    await request("/api/auth/login", {
      body: { email: admin.user.email, password },
    })
  ).json();
  assert.equal(
    (
      await request("/api/auth/second-factor", {
        body: {
          challengeId: second.challengeId,
          method: "recovery",
          code: factor.recoveryCodes[0],
        },
      })
    ).status,
    400,
  );
  const [codes] = await sql`SELECT count(*)::int AS total FROM recovery_codes`;
  assert.equal(codes.total, 9);
});
test("passkey ceremonies verify real signatures and origin, prefer passkeys and allow authenticator fallback", async () => {
  const admin = await setupUser();
  const passkey = await registerPasskey(admin.cookie, admin.user.id);
  const factor = await totpSetup(admin.cookie);
  const login = await request("/api/auth/login", {
    body: { email: admin.user.email, password },
  });
  assert.equal(login.headers.get("set-cookie"), null);
  const challenge = await login.json();
  assert.equal(challenge.preferredMethod, "passkey");
  assert.deepEqual(challenge.methods, ["passkey", "totp", "recovery"]);
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
  const fallbackCode = factor.totp.generate({ timestamp: Date.now() + 30000 });
  assert.equal(
    (
      await request("/api/auth/second-factor", {
        body: {
          challengeId: fallback.challengeId,
          method: "totp",
          code: fallbackCode,
        },
      })
    ).status,
    200,
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
test("security settings require recent identity verification and reauthentication is session-bound", async () => {
  const admin = await setupUser();
  await sql`UPDATE sessions SET authenticated_at=now()-interval '11 minutes'`;
  assert.equal(
    (await request("/api/auth/totp/setup", { cookie: admin.cookie, body: {} }))
      .status,
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
  const factor = await totpSetup(admin.cookie);
  await sql`UPDATE sessions SET authenticated_at=now()-interval '11 minutes'`;
  const challenge = await (
    await request("/api/auth/reauth", {
      cookie: admin.cookie,
      body: { password },
    })
  ).json();
  assert.equal(
    (
      await request("/api/auth/second-factor", {
        body: {
          challengeId: challenge.challengeId,
          method: "recovery",
          code: factor.recoveryCodes[0],
        },
      })
    ).status,
    401,
  );
  assert.equal(
    (
      await request("/api/auth/second-factor", {
        cookie: admin.cookie,
        body: {
          challengeId: challenge.challengeId,
          method: "recovery",
          code: factor.recoveryCodes[0],
        },
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
  await totpSetup(admin.cookie);
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
    await tx`SELECT id FROM users WHERE id=${admin.user.id} FOR UPDATE`;
    pending = request("/api/auth/login", {
      body: { email: admin.user.email, password },
    });
    let blocked = false;
    for (let attempts = 0; attempts < 100; attempts++) {
      const [waiting] =
        await sql`SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE wait_event_type='Lock' AND query LIKE 'SELECT * FROM users WHERE id=%FOR UPDATE%') AS blocked`;
      if (waiting.blocked) {
        blocked = true;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(blocked, true, "Login reached locked security-state recheck");
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
test("authenticator removal verifies a fresh code and restores password-only sign-in", async () => {
  const admin = await setupUser();
  const factor = await totpSetup(admin.cookie);
  assert.equal(
    (
      await request("/api/auth/totp/disable", {
        cookie: admin.cookie,
        body: { code: "000000" },
      })
    ).status,
    400,
  );
  const futureCode = factor.totp.generate({ timestamp: Date.now() + 30000 });
  assert.equal(
    (
      await request("/api/auth/totp/disable", {
        cookie: admin.cookie,
        body: { code: futureCode },
      })
    ).status,
    200,
  );
  assert.equal(
    (await (await request("/api/auth/me", { cookie: admin.cookie })).json())
      .user.totpEnabled,
    false,
  );
  const [count] = await sql`SELECT count(*)::int AS total FROM recovery_codes`;
  assert.equal(count.total, 0);
  const login = await request("/api/auth/login", {
    body: { email: admin.user.email, password },
  });
  assert.equal(login.status, 200);
  assert.ok((await login.json()).user);
});
test("replacing authenticator recovery codes invalidates previous codes", async () => {
  const admin = await setupUser();
  const factor = await totpSetup(admin.cookie);
  const regenerated = await request("/api/auth/totp/recovery-codes", {
    cookie: admin.cookie,
    body: { code: factor.totp.generate({ timestamp: Date.now() + 30000 }) },
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
      await request("/api/auth/second-factor", {
        body: {
          challengeId: challenge.challengeId,
          method: "recovery",
          code: factor.recoveryCodes[0],
        },
      })
    ).status,
    400,
  );
  assert.equal(
    (
      await request("/api/auth/second-factor", {
        body: {
          challengeId: challenge.challengeId,
          method: "recovery",
          code: codes[0],
        },
      })
    ).status,
    200,
  );
});

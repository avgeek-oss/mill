import { randomBytes } from "node:crypto";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
  type AuthenticationResponseJSON,
  type RegistrationResponseJSON,
  type AuthenticatorTransportFuture,
} from "@simplewebauthn/server";
import { Secret, TOTP } from "otpauth";
import { z } from "zod";
import { sql } from "../../../../packages/database/src/index.js";
import { badRequest, clientAddress, conflict, type Env } from "../http.js";
import {
  activeUser,
  audit,
  body,
  createChallenge,
  currentSession,
  human,
  identityResponse,
  invalidateSecurity,
  nameSchema,
  newSession,
  recentSession,
  type Db,
} from "./model.js";
import {
  appOrigin,
  decrypt,
  encrypt,
  hashToken,
  rateLimit,
  rpId,
} from "./security.js";

export const securityRoutes = new Hono<Env>();
const challengeSchema = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
const codeSchema = z.string().trim().min(6).max(30);
const makeTotp = (secret: string) =>
  new TOTP({
    issuer: "Mill",
    secret: Secret.fromBase32(secret),
    algorithm: "SHA1",
    digits: 6,
    period: 30,
  });
async function issueRecoveryCodes(userId: string, db: Db = sql) {
  const codes = Array.from({ length: 10 }, () =>
    randomBytes(10)
      .toString("hex")
      .match(/.{1,5}/g)!
      .join("-"),
  );
  await db`DELETE FROM recovery_codes WHERE user_id=${userId}`;
  for (const code of codes)
    await db`INSERT INTO recovery_codes(user_id,code_hash) VALUES(${userId},${hashToken(code.replaceAll("-", "").toLowerCase())})`;
  return codes;
}
async function validateTotp(
  userId: string,
  code: string,
  db: Db = sql,
  allowPending = false,
) {
  const [record] =
    await db`SELECT * FROM authenticators WHERE user_id=${userId} FOR UPDATE`;
  if (!record || (!record.verified && !allowPending))
    badRequest("An authenticator app is not enabled");
  const delta = makeTotp(decrypt(record.encryptedSecret)).validate({
    token: code,
    window: 1,
  });
  const step = Math.floor(Date.now() / 30000) + (delta ?? 0);
  if (delta === null || step <= Number(record.lastUsedStep))
    badRequest(
      "The code is incorrect or was already used. Wait for a new code.",
    );
  await db`UPDATE authenticators SET last_used_step=${step} WHERE user_id=${userId}`;
}
async function completeChallenge(
  c: Parameters<typeof currentSession>[0],
  row: {
    userId: string;
    purpose: string;
    sessionId: string | null;
    securityEpoch?: number | null;
  },
  db: Db,
) {
  const user = await activeUser(row.userId, db);
  if (
    row.securityEpoch !== undefined &&
    row.securityEpoch !== null &&
    row.securityEpoch !== user.securityEpoch
  )
    badRequest("Your account security changed. Sign in again.");
  if (row.purpose === "reauth") {
    const current = await currentSession(c, db);
    if (current.id !== row.sessionId || current.userId !== user.id)
      throw new HTTPException(403, {
        message: "Use the session that requested verification",
      });
    await db`UPDATE sessions SET authenticated_at=now() WHERE id=${row.sessionId}`;
    return { ok: true };
  }
  await newSession(c, user.id, db, user.securityEpoch);
  await audit(user, "account.sign-in", { method: "second-factor" }, db);
  return identityResponse(user, db);
}
securityRoutes.post("/second-factor", async (c) => {
  const input = await body(
    c,
    z.object({
      challengeId: challengeSchema,
      method: z.enum(["totp", "recovery"]),
      code: codeSchema,
    }),
  );
  await rateLimit(`factor:${input.challengeId}`, 5, 300);
  return sql.begin(async (tx) => {
    const [challenge] =
      await tx`SELECT * FROM auth_challenges WHERE token_hash=${hashToken(input.challengeId)} AND purpose IN ('login','reauth') AND expires_at>now() FOR UPDATE`;
    if (!challenge) badRequest("Verification expired. Sign in again.");
    if (input.method === "totp")
      await validateTotp(challenge.userId, input.code, tx);
    else {
      const [code] =
        await tx`DELETE FROM recovery_codes WHERE user_id=${challenge.userId} AND code_hash=${hashToken(input.code.replaceAll("-", "").toLowerCase())} RETURNING code_hash`;
      if (!code)
        badRequest("The recovery code is incorrect or was already used");
    }
    await tx`DELETE FROM auth_challenges WHERE token_hash=${hashToken(input.challengeId)}`;
    return c.json(
      await completeChallenge(
        c,
        challenge as {
          userId: string;
          purpose: string;
          sessionId: string | null;
          securityEpoch: number;
        },
        tx,
      ),
    );
  });
});
securityRoutes.get("/passkeys", async (c) => {
  const items =
    await sql`SELECT id,name,created_at FROM passkeys WHERE user_id=${human(c).userId} ORDER BY created_at DESC`;
  return c.json({ items });
});
securityRoutes.post("/passkeys/register/options", async (c) => {
  const session = await recentSession(c);
  const user = await activeUser(human(c).userId);
  await rateLimit(`passkey-register:${user.id}`, 20);
  const existing =
    await sql`SELECT id,transports FROM passkeys WHERE user_id=${user.id}`;
  if (existing.length >= 20)
    badRequest("Remove an existing passkey before adding another");
  const options = await generateRegistrationOptions({
    rpName: "Mill",
    rpID: rpId(),
    userName: user.email,
    userDisplayName: user.name,
    userID: new TextEncoder().encode(user.id),
    attestationType: "none",
    excludeCredentials: existing.map((p) => ({
      id: p.id,
      transports: p.transports as AuthenticatorTransportFuture[],
    })),
    authenticatorSelection: {
      residentKey: "required",
      userVerification: "required",
    },
  });
  const challengeId = await createChallenge(
    user.id,
    "registration",
    session.id,
    options.challenge,
  );
  return c.json({ challengeId, options });
});
securityRoutes.post("/passkeys/register/verify", async (c) => {
  const current = await recentSession(c);
  const input = await body(
    c,
    z.object({
      challengeId: challengeSchema,
      response: z.custom<RegistrationResponseJSON>(
        (v) => typeof v === "object" && v !== null,
      ),
      name: nameSchema,
    }),
  );
  await rateLimit(`passkey-register-verify:${input.challengeId}`, 5, 300);
  return sql.begin(async (tx) => {
    const [challenge] =
      await tx`SELECT * FROM auth_challenges WHERE token_hash=${hashToken(input.challengeId)} AND user_id=${human(c).userId} AND session_id=${current.id} AND purpose='registration' AND expires_at>now() FOR UPDATE`;
    if (!challenge) badRequest("Passkey setup expired. Try again.");
    let result;
    try {
      result = await verifyRegistrationResponse({
        response: input.response,
        expectedChallenge: challenge.challenge,
        expectedOrigin: appOrigin(),
        expectedRPID: rpId(),
        requireUserVerification: true,
      });
    } catch {
      badRequest("The passkey could not be verified. Try again.");
    }
    if (!result.verified || !result.registrationInfo)
      badRequest("The passkey could not be verified. Try again.");
    const credential = result.registrationInfo.credential;
    const [existing] =
      await tx`SELECT id FROM passkeys WHERE id=${credential.id}`;
    if (existing) conflict("This passkey is already registered");
    await tx`INSERT INTO passkeys(id,user_id,name,public_key,counter,transports) VALUES(${credential.id},${challenge.userId},${input.name},${Buffer.from(credential.publicKey)},${credential.counter},${tx.json(credential.transports ?? [])})`;
    await tx`DELETE FROM auth_challenges WHERE token_hash=${hashToken(input.challengeId)}`;
    await currentSession(c, tx);
    await invalidateSecurity(challenge.userId, current.id, tx);
    await audit(
      await activeUser(challenge.userId, tx),
      "account.passkey-added",
      {},
      tx,
    );
    return c.json({ ok: true });
  });
});
securityRoutes.delete("/passkeys/:id", async (c) => {
  const current = await recentSession(c);
  const who = human(c);
  await sql.begin(async (tx) => {
    await tx`SELECT id FROM users WHERE id=${who.userId} FOR UPDATE`;
    await currentSession(c, tx);
    const [deleted] =
      await tx`DELETE FROM passkeys WHERE id=${c.req.param("id")} AND user_id=${who.userId} RETURNING id`;
    if (!deleted)
      throw new HTTPException(404, { message: "Passkey not found" });
    await invalidateSecurity(who.userId, current.id, tx);
    await audit(
      { id: who.userId, name: who.name },
      "account.passkey-removed",
      {},
      tx,
    );
  });
  return c.json({ ok: true });
});
securityRoutes.post("/passkeys/authenticate/options", async (c) => {
  const input = await body(
    c,
    z.object({ challengeId: challengeSchema.optional() }),
  );
  await rateLimit(`passkey-options:${clientAddress(c)}`, 40);
  let userId: string | null = null;
  if (input.challengeId) {
    const [challenge] =
      await sql`SELECT * FROM auth_challenges WHERE token_hash=${hashToken(input.challengeId)} AND purpose IN ('login','reauth') AND expires_at>now()`;
    if (!challenge) badRequest("Verification expired. Sign in again.");
    if (
      challenge.purpose === "reauth" &&
      (await currentSession(c)).id !== challenge.sessionId
    )
      throw new HTTPException(403, {
        message: "Use the session that requested verification",
      });
    userId = challenge.userId;
  }
  const passkeys = userId
    ? await sql`SELECT id,transports FROM passkeys WHERE user_id=${userId}`
    : [];
  const options = await generateAuthenticationOptions({
    rpID: rpId(),
    userVerification: "required",
    allowCredentials: passkeys.map((p) => ({
      id: p.id,
      transports: p.transports as AuthenticatorTransportFuture[],
    })),
  });
  const challengeId =
    input.challengeId ?? (await createChallenge(null, "passkey"));
  await sql`UPDATE auth_challenges SET challenge=${options.challenge} WHERE token_hash=${hashToken(challengeId)}`;
  return c.json({ challengeId, options });
});
securityRoutes.post("/passkeys/authenticate/verify", async (c) => {
  const input = await body(
    c,
    z.object({
      challengeId: challengeSchema,
      response: z.custom<AuthenticationResponseJSON>(
        (v) => typeof v === "object" && v !== null,
      ),
    }),
  );
  await rateLimit(`passkey-verify:${input.challengeId}`, 5, 300);
  return sql.begin(async (tx) => {
    const [challenge] =
      await tx`SELECT * FROM auth_challenges WHERE token_hash=${hashToken(input.challengeId)} AND purpose IN ('login','reauth','passkey') AND expires_at>now() FOR UPDATE`;
    if (!challenge?.challenge)
      badRequest("Verification expired. Sign in again.");
    const [passkey] =
      await tx`SELECT * FROM passkeys WHERE id=${input.response.id ?? ""} FOR UPDATE`;
    if (!passkey || (challenge.userId && challenge.userId !== passkey.userId))
      badRequest("The passkey could not be verified");
    let result;
    try {
      result = await verifyAuthenticationResponse({
        response: input.response,
        expectedChallenge: challenge.challenge,
        expectedOrigin: appOrigin(),
        expectedRPID: rpId(),
        requireUserVerification: true,
        credential: {
          id: passkey.id,
          publicKey: new Uint8Array(passkey.publicKey),
          counter: Number(passkey.counter),
          transports: passkey.transports as AuthenticatorTransportFuture[],
        },
      });
    } catch {
      badRequest("The passkey could not be verified");
    }
    if (!result.verified) badRequest("The passkey could not be verified");
    await tx`UPDATE passkeys SET counter=${result.authenticationInfo.newCounter} WHERE id=${passkey.id}`;
    await tx`DELETE FROM auth_challenges WHERE token_hash=${hashToken(input.challengeId)}`;
    return c.json(
      await completeChallenge(
        c,
        {
          userId: passkey.userId,
          purpose: challenge.purpose,
          sessionId: challenge.sessionId,
          securityEpoch: challenge.securityEpoch,
        },
        tx,
      ),
    );
  });
});
securityRoutes.post("/totp/setup", async (c) => {
  await recentSession(c);
  const user = await activeUser(human(c).userId);
  await rateLimit(`totp-setup:${user.id}`, 10);
  return sql.begin(async (tx) => {
    await tx`SELECT id FROM users WHERE id=${user.id} FOR UPDATE`;
    const [existing] =
      await tx`SELECT verified FROM authenticators WHERE user_id=${user.id}`;
    if (existing?.verified) conflict("An authenticator app is already enabled");
    const secret = new Secret({ size: 20 }).base32;
    const totp = makeTotp(secret);
    totp.label = user.email;
    await tx`INSERT INTO authenticators(user_id,encrypted_secret) VALUES(${user.id},${encrypt(secret)}) ON CONFLICT(user_id) DO UPDATE SET encrypted_secret=excluded.encrypted_secret,last_used_step=-1,created_at=now()`;
    return c.json({ secret, uri: totp.toString() });
  });
});
securityRoutes.post("/totp/verify", async (c) => {
  await recentSession(c);
  const user = await activeUser(human(c).userId);
  const input = await body(c, z.object({ code: codeSchema }));
  await rateLimit(`totp-settings:${user.id}`, 5, 300);
  return sql.begin(async (tx) => {
    await tx`SELECT id FROM users WHERE id=${user.id} FOR UPDATE`;
    const [existing] =
      await tx`SELECT verified FROM authenticators WHERE user_id=${user.id} FOR UPDATE`;
    if (existing?.verified)
      conflict("The authenticator app is already enabled");
    await validateTotp(user.id, input.code, tx, true);
    await tx`UPDATE authenticators SET verified=true WHERE user_id=${user.id}`;
    const recoveryCodes = await issueRecoveryCodes(user.id, tx);
    const current = await currentSession(c, tx);
    await invalidateSecurity(user.id, current.id, tx);
    await audit(user, "account.authenticator-enabled", {}, tx);
    return c.json({ recoveryCodes });
  });
});
for (const action of ["disable", "recovery-codes"] as const)
  securityRoutes.post(`/totp/${action}`, async (c) => {
    await recentSession(c);
    const user = await activeUser(human(c).userId);
    const input = await body(c, z.object({ code: codeSchema }));
    await rateLimit(`totp-settings:${user.id}`, 5, 300);
    return sql.begin(async (tx) => {
      await tx`SELECT id FROM users WHERE id=${user.id} FOR UPDATE`;
      await validateTotp(user.id, input.code, tx);
      if (action === "disable") {
        await tx`DELETE FROM authenticators WHERE user_id=${user.id}`;
        await tx`DELETE FROM recovery_codes WHERE user_id=${user.id}`;
        await invalidateSecurity(user.id, (await currentSession(c, tx)).id, tx);
        await audit(user, "account.authenticator-disabled", {}, tx);
        return c.json({ ok: true });
      }
      const recoveryCodes = await issueRecoveryCodes(user.id, tx);
      await audit(user, "account.recovery-codes-replaced", {}, tx);
      return c.json({ recoveryCodes });
    });
  });

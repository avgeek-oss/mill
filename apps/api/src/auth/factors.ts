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
import { z } from "zod";
import { sql } from "../../../../packages/database/src/index.js";
import { badRequest, clientAddress, conflict, type Env } from "../http.js";
import {
  activeUser,
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
  clearAuthRateLimit,
  hashToken,
  rateLimit,
  rpId,
} from "./security.js";

export const securityRoutes = new Hono<Env>();
const challengeSchema = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
async function issueRecoveryCodes(userId: string, db: Db = sql) {
  const codes = Array.from({ length: 10 }, () =>
    randomBytes(16).toString("hex").match(/.{8}/g)!.join("-"),
  );
  await db`DELETE FROM recovery_codes WHERE user_id=${userId}`;
  for (const code of codes)
    await db`INSERT INTO recovery_codes(user_id,code_hash) VALUES(${userId},${hashToken(code.replaceAll("-", "").toLowerCase())})`;
  return codes;
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
    await db`UPDATE sessions SET authenticated_at=now(),passkey_authenticated_at=now() WHERE id=${row.sessionId}`;
    await clearAuthRateLimit(`reauth:${user.id}`, db);
    return { ok: true };
  }
  await newSession(c, user.id, db, user.securityEpoch, "passkey");
  await clearAuthRateLimit(`login-email:${user.email}`, db);

  return identityResponse(user, db);
}
securityRoutes.post("/passkeys/recovery/verify", async (c) => {
  const input = await body(
    c,
    z
      .object({
        challengeId: challengeSchema,
        code: z.string().trim().min(1).max(100),
      })
      .strict(),
  );
  await rateLimit(`recovery-factor:${input.challengeId}`, 5, 300);
  return sql.begin(async (tx) => {
    await tx`SELECT id FROM workspace FOR UPDATE`;
    const [challenge] =
      await tx`SELECT * FROM auth_challenges WHERE token_hash=${hashToken(input.challengeId)} AND purpose='login' AND expires_at>now() FOR UPDATE`;
    if (!challenge) badRequest("Verification expired. Sign in again.");
    const user = await activeUser(challenge.userId, tx);
    if (user.securityEpoch !== challenge.securityEpoch)
      badRequest("Your account security changed. Sign in again.");
    const [key] =
      await tx`SELECT id FROM passkeys WHERE user_id=${user.id} LIMIT 1`;
    if (!key) badRequest("Passkey recovery is unavailable for this account");
    const [consumed] =
      await tx`DELETE FROM recovery_codes WHERE user_id=${user.id} AND code_hash=${hashToken(input.code.replaceAll("-", "").toLowerCase())} RETURNING code_hash`;
    if (!consumed)
      badRequest("The recovery code is incorrect or was already used");
    await tx`DELETE FROM auth_challenges WHERE token_hash=${hashToken(input.challengeId)}`;
    await newSession(c, user.id, tx, user.securityEpoch, "recovery");
    await clearAuthRateLimit(`login-email:${user.email}`, tx);
    return c.json(await identityResponse(user, tx));
  });
});
securityRoutes.post("/passkeys/recovery-codes", async (c) => {
  await body(c, z.object({}).strict());
  const who = human(c);
  await rateLimit(`recovery-codes:${who.userId}`, 5, 300);
  return sql.begin(async (tx) => {
    await tx`SELECT id FROM workspace FOR UPDATE`;
    await tx`SELECT id FROM users WHERE id=${who.userId} FOR UPDATE`;
    const current = await recentSession(c, tx);
    if (
      !current.passkeyAuthenticatedAt ||
      new Date(current.passkeyAuthenticatedAt).getTime() < Date.now() - 600_000
    )
      throw new HTTPException(403, {
        message:
          "Verify your identity with a passkey before replacing recovery codes",
      });
    const [key] =
      await tx`SELECT id FROM passkeys WHERE user_id=${who.userId} LIMIT 1`;
    if (!key) badRequest("Add a passkey before generating recovery codes");
    return c.json({ recoveryCodes: await issueRecoveryCodes(who.userId, tx) });
  });
});
securityRoutes.get("/passkeys", async (c) => {
  const items =
    await sql`SELECT id,name,created_at FROM passkeys WHERE user_id=${human(c).userId} ORDER BY created_at DESC`;
  const [recovery] =
    await sql`SELECT count(*)::int AS count FROM recovery_codes WHERE user_id=${human(c).userId}`;
  return c.json({ items, recoveryCodeCount: recovery.count });
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
    z
      .object({
        challengeId: challengeSchema,
        response: z.custom<RegistrationResponseJSON>(
          (v) => typeof v === "object" && v !== null,
        ),
        name: nameSchema,
      })
      .strict(),
  );
  await rateLimit(`passkey-register-verify:${input.challengeId}`, 5, 300);
  return sql.begin(async (tx) => {
    await tx`SELECT id FROM workspace FOR UPDATE`;
    const [challenge] =
      await tx`SELECT * FROM auth_challenges WHERE token_hash=${hashToken(input.challengeId)} AND user_id=${human(c).userId} AND session_id=${current.id} AND purpose='registration' AND expires_at>now() FOR UPDATE`;
    if (!challenge) badRequest("Passkey setup expired. Try again.");
    await recentSession(c, tx);
    const user = await activeUser(challenge.userId, tx);
    if (challenge.securityEpoch !== user.securityEpoch)
      badRequest("Your account security changed. Sign in again.");
    const existingKeys =
      await tx`SELECT id FROM passkeys WHERE user_id=${user.id}`;
    if (existingKeys.length >= 20)
      badRequest("Remove an existing passkey before adding another");
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
    await tx`UPDATE sessions SET passkey_authenticated_at=now() WHERE id=${current.id}`;
    const recoveryCodes =
      existingKeys.length === 0
        ? await issueRecoveryCodes(user.id, tx)
        : undefined;
    return c.json({ ok: true, ...(recoveryCodes ? { recoveryCodes } : {}) });
  });
});
securityRoutes.delete("/passkeys/:id", async (c) => {
  const current = await recentSession(c);
  const who = human(c);
  await sql.begin(async (tx) => {
    await tx`SELECT id FROM workspace FOR UPDATE`;
    await tx`SELECT id FROM users WHERE id=${who.userId} FOR UPDATE`;
    await recentSession(c, tx);
    const [deleted] =
      await tx`DELETE FROM passkeys WHERE id=${c.req.param("id")} AND user_id=${who.userId} RETURNING id`;
    if (!deleted)
      throw new HTTPException(404, { message: "Passkey not found" });
    const [remaining] =
      await tx`SELECT id FROM passkeys WHERE user_id=${who.userId} LIMIT 1`;
    if (!remaining) {
      await tx`DELETE FROM recovery_codes WHERE user_id=${who.userId}`;
      await tx`UPDATE sessions SET passkey_authenticated_at=null WHERE id=${current.id}`;
    }
    await invalidateSecurity(who.userId, current.id, tx);
  });
  return c.json({ ok: true });
});
securityRoutes.post("/passkeys/authenticate/options", async (c) => {
  const input = await body(
    c,
    z.object({ challengeId: challengeSchema.optional() }).strict(),
  );
  await rateLimit(`passkey-options:${clientAddress(c)}`, 40);
  return sql.begin(async (tx) => {
    await tx`SELECT id FROM workspace FOR UPDATE`;
    let challengeId = input.challengeId;
    let userId: string | null = null;
    const current = c.get("actor") ? await currentSession(c, tx) : null;
    if (challengeId) {
      const [challenge] =
        await tx`SELECT * FROM auth_challenges WHERE token_hash=${hashToken(challengeId)} AND purpose IN ('login','reauth') AND expires_at>now() FOR UPDATE`;
      if (!challenge) badRequest("Verification expired. Sign in again.");
      if (
        challenge.purpose === "reauth" &&
        (!current ||
          current.id !== challenge.sessionId ||
          current.userId !== challenge.userId)
      )
        throw new HTTPException(403, {
          message: "Use the session that requested verification",
        });
      userId = challenge.userId;
      const user = await activeUser(userId!, tx);
      if (user.securityEpoch !== challenge.securityEpoch)
        badRequest("Your account security changed. Sign in again.");
    } else if (current) {
      userId = current.userId;
      challengeId = await createChallenge(
        userId,
        "reauth",
        current.id,
        null,
        tx,
      );
    } else {
      challengeId = await createChallenge(null, "passkey", null, null, tx);
    }
    const passkeys = userId
      ? await tx`SELECT id,transports FROM passkeys WHERE user_id=${userId}`
      : [];
    if (userId && !passkeys.length)
      badRequest("No passkey is available for this account");
    const options = await generateAuthenticationOptions({
      rpID: rpId(),
      userVerification: "required",
      allowCredentials: passkeys.map((p) => ({
        id: p.id,
        transports: p.transports as AuthenticatorTransportFuture[],
      })),
    });
    await tx`UPDATE auth_challenges SET challenge=${options.challenge} WHERE token_hash=${hashToken(challengeId)}`;
    return c.json({ challengeId, options });
  });
});
securityRoutes.post("/passkeys/authenticate/verify", async (c) => {
  const input = await body(
    c,
    z
      .object({
        challengeId: challengeSchema,
        response: z.custom<AuthenticationResponseJSON>(
          (v) => typeof v === "object" && v !== null,
        ),
      })
      .strict(),
  );
  await rateLimit(`passkey-verify:${input.challengeId}`, 5, 300);
  return sql.begin(async (tx) => {
    await tx`SELECT id FROM workspace FOR UPDATE`;
    const [challenge] =
      await tx`SELECT * FROM auth_challenges WHERE token_hash=${hashToken(input.challengeId)} AND purpose IN ('login','reauth','passkey') AND expires_at>now() FOR UPDATE`;
    if (!challenge?.challenge)
      badRequest("Verification expired. Sign in again.");
    if (challenge.purpose === "passkey" && c.get("actor"))
      badRequest("Your sign-in changed. Try again.");
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

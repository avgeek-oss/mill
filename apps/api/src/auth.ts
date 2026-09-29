import { randomUUID } from "node:crypto";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import { sql } from "../../../packages/database/src/index.js";
import { badRequest, clientAddress, conflict, type Env } from "./http.js";
import {
  activeUser,
  body,
  clearSession,
  createChallenge,
  currentSession,
  emailSchema,
  human,
  identityResponse,
  inAppPreferences,
  nameSchema,
  newSession,
  passwordSchema,
  recentSession,
  sessionToken,
  type UserRow,
  type Db,
} from "./auth/model.js";
import {
  hashPassword,
  hashToken,
  rateLimit,
  verifyPassword,
} from "./auth/security.js";
import { securityRoutes } from "./auth/factors.js";
import { teamRoutes } from "./auth/team.js";
import { recoveryRoutes } from "./auth/recovery.js";

export { sessionActor } from "./auth/model.js";
export const authRoutes = new Hono<Env>();
authRoutes.get("/status", async (c) => {
  const [state] =
    await sql`SELECT EXISTS(SELECT 1 FROM workspace) AS configured`;
  return c.json({ setupRequired: !state.configured });
});
authRoutes.post("/setup", async (c) => {
  await rateLimit(`setup:${clientAddress(c)}`, 20);
  const input = await body(
    c,
    z.object({
      workspaceName: nameSchema,
      name: nameSchema,
      email: emailSchema,
      password: passwordSchema,
    }),
  );
  const passwordHash = await hashPassword(input.password);
  return sql.begin(async (tx) => {
    await tx`SELECT pg_advisory_xact_lock(78127001)`;
    const [existing] = await tx`SELECT id FROM workspace`;
    if (existing) conflict("Mill is already set up. Sign in to continue.");
    const workspaceId = randomUUID();
    await tx`INSERT INTO workspace(id,name) VALUES(${workspaceId},${input.workspaceName})`;
    const [user] = await tx<
      UserRow[]
    >`INSERT INTO users(id,workspace_id,name,email,password_hash,role)
      VALUES(${randomUUID()},${workspaceId},${input.name},${input.email},${passwordHash},'admin') RETURNING *`;
    await newSession(c, user.id, tx);

    return c.json(await identityResponse(user, tx), 201);
  });
});

const loginSchema = z.object({
  email: emailSchema,
  password: z.string().min(1).max(1024),
});
export async function secondFactorChallenge(
  user: UserRow,
  purpose: "login" | "reauth",
  sessionId: string | null = null,
  db: Db = sql,
) {
  const [state] =
    await db`SELECT EXISTS(SELECT 1 FROM authenticators WHERE user_id=${user.id} AND verified) AS totp,
    EXISTS(SELECT 1 FROM passkeys WHERE user_id=${user.id}) AS passkey`;
  if (!state.totp && !state.passkey) return null;
  const methods = [
    ...(state.passkey ? ["passkey"] : []),
    ...(state.totp ? ["totp", "recovery"] : []),
  ];
  return {
    requiresSecondFactor: true,
    challengeId: await createChallenge(user.id, purpose, sessionId, null, db),
    methods,
    preferredMethod: state.passkey ? "passkey" : "totp",
  };
}
authRoutes.post("/login", async (c) => {
  const input = await body(c, loginSchema);
  await Promise.all([
    rateLimit(`login-ip:${clientAddress(c)}`, 40),
    rateLimit(`login-email:${input.email}`, 10),
  ]);
  const [user] = await sql<
    UserRow[]
  >`SELECT * FROM users WHERE email=${input.email} AND disabled_at IS NULL`;
  if (!(await verifyPassword(input.password, user?.passwordHash ?? "")))
    throw new HTTPException(401, {
      message: "The email address or password is incorrect",
    });
  return sql.begin(async (tx) => {
    const [current] = await tx<
      UserRow[]
    >`SELECT * FROM users WHERE id=${user.id} AND disabled_at IS NULL FOR UPDATE`;
    if (!current || current.passwordHash !== user.passwordHash)
      throw new HTTPException(401, {
        message: "Your account security changed. Sign in again.",
      });
    const challenge = await secondFactorChallenge(current, "login", null, tx);
    if (challenge) return c.json(challenge);
    await newSession(c, current.id, tx, current.securityEpoch);

    return c.json(await identityResponse(current, tx));
  });
});
authRoutes.post("/reauth", async (c) => {
  const user = await activeUser(human(c).userId);
  const input = await body(
    c,
    z.object({ password: z.string().min(1).max(1024) }),
  );
  await rateLimit(`reauth:${user.id}`, 10);
  if (!(await verifyPassword(input.password, user.passwordHash)))
    throw new HTTPException(401, { message: "The password is incorrect" });
  return sql.begin(async (tx) => {
    const [current] = await tx<
      UserRow[]
    >`SELECT * FROM users WHERE id=${user.id} AND disabled_at IS NULL FOR UPDATE`;
    if (!current || current.passwordHash !== user.passwordHash)
      throw new HTTPException(401, {
        message: "Your account security changed. Sign in again.",
      });
    const session = await currentSession(c, tx);
    const challenge = await secondFactorChallenge(
      current,
      "reauth",
      session.id,
      tx,
    );
    if (challenge) return c.json(challenge);
    await tx`UPDATE sessions SET authenticated_at=now() WHERE id=${session.id}`;
    return c.json({ ok: true });
  });
});
authRoutes.post("/logout", async (c) => {
  const token = sessionToken(c.req.raw);
  if (token)
    await sql`DELETE FROM sessions WHERE token_hash=${hashToken(token)}`;
  clearSession(c);
  return c.json({ ok: true });
});
authRoutes.get("/me", async (c) =>
  c.json(await identityResponse(await activeUser(human(c).userId))),
);
authRoutes.patch("/profile", async (c) => {
  const who = human(c);
  const input = await body(
    c,
    z.object({
      name: nameSchema.optional(),
      timeZone: z.string().min(1).max(100).optional(),
      notificationPreferences: z
        .object({ assignments: z.boolean(), mentions: z.boolean() })
        .strict()
        .optional(),
    }),
  );
  if (input.timeZone !== undefined) {
    try {
      new Intl.DateTimeFormat("en", { timeZone: input.timeZone });
    } catch {
      badRequest("Choose a valid time zone");
    }
  }
  const user = await activeUser(who.userId);
  const [updated] = await sql<
    UserRow[]
  >`UPDATE users SET name=${input.name ?? user.name},time_zone=${input.timeZone ?? user.timeZone},
    notification_preferences=${sql.json(input.notificationPreferences ?? inAppPreferences(user.notificationPreferences))},updated_at=now() WHERE id=${who.userId} RETURNING *`;
  return c.json(await identityResponse(updated));
});
authRoutes.get("/sessions", async (c) => {
  const session = await currentSession(c);
  const items =
    await sql`SELECT id,user_agent,created_at,last_seen_at,expires_at,(id=${session.id}) AS current FROM sessions WHERE user_id=${human(c).userId} AND expires_at>now() ORDER BY created_at DESC`;
  return c.json({ items });
});
authRoutes.delete("/sessions/:id", async (c) => {
  const who = human(c);
  const id = z.uuid().safeParse(c.req.param("id"));
  if (!id.success) badRequest("Invalid session");
  const current = await currentSession(c);
  const [deleted] =
    await sql`DELETE FROM sessions WHERE id=${id.data} AND user_id=${who.userId} RETURNING id`;
  if (!deleted) throw new HTTPException(404, { message: "Session not found" });
  if (current.id === deleted.id) clearSession(c);

  return c.json({ ok: true });
});
authRoutes.post("/password", async (c) => {
  await recentSession(c);
  const user = await activeUser(human(c).userId);
  const input = await body(
    c,
    z.object({
      currentPassword: z.string().min(1).max(1024),
      password: passwordSchema,
    }),
  );
  await rateLimit(`password-change:${user.id}`, 5);
  if (!(await verifyPassword(input.currentPassword, user.passwordHash)))
    throw new HTTPException(401, {
      message: "The current password is incorrect",
    });
  const passwordHash = await hashPassword(input.password);
  const current = await currentSession(c);
  await sql.begin(async (tx) => {
    const [locked] = await tx<
      UserRow[]
    >`SELECT * FROM users WHERE id=${user.id} AND disabled_at IS NULL FOR UPDATE`;
    if (!locked || locked.passwordHash !== user.passwordHash)
      throw new HTTPException(401, {
        message: "Your account security changed. Sign in again.",
      });
    await currentSession(c, tx);
    await tx`UPDATE users SET password_hash=${passwordHash},security_epoch=security_epoch+1,updated_at=now() WHERE id=${user.id}`;
    await tx`UPDATE sessions SET security_epoch=${locked.securityEpoch + 1},authenticated_at=now() WHERE id=${current.id}`;
    await tx`DELETE FROM sessions WHERE user_id=${user.id} AND id<>${current.id}`;
    await tx`DELETE FROM auth_challenges WHERE user_id=${user.id}`;
    await tx`DELETE FROM account_recovery WHERE user_id=${user.id}`;
    await tx`UPDATE credentials SET revoked_at=COALESCE(revoked_at,now()) WHERE user_id=${user.id}`;
    await tx`UPDATE oauth_requests SET consumed_at=COALESCE(consumed_at,now()),expires_at=now() WHERE user_id=${user.id}`;
  });
  return c.json({ ok: true });
});
authRoutes.route("/", securityRoutes);
authRoutes.route("/", teamRoutes);
authRoutes.route("/", recoveryRoutes);

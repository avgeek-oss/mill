import { randomUUID } from "node:crypto";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import { sql } from "../../../../packages/database/src/index.js";
import {
  badRequest,
  clientAddress,
  conflict,
  requireRole,
  type Env,
} from "../http.js";
import {
  activeUser,
  admin,
  audit,
  body,
  emailSchema,
  identityResponse,
  nameSchema,
  newSession,
  passwordSchema,
  roleSchema,
  type Db,
  type UserRow,
} from "./model.js";
import {
  appOrigin,
  hashPassword,
  hashToken,
  rateLimit,
  secretToken,
} from "./security.js";

export const teamRoutes = new Hono<Env>();
const uuid = (value: string) => {
  const parsed = z.uuid().safeParse(value);
  if (!parsed.success) badRequest("Invalid member or invitation");
  return parsed.data;
};
async function lockedAdmin(userId: string, db: Db) {
  await db`SELECT id FROM workspace FOR UPDATE`;
  const user = await activeUser(userId, db);
  if (user.role !== "admin")
    throw new HTTPException(403, {
      message: "Only administrators can manage the team",
    });
  return user;
}
async function protectLastAdmin(user: UserRow, db: Db) {
  if (user.role !== "admin") return;
  const [count] =
    await db`SELECT count(*)::int AS total FROM users WHERE role='admin' AND disabled_at IS NULL`;
  if (count.total <= 1)
    conflict("Keep at least one active administrator in the workspace");
}
teamRoutes.get("/members", async (c) => {
  const who = requireRole(c, "viewer");
  if (who.kind === "agent" && who.boardIds)
    throw new HTTPException(403, {
      message: "This credential cannot read the team directory",
    });
  const items =
    await sql`SELECT id,name,email,role,time_zone FROM users WHERE disabled_at IS NULL ORDER BY name,id LIMIT 1000`;
  return c.json({ items });
});
teamRoutes.get("/invitations", async (c) => {
  admin(c);
  const items =
    await sql`SELECT id,email,role,created_at,expires_at,accepted_at,revoked_at FROM invitations ORDER BY created_at DESC LIMIT 100`;
  return c.json({ items });
});
teamRoutes.post("/invitations", async (c) => {
  const who = admin(c);
  const input = await body(
    c,
    z.object({ email: emailSchema, role: roleSchema }),
  );
  await rateLimit(`invite:${who.userId}`, 30, 3600);
  const token = secretToken();
  const invitation = await sql.begin(async (tx) => {
    const user = await lockedAdmin(who.userId, tx);
    const [existing] =
      await tx`SELECT id FROM users WHERE email=${input.email} AND disabled_at IS NULL`;
    if (existing) conflict("This person is already a member");
    await tx`UPDATE invitations SET revoked_at=now() WHERE email=${input.email} AND accepted_at IS NULL AND revoked_at IS NULL`;
    const [created] =
      await tx`INSERT INTO invitations(id,email,role,token_hash,invited_by,expires_at)
      VALUES(${randomUUID()},${input.email},${input.role},${hashToken(token)},${user.id},now()+interval '7 days')
      RETURNING id,email,role,created_at,expires_at`;
    await audit(
      user,
      "member.invited",
      { email: input.email, role: input.role },
      tx,
    );
    return created;
  });
  const inviteUrl = `${appOrigin()}/invite?token=${token}`;
  return c.json(
    { invitation, token, inviteUrl, emailDelivery: "unavailable" },
    201,
  );
});
teamRoutes.delete("/invitations/:id", async (c) => {
  const who = admin(c);
  const id = uuid(c.req.param("id"));
  await sql.begin(async (tx) => {
    const user = await lockedAdmin(who.userId, tx);
    const [revoked] =
      await tx`UPDATE invitations SET revoked_at=now() WHERE id=${id} AND accepted_at IS NULL AND revoked_at IS NULL RETURNING email`;
    if (!revoked)
      throw new HTTPException(404, { message: "Active invitation not found" });
    await audit(
      user,
      "member.invitation-revoked",
      { email: revoked.email },
      tx,
    );
  });
  return c.json({ ok: true });
});
teamRoutes.get("/invitation", async (c) => {
  const token = c.req.query("token") ?? "";
  await rateLimit(`invitation-lookup:${clientAddress(c)}`, 40);
  if (!/^[A-Za-z0-9_-]{43}$/.test(token))
    badRequest("The invitation is invalid or expired");
  const [invitation] =
    await sql`SELECT i.email,i.role,w.name AS workspace_name FROM invitations i CROSS JOIN workspace w
    WHERE i.token_hash=${hashToken(token)} AND i.accepted_at IS NULL AND i.revoked_at IS NULL AND i.expires_at>now()`;
  if (!invitation) badRequest("The invitation is invalid or expired");
  return c.json({ invitation });
});
teamRoutes.post("/accept-invitation", async (c) => {
  const input = await body(
    c,
    z.object({
      token: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
      name: nameSchema,
      password: passwordSchema,
    }),
  );
  await rateLimit(`accept-invitation:${clientAddress(c)}`, 20);
  const passwordHash = await hashPassword(input.password);
  return sql.begin(async (tx) => {
    await tx`SELECT id FROM workspace FOR UPDATE`;
    const [invitation] =
      await tx`SELECT * FROM invitations WHERE token_hash=${hashToken(input.token)} AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at>now() FOR UPDATE`;
    if (!invitation) badRequest("The invitation is invalid or expired");
    const [workspace] = await tx`SELECT id FROM workspace`;
    const [existing] = await tx<
      UserRow[]
    >`SELECT * FROM users WHERE email=${invitation.email} FOR UPDATE`;
    if (existing && !existing.disabledAt)
      conflict("This account is already a member. Sign in instead.");
    let user: UserRow;
    if (existing) {
      [user] = await tx<
        UserRow[]
      >`UPDATE users SET name=${input.name},password_hash=${passwordHash},security_epoch=security_epoch+1,role=${invitation.role},disabled_at=null,updated_at=now() WHERE id=${existing.id} RETURNING *`;
      await tx`DELETE FROM passkeys WHERE user_id=${user.id}`;
      await tx`DELETE FROM authenticators WHERE user_id=${user.id}`;
      await tx`DELETE FROM recovery_codes WHERE user_id=${user.id}`;
      await tx`DELETE FROM sessions WHERE user_id=${user.id}`;
    } else
      [user] = await tx<
        UserRow[]
      >`INSERT INTO users(id,workspace_id,name,email,password_hash,role)
      VALUES(${randomUUID()},${workspace.id},${input.name},${invitation.email},${passwordHash},${invitation.role}) RETURNING *`;
    await tx`UPDATE invitations SET accepted_at=now() WHERE id=${invitation.id}`;
    await newSession(c, user.id, tx);
    await audit(user, "member.joined", {}, tx);
    return c.json(await identityResponse(user, tx), 201);
  });
});
teamRoutes.patch("/members/:id", async (c) => {
  const who = admin(c);
  const id = uuid(c.req.param("id"));
  const input = await body(c, z.object({ role: roleSchema }));
  const member = await sql.begin(async (tx) => {
    const operator = await lockedAdmin(who.userId, tx);
    const user = await activeUser(id, tx);
    if (user.role === "admin" && input.role !== "admin")
      await protectLastAdmin(user, tx);
    const [updated] =
      await tx`UPDATE users SET role=${input.role},updated_at=now() WHERE id=${id} RETURNING id,name,email,role,time_zone`;
    await audit(
      operator,
      "member.role-changed",
      { memberId: id, role: input.role },
      tx,
    );
    return updated;
  });
  return c.json({ member });
});
teamRoutes.delete("/members/:id", async (c) => {
  const who = admin(c);
  const id = uuid(c.req.param("id"));
  await sql.begin(async (tx) => {
    const operator = await lockedAdmin(who.userId, tx);
    const user = await activeUser(id, tx);
    await protectLastAdmin(user, tx);
    await tx`UPDATE users SET disabled_at=now(),security_epoch=security_epoch+1,updated_at=now() WHERE id=${id}`;
    await tx`DELETE FROM sessions WHERE user_id=${id}`;
    await tx`DELETE FROM auth_challenges WHERE user_id=${id}`;
    await tx`DELETE FROM account_recovery WHERE user_id=${id}`;
    await tx`UPDATE credentials SET revoked_at=COALESCE(revoked_at,now()) WHERE user_id=${id}`;
    await tx`UPDATE oauth_requests SET consumed_at=COALESCE(consumed_at,now()),expires_at=now() WHERE user_id=${id}`;
    await audit(operator, "member.removed", { memberId: id }, tx);
  });
  return c.json({ ok: true });
});

import {
  randomInt,
  randomUUID,
  createHmac,
  timingSafeEqual,
} from "node:crypto";
import { Hono, type Context } from "hono";
import { z } from "zod";
import type { PendingEmailChange } from "../../../../packages/contracts/src/index.js";
import { sql } from "../../../../packages/database/src/index.js";
import { config } from "../config.js";
import { clientAddress, conflict, HttpError, type Env } from "../http.js";
import {
  activeUser,
  body,
  currentSession,
  emailSchema,
  human,
  nameSchema,
  recentSession,
  type Db,
} from "./model.js";
import { appOrigin, hashToken, rateLimit, secretToken } from "./security.js";
import {
  cancelEmails,
  emailDeliveryConfigured,
  enqueueEmail,
} from "./email-outbox.js";
export const emailRoutes = new Hono<Env>();
const tokenSchema = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
const confirmationSchema = z
  .object({ id: z.uuid(), token: tokenSchema })
  .strict();
const emptySchema = z.object({}).strict();
const invalidLink = () =>
  new HttpError(400, "INVALID_EMAIL_LINK", "The link is invalid or expired");
const invalidInvitation = () =>
  new HttpError(
    400,
    "INVALID_INVITATION",
    "The invitation is invalid or expired",
  );
function requireDelivery() {
  if (!emailDeliveryConfigured())
    throw new HttpError(
      503,
      "EMAIL_DELIVERY_UNAVAILABLE",
      "Email delivery is not configured",
    );
}
const codeDigest = (id: string, code: string) =>
  createHmac("sha256", config().MILL_SECRET)
    .update(`mill:invitation-code:${id}:${code}`)
    .digest("hex");
function equalHash(a: string, b: string) {
  const x = Buffer.from(a, "hex"),
    y = Buffer.from(b, "hex");
  return x.length === y.length && timingSafeEqual(x, y);
}
function expectedIdentity(c: Context<Env>) {
  const who = human(c),
    expected = c.req.header("X-Mill-User-Id");
  if (
    expected !== undefined &&
    (!z.uuid().safeParse(expected).success || expected !== who.userId)
  )
    throw new HttpError(
      409,
      "ACCOUNT_IDENTITY_CHANGED",
      "Your signed-in account changed. Reload to continue.",
    );
  return who;
}
async function lockedIdentity(
  c: Context<Env>,
  db: Db,
  recent = false,
  lockUser = true,
) {
  const who = expectedIdentity(c);
  await db`SELECT id FROM workspace FOR UPDATE`;
  if (lockUser)
    await db`SELECT id FROM users WHERE id=${who.userId} FOR NO KEY UPDATE`;
  await (recent ? recentSession(c, db) : currentSession(c, db));
  return activeUser(who.userId, db);
}
export async function pendingInvitation(db: Db, token: string, lock = false) {
  if (lock) {
    const [inviter] =
      await db`SELECT invited_by FROM invitations WHERE token_hash=${hashToken(token)}`;
    if (inviter)
      await db`SELECT id FROM users WHERE id=${inviter.invitedBy} FOR NO KEY UPDATE`;
  }
  const [i] =
    await db`SELECT i.*,u.workspace_id,u.security_epoch AS inviter_epoch FROM invitations i JOIN users u ON u.id=i.invited_by WHERE i.token_hash=${hashToken(token)} AND i.accepted_at IS NULL AND i.revoked_at IS NULL AND i.expires_at>now() AND u.disabled_at IS NULL AND u.role='admin' ${lock ? db`FOR UPDATE OF i` : db``}`;
  if (!i) throw invalidInvitation();
  return i;
}
async function retireRequest(db: Db, id: string) {
  await db`UPDATE email_requests SET consumed_at=now(),token_hash=null,code_hash=null,proof_hash=null WHERE id=${id}`;
  await db`UPDATE email_outbox SET state='cancelled',payload=null,lease_token=null,lease_until=null WHERE request_id=${id} AND state='pending'`;
}
async function issueVerification(
  db: Db,
  user: {
    id: string;
    email: string;
    emailVerified: boolean;
    securityEpoch: number;
  },
) {
  if (user.emailVerified) return Date.now();
  const [existing] =
    await db`SELECT * FROM email_requests WHERE user_id=${user.id} AND purpose='verification' AND consumed_at IS NULL`;
  if (
    existing &&
    existing.email === user.email &&
    existing.securityEpoch === user.securityEpoch &&
    new Date(existing.expiresAt).getTime() > Date.now() &&
    new Date(existing.createdAt).getTime() + 60000 > Date.now()
  )
    return new Date(existing.createdAt).getTime() + 60000;
  if (existing) await retireRequest(db, existing.id);
  const id = randomUUID(),
    token = secretToken(),
    expiresAt = new Date(Date.now() + 3600000);
  const [created] =
    await db`INSERT INTO email_requests(id,user_id,purpose,email,security_epoch,token_hash,expires_at) VALUES(${id},${user.id},'verification',${user.email},${user.securityEpoch},${hashToken(token)},${expiresAt}) RETURNING created_at`;
  await enqueueEmail(
    db,
    { requestId: id },
    {
      to: user.email,
      subject: "Verify your Mill email address",
      text: `Confirm your email address by opening this link:\n${appOrigin()}/verify-email#${id}.${token}\n\nThis link expires in one hour. If you did not request it, ignore this email.`,
    },
    expiresAt,
  );
  return new Date(created.createdAt).getTime() + 60000;
}
emailRoutes.post("/email-verification/request", async (c) => {
  expectedIdentity(c);
  requireDelivery();
  await body(c, emptySchema);
  await rateLimit(`verification-user:${human(c).userId}`, 5, 86400);
  const resendAvailableAt = await sql.begin(async (tx) =>
    issueVerification(tx, await lockedIdentity(c, tx)),
  );
  return c.json({ status: true, resendAvailableAt });
});
async function publicEmailRequest(
  c: Context<Env>,
  purpose: "verification" | "reset",
) {
  const started = Date.now();
  try {
    const input = await body(c, z.object({ email: emailSchema }).strict());
    requireDelivery();
    await Promise.all([
      rateLimit(`public-email-${purpose}-ip:${clientAddress(c)}`, 20, 60),
      rateLimit(`public-email-${purpose}-minute:${input.email}`, 1, 60),
      rateLimit(`public-email-${purpose}-day:${input.email}`, 5, 86400),
    ]);
    await sql.begin(async (tx) => {
      await tx`SELECT id FROM workspace FOR UPDATE`;
      const [user] =
        await tx`SELECT * FROM users WHERE email=${input.email} AND disabled_at IS NULL FOR UPDATE`;
      if (!user) return;
      if (purpose === "verification") {
        await issueVerification(
          tx,
          user as {
            id: string;
            email: string;
            emailVerified: boolean;
            securityEpoch: number;
          },
        );
        return;
      }
      const [existing] =
        await tx`SELECT created_at FROM account_recovery WHERE user_id=${user.id} AND security_epoch=${user.securityEpoch} AND expires_at>now() ORDER BY created_at DESC LIMIT 1`;
      if (
        existing &&
        new Date(existing.createdAt).getTime() + 60000 > Date.now()
      )
        return;
      await tx`UPDATE email_outbox SET state='cancelled',payload=null,lease_token=null,lease_until=null WHERE recovery_hash IN (SELECT token_hash FROM account_recovery WHERE user_id=${user.id}) AND state='pending'`;
      await tx`DELETE FROM account_recovery WHERE user_id=${user.id}`;
      const token = secretToken(),
        digest = hashToken(token),
        expiresAt = new Date(Date.now() + 3600000);
      await tx`INSERT INTO account_recovery(token_hash,user_id,reset_mfa,security_epoch,expires_at) VALUES(${digest},${user.id},false,${user.securityEpoch},${expiresAt})`;
      await enqueueEmail(
        tx,
        { recoveryHash: digest },
        {
          to: user.email,
          subject: "Reset your Mill password",
          text: `Reset your password by opening this link:\n${appOrigin()}/recover#${token}\n\nThis link expires in one hour. If you did not request it, ignore this email.`,
        },
        expiresAt,
      );
    });
    return c.json({ status: true });
  } finally {
    const remaining = 500 - (Date.now() - started);
    if (remaining > 0)
      await new Promise((resolve) => setTimeout(resolve, remaining));
  }
}
emailRoutes.post("/verification-email", (c) =>
  publicEmailRequest(c, "verification"),
);
emailRoutes.post("/password-reset/request", (c) =>
  publicEmailRequest(c, "reset"),
);
emailRoutes.post("/email-verification/confirm", async (c) => {
  const input = await body(c, confirmationSchema);
  await rateLimit(`verification-confirm:${clientAddress(c)}`, 20);
  await sql.begin(async (tx) => {
    await tx`SELECT id FROM workspace FOR UPDATE`;
    const [owner] =
      await tx`SELECT user_id FROM email_requests WHERE id=${input.id}`;
    if (owner)
      await tx`SELECT id FROM users WHERE id=${owner.userId} FOR NO KEY UPDATE`;
    const [r] =
      await tx`SELECT er.* FROM email_requests er JOIN users u ON u.id=er.user_id WHERE er.id=${input.id} AND er.purpose='verification' AND er.token_hash=${hashToken(input.token)} AND er.expires_at>now() AND er.consumed_at IS NULL AND u.disabled_at IS NULL AND u.security_epoch=er.security_epoch AND u.email=er.email FOR UPDATE OF er`;
    if (!r) throw invalidLink();
    await tx`UPDATE users SET email_verified=true,updated_at=now() WHERE id=${r.userId}`;
    await retireRequest(tx, r.id);
  });
  return c.json({ ok: true });
});
async function pendingChange(
  db: Db,
  userId: string,
): Promise<PendingEmailChange | null> {
  const [r] =
    await db`SELECT er.email,er.expires_at FROM email_requests er JOIN users u ON u.id=er.user_id WHERE er.user_id=${userId} AND er.purpose='change' AND er.consumed_at IS NULL AND er.expires_at>now() AND er.security_epoch=u.security_epoch AND er.previous_email=u.email AND u.disabled_at IS NULL`;
  return r
    ? { email: r.email, expiresAt: new Date(r.expiresAt).toISOString() }
    : null;
}
emailRoutes.get("/email-change", async (c) => {
  const pending = await sql.begin(async (tx) => {
    const u = await lockedIdentity(c, tx, false, false);
    return pendingChange(tx, u.id);
  });
  return c.json({ pending });
});
emailRoutes.post("/email-change", async (c) => {
  human(c);
  requireDelivery();
  const input = await body(c, z.object({ email: emailSchema }).strict());
  const pending = await sql.begin(async (tx) => {
    const u = await lockedIdentity(c, tx, true);
    if (u.email === input.email)
      throw new HttpError(
        400,
        "EMAIL_UNCHANGED",
        "Choose a different email address",
      );
    const [existing] =
      await tx`SELECT * FROM email_requests WHERE user_id=${u.id} AND purpose='change' AND consumed_at IS NULL`;
    if (
      existing &&
      existing.email === input.email &&
      existing.securityEpoch === u.securityEpoch &&
      existing.previousEmail === u.email &&
      new Date(existing.expiresAt).getTime() > Date.now()
    )
      return {
        email: existing.email,
        expiresAt: new Date(existing.expiresAt).toISOString(),
      };
    await rateLimit(`email-change:${u.id}`, 5, 3600);
    const [taken] = await tx`SELECT id FROM users WHERE email=${input.email}`;
    if (taken) conflict("This email address is unavailable");
    if (existing) await retireRequest(tx, existing.id);
    const id = randomUUID(),
      token = secretToken(),
      expiresAt = new Date(Date.now() + 3600000);
    await tx`INSERT INTO email_requests(id,user_id,purpose,email,previous_email,security_epoch,token_hash,expires_at) VALUES(${id},${u.id},'change',${input.email},${u.email},${u.securityEpoch},${hashToken(token)},${expiresAt})`;
    await enqueueEmail(
      tx,
      { requestId: id },
      {
        to: input.email,
        subject: "Confirm your Mill email change",
        text: `Confirm your new email address by opening this link:\n${appOrigin()}/confirm-email-change#${id}.${token}\n\nThis link expires in one hour. If you did not request it, ignore this email.`,
      },
      expiresAt,
    );
    return { email: input.email, expiresAt: expiresAt.toISOString() };
  });
  return c.json({ pending });
});
emailRoutes.delete("/email-change", async (c) => {
  human(c);
  await body(c, emptySchema);
  await sql.begin(async (tx) => {
    const u = await lockedIdentity(c, tx);
    const rows =
      await tx`SELECT id FROM email_requests WHERE user_id=${u.id} AND purpose='change' AND consumed_at IS NULL`;
    for (const r of rows) await retireRequest(tx, r.id);
  });
  return c.json({ ok: true });
});
emailRoutes.post("/email-change/confirm", async (c) => {
  const input = await body(c, confirmationSchema);
  await rateLimit(`email-change-confirm:${clientAddress(c)}`, 20);
  await sql.begin(async (tx) => {
    await tx`SELECT id FROM workspace FOR UPDATE`;
    const [owner] =
      await tx`SELECT user_id FROM email_requests WHERE id=${input.id}`;
    if (owner)
      await tx`SELECT id FROM users WHERE id=${owner.userId} FOR NO KEY UPDATE`;
    const [r] =
      await tx`SELECT er.* FROM email_requests er JOIN users u ON u.id=er.user_id WHERE er.id=${input.id} AND er.purpose='change' AND er.token_hash=${hashToken(input.token)} AND er.expires_at>now() AND er.consumed_at IS NULL AND u.disabled_at IS NULL AND u.security_epoch=er.security_epoch AND u.email=er.previous_email FOR UPDATE OF er`;
    if (!r) throw invalidLink();
    const [taken] = await tx`SELECT id FROM users WHERE email=${r.email}`;
    if (taken) throw invalidLink();
    await cancelEmails(tx, r.userId);
    await retireRequest(tx, r.id);
    await tx`UPDATE users SET email=${r.email},email_verified=true,security_epoch=security_epoch+1,updated_at=now() WHERE id=${r.userId}`;
    await tx`DELETE FROM sessions WHERE user_id=${r.userId}`;
    await tx`DELETE FROM auth_challenges WHERE user_id=${r.userId}`;
    await tx`DELETE FROM account_recovery WHERE user_id=${r.userId}`;
    await tx`UPDATE credentials SET revoked_at=COALESCE(revoked_at,now()) WHERE user_id=${r.userId}`;
    await tx`UPDATE oauth_requests SET consumed_at=COALESCE(consumed_at,now()),expires_at=now() WHERE user_id=${r.userId}`;
  });
  return c.json({ ok: true });
});
emailRoutes.post("/invitation/verification/request", async (c) => {
  const input = await body(c, z.object({ token: tokenSchema }).strict());
  requireDelivery();
  await rateLimit(`invitation-code-ip:${clientAddress(c)}`, 20, 60);
  const result = await sql.begin(async (tx) => {
    await tx`SELECT id FROM workspace FOR UPDATE`;
    const i = await pendingInvitation(tx, input.token, true);
    if (!i.verificationRequired) throw invalidInvitation();
    const [old] =
      await tx`SELECT * FROM email_requests WHERE invitation_id=${i.id} AND consumed_at IS NULL`;
    if (
      old &&
      old.securityEpoch === i.inviterEpoch &&
      new Date(old.expiresAt).getTime() > Date.now() &&
      new Date(old.createdAt).getTime() + 60000 > Date.now()
    )
      return {
        status: true,
        resendAvailableAt: new Date(old.createdAt).getTime() + 60000,
        expiresAt: new Date(old.expiresAt).toISOString(),
      };
    await rateLimit(`invitation-code-day:${i.id}`, 5, 86400);
    if (old) await retireRequest(tx, old.id);
    const id = randomUUID(),
      code = String(randomInt(0, 1000000)).padStart(6, "0"),
      expiresAt = new Date(
        Math.min(Date.now() + 600000, new Date(i.expiresAt).getTime()),
      );
    const [created] =
      await tx`INSERT INTO email_requests(id,invitation_id,purpose,email,security_epoch,code_hash,expires_at) VALUES(${id},${i.id},'invitation',${i.email},${i.inviterEpoch},${codeDigest(id, code)},${expiresAt}) RETURNING created_at`;
    await enqueueEmail(
      tx,
      { requestId: id },
      {
        to: i.email,
        subject: "Verify your Mill invitation",
        text: `Your invitation verification code is ${code}.\n\nIt expires in ten minutes. If you did not request it, ignore this email.`,
      },
      expiresAt,
    );
    return {
      status: true,
      resendAvailableAt: new Date(created.createdAt).getTime() + 60000,
      expiresAt: expiresAt.toISOString(),
    };
  });
  return c.json(result);
});
emailRoutes.post("/invitation/verification/confirm", async (c) => {
  const input = await body(
    c,
    z
      .object({
        token: tokenSchema,
        name: nameSchema,
        code: z.string().regex(/^\d{6}$/),
      })
      .strict(),
  );
  await rateLimit(`invitation-code-confirm:${clientAddress(c)}`, 30, 60);
  const proof = secretToken();
  const accepted = await sql.begin(async (tx) => {
    await tx`SELECT id FROM workspace FOR UPDATE`;
    const i = await pendingInvitation(tx, input.token, true);
    const [r] =
      await tx`SELECT * FROM email_requests WHERE invitation_id=${i.id} AND purpose='invitation' AND consumed_at IS NULL AND expires_at>now() AND security_epoch=${i.inviterEpoch} FOR UPDATE`;
    if (!i.verificationRequired || !r || !r.codeHash || r.attempts >= 5)
      return false;
    if (!equalHash(r.codeHash, codeDigest(r.id, input.code))) {
      await tx`UPDATE email_requests SET attempts=attempts+1 WHERE id=${r.id}`;
      return false;
    }
    await tx`UPDATE email_requests SET code_hash=null,proof_hash=${hashToken(proof)},verified_name=${input.name},expires_at=LEAST(now()+interval '10 minutes',${i.expiresAt}) WHERE id=${r.id}`;
    await tx`UPDATE email_outbox SET state='cancelled',payload=null,lease_token=null,lease_until=null WHERE request_id=${r.id} AND state='pending'`;
    return true;
  });
  if (!accepted)
    throw new HttpError(
      400,
      "INVALID_VERIFICATION_CODE",
      "The verification code is invalid or expired",
    );
  return c.json({ verificationToken: proof });
});
export async function consumeInvitationProof(
  db: Db,
  invitation: {
    id: string;
    inviterEpoch: number;
    verificationRequired: boolean;
  },
  name: string,
  proof?: string,
) {
  if (!invitation.verificationRequired) {
    if (proof) throw invalidInvitation();
    return false;
  }
  if (!proof)
    throw new HttpError(
      400,
      "INVITATION_VERIFICATION_REQUIRED",
      "Verify your invitation email before continuing",
    );
  const [r] =
    await db`SELECT id FROM email_requests WHERE invitation_id=${invitation.id} AND purpose='invitation' AND proof_hash=${hashToken(proof)} AND verified_name=${name} AND security_epoch=${invitation.inviterEpoch} AND expires_at>now() AND consumed_at IS NULL FOR UPDATE`;
  if (!r) throw invalidInvitation();
  await retireRequest(db, r.id);
  return true;
}

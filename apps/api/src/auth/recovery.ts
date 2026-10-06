import { Hono } from "hono";
import { z } from "zod";
import { sql } from "../../../../packages/database/src/index.js";
import { badRequest, clientAddress, type Env } from "../http.js";
import { activeUser, body, passwordSchema } from "./model.js";
import { hashPassword, hashToken, rateLimit, secretToken } from "./security.js";

import { cancelEmails } from "./email-outbox.js";
export const recoveryRoutes = new Hono<Env>();
export async function createOperatorRecovery(email: string, resetMfa = false) {
  const token = secretToken();
  await sql.begin(async (tx) => {
    await tx`SELECT id FROM workspace FOR UPDATE`;
    const [user] =
      await tx`SELECT * FROM users WHERE email=${email.trim().toLowerCase()} AND disabled_at IS NULL FOR UPDATE`;
    if (!user) throw new Error("Active member not found");
    await cancelEmails(tx, user.id);
    await tx`DELETE FROM account_recovery WHERE user_id=${user.id}`;
    await tx`INSERT INTO account_recovery(token_hash,user_id,reset_mfa,security_epoch,expires_at) VALUES(${hashToken(token)},${user.id},${resetMfa},${user.securityEpoch},now()+interval '30 minutes')`;
  });
  return token;
}
recoveryRoutes.post("/recovery/reset", async (c) => {
  const input = await body(
    c,
    z
      .object({
        token: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
        password: passwordSchema,
      })
      .strict(),
  );
  await rateLimit(`account-recovery:${clientAddress(c)}`, 10);
  const passwordHash = await hashPassword(input.password);
  await sql.begin(async (tx) => {
    await tx`SELECT id FROM workspace FOR UPDATE`;
    const [recovery] =
      await tx`SELECT * FROM account_recovery WHERE token_hash=${hashToken(input.token)} AND expires_at>now() FOR UPDATE`;
    if (!recovery) badRequest("The recovery link is invalid or expired");
    const user = await activeUser(recovery.userId, tx);
    if (recovery.securityEpoch !== user.securityEpoch)
      badRequest("The recovery link is invalid or expired");
    await cancelEmails(tx, user.id);
    await tx`UPDATE users SET password_hash=${passwordHash},security_epoch=security_epoch+1,updated_at=now() WHERE id=${user.id}`;
    await tx`DELETE FROM sessions WHERE user_id=${user.id}`;
    await tx`DELETE FROM auth_challenges WHERE user_id=${user.id}`;
    await tx`DELETE FROM account_recovery WHERE user_id=${user.id}`;
    await tx`UPDATE credentials SET revoked_at=COALESCE(revoked_at,now()) WHERE user_id=${user.id}`;
    await tx`UPDATE oauth_requests SET consumed_at=COALESCE(consumed_at,now()),expires_at=now() WHERE user_id=${user.id}`;
    if (recovery.resetMfa) {
      await tx`DELETE FROM recovery_codes WHERE user_id=${user.id}`;
      await tx`DELETE FROM passkeys WHERE user_id=${user.id}`;
    }
  });
  return c.json({ ok: true });
});

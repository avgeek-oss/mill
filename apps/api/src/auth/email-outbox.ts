import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  randomUUID,
} from "node:crypto";
import { Socket } from "node:net";
import nodemailer from "nodemailer";
import { z } from "zod";
import { sql } from "../../../../packages/database/src/index.js";
import { config } from "../config.js";
import type { Db } from "./model.js";
const messageSchema = z
  .object({
    to: z.email(),
    subject: z.string().max(200),
    text: z.string().max(10000),
    html: z.string().max(100000).optional(),
  })
  .strict();
type Message = z.infer<typeof messageSchema>;
type MailRow = {
  id: string;
  requestId: string | null;
  invitationId: string | null;
  recoveryHash: string | null;
  payload: string;
  attempts: number;
  leaseToken: string;
};
export function emailDeliveryConfigured() {
  return Boolean(config().MILL_SMTP_HOST);
}
const encryptionKey = () =>
  createHash("sha256")
    .update("mill:identity-email:v1\0")
    .update(config().MILL_SECRET)
    .digest();
function encrypt(id: string, message: Message) {
  const nonce = randomBytes(12),
    cipher = createCipheriv("aes-256-gcm", encryptionKey(), nonce);
  cipher.setAAD(Buffer.from(id));
  const encrypted = Buffer.concat([
    cipher.update(JSON.stringify(message), "utf8"),
    cipher.final(),
  ]);
  return Buffer.concat([nonce, cipher.getAuthTag(), encrypted]).toString(
    "base64url",
  );
}
function decrypt(id: string, payload: string): Message {
  const encoded = Buffer.from(payload, "base64url");
  const decipher = createDecipheriv(
    "aes-256-gcm",
    encryptionKey(),
    encoded.subarray(0, 12),
  );
  decipher.setAAD(Buffer.from(id));
  decipher.setAuthTag(encoded.subarray(12, 28));
  return messageSchema.parse(
    JSON.parse(
      Buffer.concat([
        decipher.update(encoded.subarray(28)),
        decipher.final(),
      ]).toString("utf8"),
    ),
  );
}
export async function enqueueEmail(
  db: Db,
  reference: {
    requestId?: string;
    invitationId?: string;
    recoveryHash?: string;
  },
  message: Message,
  expiresAt: Date,
) {
  const id = randomUUID();
  await db`INSERT INTO email_outbox(id,request_id,invitation_id,recovery_hash,payload,expires_at) VALUES(${id},${reference.requestId ?? null},${reference.invitationId ?? null},${reference.recoveryHash ?? null},${encrypt(id, messageSchema.parse(message))},${expiresAt})`;
}
export async function cancelEmails(db: Db, userId: string) {
  await db`UPDATE email_outbox SET state='cancelled',payload=null,lease_token=null,lease_until=null WHERE state='pending' AND (request_id IN (SELECT id FROM email_requests WHERE user_id=${userId}) OR recovery_hash IN (SELECT token_hash FROM account_recovery WHERE user_id=${userId}) OR invitation_id IN (SELECT id FROM invitations WHERE invited_by=${userId}) OR request_id IN (SELECT er.id FROM email_requests er JOIN invitations i ON i.id=er.invitation_id WHERE i.invited_by=${userId}))`;
}
async function lockDeliveryIdentity(db: Db, row: MailRow) {
  const [owner] =
    await db`SELECT COALESCE(er.user_id,i.invited_by,recovery.user_id) AS user_id,COALESCE(i.id,er.invitation_id) AS invitation_id FROM email_outbox outbox LEFT JOIN email_requests er ON er.id=outbox.request_id LEFT JOIN invitations i ON i.id=COALESCE(outbox.invitation_id,er.invitation_id) LEFT JOIN account_recovery recovery ON recovery.token_hash=outbox.recovery_hash WHERE outbox.id=${row.id}`;
  if (owner?.userId)
    await db`SELECT id FROM users WHERE id=${owner.userId} FOR NO KEY UPDATE`;
  if (owner?.invitationId)
    await db`SELECT id FROM invitations WHERE id=${owner.invitationId} FOR UPDATE`;
  if (row.requestId)
    await db`SELECT id FROM email_requests WHERE id=${row.requestId} FOR UPDATE`;
  if (row.recoveryHash)
    await db`SELECT token_hash FROM account_recovery WHERE token_hash=${row.recoveryHash} FOR UPDATE`;
}
async function eligible(db: Db, row: MailRow) {
  if (row.invitationId) {
    const [i] =
      await db`SELECT i.email FROM invitations i JOIN users u ON u.id=i.invited_by WHERE i.id=${row.invitationId} AND i.expires_at>clock_timestamp() AND i.accepted_at IS NULL AND i.revoked_at IS NULL AND u.disabled_at IS NULL AND u.role='admin'`;
    return i?.email ?? null;
  }
  if (row.recoveryHash) {
    const [r] =
      await db`SELECT u.email FROM account_recovery r JOIN users u ON u.id=r.user_id WHERE r.token_hash=${row.recoveryHash} AND r.expires_at>clock_timestamp() AND r.security_epoch=u.security_epoch AND u.disabled_at IS NULL`;
    return r?.email ?? null;
  }
  const [r] =
    await db`SELECT er.*,u.email AS current_email,u.email_verified,u.security_epoch AS current_epoch,u.disabled_at,i.revoked_at,i.accepted_at,i.expires_at AS invitation_expiry,inviter.role AS inviter_role,inviter.disabled_at AS inviter_disabled,inviter.security_epoch AS inviter_epoch FROM email_requests er LEFT JOIN users u ON u.id=er.user_id LEFT JOIN invitations i ON i.id=er.invitation_id LEFT JOIN users inviter ON inviter.id=i.invited_by WHERE er.id=${row.requestId} AND er.expires_at>clock_timestamp() AND er.consumed_at IS NULL`;
  if (!r) return null;
  if (r.purpose === "invitation")
    return r.codeHash &&
      r.inviterRole === "admin" &&
      !r.inviterDisabled &&
      r.inviterEpoch === r.securityEpoch &&
      !r.revokedAt &&
      !r.acceptedAt &&
      new Date(r.invitationExpiry).getTime() > Date.now()
      ? r.email
      : null;
  if (r.disabledAt || r.currentEpoch !== r.securityEpoch) return null;
  return r.purpose === "verification"
    ? r.currentEmail === r.email && !r.emailVerified
      ? r.email
      : null
    : r.currentEmail === r.previousEmail
      ? r.email
      : null;
}
export async function sendSmtpMessage(message: Message, deadlineMs = 30000) {
  if (!Number.isInteger(deadlineMs) || deadlineMs < 1 || deadlineMs > 30000)
    throw new RangeError("SMTP deadline must be bounded");
  const socket = new Socket();
  socket.on("error", () => {});
  const c = config(),
    loopback = ["localhost", "127.0.0.1", "::1"].includes(c.MILL_SMTP_HOST);
  const transport = nodemailer.createTransport({
    socket,
    host: c.MILL_SMTP_HOST,
    port: c.MILL_SMTP_PORT,
    secure: c.MILL_SMTP_SECURE,
    requireTLS: !loopback && !c.MILL_SMTP_SECURE,
    auth: c.MILL_SMTP_USER
      ? { user: c.MILL_SMTP_USER, pass: c.MILL_SMTP_PASSWORD }
      : undefined,
    connectionTimeout: 10000,
    greetingTimeout: 10000,
    socketTimeout: 15000,
    dnsTimeout: 10000,
    logger: false,
    debug: false,
    disableFileAccess: true,
    disableUrlAccess: true,
    tls: { rejectUnauthorized: true, minVersion: "TLSv1.2" },
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const deadline = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        socket.destroy();
        reject(new Error("SMTP deadline exceeded"));
      }, deadlineMs);
    });
    const result = await Promise.race([
      transport.sendMail({
        from: c.MILL_SMTP_FROM,
        ...message,
      }),
      deadline,
    ]);
    if (result.rejected?.length || !result.accepted?.length)
      throw new Error("SMTP rejected recipient");
  } finally {
    clearTimeout(timer);
    socket.destroy();
    transport.close();
  }
}
export async function deliverEmailBatch(
  send: (message: Message) => Promise<void> = sendSmtpMessage,
  shouldContinue: () => boolean = () => true,
) {
  await sql`UPDATE email_outbox SET state='cancelled',payload=null,lease_token=null,lease_until=null WHERE state='pending' AND expires_at<=now()`;
  await sql`UPDATE email_requests SET consumed_at=COALESCE(consumed_at,now()),token_hash=null,code_hash=null,proof_hash=null WHERE expires_at<=now() AND (token_hash IS NOT NULL OR code_hash IS NOT NULL OR proof_hash IS NOT NULL)`;
  if (!emailDeliveryConfigured()) return 0;
  let processed = 0;
  for (let n = 0; n < 10 && shouldContinue(); n++) {
    const lease = randomUUID();
    const row = await sql.begin(async (tx) => {
      await tx`UPDATE email_outbox SET state='cancelled',payload=null,lease_token=null,lease_until=null WHERE state='pending' AND expires_at<=now()`;
      await tx`UPDATE email_outbox SET state='failed',payload=null,lease_token=null,lease_until=null,last_error='attempt_limit' WHERE state='pending' AND attempts>=5 AND (lease_until IS NULL OR lease_until<=now())`;
      const [candidate] =
        await tx`SELECT id FROM email_outbox WHERE state='pending' AND available_at<=now() AND expires_at>clock_timestamp() AND attempts<5 AND (lease_until IS NULL OR lease_until<=now()) ORDER BY created_at,id FOR UPDATE SKIP LOCKED LIMIT 1`;
      if (!candidate || !shouldContinue()) return null;
      const [claimed] = await tx<
        MailRow[]
      >`UPDATE email_outbox SET attempts=attempts+1,lease_token=${lease},lease_until=now()+interval '120 seconds' WHERE id=${candidate.id} RETURNING *`;
      return claimed;
    });
    if (!row) break;
    processed++;
    let sending: Promise<void> | undefined;
    try {
      // Lock order matches identity mutations: user, invitation, request/recovery, then outbox.
      await sql.begin(async (tx) => {
        await lockDeliveryIdentity(tx, row);
        const [owned] =
          await tx`SELECT id FROM email_outbox WHERE id=${row.id} AND state='pending' AND lease_token=${lease} AND lease_until>clock_timestamp() AND expires_at>clock_timestamp() FOR UPDATE`;
        if (!owned) return;
        const email = await eligible(tx, row);
        if (!email) {
          await tx`UPDATE email_outbox SET state='cancelled',payload=null,lease_token=null,lease_until=null WHERE id=${row.id}`;
          return;
        }
        const message = decrypt(row.id, row.payload);
        if (message.to !== email) throw new Error("Invalid recipient binding");
        if (!shouldContinue()) {
          await tx`UPDATE email_outbox SET attempts=attempts-1,lease_token=null,lease_until=null WHERE id=${row.id} AND state='pending' AND lease_token=${lease}`;
          return;
        }
        // Initiation is serialized with cancellation; no database lock survives the network wait.
        sending = send(message);
        void sending.catch(() => {});
      });
      if (!sending) continue;
      await sending;
      await sql`UPDATE email_outbox SET state='delivered',delivered_at=now(),payload=null,lease_token=null,lease_until=null,last_error=null WHERE id=${row.id} AND state='pending' AND lease_token=${lease}`;
    } catch {
      await sql`UPDATE email_outbox SET state=${row.attempts >= 5 ? "failed" : "pending"},payload=CASE WHEN attempts>=5 THEN null ELSE payload END,available_at=now()+${Math.min(3600, 30 * 2 ** (row.attempts - 1))}*interval '1 second',lease_token=null,lease_until=null,last_error='delivery_failed' WHERE id=${row.id} AND state='pending' AND lease_token=${lease}`;
    }
  }
  return processed;
}
export function startEmailWorker(
  send: (message: Message) => Promise<void> = sendSmtpMessage,
) {
  let stopped = false,
    running: Promise<unknown> | null = null;
  const tick = () => {
    if (!stopped && !running) {
      running = deliverEmailBatch(send, () => !stopped)
        .catch(() => console.error("Identity email worker failed"))
        .finally(() => {
          running = null;
        });
    }
  };
  const timer = setInterval(tick, 5000);
  timer.unref();
  tick();
  return async () => {
    stopped = true;
    clearInterval(timer);
    await running;
  };
}

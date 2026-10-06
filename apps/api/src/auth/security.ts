import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  scrypt as scryptCallback,
  timingSafeEqual,
} from "node:crypto";
import type { TransactionSql } from "postgres";
import { sql } from "../../../../packages/database/src/index.js";
import { config } from "../config.js";
import { HttpError } from "../http.js";
import { runPasswordOperation } from "./password.js";

function derivePassword(password: string, salt: string, legacy = false) {
  return runPasswordOperation(
    () =>
      new Promise<Buffer>((resolve, reject) =>
        scryptCallback(
          password,
          salt,
          64,
          {
            N: legacy ? 16384 : 32768,
            r: 8,
            p: legacy ? 1 : 3,
            maxmem: 64 * 1024 * 1024,
          },
          (error, key) => (error ? reject(error) : resolve(key)),
        ),
      ),
  );
}
export const secretToken = () => randomBytes(32).toString("base64url");
export const hashToken = (value: string) =>
  createHash("sha256").update(value).digest("hex");
export function appOrigin() {
  return new URL(config().MILL_BASE_URL).origin;
}
export function rpId() {
  return new URL(appOrigin()).hostname;
}

export async function hashPassword(password: string) {
  const salt = randomBytes(16).toString("hex");
  const derived = await derivePassword(password, salt);
  return `scrypt:32768:8:3:${salt}:${derived.toString("hex")}`;
}
export async function verifyPassword(password: string, stored: string) {
  const parts = stored.split(":");
  const legacy = parts.length === 3 && parts[0] === "scrypt";
  const salt = legacy ? parts[1] : parts[4];
  const encoded = legacy ? parts[2] : parts[5];
  if (
    (!legacy && parts.slice(0, 4).join(":") !== "scrypt:32768:8:3") ||
    !/^[a-f0-9]{32}$/.test(salt ?? "") ||
    !/^[a-f0-9]{128}$/.test(encoded ?? "")
  ) {
    await derivePassword(password, "invalid-password-salt");
    return false;
  }
  const actual = await derivePassword(password, salt, legacy);
  const expected = Buffer.from(encoded, "hex");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
function encryptionKey() {
  const secret = config().MILL_SECRET;
  return createHash("sha256").update(secret).digest();
}
export function encrypt(value: string) {
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", encryptionKey(), nonce);
  const encrypted = Buffer.concat([
    cipher.update(value, "utf8"),
    cipher.final(),
  ]);
  return [nonce, cipher.getAuthTag(), encrypted]
    .map((v) => v.toString("base64url"))
    .join(".");
}
export function decrypt(value: string) {
  const [nonce, tag, encrypted] = value
    .split(".")
    .map((v) => Buffer.from(v, "base64url"));
  const cipher = createDecipheriv("aes-256-gcm", encryptionKey(), nonce);
  cipher.setAuthTag(tag);
  return Buffer.concat([cipher.update(encrypted), cipher.final()]).toString(
    "utf8",
  );
}
export async function rateLimit(
  key: string,
  limit: number,
  windowSeconds = 900,
) {
  if (
    !Number.isInteger(limit) ||
    limit < 1 ||
    !Number.isInteger(windowSeconds) ||
    windowSeconds < 1 ||
    windowSeconds > 86400
  )
    throw new RangeError(
      "Authentication limits require a positive count and a window no longer than one day",
    );
  await sql`DELETE FROM auth_rate_limits WHERE window_start < now()-interval '2 days'`;
  const [bucket] = await sql`
    INSERT INTO auth_rate_limits(key, attempts, window_start) VALUES (${hashToken(key)}, 1, now())
    ON CONFLICT(key) DO UPDATE SET
      attempts = CASE WHEN auth_rate_limits.window_start < now() - ${windowSeconds} * interval '1 second' THEN 1 ELSE auth_rate_limits.attempts + 1 END,
      window_start = CASE WHEN auth_rate_limits.window_start < now() - ${windowSeconds} * interval '1 second' THEN now() ELSE auth_rate_limits.window_start END
    RETURNING attempts, greatest(1,ceil(extract(epoch FROM (window_start + ${windowSeconds} * interval '1 second' - now()))))::int AS retry_after`;
  if (bucket.attempts > limit)
    throw new HttpError(
      429,
      "AUTH_RATE_LIMITED",
      "Too many attempts. Try again later.",
      { "Retry-After": String(bucket.retryAfter) },
    );
}
export async function clearAuthRateLimit(
  key: string,
  db: typeof sql | TransactionSql = sql,
) {
  await db`DELETE FROM auth_rate_limits WHERE key=${hashToken(key)}`;
}

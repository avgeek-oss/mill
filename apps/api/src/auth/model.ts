import { randomUUID } from "node:crypto";
import { getCookie, setCookie, deleteCookie } from "hono/cookie";
import type { Context } from "hono";
import { HTTPException } from "hono/http-exception";
import type postgres from "postgres";
import { z } from "zod";
import { sql } from "../../../../packages/database/src/index.js";
import type { Actor, Role } from "../../../../packages/contracts/src/index.js";
import { actor, HttpError, type Env } from "../http.js";
import { appOrigin, hashToken, secretToken } from "./security.js";

export type Db = typeof sql | postgres.TransactionSql;
export type UserRow = {
  id: string;
  workspaceId: string;
  name: string;
  email: string;
  role: Role;
  passwordHash: string;
  securityEpoch: number;
  timeZone: string;
  dateFormat:
    | "day-short-month-year"
    | "day-month-year"
    | "month-day-year"
    | "year-month-day";
  timeFormat: "24-hour" | "12-hour";
  notificationPreferences: { assignments: boolean; mentions: boolean };
  disabledAt: Date | null;
};
export const emailSchema = z.string().trim().toLowerCase().email().max(320);
export const passwordSchema = z
  .string()
  .min(15, "Use at least 15 characters for your password")
  .max(1024);
export const nameSchema = z.string().trim().min(1).max(100);
export const dateFormatSchema = z.enum([
  "day-short-month-year",
  "day-month-year",
  "month-day-year",
  "year-month-day",
]);
export const timeFormatSchema = z.enum(["24-hour", "12-hour"]);
export const timeZoneSchema = z
  .string()
  .min(1)
  .max(100)
  .refine((value) => {
    try {
      new Intl.DateTimeFormat("en", { timeZone: value });
      return true;
    } catch {
      return false;
    }
  }, "Choose a valid time zone");
export const roleSchema = z.enum(["admin", "member", "viewer"]);
export async function body<T extends z.ZodType>(
  c: Context<Env>,
  schema: T,
): Promise<z.output<T>> {
  let data: unknown;
  try {
    data = await c.req.json();
  } catch {
    throw new HttpError(400, "MALFORMED_JSON", "Send a valid JSON body");
  }
  const parsed = schema.safeParse(data);
  if (!parsed.success)
    throw new HttpError(
      400,
      "INVALID_REQUEST",
      parsed.error.issues[0]?.message ?? "Invalid request",
    );
  return parsed.data;
}
export function human(c: Context<Env>) {
  const value = actor(c);
  if (value.kind !== "human" || value.credentialId)
    throw new HTTPException(403, {
      message: "Use a signed-in account for this action",
    });
  return value;
}
export function admin(c: Context<Env>) {
  const value = human(c);
  if (value.role !== "admin")
    throw new HTTPException(403, {
      message: "Only administrators can manage the team",
    });
  return value;
}
export async function activeUser(userId: string, db: Db = sql) {
  const [user] = await db<
    UserRow[]
  >`SELECT * FROM users WHERE id = ${userId} AND disabled_at IS NULL`;
  if (!user) throw new HTTPException(401, { message: "Sign in to continue" });
  return user;
}
export function inAppPreferences(
  preferences: UserRow["notificationPreferences"],
) {
  return {
    assignments: preferences.assignments !== false,
    mentions: preferences.mentions !== false,
  };
}
export async function userMetadata(user: UserRow, db: Db = sql) {
  const [state] =
    await db`SELECT EXISTS(SELECT 1 FROM authenticators WHERE user_id=${user.id} AND verified) AS totp_enabled,
    (SELECT count(*)::int FROM passkeys WHERE user_id=${user.id}) AS passkey_count`;
  return {
    id: user.id,
    name: user.name,
    email: user.email,
    role: user.role,
    timeZone: user.timeZone,
    dateFormat: user.dateFormat,
    timeFormat: user.timeFormat,
    notificationPreferences: inAppPreferences(user.notificationPreferences),
    totpEnabled: state.totpEnabled,
    passkeyCount: state.passkeyCount,
  };
}
export async function identityResponse(user: UserRow, db: Db = sql) {
  const [workspace] =
    await db`SELECT id,name,created_at FROM workspace WHERE id=${user.workspaceId}`;
  return { user: await userMetadata(user, db), workspace };
}
export function sessionToken(request: Request) {
  const cookies = request.headers.get("cookie") ?? "";
  const match = cookies.match(
    /(?:^|;\s*)mill_session=([A-Za-z0-9_-]{43})(?:;|$)/,
  );
  return match?.[1] ?? null;
}
export async function currentSession(c: Context<Env>, db: Db = sql) {
  const token = getCookie(c, "mill_session");
  if (!token) throw new HTTPException(401, { message: "Sign in to continue" });
  const [session] =
    await db`SELECT s.* FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=${hashToken(token)} AND s.user_id=${human(c).userId} AND s.expires_at>now() AND u.disabled_at IS NULL AND s.security_epoch=u.security_epoch`;
  if (!session)
    throw new HTTPException(401, {
      message: "Your session expired. Sign in again.",
    });
  return session;
}
export async function recentSession(c: Context<Env>) {
  const session = await currentSession(c);
  if (new Date(session.authenticatedAt).getTime() < Date.now() - 600_000)
    throw new HttpError(
      403,
      "REAUTHENTICATION_REQUIRED",
      "Verify your identity again before changing security settings",
    );
  return session;
}
export function cookieOptions() {
  return {
    httpOnly: true,
    secure: appOrigin().startsWith("https:"),
    sameSite: "Lax" as const,
    path: "/",
  };
}
export async function newSession(
  c: Context<Env>,
  userId: string,
  db: Db = sql,
  expectedEpoch?: number,
) {
  const token = secretToken();
  const user = await activeUser(userId, db);
  if (expectedEpoch !== undefined && user.securityEpoch !== expectedEpoch)
    throw new HTTPException(401, {
      message: "Your account security changed. Sign in again.",
    });
  await db`INSERT INTO sessions(id,user_id,token_hash,user_agent,expires_at,security_epoch)
    VALUES (${randomUUID()},${userId},${hashToken(token)},${(c.req.header("user-agent") ?? "Unknown device").slice(0, 300)},now()+interval '7 days',${expectedEpoch ?? user.securityEpoch})`;
  setCookie(c, "mill_session", token, { ...cookieOptions(), maxAge: 604800 });
}
export function clearSession(c: Context<Env>) {
  deleteCookie(c, "mill_session", cookieOptions());
}
export async function invalidateSecurity(
  userId: string,
  sessionId: string,
  db: Db,
) {
  const [user] =
    await db`UPDATE users SET security_epoch=security_epoch+1,updated_at=now() WHERE id=${userId} RETURNING security_epoch`;
  await db`UPDATE sessions SET security_epoch=${user.securityEpoch},authenticated_at=now() WHERE id=${sessionId} AND user_id=${userId}`;
  await db`DELETE FROM sessions WHERE user_id=${userId} AND id<>${sessionId}`;
  await db`DELETE FROM auth_challenges WHERE user_id=${userId}`;
}

export async function createChallenge(
  userId: string | null,
  purpose: string,
  sessionId: string | null = null,
  challenge: string | null = null,
  db: Db = sql,
) {
  const token = secretToken();
  await db`DELETE FROM auth_challenges WHERE expires_at < now()`;
  const epoch = userId ? (await activeUser(userId, db)).securityEpoch : null;
  await db`INSERT INTO auth_challenges(token_hash,user_id,purpose,session_id,challenge,expires_at,security_epoch)
    VALUES (${hashToken(token)},${userId},${purpose},${sessionId},${challenge},now()+interval '5 minutes',${epoch})`;
  return token;
}
export async function sessionActor(request: Request): Promise<Actor | null> {
  const token = sessionToken(request);
  if (!token) return null;
  const [user] =
    await sql`SELECT u.id,u.name,u.role,s.id AS session_id FROM sessions s JOIN users u ON u.id=s.user_id
    WHERE s.token_hash=${hashToken(token)} AND s.expires_at>now() AND u.disabled_at IS NULL AND s.security_epoch=u.security_epoch`;
  if (!user) return null;
  await sql`UPDATE sessions SET last_seen_at=now() WHERE id=${user.sessionId} AND last_seen_at<now()-interval '5 minutes'`;
  return {
    userId: user.id,
    name: user.name,
    role: user.role,
    kind: "human",
    scopes: ["read", "write"],
  };
}

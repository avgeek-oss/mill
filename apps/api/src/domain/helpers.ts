import { createHash, randomUUID } from "node:crypto";
import type postgres from "postgres";
import { HTTPException } from "hono/http-exception";
import type { Context } from "hono";
import { z } from "zod";
import { sql } from "../../../../packages/database/src/index.js";
import type {
  Actor,
  Board,
  Task,
} from "../../../../packages/contracts/src/index.js";
import { TASK_STATUSES } from "../../../../packages/contracts/src/index.js";
import { badRequest, conflict, requireRole, type Env } from "../http.js";
import { sessionToken } from "../auth/model.js";
import { hashToken } from "../auth/security.js";

export type Tx = postgres.TransactionSql;
export type BoardRow = Board & { workspaceId: string; nextNumber: number };
export type TaskRow = Task & { createdBy: string };
export const uuid = z.uuid();
export const version = z.number().int().positive();
export const priorities = ["none", "low", "medium", "high", "urgent"] as const;
export const checklist = z
  .array(
    z
      .object({
        id: z.string().min(1).max(100),
        text: z.string().trim().min(1).max(500),
        done: z.boolean(),
      })
      .strict(),
  )
  .max(100)
  .refine(
    (items) => new Set(items.map((i) => i.id)).size === items.length,
    "Checklist IDs must be unique",
  );
export const taskFields = {
  title: z.string().trim().min(1).max(300),
  description: z.string().max(100000),
  assigneeId: uuid.nullable(),
  priority: z.enum(priorities),
  status: z.enum(TASK_STATUSES),
  dueDate: z.iso.date().nullable(),
  checklist,
};
export async function body<T>(
  c: Context<Env>,
  schema: z.ZodType<T>,
): Promise<T> {
  let input: unknown;
  try {
    input = await c.req.json();
  } catch {
    badRequest("Send a valid JSON body");
  }
  const result = schema.safeParse(input);
  if (!result.success)
    badRequest(
      result.error.issues
        .map((i) => `${i.path.join(".") || "Request"}: ${i.message}`)
        .join("; "),
    );
  return result.data;
}
export function id(input: string | undefined): string {
  const result = uuid.safeParse(input);
  if (!result.success) badRequest("Use a valid item ID");
  return result.data;
}
export function missing(message: string): never {
  throw new HTTPException(404, { message });
}
export function assertVersion(row: { version: number }, expected: number) {
  if (row.version !== expected) conflict();
}
export async function board(
  c: Context<Env>,
  boardId: string,
  min: "viewer" | "member" | "admin" = "viewer",
  tx?: Tx,
): Promise<BoardRow> {
  requireRole(c, min, boardId);
  const db = tx ?? sql;
  const [row] = await db<BoardRow[]>`SELECT * FROM boards WHERE id=${boardId}`;
  if (!row) missing("Board not found");
  return row;
}
export async function revalidateAuthority(
  c: Context<Env>,
  tx: Tx,
  min: "viewer" | "member" | "admin",
  boardId?: string,
) {
  const existing = requireRole(c, min, boardId);
  const [member] = await tx<
    { role: Actor["role"]; name: string; securityEpoch: number }[]
  >`SELECT role,name,security_epoch FROM users WHERE id=${existing.userId} AND disabled_at IS NULL FOR SHARE`;
  if (!member)
    throw new HTTPException(401, {
      message: "Your membership changed. Sign in again.",
    });
  if (existing.kind === "agent") {
    const [credential] = await tx<
      { scopes: string[]; boardIds: string[] | null }[]
    >`SELECT scopes,board_ids FROM credentials WHERE id=${existing.credentialId!} AND user_id=${existing.userId} AND revoked_at IS NULL AND expires_at>now() FOR SHARE`;
    if (!credential)
      throw new HTTPException(401, {
        message: "This credential expired or was revoked",
      });
    c.set("actor", {
      ...existing,
      role: member.role,
      scopes: credential.scopes,
      boardIds: credential.boardIds ?? undefined,
    });
  } else {
    const token = sessionToken(c.req.raw);
    const [session] = token
      ? await tx`SELECT id FROM sessions WHERE token_hash=${hashToken(token)} AND user_id=${existing.userId} AND expires_at>now() AND security_epoch=${member.securityEpoch} FOR SHARE`
      : [];
    if (!session)
      throw new HTTPException(401, {
        message: "Your session expired. Sign in again.",
      });
    c.set("actor", { ...existing, name: member.name, role: member.role });
  }
  return requireRole(c, min, boardId);
}
export async function lockBoard(
  c: Context<Env>,
  tx: Tx,
  boardId: string,
  min: "member" | "admin" = "member",
): Promise<BoardRow> {
  requireRole(c, min, boardId);
  const [row] = await tx<
    BoardRow[]
  >`SELECT * FROM boards WHERE id=${boardId} FOR UPDATE`;
  if (!row) missing("Board not found");
  await revalidateAuthority(c, tx, min, boardId);
  return row;
}
export async function task(
  c: Context<Env>,
  taskId: string,
  min: "viewer" | "member" = "viewer",
  tx?: Tx,
): Promise<TaskRow> {
  requireRole(c, min);
  const db = tx ?? sql;
  const [row] = await db<TaskRow[]>`SELECT * FROM tasks WHERE id=${taskId}`;
  if (!row) missing("Task not found");
  await board(c, row.boardId, min, tx);
  return row;
}
export async function lockedTask(
  c: Context<Env>,
  tx: Tx,
  taskId: string,
  expected: number,
): Promise<TaskRow> {
  const original = await task(c, taskId, "member", tx);
  await lockBoard(c, tx, original.boardId);
  const [row] = await tx<
    TaskRow[]
  >`SELECT * FROM tasks WHERE id=${taskId} FOR UPDATE`;
  if (!row) missing("Task not found");
  assertVersion(row, expected);
  return row;
}
export async function recordActivity(
  tx: Tx,
  a: Actor,
  action: string,
  detail: unknown,
  boardId: string,
  taskId: string,
) {
  await tx`INSERT INTO activity (actor_id,actor_name,actor_kind,action,detail,board_id,task_id) VALUES (${a.userId},${a.name},${a.kind},${action},${tx.json(detail as postgres.JSONValue)},${boardId},${taskId})`;
}
export async function validateAssignee(tx: Tx, assigneeId?: string | null) {
  if (!assigneeId) return;
  const [member] =
    await tx`SELECT id FROM users WHERE id=${assigneeId} AND disabled_at IS NULL`;
  if (!member) badRequest("Choose an active workspace member");
}
export async function notify(
  tx: Tx,
  a: Actor,
  taskId: string,
  userId: string,
  kind: "assignment" | "mention",
) {
  if (userId === a.userId) return;
  const [user] = await tx<
    { notificationPreferences: { assignments?: boolean; mentions?: boolean } }[]
  >`SELECT notification_preferences FROM users WHERE id=${userId} AND disabled_at IS NULL`;
  if (
    !user ||
    user.notificationPreferences[
      kind === "assignment" ? "assignments" : "mentions"
    ] === false
  )
    return;
  await tx`INSERT INTO notifications (user_id,task_id,kind,actor_name) VALUES (${userId},${taskId},${kind},${a.name})`;
}
export async function mentionNotifications(
  tx: Tx,
  a: Actor,
  taskId: string,
  text: string,
  explicitIds: string[] = [],
  previous = "",
) {
  const users = await tx<
    { id: string; email: string }[]
  >`SELECT id,email FROM users WHERE disabled_at IS NULL`;
  for (const user of users) {
    const token = `user:${user.id}`;
    const emailToken = `@${user.email}`;
    if (
      explicitIds.includes(user.id) ||
      ((text.includes(token) || text.toLowerCase().includes(emailToken)) &&
        !previous.includes(token) &&
        !previous.toLowerCase().includes(emailToken))
    )
      await notify(tx, a, taskId, user.id, "mention");
  }
  if (explicitIds.some((i) => !users.some((u) => u.id === i)))
    badRequest("Mention an active workspace member");
}
export function pagination(c: Context<Env>, fallback = 50) {
  const raw = c.req.query("limit");
  const value = raw === undefined ? fallback : Number(raw);
  if (!Number.isInteger(value) || value < 1 || value > 100)
    badRequest("Limit must be between 1 and 100");
  return value;
}
export function boolQuery(c: Context<Env>, name: string) {
  const raw = c.req.query(name);
  if (raw === undefined) return false;
  if (raw !== "true" && raw !== "false")
    badRequest(`${name} must be true or false`);
  return raw === "true";
}
export function fingerprint(value: unknown) {
  return createHash("sha256")
    .update(JSON.stringify(value))
    .digest("hex")
    .slice(0, 24);
}
export function encodeCursor(value: unknown) {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}
export function decodeCursor(
  raw: string | undefined,
  schema: z.ZodType<{
    key: string;
    id: string;
    fingerprint: string;
    revision: string;
  }>,
) {
  if (raw === undefined) return null;
  if (raw.length > 1000) badRequest("Invalid cursor");
  try {
    return schema.parse(JSON.parse(Buffer.from(raw, "base64url").toString()));
  } catch {
    badRequest("Invalid cursor");
  }
}
export const cursorSchema = z
  .object({
    key: z.string().max(400),
    id: uuid,
    fingerprint: z.string().length(24),
    revision: z.string().regex(/^[a-f0-9]{32}$/),
  })
  .strict();
export function newId() {
  return randomUUID();
}

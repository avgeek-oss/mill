import { randomUUID } from "node:crypto";
import { Hono } from "hono";
import { z } from "zod";
import { sql } from "../../../../packages/database/src/index.js";
import {
  ATTACHMENT_CONTENT_TYPES,
  MAX_ATTACHMENT_BYTES,
  type Attachment,
} from "../../../../packages/contracts/src/index.js";
import { HttpError, badRequest, requireRole, type Env } from "../http.js";
import {
  body,
  boolQuery,
  id,
  task,
  lockBoard,
  revalidateAuthority,
  recordActivity,
  pagination,
  missing,
} from "../domain/helpers.js";
import {
  attachmentStorage,
  requireAttachmentStorage,
  URL_LIFETIME_SECONDS,
  type StoredAttachment,
} from "./storage.js";

export const attachmentUploadSchema = z
  .object({
    fileName: z
      .string()
      .trim()
      .min(1)
      .max(255)
      .refine(
        (name) => !/[\p{Cc}/\\]/u.test(name),
        "Use a file name without paths or control characters",
      ),
    contentType: z.enum(ATTACHMENT_CONTENT_TYPES),
    sizeBytes: z.number().int().min(1).max(MAX_ATTACHMENT_BYTES),
    sha256: z
      .string()
      .regex(/^[A-Fa-f0-9]{64}$/)
      .optional(),
  })
  .strict();
export function attachmentMetadata(row: StoredAttachment): Attachment {
  return {
    id: row.id,
    taskId: row.taskId,
    fileName: row.fileName,
    contentType: row.contentType,
    sizeBytes: row.sizeBytes,
    createdBy: row.createdBy,
    createdAt: new Date(row.createdAt).toISOString(),
  };
}
export const attachmentRoutes = new Hono<Env>();
attachmentRoutes.get("/attachments/config", (c) => {
  requireRole(c);
  return c.json({
    enabled: Boolean(attachmentStorage()),
    maxBytes: MAX_ATTACHMENT_BYTES,
    contentTypes: ATTACHMENT_CONTENT_TYPES,
  });
});
attachmentRoutes.post("/tasks/:taskId/attachments/uploads", async (c) => {
  const taskId = id(c.req.param("taskId"));
  const input = await body(c, attachmentUploadSchema);
  const storage = requireAttachmentStorage();
  const upload = await sql.begin(async (tx) => {
    const original = await task(c, taskId, "member", tx);
    await lockBoard(c, tx, original.boardId);
    const [count] =
      await tx`SELECT count(*)::int AS count FROM task_attachments WHERE task_id=${taskId} AND (state='ready' OR upload_expires_at>now())`;
    if (count.count >= 100)
      throw new HttpError(
        409,
        "ATTACHMENT_LIMIT",
        "A task can have at most 100 attachments.",
      );
    const attachmentId = randomUUID();
    const expiresAt = new Date(Date.now() + URL_LIFETIME_SECONDS * 1000);
    const [row] = await tx<
      StoredAttachment[]
    >`INSERT INTO task_attachments(id,task_id,file_name,content_type,size_bytes,sha256,storage_origin,storage_bucket,upload_key,object_key,upload_expires_at,created_by)
      VALUES(${attachmentId},${taskId},${input.fileName},${input.contentType},${input.sizeBytes},${input.sha256?.toLowerCase() ?? null},${storage.origin},${storage.bucket},${`mill/uploads/${attachmentId}`},${`mill/objects/${attachmentId}`},${expiresAt},${c.get("actor").kind === "team" ? null : c.get("actor").userId}) RETURNING *`;
    return storage.upload(row);
  });
  return c.json(upload, 201);
});
attachmentRoutes.post(
  "/tasks/:taskId/attachments/:attachmentId/complete",
  async (c) => {
    const taskId = id(c.req.param("taskId"));
    const attachmentId = id(c.req.param("attachmentId"));
    const storage = requireAttachmentStorage();
    const row = await sql.begin(async (tx) => {
      const original = await task(c, taskId, "member", tx);
      await lockBoard(c, tx, original.boardId);
      const [pending] = await tx<
        StoredAttachment[]
      >`SELECT * FROM task_attachments WHERE id=${attachmentId} AND task_id=${taskId} FOR UPDATE`;
      if (!pending) missing("Attachment not found");
      if (
        pending.state === "pending" &&
        new Date(pending.uploadExpiresAt).getTime() <= Date.now()
      )
        throw new HttpError(
          410,
          "UPLOAD_EXPIRED",
          "This upload expired. Start a new upload.",
        );
      return pending;
    });
    if (row.state === "ready")
      return c.json({ attachment: attachmentMetadata(row) });
    const verifiedKey = `${row.objectKey}/${randomUUID()}`;
    const queueUnusedCopy = () =>
      sql`INSERT INTO attachment_cleanup(storage_origin,storage_bucket,object_key,available_at,recheck_at)
        VALUES(${row.storageOrigin},${row.storageBucket},${verifiedKey},now(),now()+interval '1 day')
        ON CONFLICT(storage_origin,storage_bucket,object_key) DO UPDATE
        SET available_at=now(),recheck_at=now()+interval '1 day'`;
    await sql`INSERT INTO attachment_cleanup(storage_origin,storage_bucket,object_key,available_at,recheck_at)
      VALUES(${row.storageOrigin},${row.storageBucket},${verifiedKey},
        greatest(now()+interval '5 minutes',${row.uploadExpiresAt}::timestamptz+interval '1 minute'),
        now()+interval '1 day')`;
    let attachment: Attachment;
    try {
      await storage.complete(row, verifiedKey);
      attachment = await sql.begin(async (tx) => {
        const original = await task(c, taskId, "member", tx);
        await lockBoard(c, tx, original.boardId);
        const [current] = await tx<
          StoredAttachment[]
        >`SELECT * FROM task_attachments WHERE id=${attachmentId} AND task_id=${taskId} FOR UPDATE`;
        if (!current) missing("Attachment not found");
        const a = await revalidateAuthority(c, tx, "member", original.boardId);
        if (current.state === "ready") {
          await tx`INSERT INTO attachment_cleanup(storage_origin,storage_bucket,object_key,available_at,recheck_at)
            VALUES(${row.storageOrigin},${row.storageBucket},${verifiedKey},now(),now()+interval '1 day')
            ON CONFLICT(storage_origin,storage_bucket,object_key) DO UPDATE
            SET available_at=now(),recheck_at=now()+interval '1 day'`;
          return attachmentMetadata(current);
        }
        if (new Date(current.uploadExpiresAt).getTime() <= Date.now())
          throw new HttpError(
            410,
            "UPLOAD_EXPIRED",
            "This upload expired. Start a new upload.",
          );
        const [cleanup] = await tx<{ objectKey: string }[]>`
          DELETE FROM attachment_cleanup WHERE storage_origin=${row.storageOrigin}
          AND storage_bucket=${row.storageBucket} AND object_key=${verifiedKey}
          RETURNING object_key`;
        if (!cleanup)
          throw new HttpError(
            503,
            "ATTACHMENT_STORAGE_UNAVAILABLE",
            "Attachment storage is unavailable. Please try again.",
          );
        await tx`UPDATE task_attachments SET state='ready',object_key=${verifiedKey} WHERE id=${attachmentId}`;
        await tx`INSERT INTO attachment_cleanup(storage_origin,storage_bucket,object_key,available_at,recheck_at)
          VALUES(${row.storageOrigin},${row.storageBucket},${row.uploadKey},${new Date(new Date(row.uploadExpiresAt).getTime() + 60000)},${new Date(new Date(row.uploadExpiresAt).getTime() + 86400000)}) ON CONFLICT DO NOTHING`;
        await recordActivity(
          tx,
          a,
          "attachment.added",
          { attachmentId, fileName: row.fileName },
          original.boardId,
          taskId,
        );
        return attachmentMetadata(current);
      });
    } catch (error) {
      await queueUnusedCopy();
      throw error;
    }
    return c.json({ attachment });
  },
);
attachmentRoutes.get("/tasks/:taskId/attachments", async (c) => {
  const taskId = id(c.req.param("taskId"));
  await task(c, taskId);
  const limit = pagination(c);
  let cursor: { id: string; createdAt: string; taskId: string } | undefined;
  const raw = c.req.query("cursor");
  if (raw !== undefined) {
    if (raw.length > 500) badRequest("Invalid cursor");
    try {
      cursor = z
        .object({ id: z.uuid(), createdAt: z.iso.datetime(), taskId: z.uuid() })
        .strict()
        .parse(JSON.parse(Buffer.from(raw, "base64url").toString("utf8")));
    } catch {
      badRequest("Invalid cursor");
    }
    if (cursor.taskId !== taskId)
      badRequest("This cursor belongs to a different task");
  }
  const rows = await sql<
    (StoredAttachment & { cursorKey: string })[]
  >`SELECT *,to_char(created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS cursor_key FROM task_attachments WHERE task_id=${taskId} AND state='ready'
    ${cursor ? sql`AND (created_at,id)<(${cursor.createdAt}::text::timestamptz,${cursor.id}::uuid)` : sql``}
    ORDER BY created_at DESC,id DESC LIMIT ${limit + 1}`;
  const hasMore = rows.length > limit;
  const items = rows.slice(0, limit).map(attachmentMetadata);
  const last = rows.slice(0, limit).at(-1);
  return c.json({
    items,
    hasMore,
    nextCursor:
      hasMore && last
        ? Buffer.from(
            JSON.stringify({ id: last.id, createdAt: last.cursorKey, taskId }),
          ).toString("base64url")
        : null,
  });
});
attachmentRoutes.get(
  "/tasks/:taskId/attachments/:attachmentId/download",
  async (c) => {
    const taskId = id(c.req.param("taskId"));
    const attachmentId = id(c.req.param("attachmentId"));
    await task(c, taskId);
    const [row] = await sql<
      StoredAttachment[]
    >`SELECT * FROM task_attachments WHERE id=${attachmentId} AND task_id=${taskId} AND state='ready'`;
    if (!row) missing("Attachment not found");
    return c.json(
      await requireAttachmentStorage().download(row, boolQuery(c, "preview")),
    );
  },
);
attachmentRoutes.delete(
  "/tasks/:taskId/attachments/:attachmentId",
  async (c) => {
    const taskId = id(c.req.param("taskId"));
    const attachmentId = id(c.req.param("attachmentId"));
    await sql.begin(async (tx) => {
      const original = await task(c, taskId, "member", tx);
      await lockBoard(c, tx, original.boardId);
      const [row] = await tx<
        StoredAttachment[]
      >`DELETE FROM task_attachments WHERE id=${attachmentId} AND task_id=${taskId} RETURNING *`;
      if (!row) missing("Attachment not found");
      await tx`UPDATE api_idempotency SET response=null,invalidation_reason='deleted' WHERE ${attachmentId}::uuid=ANY(attachment_ids)`;
      if (row.state === "ready")
        await recordActivity(
          tx,
          c.get("actor"),
          "attachment.deleted",
          { attachmentId, fileName: row.fileName },
          original.boardId,
          taskId,
        );
    });
    return c.json({ ok: true });
  },
);

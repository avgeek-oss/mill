import { Hono } from "hono";
import { z } from "zod";
import { sql } from "../../../packages/database/src/index.js";
import type {
  Actor,
  Activity,
  Comment,
} from "../../../packages/contracts/src/index.js";
import { TASK_STATUSES } from "../../../packages/contracts/src/index.js";
import { actor, badRequest, conflict, requireRole, type Env } from "./http.js";
import {
  assertVersion,
  board,
  body,
  boolQuery,
  cursorSchema,
  decodeCursor,
  encodeCursor,
  fingerprint,
  id,
  lockBoard,
  lockedTask,
  mentionNotifications,
  missing,
  notify,
  pagination,
  priorities,
  recordActivity,
  revalidateAuthority,
  task,
  taskFields,
  uuid,
  version,
  validateAssignee,
  type TaskRow,
} from "./domain/helpers.js";

import { agentRoutes, validateTaskAgent } from "./agents.js";

export const domainRoutes = new Hono<Env>();
domainRoutes.route("/", agentRoutes);
const boardCreate = z
  .object({
    name: z.string().trim().min(1).max(100),
    prefix: z
      .string()
      .trim()
      .toUpperCase()
      .regex(/^[A-Z][A-Z0-9]{1,9}$/)
      .optional(),
    description: z.string().max(10000).default(""),
  })
  .strict();
const boardPatch = boardCreate.partial().extend({ version }).strict();
const taskCreate = z
  .object(taskFields)
  .partial()
  .extend({ title: taskFields.title })
  .strict();
const taskPatch = z.object(taskFields).partial().extend({ version }).strict();
const commentCreate = z
  .object({
    body: z.string().trim().min(1).max(10000),
    mentionIds: z.array(uuid).max(50).default([]),
  })
  .strict();
function previewLimit(c: Parameters<typeof actor>[0], name: string) {
  const raw = c.req.query(name);
  const value = raw === undefined ? 100 : Number(raw);
  if (!Number.isInteger(value) || value < 0 || value > 100)
    badRequest(`${name} must be between 0 and 100`);
  return value;
}

function previewPage<T extends { id: string }>(rows: T[], limit: number) {
  const items = rows.slice(0, limit);
  const hasMore = rows.length > limit;
  return {
    items,
    page: { hasMore, nextCursor: hasMore ? (items.at(-1)?.id ?? null) : null },
  };
}

function administrative(c: Parameters<typeof actor>[0], write = false): Actor {
  const a = requireRole(c, "admin");
  if (a.kind === "agent" || (write && !a.scopes.includes("write")))
    badRequest("This action requires a workspace administrator session");
  return a;
}

const boardListCursor = z
  .object({
    id: uuid,
    name: z.string().min(1).max(100),
    revision: z.string().regex(/^[a-f0-9]{32}$/),
    filter: z.string().regex(/^[a-f0-9]{24}$/),
  })
  .strict();

domainRoutes.get("/boards", async (c) => {
  const a = requireRole(c);
  const directory = boolQuery(c, "directory");
  if (
    c.req.query("archived") !== undefined ||
    c.req.query("deleted") !== undefined
  )
    badRequest("Archive and deleted filters are no longer supported");
  const limit = pagination(c, 100);
  const rawCursor = c.req.query("cursor");
  let cursor: z.infer<typeof boardListCursor> | undefined;
  if (rawCursor !== undefined) {
    try {
      if (rawCursor.length > 1000) throw new Error("Invalid cursor");
      cursor = boardListCursor.parse(
        JSON.parse(Buffer.from(rawCursor, "base64url").toString()),
      );
    } catch {
      badRequest("Invalid board cursor");
    }
  }
  const filterKey = fingerprint({
    collection: directory ? "board_directory" : "boards",
    userId: a.userId,
    boardIds: a.boardIds ? [...a.boardIds].sort() : null,
  });
  if (cursor && cursor.filter !== filterKey)
    badRequest("This board cursor does not match the accessible board list");
  const filters = a.boardIds
    ? a.boardIds.length
      ? sql`id IN ${sql(a.boardIds)}`
      : sql`false`
    : sql`true`;
  const revisionFields = sql`id::text||':'||name||':'||version::text`;
  const result = await sql.begin(
    "isolation level repeatable read read only",
    async (tx) => {
      const [order] = await tx<
        { revision: string }[]
      >`SELECT md5(COALESCE(string_agg(${revisionFields},',' ORDER BY lower(name),name,id),'')) AS revision FROM boards WHERE ${filters}`;
      if (cursor && cursor.revision !== order.revision)
        return { stale: true as const };
      const [anchor] = cursor
        ? await tx`SELECT id,name FROM boards WHERE id=${cursor.id} AND ${filters}`
        : [];
      if (cursor && (!anchor || anchor.name !== cursor.name))
        badRequest(
          "This board cursor does not belong to the accessible board list",
        );
      const rows =
        await tx`SELECT * FROM boards WHERE ${filters} ${cursor ? tx`AND (lower(name),name,id)>(lower(${cursor.name}),${cursor.name},${cursor.id}::uuid)` : tx``} ORDER BY lower(name),name,id LIMIT ${limit + 1}`;
      const items = rows.slice(0, limit);
      const hasMore = rows.length > limit;
      const last = items.at(-1);
      return {
        stale: false as const,
        items,
        hasMore,
        nextCursor:
          hasMore && last
            ? encodeCursor({
                id: last.id,
                name: last.name,
                revision: order.revision,
                filter: filterKey,
              })
            : null,
      };
    },
  );
  if (result.stale)
    return c.json(
      {
        error: "Board list changed. Reload boards to continue.",
        code: "board_list_changed",
      },
      409,
    );
  const { stale: _stale, ...page } = result;
  return c.json(page);
});
domainRoutes.post("/boards", async (c) => {
  const a = requireRole(c, "member");
  if (a.boardIds)
    return c.json(
      { error: "A board-restricted credential cannot create boards" },
      403,
    );
  const input = await body(c, boardCreate);
  const result = await sql.begin(async (tx) => {
    const [workspace] = await tx`SELECT id FROM workspace FOR UPDATE`;
    if (!workspace) missing("Complete workspace setup first");
    await revalidateAuthority(c, tx, "member");
    let prefix =
      input.prefix ??
      input.name
        .toUpperCase()
        .replace(/[^A-Z0-9]/g, "")
        .slice(0, 6);
    if (!/^[A-Z][A-Z0-9]{1,9}$/.test(prefix)) prefix = "TASK";
    if (input.prefix) {
      const [existing] = await tx`SELECT id FROM boards WHERE prefix=${prefix}`;
      if (existing) conflict("A board already uses this task prefix");
    } else {
      const base = prefix;
      let suffix = 1;
      while ((await tx`SELECT id FROM boards WHERE prefix=${prefix}`).length)
        prefix = `${base}${++suffix}`;
    }
    const [created] =
      await tx`INSERT INTO boards (workspace_id,name,prefix,description) VALUES (${workspace.id},${input.name},${prefix},${input.description}) RETURNING *`;
    return created;
  });
  return c.json({ board: result }, 201);
});
domainRoutes.get("/boards/:id", async (c) => {
  const row = await board(c, id(c.req.param("id")));
  return c.json({ board: row });
});
domainRoutes.patch("/boards/:id", async (c) => {
  const boardId = id(c.req.param("id"));
  requireRole(c, "member", boardId);
  const input = await body(c, boardPatch);
  const result = await sql.begin(async (tx) => {
    await tx`SELECT id FROM workspace FOR UPDATE`;
    const row = await lockBoard(c, tx, boardId, "member");
    assertVersion(row, input.version);
    if (input.prefix && input.prefix !== row.prefix)
      badRequest("Task prefixes stay fixed so task identifiers remain useful");
    const [updated] =
      await tx`UPDATE boards SET name=${input.name ?? row.name},description=${input.description ?? row.description},version=version+1,updated_at=now() WHERE id=${boardId} RETURNING *`;

    return updated;
  });
  return c.json({ board: result });
});
domainRoutes.delete("/boards/:id", async (c) => {
  const boardId = id(c.req.param("id"));
  administrative(c, true);
  const input = await body(c, z.object({ version }).strict());
  await sql.begin(async (tx) => {
    await tx`SELECT id FROM workspace FOR UPDATE`;
    const row = await lockBoard(c, tx, boardId, "admin");
    assertVersion(row, input.version);
    await tx`DELETE FROM boards WHERE id=${boardId}`;
  });
  return c.json({ ok: true });
});
domainRoutes.get("/boards/:id/tasks", async (c) => {
  const boardId = id(c.req.param("id"));
  await board(c, boardId);
  const limit = pagination(c);
  const cursorRaw = c.req.query("cursor");
  const pageRaw = c.req.query("page");
  const requestedPage = pageRaw === undefined ? 1 : Number(pageRaw);
  if (
    pageRaw !== undefined &&
    (!/^\d+$/.test(pageRaw) ||
      !Number.isSafeInteger(requestedPage) ||
      requestedPage < 1)
  )
    badRequest("Page must be a positive safe integer");
  const requestedRevision = c.req.query("revision");
  if (
    requestedRevision !== undefined &&
    !/^[a-f0-9]{32}$/.test(requestedRevision)
  )
    badRequest("Use a valid task list revision");
  if (
    cursorRaw !== undefined &&
    (pageRaw !== undefined || requestedRevision !== undefined)
  )
    badRequest("Choose cursor pagination or page/revision pagination");
  const q = c.req.query("q")?.trim() ?? "";
  if (q.length > 300) badRequest("Search is limited to 300 characters");
  const status = c.req.query("status");
  if (
    status !== undefined &&
    !TASK_STATUSES.includes(status as (typeof TASK_STATUSES)[number])
  )
    badRequest("Choose a valid status");
  for (const removed of ["columnId", "label", "parentId"])
    if (c.req.query(removed) !== undefined)
      badRequest(`${removed} is no longer supported`);
  const assigneeRaw = c.req.query("assigneeId");
  const assigneeId =
    assigneeRaw && assigneeRaw !== "unassigned" ? id(assigneeRaw) : null;
  const agentRaw = c.req.query("agentId");
  const agentId = agentRaw && agentRaw !== "unassigned" ? id(agentRaw) : null;
  if (agentRaw === "") badRequest("Choose a valid agent");
  const priority = c.req.query("priority");
  if (priority && !priorities.includes(priority as (typeof priorities)[number]))
    badRequest("Choose a valid priority");
  if (
    c.req.query("archived") !== undefined ||
    c.req.query("deleted") !== undefined
  )
    badRequest("Archive and deleted filters are no longer supported");
  const sort = c.req.query("sort") ?? "createdAt";
  const sorts = {
    title: sql`lower(tasks.title)`,
    dueDate: sql`coalesce(to_char(tasks.due_date,'YYYY-MM-DD'),'9999-12-31')`,
    priority: sql`CASE tasks.priority WHEN 'urgent' THEN '0' WHEN 'high' THEN '1' WHEN 'medium' THEN '2' WHEN 'low' THEN '3' ELSE '4' END`,
    status: sql`CASE tasks.status WHEN 'backlog' THEN '0' WHEN 'todo' THEN '1' WHEN 'in_progress' THEN '2' WHEN 'in_review' THEN '3' WHEN 'done' THEN '4' ELSE '5' END`,
    updatedAt: sql`to_char(tasks.updated_at AT TIME ZONE 'UTC','YYYY-MM-DD HH24:MI:SS.US')`,
    createdAt: sql`to_char(tasks.created_at AT TIME ZONE 'UTC','YYYY-MM-DD HH24:MI:SS.US')`,
  };
  if (!Object.hasOwn(sorts, sort)) badRequest("Choose a valid sort order");
  const sortKey = sorts[sort as keyof typeof sorts];
  const descending = sort === "updatedAt" || sort === "createdAt";
  const filterKey = fingerprint({
    boardId,
    q,
    status,
    assigneeRaw,
    agentRaw,
    priority,
    sort,
  });
  const cursor = decodeCursor(cursorRaw, cursorSchema);
  if (cursor && cursor.fingerprint !== filterKey)
    badRequest("This cursor belongs to a different search");
  const filters = sql`tasks.board_id=${boardId}
    ${q ? sql`AND (tasks.title ILIKE ${"%" + q.replace(/[%_\\]/g, "\\$&") + "%"} OR tasks.description ILIKE ${"%" + q.replace(/[%_\\]/g, "\\$&") + "%"} OR tasks.identifier ILIKE ${"%" + q.replace(/[%_\\]/g, "\\$&") + "%"})` : sql``}
    ${status ? sql`AND tasks.status=${status}` : sql``}
    ${assigneeRaw === "unassigned" ? sql`AND tasks.assignee_id IS NULL` : assigneeId ? sql`AND tasks.assignee_id=${assigneeId}` : sql``}
    ${agentRaw === "unassigned" ? sql`AND tasks.agent_id IS NULL` : agentId ? sql`AND tasks.agent_id=${agentId}` : sql``}
    ${priority ? sql`AND tasks.priority=${priority}` : sql``}`;
  const result = await sql.begin(
    "isolation level repeatable read read only",
    async (tx) => {
      await board(c, boardId, "viewer", tx);
      const [collection] = await tx<
        { revision: string; total: number }[]
      >`SELECT md5(COALESCE(string_agg(id::text||':'||version::text,',' ORDER BY id),'')) AS revision,
        count(*) FILTER (WHERE ${filters})::int AS total FROM tasks WHERE board_id=${boardId}`;
      if (
        (cursor && cursor.revision !== collection.revision) ||
        (requestedRevision !== undefined &&
          requestedRevision !== collection.revision)
      )
        return { stale: true as const };
      const pageNumber = Math.min(
        requestedPage,
        Math.max(1, Math.ceil(collection.total / limit)),
      );
      const offset = (pageNumber - 1) * limit;
      if (cursor) {
        const [anchor] = await tx<
          { sortKey: string }[]
        >`SELECT ${sortKey} AS sort_key FROM tasks WHERE ${filters} AND tasks.id=${cursor.id}`;
        if (!anchor || anchor.sortKey !== cursor.key)
          badRequest("This task cursor does not belong to the current search");
      }
      const rows = await tx<
        (TaskRow & { sortKey: string })[]
      >`SELECT tasks.*,agents.name AS agent_name,${sortKey} AS sort_key FROM tasks LEFT JOIN agents ON agents.id=tasks.agent_id WHERE ${filters}
      ${cursor ? (descending ? sql`AND (${sortKey},tasks.id)<(${cursor.key},${cursor.id}::uuid)` : sql`AND (${sortKey},tasks.id)>(${cursor.key},${cursor.id}::uuid)`) : sql``}
      ORDER BY ${sortKey} ${descending ? sql`DESC` : sql`ASC`},tasks.id ${descending ? sql`DESC` : sql`ASC`} LIMIT ${limit + 1}
      ${pageRaw !== undefined ? sql`OFFSET ${offset}` : sql``}`;
      const hasMore = rows.length > limit;
      const page = rows.slice(0, limit);
      const last = page.at(-1);
      return {
        stale: false as const,
        items: page.map(({ sortKey: _sortKey, ...row }) => row),
        total: collection.total,
        revision: collection.revision,
        ...(cursor ? {} : { page: pageNumber }),
        hasMore,
        nextCursor:
          hasMore && last
            ? encodeCursor({
                key: last.sortKey,
                id: last.id,
                fingerprint: filterKey,
                revision: collection.revision,
              })
            : null,
      };
    },
  );
  if (result.stale)
    return c.json(
      {
        error: "Task list changed. Reload tasks to continue.",
        code: "task_list_changed",
      },
      409,
    );
  const { stale: _stale, ...page } = result;
  return c.json(page);
});
domainRoutes.post("/boards/:id/tasks", async (c) => {
  const boardId = id(c.req.param("id"));
  requireRole(c, "member", boardId);
  const input = await body(c, taskCreate);
  const result = await sql.begin(async (tx) => {
    const row = await lockBoard(c, tx, boardId);
    await validateAssignee(tx, input.assigneeId);
    const a = requireRole(c, "member", boardId);
    const selectedAgent = await validateTaskAgent(
      tx,
      a.userId,
      input.agentId ?? null,
      input.assigneeId ?? null,
      true,
    );
    const [created] = await tx<
      TaskRow[]
    >`INSERT INTO tasks (board_id,status,identifier,title,description,assignee_id,agent_id,priority,due_date,created_by) VALUES (${boardId},${input.status ?? "todo"},${row.prefix + "-" + row.nextNumber},${input.title},${input.description ?? ""},${input.assigneeId ?? null},${input.agentId ?? null},${input.priority ?? "none"},${input.dueDate ?? null},${a.userId}) RETURNING *`;
    await tx`UPDATE boards SET next_number=next_number+1 WHERE id=${boardId}`;
    await recordActivity(
      tx,
      a,
      "task.created",
      { title: created.title, identifier: created.identifier },
      boardId,
      created.id,
    );
    if (created.assigneeId)
      await notify(tx, a, created.id, created.assigneeId, "assignment");
    await mentionNotifications(tx, a, created.id, created.description);
    return { ...created, agentName: selectedAgent?.name ?? null };
  });
  return c.json({ task: result }, 201);
});
domainRoutes.get("/tasks/:id", async (c) => {
  const row = await task(c, id(c.req.param("id")));
  const commentLimit = previewLimit(c, "commentLimit");
  const activityLimit = previewLimit(c, "activityLimit");
  if (c.req.query("subtaskLimit") !== undefined)
    badRequest("Subtasks are no longer supported");
  const comments = previewPage(
    await sql<
      Comment[]
    >`SELECT comments.*,users.name AS author_name FROM comments JOIN users ON users.id=comments.author_id WHERE task_id=${row.id} ORDER BY created_at DESC,id DESC LIMIT ${commentLimit + 1}`,
    commentLimit,
  );
  const activity = previewPage(
    await sql<
      Activity[]
    >`SELECT * FROM activity WHERE task_id=${row.id} ORDER BY created_at DESC,id DESC LIMIT ${activityLimit + 1}`,
    activityLimit,
  );
  return c.json({
    task: row,
    comments: comments.items,
    commentsPage: comments.page,
    activity: activity.items,
    activityPage: activity.page,
  });
});
domainRoutes.patch("/tasks/:id", async (c) => {
  const taskId = id(c.req.param("id"));
  const input = await body(c, taskPatch);
  const result = await sql.begin(async (tx) => {
    const row = await lockedTask(c, tx, taskId, input.version);
    const a = requireRole(c, "member", row.boardId);
    await validateAssignee(tx, input.assigneeId);
    const effectiveAssignee =
      input.assigneeId === undefined ? row.assigneeId : input.assigneeId;
    const effectiveAgent =
      input.agentId === undefined ? row.agentId : input.agentId;
    await validateTaskAgent(
      tx,
      a.userId,
      effectiveAgent,
      effectiveAssignee,
      effectiveAgent !== row.agentId || effectiveAssignee !== row.assigneeId,
    );
    await tx`UPDATE tasks SET status=${input.status ?? row.status},title=${input.title ?? row.title},description=${input.description ?? row.description},assignee_id=${input.assigneeId === undefined ? row.assigneeId : input.assigneeId},agent_id=${effectiveAgent},priority=${input.priority ?? row.priority},due_date=${input.dueDate === undefined ? row.dueDate : input.dueDate},version=version+1,updated_at=now() WHERE id=${taskId}`;
    const [updated] = await tx<
      TaskRow[]
    >`SELECT tasks.*,agents.name AS agent_name FROM tasks LEFT JOIN agents ON agents.id=tasks.agent_id WHERE tasks.id=${taskId}`;
    const fields = Object.keys(input).filter(
      (key) => key !== "version" && key !== "status",
    );
    if (fields.length)
      await recordActivity(
        tx,
        a,
        "task.updated",
        { fields },
        row.boardId,
        taskId,
      );
    if (updated.status !== row.status)
      await recordActivity(
        tx,
        a,
        "task.moved",
        { fromStatus: row.status, status: updated.status },
        row.boardId,
        taskId,
      );
    if (updated.assigneeId && updated.assigneeId !== row.assigneeId)
      await notify(tx, a, taskId, updated.assigneeId, "assignment");
    if (input.description !== undefined)
      await mentionNotifications(
        tx,
        a,
        taskId,
        updated.description,
        [],
        row.description,
      );
    return updated;
  });
  return c.json({ task: result });
});
domainRoutes.delete("/tasks/:id", async (c) => {
  const taskId = id(c.req.param("id"));
  const input = await body(c, z.object({ version }).strict());
  await sql.begin(async (tx) => {
    const row = await lockedTask(c, tx, taskId, input.version);
    requireRole(c, "member", row.boardId);
    await tx`DELETE FROM tasks WHERE id=${taskId}`;
  });
  return c.json({ ok: true });
});
domainRoutes.get("/tasks/:id/comments", async (c) => {
  const row = await task(c, id(c.req.param("id")));
  const limit = pagination(c);
  const cursor = c.req.query("cursor") ? id(c.req.query("cursor")) : null;
  const [anchor] = cursor
    ? await sql`SELECT id,created_at FROM comments WHERE id=${cursor} AND task_id=${row.id}`
    : [];
  if (cursor && !anchor)
    badRequest("This comment cursor does not belong to the task");
  const rows =
    await sql`SELECT comments.*,users.name AS author_name FROM comments JOIN users ON users.id=comments.author_id WHERE task_id=${row.id} ${anchor ? sql`AND (comments.created_at,comments.id)<(SELECT created_at,id FROM comments WHERE id=${anchor.id})` : sql``} ORDER BY created_at DESC,id DESC LIMIT ${limit + 1}`;
  const items = rows.slice(0, limit);
  return c.json({
    items,
    hasMore: rows.length > limit,
    nextCursor: rows.length > limit ? items.at(-1)?.id : null,
  });
});
domainRoutes.post("/tasks/:id/comments", async (c) => {
  const taskId = id(c.req.param("id"));
  const input = await body(c, commentCreate);
  const result = await sql.begin(async (tx) => {
    const row = await task(c, taskId, "member", tx);
    await lockBoard(c, tx, row.boardId);
    const [fresh] = await tx<
      TaskRow[]
    >`SELECT tasks.*,agents.name AS agent_name FROM tasks LEFT JOIN agents ON agents.id=tasks.agent_id WHERE tasks.id=${taskId}`;
    if (!fresh) missing("Task not found");
    const a = requireRole(c, "member", row.boardId);
    const [created] =
      await tx`INSERT INTO comments (task_id,author_id,body) VALUES (${taskId},${a.userId},${input.body}) RETURNING *`;
    await mentionNotifications(tx, a, taskId, input.body, input.mentionIds);
    await recordActivity(
      tx,
      a,
      "comment.created",
      { commentId: created.id },
      row.boardId,
      taskId,
    );
    return { ...created, authorName: a.name };
  });
  return c.json({ comment: result }, 201);
});
async function deleteComment(c: Parameters<typeof actor>[0]) {
  requireRole(c, "member");
  const commentId = id(c.req.param("id"));
  const input = await body(c, z.object({ version }).strict());
  return sql.begin(async (tx) => {
    const [original] = await tx<
      Comment[]
    >`SELECT * FROM comments WHERE id=${commentId}`;
    if (!original) missing("Comment not found");
    const row = await task(c, original.taskId, "member", tx);
    await lockBoard(c, tx, row.boardId);
    const a = requireRole(c, "member", row.boardId);
    if (
      original.authorId !== a.userId &&
      (a.role !== "admin" || a.kind !== "human")
    )
      return { forbidden: true };
    const [freshTask] = await tx<
      TaskRow[]
    >`SELECT * FROM tasks WHERE id=${row.id}`;
    if (!freshTask) missing("Task not found");
    const [current] = await tx<
      Comment[]
    >`SELECT * FROM comments WHERE id=${commentId} FOR UPDATE`;
    if (!current) missing("Comment not found");
    assertVersion(current, input.version);
    await tx`DELETE FROM comments WHERE id=${commentId}`;
    await recordActivity(
      tx,
      a,
      "comment.deleted",
      { commentId },
      row.boardId,
      row.id,
    );
    return { ok: true };
  });
}
domainRoutes.delete("/comments/:id", async (c) => {
  const result = await deleteComment(c);
  if ("forbidden" in result)
    return c.json(
      { error: "Only the author or an administrator can delete this comment" },
      403,
    );
  return c.json(result);
});
domainRoutes.get("/tasks/:id/activity", async (c) => {
  const row = await task(c, id(c.req.param("id")));
  const limit = pagination(c);
  const cursor = c.req.query("cursor") ? id(c.req.query("cursor")) : null;
  const [anchor] = cursor
    ? await sql`SELECT id,created_at FROM activity WHERE id=${cursor} AND task_id=${row.id}`
    : [];
  if (cursor && !anchor)
    badRequest("This activity cursor does not belong to the task");
  const rows =
    await sql`SELECT * FROM activity WHERE task_id=${row.id} ${anchor ? sql`AND (created_at,id)<(SELECT created_at,id FROM activity WHERE id=${anchor.id})` : sql``} ORDER BY created_at DESC,id DESC LIMIT ${limit + 1}`;
  const items = rows.slice(0, limit);
  return c.json({
    items,
    hasMore: rows.length > limit,
    nextCursor: rows.length > limit ? items.at(-1)?.id : null,
  });
});
domainRoutes.get("/notifications", async (c) => {
  const a = requireRole(c);
  const limit = pagination(c);
  const unread = boolQuery(c, "unread");
  const cursor = c.req.query("cursor") ? id(c.req.query("cursor")) : null;
  const scope = a.boardIds
    ? a.boardIds.length
      ? sql`AND tasks.board_id IN ${sql(a.boardIds)}`
      : sql`AND false`
    : sql``;
  const [anchor] = cursor
    ? await sql`SELECT notifications.id,notifications.created_at FROM notifications JOIN tasks ON tasks.id=notifications.task_id WHERE notifications.id=${cursor} AND user_id=${a.userId} ${scope}`
    : [];
  if (cursor && !anchor)
    badRequest(
      "This notification cursor does not belong to your notifications",
    );
  const [count] =
    await sql`SELECT count(*)::int AS total FROM notifications JOIN tasks ON tasks.id=notifications.task_id WHERE user_id=${a.userId} AND read_at IS NULL ${scope}`;
  const rows =
    await sql`SELECT notifications.*,tasks.title,tasks.identifier,tasks.board_id FROM notifications JOIN tasks ON tasks.id=notifications.task_id WHERE user_id=${a.userId} ${scope} ${unread ? sql`AND read_at IS NULL` : sql``} ${anchor ? sql`AND (notifications.created_at,notifications.id)<(SELECT created_at,id FROM notifications WHERE id=${anchor.id})` : sql``} ORDER BY notifications.created_at DESC,notifications.id DESC LIMIT ${limit + 1}`;
  const items = rows.slice(0, limit);
  return c.json({
    items,
    unreadCount: count.total,
    hasMore: rows.length > limit,
    nextCursor: rows.length > limit ? items.at(-1)?.id : null,
  });
});
domainRoutes.patch("/notifications", async (c) => {
  const a = requireRole(c);
  if (a.kind === "agent" && !a.scopes.includes("write"))
    return c.json(
      { error: "This credential does not permit notification changes" },
      403,
    );
  const input = await body(
    c,
    z
      .object({
        ids: z.array(uuid).min(1).max(100).optional(),
        all: z.literal(true).optional(),
        read: z.boolean().default(true),
      })
      .strict()
      .refine(
        (v) => Boolean(v.ids) !== Boolean(v.all),
        "Choose notification IDs or all notifications",
      ),
  );
  const rows = await sql.begin(async (tx) => {
    await revalidateAuthority(c, tx, "viewer");
    const current = actor(c);
    if (current.kind === "agent" && !current.scopes.includes("write"))
      return null;
    const permitted =
      await tx`SELECT notifications.id FROM notifications JOIN tasks ON tasks.id=notifications.task_id WHERE notifications.user_id=${current.userId} ${current.boardIds ? (current.boardIds.length ? tx`AND tasks.board_id IN ${tx(current.boardIds)}` : tx`AND false`) : tx``} ${input.ids ? tx`AND notifications.id IN ${tx(input.ids)}` : tx``} FOR UPDATE OF notifications`;
    if (input.ids && permitted.length !== new Set(input.ids).size) return null;
    if (!permitted.length) return [];
    return tx`UPDATE notifications SET read_at=${input.read ? new Date() : null} WHERE id IN ${tx(permitted.map((row) => row.id))} RETURNING id`;
  });
  if (!rows)
    return c.json({ error: "Some notifications are outside your access" }, 403);
  return c.json({ ok: true, updated: rows.length });
});
domainRoutes.get("/workspace", async (c) => {
  const a = requireRole(c);
  if (a.kind === "agent")
    return c.json(
      { error: "Workspace settings require a member session" },
      403,
    );
  const [workspace] = await sql`SELECT id,name,created_at FROM workspace`;
  return c.json({ workspace });
});
domainRoutes.patch("/workspace", async (c) => {
  administrative(c, true);
  const input = await body(
    c,
    z.object({ name: z.string().trim().min(1).max(100) }).strict(),
  );
  const workspace = await sql.begin(async (tx) => {
    await tx`SELECT id FROM workspace FOR UPDATE`;
    await revalidateAuthority(c, tx, "admin");
    const [updated] =
      await tx`UPDATE workspace SET name=${input.name} RETURNING id,name,created_at`;

    return updated;
  });
  return c.json({ workspace });
});

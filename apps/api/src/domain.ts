import { Hono } from "hono";
import { z } from "zod";
import { sql } from "../../../packages/database/src/index.js";
import type {
  Actor,
  Activity,
  Column,
  Comment,
} from "../../../packages/contracts/src/index.js";
import { actor, badRequest, conflict, requireRole, type Env } from "./http.js";
import {
  assertVersion,
  board,
  body,
  boolQuery,
  colors,
  cursorSchema,
  decodeCursor,
  encodeCursor,
  fingerprint,
  id,
  insertBefore,
  lockBoard,
  lockedTask,
  mentionNotifications,
  missing,
  normalizeColumns,
  normalizeTasks,
  notify,
  pagination,
  priorities,
  recordActivity,
  revalidateAuthority,
  task,
  taskFields,
  uuid,
  validateTaskRelations,
  version,
  type TaskRow,
} from "./domain/helpers.js";
import { installPortableRoutes } from "./domain/portable.js";

export const domainRoutes = new Hono<Env>();
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
const boardPatch = boardCreate
  .partial()
  .extend({
    version,
    beforeId: uuid.nullable().optional(),
  })
  .strict();
const columnCreate = z
  .object({
    name: z.string().trim().min(1).max(80),
    color: z.enum(colors).default("gray"),
  })
  .strict();
const columnPatch = columnCreate
  .partial()
  .extend({ version, beforeId: uuid.nullable().optional() })
  .strict();
const taskCreate = z
  .object(taskFields)
  .partial()
  .extend({ title: taskFields.title, columnId: uuid.optional() })
  .strict();
const taskPatch = z
  .object(taskFields)
  .partial()
  .extend({
    version,
    columnId: uuid.optional(),
    beforeId: uuid.nullable().optional(),
  })
  .strict();
const commentCreate = z
  .object({
    body: z.string().trim().min(1).max(10000),
    mentionIds: z.array(uuid).max(50).default([]),
  })
  .strict();
const commentPatch = commentCreate.extend({ version }).strict();
type TaskSummary = Pick<
  TaskRow,
  | "id"
  | "boardId"
  | "columnId"
  | "identifier"
  | "title"
  | "assigneeId"
  | "priority"
  | "dueDate"
  | "parentId"
  | "position"
  | "version"
>;
const summaryFields = sql`id,board_id,column_id,identifier,title,assignee_id,priority,due_date,parent_id,position,version`;

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
    position: z.number().int().min(0).max(2147483647),
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
  const revisionFields = sql`id::text||':'||position::text||':'||version::text`;
  const result = await sql.begin(
    "isolation level repeatable read read only",
    async (tx) => {
      const [order] = await tx<
        { revision: string }[]
      >`SELECT md5(COALESCE(string_agg(${revisionFields},',' ORDER BY position,id),'')) AS revision FROM boards WHERE ${filters}`;
      if (cursor && cursor.revision !== order.revision)
        return { stale: true as const };
      const [anchor] = cursor
        ? await tx`SELECT id,position FROM boards WHERE id=${cursor.id} AND ${filters}`
        : [];
      if (cursor && (!anchor || anchor.position !== cursor.position))
        badRequest(
          "This board cursor does not belong to the accessible board list",
        );
      const rows =
        await tx`SELECT * FROM boards WHERE ${filters} ${cursor ? tx`AND (position,id)>(${cursor.position},${cursor.id}::uuid)` : tx``} ORDER BY position,id LIMIT ${limit + 1}`;
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
                position: last.position,
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
    const [count] = await tx`SELECT count(*)::int AS total FROM boards`;
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
      await tx`INSERT INTO boards (workspace_id,name,prefix,description,position) VALUES (${workspace.id},${input.name},${prefix},${input.description},${count.total}) RETURNING *`;
    for (const [position, name] of ["Backlog", "In progress", "Done"].entries())
      await tx`INSERT INTO columns (board_id,name,color,position) VALUES (${created.id},${name},${["gray", "blue", "green"][position]},${position})`;

    return created;
  });
  return c.json({ board: result }, 201);
});
domainRoutes.get("/boards/:id", async (c) => {
  const row = await board(c, id(c.req.param("id")));
  const columns =
    await sql`SELECT * FROM columns WHERE board_id=${row.id} ORDER BY position,id`;
  return c.json({ board: row, columns });
});
domainRoutes.patch("/boards/:id", async (c) => {
  const boardId = id(c.req.param("id"));
  const a = requireRole(c, "member", boardId);
  const input = await body(c, boardPatch);
  if (input.beforeId !== undefined && a.boardIds)
    return c.json(
      {
        error: "A board-restricted credential cannot reorder workspace boards",
      },
      403,
    );
  const result = await sql.begin(async (tx) => {
    await tx`SELECT id FROM workspace FOR UPDATE`;
    const row = await lockBoard(c, tx, boardId, "member");
    assertVersion(row, input.version);
    if (input.prefix && input.prefix !== row.prefix)
      badRequest("Task prefixes stay fixed so task identifiers remain useful");
    if (input.beforeId !== undefined) {
      const rows = await tx`SELECT id FROM boards ORDER BY position,id`;
      const order = insertBefore(
        rows.map((r) => r.id),
        boardId,
        input.beforeId,
      );
      for (const [position, orderedId] of order.entries())
        await tx`UPDATE boards SET position=${position},version=version+1,updated_at=now() WHERE id=${orderedId} AND position<>${position} AND id<>${boardId}`;
      row.position = order.indexOf(boardId);
    }
    const [updated] =
      await tx`UPDATE boards SET name=${input.name ?? row.name},description=${input.description ?? row.description},position=${row.position},version=version+1,updated_at=now() WHERE id=${boardId} RETURNING *`;

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
    const rows = await tx`SELECT id FROM boards ORDER BY position,id`;
    for (const [position, row] of rows.entries())
      await tx`UPDATE boards SET position=${position},version=version+1,updated_at=now() WHERE id=${row.id} AND position<>${position}`;
  });
  return c.json({ ok: true });
});
domainRoutes.get("/boards/:id/columns", async (c) => {
  const row = await board(c, id(c.req.param("id")));
  return c.json({
    items:
      await sql`SELECT * FROM columns WHERE board_id=${row.id} ORDER BY position,id`,
  });
});
domainRoutes.post("/boards/:id/columns", async (c) => {
  const boardId = id(c.req.param("id"));
  requireRole(c, "member", boardId);
  const input = await body(c, columnCreate);
  const result = await sql.begin(async (tx) => {
    await lockBoard(c, tx, boardId);
    const [count] =
      await tx`SELECT count(*)::int AS total FROM columns WHERE board_id=${boardId}`;
    if (count.total >= 50) badRequest("A board supports up to 50 statuses");
    const [created] =
      await tx`INSERT INTO columns (board_id,name,color,position) VALUES (${boardId},${input.name},${input.color},${count.total}) RETURNING *`;

    return created;
  });
  return c.json({ column: result }, 201);
});
domainRoutes.patch("/columns/:id", async (c) => {
  requireRole(c, "member");
  const columnId = id(c.req.param("id"));
  const input = await body(c, columnPatch);
  const result = await sql.begin(async (tx) => {
    const [original] = await tx<
      Column[]
    >`SELECT * FROM columns WHERE id=${columnId}`;
    if (!original) missing("Status not found");
    requireRole(c, "member", original.boardId);
    await lockBoard(c, tx, original.boardId);
    const [row] = await tx<
      Column[]
    >`SELECT * FROM columns WHERE id=${columnId}`;
    if (!row) missing("Status not found");
    assertVersion(row, input.version);
    if (input.beforeId !== undefined) {
      const columns = await tx<
        Column[]
      >`SELECT * FROM columns WHERE board_id=${row.boardId} ORDER BY position,id`;
      const ordered = insertBefore(
        columns.map((r) => r.id),
        columnId,
        input.beforeId,
      );
      await normalizeColumns(tx, row.boardId, ordered);
    }
    const [updated] =
      await tx`UPDATE columns SET name=${input.name ?? row.name},color=${input.color ?? row.color},version=version+1 WHERE id=${columnId} RETURNING *`;

    return updated;
  });
  return c.json({ column: result });
});
domainRoutes.delete("/columns/:id", async (c) => {
  requireRole(c, "member");
  const columnId = id(c.req.param("id"));
  const input = await body(
    c,
    z.object({ version, moveToColumnId: uuid.optional() }).strict(),
  );
  await sql.begin(async (tx) => {
    const [original] = await tx<
      Column[]
    >`SELECT * FROM columns WHERE id=${columnId}`;
    if (!original) missing("Status not found");
    requireRole(c, "member", original.boardId);
    await lockBoard(c, tx, original.boardId);
    const [row] = await tx<
      Column[]
    >`SELECT * FROM columns WHERE id=${columnId}`;
    if (!row) missing("Status not found");
    assertVersion(row, input.version);
    const cols = await tx<
      Column[]
    >`SELECT * FROM columns WHERE board_id=${row.boardId} ORDER BY position,id`;
    if (cols.length <= 1) conflict("Keep at least one status on the board");
    const tasks = await tx<
      TaskRow[]
    >`SELECT * FROM tasks WHERE column_id=${columnId} ORDER BY position,id`;
    if (tasks.length) {
      const destination = cols.find(
        (col) => col.id === input.moveToColumnId && col.id !== columnId,
      );
      if (!destination)
        conflict("Choose another status for the tasks in this status");
      const [count] =
        await tx`SELECT count(*)::int AS total FROM tasks WHERE column_id=${destination.id}`;
      const a = requireRole(c, "member", row.boardId);
      for (const [offset, rowTask] of tasks.entries()) {
        await tx`UPDATE tasks SET column_id=${destination.id},position=${count.total + offset},version=version+1,updated_at=now() WHERE id=${rowTask.id}`;
        await recordActivity(
          tx,
          a,
          "task.moved",
          {
            fromColumnId: columnId,
            columnId: destination.id,
            status: destination.name,
          },
          row.boardId,
          rowTask.id,
        );
      }
    }
    await tx`DELETE FROM columns WHERE id=${columnId}`;
    await normalizeColumns(tx, row.boardId);
  });
  return c.json({ ok: true });
});

domainRoutes.get("/boards/:id/tasks", async (c) => {
  const boardId = id(c.req.param("id"));
  await board(c, boardId);
  const limit = pagination(c);
  const q = c.req.query("q")?.trim() ?? "";
  if (q.length > 300) badRequest("Search is limited to 300 characters");
  const columnId = c.req.query("columnId") ? id(c.req.query("columnId")) : null;
  const assigneeRaw = c.req.query("assigneeId");
  const assigneeId =
    assigneeRaw && assigneeRaw !== "unassigned" ? id(assigneeRaw) : null;
  const priority = c.req.query("priority");
  if (priority && !priorities.includes(priority as (typeof priorities)[number]))
    badRequest("Choose a valid priority");
  const label = c.req.query("label");
  if (label && label.length > 40)
    badRequest("Labels are limited to 40 characters");
  if (
    c.req.query("archived") !== undefined ||
    c.req.query("deleted") !== undefined
  )
    badRequest("Archive and deleted filters are no longer supported");
  const sort = c.req.query("sort") ?? "position";
  const sorts = {
    position: sql`lpad(columns.position::text,10,'0')||':'||lpad(tasks.position::text,10,'0')`,
    title: sql`lower(tasks.title)`,
    dueDate: sql`coalesce(to_char(tasks.due_date,'YYYY-MM-DD'),'9999-12-31')`,
    priority: sql`CASE tasks.priority WHEN 'urgent' THEN '0' WHEN 'high' THEN '1' WHEN 'medium' THEN '2' WHEN 'low' THEN '3' ELSE '4' END`,
    updatedAt: sql`to_char(tasks.updated_at AT TIME ZONE 'UTC','YYYY-MM-DD HH24:MI:SS.US')`,
    createdAt: sql`to_char(tasks.created_at AT TIME ZONE 'UTC','YYYY-MM-DD HH24:MI:SS.US')`,
  };
  if (!Object.hasOwn(sorts, sort)) badRequest("Choose a valid sort order");
  const sortKey = sorts[sort as keyof typeof sorts];
  const descending = sort === "updatedAt" || sort === "createdAt";
  const filterKey = fingerprint({
    boardId,
    q,
    columnId,
    assigneeRaw,
    priority,
    label,
    sort,
  });
  const cursor = decodeCursor(c.req.query("cursor"), cursorSchema);
  if (cursor && cursor.fingerprint !== filterKey)
    badRequest("This cursor belongs to a different search");
  const rows = await sql<
    (TaskRow & { sortKey: string })[]
  >`SELECT tasks.*,${sortKey} AS sort_key FROM tasks JOIN columns ON columns.id=tasks.column_id WHERE tasks.board_id=${boardId}
    ${q ? sql`AND (tasks.title ILIKE ${"%" + q.replace(/[%_\\]/g, "\\$&") + "%"} OR tasks.description ILIKE ${"%" + q.replace(/[%_\\]/g, "\\$&") + "%"} OR tasks.identifier ILIKE ${"%" + q.replace(/[%_\\]/g, "\\$&") + "%"})` : sql``}
    ${columnId ? sql`AND tasks.column_id=${columnId}` : sql``}
    ${assigneeRaw === "unassigned" ? sql`AND tasks.assignee_id IS NULL` : assigneeId ? sql`AND tasks.assignee_id=${assigneeId}` : sql``}
    ${priority ? sql`AND tasks.priority=${priority}` : sql``}
    ${label ? sql`AND ${label}=ANY(tasks.labels)` : sql``}
    ${cursor ? (descending ? sql`AND (${sortKey},tasks.id)<(${cursor.key},${cursor.id}::uuid)` : sql`AND (${sortKey},tasks.id)>(${cursor.key},${cursor.id}::uuid)`) : sql``}
    ORDER BY ${sortKey} ${descending ? sql`DESC` : sql`ASC`},tasks.id ${descending ? sql`DESC` : sql`ASC`} LIMIT ${limit + 1}`;
  const hasMore = rows.length > limit;
  const page = rows.slice(0, limit);
  const last = page.at(-1);
  return c.json({
    items: page.map(({ sortKey: _sortKey, ...row }) => row),
    hasMore,
    nextCursor:
      hasMore && last
        ? encodeCursor({
            key: last.sortKey,
            id: last.id,
            fingerprint: filterKey,
          })
        : null,
  });
});
domainRoutes.post("/boards/:id/tasks", async (c) => {
  const boardId = id(c.req.param("id"));
  const a = requireRole(c, "member", boardId);
  const input = await body(c, taskCreate);
  const result = await sql.begin(async (tx) => {
    const row = await lockBoard(c, tx, boardId);
    const [column] = input.columnId
      ? await tx<
          Column[]
        >`SELECT * FROM columns WHERE id=${input.columnId} AND board_id=${boardId}`
      : await tx<
          Column[]
        >`SELECT * FROM columns WHERE board_id=${boardId} ORDER BY position,id LIMIT 1`;
    if (!column) badRequest("Choose a status in this board");
    await validateTaskRelations(
      tx,
      boardId,
      null,
      input.assigneeId,
      input.parentId,
    );
    const [count] =
      await tx`SELECT count(*)::int AS total FROM tasks WHERE column_id=${column.id}`;
    const [created] = await tx<
      TaskRow[]
    >`INSERT INTO tasks (board_id,column_id,identifier,title,description,assignee_id,priority,labels,due_date,checklist,parent_id,position,created_by) VALUES (${boardId},${column.id},${row.prefix + "-" + row.nextNumber},${input.title},${input.description ?? ""},${input.assigneeId ?? null},${input.priority ?? "none"},${input.labels ?? []},${input.dueDate ?? null},${tx.json(input.checklist ?? [])},${input.parentId ?? null},${count.total},${a.userId}) RETURNING *`;
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
    return created;
  });
  return c.json({ task: result }, 201);
});
domainRoutes.get("/tasks/:id", async (c) => {
  const row = await task(c, id(c.req.param("id")));
  const commentLimit = previewLimit(c, "commentLimit");
  const activityLimit = previewLimit(c, "activityLimit");
  const subtaskLimit = previewLimit(c, "subtaskLimit");
  const comments = previewPage(
    await sql<
      Comment[]
    >`SELECT comments.*,users.name AS author_name FROM comments JOIN users ON users.id=comments.author_id WHERE task_id=${row.id} ORDER BY created_at,id LIMIT ${commentLimit + 1}`,
    commentLimit,
  );
  const activity = previewPage(
    await sql<
      Activity[]
    >`SELECT * FROM activity WHERE task_id=${row.id} ORDER BY created_at DESC,id DESC LIMIT ${activityLimit + 1}`,
    activityLimit,
  );
  const subtasks = previewPage(
    await sql<
      TaskSummary[]
    >`SELECT ${summaryFields} FROM tasks WHERE parent_id=${row.id} ORDER BY position,id LIMIT ${subtaskLimit + 1}`,
    subtaskLimit,
  );
  const [parent] = row.parentId
    ? await sql`SELECT ${summaryFields} FROM tasks WHERE id=${row.parentId}`
    : [];
  return c.json({
    task: row,
    comments: comments.items,
    commentsPage: comments.page,
    activity: activity.items,
    activityPage: activity.page,
    subtasks: subtasks.items,
    subtasksPage: subtasks.page,
    parent: parent ?? null,
  });
});
domainRoutes.get("/tasks/:id/subtasks", async (c) => {
  const row = await task(c, id(c.req.param("id")));
  const limit = pagination(c);
  const cursor = c.req.query("cursor") ? id(c.req.query("cursor")) : null;
  const [anchor] = cursor
    ? await sql`SELECT id FROM tasks WHERE id=${cursor} AND parent_id=${row.id}`
    : [];
  if (cursor && !anchor)
    badRequest("This subtask cursor does not belong to the task");
  const rows = await sql<
    TaskSummary[]
  >`SELECT ${summaryFields} FROM tasks WHERE parent_id=${row.id} ${anchor ? sql`AND (position,id)>(SELECT position,id FROM tasks WHERE id=${anchor.id})` : sql``} ORDER BY position,id LIMIT ${limit + 1}`;
  const { items, page } = previewPage(rows, limit);
  return c.json({ items, ...page });
});
domainRoutes.patch("/tasks/:id", async (c) => {
  const taskId = id(c.req.param("id"));
  const input = await body(c, taskPatch);
  const result = await sql.begin(async (tx) => {
    const row = await lockedTask(c, tx, taskId, input.version);
    const a = requireRole(c, "member", row.boardId);
    await validateTaskRelations(
      tx,
      row.boardId,
      row.id,
      input.assigneeId,
      input.parentId,
    );
    let columnId = row.columnId;
    let position = row.position;
    if (input.columnId && input.columnId !== row.columnId) {
      const [destination] =
        await tx`SELECT id FROM columns WHERE id=${input.columnId} AND board_id=${row.boardId}`;
      if (!destination) badRequest("Choose a status in this board");
      const [count] =
        await tx`SELECT count(*)::int AS total FROM tasks WHERE column_id=${destination.id}`;
      columnId = destination.id;
      position = count.total;
    }
    let ordered: string[] | undefined;
    if (input.beforeId !== undefined) {
      const tasks = await tx<
        TaskRow[]
      >`SELECT * FROM tasks WHERE column_id=${columnId} ORDER BY position,id`;
      ordered = insertBefore(
        tasks.map((t) => t.id),
        taskId,
        input.beforeId,
      );
      position = ordered.indexOf(taskId);
    }
    await tx`UPDATE tasks SET column_id=${columnId},position=${position},title=${input.title ?? row.title},description=${input.description ?? row.description},assignee_id=${input.assigneeId === undefined ? row.assigneeId : input.assigneeId},priority=${input.priority ?? row.priority},labels=${input.labels ?? row.labels},due_date=${input.dueDate === undefined ? row.dueDate : input.dueDate},checklist=${tx.json(input.checklist ?? row.checklist)},parent_id=${input.parentId === undefined ? row.parentId : input.parentId},version=version+1,updated_at=now() WHERE id=${taskId}`;
    if (ordered) await normalizeTasks(tx, columnId, ordered);
    if (columnId !== row.columnId) await normalizeTasks(tx, row.columnId);
    const [updated] = await tx<
      TaskRow[]
    >`SELECT * FROM tasks WHERE id=${taskId}`;
    await recordActivity(
      tx,
      a,
      "task.updated",
      { fields: Object.keys(input).filter((k) => k !== "version") },
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
domainRoutes.post("/tasks/:id/move", async (c) => {
  const taskId = id(c.req.param("id"));
  const input = await body(
    c,
    z
      .object({ columnId: uuid, beforeId: uuid.nullable().optional(), version })
      .strict(),
  );
  const result = await sql.begin(async (tx) => {
    const row = await lockedTask(c, tx, taskId, input.version);
    const a = requireRole(c, "member", row.boardId);
    const [destination] = await tx<
      Column[]
    >`SELECT * FROM columns WHERE id=${input.columnId} AND board_id=${row.boardId}`;
    if (!destination) badRequest("Choose a status in this board");
    const tasks = await tx<
      TaskRow[]
    >`SELECT * FROM tasks WHERE column_id=${destination.id} ORDER BY position,id`;
    const ordered = insertBefore(
      tasks.map((t) => t.id),
      taskId,
      input.beforeId,
    );
    await tx`UPDATE tasks SET column_id=${destination.id},position=${ordered.indexOf(taskId)},version=version+1,updated_at=now() WHERE id=${taskId}`;
    await normalizeTasks(tx, destination.id, ordered);
    if (row.columnId !== destination.id) await normalizeTasks(tx, row.columnId);
    const [updated] = await tx<
      TaskRow[]
    >`SELECT * FROM tasks WHERE id=${taskId}`;
    await recordActivity(
      tx,
      a,
      "task.moved",
      {
        fromColumnId: row.columnId,
        columnId: destination.id,
        status: destination.name,
      },
      row.boardId,
      taskId,
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
    const affected = await tx<
      { columnId: string }[]
    >`WITH RECURSIVE descendants AS (SELECT id,column_id FROM tasks WHERE id=${taskId} UNION ALL SELECT t.id,t.column_id FROM tasks t JOIN descendants d ON t.parent_id=d.id) SELECT DISTINCT column_id FROM descendants`;
    await tx`DELETE FROM tasks WHERE id=${taskId}`;
    for (const affectedColumn of affected)
      await normalizeTasks(tx, affectedColumn.columnId);
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
    await sql`SELECT comments.*,users.name AS author_name FROM comments JOIN users ON users.id=comments.author_id WHERE task_id=${row.id} ${anchor ? sql`AND (comments.created_at,comments.id)>(SELECT created_at,id FROM comments WHERE id=${anchor.id})` : sql``} ORDER BY created_at,id LIMIT ${limit + 1}`;
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
    const [fresh] = await tx<TaskRow[]>`SELECT * FROM tasks WHERE id=${taskId}`;
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
async function changeComment(c: Parameters<typeof actor>[0], remove: boolean) {
  requireRole(c, "member");
  const commentId = id(c.req.param("id"));
  const input = remove
    ? await body(c, z.object({ version }).strict())
    : await body(c, commentPatch);
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
    if (remove) {
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
    }
    const patch = input as z.infer<typeof commentPatch>;
    const [updated] =
      await tx`UPDATE comments SET body=${patch.body},version=version+1,updated_at=now() WHERE id=${commentId} RETURNING *`;
    await mentionNotifications(
      tx,
      a,
      row.id,
      patch.body,
      patch.mentionIds,
      current.body,
    );
    await recordActivity(
      tx,
      a,
      "comment.updated",
      { commentId },
      row.boardId,
      row.id,
    );
    return { comment: updated };
  });
}
domainRoutes.patch("/comments/:id", async (c) => {
  const result = await changeComment(c, false);
  if ("forbidden" in result)
    return c.json(
      { error: "Only the author or an administrator can edit this comment" },
      403,
    );
  return c.json(result);
});
domainRoutes.delete("/comments/:id", async (c) => {
  const result = await changeComment(c, true);
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
installPortableRoutes(domainRoutes);

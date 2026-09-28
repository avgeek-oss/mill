import { randomBytes } from "node:crypto";
import type { Hono } from "hono";
import { z } from "zod";
import { HTTPException } from "hono/http-exception";
import { sql } from "../../../../packages/database/src/index.js";
import { badRequest, requireRole, type Env } from "../http.js";
import {
  body,
  colors,
  newId,
  recordActivity,
  revalidateAuthority,
  taskFields,
  uuid,
} from "./helpers.js";

const timestamp = z.iso.datetime({ offset: true });
const portableMember = z.object({
  id: uuid,
  name: z.string().trim().min(1).max(100),
  email: z
    .email()
    .max(320)
    .transform((v) => v.toLowerCase()),
  role: z.enum(["admin", "member", "viewer"]),
  timeZone: z.string().max(100).default("UTC"),
  disabled: z.boolean().default(false),
});
const portableBoard = z.object({
  id: uuid,
  name: z.string().trim().min(1).max(100),
  prefix: z.string().regex(/^[A-Z][A-Z0-9]{1,9}$/),
  description: z.string().max(10000),
  position: z.number().int().nonnegative(),
  archived: z.boolean(),
  deletedAt: timestamp.nullable(),
});
const portableColumn = z.object({
  id: uuid,
  boardId: uuid,
  name: z.string().trim().min(1).max(80),
  color: z.enum(colors),
  position: z.number().int().nonnegative(),
});
const portableTask = z.object({
  ...taskFields,
  id: uuid,
  boardId: uuid,
  columnId: uuid,
  identifier: z.string().max(100),
  position: z.number().int().nonnegative(),
  deletedAt: timestamp.nullable(),
  createdBy: uuid,
  createdAt: timestamp,
  updatedAt: timestamp,
});
const portableComment = z.object({
  id: uuid,
  taskId: uuid,
  authorId: uuid,
  body: z.string().trim().min(1).max(10000),
  createdAt: timestamp,
  updatedAt: timestamp,
});
const portable = z
  .object({
    format: z.literal("mill-portable"),
    version: z.literal(1),
    exportedAt: timestamp,
    workspace: z.object({ name: z.string().trim().min(1).max(100) }),
    members: z.array(portableMember).max(10000),
    boards: z.array(portableBoard).max(100),
    columns: z.array(portableColumn).max(5000),
    tasks: z.array(portableTask).max(50000),
    comments: z.array(portableComment).max(100000),
  })
  .strict();

function assertUnique(items: { id: string }[], name: string) {
  if (new Set(items.map((item) => item.id)).size !== items.length)
    badRequest(`${name} contain duplicate IDs`);
}
function mapped(map: Map<string, string>, value: string, kind: string) {
  const result = map.get(value);
  if (!result) badRequest(`The import references a missing ${kind}`);
  return result;
}
function validateReferences(data: z.infer<typeof portable>) {
  for (const [name, items] of Object.entries({
    members: data.members,
    boards: data.boards,
    columns: data.columns,
    tasks: data.tasks,
    comments: data.comments,
  }))
    assertUnique(items, name);
  if (new Set(data.members.map((m) => m.email)).size !== data.members.length)
    badRequest("Members contain duplicate emails");
  const boards = new Set(data.boards.map((b) => b.id));
  const columns = new Map(data.columns.map((c) => [c.id, c]));
  const tasks = new Map(data.tasks.map((t) => [t.id, t]));
  const members = new Set(data.members.map((m) => m.id));
  for (const b of data.boards) {
    const boardColumns = data.columns.filter((c) => c.boardId === b.id);
    if (!boardColumns.length || boardColumns.length > 50)
      badRequest("Each imported board needs between 1 and 50 statuses");
  }
  for (const c of data.columns)
    if (!boards.has(c.boardId))
      badRequest("A status references a missing board");
  for (const t of data.tasks) {
    if (
      !boards.has(t.boardId) ||
      columns.get(t.columnId)?.boardId !== t.boardId
    )
      badRequest(
        "A task references a missing board or a status on another board",
      );
    if (
      !members.has(t.createdBy) ||
      (t.assigneeId && !members.has(t.assigneeId))
    )
      badRequest("A task references a missing member");
    if (t.parentId && tasks.get(t.parentId)?.boardId !== t.boardId)
      badRequest("A subtask parent must belong to its board");
  }
  const resolvedParents = new Set<string>();
  for (const task of data.tasks) {
    const path = new Set<string>();
    let current: string | null = task.id;
    while (current && !resolvedParents.has(current)) {
      if (path.has(current))
        badRequest("The imported subtasks contain a cycle");
      path.add(current);
      current = tasks.get(current)?.parentId ?? null;
    }
    for (const taskId of path) resolvedParents.add(taskId);
  }
  for (const c of data.comments)
    if (!tasks.has(c.taskId) || !members.has(c.authorId))
      badRequest("A comment references a missing task or member");
  for (const m of data.members) {
    try {
      new Intl.DateTimeFormat("en", { timeZone: m.timeZone });
    } catch {
      badRequest("A member has an invalid time zone");
    }
  }
}

export function installPortableRoutes(routes: Hono<Env>) {
  routes.get("/export", async (c) => {
    const a = requireRole(c, "admin");
    const data = await sql.begin(async (tx) => {
      await tx`SELECT id FROM workspace FOR UPDATE`;
      await tx`SELECT id FROM boards ORDER BY id FOR UPDATE`;
      await revalidateAuthority(c, tx, "admin");
      const [bounds] = await tx`SELECT
        (SELECT count(*) FROM tasks) AS tasks,
        (SELECT count(*) FROM comments) AS comments,
        (SELECT count(*) FROM users) AS members,
        (SELECT coalesce(sum(octet_length(row_to_json(t)::text)),0) FROM tasks t) +
        (SELECT coalesce(sum(octet_length(row_to_json(c)::text)),0) FROM comments c) +
        (SELECT coalesce(sum(octet_length(row_to_json(u)::text)),0) FROM (SELECT id,name,email,role,time_zone,(disabled_at IS NOT NULL) AS disabled FROM users) u) AS bytes`;
      if (
        Number(bounds.tasks) > 50000 ||
        Number(bounds.comments) > 100000 ||
        Number(bounds.members) > 10000 ||
        Number(bounds.bytes) > 32 * 1024 * 1024
      )
        throw new HTTPException(413, {
          message:
            "This workspace exceeds portable export limits. Use a PostgreSQL backup to move the complete instance.",
        });
      const [workspace] = await tx`SELECT name FROM workspace`;
      const members =
        await tx`SELECT id,name,email,role,time_zone,(disabled_at IS NOT NULL) AS disabled FROM users ORDER BY created_at,id`;
      const boards =
        await tx`SELECT id,name,prefix,description,position,archived,deleted_at FROM boards ORDER BY position,id`;
      const columns =
        await tx`SELECT id,board_id,name,color,position FROM columns ORDER BY board_id,position,id`;
      const tasks =
        await tx`SELECT id,board_id,column_id,identifier,title,description,assignee_id,priority,labels,due_date,checklist,parent_id,position,archived,deleted_at,created_by,created_at,updated_at FROM tasks ORDER BY board_id,column_id,position,id`;
      const comments =
        await tx`SELECT id,task_id,author_id,body,created_at,updated_at FROM comments ORDER BY created_at,id`;
      const result = {
        format: "mill-portable",
        version: 1,
        exportedAt: new Date().toISOString(),
        workspace,
        members,
        boards,
        columns,
        tasks,
        comments,
      };
      if (Buffer.byteLength(JSON.stringify(result)) > 32 * 1024 * 1024)
        throw new HTTPException(413, {
          message:
            "This workspace is larger than the 32 MiB portable export limit. Use a PostgreSQL backup to move the complete instance.",
        });
      await recordActivity(tx, a, "workspace.exported", {
        boards: boards.length,
        tasks: tasks.length,
      });
      return result;
    });
    c.header(
      "Content-Disposition",
      `attachment; filename="mill-export-${new Date().toISOString().slice(0, 10)}.json"`,
    );
    return c.json(data);
  });
  routes.post("/import", async (c) => {
    const a = requireRole(c, "admin");
    const data = await body(c, portable);
    validateReferences(data);
    const result = await sql.begin(async (tx) => {
      await tx`SELECT id FROM workspace FOR UPDATE`;
      const [workspace] = await tx`SELECT id FROM workspace`;
      await revalidateAuthority(c, tx, "admin");
      const [count] = await tx`SELECT count(*)::int AS total FROM boards`;
      if (count.total + data.boards.length > 100)
        badRequest("The import would exceed the workspace limit of 100 boards");
      const memberMap = new Map<string, string>();
      for (const member of data.members) {
        const [existing] =
          await tx`SELECT id FROM users WHERE email=${member.email}`;
        if (existing) memberMap.set(member.id, existing.id);
        else {
          const importedId = newId();
          await tx`INSERT INTO users (id,workspace_id,name,email,role,time_zone,password_hash,disabled_at) VALUES (${importedId},${workspace.id},${member.name},${member.email},${member.role},${member.timeZone},${"imported:" + randomBytes(32).toString("hex")},now())`;
          memberMap.set(member.id, importedId);
        }
      }
      const boardMap = new Map<string, string>();
      const columnMap = new Map<string, string>();
      const taskMap = new Map<string, string>();
      const prefixMap = new Map<string, string>();
      for (const [offset, board] of [...data.boards]
        .sort((x, y) => x.position - y.position || x.id.localeCompare(y.id))
        .entries()) {
        const boardId = newId();
        let prefix = board.prefix;
        let suffix = 1;
        while ((await tx`SELECT id FROM boards WHERE prefix=${prefix}`).length)
          prefix = `${board.prefix.slice(0, 7)}${++suffix}`;
        await tx`INSERT INTO boards (id,workspace_id,name,prefix,description,position,archived,deleted_at) VALUES (${boardId},${workspace.id},${board.name},${prefix},${board.description},${count.total + offset},${board.archived},${board.deletedAt})`;
        boardMap.set(board.id, boardId);
        prefixMap.set(board.id, prefix);
      }
      for (const board of data.boards) {
        const columns = data.columns
          .filter((col) => col.boardId === board.id)
          .sort((x, y) => x.position - y.position || x.id.localeCompare(y.id));
        for (const [position, col] of columns.entries()) {
          const columnId = newId();
          await tx`INSERT INTO columns (id,board_id,name,color,position) VALUES (${columnId},${mapped(boardMap, col.boardId, "board")},${col.name},${col.color},${position})`;
          columnMap.set(col.id, columnId);
        }
      }
      for (const task of data.tasks) taskMap.set(task.id, newId());
      const nextNumbers = new Map<string, number>();
      const identifiers = new Set<string>();
      for (const col of data.columns) {
        const tasks = data.tasks
          .filter((t) => t.columnId === col.id)
          .sort((x, y) => x.position - y.position || x.id.localeCompare(y.id));
        for (const [position, task] of tasks.entries()) {
          const prefix = mapped(prefixMap, task.boardId, "board");
          const oldNumber = Number(task.identifier.match(/-(\d+)$/)?.[1]);
          let number =
            Number.isSafeInteger(oldNumber) &&
            oldNumber > 0 &&
            oldNumber < 2147483647
              ? oldNumber
              : (nextNumbers.get(task.boardId) ?? 1);
          while (identifiers.has(`${prefix}-${number}`)) number++;
          identifiers.add(`${prefix}-${number}`);
          nextNumbers.set(
            task.boardId,
            Math.max(nextNumbers.get(task.boardId) ?? 1, number + 1),
          );
          await tx`INSERT INTO tasks (id,board_id,column_id,identifier,title,description,assignee_id,priority,labels,due_date,checklist,parent_id,position,archived,deleted_at,created_by,created_at,updated_at) VALUES (${mapped(taskMap, task.id, "task")},${mapped(boardMap, task.boardId, "board")},${mapped(columnMap, task.columnId, "status")},${prefix + "-" + number},${task.title},${task.description},${task.assigneeId ? mapped(memberMap, task.assigneeId, "member") : null},${task.priority},${task.labels},${task.dueDate},${tx.json(task.checklist)},NULL,${position},${task.archived},${task.deletedAt},${mapped(memberMap, task.createdBy, "member")},${task.createdAt},${task.updatedAt})`;
        }
      }
      for (const task of data.tasks)
        if (task.parentId)
          await tx`UPDATE tasks SET parent_id=${mapped(taskMap, task.parentId, "task")} WHERE id=${mapped(taskMap, task.id, "task")}`;
      for (const [oldId, next] of nextNumbers)
        await tx`UPDATE boards SET next_number=${next} WHERE id=${mapped(boardMap, oldId, "board")}`;
      for (const comment of data.comments)
        await tx`INSERT INTO comments (task_id,author_id,body,created_at,updated_at) VALUES (${mapped(taskMap, comment.taskId, "task")},${mapped(memberMap, comment.authorId, "member")},${comment.body},${comment.createdAt},${comment.updatedAt})`;
      await recordActivity(tx, a, "workspace.imported", {
        boards: data.boards.length,
        tasks: data.tasks.length,
        comments: data.comments.length,
        sourceWorkspace: data.workspace.name,
      });
      return {
        boards: data.boards.length,
        tasks: data.tasks.length,
        comments: data.comments.length,
        members: data.members.length,
        boardIds: [...boardMap.values()],
      };
    });
    return c.json({ imported: result }, 201);
  });
}

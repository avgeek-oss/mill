import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import { sql } from "../../../packages/database/src/index.js";
import type { Agent } from "../../../packages/contracts/src/index.js";
import { badRequest, requireHuman, requireRole, type Env } from "./http.js";
import {
  assertVersion,
  body,
  encodeCursor,
  fingerprint,
  pagination,
  revalidateAuthority,
  recordActivity,
  type Tx,
} from "./domain/helpers.js";

export async function lockAgentAuthority(tx: Tx): Promise<void> {
  await tx`SELECT id FROM workspace FOR UPDATE`;
}
const renderedMemberIds = sql`ARRAY(SELECT m.user_id FROM agent_members m JOIN users u ON u.id=m.user_id WHERE m.agent_id=a.id AND u.disabled_at IS NULL ORDER BY m.user_id)`;
const agentFields = sql`a.id,a.name,a.scope,a.creator_id,a.all_members,a.version,a.created_at,a.updated_at,
  ${renderedMemberIds} AS member_ids`;
function accessible(userId: string) {
  return sql`((a.scope='personal' AND a.creator_id=${userId}) OR (a.scope='team' AND (a.all_members OR EXISTS(SELECT 1 FROM agent_members m WHERE m.agent_id=a.id AND m.user_id=${userId}))))`;
}
export async function findAccessibleAgent(
  userId: string,
  agentId: string,
): Promise<Agent | null> {
  const [row] = await sql<
    Agent[]
  >`SELECT ${agentFields} FROM agents a WHERE a.id=${agentId} AND ${accessible(userId)} AND EXISTS(SELECT 1 FROM users WHERE id=${userId} AND disabled_at IS NULL)`;
  return row ?? null;
}
export async function listAccessibleAgents(userId: string): Promise<Agent[]> {
  return sql<
    Agent[]
  >`SELECT ${agentFields} FROM agents a WHERE ${accessible(userId)} AND EXISTS(SELECT 1 FROM users WHERE id=${userId} AND disabled_at IS NULL) ORDER BY lower(a.name),a.name,a.id`;
}
export async function requireAgentAccess(
  tx: Tx,
  userId: string,
  agentId: string,
): Promise<Agent> {
  await lockAgentAuthority(tx);
  const [user] =
    await tx`SELECT id FROM users WHERE id=${userId} AND disabled_at IS NULL FOR SHARE`;
  const [agent] = await tx<
    Agent[]
  >`SELECT ${agentFields} FROM agents a WHERE a.id=${agentId} FOR SHARE OF a`;
  if (!user || !agent)
    throw new HTTPException(403, {
      message: "This agent is not available to your account",
    });
  if (agent.scope === "personal") {
    if (agent.creatorId !== userId)
      throw new HTTPException(403, {
        message: "This agent is not available to your account",
      });
  } else if (!agent.allMembers) {
    const [grant] =
      await tx`SELECT user_id FROM agent_members WHERE agent_id=${agentId} AND user_id=${userId} FOR SHARE`;
    if (!grant)
      throw new HTTPException(403, {
        message: "This agent is not available to your account",
      });
  }
  return agent;
}
export async function validateTaskAgent(
  tx: Tx,
  userId: string,
  agentId: string | null,
  assigneeId: string | null,
  checkActor: boolean,
): Promise<Agent | null> {
  if (!agentId) return null;
  const selectedAgent = checkActor
    ? await requireAgentAccess(tx, userId, agentId)
    : null;
  if (!assigneeId) return selectedAgent;
  try {
    return await requireAgentAccess(tx, assigneeId, agentId);
  } catch (error) {
    if (error instanceof HTTPException && error.status === 403)
      throw new HTTPException(403, {
        message: "This agent is not available to the selected assignee",
      });
    throw error;
  }
}
const uuid = z.uuid();
const version = z.number().int().positive();
const memberIds = z
  .array(uuid)
  .max(1000)
  .refine((ids) => new Set(ids).size === ids.length, "Members must be unique");
const name = z.string().trim().min(1).max(100);
const create = z
  .object({
    name,
    scope: z.enum(["personal", "team"]),
    memberIds: memberIds.optional(),
    allMembers: z.boolean().optional(),
  })
  .strict();
const patch = z
  .object({
    version,
    name: name.optional(),
    memberIds: memberIds.optional(),
    allMembers: z.boolean().optional(),
  })
  .strict();
const cursorShape = z
  .object({
    id: uuid,
    name,
    revision: z.string().regex(/^[a-f0-9]{32}$/),
    filter: z.string().length(24),
  })
  .strict();
function agentId(raw: string) {
  const result = uuid.safeParse(raw);
  if (!result.success) badRequest("Use a valid agent ID");
  return result.data;
}
async function validateMembers(tx: Tx, ids: string[]) {
  const rows =
    await tx`SELECT id FROM users WHERE id=ANY(${ids}::uuid[]) AND disabled_at IS NULL ORDER BY id FOR SHARE`;
  if (rows.length !== ids.length) badRequest("Choose active workspace members");
}
async function managed(
  tx: Tx,
  c: Parameters<typeof requireRole>[0],
  id: string,
  expected: number,
) {
  await lockAgentAuthority(tx);
  await revalidateAuthority(c, tx, "member");
  const a = requireHuman(c);
  const [row] = await tx<
    Agent[]
  >`SELECT ${agentFields} FROM agents a WHERE a.id=${id} FOR UPDATE OF a`;
  if (!row) throw new HTTPException(404, { message: "Agent not found" });
  if (
    row.scope === "personal" ? row.creatorId !== a.userId : a.role !== "admin"
  )
    throw new HTTPException(403, {
      message: "You do not have permission to manage this agent",
    });
  assertVersion(row, expected);
  return { row, a };
}
export const agentRoutes = new Hono<Env>();
agentRoutes.get("/agents", async (c) => {
  const a = requireRole(c);
  const rawManage = c.req.query("manage");
  if (rawManage !== undefined && rawManage !== "true" && rawManage !== "false")
    badRequest("Manage must be true or false");
  const manage = rawManage === "true";
  if (manage) {
    requireHuman(c);
    requireRole(c, "member");
  }
  const limit = pagination(c, 100);
  let cursor: z.infer<typeof cursorShape> | undefined;
  const raw = c.req.query("cursor");
  if (raw !== undefined) {
    try {
      if (raw.length > 1000) throw new Error("Invalid cursor");
      cursor = cursorShape.parse(
        JSON.parse(Buffer.from(raw, "base64url").toString()),
      );
    } catch {
      badRequest("Invalid agent cursor");
    }
  }
  const filter = fingerprint({ userId: a.userId, manage, role: a.role });
  if (cursor && cursor.filter !== filter)
    badRequest("This agent cursor belongs to a different directory");
  const scope =
    manage && a.role === "admin"
      ? sql`(a.scope='team' OR a.creator_id=${a.userId})`
      : accessible(a.userId);
  const result = await sql.begin(
    "isolation level repeatable read read only",
    async (tx) => {
      const [user] =
        await tx`SELECT role FROM users WHERE id=${a.userId} AND disabled_at IS NULL`;
      if (!user || user.role !== a.role)
        throw new HTTPException(403, {
          message: "Your membership changed. Reload Mill.",
        });
      const [collection] = await tx<
        { revision: string }[]
      >`SELECT md5(COALESCE(string_agg(a.id::text||':'||a.version::text||':'||a.all_members::text||':'||${renderedMemberIds}::text,',' ORDER BY a.id),'')) AS revision FROM agents a WHERE ${scope}`;
      if (cursor && cursor.revision !== collection.revision)
        return { stale: true as const };
      if (cursor) {
        const [anchor] =
          await tx`SELECT a.name FROM agents a WHERE a.id=${cursor.id} AND ${scope}`;
        if (!anchor || anchor.name !== cursor.name)
          badRequest("This agent cursor does not belong to the directory");
      }
      const rows = await tx<
        Agent[]
      >`SELECT ${agentFields} FROM agents a WHERE ${scope} ${cursor ? tx`AND (lower(a.name),a.name,a.id)>(lower(${cursor.name}),${cursor.name},${cursor.id}::uuid)` : tx``} ORDER BY lower(a.name),a.name,a.id LIMIT ${limit + 1}`;
      const items = rows.slice(0, limit),
        last = items.at(-1),
        hasMore = rows.length > limit;
      return {
        stale: false as const,
        items,
        hasMore,
        nextCursor:
          hasMore && last
            ? encodeCursor({
                id: last.id,
                name: last.name,
                revision: collection.revision,
                filter,
              })
            : null,
      };
    },
  );
  if (result.stale)
    return c.json(
      {
        error: "Agent list changed. Reload agents to continue.",
        code: "agent_list_changed",
      },
      409,
    );
  const { stale: _stale, ...page } = result;
  return c.json(page);
});
agentRoutes.post("/agents", async (c) => {
  requireHuman(c);
  requireRole(c, "member");
  const input = await body(c, create);
  const agent = await sql.begin(async (tx) => {
    await lockAgentAuthority(tx);
    await revalidateAuthority(
      c,
      tx,
      input.scope === "team" ? "admin" : "member",
    );
    const a = requireHuman(c);
    if (
      input.scope === "personal" &&
      (input.memberIds !== undefined || input.allMembers !== undefined)
    )
      badRequest("Personal agents are available only to their creator");
    const ids =
      input.scope === "team"
        ? [...new Set([a.userId, ...(input.memberIds ?? [])])]
        : [];
    await validateMembers(tx, ids);
    const [created] =
      await tx`INSERT INTO agents(name,scope,creator_id,all_members) VALUES(${input.name},${input.scope},${a.userId},${input.allMembers ?? false}) RETURNING id`;
    for (const userId of ids)
      await tx`INSERT INTO agent_members(agent_id,user_id) VALUES(${created.id},${userId}) ON CONFLICT DO NOTHING`;
    const [row] = await tx<
      Agent[]
    >`SELECT ${agentFields} FROM agents a WHERE a.id=${created.id}`;
    return row;
  });
  return c.json({ agent }, 201);
});
agentRoutes.get("/agents/:id", async (c) => {
  const a = requireRole(c);
  const id = agentId(c.req.param("id"));
  const rawManage = c.req.query("manage");
  if (rawManage !== undefined && rawManage !== "true" && rawManage !== "false")
    badRequest("Manage must be true or false");
  const manage = rawManage === "true";
  if (manage) {
    requireHuman(c);
    requireRole(c, "member");
  }
  const scope =
    manage && a.role === "admin"
      ? sql`(a.scope='team' OR a.creator_id=${a.userId})`
      : accessible(a.userId);
  const [agent] = await sql<
    Agent[]
  >`SELECT ${agentFields} FROM agents a WHERE a.id=${id} AND ${scope} AND EXISTS(SELECT 1 FROM users WHERE id=${a.userId} AND disabled_at IS NULL)`;
  if (!agent) throw new HTTPException(404, { message: "Agent not found" });
  return c.json({ agent });
});
agentRoutes.patch("/agents/:id", async (c) => {
  requireHuman(c);
  requireRole(c, "member");
  const id = agentId(c.req.param("id")),
    input = await body(c, patch);
  const agent = await sql.begin(async (tx) => {
    const { row, a } = await managed(tx, c, id, input.version);
    if (
      row.scope === "personal" &&
      (input.memberIds !== undefined || input.allMembers !== undefined)
    )
      badRequest("Personal agents are available only to their creator");
    const allMembers = input.allMembers ?? row.allMembers;
    const [creator] =
      await tx`SELECT id FROM users WHERE id=${row.creatorId} AND disabled_at IS NULL FOR SHARE`;
    const ids =
      input.memberIds === undefined
        ? row.memberIds
        : [
            ...new Set([
              ...(creator ? [row.creatorId] : []),
              ...input.memberIds,
            ]),
          ];
    await validateMembers(tx, ids);
    const before = await tx<
      { id: string; boardId: string }[]
    >`SELECT id,board_id FROM tasks WHERE agent_id=${id}`;
    // Expansion must precede grant removal; narrowing follows the final grants.
    if (allMembers && !row.allMembers)
      await tx`UPDATE agents SET all_members=true WHERE id=${id}`;
    if (input.memberIds !== undefined) {
      await tx`DELETE FROM agent_members WHERE agent_id=${id} AND NOT(user_id=ANY(${ids}::uuid[]))`;
      for (const userId of ids)
        await tx`INSERT INTO agent_members(agent_id,user_id) VALUES(${id},${userId}) ON CONFLICT DO NOTHING`;
    }
    await tx`UPDATE agents SET name=${input.name ?? row.name},all_members=${allMembers},version=version+1,updated_at=now() WHERE id=${id}`;
    if (before.length) {
      const cleared = await tx<
        { id: string; boardId: string }[]
      >`SELECT id,board_id FROM tasks WHERE id=ANY(${before.map((task) => task.id)}::uuid[]) AND agent_id IS NULL`;
      for (const task of cleared)
        await recordActivity(
          tx,
          a,
          "task.updated",
          { fields: ["agentId"] },
          task.boardId,
          task.id,
        );
    }
    return (
      await tx<Agent[]>`SELECT ${agentFields} FROM agents a WHERE a.id=${id}`
    )[0];
  });
  return c.json({ agent });
});
agentRoutes.delete("/agents/:id", async (c) => {
  requireHuman(c);
  requireRole(c, "member");
  const id = agentId(c.req.param("id")),
    input = await body(c, z.object({ version }).strict());
  await sql.begin(async (tx) => {
    const { a } = await managed(tx, c, id, input.version);
    const cleared = await tx<
      { id: string; boardId: string }[]
    >`SELECT id,board_id FROM tasks WHERE agent_id=${id}`;
    await tx`DELETE FROM agents WHERE id=${id}`;
    for (const task of cleared)
      await recordActivity(
        tx,
        a,
        "task.updated",
        { fields: ["agentId"] },
        task.boardId,
        task.id,
      );
  });
  return c.json({ ok: true });
});

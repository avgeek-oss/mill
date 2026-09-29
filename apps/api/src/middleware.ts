import {
  createHash,
  createCipheriv,
  createDecipheriv,
  randomBytes,
} from "node:crypto";
import type { Context, MiddlewareHandler } from "hono";
import { HTTPException } from "hono/http-exception";
import {
  sql,
  withDatabaseTransaction,
} from "../../../packages/database/src/index.js";
import { clientAddress, requireRole, type Env } from "./http.js";
import { config } from "./config.js";
import { lockAgentAuthority, requireAgentAccess } from "./agents.js";
class RetryTransactionRollback extends Error {}
function encryptResponse(value: unknown) {
  const iv = randomBytes(12);
  const key = createHash("sha256").update(config().MILL_SECRET).digest();
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const data = Buffer.concat([
    cipher.update(JSON.stringify(value), "utf8"),
    cipher.final(),
  ]);
  return {
    iv: iv.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
    data: data.toString("base64"),
  };
}
function decryptResponse(envelope: { iv: string; tag: string; data: string }) {
  const key = createHash("sha256").update(config().MILL_SECRET).digest();
  const decipher = createDecipheriv(
    "aes-256-gcm",
    key,
    Buffer.from(envelope.iv, "base64"),
  );
  decipher.setAuthTag(Buffer.from(envelope.tag, "base64"));
  return JSON.parse(
    Buffer.concat([
      decipher.update(Buffer.from(envelope.data, "base64")),
      decipher.final(),
    ]).toString("utf8"),
  );
}
export const trustedOrigin: MiddlewareHandler<Env> = async (c, next) => {
  const origin = c.req.header("origin");
  if (origin && origin !== new URL(config().MILL_BASE_URL).origin)
    throw new HTTPException(403, {
      message: "This request came from an untrusted website",
    });
  if (
    !["GET", "HEAD", "OPTIONS"].includes(c.req.method) &&
    c.req.header("cookie") &&
    !origin
  )
    throw new HTTPException(403, {
      message: "A trusted Origin is required for browser changes",
    });
  await next();
};
export const rateLimit: MiddlewareHandler<Env> = async (c, next) => {
  const a = c.get("actor");
  const client = clientAddress(c);
  const key = a ? `actor:${a.credentialId ?? a.userId}` : `anonymous:${client}`;
  const limit = a ? 240 : 120;
  const [r] =
    await sql`INSERT INTO request_limits (key,count,reset_at) VALUES (${key},1,now()+interval '1 minute') ON CONFLICT(key) DO UPDATE SET count=CASE WHEN request_limits.reset_at<now() THEN 1 ELSE request_limits.count+1 END,reset_at=CASE WHEN request_limits.reset_at<now() THEN now()+interval '1 minute' ELSE request_limits.reset_at END RETURNING count,reset_at`;
  if (r.count > limit) {
    c.header("Retry-After", "60");
    throw new HTTPException(429, {
      message: "Too many requests. Try again in a minute.",
    });
  }
  await next();
};
function responseResources(path: string, response: unknown) {
  const boardIds = new Set<string>();
  const taskIds = new Set<string>();
  const agentIds = new Set<string>();
  const validId = (value: unknown): value is string =>
    typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      value,
    );
  const boardId = path.match(/^\/api\/boards\/([^/]+)/)?.[1];
  const taskId = path.match(/^\/api\/tasks\/([^/]+)/)?.[1];
  if (validId(boardId)) boardIds.add(boardId);
  if (validId(taskId)) taskIds.add(taskId);
  const agentId = path.match(/^\/api\/agents\/([^/]+)/)?.[1];
  if (validId(agentId)) agentIds.add(agentId);
  function visit(value: unknown, parent?: string) {
    if (Array.isArray(value)) {
      for (const item of value) visit(item, parent);
    } else if (value && typeof value === "object") {
      for (const [key, item] of Object.entries(value)) {
        if (key === "boardId" && validId(item)) boardIds.add(item);
        if (key === "taskId" && validId(item)) taskIds.add(item);
        if (key === "agentId" && validId(item)) agentIds.add(item);
        if (key === "id" && validId(item)) {
          if (parent === "board" || parent === "boards") boardIds.add(item);
          if (parent === "task" || parent === "tasks") taskIds.add(item);
          if (parent === "agent" || parent === "agents") agentIds.add(item);
        }
        if (key === "boardIds" && Array.isArray(item))
          for (const id of item) if (validId(id)) boardIds.add(id);
        visit(item, key);
      }
    }
  }
  visit(response);
  return {
    boardIds: [...boardIds],
    taskIds: [...taskIds],
    agentIds: [...agentIds],
  };
}
export const idempotency: MiddlewareHandler<Env> = async (c, next) => {
  const key = c.req.header("idempotency-key");
  if (
    !key ||
    !["POST", "PATCH", "DELETE"].includes(c.req.method) ||
    !c.req.path.startsWith("/api/") ||
    c.req.path.startsWith("/api/auth/")
  )
    return next();
  if (!/^[A-Za-z0-9._:-]{8,128}$/.test(key))
    throw new HTTPException(400, {
      message: "Idempotency-Key must be 8–128 letters, numbers or ._:-",
    });
  const actor = c.get("actor");
  if (!actor) throw new HTTPException(401, { message: "Sign in to continue" });
  const actorKey = actor.credentialId ?? actor.userId;
  const requestUrl = new URL(c.req.url);
  const hash = createHash("sha256")
    .update(
      `${c.req.method}\n${requestUrl.pathname}${requestUrl.search}\n${await c.req.raw.clone().text()}`,
    )
    .digest("hex");
  return withDatabaseTransaction(async () => {
    await sql.begin(lockAgentAuthority);
    await currentAuthority(c);
    await sql`DELETE FROM api_idempotency WHERE created_at < now()-interval '24 hours'`;
    const rows =
      await sql`INSERT INTO api_idempotency (actor_key,key,request_hash) VALUES (${actorKey},${key},${hash}) ON CONFLICT DO NOTHING RETURNING key`;
    if (!rows.length) {
      const [existing] =
        await sql`SELECT * FROM api_idempotency WHERE actor_key=${actorKey} AND key=${key}`;
      if (existing.requestHash !== hash)
        throw new HTTPException(409, {
          message: "This retry key was already used for a different request",
        });
      if (!existing.status) {
        c.header("Retry-After", "1");
        throw new HTTPException(409, {
          message: "This request is still being processed. Retry in a moment.",
        });
      }
      c.header("Idempotency-Replayed", "true");
      if (existing.invalidationReason)
        return c.json(
          {
            error:
              existing.invalidationReason === "deleted"
                ? "This work was permanently deleted. Its changes cannot be retried."
                : existing.invalidationReason === "access"
                  ? "Agent access changed. Reload Mill before making a new change."
                  : "This retry was invalidated by an upgrade. Reload Mill before making a new change.",
            code: "retry_invalidated",
          },
          410,
        );
      if ([204, 205, 304].includes(existing.status))
        return c.body(null, existing.status);
      return c.json(decryptResponse(existing.response), existing.status);
    }
    await next();
    const response = await c.res
      .clone()
      .json()
      .catch(() => null);
    if (c.res.status >= 400) throw new RetryTransactionRollback();
    const resources = responseResources(c.req.path, response);
    const consentId = c.req.path.match(
      /^\/api\/oauth\/consent\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i,
    )?.[1];
    if (
      c.req.method === "POST" &&
      actor.kind === "human" &&
      consentId &&
      response &&
      typeof response === "object" &&
      "redirectTo" in response &&
      typeof response.redirectTo === "string"
    ) {
      const [grant] = await sql<
        { agentId: string; boardIds: string[] | null }[]
      >`SELECT agent_id,board_ids FROM oauth_requests WHERE id=${consentId} AND user_id=${actor.userId} AND code_hash IS NOT NULL AND agent_id IS NOT NULL`;
      if (grant) {
        resources.agentIds = [
          ...new Set([...resources.agentIds, grant.agentId]),
        ];
        resources.boardIds = [
          ...new Set([...resources.boardIds, ...(grant.boardIds ?? [])]),
        ];
      }
    }
    await sql`UPDATE api_idempotency SET response=${sql.json(encryptResponse(response))},status=${c.res.status},board_ids=${resources.boardIds},task_ids=${resources.taskIds},agent_ids=${resources.agentIds} WHERE actor_key=${actorKey} AND key=${key}`;
  }).catch((error) => {
    if (!(error instanceof RetryTransactionRollback)) throw error;
  });
};

async function currentAuthority(c: Context<Env>) {
  const a = c.get("actor");
  if (a.credentialId) {
    const [row] =
      await sql`SELECT u.role,c.revoked_at,c.expires_at,u.disabled_at,c.agent_id,c.token_type,c.scopes,c.board_ids FROM credentials c JOIN users u ON u.id=c.user_id WHERE c.id=${a.credentialId} AND u.id=${a.userId} FOR SHARE OF u,c`;
    if (
      !row ||
      row.disabledAt ||
      row.revokedAt ||
      new Date(row.expiresAt).getTime() <= Date.now()
    )
      throw new HTTPException(401, {
        message: "This credential is no longer valid",
      });
    if (row.tokenType === "oauth" && a.kind === "agent" && row.agentId)
      await sql.begin((tx) => requireAgentAccess(tx, a.userId, row.agentId));
    else if (
      row.tokenType !== "api-key" ||
      a.kind !== "human" ||
      row.agentId ||
      row.boardIds !== null ||
      row.scopes.length
    )
      throw new HTTPException(401, {
        message: "This credential is no longer valid",
      });
    if (row.tokenType === "api-key") {
      const domainMutation =
        (c.req.method === "POST" &&
          /^\/api\/boards(?:\/[^/]+\/tasks)?$/.test(c.req.path)) ||
        (["PATCH", "DELETE"].includes(c.req.method) &&
          /^\/api\/(?:boards|tasks|comments)\/[^/]+$/.test(c.req.path)) ||
        (c.req.method === "POST" &&
          /^\/api\/tasks\/[^/]+\/comments$/.test(c.req.path));
      if (domainMutation)
        requireRole(
          c,
          c.req.method === "DELETE" && /^\/api\/boards\/[^/]+$/.test(c.req.path)
            ? "admin"
            : "member",
        );
    }
    if (row.role !== a.role)
      throw new HTTPException(403, {
        message: "Your permissions changed. Reload Mill before trying again.",
      });
  } else {
    const token = c.req
      .header("cookie")
      ?.match(/(?:^|;\s*)mill_session=([A-Za-z0-9_-]{43})(?:;|$)/)?.[1];
    if (!token)
      throw new HTTPException(401, { message: "Sign in to continue" });
    const hash = createHash("sha256").update(token).digest("hex");
    const [row] =
      await sql`SELECT u.role,u.disabled_at,s.expires_at,u.security_epoch AS user_epoch,s.security_epoch AS session_epoch FROM users u JOIN sessions s ON s.user_id=u.id WHERE u.id=${a.userId} AND s.token_hash=${hash} FOR SHARE OF u,s`;
    if (
      !row ||
      row.disabledAt ||
      new Date(row.expiresAt).getTime() <= Date.now() ||
      row.userEpoch !== row.sessionEpoch
    )
      throw new HTTPException(401, {
        message: "Your session expired. Sign in again.",
      });
    if (row.role !== a.role)
      throw new HTTPException(403, {
        message: "Your permissions changed. Reload Mill before trying again.",
      });
  }
}
export const mutationAuthority: MiddlewareHandler<Env> = async (c, next) => {
  if (
    !c.get("actor") ||
    c.req.path.startsWith("/api/auth/") ||
    !["POST", "PATCH", "DELETE"].includes(c.req.method)
  )
    return next();
  return withDatabaseTransaction(async () => {
    await sql.begin(lockAgentAuthority);
    await next();
    if (c.res.status >= 400) throw new RetryTransactionRollback();
    await currentAuthority(c);
  }).catch((error) => {
    if (!(error instanceof RetryTransactionRollback)) throw error;
  });
};

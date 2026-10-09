import type { Actor, Role } from "../../../../packages/contracts/src/index.js";
import { AsyncLocalStorage } from "node:async_hooks";
import { sql } from "../../../../packages/database/src/index.js";
import { badRequest } from "../http.js";
import { HTTPException } from "hono/http-exception";
import type { Tx } from "../domain/helpers.js";
import { lockAuthority } from "../authority.js";
import { digest, mcpResource, secret } from "./protocol.js";

export type Credential = {
  id: string;
  userId: string | null;
  createdBy: string;
  name: string;
  tokenPrefix: string;
  scopes: string[];
  boardIds: string[] | null;
  tokenType: "api-key" | "oauth";
  oauthClientId: string | null;
  createdAt: Date;
  expiresAt: Date | null;
  accessLevel: "read" | "edit";
  includeAdmin: boolean;
  lastUsedAt: Date | null;
  revokedAt: Date | null;
};
export type CredentialInput = {
  name: string;
  access: "read" | "edit";
  includeAdmin: boolean;
  expiresAt: string | null;
};
export type CredentialScope = "personal" | "team";
// Only in-process MCP dispatch can use a resource-bound OAuth token on REST handlers.
export const mcpDispatchRequests = new WeakSet<Request>();
export const mcpDispatchTokens = new AsyncLocalStorage<string>();

export async function listCredentials(
  a: Actor,
  limit: number,
  cursor?: string,
  scope: CredentialScope = "personal",
) {
  const owner =
    scope === "personal"
      ? sql`user_id=${a.userId}`
      : sql`user_id IS NULL AND token_type='api-key'`;
  const [anchor] = cursor
    ? await sql`SELECT id FROM credentials WHERE id=${cursor} AND ${owner}`
    : [];
  if (cursor && !anchor)
    badRequest("This credential cursor does not belong to your account");
  const rows = await sql<
    Credential[]
  >`SELECT c.id,c.user_id,c.created_by,c.name,c.token_prefix,c.scopes,c.board_ids,c.token_type,c.oauth_client_id,c.created_at,c.expires_at,c.access_level,c.include_admin,c.last_used_at,c.revoked_at FROM credentials c WHERE ${owner} AND c.revoked_at IS NULL ${anchor ? sql`AND (c.created_at,c.id)<(SELECT created_at,id FROM credentials WHERE id=${anchor.id} AND ${owner})` : sql``} ORDER BY c.created_at DESC,c.id DESC LIMIT ${limit + 1}`;
  const items = rows.slice(0, limit);
  const hasMore = rows.length > limit;
  return { items, hasMore, nextCursor: hasMore ? items.at(-1)!.id : null };
}
export async function validateBoards(boardIds: string[] | undefined, tx: Tx) {
  if (boardIds === undefined) return;
  const boards =
    await tx`SELECT id FROM boards WHERE id = ANY(${boardIds}::uuid[]) ORDER BY id FOR SHARE`;
  if (boards.length !== boardIds.length)
    throw new Error("Choose existing boards");
}
export async function createCredential(
  a: Actor,
  input: CredentialInput,
  scope: CredentialScope = "personal",
) {
  return sql.begin(async (tx) => {
    await lockAuthority(tx);
    const [owner] = await tx<
      { role: Role }[]
    >`SELECT role FROM users WHERE id=${a.userId} AND disabled_at IS NULL FOR SHARE`;
    if (
      !owner ||
      a.kind !== "human" ||
      a.credentialId ||
      (scope === "team" && owner.role !== "admin") ||
      (input.access === "edit" && owner.role === "viewer") ||
      (input.includeAdmin &&
        (owner.role !== "admin" || input.access !== "edit")) ||
      (input.expiresAt === null && owner.role !== "admin")
    )
      throw new HTTPException(403, {
        message: "These API key permissions exceed your role",
      });
    let expiresAt: Date | null = null;
    if (input.expiresAt !== null) {
      expiresAt = new Date(input.expiresAt);
      if (
        !Number.isFinite(expiresAt.getTime()) ||
        expiresAt.getTime() - Date.now() < 86400000
      )
        badRequest("Choose an expiry at least one day from now");
    }
    const token = `mill_${secret()}`;
    const [credential] = await tx<
      Credential[]
    >`INSERT INTO credentials(user_id,created_by,name,token_hash,token_prefix,scopes,expires_at,access_level,include_admin) VALUES(${scope === "personal" ? a.userId : null},${a.userId},${input.name},${digest(token)},${token.slice(0, 12)},'{}'::text[],${expiresAt},${input.access},${input.includeAdmin}) RETURNING id,user_id,created_by,name,token_prefix,scopes,board_ids,token_type,oauth_client_id,created_at,expires_at,access_level,include_admin,last_used_at,revoked_at`;

    return { credential: credential!, token };
  });
}
export async function revokeCredential(
  a: Actor,
  id: string,
  scope: CredentialScope = "personal",
) {
  const [credential] =
    await sql`UPDATE credentials SET revoked_at=COALESCE(revoked_at,now()) WHERE id=${id} AND ${scope === "personal" ? sql`user_id=${a.userId}` : sql`user_id IS NULL AND token_type='api-key'`} RETURNING id,name`;
  if (!credential) return false;

  return true;
}
export async function credentialActor(request: Request): Promise<Actor | null> {
  const authorization = request.headers.get("authorization");
  if (!authorization?.startsWith("Bearer ")) return null;
  const token = authorization.slice(7);
  if (!/^mill_[A-Za-z0-9_-]{43}$/.test(token)) return null;
  const [principal] = await sql<
    {
      id: string;
      name: string;
      userId: string;
      userName: string;
      role: Role | null;
      scopes: string[];
      boardIds: string[] | null;
      tokenType: string;
      resource: string | null;
      lastUsedAt: Date | null;
      accessLevel: "read" | "edit";
      includeAdmin: boolean;
    }[]
  >`SELECT c.id,c.name,COALESCE(c.user_id,c.created_by) AS user_id,CASE WHEN c.user_id IS NULL THEN 'Team API key: '||c.name ELSE u.name END AS user_name,u.role,c.scopes,c.board_ids,c.token_type,c.resource,c.last_used_at,c.access_level,c.include_admin FROM credentials c LEFT JOIN users u ON u.id=c.user_id WHERE c.token_hash=${digest(token)} AND c.revoked_at IS NULL AND (c.expires_at IS NULL OR c.expires_at>now()) AND (c.user_id IS NULL OR u.disabled_at IS NULL)`;
  if (!principal) return null;
  const url = new URL(request.url);
  let result: Actor;
  if (principal.tokenType === "api-key") {
    if (principal.boardIds !== null || principal.scopes.length) return null;
    if (url.pathname === "/mcp") return null;
    if (
      /^\/api\/(?:auth|oauth|credentials|team-credentials|workspace)(?:\/|$)/.test(
        url.pathname,
      ) ||
      (principal.role === null &&
        url.pathname.startsWith("/api/notifications")) ||
      url.pathname.startsWith("/oauth/")
    )
      throw new HTTPException(403, {
        message: "Use a signed-in account for this action",
      });
    result = {
      userId: principal.userId,
      name: principal.userName,
      role:
        principal.role ??
        (principal.includeAdmin
          ? "admin"
          : principal.accessLevel === "edit"
            ? "member"
            : "viewer"),
      kind: principal.role ? "human" : "team",
      scopes: principal.accessLevel === "edit" ? ["read", "write"] : ["read"],
      includeAdmin: principal.includeAdmin,
      credentialId: principal.id,
      credentialType: "api-key",
    };
  } else if (principal.tokenType === "oauth") {
    if (principal.resource !== mcpResource()) return null;
    if (
      url.pathname !== "/mcp" &&
      !mcpDispatchRequests.has(request) &&
      mcpDispatchTokens.getStore() !== digest(token)
    )
      throw new HTTPException(403, {
        message: "OAuth credentials use MCP",
      });
    result = {
      userId: principal.userId,
      name: principal.userName,
      role: principal.role!,
      kind: "oauth",
      scopes: principal.scopes,
      credentialId: principal.id,
      credentialType: "oauth",
      boardIds: principal.boardIds ?? undefined,
    };
  } else return null;
  // A token never holds permissions beyond its owner's current membership.
  if (
    !principal.lastUsedAt ||
    principal.lastUsedAt.getTime() < Date.now() - 300000
  )
    await sql`UPDATE credentials SET last_used_at=now() WHERE id=${principal.id} AND (last_used_at IS NULL OR last_used_at<now()-interval '5 minutes')`;
  return result;
}

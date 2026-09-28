import type { Actor, Role } from "../../../../packages/contracts/src/index.js";
import type postgres from "postgres";
import { AsyncLocalStorage } from "node:async_hooks";
import { sql } from "../../../../packages/database/src/index.js";
import { badRequest } from "../http.js";
import { HTTPException } from "hono/http-exception";
import type { Tx } from "../domain/helpers.js";
import { digest, mcpResource, secret } from "./protocol.js";

export type Credential = {
  id: string;
  userId: string;
  name: string;
  tokenPrefix: string;
  scopes: string[];
  boardIds: string[] | null;
  tokenType: "api-key" | "oauth";
  oauthClientId: string | null;
  createdAt: Date;
  expiresAt: Date;
  lastUsedAt: Date | null;
  revokedAt: Date | null;
};
export type CredentialInput = {
  name: string;
  scopes: string[];
  boardIds?: string[];
  expiresInDays: number;
};
// Only in-process MCP dispatch can use a resource-bound OAuth token on REST handlers.
export const mcpDispatchRequests = new WeakSet<Request>();
export const mcpDispatchTokens = new AsyncLocalStorage<string>();
export async function externalAudit(
  a: Actor,
  action: string,
  detail: Record<string, unknown>,
) {
  await sql`INSERT INTO activity(actor_id,actor_name,actor_kind,action,detail) VALUES(${a.userId},${a.name},${a.kind},${action},${sql.json(detail as postgres.JSONValue)})`;
}
export async function listCredentials(
  a: Actor,
  limit: number,
  cursor?: string,
) {
  const [anchor] = cursor
    ? await sql`SELECT id FROM credentials WHERE id=${cursor} AND user_id=${a.userId}`
    : [];
  if (cursor && !anchor)
    badRequest("This credential cursor does not belong to your account");
  const rows = await sql<
    Credential[]
  >`SELECT id,user_id,name,token_prefix,scopes,board_ids,token_type,oauth_client_id,created_at,expires_at,last_used_at,revoked_at FROM credentials WHERE user_id=${a.userId} ${anchor ? sql`AND (created_at,id)<(SELECT created_at,id FROM credentials WHERE id=${anchor.id} AND user_id=${a.userId})` : sql``} ORDER BY created_at DESC,id DESC LIMIT ${limit + 1}`;
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
export async function createCredential(a: Actor, input: CredentialInput) {
  return sql.begin(async (tx) => {
    await validateBoards(input.boardIds, tx);
    const [owner] = await tx<
      { role: Role; name: string }[]
    >`SELECT role,name FROM users WHERE id=${a.userId} AND disabled_at IS NULL FOR SHARE`;
    if (!owner || a.kind !== "human")
      throw new HTTPException(403, {
        message: "Your membership no longer permits this action",
      });
    if (owner.role === "viewer" && input.scopes.includes("write"))
      throw new HTTPException(403, {
        message: "Viewer accounts can only grant read access",
      });
    const token = `mill_${secret()}`;
    const [credential] = await tx<
      Credential[]
    >`INSERT INTO credentials(user_id,name,token_hash,token_prefix,scopes,board_ids,expires_at) VALUES(${a.userId},${input.name},${digest(token)},${token.slice(0, 12)},${input.scopes},${input.boardIds ?? null},${new Date(Date.now() + input.expiresInDays * 86400000)}) RETURNING id,user_id,name,token_prefix,scopes,board_ids,token_type,oauth_client_id,created_at,expires_at,last_used_at,revoked_at`;
    await tx`INSERT INTO activity(actor_id,actor_name,actor_kind,action,detail) VALUES(${a.userId},${owner.name},'human','credential.created',${tx.json({ credentialId: credential!.id, name: input.name, scopes: input.scopes, boardIds: input.boardIds ?? null })})`;
    return { credential: credential!, token };
  });
}
export async function revokeCredential(a: Actor, id: string) {
  const [credential] =
    await sql`UPDATE credentials SET revoked_at=COALESCE(revoked_at,now()) WHERE id=${id} AND user_id=${a.userId} RETURNING id,name`;
  if (!credential) return false;
  await externalAudit(a, "credential.revoked", {
    credentialId: id,
    name: credential.name,
  });
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
      role: Role;
      scopes: string[];
      boardIds: string[] | null;
      tokenType: string;
      resource: string | null;
    }[]
  >`SELECT c.id,c.name,c.user_id,u.name AS user_name,u.role,c.scopes,c.board_ids,c.token_type,c.resource FROM credentials c JOIN users u ON u.id=c.user_id WHERE c.token_hash=${digest(token)} AND c.revoked_at IS NULL AND c.expires_at>now() AND u.disabled_at IS NULL`;
  if (
    !principal ||
    (principal.tokenType === "oauth" &&
      (principal.resource !== mcpResource() ||
        (new URL(request.url).pathname !== "/mcp" &&
          !mcpDispatchRequests.has(request) &&
          mcpDispatchTokens.getStore() !== digest(token))))
  )
    return null;
  // A token never holds permissions beyond its owner's current membership.
  await sql`UPDATE credentials SET last_used_at=now() WHERE id=${principal.id} AND (last_used_at IS NULL OR last_used_at<now()-interval '5 minutes')`;
  return {
    userId: principal.userId,
    name: `${principal.userName} via ${principal.name}`,
    role: principal.role,
    kind: "agent",
    scopes: principal.scopes,
    credentialId: principal.id,
    ...(principal.boardIds ? { boardIds: principal.boardIds } : {}),
  };
}

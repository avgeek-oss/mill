import type { Actor, Role } from "../../../../packages/contracts/src/index.js";
import type postgres from "postgres";
import { AsyncLocalStorage } from "node:async_hooks";
import { sql } from "../../../../packages/database/src/index.js";
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
export async function listCredentials(a: Actor) {
  return sql<
    Credential[]
  >`SELECT id,user_id,name,token_prefix,scopes,board_ids,token_type,oauth_client_id,created_at,expires_at,last_used_at,revoked_at FROM credentials WHERE user_id=${a.userId} ORDER BY created_at DESC LIMIT 200`;
}
export async function validateBoards(boardIds: string[] | undefined) {
  if (boardIds === undefined) return;
  const boards =
    await sql`SELECT id FROM boards WHERE id = ANY(${boardIds}::uuid[]) AND deleted_at IS NULL`;
  if (boards.length !== boardIds.length)
    throw new Error("Choose existing boards");
}
export async function createCredential(a: Actor, input: CredentialInput) {
  if (a.role === "viewer" && input.scopes.includes("write"))
    throw new Error("Viewer accounts can only grant read access");
  await validateBoards(input.boardIds);
  const token = `mill_${secret()}`;
  const [credential] = await sql<
    Credential[]
  >`INSERT INTO credentials(user_id,name,token_hash,token_prefix,scopes,board_ids,expires_at) VALUES(${a.userId},${input.name},${digest(token)},${token.slice(0, 12)},${input.scopes},${input.boardIds ?? null},${new Date(Date.now() + input.expiresInDays * 86400000)}) RETURNING id,user_id,name,token_prefix,scopes,board_ids,token_type,oauth_client_id,created_at,expires_at,last_used_at,revoked_at`;
  await externalAudit(a, "credential.created", {
    credentialId: credential!.id,
    name: input.name,
    scopes: input.scopes,
    boardIds: input.boardIds ?? null,
  });
  return { credential: credential!, token };
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

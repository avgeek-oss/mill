import { sql } from "../../../../packages/database/src/index.js";
import type { Actor, Role } from "../../../../packages/contracts/src/index.js";
import { resolveClient } from "./clients.js";
import { lockAuthority } from "../authority.js";
import {
  allowedAccess,
  isCanonicalScope,
  scopeForAccess,
  type ConsentAccess,
} from "./access.js";
import {
  authorizationResponse,
  digest,
  equalHash,
  mcpResource,
  OAuthError,
  parseScope,
  registeredRedirectUri,
  requireResource,
  secret,
  tokenLifetimeSeconds,
} from "./protocol.js";

type Grant = {
  id: string;
  clientId: string;
  clientName: string;
  clientTrust: string;
  redirectUri: string;
  resource: string;
  scope: string;
  state: string | null;
  challenge: string;
  userId: string | null;
  boardIds: string[] | null;
  codeHash: string | null;
  approvedRole: Role | null;
  reviewedRole: Role | null;
  credentialId: string | null;
  expiresAt: Date;
  consumedAt: Date | null;
};
export async function beginAuthorization(params: Record<string, string>) {
  const client = await resolveClient(params.client_id ?? "");
  if (
    !params.redirect_uri ||
    !registeredRedirectUri(client.redirectUris, params.redirect_uri)
  )
    throw new OAuthError(
      "invalid_request",
      "The redirect URI is not registered for this client",
    );
  let scope: string;
  try {
    if (params.response_type !== "code")
      throw new OAuthError(
        "unsupported_response_type",
        "Only authorization code responses are supported",
      );
    if (
      params.code_challenge_method !== "S256" ||
      !/^[A-Za-z0-9_-]{43}$/.test(params.code_challenge ?? "")
    )
      throw new OAuthError("invalid_request", "S256 PKCE is required");
    requireResource(params.resource);
    scope = parseScope(params.scope);
    if ((params.state?.length ?? 0) > 2048)
      throw new OAuthError("invalid_request", "State is too long");
  } catch (error) {
    if (!(error instanceof OAuthError)) throw error;
    return {
      redirectTo: authorizationResponse(
        {
          redirectUri: params.redirect_uri,
          state:
            (params.state?.length ?? 0) <= 2048 ? (params.state ?? null) : null,
        },
        { error: error.code },
      ),
    };
  }
  await sql`DELETE FROM oauth_requests WHERE expires_at<now()-interval '31 days' OR (code_hash IS NULL AND expires_at<now())`;
  const [grant] =
    await sql`INSERT INTO oauth_requests(client_id,client_name,client_trust,redirect_uri,resource,scope,state,challenge,expires_at) VALUES(${client.id},${client.name},${client.trust},${params.redirect_uri},${mcpResource()},${scope},${params.state ?? null},${params.code_challenge!},${new Date(Date.now() + 600000)}) RETURNING id`;
  return { requestId: String(grant!.id) };
}
export async function consentDetails(id: string, a: Actor) {
  return sql.begin(async (tx) => {
    await lockAuthority(tx);
    const [user] = await tx<
      { role: Role; name: string }[]
    >`SELECT role,name FROM users WHERE id=${a.userId} AND disabled_at IS NULL FOR SHARE`;
    const [grant] = await tx<
      Grant[]
    >`SELECT * FROM oauth_requests WHERE id=${id} AND expires_at>now() AND code_hash IS NULL AND consumed_at IS NULL FOR UPDATE`;
    if (!user || !grant || (grant.userId && grant.userId !== a.userId))
      throw new OAuthError(
        "invalid_request",
        "This connection link has expired or was already used. Start again from your app.",
      );
    await tx`UPDATE oauth_requests SET user_id=${a.userId},reviewed_role=${user.role} WHERE id=${id}`;
    return {
      clientName: grant.clientName,
      clientId: grant.clientId,
      clientTrust: grant.clientTrust,
      redirectUri: grant.redirectUri,
      scope: grant.scope,
      expiresIn: tokenLifetimeSeconds,
      user: { name: user.name, role: user.role },
      availableAccessLevels: allowedAccess(user.role),
      canApprove: true,
    };
  });
}
export async function decideConsent(
  id: string,
  a: Actor,
  allow: boolean,
  accessLevel?: ConsentAccess,
) {
  if (a.kind !== "human" || a.credentialId)
    throw new OAuthError(
      "access_denied",
      "Consent requires a personal account",
      403,
    );
  return sql.begin(async (tx) => {
    await lockAuthority(tx);
    const [user] = await tx<
      { role: Role }[]
    >`SELECT role FROM users WHERE id=${a.userId} AND disabled_at IS NULL FOR SHARE`;
    const [grant] = await tx<
      Grant[]
    >`SELECT * FROM oauth_requests WHERE id=${id} FOR UPDATE`;
    if (
      !user ||
      !grant ||
      (grant.userId && grant.userId !== a.userId) ||
      (grant.reviewedRole && grant.reviewedRole !== user.role) ||
      grant.expiresAt <= new Date() ||
      grant.codeHash ||
      grant.consumedAt
    )
      throw new OAuthError(
        "invalid_request",
        "This connection link has expired or was already used. Start again from your app.",
      );
    if (!allow) {
      await tx`UPDATE oauth_requests SET consumed_at=now() WHERE id=${id}`;

      return authorizationResponse(grant, { error: "access_denied" });
    }
    if (!accessLevel || !allowedAccess(user.role).includes(accessLevel))
      throw new OAuthError(
        "access_denied",
        "Selected access exceeds your current role",
        403,
      );
    const code = secret();
    await tx`UPDATE oauth_requests SET user_id=${a.userId},approved_role=${user.role},scope=${scopeForAccess(accessLevel)},board_ids=NULL,code_hash=${digest(code)},expires_at=${new Date(Date.now() + 120000)} WHERE id=${id}`;

    return authorizationResponse(grant, { code });
  });
}
export async function exchangeCode(
  clientId: string,
  params: Record<string, string>,
) {
  if (params.grant_type !== "authorization_code")
    throw new OAuthError(
      "unsupported_grant_type",
      "Authorize again to obtain a new token",
    );
  requireResource(params.resource);
  if (!/^[A-Za-z0-9._~-]{43,128}$/.test(params.code_verifier ?? ""))
    throw new OAuthError("invalid_grant", "Invalid PKCE verifier");
  const result = await sql.begin(async (tx) => {
    await lockAuthority(tx);
    const [grant] = await tx<
      Grant[]
    >`SELECT * FROM oauth_requests WHERE code_hash=${digest(params.code ?? "")} FOR UPDATE`;
    if (
      !grant ||
      grant.clientId !== clientId ||
      grant.redirectUri !== params.redirect_uri ||
      grant.resource !== mcpResource() ||
      !isCanonicalScope(grant.scope) ||
      !equalHash(digest(params.code_verifier!), grant.challenge)
    )
      return null;
    if (grant.consumedAt) {
      if (grant.credentialId) {
        await tx`UPDATE credentials SET revoked_at=COALESCE(revoked_at,now()) WHERE id=${grant.credentialId}`;
      }
      return null;
    }
    if (grant.expiresAt <= new Date() || !grant.userId) return null;
    const [user] = await tx<
      { role: Role; name: string }[]
    >`SELECT role,name FROM users WHERE id=${grant.userId} AND disabled_at IS NULL FOR SHARE`;
    if (
      !user ||
      grant.approvedRole !== user.role ||
      (user.role === "viewer" && grant.scope.includes("member")) ||
      (grant.scope.includes("admin") && user.role !== "admin")
    )
      return null;
    if (grant.boardIds !== null) {
      const boards =
        await tx`SELECT id FROM boards WHERE id=ANY(${grant.boardIds}::uuid[]) FOR SHARE`;
      if (!grant.boardIds.length || boards.length !== grant.boardIds.length) {
        await tx`UPDATE oauth_requests SET consumed_at=now() WHERE id=${grant.id}`;
        return null;
      }
    }
    const token = `mill_${secret()}`;
    const [credential] =
      await tx`INSERT INTO credentials(user_id,created_by,name,token_hash,token_prefix,scopes,board_ids,token_type,oauth_client_id,resource,expires_at,access_level,include_admin) VALUES(${grant.userId},${grant.userId},${grant.clientName},${digest(token)},${token.slice(0, 12)},${grant.scope.split(" ")},${grant.boardIds},'oauth',${clientId},${mcpResource()},${new Date(Date.now() + tokenLifetimeSeconds * 1000)},${grant.scope.includes("member") ? "edit" : "read"},${grant.scope.includes("admin")}) RETURNING id`;
    await tx`UPDATE oauth_requests SET consumed_at=now(),credential_id=${credential!.id} WHERE id=${grant.id}`;

    return {
      access_token: token,
      token_type: "Bearer",
      expires_in: tokenLifetimeSeconds,
      scope: grant.scope,
    };
  });
  if (!result)
    throw new OAuthError(
      "invalid_grant",
      "Authorization code is invalid, expired, or already used",
    );
  return result;
}
export async function revokeOAuthToken(clientId: string, token: string) {
  await sql.begin(async (tx) => {
    await lockAuthority(tx);
    await tx`UPDATE credentials SET revoked_at=now() WHERE token_hash=${digest(token)} AND oauth_client_id=${clientId} AND token_type='oauth' AND revoked_at IS NULL`;
  });
}

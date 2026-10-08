import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { cors } from "hono/cors";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import { badRequest, requireHuman, handleError, type Env } from "./http.js";
import { authenticateClient, registerClient } from "./external/clients.js";
import {
  createCredential,
  listCredentials,
  revokeCredential,
} from "./external/credentials.js";
import {
  beginAuthorization,
  consentDetails,
  decideConsent,
  exchangeCode,
  revokeOAuthToken,
} from "./external/oauth.js";
import {
  externalAccessAllowed,
  issuer,
  mcpResource,
  OAuthError,
  resourceMetadataUrl,
  uniqueParameters,
} from "./external/protocol.js";
import { serveMcp } from "./external/mcp.js";
import { recentSession } from "./auth/model.js";
import { appOrigin } from "./auth/security.js";
export { credentialActor } from "./external/credentials.js";
export { setApiDispatcher } from "./external/mcp.js";

export const externalRoutes = new Hono<Env>();
for (const path of [
  "/api/credentials",
  "/api/credentials/*",
  "/api/team-credentials",
  "/api/team-credentials/*",
])
  externalRoutes.use(path, async (c, next) => {
    c.header("Cache-Control", "no-store");
    c.header("Pragma", "no-cache");
    await next();
  });
externalRoutes.onError((error, c) => {
  if (error instanceof OAuthError) {
    if (error.status === 401)
      c.header("WWW-Authenticate", 'Basic realm="Mill OAuth"');
    return c.json(
      { error: error.code, error_description: error.message },
      error.status,
    );
  }
  return handleError(error, c);
});
for (const path of ["/.well-known/*", "/oauth/*", "/api/oauth/*", "/mcp"]) {
  externalRoutes.use(path, async (c, next) => {
    c.header("Cache-Control", "no-store");
    c.header("Pragma", "no-cache");
    c.header("Referrer-Policy", "no-referrer");
    if (!externalAccessAllowed())
      return c.json({ error: "HTTPS is required for external access" }, 403);
    await next();
  });
}
for (const path of [
  "/oauth/*",
  "/api/oauth/*",
  "/api/credentials*",
  "/api/team-credentials*",
])
  externalRoutes.use(
    path,
    bodyLimit({
      maxSize: 16384,
      onError: (c) => c.json({ error: "Request is too large" }, 413),
    }),
  );
externalRoutes.use(
  "/mcp",
  bodyLimit({
    maxSize: 1024 * 1024,
    onError: (c) => c.json({ error: "Request is too large" }, 413),
  }),
);
for (const scope of ["personal", "team"] as const) {
  const route =
    scope === "personal" ? "/api/credentials" : "/api/team-credentials";
  externalRoutes.get(route, async (c) => {
    const who = requireHuman(c);
    if (scope === "team" && who.role !== "admin")
      throw new HTTPException(403, {
        message: "Only administrators can manage team API keys",
      });
    const query = z
      .object({
        limit: z.coerce.number().int().min(1).max(200).default(200),
        cursor: z.uuid().optional(),
      })
      .safeParse(c.req.query());
    if (!query.success)
      badRequest("Choose a limit from 1 to 200 and a valid credential cursor");
    return c.json(
      await listCredentials(who, query.data.limit, query.data.cursor, scope),
    );
  });
  externalRoutes.post(route, async (c) => {
    const a = requireHuman(c);
    if (scope === "team" && a.role !== "admin")
      throw new HTTPException(403, {
        message: "Only administrators can manage team API keys",
      });
    const parsed = z
      .object({
        name: z.string().trim().min(1).max(120),
        access: z.enum(["read", "edit"]),
        includeAdmin: z.boolean(),
        expiresAt: z.iso.datetime().nullable(),
      })
      .strict()
      .safeParse(await c.req.json());
    if (!parsed.success)
      badRequest("Choose a name, permissions, and an expiry");
    await recentSession(c);
    return c.json(await createCredential(a, parsed.data, scope), 201);
  });
  externalRoutes.delete(`${route}/:id`, async (c) => {
    const a = requireHuman(c),
      id = z.uuid().safeParse(c.req.param("id"));
    if (scope === "team" && a.role !== "admin")
      throw new HTTPException(403, {
        message: "Only administrators can manage team API keys",
      });
    if (!id.success) badRequest("Invalid credential");
    if (scope === "team") await recentSession(c);
    if (!(await revokeCredential(a, id.data, scope)))
      throw new HTTPException(404, { message: "Credential not found" });
    return c.json({ revoked: true });
  });
}
externalRoutes.use(
  "/.well-known/*",
  cors({ origin: "*", allowMethods: ["GET", "OPTIONS"] }),
);
externalRoutes.get("/.well-known/oauth-authorization-server", (c) =>
  c.json({
    issuer: issuer(),
    authorization_endpoint: `${issuer()}/oauth/authorize`,
    token_endpoint: `${issuer()}/oauth/token`,
    registration_endpoint: `${issuer()}/oauth/register`,
    revocation_endpoint: `${issuer()}/oauth/revoke`,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code"],
    code_challenge_methods_supported: ["S256"],
    scopes_supported: ["read", "write"],
    token_endpoint_auth_methods_supported: [
      "none",
      "client_secret_basic",
      "client_secret_post",
    ],
    revocation_endpoint_auth_methods_supported: [
      "none",
      "client_secret_basic",
      "client_secret_post",
    ],
    client_id_metadata_document_supported: true,
    authorization_response_iss_parameter_supported: true,
  }),
);
for (const path of [
  "/.well-known/oauth-protected-resource",
  "/.well-known/oauth-protected-resource/mcp",
])
  externalRoutes.get(path, (c) =>
    c.json({
      resource: mcpResource(),
      authorization_servers: [issuer()],
      scopes_supported: ["read", "write"],
      bearer_methods_supported: ["header"],
      resource_name: "Mill MCP",
    }),
  );
for (const path of ["/oauth/register", "/oauth/token", "/oauth/revoke"])
  externalRoutes.use(
    path,
    cors({
      origin: "*",
      allowMethods: ["POST", "OPTIONS"],
      allowHeaders: ["Content-Type", "Authorization"],
    }),
  );
externalRoutes.post("/oauth/register", async (c) => {
  if (!c.req.header("content-type")?.startsWith("application/json"))
    throw new OAuthError("invalid_request", "Use application/json");
  return c.json(await registerClient(await c.req.json()), 201);
});
externalRoutes.get("/oauth/authorize", async (c) => {
  const result = await beginAuthorization(
    uniqueParameters(new URL(c.req.url).searchParams),
  );
  return c.redirect(
    result.redirectTo ??
      `${appOrigin()}/oauth/consent?request=${result.requestId}`,
    302,
  );
});
externalRoutes.get("/api/oauth/consent/:id", async (c) => {
  const a = requireHuman(c),
    id = z.uuid().safeParse(c.req.param("id"));
  if (!id.success)
    throw new OAuthError("invalid_request", "Invalid authorization request");
  return c.json(await consentDetails(id.data, a));
});
externalRoutes.post("/api/oauth/consent/:id", async (c) => {
  const a = requireHuman(c),
    id = z.uuid().safeParse(c.req.param("id"));
  if (!id.success)
    throw new OAuthError("invalid_request", "Invalid authorization request");
  const parsed = z
    .object({
      allow: z.boolean(),
      boardIds: z
        .array(z.uuid())
        .min(1)
        .max(100)
        .refine((ids) => new Set(ids).size === ids.length)
        .optional(),
    })
    .strict()
    .safeParse(await c.req.json());
  if (!parsed.success)
    throw new OAuthError("invalid_request", "Choose whether to allow access");
  if (parsed.data.allow) await recentSession(c);
  try {
    return c.json({
      redirectTo: await decideConsent(
        id.data,
        a,
        parsed.data.allow,
        parsed.data.boardIds,
      ),
    });
  } catch (error) {
    if (error instanceof Error && error.message === "Choose existing boards")
      throw new OAuthError("invalid_request", error.message);
    throw error;
  }
});
async function readForm(request: Request) {
  if (
    !request.headers
      .get("content-type")
      ?.startsWith("application/x-www-form-urlencoded")
  )
    throw new OAuthError(
      "invalid_request",
      "Use application/x-www-form-urlencoded",
    );
  return uniqueParameters(new URLSearchParams(await request.text()));
}
externalRoutes.post("/oauth/token", async (c) => {
  const params = await readForm(c.req.raw),
    client = await authenticateClient(params, c.req.header("authorization"));
  return c.json(await exchangeCode(client.id, params));
});
externalRoutes.post("/oauth/revoke", async (c) => {
  const params = await readForm(c.req.raw),
    client = await authenticateClient(params, c.req.header("authorization"));
  if (!params.token)
    throw new OAuthError("invalid_request", "A token is required");
  await revokeOAuthToken(client.id, params.token);
  return c.body(null, 200);
});
externalRoutes.use(
  "/mcp",
  cors({
    origin: "*",
    allowMethods: ["GET", "POST", "DELETE", "OPTIONS"],
    allowHeaders: [
      "Content-Type",
      "Authorization",
      "MCP-Protocol-Version",
      "Mcp-Session-Id",
      "Last-Event-ID",
    ],
    exposeHeaders: [
      "WWW-Authenticate",
      "MCP-Protocol-Version",
      "Mcp-Session-Id",
    ],
  }),
);
externalRoutes.all("/mcp", async (c) => {
  if (!c.get("actor")) {
    c.header(
      "WWW-Authenticate",
      `Bearer resource_metadata="${resourceMetadataUrl()}"`,
    );
    return c.json(
      { error: "A valid API key or OAuth credential is required" },
      401,
    );
  }
  return serveMcp(c);
});

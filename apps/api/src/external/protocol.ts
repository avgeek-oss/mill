import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { z } from "zod";

export const tokenLifetimeSeconds = 30 * 86400;
export const secret = () => randomBytes(32).toString("base64url");
export const digest = (value: string) =>
  createHash("sha256").update(value).digest("base64url");
export const equalHash = (a: string, b: string) =>
  timingSafeEqual(Buffer.from(digest(a)), Buffer.from(digest(b)));
export function issuer() {
  const raw = process.env.MILL_API_URL;
  if (!raw) throw new Error("MILL_API_URL is required");
  return new URL(raw).origin;
}
export const mcpResource = () => `${issuer()}/mcp`;
export const resourceMetadataUrl = () =>
  `${issuer()}/.well-known/oauth-protected-resource/mcp`;
export function externalAccessAllowed() {
  const url = new URL(issuer());
  return (
    url.protocol === "https:" ||
    (url.protocol === "http:" &&
      ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))
  );
}
export class OAuthError extends Error {
  constructor(
    public code: string,
    message: string,
    public status: 400 | 401 | 403 = 400,
  ) {
    super(message);
  }
}
export function validRedirectUri(raw: string) {
  try {
    const url = new URL(raw);
    return (
      !url.username &&
      !url.password &&
      !raw.includes("#") &&
      (url.protocol === "https:" ||
        (url.protocol === "http:" &&
          ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)))
    );
  } catch {
    return false;
  }
}
export function registeredRedirectUri(registered: string[], requested: string) {
  if (registered.includes(requested)) return true;
  if (!validRedirectUri(requested)) return false;
  const loopback = /^http:\/\/(?:127\.0\.0\.1|\[::1\])(?::\d+)?(?=\/|\?|$)/;
  if (!loopback.test(requested)) return false;
  const withoutPort = (value: string) =>
    value.replace(
      /^(http:\/\/(?:127\.0\.0\.1|\[::1\]))(?::\d+)?(?=\/|\?|$)/,
      "$1",
    );
  return registered.some(
    (value) =>
      loopback.test(value) && withoutPort(value) === withoutPort(requested),
  );
}
export const clientMetadataSchema = z.object({
  client_name: z.string().trim().min(1).max(120).default("MCP client"),
  redirect_uris: z
    .array(z.string().max(2048).refine(validRedirectUri))
    .min(1)
    .max(20),
  token_endpoint_auth_method: z
    .enum(["none", "client_secret_basic", "client_secret_post"])
    .default("client_secret_basic"),
  grant_types: z
    .array(z.enum(["authorization_code", "refresh_token"]))
    .min(1)
    .max(2)
    .refine(
      (values) =>
        values.includes("authorization_code") &&
        new Set(values).size === values.length,
    )
    .default(["authorization_code"]),
  response_types: z.array(z.literal("code")).length(1).default(["code"]),
});
export function parseScope(value = "read") {
  const scopes = [...new Set(value.split(" "))];
  if (scopes.some((scope) => !["read", "write", "admin"].includes(scope)))
    throw new OAuthError(
      "invalid_scope",
      "Supported scopes are read, write and admin",
    );
  if (scopes.includes("admin")) return "read write admin";
  return scopes.includes("write") ? "read write" : "read";
}
export function requireResource(value?: string) {
  if (value !== mcpResource())
    throw new OAuthError(
      "invalid_target",
      "The resource must be this Mill MCP endpoint",
    );
}
export function uniqueParameters(params: URLSearchParams) {
  for (const key of params.keys())
    if (params.getAll(key).length !== 1)
      throw new OAuthError("invalid_request", `Repeated parameter: ${key}`);
  return Object.fromEntries(params);
}
export function authorizationResponse(
  request: { redirectUri: string; state: string | null },
  result: { code: string } | { error: string },
) {
  const url = new URL(request.redirectUri);
  for (const [key, value] of Object.entries(result))
    url.searchParams.set(key, value);
  if (request.state !== null) url.searchParams.set("state", request.state);
  url.searchParams.set("iss", issuer());
  return url.href;
}

import { millVersion } from "./version.js";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { httpSecurity } from "../../shared/security.js";
export { httpSecurity } from "../../shared/security.js";
import { sql } from "../../../packages/database/src/index.js";
import { authRoutes, sessionActor } from "./auth.js";
import { domainRoutes } from "./domain.js";
import {
  externalRoutes,
  credentialActor,
  setApiDispatcher,
} from "./external.js";
import {
  trustedOrigin,
  rateLimit,
  idempotency,
  mutationAuthority,
  readAuthority,
} from "./middleware.js";
import {
  errorResponse,
  handleError,
  requestContext,
  requestId,
  type Env,
} from "./http.js";
import type { ContentfulStatusCode } from "hono/utils/http-status";
export const app = new Hono<Env>();
app.use("*", async (c, next) => {
  const id = requestId(c.req.header("x-request-id"));
  c.set("requestId", id);
  c.header("X-Request-Id", id);
  await requestContext.run(id, next);
  if (
    c.res.status < 400 ||
    !c.res.headers.get("Content-Type")?.includes("application/json")
  )
    return;
  const result: unknown = await c.res
    .clone()
    .json()
    .catch(() => null);
  if (
    result &&
    typeof result === "object" &&
    "error" in result &&
    typeof result.error === "string" &&
    !("error_description" in result)
  ) {
    c.res = errorResponse(
      c,
      c.res.status as ContentfulStatusCode,
      result.error,
      "code" in result && typeof result.code === "string"
        ? result.code
        : undefined,
    );
  }
});

app.use("*", httpSecurity);
const standardBodyLimit = bodyLimit({
  maxSize: 2 * 1024 * 1024,
  onError: (c) => errorResponse(c, 413, "Request is too large"),
});
app.use("*", standardBodyLimit);
app.onError(handleError);
app.get("/health/live", (c) => c.json({ status: "ok" }));
app.get("/health/ready", async (c) => {
  c.header("Cache-Control", "no-store");
  const query = sql`SELECT 1`;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      query,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          reject(new Error("Database readiness timed out"));
        }, 3000);
      }),
    ]);
    return c.json({ status: "ready", version: millVersion });
  } catch {
    return c.json({ status: "unavailable" }, 503);
  } finally {
    clearTimeout(timer);
  }
});
app.use("*", async (c, next) => {
  if (
    c.req.path.startsWith("/api/") ||
    c.req.path === "/mcp" ||
    c.req.path.startsWith("/oauth/")
  ) {
    const a = c.req.header("authorization")
      ? await credentialActor(c.req.raw)
      : await sessionActor(c.req.raw);
    if (a) c.set("actor", a);
  }
  await next();
});
app.use("/api/*", async (c, next) => {
  c.header("Cache-Control", "no-store");
  c.header("Pragma", "no-cache");
  await next();
});
app.use(
  "/api/*",
  trustedOrigin,
  rateLimit,
  readAuthority,
  idempotency,
  mutationAuthority,
);
app.use("/mcp", rateLimit);
app.use("/oauth/*", rateLimit);
app.route("/api/auth", authRoutes);
app.route("/api", domainRoutes);
app.route("/", externalRoutes);
app.notFound((c) => errorResponse(c, 404, "This route does not exist"));
setApiDispatcher(async (request) => app.fetch(request));

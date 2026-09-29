import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { secureHeaders } from "hono/secure-headers";
import { HTTPException } from "hono/http-exception";
import { ZodError } from "zod";
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
} from "./middleware.js";
import type { Env } from "./http.js";
export const app = new Hono<Env>();
export const httpSecurity = secureHeaders({
  contentSecurityPolicy: {
    defaultSrc: ["'self'"],
    scriptSrc: ["'self'"],
    styleSrc: ["'self'", "'unsafe-inline'"],
    imgSrc: ["'self'", "data:"],
    connectSrc: ["'self'"],
    fontSrc: ["'self'"],
    objectSrc: ["'none'"],
    baseUri: ["'none'"],
    frameAncestors: ["'none'"],
  },
});
app.use("*", httpSecurity);
const standardBodyLimit = bodyLimit({
  maxSize: 2 * 1024 * 1024,
  onError: (c) => c.json({ error: "Request is too large" }, 413),
});
app.use("*", standardBodyLimit);
app.onError((error, c) => {
  if (error instanceof HTTPException)
    return c.json({ error: error.message }, error.status);
  if (error instanceof ZodError)
    return c.json(
      {
        error: error.issues
          .map((i) => `${i.path.join(".")}: ${i.message}`)
          .join("; "),
      },
      400,
    );
  if (error instanceof SyntaxError)
    return c.json({ error: "Request must contain valid JSON" }, 400);
  console.error(
    "Request failed",
    error instanceof Error ? error.name : "Unknown error",
  );
  return c.json(
    { error: "Mill could not complete this request. Try again." },
    500,
  );
});
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
    return c.json({ status: "ready", version: "1.0.0-beta.1" });
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
app.use("/api/*", trustedOrigin, rateLimit, idempotency, mutationAuthority);
app.use("/mcp", rateLimit);
app.use("/oauth/*", rateLimit);
app.route("/api/auth", authRoutes);
app.route("/api", domainRoutes);
app.route("/", externalRoutes);
app.notFound((c) => c.json({ error: "This route does not exist" }, 404));
setApiDispatcher(async (request) => app.fetch(request));

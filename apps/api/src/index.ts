import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { resolve } from "node:path";
import { existsSync } from "node:fs";
import { Hono } from "hono";
import { validateConfiguration } from "./config.js";
import { migrate } from "../../../packages/database/src/migrate.js";
import { closeDatabase } from "../../../packages/database/src/index.js";
import { app, httpSecurity } from "./app.js";
const configuration = validateConfiguration();
await migrate();
const serverApp = new Hono<import("./http.js").Env>();
serverApp.use("*", httpSecurity);
serverApp.use("*", async (c, next) => {
  const path = c.req.path;
  if (
    path.startsWith("/api/") ||
    path.startsWith("/health/") ||
    path === "/mcp" ||
    (path.startsWith("/oauth/") && !path.startsWith("/oauth/consent")) ||
    path.startsWith("/.well-known/")
  )
    return app.fetch(c.req.raw, c.env);
  await next();
});
const root = process.env.MILL_WEB_DIR ?? resolve("apps/web/dist");
if (existsSync(root)) {
  serverApp.get("*", serveStatic({ root }));
  serverApp.get("*", serveStatic({ path: `${root}/index.html` }));
} else
  serverApp.get("*", (c) =>
    c.text("Build the web application with pnpm build.", 503),
  );
const server = serve(
  { fetch: serverApp.fetch, port: configuration.PORT, hostname: "0.0.0.0" },
  (info) =>
    console.log(
      `Mill ready at ${configuration.MILL_BASE_URL} (port ${info.port})`,
    ),
);
for (const signal of ["SIGTERM", "SIGINT"] as const)
  process.once(signal, () =>
    server.close(async () => {
      await closeDatabase();
      process.exit(0);
    }),
  );

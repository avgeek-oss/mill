import { getRequestListener } from "@hono/node-server";
import { Hono } from "hono";
import { existsSync } from "node:fs";
import { createServer } from "node:http";
import { registerStaticRoutes } from "../../shared/static.js";
import { webSecurity } from "../../shared/security.js";

export function webConfiguration(environment = process.env) {
  if (!environment.MILL_API_URL)
    throw new Error("MILL_API_URL is required for the UI");
  const api = new URL(environment.MILL_API_URL);
  if (
    api.protocol !== "https:" &&
    !(
      api.protocol === "http:" &&
      ["localhost", "127.0.0.1", "[::1]"].includes(api.hostname)
    )
  )
    throw new Error("MILL_API_URL must use HTTPS or loopback HTTP");
  if (
    api.username ||
    api.password ||
    api.pathname !== "/" ||
    api.search ||
    api.hash
  )
    throw new Error("MILL_API_URL must be an origin without credentials");
  const port = Number(environment.PORT ?? 4322);
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw new Error("PORT must be between 1 and 65535");
  const storage = environment.MILL_S3_ENDPOINT
    ? new URL(environment.MILL_S3_ENDPOINT)
    : null;
  if (
    storage &&
    (storage.username ||
      storage.password ||
      storage.pathname !== "/" ||
      storage.search ||
      storage.hash ||
      !(
        storage.protocol === "https:" ||
        (storage.protocol === "http:" &&
          ["localhost", "127.0.0.1", "[::1]"].includes(storage.hostname))
      ))
  )
    throw new Error(
      "MILL_S3_ENDPOINT must use HTTPS or loopback HTTP without credentials",
    );
  return { api, port, storage };
}

export function createWebServer(
  root: string,
  configuration = webConfiguration(),
) {
  if (!existsSync(`${root}/index.html`))
    throw new Error("The Mill UI image must contain its built application");
  const app = new Hono();
  const faviconPath = "/brand/mill-favicon.png";
  for (const path of [faviconPath, "/favicon.ico"])
    app.use(path, async (c, next) => {
      await next();
      if (["GET", "HEAD"].includes(c.req.method) && c.res.status < 400) {
        c.header("Cross-Origin-Resource-Policy", "cross-origin");
        c.header("Cache-Control", "public, max-age=3600");
      }
    });
  app.use(
    "*",
    webSecurity(configuration.api.origin, configuration.storage?.origin),
  );
  app.get("/health/live", (c) => c.json({ status: "ok" }));
  app.get("/health/ready", (c) => c.json({ status: "ready" }));
  app.get("/favicon.ico", (c) => c.redirect(faviconPath, 308));
  app.get("/runtime-config.js", (c) => {
    c.header("Cache-Control", "no-store");
    c.header("Content-Type", "application/javascript; charset=utf-8");
    return c.body(
      `window.__MILL_RUNTIME_CONFIG__=Object.freeze(${JSON.stringify({ apiOrigin: configuration.api.origin })});`,
    );
  });
  app.all("/oauth/*", (c, next) =>
    c.req.path === "/oauth/consent" ? next() : c.notFound(),
  );
  for (const path of [
    "/api",
    "/api/*",
    "/oauth",
    "/mcp",
    "/.well-known",
    "/.well-known/*",
  ])
    app.all(path, (c) => c.notFound());
  registerStaticRoutes(app, root);
  const listener = getRequestListener(app.fetch);
  // Node's http server ignores the listener's promise. Hono's listener
  // handles request and response errors itself, as serve() does for the API.
  return createServer((request, response) => {
    void listener(request, response);
  });
}

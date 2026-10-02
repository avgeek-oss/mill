import { serveStatic } from "@hono/node-server/serve-static";
import { compress } from "hono/compress";
import type { Hono } from "hono";
import type { Env } from "./http.js";

const gzipStatic = compress({
  encoding: "gzip",
  threshold: 1024,
  contentTypeFilter:
    /^(?:text\/(?:css|html|javascript|plain)|application\/javascript|image\/svg\+xml)(?:;|$)/i,
});

export function registerStaticRoutes(serverApp: Hono<Env>, root: string) {
  // API, OAuth, health and MCP dispatch is mounted before this middleware.
  serverApp.use("*", (c, next) =>
    c.req.method === "GET" ? gzipStatic(c, next) : next(),
  );
  serverApp.use("/assets/*", async (c, next) => {
    await next();
    if (c.res.status === 200)
      c.header(
        "Cache-Control",
        /-[A-Za-z0-9_-]{8}\.[A-Za-z0-9]+$/.test(c.req.path)
          ? "public, max-age=31536000, immutable"
          : "no-cache",
      );
  });
  serverApp.get("/assets/*", serveStatic({ root }));
  serverApp.get("/assets/*", (c) => {
    c.header("Cache-Control", "no-store");
    return c.notFound();
  });
  serverApp.use("*", async (c, next) => {
    await next();
    if (c.res.headers.get("Content-Type")?.includes("text/html"))
      c.header("Cache-Control", "no-store");
    else if (c.req.path === "/startup-recovery.js")
      c.header("Cache-Control", "no-cache");
  });
  serverApp.get("*", serveStatic({ root }));
  serverApp.get("*", serveStatic({ path: `${root}/index.html` }));
}

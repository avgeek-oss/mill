import { getRequestListener } from "@hono/node-server";
import { Hono } from "hono";
import { existsSync } from "node:fs";
import {
  createServer,
  request as httpRequest,
  type IncomingHttpHeaders,
} from "node:http";
import { request as httpsRequest } from "node:https";
import { registerStaticRoutes } from "../../shared/static.js";
import { httpSecurity } from "../../shared/security.js";

export function webConfiguration(environment = process.env) {
  const api = new URL(environment.MILL_API_URL ?? "http://api:4321");
  if (
    !["http:", "https:"].includes(api.protocol) ||
    api.username ||
    api.password ||
    api.pathname !== "/" ||
    api.search ||
    api.hash
  )
    throw new Error(
      "MILL_API_URL must be an HTTP(S) origin without credentials",
    );
  const port = Number(environment.PORT ?? 4322);
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw new Error("PORT must be between 1 and 65535");
  return { api, port };
}

function endToEndHeaders(source: IncomingHttpHeaders) {
  const headers = { ...source };
  const connection = String(headers.connection ?? "").split(",");
  for (const name of [
    ...connection,
    "connection",
    "keep-alive",
    "proxy-authenticate",
    "proxy-authorization",
    "te",
    "trailer",
    "transfer-encoding",
    "upgrade",
  ])
    delete headers[name.trim().toLowerCase()];
  return headers;
}

export function createWebServer(
  root: string,
  configuration = webConfiguration(),
) {
  if (!existsSync(`${root}/index.html`))
    throw new Error("The Mill UI image must contain its built application");
  const app = new Hono();
  app.use("*", httpSecurity);
  registerStaticRoutes(app, root);
  const staticListener = getRequestListener(app.fetch);
  return createServer((incoming, outgoing) => {
    let url: URL;
    try {
      url = new URL(incoming.url ?? "/", "http://mill.internal");
    } catch {
      outgoing.writeHead(400, {
        "Content-Type": "text/plain",
        "Cache-Control": "no-store",
      });
      outgoing.end("Invalid request URL");
      return;
    }
    const path = url.pathname;
    const apiRoute =
      ["/api", "/health", "/.well-known"].some(
        (prefix) => path === prefix || path.startsWith(`${prefix}/`),
      ) ||
      path === "/mcp" ||
      (path.startsWith("/oauth/") && !path.startsWith("/oauth/consent"));
    if (!apiRoute) {
      void staticListener(incoming, outgoing);
      return;
    }
    const headers = endToEndHeaders(incoming.headers);
    delete headers.forwarded;
    delete headers["x-forwarded-for"];
    const request =
      configuration.api.protocol === "https:" ? httpsRequest : httpRequest;
    const upstream = request(
      {
        protocol: configuration.api.protocol,
        hostname: configuration.api.hostname,
        port: configuration.api.port,
        path: `${url.pathname}${url.search}`,
        method: incoming.method,
        headers,
      },
      (response) => {
        outgoing.writeHead(
          response.statusCode ?? 502,
          endToEndHeaders(response.headers),
        );
        response.on("error", () => outgoing.destroy());
        response.pipe(outgoing);
      },
    );
    upstream.setTimeout(120_000, () => upstream.destroy());
    upstream.on("error", () => {
      if (outgoing.headersSent) {
        outgoing.destroy();
        return;
      }
      outgoing.writeHead(503, {
        "Content-Type": "application/json",
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
      });
      outgoing.end(
        JSON.stringify({
          error: {
            code: "SERVICE_UNAVAILABLE",
            message: "Mill is temporarily unavailable. Try again.",
          },
        }),
      );
    });
    incoming.on("aborted", () => upstream.destroy());
    outgoing.on("close", () => {
      if (!outgoing.writableFinished) upstream.destroy();
    });
    incoming.pipe(upstream);
  });
}

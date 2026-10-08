import assert from "node:assert/strict";
import { createServer, request as httpRequest, type Server } from "node:http";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  createWebServer,
  webConfiguration,
} from "../apps/web-server/src/server.js";

async function listen(server: Server) {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  return `http://127.0.0.1:${address.port}`;
}

async function close(server: Server) {
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
}

test("UI configuration needs only its API origin and rejects invalid proxy settings", () => {
  assert.equal(webConfiguration({}).api.origin, "http://api:4321");
  for (const value of [
    "file:///etc/passwd",
    "http://user:password@api:4321",
    "http://api:4321/path",
  ])
    assert.throws(() => webConfiguration({ MILL_API_URL: value }));
  assert.throws(() => webConfiguration({ PORT: "0" }));
  assert.throws(() =>
    webConfiguration({ MILL_WEB_TRUSTED_PROXY_IPS: "10.0.0.0/8" }),
  );
});

test("UI serves client routes and proxies API bodies, cookies and trusted client addresses", async () => {
  const root = await mkdtemp(join(tmpdir(), "mill-web-server-"));
  await writeFile(join(root, "index.html"), "<html>Mill UI fixture</html>");
  const api = createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk.toString();
    response.writeHead(200, {
      "Content-Type": "application/json",
      "Set-Cookie": [
        "session=synthetic; HttpOnly; SameSite=Lax",
        "csrf=synthetic",
      ],
    });
    response.end(
      JSON.stringify({
        path: request.url,
        method: request.method,
        headers: request.headers,
        body,
      }),
    );
  });
  const upstream = await listen(api);
  const web = createWebServer(
    root,
    webConfiguration({ MILL_API_URL: upstream }),
  );
  const origin = await listen(web);
  const trustedWeb = createWebServer(
    root,
    webConfiguration({
      MILL_API_URL: upstream,
      MILL_WEB_TRUSTED_PROXY_IPS: "127.0.0.1",
    }),
  );
  const trustedOrigin = await listen(trustedWeb);
  try {
    for (const path of [
      "/",
      "/boards/example",
      "/oauth/consent?request=example",
    ]) {
      const response = await fetch(`${origin}${path}`);
      assert.equal(response.status, 200);
      assert.equal(await response.text(), "<html>Mill UI fixture</html>");
      assert.match(
        response.headers.get("content-security-policy") ?? "",
        /frame-ancestors 'none'/,
      );
      assert.equal(response.headers.get("cache-control"), "no-store");
    }
    assert.equal((await fetch(`${origin}/assets/missing.js`)).status, 404);
    for (const path of [
      "/api/auth/login?next=boards",
      "/oauth/token",
      "/.well-known/oauth-authorization-server",
      "/health/ready",
    ]) {
      const response = await fetch(`${origin}${path}`, {
        method: "POST",
        headers: {
          Origin: origin,
          "Content-Type": "application/json",
          Cookie: "session=synthetic",
          "X-Forwarded-For": "203.0.113.42",
        },
        body: '{"name":"synthetic"}',
      });
      assert.equal(response.headers.getSetCookie().length, 2);
      const actual = await response.json();
      assert.equal(actual.path, path);
      assert.equal(actual.method, "POST");
      assert.equal(actual.body, '{"name":"synthetic"}');
      assert.equal(actual.headers.origin, origin);
      assert.equal(actual.headers.host, new URL(origin).host);
      assert.equal(actual.headers.cookie, "session=synthetic");
      assert.equal(actual.headers["x-forwarded-for"], "127.0.0.1");
    }
    await new Promise<void>((resolve, reject) => {
      const request = httpRequest(
        `${origin}/api/boards`,
        {
          headers: { "X-Remove-Me": "hop", Connection: "x-remove-me" },
        },
        (response) => {
          let body = "";
          response.on("data", (data) => {
            body += data;
          });
          response.on("end", () => {
            try {
              assert.equal(JSON.parse(body).headers["x-remove-me"], undefined);
              resolve();
            } catch (error) {
              reject(error);
            }
          });
        },
      );
      request.on("error", reject);
      request.end();
    });
    await new Promise<void>((resolve, reject) => {
      const request = httpRequest(origin, { path: "http://[" }, (response) => {
        try {
          assert.equal(response.statusCode, 400);
        } catch (error) {
          reject(error);
        }
        response.resume();
        response.on("end", resolve);
      });
      request.on("error", reject);
      request.end();
    });
    assert.equal((await fetch(`${origin}/`)).status, 200);
    const trusted = await fetch(`${trustedOrigin}/api/boards`, {
      headers: { "X-Forwarded-For": "198.51.100.1, 203.0.113.42" },
    });
    assert.equal(
      (await trusted.json()).headers["x-forwarded-for"],
      "203.0.113.42",
    );
    await close(api);
    const unavailable = await fetch(`${origin}/api/boards`);
    assert.equal(unavailable.status, 503);
    assert.equal((await unavailable.json()).error.code, "SERVICE_UNAVAILABLE");
  } finally {
    if (api.listening) await close(api);
    await close(web);
    await close(trustedWeb);
    await rm(root, { recursive: true, force: true });
  }
});

test("MCP events cross the UI proxy before the upstream response finishes", async () => {
  const root = await mkdtemp(join(tmpdir(), "mill-web-stream-"));
  await writeFile(join(root, "index.html"), "Mill UI");
  let finish!: () => void;
  const released = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const api = createServer(async (_request, response) => {
    response.writeHead(200, { "Content-Type": "text/event-stream" });
    response.write('data: {"first":true}\n\n');
    await released;
    response.end('data: {"last":true}\n\n');
  });
  const upstream = await listen(api);
  const web = createWebServer(
    root,
    webConfiguration({ MILL_API_URL: upstream }),
  );
  const origin = await listen(web);
  try {
    const response = await fetch(`${origin}/mcp`, {
      signal: AbortSignal.timeout(5000),
    });
    const reader = response.body!.getReader();
    assert.match(
      new TextDecoder().decode((await reader.read()).value),
      /first/,
    );
    finish();
    assert.match(new TextDecoder().decode((await reader.read()).value), /last/);
    assert.equal((await reader.read()).done, true);
  } finally {
    finish();
    await close(web);
    await close(api);
    await rm(root, { recursive: true, force: true });
  }
});

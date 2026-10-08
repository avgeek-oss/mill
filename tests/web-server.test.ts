import assert from "node:assert/strict";
import type { Server } from "node:http";
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

test("UI needs a public API origin and validates it", () => {
  assert.throws(() => webConfiguration({}), /MILL_API_URL/);
  for (const value of [
    "file:///etc/passwd",
    "http://api:4321",
    "http://user:pass@localhost:4321",
    "https://api.example/path",
  ]) {
    assert.throws(() => webConfiguration({ MILL_API_URL: value }));
  }
  assert.equal(
    webConfiguration({ MILL_API_URL: "https://mill-api.example" }).api.origin,
    "https://mill-api.example",
  );
});

test("UI serves runtime API configuration without proxying API or OAuth", async () => {
  const root = await mkdtemp(join(tmpdir(), "mill-web-server-"));
  await writeFile(
    join(root, "index.html"),
    '<html><script src="/runtime-config.js"></script>Mill UI</html>',
  );
  const web = createWebServer(
    root,
    webConfiguration({ MILL_API_URL: "https://mill-api.example" }),
  );
  const origin = await listen(web);
  try {
    for (const path of [
      "/",
      "/boards/example",
      "/oauth/consent?request=example",
    ]) {
      const response = await fetch(`${origin}${path}`);
      assert.equal(response.status, 200);
      assert.match(await response.text(), /Mill UI/);
      assert.equal(response.headers.get("cache-control"), "no-store");
      assert.match(
        response.headers.get("content-security-policy") ?? "",
        /https:\/\/mill-api.example/,
      );
    }
    const config = await fetch(`${origin}/runtime-config.js`);
    assert.equal(config.headers.get("cache-control"), "no-store");
    assert.match(
      await config.text(),
      /"apiOrigin":"https:\/\/mill-api.example"/,
    );
    for (const path of [
      "/api/auth/login",
      "/oauth/token",
      "/.well-known/oauth-authorization-server",
      "/mcp",
    ])
      assert.equal((await fetch(`${origin}${path}`)).status, 404);
    assert.equal((await fetch(`${origin}/health/ready`)).status, 200);
    assert.equal((await fetch(`${origin}/assets/missing.js`)).status, 404);
  } finally {
    web.closeAllConnections();
    await new Promise<void>((resolve) => web.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
});

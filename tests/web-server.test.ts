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

test("optional storage allows only its configured origin in UI security policy", async () => {
  for (const endpoint of [
    "http://storage.example",
    "https://user:secret@storage.example",
    "https://storage.example?token=secret",
    "data:text/html,hello",
  ])
    assert.throws(
      () =>
        webConfiguration({
          MILL_API_URL: "https://mill-api.example",
          MILL_S3_ENDPOINT: endpoint,
        }),
      /MILL_S3_ENDPOINT/,
    );
  const root = await mkdtemp(join(tmpdir(), "mill-storage-csp-"));
  await writeFile(join(root, "index.html"), "Mill UI");
  const web = createWebServer(
    root,
    webConfiguration({
      MILL_API_URL: "https://mill-api.example",
      MILL_S3_ENDPOINT: "https://storage.example",
    }),
  );
  const origin = await listen(web);
  try {
    const response = await fetch(origin);
    const csp = response.headers.get("content-security-policy") ?? "";
    assert.match(
      csp,
      /connect-src 'self' https:\/\/mill-api.example https:\/\/storage.example/,
    );
    assert.match(csp, /frame-src 'none'/);
    assert.match(csp, /worker-src 'self'/);
    assert.doesNotMatch(csp, /\*|connect-src[^;]*\shttps:(?:;|\s)/);
    const runtime = await (await fetch(`${origin}/runtime-config.js`)).text();
    assert.doesNotMatch(
      runtime,
      /storage.example|SECRET_ACCESS_KEY|ACCESS_KEY_ID/,
    );
  } finally {
    web.closeAllConnections();
    await new Promise<void>((resolve) => web.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
});

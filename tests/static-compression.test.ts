import assert from "node:assert/strict";
import { gunzipSync } from "node:zlib";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Hono } from "hono";
import { registerStaticRoutes } from "../apps/api/src/static.js";
import type { Env } from "../apps/api/src/http.js";

test("static assets negotiate gzip without changing identity bytes or API responses", async () => {
  const root = await mkdtemp(join(tmpdir(), "mill-static-compression-"));
  try {
    await mkdir(join(root, "assets"));
    const html = Buffer.from("<!doctype html><title>Mill</title>".repeat(50));
    const script = Buffer.from("export const value = 'mill';\n".repeat(1000));
    const style = Buffer.from(".mill { color: rebeccapurple; }\n".repeat(1000));
    await writeFile(join(root, "index.html"), html);
    await writeFile(join(root, "assets", "index-abcdefgh.js"), script);
    await writeFile(join(root, "assets", "index-abcdefgh.css"), style);

    const app = new Hono<Env>();
    app.use("*", async (c, next) => {
      c.header("Content-Security-Policy", "default-src 'self'");
      c.header("X-Content-Type-Options", "nosniff");
      await next();
    });
    const dynamic = "uncompressed response ".repeat(1000);
    app.get("/api/large", (c) => c.text(dynamic));
    app.post("/mcp", (c) => c.text(dynamic));
    registerStaticRoutes(app, root);

    for (const [path, body, mime, cache] of [
      [
        "/assets/index-abcdefgh.js",
        script,
        "text/javascript",
        "public, max-age=31536000, immutable",
      ],
      [
        "/assets/index-abcdefgh.css",
        style,
        "text/css",
        "public, max-age=31536000, immutable",
      ],
      ["/", html, "text/html", "no-store"],
    ] as const) {
      const identity = await app.request(path, {
        headers: { "Accept-Encoding": "identity" },
      });
      assert.equal(identity.status, 200);
      assert.match(
        identity.headers.get("content-type") ?? "",
        new RegExp(`^${mime}`),
      );
      assert.equal(identity.headers.get("cache-control"), cache);
      assert.equal(
        identity.headers.get("content-security-policy"),
        "default-src 'self'",
      );
      assert.equal(identity.headers.get("x-content-type-options"), "nosniff");
      assert.equal(identity.headers.get("content-encoding"), null);
      assert.deepEqual(Buffer.from(await identity.arrayBuffer()), body);

      const compressed = await app.request(path, {
        headers: { "Accept-Encoding": "gzip" },
      });
      assert.equal(compressed.status, 200);
      assert.equal(compressed.headers.get("content-encoding"), "gzip");
      assert.equal(compressed.headers.get("content-length"), null);
      assert.match(
        compressed.headers.get("vary") ?? "",
        /(?:^|,)\s*Accept-Encoding(?:,|$)/i,
      );
      assert.equal(
        compressed.headers.get("content-type"),
        identity.headers.get("content-type"),
      );
      assert.equal(compressed.headers.get("cache-control"), cache);
      assert.equal(
        compressed.headers.get("content-security-policy"),
        "default-src 'self'",
      );
      const zipped = Buffer.from(await compressed.arrayBuffer());
      assert.ok(zipped.length < body.length);
      assert.deepEqual(gunzipSync(zipped), body);

      const forbidden = await app.request(path, {
        headers: { "Accept-Encoding": "gzip;q=0, *;q=1" },
      });
      assert.equal(forbidden.headers.get("content-encoding"), null);
      assert.match(forbidden.headers.get("vary") ?? "", /Accept-Encoding/i);
      assert.deepEqual(Buffer.from(await forbidden.arrayBuffer()), body);
    }

    const partial = await app.request("/assets/index-abcdefgh.js", {
      headers: { "Accept-Encoding": "gzip", Range: "bytes=0-99" },
    });
    assert.equal(partial.status, 206);
    assert.equal(partial.headers.get("content-encoding"), null);
    assert.equal(
      partial.headers.get("content-range"),
      `bytes 0-99/${script.length}`,
    );
    assert.deepEqual(
      Buffer.from(await partial.arrayBuffer()),
      script.subarray(0, 100),
    );

    for (const [path, method] of [
      ["/api/large", "GET"],
      ["/mcp", "POST"],
    ] as const) {
      const response = await app.request(path, {
        method,
        headers: { "Accept-Encoding": "gzip" },
      });
      assert.equal(response.status, 200);
      assert.equal(response.headers.get("content-encoding"), null);
      assert.equal(response.headers.get("vary"), null);
      assert.equal(await response.text(), dynamic);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

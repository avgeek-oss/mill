import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { after, test } from "node:test";
import { cleanupDatabase } from "./support.js";
import { app } from "../apps/api/src/app.js";

after(cleanupDatabase);
const iconPath = "/brand/mill-favicon.png";
const iconLink = '</favicon.ico>; rel="icon"; type="image/png"';

test("API serves the existing PNG anonymously and allows cross-origin embedding", async () => {
  const expected = await readFile(`apps/web/public${iconPath}`);
  assert.equal(expected.subarray(0, 8).toString("hex"), "89504e470d0a1a0a");
  assert.equal(expected.readUInt32BE(16), 64);
  assert.equal(expected.readUInt32BE(20), 64);
  for (const method of ["GET", "HEAD"]) {
    const response = await app.request(iconPath, {
      method,
      headers: { Origin: "https://dashboard.example" },
    });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("Content-Type"), "image/png");
    assert.equal(
      response.headers.get("Content-Length"),
      String(expected.length),
    );
    assert.equal(response.headers.get("Link"), iconLink);
    assert.equal(response.headers.get("Cache-Control"), "public, max-age=3600");
    assert.equal(
      response.headers.get("Cross-Origin-Resource-Policy"),
      "cross-origin",
    );
    assert.equal(response.headers.get("X-Content-Type-Options"), "nosniff");
    assert.equal(response.headers.get("Set-Cookie"), null);
    assert.equal(
      response.headers.get("Access-Control-Allow-Credentials"),
      null,
    );
    assert.deepEqual(
      Buffer.from(await response.arrayBuffer()),
      method === "HEAD" ? Buffer.alloc(0) : expected,
    );
  }
});

test("conventional favicon requests redirect to the canonical PNG", async () => {
  for (const method of ["GET", "HEAD"]) {
    const response = await app.request("/favicon.ico", { method });
    assert.equal(response.status, 308);
    assert.equal(response.headers.get("Location"), iconPath);
    assert.equal(
      response.headers.get("Cross-Origin-Resource-Policy"),
      "cross-origin",
    );
    assert.equal(response.headers.get("Set-Cookie"), null);
  }
});

test("icon discovery preserves JSON errors, health responses and authentication", async () => {
  for (const [path, status] of [
    ["/", 404],
    ["/health/live", 200],
    ["/api/boards", 401],
    ["/brand/missing.png", 404],
    ["/brand/mill-mark.png", 404],
    ["/apps/web/public/brand/mill-favicon.png", 404],
    ["/package.json", 404],
  ] as const) {
    const response = await app.request(path);
    assert.equal(response.status, status, path);
    assert.equal(response.headers.get("Link"), iconLink);
    assert.equal(response.headers.get("Content-Type"), "application/json");
    assert.equal(
      response.headers.get("Cross-Origin-Resource-Policy"),
      "same-origin",
    );
    const body = await response.json();
    if (status === 200) assert.deepEqual(body, { status: "ok" });
    else {
      assert.equal(
        body.error.code,
        status === 401 ? "UNAUTHORIZED" : "NOT_FOUND",
      );
      assert.equal(body.error.requestId, response.headers.get("X-Request-Id"));
      assert.equal(response.headers.get("Cache-Control"), "no-store");
    }
  }
  for (const path of [iconPath, "/favicon.ico"]) {
    const response = await app.request(path, { method: "POST" });
    assert.equal(response.status, 404);
    assert.equal(response.headers.get("Content-Type"), "application/json");
    assert.equal(
      response.headers.get("Cross-Origin-Resource-Policy"),
      "same-origin",
    );
  }
});

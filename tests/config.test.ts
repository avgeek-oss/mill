import { test } from "node:test";
import assert from "node:assert/strict";
import { validateConfiguration } from "../apps/api/src/config.js";
test("configuration requires secrets/database and restricts insecure origins", () => {
  const previous = { ...process.env };
  try {
    Object.assign(process.env, {
      DATABASE_URL: "postgres://test:disposable@127.0.0.1/mill",
      MILL_SECRET: "x".repeat(32),
      MILL_WEB_URL: "https://mill.example",
      MILL_API_URL: "https://mill-api.example",
      PORT: "4321",
    });
    assert.equal(validateConfiguration().PORT, 4321);
    for (const base of [
      "http://mill.example",
      "https://mill.example/path",
      "https://user:pass@mill.example",
      "https://mill.example?q=a",
      "ftp://mill.example",
    ]) {
      process.env.MILL_WEB_URL = base;
      assert.throws(() => validateConfiguration());
    }
    process.env.MILL_WEB_URL = "http://localhost:4322";
    assert.equal(validateConfiguration().MILL_WEB_URL, "http://localhost:4322");
    process.env.MILL_API_URL = "http://localhost:4322";
    assert.throws(() => validateConfiguration(), /separate origins/);
    process.env.MILL_API_URL = "http://api.example";
    assert.throws(() => validateConfiguration(), /MILL_API_URL/);
    process.env.MILL_API_URL = "https://mill-api.example";
    delete process.env.DATABASE_URL;
    assert.throws(() => validateConfiguration(), /DATABASE_URL/);
    process.env.DATABASE_URL = "postgres://test@localhost/mill";
    process.env.MILL_SECRET = "short";
    assert.throws(() => validateConfiguration(), /MILL_SECRET/);
  } finally {
    process.env = previous;
  }
});

test("optional SMTP requires paired configuration, validates addresses and retains secure defaults", () => {
  const environment = { ...process.env };
  Object.assign(process.env, {
    DATABASE_URL: "postgres://test:disposable@127.0.0.1/mill",
    MILL_SECRET: "x".repeat(32),
    MILL_WEB_URL: "https://mill.example",
    MILL_API_URL: "https://mill-api.example",
  });
  const fields = [
    "MILL_SMTP_HOST",
    "MILL_SMTP_PORT",
    "MILL_SMTP_SECURE",
    "MILL_SMTP_USER",
    "MILL_SMTP_PASSWORD",
    "MILL_SMTP_FROM",
  ];
  try {
    for (const k of fields) delete process.env[k];
    assert.equal(validateConfiguration().MILL_SMTP_HOST, "");
    process.env.MILL_SMTP_HOST = "smtp.example.test";
    assert.throws(validateConfiguration, /Configure SMTP host and from/);
    process.env.MILL_SMTP_FROM = "no-reply@example.test";
    let c = validateConfiguration();
    assert.equal(c.MILL_SMTP_PORT, 587);
    assert.equal(c.MILL_SMTP_SECURE, false);
    process.env.MILL_SMTP_USER = "user";
    assert.throws(validateConfiguration, /Configure SMTP user and password/);
    process.env.MILL_SMTP_PASSWORD = "safe-test-password";
    process.env.MILL_SMTP_SECURE = "true";
    c = validateConfiguration();
    assert.equal(c.MILL_SMTP_SECURE, true);
    process.env.MILL_SMTP_FROM = "Header\r\nInjected";
    assert.throws(validateConfiguration, /MILL_SMTP_FROM/);
  } finally {
    process.env = environment;
  }
});

test("browser preflight admits only the UI origin with credentials", async () => {
  const previous = { ...process.env };
  Object.assign(process.env, {
    DATABASE_URL: "postgres://test:disposable@127.0.0.1/mill",
    MILL_SECRET: "x".repeat(32),
    MILL_WEB_URL: "https://mill.example",
    MILL_API_URL: "https://mill-api.example",
  });
  try {
    const { app } = await import("../apps/api/src/app.js");
    const allowed = await app.request("/api/auth/me", {
      method: "OPTIONS",
      headers: {
        Origin: "https://mill.example",
        "Access-Control-Request-Method": "GET",
        "Access-Control-Request-Headers": "content-type",
      },
    });
    assert.equal(
      allowed.headers.get("access-control-allow-origin"),
      "https://mill.example",
    );
    assert.equal(
      allowed.headers.get("access-control-allow-credentials"),
      "true",
    );
    const denied = await app.request("/api/auth/me", {
      method: "OPTIONS",
      headers: {
        Origin: "https://untrusted.example",
        "Access-Control-Request-Method": "GET",
      },
    });
    assert.notEqual(
      denied.headers.get("access-control-allow-origin"),
      "https://untrusted.example",
    );
    const { cookieOptions } = await import("../apps/api/src/auth/model.js");
    assert.equal(cookieOptions().secure, true);
    assert.equal("domain" in cookieOptions(), false);
  } finally {
    process.env = previous;
  }
});

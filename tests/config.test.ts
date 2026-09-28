import { test } from "node:test";
import assert from "node:assert/strict";
import { validateConfiguration } from "../apps/api/src/config.js";
test("configuration requires secrets/database and restricts insecure origins", () => {
  const previous = { ...process.env };
  try {
    Object.assign(process.env, {
      DATABASE_URL: "postgres://test:disposable@127.0.0.1/mill",
      MILL_SECRET: "x".repeat(32),
      MILL_BASE_URL: "https://mill.example",
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
      process.env.MILL_BASE_URL = base;
      assert.throws(() => validateConfiguration());
    }
    process.env.MILL_BASE_URL = "http://localhost:4321";
    assert.equal(
      validateConfiguration().MILL_BASE_URL,
      "http://localhost:4321",
    );
    delete process.env.DATABASE_URL;
    assert.throws(() => validateConfiguration(), /DATABASE_URL/);
    process.env.DATABASE_URL = "postgres://test@localhost/mill";
    process.env.MILL_SECRET = "short";
    assert.throws(() => validateConfiguration(), /MILL_SECRET/);
  } finally {
    process.env = previous;
  }
});

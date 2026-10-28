import assert from "node:assert/strict";
import { randomBytes, scryptSync } from "node:crypto";
import { test } from "node:test";

// This file deliberately does not load ./support.js, which lowers the scrypt
// cost for the other suites, so it exercises the production cost. Hashing
// needs configuration but no database connection.
process.env.DATABASE_URL ??=
  "postgres://mill:mill-test-disposable@127.0.0.1:55432/mill";
process.env.MILL_WEB_URL ??= "http://localhost:4322";
process.env.MILL_API_URL ??= "http://localhost:4321";
process.env.MILL_SECRET ??=
  "mill-integration-only-32-byte-secret-never-production";
const { hashPassword, verifyPassword } =
  await import("../apps/api/src/auth/security.js");

const password = "Production cost passphrase 42!";
const scrypt = (salt: string, N: number, r: number, p: number) =>
  scryptSync(password, salt, 64, { N, r, p, maxmem: 64 * 1024 * 1024 });

test("passwords are stored with the production scrypt cost and only that cost verifies", async () => {
  const stored = await hashPassword(password);
  const [scheme, N, r, p, salt, derived] = stored.split(":");
  assert.deepEqual([scheme, N, r, p], ["scrypt", "32768", "8", "3"]);
  assert.equal(derived, scrypt(salt, 32768, 8, 3).toString("hex"));
  assert.equal(await verifyPassword(password, stored), true);
  assert.equal(await verifyPassword("Another passphrase 42!", stored), false);
  const cheaper = `scrypt:1024:8:1:${salt}:${scrypt(salt, 1024, 8, 1).toString("hex")}`;
  assert.equal(await verifyPassword(password, cheaper), false);
  const legacySalt = randomBytes(16).toString("hex");
  const legacy = `scrypt:${legacySalt}:${scrypt(legacySalt, 16384, 8, 1).toString("hex")}`;
  assert.equal(await verifyPassword(password, legacy), true);
});

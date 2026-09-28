import { after, test } from "node:test";
import assert from "node:assert/strict";
import { cleanupDatabase, sql } from "./support.js";
import { withDatabaseTransaction } from "../packages/database/src/index.js";
after(cleanupDatabase);
test("queries and nested domain transactions participate in one rollback boundary", async () => {
  await sql`CREATE TABLE transaction_probe (id integer PRIMARY KEY, detail jsonb)`;
  await assert.rejects(
    withDatabaseTransaction(async () => {
      await sql`INSERT INTO transaction_probe VALUES (1,${sql.json({ phase: "outer" })})`;
      await sql.begin(async (tx) => {
        await tx`INSERT INTO transaction_probe VALUES (2,${tx.json({ phase: "inner" })})`;
      });
      throw new Error("simulated failure after mutation");
    }),
    /simulated failure/,
  );
  assert.equal((await sql`SELECT * FROM transaction_probe`).length, 0);
  await withDatabaseTransaction(async () => {
    await sql`INSERT INTO transaction_probe VALUES (1,${sql.json({ phase: "outer" })})`;
    await sql.begin(async (tx) => {
      await tx`INSERT INTO transaction_probe VALUES (2,${tx.json({ phase: "inner" })})`;
    });
  });
  assert.equal((await sql`SELECT * FROM transaction_probe`).length, 2);
});
test("PostgreSQL calendar dates stay date-only without timezone conversion", async () => {
  const [result] = await sql`SELECT '2026-10-15'::date AS due_date`;
  assert.equal(result.dueDate, "2026-10-15");
});

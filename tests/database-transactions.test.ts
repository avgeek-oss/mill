import { after, test } from "node:test";
import assert from "node:assert/strict";
import { cleanupDatabase, sql } from "./support.js";
import { withDatabaseTransaction } from "../packages/database/src/index.js";
after(cleanupDatabase);
test("nested begin options use the protected outer transaction and roll back ambient queries at their savepoint", async () => {
  await sql`CREATE TABLE transaction_fixture(value text)`;
  await withDatabaseTransaction(async () => {
    await sql`INSERT INTO transaction_fixture VALUES('outer')`;
    const result = await sql.begin(
      "isolation level repeatable read read only",
      async (nested) => {
        const [row] = await nested`SELECT value FROM transaction_fixture`;
        return row.value;
      },
    );
    assert.equal(result, "outer");
    await assert.rejects(
      sql.begin(async () => {
        await sql`INSERT INTO transaction_fixture VALUES('must roll back')`;
        throw new Error("nested failure");
      }),
      /nested failure/,
    );
    assert.deepEqual(
      (await sql`SELECT value FROM transaction_fixture`).map(
        (row) => row.value,
      ),
      ["outer"],
    );
  });
  assert.deepEqual(
    (await sql`SELECT value FROM transaction_fixture`).map((row) => row.value),
    ["outer"],
  );
  await assert.rejects(
    withDatabaseTransaction(async () => {
      await sql.begin("isolation level repeatable read read only", async () => {
        await sql`INSERT INTO transaction_fixture VALUES('outer rollback')`;
      });
      throw new Error("outer failure");
    }),
    /outer failure/,
  );
  assert.deepEqual(
    (await sql`SELECT value FROM transaction_fixture`).map((row) => row.value),
    ["outer"],
  );
});

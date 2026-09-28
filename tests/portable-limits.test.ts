import { after, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import {
  cleanupDatabase,
  request,
  resetDatabase,
  setupUser,
  sql,
} from "./support.js";

beforeEach(resetDatabase);
after(cleanupDatabase);

test("a bounded portable document imports into a larger workspace and export reports its document limit", async () => {
  const { cookie, user } = await setupUser();
  const created = await request("/api/boards", {
    cookie,
    body: { name: "Portable source", prefix: "PORTABLE" },
  });
  assert.equal(created.status, 201);
  const exported = await request("/api/export", { cookie });
  assert.equal(exported.status, 200);
  const document = await exported.json();
  assert.equal(document.boards.length, 1);
  await sql`INSERT INTO boards(workspace_id,name,prefix,position) SELECT workspace_id,'Large workspace board '||n,'LARGE'||n,n FROM users CROSS JOIN generate_series(1,105)n WHERE users.id=${user.id}`;

  const imported = await request("/api/import", { cookie, body: document });
  assert.equal(imported.status, 201, await imported.clone().text());
  const result = await imported.json();
  assert.equal(result.imported.boards, 1);
  assert.equal(result.imported.boardIds.length, 1);
  const [count] = await sql`SELECT count(*)::int AS total FROM boards`;
  assert.equal(count.total, 107);
  const me = await request("/api/auth/me", { cookie });
  assert.equal(me.status, 200);
  assert.equal((await me.json()).user.role, "admin");

  const largeExport = await request("/api/export", { cookie });
  assert.equal(largeExport.status, 413);
  assert.match((await largeExport.json()).error, /PostgreSQL backup/);
  assert.equal(largeExport.headers.get("content-disposition"), null);

  const invalid = structuredClone(document);
  invalid.boards = Array.from({ length: 101 }, () => document.boards[0]);
  assert.equal(
    (await request("/api/import", { cookie, body: invalid })).status,
    400,
  );
  const [unchanged] = await sql`SELECT count(*)::int AS total FROM boards`;
  assert.equal(unchanged.total, 107);
});

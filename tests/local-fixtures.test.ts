import { after, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import {
  cleanupDatabase,
  request,
  resetDatabase,
  setupUser,
  sql,
} from "./support.js";
import {
  assertLocalFixtureEnvironment,
  seedLocalFixtures,
} from "../tools/local-fixtures.js";

beforeEach(resetDatabase);
after(cleanupDatabase);

test("fixtures refuse production and remote hosts", () => {
  assert.throws(
    () =>
      assertLocalFixtureEnvironment({ ...process.env, NODE_ENV: "production" }),
    /production/,
  );
  for (const key of ["DATABASE_URL", "MILL_WEB_URL", "MILL_API_URL"]) {
    assert.throws(
      () =>
        assertLocalFixtureEnvironment({
          ...process.env,
          [key]: "https://remote.example.test",
        }),
      /loopback/,
    );
    assert.throws(
      () => assertLocalFixtureEnvironment({ ...process.env, [key]: "" }),
      /required/,
    );
  }
});

test("fixtures populate real routes and preserve edits, existing records and sessions on rerun", async () => {
  const { cookie, user, body } = await setupUser();
  await sql`INSERT INTO boards(workspace_id,name,prefix) VALUES(${body.workspace.id},'My board','MINE')`;
  const first = await seedLocalFixtures(user.email);
  assert.deepEqual(first, {
    boards: 4,
    tasks: 44,
    people: 3,
    comments: 6,
    notifications: 3,
  });
  assert.equal(
    (await sql`SELECT id FROM activity WHERE action LIKE 'comment.%'`).length,
    0,
  );
  const response = await request("/api/boards", { cookie });
  assert.equal(response.status, 200);
  const page = await response.json();
  assert.equal(page.items.length, 5);
  const product = page.items.find(
    (board: { prefix: string }) => board.prefix === "PRD",
  );
  const tasks = await (
    await request(`/api/boards/${product.id}/tasks?limit=25`, { cookie })
  ).json();
  assert.equal(tasks.items.length, 25);
  assert.equal(tasks.total, 30);
  assert.ok(
    tasks.items[0].acceptanceCriteria.includes(
      "Check desktop and mobile behavior",
    ),
  );
  assert.ok(!tasks.items[0].description.includes("### Acceptance criteria"));
  const [task] =
    await sql`UPDATE tasks SET title='My edited task' WHERE identifier='PRD-1' RETURNING id`;
  await sql`UPDATE users SET name='My renamed sample member' WHERE email='maya@example.test'`;
  assert.deepEqual(await seedLocalFixtures(user.email), {
    boards: 0,
    tasks: 0,
    people: 0,
    comments: 0,
    notifications: 0,
  });
  const [preserved] = await sql`SELECT title FROM tasks WHERE id=${task.id}`;
  assert.equal(preserved.title, "My edited task");
  const [person] =
    await sql`SELECT name FROM users WHERE email='maya@example.test'`;
  assert.equal(person.name, "My renamed sample member");
  const [state] =
    await sql`SELECT (SELECT count(*)::int FROM tasks) AS tasks,(SELECT count(*)::int FROM notifications WHERE user_id=${user.id}) AS notifications,(SELECT count(*)::int FROM boards WHERE prefix='MINE') AS original`;
  assert.deepEqual(state, { tasks: 44, notifications: 3, original: 1 });
});

test("a conflicting board prefix rolls back the entire fixture load", async () => {
  const { user, body } = await setupUser();
  await sql`INSERT INTO boards(workspace_id,name,prefix) VALUES(${body.workspace.id},'Existing product','PRD')`;
  await assert.rejects(seedLocalFixtures(user.email), /duplicate key/);
  const [state] =
    await sql`SELECT (SELECT count(*)::int FROM tasks) AS tasks,(SELECT count(*)::int FROM users) AS people,(SELECT count(*)::int FROM boards) AS boards`;
  assert.deepEqual(state, { tasks: 0, people: 1, boards: 1 });
});

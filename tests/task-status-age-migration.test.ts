import { after, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { cleanupDatabase, resetDatabase, sql } from "./support.js";

beforeEach(resetDatabase);
after(cleanupDatabase);
test("baseline status clock resets only for a status change and preserves independent content edits", async () => {
  const id = randomUUID();
  await sql`INSERT INTO workspace(id,name) VALUES(${id},'Status age')`;
  const [user] =
    await sql`INSERT INTO users(id,workspace_id,name,email,role,password_hash) VALUES(${randomUUID()},${id},'Admin','age@example.test','admin','unused') RETURNING id`;
  const [board] =
    await sql`INSERT INTO boards(workspace_id,name,prefix) VALUES(${id},'Status board','AGE') RETURNING id`;
  const [task] =
    await sql`INSERT INTO tasks(board_id,identifier,title,status,created_by,status_changed_at) VALUES(${board.id},'AGE-1','Task','done',${user.id},now()-interval '2 days') RETURNING id,status_changed_at`;
  await sql`UPDATE tasks SET title='Updated text',status='done',version=version+1,updated_at=now() WHERE id=${task.id}`;
  const [edited] =
    await sql`SELECT status_changed_at,version FROM tasks WHERE id=${task.id}`;
  assert.equal(
    edited.statusChangedAt.getTime(),
    task.statusChangedAt.getTime(),
  );
  assert.equal(edited.version, 2);
  await sql`UPDATE tasks SET status='wont_do' WHERE id=${task.id}`;
  const [moved] =
    await sql`SELECT status_changed_at,version FROM tasks WHERE id=${task.id}`;
  assert.ok(moved.statusChangedAt.getTime() > task.statusChangedAt.getTime());
  assert.equal(moved.version, 2);
  const [fresh] =
    await sql`INSERT INTO tasks(board_id,identifier,title,status,created_by) VALUES(${board.id},'AGE-2','Fresh terminal','done',${user.id}) RETURNING status_changed_at=created_at AS clock_matches`;
  assert.equal(fresh.clockMatches, true);
});

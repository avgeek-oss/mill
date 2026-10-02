import { after, test } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { cleanupDatabase, sql } from "./support.js";

after(cleanupDatabase);

test("010 retires nonempty checklists without losing tasks and permits Agent-only attribution", async () => {
  const schema = `assignment_${randomUUID().replaceAll("-", "")}`;
  await sql.begin(async (tx) => {
    await tx.unsafe(`CREATE SCHEMA "${schema}"`);
    await tx.unsafe(`SET LOCAL search_path TO "${schema}"`);
    await tx`CREATE TABLE mill_migrations(name text PRIMARY KEY,checksum text NOT NULL,applied_at timestamptz NOT NULL DEFAULT now())`;
    const dir = new URL("../packages/database/migrations/", import.meta.url);
    for (const file of (await readdir(dir))
      .filter((name) => name.endsWith(".sql") && name < "010")
      .sort()) {
      const source = await readFile(new URL(file, dir), "utf8");
      await tx.unsafe(source);
      await tx`INSERT INTO mill_migrations(name,checksum) VALUES(${file},${createHash("sha256").update(source).digest("hex")})`;
    }
    const [workspace] =
      await tx`INSERT INTO workspace(id,name) VALUES(${randomUUID()},'Existing workspace') RETURNING id`;
    const [creator] =
      await tx`INSERT INTO users(id,workspace_id,name,email,role,password_hash) VALUES(${randomUUID()},${workspace.id},'Creator','creator@assignment.test','admin','unchanged') RETURNING id`;
    const [other] =
      await tx`INSERT INTO users(id,workspace_id,name,email,role,password_hash) VALUES(${randomUUID()},${workspace.id},'Other','other@assignment.test','member','unchanged') RETURNING id`;
    const [board] =
      await tx`INSERT INTO boards(workspace_id,name,prefix) VALUES(${workspace.id},'Preserved board','KEEP') RETURNING id`;
    const [agent] =
      await tx`INSERT INTO agents(name,scope,creator_id) VALUES('Creator helper','personal',${creator.id}) RETURNING id`;
    const checklist = [{ id: "step", text: "Keep this privately", done: true }];
    const [task] =
      await tx`INSERT INTO tasks(board_id,status,identifier,title,description,assignee_id,agent_id,priority,checklist,version,created_by) VALUES(${board.id},'in_review','KEEP-1','Preserved task','Preserved description',${creator.id},${agent.id},'high',${tx.json(checklist)},7,${creator.id}) RETURNING id`;
    const [empty] =
      await tx`INSERT INTO tasks(board_id,identifier,title,created_by) VALUES(${board.id},'KEEP-2','Empty checklist',${creator.id}) RETURNING id`;
    await tx`INSERT INTO comments(task_id,author_id,body) VALUES(${task.id},${creator.id},'Preserved comment')`;
    await tx`INSERT INTO activity(task_id,board_id,actor_id,actor_name,actor_kind,action,detail) VALUES(${task.id},${board.id},${creator.id},'Creator','human','task.created',${tx.json({ title: "Preserved task" })})`;
    await tx`INSERT INTO notifications(user_id,task_id,kind,actor_name) VALUES(${other.id},${task.id},'mention','Creator')`;
    const before = {
      tasks:
        await tx`SELECT id,to_jsonb(tasks)-'checklist' AS content FROM tasks ORDER BY id`,
      comments: await tx`SELECT * FROM comments ORDER BY id`,
      activity: await tx`SELECT * FROM activity ORDER BY id`,
      notifications: await tx`SELECT * FROM notifications ORDER BY id`,
      migrations: await tx`SELECT * FROM mill_migrations ORDER BY name`,
    };
    await tx.unsafe(
      await readFile(
        new URL("010_task_assignment_without_assignee.sql", dir),
        "utf8",
      ),
    );
    assert.deepEqual(
      [...(await tx`SELECT * FROM mill_migrations ORDER BY name`)],
      [...before.migrations],
    );
    assert.deepEqual(
      await tx`SELECT id,to_jsonb(tasks) AS content FROM tasks ORDER BY id`,
      before.tasks,
    );
    for (const table of ["comments", "activity", "notifications"] as const)
      assert.deepEqual(
        await tx`SELECT * FROM ${tx(table)} ORDER BY id`,
        before[table],
      );
    assert.deepEqual(
      [...(await tx`SELECT task_id,items FROM retired_task_checklists`)],
      [{ taskId: task.id, items: checklist }],
    );
    assert.equal(
      (
        await tx`SELECT task_id FROM retired_task_checklists WHERE task_id=${empty.id}`
      ).length,
      0,
    );
    assert.equal(
      (
        await tx`SELECT column_name FROM information_schema.columns WHERE table_schema=${schema} AND table_name='tasks' AND column_name='checklist'`
      ).length,
      0,
    );
    await tx`UPDATE tasks SET assignee_id=NULL WHERE id=${task.id}`;
    const [agentOnly] =
      await tx`SELECT agent_id,assignee_id,version FROM tasks WHERE id=${task.id}`;
    assert.equal(agentOnly.agentId, agent.id);
    assert.equal(agentOnly.assigneeId, null);
    assert.equal(agentOnly.version, 7);
    await assert.rejects(
      tx.savepoint(
        (nested) =>
          nested`UPDATE tasks SET assignee_id=${other.id} WHERE id=${task.id}`,
      ),
      { code: "23514" },
    );
    await tx`DELETE FROM tasks WHERE id=${task.id}`;
    assert.equal((await tx`SELECT * FROM retired_task_checklists`).length, 0);
    await tx.unsafe(`DROP SCHEMA "${schema}" CASCADE`);
  });
});

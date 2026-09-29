import { after, test } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { cleanupDatabase, sql } from "./support.js";

after(cleanupDatabase);

test("007 maps fixed statuses and flattens every task without losing content, history or retry identities", async () => {
  const schema = `status_${randomUUID().replaceAll("-", "")}`;
  await sql.begin(async (tx) => {
    await tx.unsafe(`CREATE SCHEMA "${schema}"`);
    await tx.unsafe(`SET LOCAL search_path TO "${schema}"`);
    await tx`CREATE TABLE mill_migrations(name text PRIMARY KEY,checksum text NOT NULL,applied_at timestamptz NOT NULL DEFAULT now())`;
    for (const name of [
      "001_identity.sql",
      "002_boards.sql",
      "003_external.sql",
      "004_http.sql",
      "005_permanent_deletion.sql",
      "006_task_activity_only.sql",
    ]) {
      const source = await readFile(
        new URL(`../packages/database/migrations/${name}`, import.meta.url),
        "utf8",
      );
      await tx.unsafe(source);
      await tx`INSERT INTO mill_migrations(name,checksum) VALUES(${name},${createHash("sha256").update(source).digest("hex")})`;
    }
    const migrationHistory =
      await tx`SELECT * FROM mill_migrations ORDER BY name`;
    await tx`ALTER TABLE users ALTER COLUMN notification_preferences SET DEFAULT '{"assignments":true,"mentions":true,"email":true}'`;
    const [workspace] =
      await tx`INSERT INTO workspace(id,name) VALUES(${randomUUID()},'Upgrade workspace') RETURNING id`;
    const [user] =
      await tx`INSERT INTO users(id,workspace_id,name,email,role,password_hash,notification_preferences) VALUES(${randomUUID()},${workspace.id},'Admin','upgrade-status@example.test','admin','unused','{"assignments":false,"mentions":true,"email":false}') RETURNING id`;
    const [board] =
      await tx`INSERT INTO boards(workspace_id,name,prefix,position,next_number) VALUES(${workspace.id},'Upgrade work','UPGRADE',4,99) RETURNING id`;
    const [other] =
      await tx`INSERT INTO boards(workspace_id,name,prefix,position) VALUES(${workspace.id},'Outside work','OUTSIDE',8) RETURNING id`;
    const names = [
      ["bAcKlOg", "backlog"],
      ["TODO", "todo"],
      ["To do", "todo"],
      [" In   progress ", "in_progress"],
      ["IN REVIEW", "in_review"],
      ["Done", "done"],
      ["Won't do", "wont_do"],
      ["Cancelled", "wont_do"],
      ["Needs approval", "todo"],
    ] as const;
    const tasks: { id: string; status: string }[] = [];
    const columns: string[] = [];
    for (const [index, [name, status]] of names.entries()) {
      const [column] =
        await tx`INSERT INTO columns(board_id,name,position) VALUES(${board.id},${name},${index}) RETURNING id`;
      columns.push(column.id);
      const [task] =
        await tx`INSERT INTO tasks(board_id,column_id,identifier,title,description,assignee_id,priority,labels,due_date,checklist,parent_id,position,version,created_by,created_at,updated_at) VALUES(${board.id},${column.id},${`UPGRADE-${index + 1}`},${`Task ${index + 1}`},${`Description ${index + 1}`},${user.id},'high',ARRAY['legacy'],'2026-10-02',${tx.json([{ id: "step", text: "Keep checklist", done: true }])},${index > 0 && index < 3 ? tasks[index - 1].id : null},${index},7,${user.id},${`2026-09-29T01:02:03.${String(index).padStart(6, "0")}Z`},'2026-09-29T02:03:04.123456Z') RETURNING id`;
      tasks.push({ id: task.id, status });
      await tx`INSERT INTO comments(task_id,author_id,body,created_at) VALUES(${task.id},${user.id},${`Comment ${index + 1}`},${`2026-09-29T03:04:05.${String(index).padStart(6, "0")}Z`})`;
      await tx`INSERT INTO activity(task_id,board_id,actor_id,actor_name,actor_kind,action,detail,created_at) VALUES(${task.id},${board.id},${user.id},${index % 2 ? "Admin via Helper" : "Admin"},${index % 2 ? "agent" : "human"},'task.moved',${tx.json({ fromColumnId: columns[0], columnId: column.id, status: name, fields: ["columnId", "labels", "parentId", "position"], parentId: index > 0 && index < 3 ? tasks[index - 1].id : null, position: index })},${`2026-09-29T04:05:06.${String(index).padStart(6, "0")}Z`})`;
      await tx`INSERT INTO notifications(user_id,task_id,kind,actor_name) VALUES(${user.id},${task.id},'mention','Admin')`;
    }
    const [outsideColumn] =
      await tx`INSERT INTO columns(board_id,name,position) VALUES(${other.id},'Done',0) RETURNING id`;
    const [outsideTask] =
      await tx`INSERT INTO tasks(board_id,column_id,identifier,title,position,created_by) VALUES(${other.id},${outsideColumn.id},'OUTSIDE-1','Outside',0,${user.id}) RETURNING id`;
    await tx`INSERT INTO credentials(user_id,name,token_hash,token_prefix,scopes,board_ids,expires_at) VALUES(${user.id},'Mixed scope','status-mixed-hash','prefix',ARRAY['read'],ARRAY[${board.id}::uuid,${other.id}::uuid],now()+interval '1 day')`;
    await tx`INSERT INTO oauth_requests(client_id,client_name,client_trust,redirect_uri,resource,scope,challenge,user_id,board_ids,expires_at) VALUES('status-agent','Agent','registered','https://example.test/callback','https://example.test/mcp','read','challenge',${user.id},ARRAY[${board.id}::uuid,${other.id}::uuid],now()+interval '1 day')`;
    await tx`INSERT INTO api_idempotency(actor_key,key,request_hash,response,status,board_ids,task_ids,created_at) VALUES(${user.id},'old-task-response','original-hash',${tx.json({ private: "old task structure" })},201,ARRAY[${board.id}::uuid],ARRAY[${tasks[0].id}::uuid],'2026-09-29T05:06:07.123456Z')`;
    await tx`INSERT INTO api_idempotency(actor_key,key,request_hash,response,status,invalidation_reason,created_at) VALUES(${user.id},'already-deleted','deleted-hash',NULL,410,'deleted','2026-09-29T05:06:08.123456Z')`;
    const taskContents =
      await tx`SELECT id,to_jsonb(tasks)-'column_id'-'labels'-'parent_id'-'position' AS content FROM tasks ORDER BY id`;
    const boardContents =
      await tx`SELECT id,to_jsonb(boards)-'position' AS content FROM boards ORDER BY id`;
    const comments = await tx`SELECT * FROM comments ORDER BY created_at,id`;
    const history = await tx`SELECT * FROM activity ORDER BY created_at,id`;
    const notifications = await tx`SELECT * FROM notifications ORDER BY id`;
    const caches = await tx`SELECT * FROM api_idempotency ORDER BY key`;
    const source = await readFile(
      new URL(
        "../packages/database/migrations/007_fixed_task_statuses.sql",
        import.meta.url,
      ),
      "utf8",
    );
    await tx.unsafe(source);
    await tx`INSERT INTO mill_migrations(name,checksum) VALUES('007_fixed_task_statuses.sql',${createHash("sha256").update(source).digest("hex")})`;
    assert.deepEqual(
      await tx`SELECT * FROM mill_migrations WHERE name<'007' ORDER BY name`,
      migrationHistory,
    );
    assert.deepEqual(
      await tx`SELECT id,to_jsonb(tasks)-'status' AS content FROM tasks ORDER BY id`,
      taskContents,
    );
    assert.deepEqual(
      await tx`SELECT id,to_jsonb(boards) AS content FROM boards ORDER BY id`,
      boardContents,
    );
    assert.deepEqual(
      await tx`SELECT * FROM comments ORDER BY created_at,id`,
      comments,
    );
    assert.deepEqual(
      await tx`SELECT * FROM activity ORDER BY created_at,id`,
      history,
    );
    assert.deepEqual(
      await tx`SELECT * FROM notifications ORDER BY id`,
      notifications,
    );
    for (const task of tasks)
      assert.equal(
        (await tx`SELECT status FROM tasks WHERE id=${task.id}`)[0].status,
        task.status,
      );
    assert.equal(
      (await tx`SELECT status FROM tasks WHERE id=${outsideTask.id}`)[0].status,
      "done",
    );
    assert.equal(
      (await tx`SELECT to_regclass(${schema + ".columns"}) AS relation`)[0]
        .relation,
      null,
    );
    assert.equal(
      (
        await tx`SELECT column_name FROM information_schema.columns WHERE table_schema=${schema} AND ((table_name='tasks' AND column_name IN ('column_id','labels','parent_id','position')) OR (table_name='boards' AND column_name='position'))`
      ).length,
      0,
    );
    assert.deepEqual(
      (
        await tx`SELECT notification_preferences FROM users WHERE id=${user.id}`
      )[0].notificationPreferences,
      { assignments: false, mentions: true },
    );
    const [newUser] =
      await tx`INSERT INTO users(id,workspace_id,name,email,role,password_hash) VALUES(${randomUUID()},${workspace.id},'New user','new-status@example.test','member','unused') RETURNING notification_preferences`;
    assert.deepEqual(newUser.notificationPreferences, {
      assignments: true,
      mentions: true,
    });
    const [defaultTask] =
      await tx`INSERT INTO tasks(board_id,identifier,title,created_by) VALUES(${board.id},'UPGRADE-99','Default status',${user.id}) RETURNING status`;
    assert.equal(defaultTask.status, "todo");
    await assert.rejects(
      tx.savepoint(
        (nested) =>
          nested`UPDATE tasks SET status='custom' WHERE id=${tasks[0].id}`,
      ),
      { code: "23514" },
    );
    const upgradedCache = (
      await tx`SELECT * FROM api_idempotency WHERE key='old-task-response'`
    )[0];
    const originalCache = caches.find(
      (row) => row.key === "old-task-response",
    )!;
    for (const key of ["actorKey", "key", "requestHash", "createdAt"] as const)
      assert.deepEqual(upgradedCache[key], originalCache[key]);
    assert.equal(upgradedCache.status, 410);
    assert.equal(upgradedCache.invalidationReason, "upgrade");
    assert.equal(upgradedCache.response, null);
    assert.deepEqual(upgradedCache.boardIds, []);
    assert.deepEqual(upgradedCache.taskIds, []);
    assert.deepEqual(
      (await tx`SELECT * FROM api_idempotency WHERE key='already-deleted'`)[0],
      caches.find((row) => row.key === "already-deleted"),
    );
    // Qualified deletion uses the schema-local cleanup functions under a foreign caller path.
    await tx.unsafe("SET LOCAL search_path TO pg_catalog");
    await tx`DELETE FROM ${tx(`${schema}.tasks`)} WHERE id=${tasks[0].id}`;
    assert.equal(
      (
        await tx`SELECT id FROM ${tx(`${schema}.tasks`)} WHERE id IN ${tx(tasks.slice(1, 3).map((task) => task.id))}`
      ).length,
      2,
    );
    for (const table of ["comments", "activity", "notifications"]) {
      assert.equal(
        (
          await tx`SELECT id FROM ${tx(`${schema}.${table}`)} WHERE task_id=${tasks[0].id}`
        ).length,
        0,
      );
      assert.equal(
        (
          await tx`SELECT id FROM ${tx(`${schema}.${table}`)} WHERE task_id IN ${tx(tasks.slice(1, 3).map((task) => task.id))}`
        ).length,
        2,
      );
    }
    await tx`DELETE FROM ${tx(`${schema}.boards`)} WHERE id=${board.id}`;
    assert.equal(
      (
        await tx`SELECT id FROM ${tx(`${schema}.tasks`)} WHERE board_id=${board.id}`
      ).length,
      0,
    );
    assert.equal(
      (
        await tx`SELECT id FROM ${tx(`${schema}.tasks`)} WHERE id=${outsideTask.id}`
      ).length,
      1,
    );
    assert.deepEqual(
      (await tx`SELECT board_ids FROM ${tx(`${schema}.credentials`)}`)[0]
        .boardIds,
      [other.id],
    );
    assert.deepEqual(
      (await tx`SELECT board_ids FROM ${tx(`${schema}.oauth_requests`)}`)[0]
        .boardIds,
      [other.id],
    );
    await tx.unsafe(`DROP SCHEMA "${schema}" CASCADE`);
  });
});

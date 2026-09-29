import { after, test } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { cleanupDatabase, sql } from "./support.js";

after(cleanupDatabase);

test("008 preserves prior task and identity data, revokes unbound access and enforces eligible human Agent bindings", async () => {
  const schema = `agents_${randomUUID().replaceAll("-", "")}`;
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
      "007_fixed_task_statuses.sql",
    ]) {
      const source = await readFile(
        new URL(`../packages/database/migrations/${name}`, import.meta.url),
        "utf8",
      );
      await tx.unsafe(source);
      await tx`INSERT INTO mill_migrations(name,checksum) VALUES(${name},${createHash("sha256").update(source).digest("hex")})`;
    }
    const migrations = await tx`SELECT * FROM mill_migrations ORDER BY name`;
    const [workspace] =
      await tx`INSERT INTO workspace(id,name) VALUES(${randomUUID()},'Prior workspace') RETURNING id`;
    const [creator] =
      await tx`INSERT INTO users(id,workspace_id,name,email,role,password_hash) VALUES(${randomUUID()},${workspace.id},'Admin','agents-upgrade@example.test','admin','unchanged') RETURNING id`;
    const [member] =
      await tx`INSERT INTO users(id,workspace_id,name,email,role,password_hash) VALUES(${randomUUID()},${workspace.id},'Member','member-upgrade@example.test','member','unchanged') RETURNING id`;
    await tx`INSERT INTO sessions(id,user_id,token_hash,security_epoch,user_agent,expires_at) VALUES(${randomUUID()},${creator.id},'legacy-session',0,'Browser',now()+interval '1 day')`;
    const [board] =
      await tx`INSERT INTO boards(workspace_id,name,prefix,next_number) VALUES(${workspace.id},'Existing work','KEEP',42) RETURNING id`;
    const [task] =
      await tx`INSERT INTO tasks(board_id,status,identifier,title,description,assignee_id,priority,due_date,checklist,version,created_by) VALUES(${board.id},'in_review','KEEP-7','Existing task','Preserve the Markdown',${member.id},'high','2026-10-03',${tx.json([{ id: "step", text: "Keep checklist", done: true }])},9,${creator.id}) RETURNING id`;
    await tx`INSERT INTO comments(task_id,author_id,body) VALUES(${task.id},${member.id},'Preserve comment')`;
    await tx`INSERT INTO activity(task_id,board_id,actor_id,actor_name,actor_kind,action,detail,created_at) VALUES(${task.id},${board.id},${creator.id},'Historical helper via Admin','agent','task.updated',${tx.json({ fields: ["description"], legacyAgentName: "Historical helper" })},'2026-09-29T01:02:03.123456Z')`;
    await tx`INSERT INTO notifications(user_id,task_id,kind,actor_name) VALUES(${member.id},${task.id},'mention','Historical helper')`;
    const [key] =
      await tx`INSERT INTO credentials(user_id,name,token_hash,token_prefix,scopes,board_ids,expires_at) VALUES(${creator.id},'Prior key','legacy-hash','mill_prefix',ARRAY['read','write'],ARRAY[${board.id}::uuid],now()+interval '1 day') RETURNING id`;
    await tx`INSERT INTO oauth_requests(client_id,client_name,client_trust,redirect_uri,resource,scope,challenge,user_id,board_ids,code_hash,expires_at) VALUES('legacy-client','Legacy client','registered','https://example.test/callback','https://example.test/mcp','read','challenge',${creator.id},ARRAY[${board.id}::uuid],'legacy-code',now()+interval '1 day')`;
    await tx`INSERT INTO api_idempotency(actor_key,key,request_hash,response,status,board_ids,task_ids,created_at) VALUES(${creator.id},'legacy-task-retry','retained-hash',${tx.json({ private: "Prior task response" })},200,ARRAY[${board.id}::uuid],ARRAY[${task.id}::uuid],'2026-09-29T02:03:04.123456Z')`;
    const contents = new Map<string, unknown>();
    for (const table of [
      "users",
      "sessions",
      "boards",
      "tasks",
      "comments",
      "activity",
      "notifications",
    ])
      contents.set(
        table,
        await tx`SELECT to_jsonb(${tx(table)}) AS content FROM ${tx(table)} ORDER BY id`,
      );
    const originalKey = (
      await tx`SELECT to_jsonb(credentials)-'revoked_at' AS content FROM credentials WHERE id=${key.id}`
    )[0];
    const originalGrant = (
      await tx`SELECT to_jsonb(oauth_requests)-'consumed_at'-'expires_at' AS content FROM oauth_requests`
    )[0];
    const originalRetry = (
      await tx`SELECT actor_key,key,request_hash,created_at FROM api_idempotency`
    )[0];
    const source = await readFile(
      new URL(
        "../packages/database/migrations/008_agents.sql",
        import.meta.url,
      ),
      "utf8",
    );
    await tx.unsafe(source);
    await tx`INSERT INTO mill_migrations(name,checksum) VALUES('008_agents.sql',${createHash("sha256").update(source).digest("hex")})`;
    assert.deepEqual(
      await tx`SELECT * FROM mill_migrations WHERE name<'008' ORDER BY name`,
      migrations,
    );
    for (const table of [
      "users",
      "sessions",
      "boards",
      "comments",
      "activity",
      "notifications",
    ])
      assert.deepEqual(
        await tx`SELECT to_jsonb(${tx(table)}) AS content FROM ${tx(table)} ORDER BY id`,
        contents.get(table),
        table,
      );
    assert.deepEqual(
      await tx`SELECT to_jsonb(tasks)-'agent_id' AS content FROM tasks ORDER BY id`,
      contents.get("tasks"),
    );
    assert.equal((await tx`SELECT agent_id FROM tasks`)[0].agentId, null);
    assert.equal(
      (await tx`SELECT * FROM agents`).length,
      0,
      "No implicit Agent created",
    );
    assert.equal((await tx`SELECT * FROM agent_members`).length, 0);
    assert.deepEqual(
      (
        await tx`SELECT to_jsonb(credentials)-'revoked_at'-'agent_id' AS content FROM credentials WHERE id=${key.id}`
      )[0],
      originalKey,
    );
    assert.ok(
      (await tx`SELECT revoked_at FROM credentials WHERE id=${key.id}`)[0]
        .revokedAt,
    );
    assert.deepEqual(
      (
        await tx`SELECT to_jsonb(oauth_requests)-'consumed_at'-'expires_at'-'agent_id' AS content FROM oauth_requests`
      )[0],
      originalGrant,
    );
    const grant = (await tx`SELECT * FROM oauth_requests`)[0];
    assert.ok(grant.consumedAt);
    assert.ok(grant.expiresAt <= new Date());
    assert.deepEqual(
      (
        await tx`SELECT actor_key,key,request_hash,created_at FROM api_idempotency`
      )[0],
      originalRetry,
    );
    const retry = (await tx`SELECT * FROM api_idempotency`)[0];
    assert.equal(retry.status, 410);
    assert.equal(retry.response, null);
    assert.equal(retry.invalidationReason, "upgrade");
    assert.deepEqual(retry.agentIds, []);
    const [personal] =
      await tx`INSERT INTO agents(name,scope,creator_id) VALUES('Personal helper','personal',${creator.id}) RETURNING id`;
    const [team] =
      await tx`INSERT INTO agents(name,scope,creator_id) VALUES('Team helper','team',${creator.id}) RETURNING id`;
    await tx`INSERT INTO agent_members(agent_id,user_id) VALUES(${team.id},${creator.id}),(${team.id},${member.id})`;
    await assert.rejects(
      tx.savepoint(
        (nested) =>
          nested`UPDATE tasks SET agent_id=${team.id},assignee_id=NULL WHERE id=${task.id}`,
      ),
      { code: "23514" },
    );
    await assert.rejects(
      tx.savepoint(
        (nested) =>
          nested`UPDATE tasks SET agent_id=${personal.id} WHERE id=${task.id}`,
      ),
      { code: "23514" },
    );
    await assert.rejects(
      tx.savepoint(
        (nested) =>
          nested`INSERT INTO agent_members(agent_id,user_id) VALUES(${personal.id},${member.id})`,
      ),
      { code: "23514" },
    );
    await assert.rejects(
      tx.savepoint(
        (nested) =>
          nested`INSERT INTO credentials(user_id,name,token_hash,token_prefix,scopes,expires_at) VALUES(${creator.id},'Unbound','new-unbound','prefix',ARRAY['read'],now()+interval '1 day')`,
      ),
      { code: "23514" },
    );
    await assert.rejects(
      tx.savepoint(
        (nested) =>
          nested`UPDATE agent_members SET user_id=${member.id} WHERE agent_id=${team.id} AND user_id=${creator.id}`,
      ),
      { code: "23514" },
    );
    await tx`UPDATE tasks SET agent_id=${team.id} WHERE id=${task.id}`;
    const [boundKey] =
      await tx`INSERT INTO credentials(user_id,agent_id,name,token_hash,token_prefix,scopes,expires_at) VALUES(${member.id},${team.id},'Bound','bound-hash','prefix',ARRAY['read'],now()+interval '1 day') RETURNING id`;
    const history = await tx`SELECT * FROM activity ORDER BY created_at,id`;
    await tx.unsafe("SET LOCAL search_path TO pg_catalog");
    await tx`DELETE FROM ${tx(`${schema}.agent_members`)} WHERE agent_id=${team.id} AND user_id=${member.id}`;
    const cleared = (
      await tx`SELECT * FROM ${tx(`${schema}.tasks`)} WHERE id=${task.id}`
    )[0];
    assert.equal(cleared.agentId, null);
    assert.equal(cleared.assigneeId, member.id);
    assert.equal(cleared.version, 10);
    assert.ok(
      (
        await tx`SELECT revoked_at FROM ${tx(`${schema}.credentials`)} WHERE id=${boundKey.id}`
      )[0].revokedAt,
    );
    assert.deepEqual(
      await tx`SELECT * FROM ${tx(`${schema}.activity`)} ORDER BY created_at,id`,
      history,
    );
    await tx`UPDATE ${tx(`${schema}.tasks`)} SET assignee_id=${creator.id},agent_id=${personal.id} WHERE id=${task.id}`;
    await tx`UPDATE ${tx(`${schema}.users`)} SET disabled_at=now() WHERE id=${creator.id}`;
    assert.equal(
      (
        await tx`SELECT agent_id FROM ${tx(`${schema}.tasks`)} WHERE id=${task.id}`
      )[0].agentId,
      null,
    );
    assert.equal(
      (
        await tx`SELECT * FROM ${tx(`${schema}.agent_members`)} WHERE user_id=${creator.id}`
      ).length,
      0,
    );
    await tx`DELETE FROM ${tx(`${schema}.agents`)} WHERE id=${team.id}`;
    assert.equal(
      (
        await tx`SELECT agent_id FROM ${tx(`${schema}.credentials`)} WHERE id=${boundKey.id}`
      )[0].agentId,
      null,
    );
    assert.deepEqual(
      await tx`SELECT * FROM ${tx(`${schema}.activity`)} ORDER BY created_at,id`,
      history,
    );
    const functions =
      await tx`SELECT p.prosecdef,p.proconfig FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname=${schema} AND p.proname IN ('lock_agent_authority','check_agent_access','enforce_task_agent','clean_removed_agent_member','clean_deleted_agent','clean_disabled_agent_user')`;
    assert.equal(functions.length, 6);
    for (const fn of functions) {
      assert.equal(fn.prosecdef, false);
      assert.deepEqual(fn.proconfig, [
        `search_path=pg_catalog, ${schema}, pg_temp`,
      ]);
    }
    await tx.unsafe(`DROP SCHEMA "${schema}" CASCADE`);
  });
});

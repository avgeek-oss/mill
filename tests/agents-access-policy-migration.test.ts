import { after, test } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { cleanupDatabase, sql } from "./support.js";
after(cleanupDatabase);

test("009 preserves work and OAuth, pins creators, revokes old scoped API keys, and enforces dynamic team access", async () => {
  const schema = `policy_${randomUUID().replaceAll("-", "")}`;
  await sql.begin(async (tx) => {
    await tx.unsafe(`CREATE SCHEMA "${schema}"`);
    await tx.unsafe(`SET LOCAL search_path TO "${schema}"`);
    await tx`CREATE TABLE mill_migrations(name text PRIMARY KEY,checksum text NOT NULL,applied_at timestamptz NOT NULL DEFAULT now())`;
    const dir = new URL("../packages/database/migrations/", import.meta.url);
    for (const file of (await readdir(dir))
      .filter((name) => name.endsWith(".sql") && name < "009")
      .sort()) {
      const source = await readFile(new URL(file, dir), "utf8");
      await tx.unsafe(source);
      await tx`INSERT INTO mill_migrations(name,checksum) VALUES(${file},${createHash("sha256").update(source).digest("hex")})`;
    }
    const originalMigrations =
      await tx`SELECT * FROM mill_migrations ORDER BY name`;
    const [workspace] =
      await tx`INSERT INTO workspace(id,name) VALUES(${randomUUID()},'Existing workspace') RETURNING id`;
    const [creator] =
      await tx`INSERT INTO users(id,workspace_id,name,email,role,password_hash) VALUES(${randomUUID()},${workspace.id},'Creator','creator@policy.test','admin','unchanged') RETURNING id`;
    const [member] =
      await tx`INSERT INTO users(id,workspace_id,name,email,role,password_hash) VALUES(${randomUUID()},${workspace.id},'Member','member@policy.test','member','unchanged') RETURNING id`;
    const [outsider] =
      await tx`INSERT INTO users(id,workspace_id,name,email,role,password_hash) VALUES(${randomUUID()},${workspace.id},'Other','other@policy.test','member','unchanged') RETURNING id`;
    const [agent] =
      await tx`INSERT INTO agents(name,scope,creator_id) VALUES('Existing team','team',${creator.id}) RETURNING id`;
    await tx`INSERT INTO agent_members(agent_id,user_id) VALUES(${agent.id},${member.id})`;
    const [board] =
      await tx`INSERT INTO boards(workspace_id,name,prefix,next_number) VALUES(${workspace.id},'Work','KEEP',42) RETURNING id`;
    const [task] =
      await tx`INSERT INTO tasks(board_id,status,identifier,title,description,assignee_id,agent_id,priority,checklist,version,created_by) VALUES(${board.id},'in_review','KEEP-7','Preserve work','Preserve Markdown',${member.id},${agent.id},'high',${tx.json([{ id: "check", text: "Keep checklist", done: true }])},9,${creator.id}) RETURNING id`;
    await tx`INSERT INTO comments(task_id,author_id,body) VALUES(${task.id},${member.id},'Keep comment')`;
    await tx`INSERT INTO activity(task_id,board_id,actor_id,actor_name,actor_kind,action,detail,created_at) VALUES(${task.id},${board.id},${member.id},'Existing team via Member','agent','task.updated',${tx.json({ fields: ["description"], oldStatus: "Custom" })},'2026-09-29T01:02:03.123456Z')`;
    const [key] =
      await tx`INSERT INTO credentials(user_id,agent_id,name,token_hash,token_prefix,scopes,board_ids,expires_at) VALUES(${member.id},${agent.id},'Old scoped key','key-hash','prefix',ARRAY['read','write'],ARRAY[${board.id}::uuid],now()+interval '1 day') RETURNING id`;
    const [oauth] =
      await tx`INSERT INTO credentials(user_id,agent_id,name,token_hash,token_prefix,scopes,board_ids,token_type,oauth_client_id,resource,expires_at) VALUES(${member.id},${agent.id},'Existing OAuth','oauth-hash','prefix',ARRAY['read','write'],ARRAY[${board.id}::uuid],'oauth','client','https://policy.test/mcp',now()+interval '1 day') RETURNING id`;
    const [grant] =
      await tx`INSERT INTO oauth_requests(client_id,client_name,client_trust,redirect_uri,resource,scope,challenge,user_id,agent_id,code_hash,expires_at) VALUES('client','Existing connection','registered','https://policy.test/callback','https://policy.test/mcp','read write','challenge',${member.id},${agent.id},'issued-code',now()+interval '1 day') RETURNING id`;
    await tx`INSERT INTO api_idempotency(actor_key,key,request_hash,response,status,agent_ids,created_at) VALUES(${member.id},'old-policy','exact-hash',${tx.json({ old: "response" })},200,ARRAY[${agent.id}::uuid],'2026-09-29T02:03:04.123456Z')`;
    const originals = new Map<string, unknown>();
    for (const table of [
      "users",
      "boards",
      "tasks",
      "comments",
      "activity",
      "oauth_requests",
    ])
      originals.set(
        table,
        await tx`SELECT to_jsonb(${tx(table)}) AS content FROM ${tx(table)} ORDER BY id`,
      );
    const originalOAuth =
      await tx`SELECT * FROM credentials WHERE id=${oauth.id}`;
    const originalRetry =
      await tx`SELECT actor_key,key,request_hash,created_at FROM api_idempotency`;
    const source = await readFile(
      new URL("009_agents_access.sql", dir),
      "utf8",
    );
    await tx.unsafe(source);
    assert.deepEqual(
      await tx`SELECT * FROM mill_migrations ORDER BY name`,
      originalMigrations,
    );
    for (const [table, rows] of originals)
      assert.deepEqual(
        await tx`SELECT to_jsonb(${tx(table)}) AS content FROM ${tx(table)} ORDER BY id`,
        rows,
        table,
      );
    assert.deepEqual(
      await tx`SELECT * FROM credentials WHERE id=${oauth.id}`,
      originalOAuth,
    );
    const changedKey = (
      await tx`SELECT * FROM credentials WHERE id=${key.id}`
    )[0];
    assert.ok(changedKey.revokedAt);
    assert.equal(changedKey.agentId, null);
    assert.equal(changedKey.boardIds, null);
    assert.deepEqual(changedKey.scopes, []);
    assert.deepEqual(
      await tx`SELECT actor_key,key,request_hash,created_at FROM api_idempotency`,
      originalRetry,
    );
    const retry = (await tx`SELECT * FROM api_idempotency`)[0];
    assert.equal(retry.response, null);
    assert.equal(retry.status, 410);
    assert.equal(retry.invalidationReason, "upgrade");
    assert.equal(
      (await tx`SELECT all_members FROM agents`)[0].allMembers,
      false,
    );
    assert.deepEqual(
      (await tx`SELECT user_id FROM agent_members ORDER BY user_id`).map(
        (row) => row.userId,
      ),
      [creator.id, member.id].sort(),
    );
    await assert.rejects(
      tx.savepoint(
        (nested) =>
          nested`DELETE FROM agent_members WHERE agent_id=${agent.id} AND user_id=${creator.id}`,
      ),
      { code: "23514" },
    );
    await assert.rejects(
      tx.savepoint(
        (nested) =>
          nested`INSERT INTO agents(name,scope,creator_id,all_members) VALUES('Wrong personal','personal',${creator.id},true)`,
      ),
      { code: "23514" },
    );
    await tx`INSERT INTO credentials(user_id,name,token_hash,token_prefix,scopes,expires_at) VALUES(${outsider.id},'New human key','new-key','prefix','{}',now()+interval '1 day')`;
    await assert.rejects(
      tx.savepoint(
        (nested) =>
          nested`INSERT INTO credentials(user_id,agent_id,name,token_hash,token_prefix,scopes,expires_at) VALUES(${member.id},${agent.id},'Cannot widen','bad-key','prefix',ARRAY['read'],now()+interval '1 day')`,
      ),
      { code: "23514" },
    );
    await tx`UPDATE agents SET all_members=true WHERE id=${agent.id}`;
    const [future] =
      await tx`INSERT INTO users(id,workspace_id,name,email,role,password_hash) VALUES(${randomUUID()},${workspace.id},'Future','future@policy.test','viewer','unchanged') RETURNING id`;
    assert.equal(
      (
        await tx`SELECT check_agent_access(${agent.id},${future.id}) AS eligible`
      )[0].eligible,
      true,
    );
    await tx`UPDATE tasks SET assignee_id=${future.id} WHERE id=${task.id}`;
    await tx`DELETE FROM agent_members WHERE agent_id=${agent.id} AND user_id=${member.id}`;
    assert.equal(
      (await tx`SELECT revoked_at FROM credentials WHERE id=${oauth.id}`)[0]
        .revokedAt,
      null,
    );
    assert.equal(
      (await tx`SELECT consumed_at FROM oauth_requests WHERE id=${grant.id}`)[0]
        .consumedAt,
      null,
    );
    assert.equal(
      (await tx`SELECT agent_id FROM tasks WHERE id=${task.id}`)[0].agentId,
      agent.id,
    );
    await tx`INSERT INTO agent_members(agent_id,user_id) VALUES(${agent.id},${member.id})`;
    await tx.unsafe("SET LOCAL search_path TO pg_catalog");
    await tx`UPDATE ${tx(`${schema}.agents`)} SET all_members=false WHERE id=${agent.id}`;
    const cleared = (
      await tx`SELECT * FROM ${tx(`${schema}.tasks`)} WHERE id=${task.id}`
    )[0];
    assert.equal(cleared.agentId, null);
    assert.equal(cleared.assigneeId, future.id);
    assert.equal(cleared.version, 10);
    assert.equal(
      (
        await tx`SELECT revoked_at FROM ${tx(`${schema}.credentials`)} WHERE id=${oauth.id}`
      )[0].revokedAt,
      null,
    );
    await tx`DELETE FROM ${tx(`${schema}.agent_members`)} WHERE agent_id=${agent.id} AND user_id=${member.id}`;
    assert.ok(
      (
        await tx`SELECT revoked_at FROM ${tx(`${schema}.credentials`)} WHERE id=${oauth.id}`
      )[0].revokedAt,
    );
    assert.ok(
      (
        await tx`SELECT consumed_at FROM ${tx(`${schema}.oauth_requests`)} WHERE id=${grant.id}`
      )[0].consumedAt,
    );
    assert.deepEqual(
      await tx`SELECT to_jsonb(history) AS content FROM ${tx(`${schema}.activity`)} history ORDER BY id`,
      originals.get("activity"),
    );
    await tx.unsafe(`DROP SCHEMA "${schema}" CASCADE`);
  });
});

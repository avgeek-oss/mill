import { after, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import {
  cleanupDatabase,
  request,
  resetDatabase,
  setupAgent,
  setupOAuthAgent,
  callMcpTool,
  setupUser,
  sql,
} from "./support.js";

beforeEach(resetDatabase);
after(cleanupDatabase);
async function json(response: Response, status = 200) {
  assert.equal(response.status, status, await response.clone().text());
  return response.json();
}

for (const callerPath of ["public", "pg_catalog"] as const) {
  test(`qualified deletes bind cleanup to their owning schema with caller search_path ${callerPath}`, async () => {
    const { cookie, user } = await setupUser();
    const { board: removed } = await json(
      await request("/api/boards", {
        cookie,
        body: { name: "Removed board", prefix: "REMOVE" },
      }),
      201,
    );
    const { board: kept } = await json(
      await request("/api/boards", {
        cookie,
        body: { name: "Kept board", prefix: "KEEP" },
      }),
      201,
    );
    async function createTask(boardId: string, key: string) {
      return (
        await json(
          await request(`/api/boards/${boardId}/tasks`, {
            cookie,
            body: { title: `Private content ${key}` },
            headers: { "Idempotency-Key": key },
          }),
          201,
        )
      ).task;
    }
    const parent = await createTask(removed.id, "schema-parent-cache");
    const child = await createTask(removed.id, "schema-child-cache");
    const grandchild = await createTask(removed.id, "schema-grandchild-cache");
    const boardOnly = await createTask(removed.id, "schema-board-only-cache");
    const outside = await createTask(kept.id, "schema-outside-cache");
    for (const item of [parent, boardOnly]) {
      await json(
        await request(`/api/tasks/${item.id}/comments`, {
          cookie,
          body: { body: "Private discussion" },
          headers: { "Idempotency-Key": `schema-comment-${item.id}` },
        }),
        201,
      );
      await sql`INSERT INTO notifications(user_id,task_id,kind,actor_name) VALUES (${user.id},${item.id},'mention','Admin')`;
    }
    const sole = await setupOAuthAgent(cookie, {
      agentId: (await setupAgent(cookie)).id,
      scopes: ["read"],
      boardIds: [removed.id],
      idempotencyKey: "schema-sole-credential-cache",
    });
    const mixed = await setupOAuthAgent(cookie, {
      agentId: (await setupAgent(cookie)).id,
      scopes: ["read"],
      boardIds: [removed.id, kept.id],
      idempotencyKey: "schema-mixed-credential-cache",
    });
    const [soleGrant] =
      await sql`INSERT INTO oauth_requests(client_id,client_name,client_trust,redirect_uri,resource,scope,challenge,user_id,agent_id,board_ids,expires_at) VALUES ('schema-agent','Agent','registered','https://example.test/callback','https://example.test/mcp','read','challenge',${user.id},${sole.credential.agentId},ARRAY[${removed.id}::uuid],now()+interval '1 day') RETURNING id`;
    const [mixedGrant] =
      await sql`INSERT INTO oauth_requests(client_id,client_name,client_trust,redirect_uri,resource,scope,challenge,user_id,agent_id,board_ids,expires_at) VALUES ('schema-agent','Agent','registered','https://example.test/callback','https://example.test/mcp','read','challenge',${user.id},${mixed.credential.agentId},ARRAY[${removed.id}::uuid,${kept.id}::uuid],now()+interval '1 day') RETURNING id`;
    const originalCaches =
      await sql`SELECT actor_key,key,request_hash,created_at FROM api_idempotency ORDER BY key`;
    const schema = process.env.MILL_DB_SCHEMA!;
    await sql.begin(async (tx) => {
      // Temp shadows exercise search-path isolation without touching public tables.
      for (const name of ["credentials", "oauth_requests", "api_idempotency"]) {
        await tx`CREATE TEMP TABLE ${tx(name)} (LIKE ${tx(`${schema}.${name}`)} INCLUDING ALL) ON COMMIT DROP`;
        await tx`INSERT INTO ${tx(`pg_temp.${name}`)} SELECT * FROM ${tx(`${schema}.${name}`)}`;
      }
      const credentialShadows =
        await tx`SELECT * FROM pg_temp.credentials ORDER BY id`;
      const grantShadows =
        await tx`SELECT * FROM pg_temp.oauth_requests ORDER BY id`;
      const cacheShadows =
        await tx`SELECT * FROM pg_temp.api_idempotency ORDER BY key`;
      await tx.unsafe(`SET LOCAL search_path TO ${callerPath}`);
      const functions =
        await tx`SELECT p.proname,p.prosecdef,p.proconfig FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname=${schema} AND p.proname IN ('clean_deleted_board','clean_deleted_task') ORDER BY p.proname`;
      assert.equal(functions.length, 2);
      for (const fn of functions) {
        assert.equal(fn.prosecdef, false);
        assert.deepEqual(fn.proconfig, [
          `search_path=pg_catalog, ${schema}, pg_temp`,
        ]);
      }
      await tx`DELETE FROM ${tx(`${schema}.tasks`)} WHERE id=${parent.id}`;
      const descendants = [parent.id];
      assert.equal(
        (
          await tx`SELECT id FROM ${tx(`${schema}.tasks`)} WHERE id IN ${tx([child.id, grandchild.id])}`
        ).length,
        2,
      );
      assert.equal(
        (
          await tx`SELECT id FROM ${tx(`${schema}.tasks`)} WHERE id IN ${tx(descendants)}`
        ).length,
        0,
      );
      for (const name of ["comments", "notifications", "activity"])
        assert.equal(
          (
            await tx`SELECT id FROM ${tx(`${schema}.${name}`)} WHERE task_id IN ${tx(descendants)}`
          ).length,
          0,
          name,
        );
      assert.equal(
        (
          await tx`SELECT id FROM ${tx(`${schema}.tasks`)} WHERE id=${boardOnly.id}`
        ).length,
        1,
      );
      await tx`DELETE FROM ${tx(`${schema}.boards`)} WHERE id=${removed.id}`;
      for (const name of ["tasks", "activity"])
        assert.equal(
          (
            await tx`SELECT id FROM ${tx(`${schema}.${name}`)} WHERE board_id=${removed.id}`
          ).length,
          0,
          name,
        );
      for (const name of ["comments", "notifications"])
        assert.equal(
          (
            await tx`SELECT id FROM ${tx(`${schema}.${name}`)} WHERE task_id=${boardOnly.id}`
          ).length,
          0,
          name,
        );
      const [soleCredential] =
        await tx`SELECT * FROM ${tx(`${schema}.credentials`)} WHERE id=${sole.credential.id}`;
      assert.deepEqual(soleCredential.boardIds, []);
      assert.ok(soleCredential.revokedAt);
      const [mixedCredential] =
        await tx`SELECT * FROM ${tx(`${schema}.credentials`)} WHERE id=${mixed.credential.id}`;
      assert.deepEqual(mixedCredential.boardIds, [kept.id]);
      assert.equal(mixedCredential.revokedAt, null);
      assert.equal(
        (
          await tx`SELECT id FROM ${tx(`${schema}.oauth_requests`)} WHERE id=${soleGrant.id}`
        ).length,
        0,
      );
      const [remainingGrant] =
        await tx`SELECT * FROM ${tx(`${schema}.oauth_requests`)} WHERE id=${mixedGrant.id}`;
      assert.deepEqual(remainingGrant.boardIds, [kept.id]);
      const caches =
        await tx`SELECT * FROM ${tx(`${schema}.api_idempotency`)} ORDER BY key`;
      assert.equal(caches.length, originalCaches.length);
      for (const cache of caches) {
        const original = originalCaches.find((item) => item.key === cache.key)!;
        assert.equal(cache.actorKey, original.actorKey);
        assert.equal(cache.requestHash, original.requestHash);
        assert.equal(
          cache.createdAt.toISOString(),
          original.createdAt.toISOString(),
        );
        if (cache.key === "schema-outside-cache") {
          assert.equal(cache.invalidationReason, null);
          assert.equal(cache.status, 201);
          assert.ok(cache.response);
        } else {
          assert.equal(cache.invalidationReason, "deleted");
          assert.equal(cache.status, 410);
          assert.equal(cache.response, null);
          assert.deepEqual(cache.boardIds, []);
          assert.deepEqual(cache.taskIds, []);
        }
      }
      assert.equal(
        (
          await tx`SELECT id FROM ${tx(`${schema}.tasks`)} WHERE id=${outside.id}`
        ).length,
        1,
      );
      assert.deepEqual(
        await tx`SELECT * FROM pg_temp.credentials ORDER BY id`,
        credentialShadows,
      );
      assert.deepEqual(
        await tx`SELECT * FROM pg_temp.oauth_requests ORDER BY id`,
        grantShadows,
      );
      assert.deepEqual(
        await tx`SELECT * FROM pg_temp.api_idempotency ORDER BY key`,
        cacheShadows,
      );
    });
    assert.equal(
      (await callMcpTool(sole.token, "list_boards")).response.status,
      401,
    );
    const keptRead = await callMcpTool(mixed.token, "get_task", {
      taskId: outside.id,
    });
    assert.equal(keptRead.response.status, 200);
    assert.equal(keptRead.result?.isError, false);
    assert.equal(
      (keptRead.result?.structuredContent?.task as { id: string }).id,
      outside.id,
    );
    assert.equal(
      (await request(`/api/tasks/${outside.id}`, { token: mixed.token }))
        .status,
      403,
    );
  });
}

import { after, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { cleanupDatabase, resetDatabase, sql } from "./support.js";

beforeEach(resetDatabase);
after(cleanupDatabase);
async function fixture() {
  const workspace = randomUUID();
  await sql`INSERT INTO workspace(id,name) VALUES(${workspace},'Human authority workspace')`;
  const [admin] =
    await sql`INSERT INTO users(id,workspace_id,name,email,role,password_hash) VALUES(${randomUUID()},${workspace},'Admin','admin@schema.test','admin','unused') RETURNING id`;
  const [member] =
    await sql`INSERT INTO users(id,workspace_id,name,email,role,password_hash) VALUES(${randomUUID()},${workspace},'Member','member@schema.test','member','unused') RETURNING id`;
  const [board] =
    await sql`INSERT INTO boards(workspace_id,name,prefix) VALUES(${workspace},'Work','WORK') RETURNING id`;
  return { admin, member, board };
}
async function insertTask(
  boardId: string,
  userId: string,
  assigneeId: string | null = null,
) {
  const [row] =
    await sql`INSERT INTO tasks(board_id,identifier,title,created_by,assignee_id) VALUES(${boardId},${randomUUID()},'Assigned work',${userId},${assigneeId}) RETURNING id,version`;
  return row;
}
test("disabling a human clears responsibility and retries and revokes human OAuth without Agent state", async () => {
  const { admin, member, board } = await fixture();
  const task = await insertTask(board.id, admin.id, member.id);
  await sql`INSERT INTO api_idempotency(actor_key,key,request_hash,response,status,task_ids) VALUES('other-user','disabled-assignee','hash','{}',201,ARRAY[${task.id}::uuid])`;
  const [credential] =
    await sql`INSERT INTO credentials(user_id,name,token_hash,token_prefix,scopes,token_type,board_ids,expires_at) VALUES(${member.id},'Approved connection','hash','prefix',ARRAY['read'],'oauth',ARRAY[${board.id}::uuid],now()+interval '1 day') RETURNING id`;
  await sql`UPDATE users SET disabled_at=now() WHERE id=${member.id}`;
  const [cleared] =
    await sql`SELECT assignee_id,version FROM tasks WHERE id=${task.id}`;
  assert.deepEqual(cleared, { assigneeId: null, version: 2 });
  assert.deepEqual(
    (
      await sql`SELECT response,status,invalidation_reason FROM api_idempotency WHERE key='disabled-assignee'`
    )[0],
    { response: null, status: 410, invalidationReason: "access" },
  );
  assert.ok(
    (await sql`SELECT revoked_at FROM credentials WHERE id=${credential.id}`)[0]
      .revokedAt,
  );
  await assert.rejects(insertTask(board.id, admin.id, member.id), {
    code: "23514",
  });
});
test("deleting a board narrows approved OAuth grants and invalidates cached board responses", async () => {
  const { admin, board } = await fixture();
  const [other] =
    await sql`INSERT INTO boards(workspace_id,name,prefix) SELECT workspace_id,'Other','OTHER' FROM users WHERE id=${admin.id} RETURNING id`;
  const [credential] =
    await sql`INSERT INTO credentials(user_id,name,token_hash,token_prefix,scopes,token_type,board_ids,expires_at) VALUES(${admin.id},'Two boards','two-boards','prefix',ARRAY['read'],'oauth',ARRAY[${board.id}::uuid,${other.id}::uuid],now()+interval '1 day') RETURNING id`;
  const [last] =
    await sql`INSERT INTO credentials(user_id,name,token_hash,token_prefix,scopes,token_type,board_ids,expires_at) VALUES(${admin.id},'One board','one-board','prefix',ARRAY['read'],'oauth',ARRAY[${board.id}::uuid],now()+interval '1 day') RETURNING id`;
  await sql`INSERT INTO api_idempotency(actor_key,key,request_hash,response,status,board_ids) VALUES('user','board-response','hash','{}',201,ARRAY[${board.id}::uuid])`;
  await sql`DELETE FROM boards WHERE id=${board.id}`;
  assert.deepEqual(
    (
      await sql`SELECT board_ids,revoked_at FROM credentials WHERE id=${credential.id}`
    )[0],
    { boardIds: [other.id], revokedAt: null },
  );
  const [revoked] =
    await sql`SELECT board_ids,revoked_at FROM credentials WHERE id=${last.id}`;
  assert.deepEqual(revoked.boardIds, []);
  assert.ok(revoked.revokedAt);
  assert.deepEqual(
    (
      await sql`SELECT response,status,invalidation_reason FROM api_idempotency WHERE key='board-response'`
    )[0],
    { response: null, status: 410, invalidationReason: "deleted" },
  );
});
test("a waiting assignment cannot survive a concurrent human disable", async () => {
  const { admin, member, board } = await fixture();
  let release!: () => void;
  let locked!: () => void;
  const hold = new Promise<void>((resolve) => {
    release = resolve;
  });
  const ready = new Promise<void>((resolve) => {
    locked = resolve;
  });
  const disable = sql.begin(async (tx) => {
    await tx`UPDATE users SET disabled_at=now() WHERE id=${member.id}`;
    locked();
    await hold;
  });
  await ready;
  const assignment = insertTask(board.id, admin.id, member.id);
  const rejected = assert.rejects(assignment, { code: "23514" });
  release();
  await Promise.all([disable, rejected]);
  assert.equal(
    (await sql`SELECT id FROM tasks WHERE assignee_id=${member.id}`).length,
    0,
  );
});

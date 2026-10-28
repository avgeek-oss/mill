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
    await sql`INSERT INTO credentials(user_id,name,token_hash,token_prefix,scopes,token_type,board_ids,expires_at) VALUES(${member.id},'Approved connection','hash','prefix',ARRAY['viewer'],'oauth',ARRAY[${board.id}::uuid],now()+interval '1 day') RETURNING id`;
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

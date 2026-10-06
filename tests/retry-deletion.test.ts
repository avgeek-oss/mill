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
async function json(response: Response, status = 200) {
  assert.equal(response.status, status, await response.clone().text());
  return response.json();
}
async function terminalRetry(
  path: string,
  options: Parameters<typeof request>[1],
) {
  const replay = await request(path, options);
  assert.equal(replay.headers.get("Idempotency-Replayed"), "true");
  const result = await json(replay, 410);
  assert.equal(result.error.code, "retry_invalidated");
  return result;
}
async function saved(key: string) {
  const [row] = await sql`SELECT * FROM api_idempotency WHERE key=${key}`;
  assert.ok(row);
  return row;
}
async function assertTombstone(
  key: string,
  original: Awaited<ReturnType<typeof saved>>,
) {
  const current = await saved(key);
  assert.equal(current.actorKey, original.actorKey);
  assert.equal(current.key, original.key);
  assert.equal(current.requestHash, original.requestHash);
  assert.equal(
    current.createdAt.toISOString(),
    original.createdAt.toISOString(),
  );
  assert.equal(current.status, 410);
  assert.equal(current.response, null);
  assert.equal(current.invalidationReason, "deleted");
  assert.deepEqual(current.boardIds, []);
  assert.deepEqual(current.taskIds, []);
}
async function fixture() {
  const admin = await setupUser();
  const { board } = await json(
    await request("/api/boards", {
      cookie: admin.cookie,
      body: { name: "Retry work", prefix: "RETRY" },
    }),
    201,
  );
  return { ...admin, board };
}

test("an exact task creation retry cannot recreate permanently deleted work", async () => {
  const { cookie, board } = await fixture();
  const key = "create-task-after-delete";
  const path = `/api/boards/${board.id}/tasks`;
  const options = {
    cookie,
    body: {
      title: "Sensitive original title",
      description: "Sensitive original description",
    },
    headers: { "Idempotency-Key": key },
  };
  const { task } = await json(await request(path, options), 201);
  const original = await saved(key);
  await json(
    await request(`/api/tasks/${task.id}`, {
      cookie,
      method: "DELETE",
      body: { version: task.version },
      headers: { "Idempotency-Key": "delete-task-acknowledgment" },
    }),
  );
  await assertTombstone(key, original);
  await terminalRetry(path, options);
  assert.equal(
    (await sql`SELECT id FROM tasks WHERE board_id=${board.id}`).length,
    0,
  );
  const [counter] =
    await sql`SELECT next_number FROM boards WHERE id=${board.id}`;
  assert.equal(counter.nextNumber, 2);
  const replay = await request(`/api/tasks/${task.id}`, {
    cookie,
    method: "DELETE",
    body: { version: task.version },
    headers: { "Idempotency-Key": "delete-task-acknowledgment" },
  });
  assert.equal(replay.headers.get("Idempotency-Replayed"), "true");
  assert.deepEqual(await json(replay), { ok: true });
});

test("an exact board creation retry cannot recreate a permanently deleted board", async () => {
  const { cookie } = await setupUser();
  const key = "create-board-after-delete";
  const options = {
    cookie,
    body: {
      name: "Sensitive board",
      prefix: "GONE",
      description: "Sensitive board description",
    },
    headers: { "Idempotency-Key": key },
  };
  const { board } = await json(await request("/api/boards", options), 201);
  const original = await saved(key);
  const deletion = {
    cookie,
    method: "DELETE",
    body: { version: board.version },
    headers: { "Idempotency-Key": "delete-board-acknowledgment" },
  };
  await json(await request(`/api/boards/${board.id}`, deletion));
  await assertTombstone(key, original);
  await terminalRetry("/api/boards", options);
  assert.equal((await sql`SELECT id FROM boards`).length, 0);
  const replay = await request(`/api/boards/${board.id}`, deletion);
  assert.equal(replay.headers.get("Idempotency-Replayed"), "true");
  assert.deepEqual(await json(replay), { ok: true });
});

for (const action of ["edit", "comment"] as const) {
  test(`a late exact task ${action} retry retains only a terminal key after deletion`, async () => {
    const { cookie, board } = await fixture();
    const { task } = await json(
      await request(`/api/boards/${board.id}/tasks`, {
        cookie,
        body: { title: "Initial work" },
      }),
      201,
    );
    const key = `late-task-${action}-retry`;
    const path = `/api/tasks/${task.id}${action === "comment" ? "/comments" : ""}`;
    const options = {
      cookie,
      method: action === "comment" ? "POST" : "PATCH",
      body:
        action === "comment"
          ? { body: "Sensitive discussion content" }
          : {
              version: task.version,
              title: "Sensitive edited title",
              description: "Sensitive edited description",
            },
      headers: { "Idempotency-Key": key },
    };
    const changed = await json(
      await request(path, options),
      action === "comment" ? 201 : 200,
    );
    const original = await saved(key);
    await json(
      await request(`/api/tasks/${task.id}`, {
        cookie,
        method: "DELETE",
        body: {
          version: action === "edit" ? changed.task.version : task.version,
        },
      }),
    );
    await assertTombstone(key, original);
    await terminalRetry(path, options);
    assert.equal((await sql`SELECT id FROM tasks`).length, 0);
    assert.equal((await sql`SELECT id FROM comments`).length, 0);
    assert.equal(
      (await sql`SELECT id FROM activity WHERE task_id=${task.id}`).length,
      0,
    );
    assert.equal(
      (
        await request(path, {
          ...options,
          body:
            action === "comment"
              ? { body: "Different content" }
              : { version: task.version, title: "Different title" },
        })
      ).status,
      409,
    );
  });
}

test("a retained legacy upgrade retry key returns a terminal response and cannot repeat its mutation", async () => {
  const { cookie } = await setupUser();
  const key = "legacy-upgrade-retry-key";
  const options = {
    cookie,
    body: { name: "Work created before upgrade", prefix: "LEGACY" },
    headers: { "Idempotency-Key": key },
  };
  await json(await request("/api/boards", options), 201);
  const original = await saved(key);
  await sql`UPDATE api_idempotency SET response=NULL,status=410,invalidation_reason='upgrade',board_ids='{}',task_ids='{}' WHERE key=${key}`;
  const result = await terminalRetry("/api/boards", options);
  assert.match(result.error.message, /upgrade/);
  assert.equal((await sql`SELECT id FROM boards`).length, 1);
  const current = await saved(key);
  assert.equal(current.actorKey, original.actorKey);
  assert.equal(current.requestHash, original.requestHash);
  assert.equal(current.response, null);
});

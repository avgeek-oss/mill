import { after, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import {
  cleanupDatabase,
  request,
  resetDatabase,
  setupAgent,
  setupUser,
  sql,
} from "./support.js";

beforeEach(resetDatabase);
after(cleanupDatabase);
async function json(response: Response, status = 200) {
  assert.equal(response.status, status, await response.clone().text());
  return response.json();
}

test("task detail preserves maximum Unicode content while comment and activity previews remain bounded", async () => {
  const { cookie, user } = await setupUser();
  const { board } = await json(
    await request("/api/boards", {
      cookie,
      body: { name: "Long content", prefix: "LONG" },
    }),
    201,
  );
  const description = "漢".repeat(100000);
  const checklist = Array.from({ length: 100 }, (_unused, index) => ({
    id: `item-${index}`,
    text: "討".repeat(500),
    done: false,
  }));
  const { task } = await json(
    await request(`/api/boards/${board.id}/tasks`, {
      cookie,
      body: { title: "Full Unicode context", description, checklist },
    }),
    201,
  );
  await sql`INSERT INTO comments(task_id,author_id,body,created_at) SELECT ${task.id},${user.id},${"討".repeat(10000)},now()+sequence*interval '1 millisecond' FROM generate_series(1,12) sequence`;
  await sql`INSERT INTO activity(task_id,board_id,actor_id,actor_name,actor_kind,action,detail,created_at) SELECT ${task.id},${board.id},${user.id},'Admin','human','comment.created','{}',now()+sequence*interval '1 millisecond' FROM generate_series(1,10) sequence`;
  const boundedResponse = await request(
    `/api/tasks/${task.id}?commentLimit=0&activityLimit=0`,
    { cookie },
  );
  const raw = await boundedResponse.clone().text();
  assert.ok(Buffer.byteLength(raw) < 512 * 1024);
  const bounded = await json(boundedResponse);
  assert.equal(bounded.task.description, description);
  assert.deepEqual(bounded.task.checklist, checklist);
  assert.equal(bounded.task.status, "todo");
  assert.deepEqual(bounded.comments, []);
  assert.deepEqual(bounded.activity, []);
  assert.deepEqual(bounded.commentsPage, { hasMore: true, nextCursor: null });
  assert.deepEqual(bounded.activityPage, { hasMore: true, nextCursor: null });
  for (const field of ["parent", "subtasks", "subtasksPage"])
    assert.equal(Object.hasOwn(bounded, field), false);
  const preview = await json(
    await request(`/api/tasks/${task.id}?commentLimit=3&activityLimit=2`, {
      cookie,
    }),
  );
  assert.equal(preview.comments.length, 3);
  assert.equal(preview.activity.length, 2);
  for (const [path, previous, firstCursor, expected] of [
    ["comments", preview.comments, preview.commentsPage.nextCursor, 12],
    ["activity", preview.activity, preview.activityPage.nextCursor, 11],
  ] as const) {
    const ids: string[] = previous.map((item: { id: string }) => item.id);
    let cursor: string | null = firstCursor;
    while (cursor) {
      const page = await json(
        await request(
          `/api/tasks/${task.id}/${path}?limit=3&cursor=${cursor}`,
          {
            cookie,
          },
        ),
      );
      ids.push(...page.items.map((item: { id: string }) => item.id));
      assert.ok(ids.length <= expected);
      cursor = page.nextCursor;
    }
    assert.equal(ids.length, expected);
    assert.equal(new Set(ids).size, expected);
  }
  const webDefault = await json(
    await request(`/api/tasks/${task.id}`, { cookie }),
  );
  assert.equal(webDefault.comments.length, 12);
  assert.equal(webDefault.activity.length, 11);
  for (const query of [
    "commentLimit=101",
    "activityLimit=-1",
    "commentLimit=NaN",
    "subtaskLimit=0",
  ])
    assert.equal(
      (await request(`/api/tasks/${task.id}?${query}`, { cookie })).status,
      400,
    );
});

test("task detail, comments and activity resolve permissions through the owning board", async () => {
  const { cookie } = await setupUser();
  const { board: allowed } = await json(
    await request("/api/boards", {
      cookie,
      body: { name: "Allowed", prefix: "ALLOW" },
    }),
    201,
  );
  const { board: other } = await json(
    await request("/api/boards", {
      cookie,
      body: { name: "Other", prefix: "OTHER" },
    }),
    201,
  );
  const { task } = await json(
    await request(`/api/boards/${other.id}/tasks`, {
      cookie,
      body: { title: "Other task" },
    }),
    201,
  );
  const { token } = await json(
    await request("/api/credentials", {
      cookie,
      body: {
        agentId: (await setupAgent(cookie)).id,
        name: "Limited reader",
        scopes: ["read"],
        boardIds: [allowed.id],
      },
    }),
    201,
  );
  for (const path of [
    `/api/tasks/${task.id}?commentLimit=0&activityLimit=0`,
    `/api/tasks/${task.id}/comments`,
    `/api/tasks/${task.id}/activity`,
  ])
    assert.equal((await request(path, { token })).status, 403, path);
});

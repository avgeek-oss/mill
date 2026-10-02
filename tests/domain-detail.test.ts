import { after, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import {
  cleanupDatabase,
  callMcpTool,
  request,
  resetDatabase,
  setupAgent,
  setupOAuthAgent,
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
  const { task } = await json(
    await request(`/api/boards/${board.id}/tasks`, {
      cookie,
      body: { title: "Full Unicode context", description },
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
  assert.equal(Object.hasOwn(bounded.task, "checklist"), false);
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
  const { token } = await setupOAuthAgent(cookie, {
    agentId: (await setupAgent(cookie)).id,
    scopes: ["read"],
    boardIds: [allowed.id],
  });
  const permitted = await callMcpTool(token, "get_board", {
    boardId: allowed.id,
  });
  assert.equal(permitted.response.status, 200);
  assert.equal(permitted.result?.isError, false);
  assert.equal(
    (permitted.result?.structuredContent?.board as { id: string }).id,
    allowed.id,
  );
  for (const [name, arguments_] of [
    ["get_task", { taskId: task.id, commentLimit: 0, activityLimit: 0 }],
    ["list_comments", { taskId: task.id }],
    ["get_activity", { taskId: task.id }],
  ] as const) {
    const denied = await callMcpTool(token, name, arguments_);
    assert.equal(denied.response.status, 200);
    assert.equal(denied.error, undefined);
    assert.equal(denied.result?.isError, true, name);
    assert.equal(
      denied.result?.structuredContent?.error,
      "This credential does not permit this action",
      name,
    );
    assert.equal(denied.result?.structuredContent?.task, undefined);
    assert.equal(denied.result?.structuredContent?.items, undefined);
  }
});

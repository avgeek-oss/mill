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

test("task detail preserves maximum Unicode content while previews and related metadata remain bounded", async () => {
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
  await sql`INSERT INTO tasks(board_id,column_id,identifier,title,description,parent_id,position,created_by) SELECT ${board.id},${task.columnId},'LONG-'||(sequence+1),'Child '||sequence,${"Child details ".repeat(1500)},${task.id},sequence,${user.id} FROM generate_series(1,103) sequence`;
  await sql`UPDATE boards SET next_number=105 WHERE id=${board.id}`;
  await sql`INSERT INTO comments(task_id,author_id,body,created_at) SELECT ${task.id},${user.id},${"討".repeat(10000)},now()+sequence*interval '1 millisecond' FROM generate_series(1,12) sequence`;
  await sql`INSERT INTO activity(task_id,board_id,actor_id,actor_name,actor_kind,action,detail,created_at) SELECT ${task.id},${board.id},${user.id},'Admin','human','comment.created','{}',now()+sequence*interval '1 millisecond' FROM generate_series(1,10) sequence`;
  const boundedResponse = await request(
    `/api/tasks/${task.id}?commentLimit=0&activityLimit=0&subtaskLimit=10`,
    { cookie },
  );
  const raw = await boundedResponse.clone().text();
  assert.ok(Buffer.byteLength(raw) < 512 * 1024);
  const bounded = await json(boundedResponse);
  assert.equal(bounded.task.description, description);
  assert.deepEqual(bounded.task.checklist, checklist);
  assert.deepEqual(bounded.comments, []);
  assert.deepEqual(bounded.activity, []);
  assert.deepEqual(bounded.commentsPage, { hasMore: true, nextCursor: null });
  assert.deepEqual(bounded.activityPage, { hasMore: true, nextCursor: null });
  assert.equal(bounded.subtasks.length, 10);
  assert.equal(bounded.subtasksPage.hasMore, true);
  for (const subtask of bounded.subtasks) {
    assert.equal(subtask.description, undefined);
    assert.equal(subtask.checklist, undefined);
    assert.ok(
      subtask.id &&
        subtask.identifier &&
        subtask.title &&
        subtask.columnId &&
        subtask.version,
    );
  }
  const remainingIds = [
    ...bounded.subtasks.map((subtask: { id: string }) => subtask.id),
  ];
  let cursor: string | null = bounded.subtasksPage.nextCursor;
  do {
    const page = await json(
      await request(
        `/api/tasks/${task.id}/subtasks?limit=20${cursor ? "&cursor=" + cursor : ""}`,
        { cookie },
      ),
    );
    remainingIds.push(
      ...page.items.map((subtask: { id: string }) => subtask.id),
    );
    cursor = page.nextCursor;
  } while (cursor);
  assert.equal(remainingIds.length, 103);
  assert.equal(new Set(remainingIds).size, 103);
  const child = await json(
    await request(
      `/api/tasks/${bounded.subtasks[0].id}?commentLimit=0&activityLimit=0&subtaskLimit=0`,
      { cookie },
    ),
  );
  assert.equal(child.parent.id, task.id);
  assert.equal(child.parent.description, undefined);
  assert.equal(child.parent.checklist, undefined);
  assert.equal(child.task.description, "Child details ".repeat(1500));
  const preview = await json(
    await request(
      `/api/tasks/${task.id}?commentLimit=3&activityLimit=2&subtaskLimit=7`,
      { cookie },
    ),
  );
  assert.equal(preview.comments.length, 3);
  assert.equal(preview.activity.length, 2);
  assert.equal(preview.subtasks.length, 7);
  const nextComments = await json(
    await request(
      `/api/tasks/${task.id}/comments?cursor=${preview.commentsPage.nextCursor}`,
      { cookie },
    ),
  );
  assert.equal(nextComments.items.length, 9);
  assert.equal(
    nextComments.items.some((comment: { id: string }) =>
      preview.comments.some(
        (previous: { id: string }) => previous.id === comment.id,
      ),
    ),
    false,
  );
  const webDefault = await json(
    await request(`/api/tasks/${task.id}`, { cookie }),
  );
  assert.equal(webDefault.comments.length, 12);
  assert.equal(webDefault.subtasks.length, 100);
  assert.equal(webDefault.subtasksPage.hasMore, true);
  for (const query of [
    "commentLimit=101",
    "activityLimit=-1",
    "subtaskLimit=NaN",
  ])
    assert.equal(
      (await request(`/api/tasks/${task.id}?${query}`, { cookie })).status,
      400,
    );
  assert.equal(
    (
      await request(`/api/tasks/${task.id}/subtasks?cursor=${task.id}`, {
        cookie,
      })
    ).status,
    400,
  );
});

test("related task pagination resolves permissions through the owning task", async () => {
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
      body: { title: "Other parent" },
    }),
    201,
  );
  const { token } = await json(
    await request("/api/credentials", {
      cookie,
      body: {
        name: "Limited reader",
        scopes: ["read"],
        boardIds: [allowed.id],
      },
    }),
    201,
  );
  assert.equal(
    (await request(`/api/tasks/${task.id}/subtasks`, { token })).status,
    403,
  );
  assert.equal(
    (await request(`/api/tasks/${task.id}?subtaskLimit=0`, { token })).status,
    403,
  );
});

import { after, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  cleanupDatabase,
  request,
  resetDatabase,
  setupUser,
  setupOAuth,
  callMcpTool,
  sql,
} from "./support.js";

beforeEach(resetDatabase);
after(cleanupDatabase);
async function json(response: Response, status = 200) {
  assert.equal(response.status, status, await response.clone().text());
  return response.json();
}
async function fixture() {
  const account = await setupUser();
  const { board } = await json(
    await request("/api/boards", {
      cookie: account.cookie,
      body: { name: "Discussion", prefix: "DISC" },
    }),
    201,
  );
  const { task } = await json(
    await request(`/api/boards/${board.id}/tasks`, {
      cookie: account.cookie,
      body: { title: "Threaded discussion" },
    }),
    201,
  );
  return { ...account, board, task };
}
async function add(
  cookie: string,
  taskId: string,
  body: string,
  parentId?: string,
) {
  return (
    await json(
      await request(`/api/tasks/${taskId}/comments`, {
        cookie,
        body: { body, ...(parentId ? { parentId } : {}) },
      }),
      201,
    )
  ).comment;
}
async function remove(
  cookie: string,
  comment: { id: string; version: number },
) {
  return json(
    await request(`/api/comments/${comment.id}`, {
      cookie,
      method: "DELETE",
      body: { version: comment.version },
    }),
  );
}

test("nested replies persist with exact parents, direct counts, previews and independently paginated threads", async () => {
  const { cookie, user, task } = await fixture();
  const root = await add(cookie, task.id, "First review");
  const sibling = await add(cookie, task.id, "Another topic");
  const reply = await add(cookie, task.id, "Desktop checked", root.id);
  const nested = await add(cookie, task.id, "Keyboard checked too", reply.id);
  const second = await add(cookie, task.id, "Mobile checked", root.id);
  const roots = await json(
    await request(`/api/tasks/${task.id}/comments?parentId=root&limit=1`, {
      cookie,
    }),
  );
  assert.deepEqual(
    roots.items.map((item: { id: string }) => item.id),
    [sibling.id],
  );
  assert.equal(roots.hasMore, true);
  const older = await json(
    await request(
      `/api/tasks/${task.id}/comments?parentId=root&limit=1&cursor=${sibling.id}`,
      { cookie },
    ),
  );
  assert.equal(older.items[0].id, root.id);
  assert.equal(older.items[0].replyCount, 2);
  const replies = await json(
    await request(
      `/api/tasks/${task.id}/comments?parentId=${root.id}&limit=1`,
      { cookie },
    ),
  );
  assert.equal(replies.items[0].id, second.id);
  assert.equal(replies.hasMore, true);
  const next = await json(
    await request(
      `/api/tasks/${task.id}/comments?parentId=${root.id}&cursor=${replies.nextCursor}`,
      { cookie },
    ),
  );
  assert.equal(next.items[0].id, reply.id);
  assert.equal(next.items[0].replyCount, 1);
  const child = (
    await json(await request(`/api/comments/${nested.id}`, { cookie }))
  ).comment;
  assert.equal(child.parentId, reply.id);
  assert.equal(child.replyCount, 0);
  assert.equal(child.authorId, user.id);
  assert.equal(
    (await json(await request(`/api/tasks/${task.id}/comments`, { cookie })))
      .items.length,
    5,
  );
  const preview = await json(
    await request(`/api/tasks/${task.id}?commentLimit=10`, { cookie }),
  );
  assert.equal(
    preview.comments.find((item: { id: string }) => item.id === reply.id)
      .replyCount,
    1,
  );
  await json(
    await request(
      `/api/tasks/${task.id}/comments?parentId=${reply.id}&cursor=${second.id}`,
      { cookie },
    ),
    400,
  );
  await json(
    await request(
      `/api/tasks/${task.id}/comments?parentId=root&cursor=${reply.id}`,
      { cookie },
    ),
    400,
  );
});

test("invalid, missing and cross-task parents are rejected without adding comments or activity", async () => {
  const { cookie, task, board } = await fixture();
  const { task: other } = await json(
    await request(`/api/boards/${board.id}/tasks`, {
      cookie,
      body: { title: "Other task" },
    }),
    201,
  );
  const parent = await add(cookie, other.id, "Other discussion");
  for (const [parentId, status] of [
    [parent.id, 404],
    [randomUUID(), 404],
    ["invalid", 400],
    [null, 400],
  ] as const) {
    await json(
      await request(`/api/tasks/${task.id}/comments`, {
        cookie,
        body: { body: "Bad reply", parentId },
      }),
      status,
    );
  }
  assert.equal(
    (await sql`SELECT id FROM comments WHERE task_id=${task.id}`).length,
    0,
  );
  assert.equal(
    (
      await sql`SELECT id FROM activity WHERE task_id=${task.id} AND action='comment.created'`
    ).length,
    0,
  );
  await json(
    await request(`/api/tasks/${task.id}/comments?parentId=${parent.id}`, {
      cookie,
    }),
    404,
  );
  await json(
    await request(`/api/tasks/${task.id}/comments?parentId=`, { cookie }),
    400,
  );
  await assert.rejects(
    sql`INSERT INTO comments(task_id,parent_id,author_id,body) VALUES(${task.id},${parent.id},${parent.authorId},'Invalid cross-task relationship')`,
    { code: "23503" },
  );
  await assert.rejects(
    sql`UPDATE comments SET parent_id=id WHERE id=${parent.id}`,
    { code: "23514" },
  );
});

test("deleting a comment preserves its replies under the nearest remaining ancestor and protects stale versions", async () => {
  const { cookie, task } = await fixture();
  const root = await add(cookie, task.id, "Root");
  const reply = await add(cookie, task.id, "Reply", root.id);
  const nested = await add(cookie, task.id, "Nested", reply.id);
  await remove(cookie, reply);
  const promoted = (
    await json(await request(`/api/comments/${nested.id}`, { cookie }))
  ).comment;
  assert.equal(promoted.parentId, root.id);
  assert.equal(promoted.body, nested.body);
  assert.equal(promoted.version, nested.version + 1);
  await json(
    await request(`/api/comments/${nested.id}`, {
      cookie,
      method: "DELETE",
      body: { version: nested.version },
    }),
    409,
  );
  await remove(cookie, root);
  const roots = await json(
    await request(`/api/tasks/${task.id}/comments?parentId=root`, { cookie }),
  );
  assert.equal(roots.items.length, 1);
  assert.equal(roots.items[0].id, nested.id);
  assert.equal(roots.items[0].parentId, null);
  await json(await request(`/api/comments/${reply.id}`, { cookie }), 404);
  await json(
    await request(`/api/tasks/${task.id}`, {
      cookie,
      method: "DELETE",
      body: { version: task.version },
    }),
  );
  assert.equal(
    (await sql`SELECT id FROM comments WHERE task_id=${task.id}`).length,
    0,
  );
});

test("reply creation and parent deletion serialize without orphaning or losing replies", async () => {
  const { cookie, task } = await fixture();
  const root = await add(cookie, task.id, "Root");
  const [created, deleted] = await Promise.all([
    request(`/api/tasks/${task.id}/comments`, {
      cookie,
      body: { body: "Concurrent reply", parentId: root.id },
    }),
    request(`/api/comments/${root.id}`, {
      cookie,
      method: "DELETE",
      body: { version: root.version },
    }),
  ]);
  assert.equal(deleted.status, 200);
  assert.ok([201, 404].includes(created.status), await created.clone().text());
  const rows =
    await sql`SELECT parent_id,body FROM comments WHERE task_id=${task.id}`;
  assert.equal(rows.length, created.status === 201 ? 1 : 0);
  if (rows.length) assert.equal(rows[0].parentId, null);
});

test("MCP replies, mentions and idempotent retry use the same thread contract and access rules", async () => {
  const { cookie, task } = await fixture();
  const root = await add(cookie, task.id, "Root");
  const sibling = await add(cookie, task.id, "Other root");
  const oauth = await setupOAuth(cookie);
  const args = {
    taskId: task.id,
    body: "MCP reply",
    parentId: root.id,
    idempotencyKey: randomUUID(),
  };
  const result = await callMcpTool(oauth.token, "add_comment", args);
  assert.equal(result.result?.isError, false, JSON.stringify(result.result));
  const retry = await callMcpTool(oauth.token, "add_comment", args);
  assert.deepEqual(
    retry.result?.structuredContent,
    result.result?.structuredContent,
  );
  const mismatch = await callMcpTool(oauth.token, "add_comment", {
    ...args,
    parentId: sibling.id,
  });
  assert.equal(mismatch.result?.isError, true);
  const list = await callMcpTool(oauth.token, "list_comments", {
    taskId: task.id,
    parentId: root.id,
  });
  assert.equal(list.result?.isError, false, JSON.stringify(list.result));
  const structured = list.result!.structuredContent as {
    items: { parentId: string }[];
  };
  assert.equal(structured.items.length, 1);
  assert.equal(structured.items[0].parentId, root.id);
  const invitation = await json(
    await request("/api/auth/invitations", {
      cookie,
      body: { email: "reviewer@example.test", role: "member" },
    }),
    201,
  );
  const joined = await request("/api/auth/accept-invitation", {
    body: {
      token: invitation.token,
      name: "Reviewer",
      password: "Another secure passphrase 42!",
    },
  });
  const { user: reviewer } = await json(joined, 201);
  await add(
    cookie,
    task.id,
    `@reviewer@example.test Please check this`,
    root.id,
  );
  assert.equal(
    (
      await sql`SELECT id FROM notifications WHERE task_id=${task.id} AND user_id=${reviewer.id} AND kind='mention'`
    ).length,
    1,
  );
  const reviewerCookie = joined.headers.get("set-cookie")!.split(";")[0];
  await json(
    await request(`/api/comments/${root.id}`, {
      cookie: reviewerCookie,
      method: "DELETE",
      body: { version: root.version },
    }),
    403,
  );
  await sql`UPDATE users SET role='viewer' WHERE id=${reviewer.id}`;
  await json(
    await request(`/api/tasks/${task.id}/comments`, {
      cookie: reviewerCookie,
      body: { body: "Forbidden reply", parentId: root.id },
    }),
    403,
  );
  const { board: otherBoard } = await json(
    await request("/api/boards", {
      cookie,
      body: { name: "Other", prefix: "OTHER" },
    }),
    201,
  );
  const restricted = await setupOAuth(cookie, { boardIds: [otherBoard.id] });
  const denied = await callMcpTool(restricted.token, "list_comments", {
    taskId: task.id,
    parentId: root.id,
  });
  assert.equal(denied.result?.isError, true);
});

test("REST and MCP cap replies at three levels and recalculate depth after parent deletion", async () => {
  const { cookie, task, user } = await fixture();
  const root = await add(cookie, task.id, "Root at depth zero");
  const first = await add(cookie, task.id, "First reply level", root.id);
  const second = await add(cookie, task.id, "Second reply level", first.id);
  const third = await add(cookie, task.id, "Third reply level", second.id);
  const denied = await json(
    await request(`/api/tasks/${task.id}/comments`, {
      cookie,
      body: { body: "Fourth level is forbidden", parentId: third.id },
    }),
    400,
  );
  assert.equal(denied.error.code, "COMMENT_DEPTH_LIMIT");
  assert.equal(
    (await sql`SELECT id FROM comments WHERE task_id=${task.id}`).length,
    4,
  );
  const oauth = await setupOAuth(cookie);
  const mcp = await callMcpTool(oauth.token, "add_comment", {
    taskId: task.id,
    body: "MCP cannot bypass the limit",
    parentId: third.id,
  });
  assert.equal(mcp.result?.isError, true);
  assert.match(JSON.stringify(mcp.result), /COMMENT_DEPTH_LIMIT/);
  const [legacy] =
    await sql`INSERT INTO comments(task_id,parent_id,author_id,body) VALUES(${task.id},${third.id},${user.id},'Existing deeper reply') RETURNING id`;
  const retained = await json(
    await request(`/api/tasks/${task.id}/comments?parentId=${third.id}`, {
      cookie,
    }),
  );
  assert.equal(retained.items[0].id, legacy.id);
  await json(
    await request(`/api/tasks/${task.id}/comments`, {
      cookie,
      body: { body: "Cannot extend a legacy deep thread", parentId: legacy.id },
    }),
    400,
  );
  await remove(cookie, first);
  const accepted = await add(
    cookie,
    task.id,
    "New third level after promotion",
    third.id,
  );
  assert.equal(accepted.parentId, third.id);
});

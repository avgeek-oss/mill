import { after, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import type { BoardSummary } from "../packages/contracts/src/index.js";
import {
  callMcpTool,
  cleanupDatabase,
  request,
  resetDatabase,
  setupOAuth,
  setupUser,
  sql,
} from "./support.js";

beforeEach(resetDatabase);
after(cleanupDatabase);

type BoardPage = {
  items: BoardSummary[];
  hasMore: boolean;
  nextCursor: string | null;
};

async function json(response: Response, status = 200) {
  assert.equal(response.status, status, await response.clone().text());
  return response.json();
}

async function createBoard(cookie: string, name: string, prefix: string) {
  return (
    await json(
      await request("/api/boards", { cookie, body: { name, prefix } }),
      201,
    )
  ).board;
}

async function addTasks(
  boardId: string,
  userId: string,
  status: string,
  count: number,
) {
  await sql`INSERT INTO tasks(board_id,identifier,title,status,created_by)
    SELECT ${boardId},${boardId}||'-'||${status}||'-'||sequence,'Task '||sequence,${status},${userId}
    FROM generate_series(1,${count}) sequence`;
}

async function summaries(cookie: string, query = ""): Promise<BoardPage> {
  return json(await request(`/api/boards${query}`, { cookie }));
}

test("board cards count every task across all six statuses, including beyond task pagination", async () => {
  const { cookie, user } = await setupUser();
  const populated = await createBoard(cookie, "Alpha", "ALPHA");
  const empty = await createBoard(cookie, "Bravo", "BRAVO");
  const terminal = await createBoard(cookie, "Charlie", "CHARLIE");
  for (const [status, count] of [
    ["backlog", 151],
    ["todo", 101],
    ["in_progress", 2],
    ["in_review", 3],
    ["done", 5],
    ["wont_do", 7],
  ] as const)
    await addTasks(populated.id, user.id, status, count);
  await addTasks(terminal.id, user.id, "done", 2);
  await addTasks(terminal.id, user.id, "wont_do", 3);

  const taskPage = await json(
    await request(`/api/boards/${populated.id}/tasks?limit=25`, { cookie }),
  );
  assert.equal(taskPage.items.length, 25);
  assert.equal(taskPage.total, 269);

  const first = await summaries(cookie, "?limit=1");
  assert.equal(first.items[0].id, populated.id);
  assert.equal(first.items[0].backlogCount, 151);
  assert.equal(first.items[0].activeCount, 106);
  assert.equal(first.items[0].inProgressCount, 2);
  assert.equal(first.items[0].todoCount, 101);
  assert.equal(first.hasMore, true);
  assert.ok(first.nextCursor);
  const second = await summaries(cookie, `?limit=1&cursor=${first.nextCursor}`);
  assert.equal(second.items[0].id, empty.id);
  assert.equal(second.items[0].backlogCount, 0);
  assert.equal(second.items[0].activeCount, 0);
  assert.equal(second.items[0].inProgressCount, 0);
  assert.equal(second.items[0].todoCount, 0);
  const third = await summaries(cookie, `?limit=1&cursor=${second.nextCursor}`);
  assert.equal(third.items[0].id, terminal.id);
  assert.equal(third.items[0].backlogCount, 0);
  assert.equal(third.items[0].activeCount, 0);
  assert.equal(third.items[0].inProgressCount, 0);
  assert.equal(third.items[0].todoCount, 0);
  assert.equal(third.hasMore, false);
  const directory = await summaries(cookie, "?directory=true");
  assert.deepEqual(directory.items, (await summaries(cookie)).items);

  const detail = await json(
    await request(`/api/boards/${populated.id}`, { cookie }),
  );
  assert.equal(Object.hasOwn(detail.board, "backlogCount"), false);
  assert.equal(Object.hasOwn(populated, "backlogCount"), false);

  let task = (
    await json(
      await request(`/api/boards/${empty.id}/tasks`, {
        cookie,
        body: { title: "New backlog work", status: "backlog" },
      }),
      201,
    )
  ).task;
  let updated = (await summaries(cookie)).items.find(
    (row) => row.id === empty.id,
  )!;
  assert.equal(updated.backlogCount, 1);
  assert.equal(updated.activeCount, 0);
  assert.equal(updated.inProgressCount, 0);
  assert.equal(updated.todoCount, 0);
  task = (
    await json(
      await request(`/api/tasks/${task.id}`, {
        cookie,
        method: "PATCH",
        body: { version: task.version, status: "todo" },
      }),
    )
  ).task;
  updated = (await summaries(cookie)).items.find((row) => row.id === empty.id)!;
  assert.equal(updated.backlogCount, 0);
  assert.equal(updated.activeCount, 1);
  assert.equal(updated.inProgressCount, 0);
  assert.equal(updated.todoCount, 1);
  task = (
    await json(
      await request(`/api/tasks/${task.id}`, {
        cookie,
        method: "PATCH",
        body: { version: task.version, status: "in_progress" },
      }),
    )
  ).task;
  updated = (await summaries(cookie)).items.find((row) => row.id === empty.id)!;
  assert.equal(updated.backlogCount, 0);
  assert.equal(updated.activeCount, 1);
  assert.equal(updated.inProgressCount, 1);
  assert.equal(updated.todoCount, 0);
  task = (
    await json(
      await request(`/api/tasks/${task.id}`, {
        cookie,
        method: "PATCH",
        body: { version: task.version, status: "in_review" },
      }),
    )
  ).task;
  updated = (await summaries(cookie)).items.find((row) => row.id === empty.id)!;
  assert.equal(updated.backlogCount, 0);
  assert.equal(updated.activeCount, 1);
  assert.equal(updated.inProgressCount, 0);
  assert.equal(updated.todoCount, 0);
  await json(
    await request(`/api/tasks/${task.id}`, {
      cookie,
      method: "DELETE",
      body: { version: task.version },
    }),
  );
  updated = (await summaries(cookie)).items.find((row) => row.id === empty.id)!;
  assert.equal(updated.backlogCount, 0);
  assert.equal(updated.activeCount, 0);
  assert.equal(updated.inProgressCount, 0);
  assert.equal(updated.todoCount, 0);
  const continued = await summaries(
    cookie,
    `?limit=1&cursor=${first.nextCursor}`,
  );
  assert.equal(continued.items[0].id, empty.id);
});

test("viewer sessions and personal REST keys receive the same authorized board summaries", async () => {
  const { cookie, user } = await setupUser();
  const board = await createBoard(cookie, "Shared work", "SHARED");
  await addTasks(board.id, user.id, "backlog", 4);
  await addTasks(board.id, user.id, "todo", 6);
  await addTasks(board.id, user.id, "in_progress", 8);
  await addTasks(board.id, user.id, "in_review", 9);
  const invitation = await json(
    await request("/api/auth/invitations", {
      cookie,
      body: { email: "viewer@example.test", role: "viewer" },
    }),
    201,
  );
  const accepted = await request("/api/auth/accept-invitation", {
    body: {
      token: invitation.token,
      name: "Viewer",
      password: "Another secure passphrase 42!",
    },
  });
  await json(accepted, 201);
  const viewerCookie = accepted.headers.get("set-cookie")!.split(";")[0];
  const viewer = await summaries(viewerCookie);
  assert.equal(viewer.items[0].backlogCount, 4);
  assert.equal(viewer.items[0].activeCount, 23);
  assert.equal(viewer.items[0].inProgressCount, 8);
  assert.equal(viewer.items[0].todoCount, 6);
  const issued = await json(
    await request("/api/credentials", {
      cookie: viewerCookie,
      body: { name: "Read summaries", expiresInDays: 30 },
    }),
    201,
  );
  const keyed = await json(
    await request("/api/boards", { token: issued.token }),
  );
  assert.deepEqual(keyed.items, viewer.items);
  assert.equal(
    (
      await request(`/api/boards/${board.id}/tasks`, {
        cookie: viewerCookie,
        body: { title: "Unauthorized work" },
      })
    ).status,
    403,
  );
  assert.equal((await request("/api/boards")).status, 401);
});

test("MCP board summaries expose counts only for the credential's accessible boards", async () => {
  const { cookie, user } = await setupUser();
  const allowed = await createBoard(cookie, "Alpha allowed", "ALLOWED");
  const hidden = await createBoard(cookie, "Bravo hidden", "HIDDEN");
  const allowedEmpty = await createBoard(cookie, "Charlie allowed", "EMPTY");
  await addTasks(allowed.id, user.id, "backlog", 2);
  await addTasks(allowed.id, user.id, "in_progress", 3);
  await addTasks(allowed.id, user.id, "todo", 5);
  await addTasks(allowed.id, user.id, "in_review", 7);
  await addTasks(hidden.id, user.id, "backlog", 61);
  await addTasks(hidden.id, user.id, "in_review", 73);
  const scoped = await setupOAuth(cookie, {
    scopes: ["read"],
    boardIds: [allowed.id, allowedEmpty.id],
  });
  async function mcpPage(args: Record<string, unknown>): Promise<BoardPage> {
    const result = await callMcpTool(scoped.token, "list_boards", args);
    assert.equal(result.response.status, 200);
    assert.equal(result.result?.isError, false, JSON.stringify(result));
    return result.result!.structuredContent as BoardPage;
  }
  const first = await mcpPage({ limit: 1 });
  assert.equal(first.items[0].id, allowed.id);
  assert.equal(first.items[0].backlogCount, 2);
  assert.equal(first.items[0].activeCount, 15);
  assert.equal(first.items[0].inProgressCount, 3);
  assert.equal(first.items[0].todoCount, 5);
  assert.ok(first.nextCursor);
  const second = await mcpPage({ limit: 1, cursor: first.nextCursor });
  assert.equal(second.items[0].id, allowedEmpty.id);
  assert.equal(second.items[0].backlogCount, 0);
  assert.equal(second.items[0].activeCount, 0);
  assert.equal(second.items[0].inProgressCount, 0);
  assert.equal(second.items[0].todoCount, 0);
  assert.equal(second.hasMore, false);
  assert.equal(JSON.stringify([first, second]).includes(hidden.id), false);
  assert.equal(
    (await request("/api/boards", { token: scoped.token })).status,
    403,
  );
  await sql`UPDATE credentials SET board_ids=ARRAY[]::uuid[] WHERE id=${scoped.credential.id}`;
  assert.deepEqual(await mcpPage({}), {
    items: [],
    hasMore: false,
    nextCursor: null,
  });
});

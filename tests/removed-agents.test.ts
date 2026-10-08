import { after, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  cleanupDatabase,
  request,
  resetDatabase,
  setupOAuth,
  setupUser,
  callMcpTool,
  sql,
} from "./support.js";

beforeEach(resetDatabase);
after(cleanupDatabase);
async function json<T = Record<string, unknown>>(
  response: Response,
  status = 200,
): Promise<T> {
  assert.equal(response.status, status, await response.clone().text());
  return response.json() as Promise<T>;
}

test("Agent routes and task assignment/filter fields are absent without changing existing work", async () => {
  const { cookie } = await setupUser();
  const { board } = await json<{ board: { id: string } }>(
    await request("/api/boards", {
      cookie,
      body: { name: "Human work", prefix: "WORK" },
    }),
    201,
  );
  const { task } = await json<{ task: { id: string; version: number } }>(
    await request(`/api/boards/${board.id}/tasks`, {
      cookie,
      body: { title: "Preserve work" },
    }),
    201,
  );
  assert.equal("agentId" in task, false);
  assert.equal("agentName" in task, false);
  const snapshot = await sql`SELECT * FROM tasks ORDER BY id`;
  const removed = randomUUID();
  for (const [path, method, body] of [
    ["/api/agents", "GET", undefined],
    ["/api/agents?manage=true", "GET", undefined],
    ["/api/agents", "POST", { name: "No identity" }],
    [`/api/agents/${removed}`, "GET", undefined],
    [`/api/agents/${removed}`, "PATCH", { version: 1, name: "No identity" }],
    [`/api/agents/${removed}`, "DELETE", { version: 1 }],
  ] as const)
    assert.equal(
      (await request(path, { cookie, method, body })).status,
      404,
      `${method} ${path}`,
    );
  assert.equal(
    (
      await request(`/api/boards/${board.id}/tasks`, {
        cookie,
        body: { title: "Removed assignment", agentId: removed },
      })
    ).status,
    400,
  );
  assert.equal(
    (
      await request(`/api/tasks/${task.id}`, {
        cookie,
        method: "PATCH",
        body: { version: task.version, agentId: removed },
      })
    ).status,
    400,
  );
  assert.equal(
    (
      await request(`/api/boards/${board.id}/tasks?agentId=unassigned`, {
        cookie,
      })
    ).status,
    400,
  );
  assert.deepEqual(await sql`SELECT * FROM tasks ORDER BY id`, snapshot);
});

test("MCP authenticates directly as its human owner and has no Agent tool or assignment schema", async () => {
  const { cookie, user } = await setupUser();
  const { board } = await json<{ board: { id: string } }>(
    await request("/api/boards", {
      cookie,
      body: { name: "Connected board", prefix: "MCP" },
    }),
    201,
  );
  const oauth = await setupOAuth(cookie, { boardIds: [board.id] });
  assert.equal("agentId" in oauth.credential, false);
  assert.equal("agentName" in oauth.credential, false);
  for (const name of [
    "list_agents",
    "get_agent",
    "create_agent",
    "update_agent",
    "delete_agent",
  ]) {
    const removed = await callMcpTool(oauth.token, name);
    assert.equal(removed.result?.isError, true, name);
  }
  const added = await callMcpTool(oauth.token, "create_task", {
    boardId: board.id,
    title: "Human-owned OAuth work",
  });
  assert.equal(added.result?.isError, false, JSON.stringify(added.result));
  const task = added.result!.structuredContent!.task as {
    id: string;
    version: number;
    assigneeId: string | null;
  };
  assert.equal(task.assigneeId, null);
  assert.equal("agentId" in task, false);
  const [history] =
    await sql`SELECT actor_id,actor_name,actor_kind FROM activity WHERE task_id=${task.id} AND action='task.created'`;
  assert.equal(history.actorId, user.id);
  assert.equal(history.actorName, user.name);
  assert.equal(history.actorKind, "oauth");
  for (const [name, args] of [
    [
      "create_task",
      { boardId: board.id, title: "Removed field", agentId: randomUUID() },
    ],
    ["update_task", { taskId: task.id, version: task.version, agentId: null }],
    ["list_tasks", { boardId: board.id, agentId: "unassigned" }],
  ] as const) {
    const denied = await callMcpTool(oauth.token, name, args);
    assert.equal(denied.result?.isError, true, name);
    assert.match(JSON.stringify(denied.result?.content), /Invalid arguments/);
  }
  assert.equal((await sql`SELECT id FROM tasks`).length, 1);
});

test("OAuth consent is tied directly to the signed-in human and rejects retired Agent input", async () => {
  const { cookie, user } = await setupUser();
  const { digest, secret } =
    await import("../apps/api/src/external/protocol.js");
  const redirect = "http://127.0.0.1:4182/human-consent";
  const client = await json<{ client_id: string }>(
    await request("/oauth/register", {
      body: {
        client_name: "Human-owned connection",
        redirect_uris: [redirect],
        token_endpoint_auth_method: "none",
      },
    }),
    201,
  );
  const response = await request(
    `/oauth/authorize?${new URLSearchParams({
      client_id: client.client_id,
      redirect_uri: redirect,
      resource: `${process.env.MILL_API_URL}/mcp`,
      response_type: "code",
      scope: "read write",
      code_challenge_method: "S256",
      code_challenge: digest(secret()),
    })}`,
  );
  assert.equal(response.status, 302);
  const grantId = new URL(response.headers.get("location")!).searchParams.get(
    "request",
  )!;
  const details = await json<{ user: { name: string }; canApprove: boolean }>(
    await request(`/api/oauth/consent/${grantId}`, { cookie }),
  );
  assert.equal(details.user.name, user.name);
  assert.equal(details.canApprove, true);
  assert.equal("agents" in details, false);
  assert.equal("requiresAgent" in details, false);
  assert.equal(
    (
      await request(`/api/oauth/consent/${grantId}`, {
        cookie,
        body: { allow: true, agentId: randomUUID() },
      })
    ).status,
    400,
  );
  const decision = await json<{ redirectTo: string }>(
    await request(`/api/oauth/consent/${grantId}`, {
      cookie,
      body: { allow: true },
    }),
  );
  assert.ok(new URL(decision.redirectTo).searchParams.get("code"));
  const [stored] =
    await sql`SELECT user_id,board_ids FROM oauth_requests WHERE id=${grantId}`;
  assert.equal(stored.userId, user.id);
  assert.equal(stored.boardIds, null);
  assert.equal("agentId" in stored, false);
});

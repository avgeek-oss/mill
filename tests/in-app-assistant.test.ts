import { after, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import {
  cleanupDatabase,
  request,
  resetDatabase,
  setupUser,
  sql,
} from "./support.js";
import { createAgent } from "@avgeek-oss/agent-core";
import { PostgresStorage } from "@avgeek-oss/agent-core/postgres";
import {
  agentConfiguration,
  agentMcpServer,
  agentPrincipal,
  callAgentTool,
  requiresAssistantConfirmation,
  closeAgent,
} from "../apps/api/src/agent.js";
import { tools } from "../apps/api/src/external/tools.js";

process.env.AGENT_API_KEY = "disposable-local-test-key";
await import("../apps/api/src/app.js");
beforeEach(resetDatabase);
after(async () => {
  await closeAgent();
  await cleanupDatabase();
});

async function principal(cookie: string) {
  const value = await agentPrincipal(
    new Request(process.env.MILL_API_URL!, { headers: { cookie } }),
  );
  assert.ok(value);
  return value;
}

async function invite(cookie: string, role: "viewer" | "member") {
  const response = await request("/api/auth/invitations", {
    cookie,
    body: { email: `${role}-${randomUUID()}@example.test`, role },
  });
  assert.equal(response.status, 201);
  const { token } = (await response.json()) as { token: string };
  const accepted = await request("/api/auth/accept-invitation", {
    body: { token, name: role, password: "Safe local test password 42!" },
  });
  assert.equal(accepted.status, 201);
  return {
    cookie: accepted.headers.get("set-cookie")!.split(";")[0]!,
    user: ((await accepted.json()) as { user: { id: string } }).user,
  };
}

test("assistant is absent without a provider and rejects anonymous, bearer and expired browser sessions", async () => {
  assert.equal(agentConfiguration({}), undefined);
  const admin = await setupUser();
  const status = await request("/api/auth/status");
  assert.equal(
    ((await status.json()) as { assistantEnabled: boolean }).assistantEnabled,
    true,
  );
  assert.equal((await request("/agent/conversations")).status, 401);
  assert.equal(
    (
      await request("/agent/conversations", {
        cookie: admin.cookie,
        headers: { Authorization: "Bearer mill_invalid" },
      })
    ).status,
    401,
  );
  const issued = await request("/api/credentials", {
    cookie: admin.cookie,
    body: {
      name: "Local read key",
      access: "read",
      includeAdmin: false,
      expiresAt: new Date(Date.now() + 30 * 86400000).toISOString(),
    },
  });
  assert.equal(issued.status, 201);
  const { token } = (await issued.json()) as { token: string };
  assert.equal((await request("/agent/conversations", { token })).status, 401);
  await sql`DELETE FROM sessions`;
  assert.equal(
    (await request("/agent/conversations", { cookie: admin.cookie })).status,
    401,
  );
});

test("conversation history belongs to one signed-in human within the team", async () => {
  const admin = await setupUser();
  const second = await invite(admin.cookie, "member");
  const adminPrincipal = await principal(admin.cookie);
  const otherPrincipal = await principal(second.cookie);
  const id = randomUUID();
  await sql`INSERT INTO agent_conversations(id,owner_id,title) VALUES(${id},${adminPrincipal.id},'Private conversation')`;
  assert.equal(
    (await request(`/agent/conversations/${id}`, { cookie: admin.cookie }))
      .status,
    200,
  );
  assert.equal(
    (await request(`/agent/conversations/${id}`, { cookie: second.cookie }))
      .status,
    404,
  );
  assert.equal(
    (
      await request(`/agent/conversations/${id}`, {
        cookie: second.cookie,
        method: "DELETE",
      })
    ).status,
    404,
  );
  assert.equal(
    (
      (await request("/agent/conversations", { cookie: second.cookie }).then(
        (r) => r.json(),
      )) as { conversations: unknown[] }
    ).conversations.length,
    0,
  );
  assert.notEqual(adminPrincipal.id, otherPrincipal.id);
});

test("tool calls use the live browser session, REST validation and human activity attribution", async () => {
  const admin = await setupUser();
  const member = await invite(admin.cookie, "member");
  const boardResponse = await request("/api/boards", {
    cookie: admin.cookie,
    body: { name: "Assistant board", prefix: "AST" },
  });
  const { board } = (await boardResponse.json()) as { board: { id: string } };
  const p = await principal(member.cookie);
  const create = tools.find((tool) => tool.name === "create_task")!;
  const bad = await callAgentTool(p, create, {
    boardId: board.id,
    title: "Bad",
    agentId: randomUUID(),
  });
  assert.equal(bad.isError, true);
  assert.match(JSON.stringify(bad.content), /Invalid arguments/);
  const created = await callAgentTool(p, create, {
    boardId: board.id,
    title: "Human-owned task",
    idempotencyKey: randomUUID(),
  });
  assert.equal(created.isError, false, JSON.stringify(created.content));
  const [activity] =
    await sql`SELECT actor_id,actor_kind FROM activity WHERE action='task.created'`;
  assert.equal(activity.actorId, member.user.id);
  assert.equal(activity.actorKind, "human");
  await sql`UPDATE users SET role='viewer' WHERE id=${member.user.id}`;
  const denied = await callAgentTool(p, create, {
    boardId: board.id,
    title: "No write",
  });
  assert.equal(denied.isError, true);
  assert.equal((await sql`SELECT id FROM tasks`).length, 1);
  await sql`DELETE FROM sessions WHERE user_id=${member.user.id}`;
  const invalid = await callAgentTool(
    p,
    tools.find((tool) => tool.name === "list_boards")!,
    {},
  );
  assert.equal(invalid.isError, true);
});

function fakeClient(input: { boardId: string; title: string }) {
  let calls = 0;
  return {
    messages: {
      stream: () => ({
        on: () => undefined,
        finalMessage: async () => ({
          content:
            calls++ === 0
              ? [
                  {
                    type: "tool_use",
                    id: "write-1",
                    name: "create_task",
                    input,
                  },
                ]
              : [{ type: "text", text: "Done." }],
          stop_reason: calls === 1 ? "tool_use" : "end_turn",
          usage: { input_tokens: 1, output_tokens: 1 },
          model: "local-fake",
        }),
      }),
    },
  } as unknown as NonNullable<Parameters<typeof createAgent>[0]["client"]>;
}

test("every write pauses for approval; rejection does not mutate and approval executes the real tool", async () => {
  const admin = await setupUser();
  const boardResponse = await request("/api/boards", {
    cookie: admin.cookie,
    body: { name: "Approvals", prefix: "APR" },
  });
  const { board } = (await boardResponse.json()) as { board: { id: string } };
  const p = await principal(admin.cookie);
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    max: 2,
    options: `-c search_path=${process.env.MILL_DB_SCHEMA}`,
  });
  try {
    assert.equal(
      requiresAssistantConfirmation({
        name: "update_task",
        inputSchema: { type: "object" },
        annotations: { readOnlyHint: false, destructiveHint: false },
      }),
      true,
    );
    for (const approved of [false, true]) {
      const title = approved ? "Approved task" : "Declined task";
      const agent = createAgent({
        appName: "Mill",
        provider: { model: "local-fake", profile: "compatible" },
        client: fakeClient({ boardId: board.id, title }),
        mcpServer: agentMcpServer,
        storage: new PostgresStorage(pool),
        requiresConfirmation: requiresAssistantConfirmation,
      });
      const events: Array<{ type: string; [key: string]: unknown }> = [];
      const step = await agent.startStep(p, {
        type: "user_message",
        text: `Create ${title}`,
        clientTools: [],
      });
      await step.run((event) => events.push(event));
      const pending = events.find((event) => event.type === "awaiting_input");
      assert.ok(pending, JSON.stringify(events));
      assert.equal(
        (await sql`SELECT id FROM tasks WHERE title=${title}`).length,
        0,
      );
      const resolution = await agent.startStep(p, {
        type: "resolve_tool_calls",
        conversationId: step.conversationId,
        resolutions: [{ kind: "confirmation", toolUseId: "write-1", approved }],
        clientTools: [],
      });
      await resolution.run((event) => events.push(event));
      assert.equal(
        (await sql`SELECT id FROM tasks WHERE title=${title}`).length,
        approved ? 1 : 0,
      );
    }
    const demoted = createAgent({
      appName: "Mill",
      provider: { model: "local-fake", profile: "compatible" },
      client: fakeClient({ boardId: board.id, title: "Demoted task" }),
      mcpServer: agentMcpServer,
      storage: new PostgresStorage(pool),
      requiresConfirmation: requiresAssistantConfirmation,
    });
    const paused = await demoted.startStep(p, {
      type: "user_message",
      text: "Create a task",
      clientTools: [],
    });
    await paused.run(() => {});
    await sql`UPDATE users SET role='viewer' WHERE id=${admin.user.id}`;
    const resumed = await demoted.startStep(p, {
      type: "resolve_tool_calls",
      conversationId: paused.conversationId,
      resolutions: [
        { kind: "confirmation", toolUseId: "write-1", approved: true },
      ],
      clientTools: [],
    });
    await resumed.run(() => {});
    assert.equal(
      (await sql`SELECT id FROM tasks WHERE title='Demoted task'`).length,
      0,
    );
  } finally {
    await pool.end();
  }
});

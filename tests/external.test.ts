import {
  cleanupDatabase,
  request,
  resetDatabase,
  setupUser,
  setupOAuth,
  sql,
} from "./support.js";
import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { serve } from "@hono/node-server";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { app } from "../apps/api/src/app.js";
import { credentialActor } from "../apps/api/src/external.js";
import { TASK_STATUSES, type Task } from "../packages/contracts/src/index.js";
type BoardResult = {
  board: { id: string; version: number };
};
type TaskResult = { task: Task };
type CredentialResult = {
  credential: {
    id: string;
    name: string;
    scopes: string[];
    boardIds: string[] | null;
  };
  token: string;
};
async function ok<T>(response: Response): Promise<T> {
  const body = await response.json();
  assert(response.ok, `${response.status}: ${JSON.stringify(body)}`);
  return body as T;
}
async function result<T>(
  client: Client,
  name: string,
  args: Record<string, unknown>,
): Promise<T> {
  const value = await client.callTool({ name, arguments: args });
  assert.equal(value.isError, false, JSON.stringify(value));
  return value.structuredContent as T;
}
test("External credentials and actual MCP task workflows enforce current permission boundaries", async (t) => {
  await resetDatabase();
  const { cookie, user } = await setupUser();
  const first = await ok<BoardResult>(
    await request("/api/boards", {
      cookie,
      body: { name: "Connected board", prefix: "MCP" },
    }),
  );
  const second = await ok<BoardResult>(
    await request("/api/boards", {
      cookie,
      body: { name: "Private scope", prefix: "PRIVATE" },
    }),
  );
  const outside = await ok<TaskResult>(
    await request(`/api/boards/${second.board.id}/tasks`, {
      cookie,
      body: { title: "Outside credential scope" },
    }),
  );
  const write = await ok<CredentialResult>(
    await request("/api/credentials", {
      cookie,
      body: {
        name: "Integration worker",
        access: "edit",
        includeAdmin: false,
        expiresAt: new Date(Date.now() + 30 * 86400000).toISOString(),
      },
    }),
  );
  const read = await ok<CredentialResult>(
    await request("/api/credentials", {
      cookie,
      body: {
        name: "Read worker",
        access: "read",
        includeAdmin: false,
        expiresAt: new Date(Date.now() + 30 * 86400000).toISOString(),
      },
    }),
  );
  const personalRest = write;
  try {
    await t.test(
      "one-time hashed expiring credentials and human-only ownership management",
      async () => {
        assert(
          /^mill_[A-Za-z0-9_-]{43}$/.test(write.token),
          "Credential token has the expected format",
        );
        assert.equal("agentId" in write.credential, false);
        assert.equal("agentName" in write.credential, false);
        const principal = await credentialActor(
          new Request(`${process.env.MILL_BASE_URL}/api/boards`, {
            headers: { Authorization: `Bearer ${write.token}` },
          }),
        );
        assert.equal("agentId" in principal!, false);
        assert.equal(principal?.userId, user.id);
        assert.equal(principal?.name, user.name);
        assert.equal(principal?.kind, "human");
        assert.equal(principal?.credentialType, "api-key");
        const [stored] =
          await sql`SELECT * FROM credentials WHERE id=${write.credential.id}`;
        assert(
          stored.tokenHash !== write.token,
          "Credential storage does not contain the bearer token",
        );
        assert(!JSON.stringify(write.credential).includes("tokenHash"));
        assert(
          new Date(stored.expiresAt).getTime() > Date.now() + 29 * 86400000,
        );
        assert.equal(
          (await request("/api/credentials", { token: write.token })).status,
          403,
        );
        assert.equal(
          (
            await request("/api/credentials", {
              token: write.token,
              body: { name: "Escalate", scopes: ["read", "write"] },
            })
          ).status,
          403,
        );
        assert.equal(
          (
            await request("/api/credentials", {
              cookie,
              body: {
                name: "Invalid boards",
                scopes: ["read"],
                boardIds: [randomUUID()],
              },
            })
          ).status,
          400,
        );
        assert.equal(
          (
            await request("/api/credentials", {
              cookie,
              body: {
                name: "Unbounded",
                scopes: ["read"],
                expiresInDays: 366,
              },
            })
          ).status,
          400,
        );
      },
    );
    await t.test(
      "personal keys can work within their grant but cannot open browser settings",
      async () => {
        const list = await ok<{ items: { id: string }[] }>(
          await request("/api/boards", { token: write.token }),
        );
        assert.deepEqual(
          new Set(list.items.map((item) => item.id)),
          new Set([first.board.id, second.board.id]),
        );
        await ok(
          await request(`/api/tasks/${outside.task.id}`, {
            token: write.token,
          }),
        );
        const created = await ok<TaskResult>(
          await request(`/api/boards/${second.board.id}/tasks`, {
            token: write.token,
            body: { title: "Personal REST task" },
          }),
        );
        const events = await ok<{
          items: { actorKind: string; actorName: string }[];
        }>(
          await request(`/api/tasks/${created.task.id}/activity`, {
            token: write.token,
          }),
        );
        assert(
          events.items.some(
            (event) =>
              event.actorKind === "human" && event.actorName === user.name,
          ),
        );
        for (const path of [
          "/api/workspace",
          "/api/auth/me",
          "/api/auth/sessions",
          "/api/auth/members",
          "/api/credentials",
        ])
          assert.equal(
            (await request(path, { token: write.token })).status,
            403,
            path,
          );
        for (const options of [{ cookie }, { token: write.token }]) {
          assert.equal((await request("/api/export", options)).status, 404);
          assert.equal(
            (await request("/api/import", { ...options, body: {} })).status,
            404,
          );
        }
      },
    );
    await t.test(
      "installed MCP SDK creates, changes fixed statuses, comments, permanently deletes and retries against a live HTTP server",
      async () => {
        const personal = personalRest;
        const server = serve({
          fetch: app.fetch,
          hostname: "127.0.0.1",
          port: 0,
        });
        await new Promise<void>((resolve) => server.on("listening", resolve));
        const address = server.address();
        assert(address && typeof address !== "string");
        const previous = process.env.MILL_BASE_URL;
        process.env.MILL_BASE_URL = `http://127.0.0.1:${address.port}`;
        const write = await setupOAuth(cookie, {
          scopes: ["read", "write"],
          boardIds: [first.board.id],
        });
        const read = await setupOAuth(cookie, {
          scopes: ["read"],
          boardIds: [first.board.id],
        });
        const client = new Client({
          name: "mill-external-integration",
          version: "1.0.0",
        });
        const transport = new StreamableHTTPClientTransport(
          new URL(`${process.env.MILL_BASE_URL}/mcp`),
          {
            requestInit: {
              headers: { Authorization: `Bearer ${write.token}` },
            },
          },
        );
        try {
          await client.connect(transport);
          const listed = await client.listTools();
          assert(listed.tools.some((tool) => tool.name === "create_task"));
          assert(!listed.tools.some((tool) => tool.name === "create_board"));
          assert(!listed.tools.some((tool) => tool.name === "list_members"));
          assert(!listed.tools.some((tool) => tool.name === "list_agents"));
          for (const name of [
            "list_agents",
            "get_agent",
            "create_agent",
            "update_agent",
            "delete_agent",
            "list_columns",
            "create_column",
            "update_column",
            "delete_column",
            "move_task",
            "list_subtasks",
            "import_workspace",
            "export_workspace",
          ]) {
            assert(!listed.tools.some((tool) => tool.name === name), name);
            assert.equal(
              (await client.callTool({ name, arguments: {} })).isError,
              true,
              name,
            );
          }
          for (const name of ["create_task", "update_task", "list_tasks"]) {
            const schema = listed.tools.find((tool) => tool.name === name)!
              .inputSchema.properties!;
            assert.deepEqual((schema.status as { enum: string[] }).enum, [
              ...TASK_STATUSES,
            ]);
            for (const field of [
              "columnId",
              "beforeId",
              "position",
              "labels",
              "label",
              "parentId",
            ])
              assert(!(field in schema), `${name}.${field}`);
          }
          for (const name of ["create_task", "update_task"]) {
            const schema = listed.tools.find((tool) => tool.name === name)!
              .inputSchema.properties!;
            assert.deepEqual((schema.type as { enum: string[] }).enum, [
              "task",
              "bug",
            ]);
          }
          const boardSchema = listed.tools.find(
            (tool) => tool.name === "update_board",
          )!.inputSchema.properties!;
          assert(!("beforeId" in boardSchema));
          assert(!("position" in boardSchema));
          const detailSchema = listed.tools.find(
            (tool) => tool.name === "get_task",
          )!.inputSchema.properties!;
          assert(!("subtaskLimit" in detailSchema));
          let boardState = await result<BoardResult>(client, "get_board", {
            boardId: first.board.id,
          });
          assert.deepEqual(Object.keys(boardState), ["board"]);
          assert(!("position" in boardState.board));
          const removedId = randomUUID();
          for (const options of [{ cookie }, { token: personal.token }]) {
            for (const [path, method, body] of [
              [`/api/boards/${first.board.id}/columns`, "GET", undefined],
              [
                `/api/boards/${first.board.id}/columns`,
                "POST",
                { name: "Custom status" },
              ],
              [
                `/api/columns/${removedId}`,
                "PATCH",
                { version: 1, name: "Custom status" },
              ],
              [`/api/columns/${removedId}`, "DELETE", { version: 1 }],
              [
                `/api/tasks/${outside.task.id}/move`,
                "POST",
                { version: 1, columnId: removedId },
              ],
              [`/api/tasks/${outside.task.id}/subtasks`, "GET", undefined],
            ] as const)
              assert.equal(
                (await request(path, { ...options, method, body })).status,
                404,
                `${method} ${path}`,
              );
          }
          boardState = await result<BoardResult>(client, "update_board", {
            boardId: first.board.id,
            version: boardState.board.version,
            name: "Connected work",
          });
          assert.equal(boardState.board.version, 2);
          const args = {
            boardId: first.board.id,
            title: "Actual MCP task",
            type: "bug",
            assigneeId: user.id,
            description: "**Markdown** task",
            priority: "high",
            startDate: "2026-09-30",
            dueDate: "2026-10-01",
            idempotencyKey: "mcp-create-retry-0001",
          };
          let task = await result<TaskResult>(client, "create_task", args);
          assert.equal(task.task.status, "todo");
          assert.equal(task.task.type, "bug");
          assert.equal(task.task.startDate, "2026-09-30");
          assert.equal("agentId" in task.task, false);
          assert.equal("agentName" in task.task, false);
          assert.equal(task.task.assigneeId, user.id);
          const withoutHuman = await result<TaskResult>(client, "create_task", {
            ...args,
            title: "Unassigned OAuth task",
            type: undefined,
            startDate: undefined,
            assigneeId: null,
            idempotencyKey: "mcp-unassigned-task",
          });
          assert.equal(withoutHuman.task.assigneeId, null);
          assert.equal(withoutHuman.task.type, "task");
          assert.equal(withoutHuman.task.startDate, null);
          assert.equal("agentId" in withoutHuman.task, false);
          const assigned = await result<{ items: TaskResult["task"][] }>(
            client,
            "list_tasks",
            { boardId: first.board.id },
          );
          assert.deepEqual(
            assigned.items.map((item) => item.id),
            [withoutHuman.task.id, task.task.id],
          );
          const detail = await result<TaskResult>(client, "get_task", {
            taskId: task.task.id,
          });
          assert.equal("agentId" in detail.task, false);
          assert.equal(detail.task.startDate, "2026-09-30");
          assert.equal("agentName" in detail.task, false);
          for (const [name, arguments_] of [
            [
              "update_board",
              {
                boardId: first.board.id,
                version: boardState.board.version,
                beforeId: null,
              },
            ],
            ["get_task", { taskId: task.task.id, subtaskLimit: 1 }],
          ] as const) {
            const invalid = await client.callTool({
              name,
              arguments: arguments_,
            });
            assert.equal(invalid.isError, true);
            assert.match(JSON.stringify(invalid.content), /Invalid arguments/);
          }
          for (const field of ["columnId", "position", "labels", "parentId"])
            assert(!(field in task.task), field);
          for (const removed of [
            { columnId: randomUUID() },
            { labels: ["integration"] },
            { parentId: task.task.id },
            { position: 1 },
          ]) {
            const invalid = await client.callTool({
              name: "create_task",
              arguments: { ...args, ...removed },
            });
            assert.equal(invalid.isError, true);
            assert.match(JSON.stringify(invalid.content), /Invalid arguments/);
          }
          assert.equal(
            (
              await client.callTool({
                name: "create_task",
                arguments: { ...args, status: "custom_review" },
              })
            ).isError,
            true,
          );
          for (const startDate of ["2026-02-29", "2026-10-01T00:00:00Z"]) {
            const invalid = await client.callTool({
              name: "create_task",
              arguments: { ...args, startDate },
            });
            assert.equal(invalid.isError, true);
            assert.match(JSON.stringify(invalid.content), /Invalid arguments/);
          }
          const retry = await result<TaskResult>(client, "create_task", args);
          assert.equal(retry.task.id, task.task.id);
          const [count] =
            await sql`SELECT count(*)::int AS total FROM tasks WHERE title='Actual MCP task'`;
          assert.equal(count.total, 1);
          task = await result<TaskResult>(client, "update_task", {
            taskId: task.task.id,
            version: task.task.version,
            title: "Actual MCP task edited",
            startDate: "2028-02-29",
            type: "task",
            status: "in_progress",
          });
          assert.equal(task.task.title, "Actual MCP task edited");
          assert.equal(task.task.startDate, "2028-02-29");
          assert.equal(task.task.dueDate, "2026-10-01");
          assert.equal(task.task.type, "task");
          assert.equal(task.task.status, "in_progress");
          const stale = await client.callTool({
            name: "update_task",
            arguments: {
              taskId: task.task.id,
              version: 1,
              title: "Stale update",
              startDate: "2026-10-02",
              type: "bug",
            },
          });
          assert.equal(stale.isError, true);
          for (const status of TASK_STATUSES) {
            task = await result<TaskResult>(client, "update_task", {
              taskId: task.task.id,
              version: task.task.version,
              status,
            });
            assert.equal(task.task.status, status);
          }
          for (const removed of [
            { columnId: randomUUID() },
            { beforeId: null },
            { labels: ["integration"] },
            { parentId: outside.task.id },
            { position: 1 },
            { status: "custom_review" },
            { type: "feature" },
            { startDate: "2026-02-29" },
            { startDate: "2026-10-01T00:00:00Z" },
          ]) {
            const invalid = await client.callTool({
              name: "update_task",
              arguments: {
                taskId: task.task.id,
                version: task.task.version,
                ...removed,
              },
            });
            assert.equal(invalid.isError, true);
            assert.match(JSON.stringify(invalid.content), /Invalid arguments/);
          }
          for (const removed of [
            { columnId: randomUUID() },
            { label: "integration" },
            { sort: "position" },
            { status: "custom_review" },
            { type: "feature" },
          ])
            assert.equal(
              (
                await client.callTool({
                  name: "list_tasks",
                  arguments: { boardId: first.board.id, ...removed },
                })
              ).isError,
              true,
            );
          task = await result<TaskResult>(client, "update_task", {
            taskId: task.task.id,
            version: task.task.version,
            startDate: null,
          });
          assert.equal(task.task.startDate, null);
          assert.equal(task.task.dueDate, "2026-10-01");
          const reviewArguments = {
            taskId: task.task.id,
            status: "in_review",
            version: task.task.version,
            idempotencyKey: "mcp-status-retry-0001",
          };
          task = await result<TaskResult>(
            client,
            "update_task",
            reviewArguments,
          );
          const reviewedRetry = await result<TaskResult>(
            client,
            "update_task",
            reviewArguments,
          );
          assert.equal(task.task.status, "in_review");
          assert.deepEqual(reviewedRetry, task);
          const comment = await result<{
            comment: { id: string; version: number };
          }>(client, "add_comment", {
            taskId: task.task.id,
            body: "The integration worker completed this",
            idempotencyKey: "mcp-comment-retry-0001",
          });
          const commentRetry = await result<{
            comment: { id: string; version: number };
          }>(client, "add_comment", {
            taskId: task.task.id,
            body: "The integration worker completed this",
            idempotencyKey: "mcp-comment-retry-0001",
          });
          assert.equal(commentRetry.comment.id, comment.comment.id);
          assert(
            !(await client.listTools()).tools.some(
              (tool) => tool.name === "update_comment",
            ),
          );
          const activity = await result<{
            items: { actorKind: string; actorName: string }[];
          }>(client, "get_activity", { taskId: task.task.id });
          assert(
            activity.items.some(
              (entry) =>
                entry.actorKind === "oauth" && entry.actorName === user.name,
            ),
          );
          const filter = await result<{ items: { id: string }[] }>(
            client,
            "list_tasks",
            {
              boardId: first.board.id,
              q: "edited",
              status: "in_review",
              priority: "high",
              sort: "dueDate",
              limit: 1,
            },
          );
          assert.deepEqual(
            filter.items.map((item) => item.id),
            [task.task.id],
          );
          await result(client, "delete_comment", {
            commentId: comment.comment.id,
            version: comment.comment.version,
          });
          const deletion = await result<{ ok: boolean }>(
            client,
            "delete_task",
            {
              taskId: task.task.id,
              version: task.task.version,
              idempotencyKey: "mcp-permanent-task-delete",
            },
          );
          assert.equal(deletion.ok, true);
          assert.equal(
            (await sql`SELECT id FROM tasks WHERE id=${task.task.id}`).length,
            0,
          );
          const replayed = await result<{ ok: boolean }>(
            client,
            "delete_task",
            {
              taskId: task.task.id,
              version: task.task.version,
              idempotencyKey: "mcp-permanent-task-delete",
            },
          );
          assert.equal(replayed.ok, true);
          assert.equal(
            (await client.listTools()).tools.some(
              (tool) => tool.name === "restore_task",
            ),
            false,
          );
          const forbidden = await client.callTool({
            name: "get_task",
            arguments: { taskId: outside.task.id },
          });
          assert.equal(forbidden.isError, true);
          for (const [name, arguments_] of [
            ["get_board", { boardId: second.board.id }],
            ["list_tasks", { boardId: second.board.id }],
            ["list_comments", { taskId: outside.task.id }],
            ["get_activity", { taskId: outside.task.id }],
          ] as const)
            assert.equal(
              (await client.callTool({ name, arguments: arguments_ })).isError,
              true,
              name,
            );
          assert.equal(
            (await request("/api/boards", { token: write.token })).status,
            403,
          );
          const invitation = await ok<{ token: string }>(
            await request("/api/auth/invitations", {
              cookie,
              body: { email: "mcp-member@example.test", role: "member" },
            }),
          );
          const accepted = await request("/api/auth/accept-invitation", {
            body: {
              token: invitation.token,
              name: "MCP member",
              password: "A private member passphrase 42!",
            },
          });
          assert.equal(accepted.status, 201);
          const memberCookie = accepted.headers
            .get("set-cookie")!
            .split(";")[0]!;
          const insideAssignment = await ok<TaskResult>(
            await request(`/api/boards/${first.board.id}/tasks`, {
              cookie: memberCookie,
              body: { title: "Scoped notification", assigneeId: user.id },
            }),
          );
          const outsideAssignment = await ok<TaskResult>(
            await request(`/api/boards/${second.board.id}/tasks`, {
              cookie: memberCookie,
              body: { title: "Outside notification", assigneeId: user.id },
            }),
          );
          const memberComment = await ok<{
            comment: { id: string; version: number };
          }>(
            await request(`/api/tasks/${insideAssignment.task.id}/comments`, {
              cookie: memberCookie,
              body: { body: "Another person's comment" },
            }),
          );
          assert.equal(
            (
              await client.callTool({
                name: "delete_comment",
                arguments: {
                  commentId: memberComment.comment.id,
                  version: memberComment.comment.version,
                },
              })
            ).isError,
            true,
          );
          const notifications = await result<{
            items: { taskId: string }[];
            unreadCount: number;
          }>(client, "list_notifications", { unread: true });
          assert(
            notifications.items.some(
              (item) => item.taskId === insideAssignment.task.id,
            ),
          );
          assert(
            !notifications.items.some(
              (item) => item.taskId === outsideAssignment.task.id,
            ),
          );
          const [privateNotification] =
            await sql`SELECT id FROM notifications WHERE task_id=${outsideAssignment.task.id}`;
          assert.equal(
            (
              await client.callTool({
                name: "mark_notifications",
                arguments: { ids: [privateNotification.id] },
              })
            ).isError,
            true,
          );
          await result(client, "mark_notifications", { all: true });
          const remaining = await ok<{ items: { taskId: string }[] }>(
            await request("/api/notifications?unread=true", {
              token: personal.token,
            }),
          );
          assert(
            remaining.items.some(
              (item) => item.taskId === outsideAssignment.task.id,
            ),
          );
          assert(
            !remaining.items.some(
              (item) => item.taskId === insideAssignment.task.id,
            ),
          );
          const boundedIds: string[] = [];
          for (let index = 0; index < 4; index++) {
            const created = await result<TaskResult>(client, "create_task", {
              boardId: first.board.id,
              title: `Bounded content ${index}`,
              description: "界".repeat(100000),
            });
            boundedIds.push(created.task.id);
          }
          const oversized = await client.callTool({
            name: "list_tasks",
            arguments: {
              boardId: first.board.id,
              q: "Bounded content",
              limit: 100,
            },
          });
          assert.equal(oversized.isError, true);
          assert.match(JSON.stringify(oversized.content), /size limit/);
          const bounded = await result<{ items: { id: string }[] }>(
            client,
            "list_tasks",
            { boardId: first.board.id, q: "Bounded content", limit: 1 },
          );
          assert.equal(bounded.items.length, 1);
          assert.equal(bounded.items[0]!.id, boundedIds.at(-1));
          const firstTaskPage = await result<{
            items: { id: string }[];
            hasMore: boolean;
            nextCursor: string;
          }>(client, "list_tasks", {
            boardId: first.board.id,
            q: "Bounded content",
            limit: 1,
          });
          const secondTaskPage = await result<{ items: { id: string }[] }>(
            client,
            "list_tasks",
            {
              boardId: first.board.id,
              q: "Bounded content",
              limit: 1,
              cursor: firstTaskPage.nextCursor,
            },
          );
          assert.equal(firstTaskPage.hasMore, true);
          assert.equal(firstTaskPage.items[0]!.id, boundedIds.at(-1));
          assert.equal(secondTaskPage.items[0]!.id, boundedIds.at(-2));
          const large = await result<TaskResult>(client, "create_task", {
            boardId: first.board.id,
            title: "Full-size readable task",
            description: "\u0001".repeat(100000),
          });
          await sql`INSERT INTO comments(task_id,author_id,body,created_at) SELECT ${large.task.id},${user.id},${"言".repeat(9900)},now()+sequence*interval '1 millisecond' FROM generate_series(1,100) sequence`;
          const longDetail = await result<
            TaskResult & {
              comments: unknown[];
              commentsPage: { hasMore: boolean; nextCursor: string | null };
            }
          >(client, "get_task", { taskId: large.task.id });
          assert.equal(longDetail.task.description.length, 100000);
          assert.equal(Object.hasOwn(longDetail.task, "checklist"), false);
          assert.equal(longDetail.comments.length, 0);
          assert.equal(longDetail.commentsPage.hasMore, true);
          assert.equal(longDetail.commentsPage.nextCursor, null);
          assert(!("parent" in longDetail));
          assert(!("subtasks" in longDetail));
          assert(!("subtasksPage" in longDetail));
          const commentPage = await result<{
            items: { id: string; body: string }[];
            hasMore: boolean;
            nextCursor: string;
          }>(client, "list_comments", { taskId: large.task.id, limit: 1 });
          assert.equal(commentPage.items[0]!.body.length, 9900);
          assert.equal(commentPage.hasMore, true);
          assert(commentPage.nextCursor);
          const otherComments = await result<{ items: { id: string }[] }>(
            client,
            "list_comments",
            { taskId: large.task.id, limit: 1, cursor: commentPage.nextCursor },
          );
          assert.equal(otherComments.items.length, 1);
          assert.notEqual(otherComments.items[0]!.id, commentPage.items[0]!.id);
          const readClient = new Client({
            name: "read-integration",
            version: "1.0.0",
          });
          await readClient.connect(
            new StreamableHTTPClientTransport(
              new URL(`${process.env.MILL_BASE_URL}/mcp`),
              {
                requestInit: {
                  headers: { Authorization: `Bearer ${read.token}` },
                },
              },
            ),
          );
          try {
            assert(
              (await readClient.listTools()).tools.every(
                (tool) => tool.annotations?.readOnlyHint,
              ),
            );
            await result(readClient, "list_tasks", {
              boardId: first.board.id,
              q: "edited",
              limit: 100,
            });
          } finally {
            await readClient.close();
          }
        } finally {
          await client.close();
          process.env.MILL_BASE_URL = previous;
          await new Promise<void>((resolve, reject) =>
            server.close((error) => (error ? reject(error) : resolve())),
          );
        }
      },
    );
    await t.test(
      "role downgrades, account removal, expiry and revocation apply immediately",
      async () => {
        await sql`UPDATE users SET role='viewer' WHERE id=${user.id}`;
        assert.equal(
          (
            await request(`/api/boards/${first.board.id}/tasks`, {
              token: write.token,
              body: { title: "No longer allowed" },
            })
          ).status,
          403,
        );
        assert.equal(
          (
            await request("/api/credentials", {
              cookie,
              body: {
                name: "Cannot choose scopes",
                scopes: ["read", "write"],
              },
            })
          ).status,
          400,
        );
        await sql`UPDATE credentials SET expires_at=now()-interval '1 second' WHERE id=${read.credential.id}`;
        assert.equal(
          (await request("/api/boards", { token: read.token })).status,
          401,
        );
        await sql`UPDATE users SET role='admin',disabled_at=now() WHERE id=${user.id}`;
        assert.equal(
          await credentialActor(
            new Request(`${process.env.MILL_BASE_URL}/api/boards`, {
              headers: { Authorization: `Bearer ${write.token}` },
            }),
          ),
          null,
        );
        await sql`UPDATE users SET disabled_at=NULL WHERE id=${user.id}`;
        const revocable = await ok<CredentialResult>(
          await request("/api/credentials", {
            cookie,
            body: {
              name: "Fresh revocation",
              access: "edit",
              includeAdmin: false,
              expiresAt: new Date(Date.now() + 30 * 86400000).toISOString(),
            },
          }),
        );
        await ok(
          await request(`/api/credentials/${revocable.credential.id}`, {
            cookie,
            method: "DELETE",
          }),
        );
        assert.equal(
          (await request("/api/boards", { token: revocable.token })).status,
          401,
        );
        assert.equal(
          (await request("/api/boards", { token: write.token })).status,
          401,
        );
        assert.equal((await request("/api/audit", { cookie })).status, 404);
        assert.equal(
          (await sql`SELECT id FROM activity WHERE task_id IS NULL`).length,
          0,
        );
      },
    );
  } finally {
    await cleanupDatabase();
  }
});

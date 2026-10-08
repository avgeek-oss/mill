import {
  cleanupDatabase,
  request,
  resetDatabase,
  setupUser,
  sql,
} from "./support.js";
import assert from "node:assert/strict";
import test, { after } from "node:test";
import { serve } from "@hono/node-server";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { app } from "../apps/api/src/app.js";

type Issued = {
  token: string;
  credential: {
    id: string;
    userId: string | null;
    createdBy: string;
    accessLevel: "read" | "edit";
    includeAdmin: boolean;
    expiresAt: string | null;
  };
};
const expiry = (days: 30 | 90 | 365) =>
  new Date(Date.now() + days * 86400000).toISOString();
async function json<T>(response: Response, status: number): Promise<T> {
  const value = await response.json();
  assert.equal(response.status, status, JSON.stringify(value));
  return value as T;
}
function issue(
  cookie: string,
  scope: "personal" | "team",
  access: "read" | "edit",
  includeAdmin: boolean,
  expiresAt: string | null = expiry(30),
) {
  return request(
    scope === "team" ? "/api/team-credentials" : "/api/credentials",
    {
      cookie,
      body: {
        name: `${scope}-${access}-${includeAdmin}`,
        access,
        includeAdmin,
        expiresAt,
      },
    },
  );
}
async function member(
  adminCookie: string,
  email: string,
  role: "viewer" | "member",
) {
  const invitation = await json<{ token: string }>(
    await request("/api/auth/invitations", {
      cookie: adminCookie,
      body: { email, role },
    }),
    201,
  );
  const accepted = await request("/api/auth/accept-invitation", {
    body: {
      token: invitation.token,
      name: role,
      password: "API key test passphrase 42!",
    },
  });
  const value = await json<{ user: { id: string } }>(accepted, 201);
  return {
    id: value.user.id,
    cookie: accepted.headers.get("set-cookie")!.split(";")[0]!,
  };
}

after(cleanupDatabase);
test("explicit API key policy limits REST and MCP across roles, expiry and revocation", async () => {
  await resetDatabase();
  const admin = await setupUser();
  const board = await json<{ board: { id: string; version: number } }>(
    await request("/api/boards", {
      cookie: admin.cookie,
      body: { name: "Key policy", prefix: "KEY" },
    }),
    201,
  );
  const path = `/api/boards/${board.board.id}/tasks`;
  for (const body of [
    { name: "Missing policy" },
    { name: "Missing expiry", access: "read", includeAdmin: false },
    {
      name: "Old alias",
      access: "read",
      includeAdmin: false,
      expiresInDays: 30,
    },
    { name: "No admin choice", access: "edit", expiresAt: expiry(30) },
  ]) {
    assert.equal(
      (await request("/api/credentials", { cookie: admin.cookie, body }))
        .status,
      400,
    );
  }
  const viewer = await member(
    admin.cookie,
    "key-viewer@example.test",
    "viewer",
  );
  assert.equal(
    (await issue(viewer.cookie, "personal", "edit", false)).status,
    403,
  );
  assert.equal(
    (await issue(viewer.cookie, "personal", "read", true)).status,
    403,
  );
  assert.equal(
    (await issue(viewer.cookie, "personal", "read", false, null)).status,
    403,
  );
  const viewerRead = await json<Issued>(
    await issue(viewer.cookie, "personal", "read", false),
    201,
  );
  assert.equal((await request(path, { token: viewerRead.token })).status, 200);
  assert.equal(
    (
      await request(path, {
        token: viewerRead.token,
        body: { title: "Denied" },
      })
    ).status,
    403,
  );
  await json(
    await request(`/api/auth/members/${viewer.id}`, {
      cookie: admin.cookie,
      method: "PATCH",
      body: { role: "member" },
    }),
    200,
  );
  assert.equal(
    (
      await request(path, {
        token: viewerRead.token,
        body: { title: "Still denied" },
      })
    ).status,
    403,
  );
  const memberEdit = await json<Issued>(
    await issue(viewer.cookie, "personal", "edit", false),
    201,
  );
  assert.equal(
    (
      await request(path, {
        token: memberEdit.token,
        body: { title: "Allowed" },
      })
    ).status,
    201,
  );
  await json(
    await request(`/api/auth/members/${viewer.id}`, {
      cookie: admin.cookie,
      method: "PATCH",
      body: { role: "viewer" },
    }),
    200,
  );
  assert.equal(
    (
      await request(path, {
        token: memberEdit.token,
        body: { title: "Demoted" },
      })
    ).status,
    403,
  );
  assert.equal((await request(path, { token: memberEdit.token })).status, 200);

  const adminEdit = await json<Issued>(
    await issue(admin.cookie, "personal", "edit", false),
    201,
  );
  const adminFull = await json<Issued>(
    await issue(admin.cookie, "personal", "edit", true, null),
    201,
  );
  assert.equal(adminFull.credential.expiresAt, null);
  assert.equal(
    (
      await request(`/api/boards/${board.board.id}`, {
        token: adminEdit.token,
        method: "DELETE",
        body: { version: board.board.version },
      })
    ).status,
    403,
  );
  assert.equal(
    (await request("/api/workspace", { token: adminFull.token })).status,
    403,
  );
  assert.equal(
    (await request("/api/credentials", { token: adminFull.token })).status,
    403,
  );

  const server = serve({ fetch: app.fetch, hostname: "127.0.0.1", port: 0 });
  await new Promise<void>((resolve) => server.on("listening", resolve));
  const address = server.address();
  assert(address && typeof address !== "string");
  const oldBase = process.env.MILL_API_URL;
  process.env.MILL_API_URL = `http://127.0.0.1:${address.port}`;
  async function connect(token: string) {
    const client = new Client({ name: "key-test", version: "1.0.0" });
    const transport = new StreamableHTTPClientTransport(
      new URL(`${process.env.MILL_API_URL}/mcp`),
      {
        requestInit: { headers: { Authorization: `Bearer ${token}` } },
      },
    );
    await client.connect(transport);
    return { client, transport };
  }
  try {
    const readMcp = await connect(viewerRead.token);
    try {
      const listed = await readMcp.client.listTools();
      assert(listed.tools.some((tool) => tool.name === "list_tasks"));
      assert(!listed.tools.some((tool) => tool.name === "create_task"));
      assert(!listed.tools.some((tool) => tool.name === "list_members"));
      await assert.rejects(
        readMcp.client.callTool({
          name: "create_task",
          arguments: { boardId: board.board.id, title: "Denied" },
        }),
      );
    } finally {
      await readMcp.client.close();
      await readMcp.transport.close();
    }
    const editMcp = await connect(adminEdit.token);
    try {
      const listed = await editMcp.client.listTools();
      assert(listed.tools.some((tool) => tool.name === "create_task"));
      const created = await editMcp.client.callTool({
        name: "create_task",
        arguments: { boardId: board.board.id, title: "MCP key task" },
      });
      assert.equal(created.isError, false, JSON.stringify(created));
    } finally {
      await editMcp.client.close();
      await editMcp.transport.close();
    }
  } finally {
    process.env.MILL_API_URL = oldBase;
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }

  await sql`UPDATE credentials SET expires_at=now()-interval '1 second' WHERE id=${adminEdit.credential.id}`;
  assert.equal(
    (await request("/api/boards", { token: adminEdit.token })).status,
    401,
  );
  await sql`UPDATE users SET role='viewer' WHERE id=${admin.user.id}`;
  await sql`UPDATE users SET role='admin' WHERE id=${admin.user.id}`;
  assert.equal(
    (
      await request(path, {
        token: adminFull.token,
        body: { title: "Admin access cannot return" },
      })
    ).status,
    403,
  );
  const [narrowed] =
    await sql`SELECT access_level,include_admin FROM credentials WHERE id=${adminFull.credential.id}`;
  assert.equal(narrowed.accessLevel, "read");
  assert.equal(narrowed.includeAdmin, false);
  await json(
    await request(`/api/credentials/${adminFull.credential.id}`, {
      cookie: admin.cookie,
      method: "DELETE",
    }),
    200,
  );
  assert.equal(
    (await request("/api/boards", { token: adminFull.token })).status,
    401,
  );
});

test("team keys are administrator managed and independent of creator membership", async () => {
  await resetDatabase();
  const admin = await setupUser();
  const colleague = await member(
    admin.cookie,
    "team-key-admin@example.test",
    "member",
  );
  const board = await json<{ board: { id: string; version: number } }>(
    await request("/api/boards", {
      cookie: admin.cookie,
      body: { name: "Team board", prefix: "TEAM" },
    }),
    201,
  );
  assert.equal(
    (await issue(colleague.cookie, "team", "read", false)).status,
    403,
  );
  assert.equal(
    (await request("/api/team-credentials", { cookie: colleague.cookie }))
      .status,
    403,
  );
  const teamRead = await json<Issued>(
    await issue(admin.cookie, "team", "read", false),
    201,
  );
  const teamEdit = await json<Issued>(
    await issue(admin.cookie, "team", "edit", false, null),
    201,
  );
  const teamAdmin = await json<Issued>(
    await issue(admin.cookie, "team", "edit", true, null),
    201,
  );
  assert.equal(teamRead.credential.userId, null);
  assert.equal(teamRead.credential.createdBy, admin.user.id);
  assert.equal(teamAdmin.credential.includeAdmin, true);
  assert.equal(
    (
      await request("/api/credentials", { cookie: admin.cookie }).then((r) =>
        r.json(),
      )
    ).items.some((item: { id: string }) => item.id === teamRead.credential.id),
    false,
  );
  assert.equal(
    (
      await request("/api/team-credentials", { cookie: admin.cookie }).then(
        (r) => r.json(),
      )
    ).items.length,
    3,
  );
  assert.equal(
    (
      await request(`/api/boards/${board.board.id}/tasks`, {
        token: teamRead.token,
        body: { title: "Denied" },
      })
    ).status,
    403,
  );
  const teamTask = await json<{ task: { id: string } }>(
    await request(`/api/boards/${board.board.id}/tasks`, {
      token: teamEdit.token,
      body: { title: "Team edit", assigneeId: admin.user.id },
    }),
    201,
  );
  const notifications = await json<{ items: { actorName: string }[] }>(
    await request("/api/notifications", { cookie: admin.cookie }),
    200,
  );
  assert.equal(
    notifications.items[0]?.actorName,
    "Team API key: team-edit-false",
  );
  const humanComment = await json<{ comment: { id: string; version: number } }>(
    await request(`/api/tasks/${teamTask.task.id}/comments`, {
      cookie: admin.cookie,
      body: { body: "Human comment" },
    }),
    201,
  );
  assert.equal(
    (
      await request(`/api/comments/${humanComment.comment.id}`, {
        token: teamEdit.token,
        method: "DELETE",
        body: { version: humanComment.comment.version },
      })
    ).status,
    403,
  );
  const teamComment = await json<{
    comment: {
      id: string;
      authorId: string | null;
      authorKind: string;
      authorName: string;
    };
  }>(
    await request(`/api/tasks/${teamTask.task.id}/comments`, {
      token: teamEdit.token,
      body: { body: "Team comment" },
    }),
    201,
  );
  assert.equal(teamComment.comment.authorId, null);
  assert.equal(teamComment.comment.authorKind, "team");
  assert.equal(teamComment.comment.authorName, "Team API key: team-edit-false");
  const comments = await json<{
    items: {
      id: string;
      authorId: string | null;
      authorKind: string;
      authorName: string;
    }[];
  }>(
    await request(`/api/tasks/${teamTask.task.id}/comments`, {
      cookie: admin.cookie,
    }),
    200,
  );
  const listedTeamComment = comments.items.find(
    (comment) => comment.id === teamComment.comment.id,
  );
  assert.equal(listedTeamComment?.authorId, null);
  assert.equal(listedTeamComment?.authorKind, "team");
  assert.equal(listedTeamComment?.authorName, teamComment.comment.authorName);
  assert.equal(
    (
      await request(`/api/comments/${teamComment.comment.id}`, {
        token: teamEdit.token,
        method: "DELETE",
        body: { version: 1 },
      })
    ).status,
    200,
  );
  assert.equal(
    (
      await request(`/api/boards/${board.board.id}`, {
        token: teamEdit.token,
        method: "DELETE",
        body: { version: board.board.version },
      })
    ).status,
    403,
  );
  assert.equal(
    (await request("/api/auth/members", { token: teamAdmin.token })).status,
    403,
  );
  assert.equal(
    (await request("/api/notifications", { token: teamAdmin.token })).status,
    403,
  );
  await sql`UPDATE users SET disabled_at=now() WHERE id=${admin.user.id}`;
  assert.equal(
    (await request("/api/boards", { token: teamRead.token })).status,
    200,
  );
  assert.equal(
    (
      await request(`/api/boards/${board.board.id}/tasks`, {
        token: teamEdit.token,
        body: { title: "After creator disabled" },
      })
    ).status,
    201,
  );
  assert.equal(
    (
      await request(`/api/boards/${board.board.id}`, {
        token: teamAdmin.token,
        method: "DELETE",
        body: { version: board.board.version },
      })
    ).status,
    200,
  );
  await sql`UPDATE users SET disabled_at=NULL WHERE id=${admin.user.id}`;
  await json(
    await request(`/api/team-credentials/${teamEdit.credential.id}`, {
      cookie: admin.cookie,
      method: "DELETE",
    }),
    200,
  );
  assert.equal(
    (await request("/api/boards", { token: teamEdit.token })).status,
    401,
  );
});

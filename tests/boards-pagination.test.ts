import { after, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

const {
  cleanupDatabase,
  request,
  resetDatabase,
  setupAgent,
  setupOAuthAgent,
  callMcpTool,
  setupUser,
  sql,
} = await import("./support.js");

beforeEach(resetDatabase);
after(cleanupDatabase);

async function json(response: Response, status = 200) {
  assert.equal(response.status, status, await response.clone().text());
  return response.json();
}

type Page = {
  items: {
    id: string;
    name: string;
  }[];
  hasMore: boolean;
  nextCursor: string | null;
};

async function traversal(
  path: string,
  options: { cookie?: string; token?: string },
  first: Page,
) {
  const ids = first.items.map((item) => item.id);
  let page = first;
  while (page.hasMore) {
    assert.ok(page.nextCursor);
    page = await json(
      await request(`${path}&cursor=${page.nextCursor}`, options),
    );
    ids.push(...page.items.map((item) => item.id));
  }
  assert.equal(page.nextCursor, null);
  assert.equal(new Set(ids).size, ids.length);
  return ids;
}

async function mcpPage(
  token: string,
  args: Record<string, unknown>,
): Promise<Page> {
  const call = await callMcpTool(token, "list_boards", args);
  assert.equal(call.response.status, 200);
  assert.equal(call.result?.isError, false, JSON.stringify(call.result));
  return call.result!.structuredContent as Page;
}
async function mcpTraversal(token: string, first: Page, limit = 1) {
  const ids = first.items.map((item) => item.id);
  let page = first;
  while (page.hasMore) {
    assert.ok(page.nextCursor);
    page = await mcpPage(token, { limit, cursor: page.nextCursor });
    ids.push(...page.items.map((item) => item.id));
  }
  assert.equal(page.nextCursor, null);
  assert.equal(new Set(ids).size, ids.length);
  return ids;
}

test("board pagination reaches every board and newly created boards beyond the former ceiling", async () => {
  const { cookie, user } = await setupUser();
  await sql`INSERT INTO boards(workspace_id,name,prefix) SELECT workspace_id,'Board '||sequence,'B'||sequence FROM users CROSS JOIN generate_series(1,223) sequence WHERE users.id=${user.id}`;
  const first: Page = await json(await request("/api/boards", { cookie }));
  assert.equal(first.items.length, 100);
  assert.equal(first.hasMore, true);
  assert.ok(first.nextCursor);
  assert.notEqual(first.nextCursor, first.items.at(-1)!.id);
  const created = await json(
    await request("/api/boards", {
      cookie,
      body: { name: "Created after 223 boards", prefix: "BEYOND" },
    }),
    201,
  );
  assert.equal(Object.hasOwn(created.board, "position"), false);
  assert.equal(created.board.name, "Created after 223 boards");
  const expected = (
    await sql`SELECT id FROM boards ORDER BY lower(name),name,id`
  ).map((row) => row.id);
  const stale = await json(
    await request(`/api/boards?cursor=${first.nextCursor}`, { cookie }),
    409,
  );
  assert.equal(stale.code, "board_list_changed");
  const restarted = await json(await request("/api/boards", { cookie }));
  assert.deepEqual(
    await traversal("/api/boards?limit=100", { cookie }, restarted),
    expected,
  );
  assert.ok(expected.includes(created.board.id));
  const smallFirst = await json(
    await request("/api/boards?limit=17", { cookie }),
  );
  assert.deepEqual(
    await traversal("/api/boards?limit=17", { cookie }, smallFirst),
    expected,
  );
});

test("board cursors preserve alphabetical case and identifier ties and reject inserts on either side", async () => {
  const { cookie, user } = await setupUser();
  await sql`INSERT INTO boards(workspace_id,name,prefix) SELECT workspace_id,CASE sequence%3 WHEN 0 THEN 'Precision' WHEN 1 THEN 'precision' ELSE 'PRECISION' END,'P'||sequence FROM users CROSS JOIN generate_series(1,211) sequence WHERE users.id=${user.id}`;
  const expected = (
    await sql`SELECT id FROM boards ORDER BY lower(name),name,id`
  ).map((row) => row.id);
  const first: Page = await json(
    await request("/api/boards?limit=37", { cookie }),
  );
  assert.deepEqual(
    first.items.map((item) => item.id),
    expected.slice(0, 37),
  );
  assert.deepEqual(
    await traversal("/api/boards?limit=37", { cookie }, first),
    expected,
  );
  const [before] =
    await sql`INSERT INTO boards(workspace_id,name,prefix) SELECT workspace_id,'A before cursor','BEFORE' FROM users WHERE id=${user.id} RETURNING id`;
  const [after] =
    await sql`INSERT INTO boards(workspace_id,name,prefix) SELECT workspace_id,'Z after cursor','AFTER' FROM users WHERE id=${user.id} RETURNING id`;
  const stale = await json(
    await request(`/api/boards?cursor=${first.nextCursor}`, { cookie }),
    409,
  );
  assert.equal(stale.code, "board_list_changed");
  const restarted = await json(
    await request("/api/boards?limit=37", { cookie }),
  );
  const ids = await traversal("/api/boards?limit=37", { cookie }, restarted);
  assert.deepEqual(ids, [before.id, ...expected, after.id]);
});

test("OAuth Agent board pagination keeps restrictions on every page", async () => {
  const { cookie, user } = await setupUser();
  await sql`INSERT INTO boards(workspace_id,name,prefix) SELECT workspace_id,'Filtered '||sequence,'F'||sequence FROM users CROSS JOIN generate_series(1,9) sequence WHERE users.id=${user.id}`;
  const boards =
    await sql`SELECT id,name FROM boards ORDER BY lower(name),name,id`;
  const allowedIds = [
    boards[0]!.id,
    boards[2]!.id,
    boards[4]!.id,
    boards[6]!.id,
  ];
  const credential = await setupOAuthAgent(cookie, {
    agentId: (await setupAgent(cookie)).id,
    scopes: ["read"],
    boardIds: allowedIds,
  });
  const first = await json(await request("/api/boards?limit=1", { cookie }));
  const scoped = await mcpPage(credential.token, { limit: 1 });
  assert.deepEqual(
    await traversal("/api/boards?limit=1", { cookie }, first),
    boards.map((board) => board.id),
  );
  assert.deepEqual(await mcpTraversal(credential.token, scoped), allowedIds);
  const foreign = await callMcpTool(credential.token, "list_boards", {
    cursor: first.nextCursor,
  });
  assert.equal(foreign.response.status, 200);
  assert.equal(foreign.result?.isError, true);
  assert.match(JSON.stringify(foreign.result), /accessible board list/);
  assert.equal(
    (await request("/api/boards", { token: credential.token })).status,
    403,
  );
  await sql`UPDATE credentials SET board_ids=ARRAY[]::uuid[] WHERE id=${credential.credential.id}`;
  assert.deepEqual(await mcpPage(credential.token, {}), {
    items: [],
    hasMore: false,
    nextCursor: null,
  });
  const narrowed = await callMcpTool(credential.token, "list_boards", {
    cursor: scoped.nextCursor,
  });
  assert.equal(narrowed.response.status, 200);
  assert.equal(narrowed.result?.isError, true);
  assert.match(JSON.stringify(narrowed.result), /accessible board list/);
});

test("board page validation rejects malformed, missing and wrong-collection anchors", async () => {
  const { cookie } = await setupUser();
  const credential = await json(
    await request("/api/credentials", {
      cookie,
      body: { name: "Cursor boundary", expiresInDays: 30 },
    }),
    201,
  );
  for (const cursor of [
    "",
    "not-a-uuid",
    randomUUID(),
    credential.credential.id,
  ])
    assert.equal(
      (await request(`/api/boards?cursor=${cursor}`, { cookie })).status,
      400,
    );
  for (const name of ["Cursor alpha", "Cursor bravo"])
    await json(await request("/api/boards", { cookie, body: { name } }), 201);
  const first = await json(await request("/api/boards?limit=1", { cookie }));
  const payload = JSON.parse(
    Buffer.from(first.nextCursor, "base64url").toString(),
  );
  for (const change of [
    { id: randomUUID() },
    { id: credential.credential.id },
    { name: "Wrong name" },
  ]) {
    const cursor = Buffer.from(
      JSON.stringify({ ...payload, ...change }),
    ).toString("base64url");
    assert.equal(
      (await request(`/api/boards?cursor=${cursor}`, { cookie })).status,
      400,
    );
  }
  for (const limit of ["", "0", "101", "1.5", "-1", "NaN"])
    assert.equal(
      (await request(`/api/boards?limit=${limit}`, { cookie })).status,
      400,
    );
  for (const query of ["archived=1", "deleted=yes"])
    assert.equal(
      (await request(`/api/boards?${query}`, { cookie })).status,
      400,
    );
  assert.equal((await request("/api/boards")).status, 401);
});

test("board cursors reject renamed anchors and other renamed rows before a complete restart", async () => {
  const { cookie } = await setupUser();
  const boards = [];
  for (const name of ["Alpha", "Bravo", "Charlie", "Delta"]) {
    const created = await json(
      await request("/api/boards", { cookie, body: { name } }),
      201,
    );
    boards.push(created.board);
  }
  const first = await json(await request("/api/boards?limit=2", { cookie }));
  assert.deepEqual(
    first.items.map((item: { id: string }) => item.id),
    boards.slice(0, 2).map((item) => item.id),
  );
  const renamed = await json(
    await request(`/api/boards/${boards[1].id}`, {
      cookie,
      method: "PATCH",
      body: { version: boards[1].version, name: "Zulu" },
    }),
  );
  const movedAnchor = await json(
    await request(`/api/boards?limit=2&cursor=${first.nextCursor}`, { cookie }),
    409,
  );
  assert.equal(movedAnchor.code, "board_list_changed");
  const reset = await json(await request("/api/boards?limit=2", { cookie }));
  assert.deepEqual(await traversal("/api/boards?limit=2", { cookie }, reset), [
    boards[0].id,
    boards[2].id,
    boards[3].id,
    boards[1].id,
  ]);
  const [before] =
    await sql`SELECT name,version FROM boards WHERE id=${boards[2].id}`;
  await json(
    await request(`/api/boards/${boards[1].id}`, {
      cookie,
      method: "PATCH",
      body: { version: renamed.board.version, name: "Cedar" },
    }),
  );
  const [after] =
    await sql`SELECT name,version FROM boards WHERE id=${boards[2].id}`;
  assert.deepEqual(after, before);
  const movedOther = await json(
    await request(`/api/boards?limit=2&cursor=${reset.nextCursor}`, { cookie }),
    409,
  );
  assert.equal(movedOther.code, "board_list_changed");
  const final = await json(await request("/api/boards?limit=2", { cookie }));
  assert.deepEqual(await traversal("/api/boards?limit=2", { cookie }, final), [
    boards[0].id,
    boards[1].id,
    boards[2].id,
    boards[3].id,
  ]);
});

test("directory continuation reaches every board and rejects metadata or deletion changes", async () => {
  const { cookie, user } = await setupUser();
  await sql`INSERT INTO boards(workspace_id,name,prefix) SELECT workspace_id,'Whole directory '||sequence,'WHOLE'||sequence FROM users CROSS JOIN generate_series(1,213) sequence WHERE users.id=${user.id}`;
  const path = "/api/boards?directory=true&limit=100";
  const expected = (
    await sql`SELECT id FROM boards ORDER BY lower(name),name,id`
  ).map((board) => board.id);
  let first = await json(await request(path, { cookie }));
  assert.equal(first.items.length, 100);
  assert.deepEqual(await traversal(path, { cookie }, first), expected);
  const [unvisited] = await sql`SELECT * FROM boards WHERE prefix='WHOLE151'`;
  await json(
    await request(`/api/boards/${unvisited.id}`, {
      cookie,
      method: "PATCH",
      body: { version: unvisited.version, name: "Renamed board" },
    }),
  );
  let stale = await json(
    await request(`${path}&cursor=${first.nextCursor}`, { cookie }),
    409,
  );
  assert.equal(stale.code, "board_list_changed");
  first = await json(await request(path, { cookie }));
  const [removed] = await sql`SELECT * FROM boards WHERE prefix='WHOLE153'`;
  await json(
    await request(`/api/boards/${removed.id}`, {
      cookie,
      method: "DELETE",
      body: { version: removed.version },
    }),
  );
  stale = await json(
    await request(`${path}&cursor=${first.nextCursor}`, { cookie }),
    409,
  );
  assert.equal(stale.code, "board_list_changed");
  const reset = await json(await request(path, { cookie }));
  assert.deepEqual(
    await traversal(path, { cookie }, reset),
    (await sql`SELECT id FROM boards ORDER BY lower(name),name,id`).map(
      (row) => row.id,
    ),
  );
});

test("personal API key directory pages cover current and future boards and reject cross-mode cursors", async () => {
  const { cookie, user } = await setupUser();
  await sql`INSERT INTO boards(workspace_id,name,prefix) SELECT workspace_id,'Directory '||sequence,'SCOPE'||sequence FROM users CROSS JOIN generate_series(1,8) sequence WHERE users.id=${user.id}`;
  const boards = await sql`SELECT id FROM boards ORDER BY lower(name),name,id`;
  const personal = await json(
    await request("/api/credentials", {
      cookie,
      body: { name: "Directory automation", expiresInDays: 60 },
    }),
    201,
  );
  assert.equal(personal.credential.agentId, null);
  assert.equal(personal.credential.boardIds, null);
  assert.deepEqual(personal.credential.scopes, []);
  const path = "/api/boards?directory=true&limit=1";
  const full = await json(await request(path, { cookie }));
  const keyed = await json(await request(path, { token: personal.token }));
  assert.deepEqual(
    await traversal(path, { token: personal.token }, keyed),
    boards.map((board) => board.id),
  );
  assert.deepEqual(
    await json(
      await request(`${path}&cursor=${full.nextCursor}`, {
        token: personal.token,
      }),
    ),
    await json(await request(`${path}&cursor=${full.nextCursor}`, { cookie })),
  );
  assert.deepEqual(
    await json(await request(`${path}&cursor=${keyed.nextCursor}`, { cookie })),
    await json(
      await request(`${path}&cursor=${keyed.nextCursor}`, {
        token: personal.token,
      }),
    ),
  );
  const normal = await json(await request("/api/boards?limit=1", { cookie }));
  for (const query of [
    `directory=true&cursor=${normal.nextCursor}`,
    `cursor=${full.nextCursor}`,
    `directory=false&cursor=${full.nextCursor}`,
    "directory=1",
    "directory=true&archived=false",
    "directory=true&archived=true",
    "directory=true&deleted=false",
    "directory=true&deleted=true",
  ])
    assert.equal(
      (await request(`/api/boards?${query}`, { token: personal.token })).status,
      400,
    );
  assert.equal((await request("/api/boards?directory=true")).status, 401);
  const future = await json(
    await request("/api/boards", {
      cookie,
      body: { name: "Future directory board" },
    }),
    201,
  );
  const stale = await json(
    await request(`${path}&cursor=${keyed.nextCursor}`, {
      token: personal.token,
    }),
    409,
  );
  assert.equal(stale.code, "board_list_changed");
  const restarted = await json(await request(path, { token: personal.token }));
  const expected = (
    await sql`SELECT id FROM boards ORDER BY lower(name),name,id`
  ).map((board) => board.id);
  assert.deepEqual(
    await traversal(path, { token: personal.token }, restarted),
    expected,
  );
  assert.ok(expected.includes(future.board.id));
});

test("initialized MCP clients traverse more than 100 boards and preserve board restrictions across cursors", async () => {
  const { cookie, user } = await setupUser();
  await sql`INSERT INTO boards(workspace_id,name,prefix) SELECT workspace_id,'MCP board '||sequence,'MCP'||sequence FROM users CROSS JOIN generate_series(1,221) sequence WHERE users.id=${user.id}`;
  const expected = (
    await sql`SELECT id FROM boards ORDER BY lower(name),name,id`
  ).map((row) => row.id as string);
  const restrictedIds = expected
    .filter((_id, index) => index % 2 === 0)
    .slice(0, 100);
  const { serve } = await import("@hono/node-server");
  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
  const { StreamableHTTPClientTransport } =
    await import("@modelcontextprotocol/sdk/client/streamableHttp.js");
  const { app } = await import("../apps/api/src/app.js");
  const server = serve({ fetch: app.fetch, hostname: "127.0.0.1", port: 0 });
  await new Promise<void>((resolve) => server.on("listening", resolve));
  const address = server.address();
  assert(address && typeof address !== "string");
  const previous = process.env.MILL_BASE_URL;
  process.env.MILL_BASE_URL = `http://127.0.0.1:${address.port}`;
  const clients = [
    new Client({ name: "mill-board-pagination", version: "1.0.0" }),
    new Client({ name: "mill-scoped-board-pagination", version: "1.0.0" }),
  ];
  try {
    const agent = await setupAgent(cookie);
    const read = await setupOAuthAgent(cookie, {
      agentId: agent.id,
      scopes: ["read"],
    });
    const restricted = await setupOAuthAgent(cookie, {
      agentId: agent.id,
      scopes: ["read"],
      boardIds: restrictedIds,
    });
    for (const [index, credential] of [read, restricted].entries()) {
      const client = clients[index]!;
      await client.connect(
        new StreamableHTTPClientTransport(
          new URL("/mcp", process.env.MILL_BASE_URL),
          {
            requestInit: {
              headers: { Authorization: `Bearer ${credential.token}` },
            },
          },
        ),
      );
      const listed = await client.listTools();
      assert(listed.tools.every((tool) => tool.annotations?.readOnlyHint));
      const tool = listed.tools.find((item) => item.name === "list_boards");
      assert.ok(tool?.inputSchema.properties?.limit);
      assert.ok(tool.inputSchema.properties.cursor);
      const ids: string[] = [];
      let cursor: string | null = null;
      let pages = 0;
      do {
        const value = await client.callTool({
          name: "list_boards",
          arguments: {
            ...(index === 1 ? { limit: 37 } : {}),
            ...(cursor ? { cursor } : {}),
          },
        });
        assert.equal(value.isError, false, JSON.stringify(value));
        const page = value.structuredContent as Page;
        assert.ok(page.items.length <= (index === 1 ? 37 : 100));
        if (pages === 0) {
          assert.equal(page.hasMore, true);
          assert.equal(page.items.length, index === 1 ? 37 : 100);
        }
        if (page.hasMore) {
          assert.ok(page.nextCursor);
          assert.notEqual(page.nextCursor, page.items.at(-1)!.id);
        } else assert.equal(page.nextCursor, null);
        ids.push(...page.items.map((item) => item.id));
        cursor = page.nextCursor;
        pages++;
      } while (cursor);
      assert.equal(pages, 3);
      assert.deepEqual(ids, index === 1 ? restrictedIds : expected);
      assert.equal(new Set(ids).size, ids.length);
    }
    const foreign = await clients[0]!.callTool({
      name: "list_boards",
      arguments: { limit: 37 },
    });
    assert.equal(foreign.isError, false);
    const first = foreign.structuredContent as Page;
    const denied = await clients[1]!.callTool({
      name: "list_boards",
      arguments: { limit: 37, cursor: first.nextCursor },
    });
    assert.equal(denied.isError, true);
    assert.match(
      JSON.stringify(denied.structuredContent),
      /accessible board list/,
    );
    const anchorId = first.items.at(-1)!.id;
    const [anchor] = await sql`SELECT version FROM boards WHERE id=${anchorId}`;
    await json(
      await request(`/api/boards/${anchorId}`, {
        cookie,
        method: "PATCH",
        body: { version: anchor.version, name: "ZZZ renamed MCP board" },
      }),
    );
    const stale = await clients[0]!.callTool({
      name: "list_boards",
      arguments: { limit: 37, cursor: first.nextCursor },
    });
    assert.equal(stale.isError, true);
    assert.equal(
      (stale.structuredContent as { code: string }).code,
      "board_list_changed",
    );
    const currentExpected = (
      await sql`SELECT id FROM boards ORDER BY lower(name),name,id`
    ).map((item) => item.id);
    const resetIds: string[] = [];
    let resetCursor: string | null = null;
    do {
      const value = await clients[0]!.callTool({
        name: "list_boards",
        arguments: {
          limit: 37,
          ...(resetCursor ? { cursor: resetCursor } : {}),
        },
      });
      assert.equal(value.isError, false, JSON.stringify(value));
      const page = value.structuredContent as Page;
      resetIds.push(...page.items.map((item) => item.id));
      resetCursor = page.nextCursor;
    } while (resetCursor);
    assert.deepEqual(resetIds, currentExpected);
    assert.equal(new Set(resetIds).size, currentExpected.length);
  } finally {
    await Promise.all(clients.map((client) => client.close()));
    process.env.MILL_BASE_URL = previous;
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});

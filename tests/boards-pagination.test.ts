import { after, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

const { cleanupDatabase, request, resetDatabase, setupUser, sql } =
  await import("./support.js");

beforeEach(resetDatabase);
after(cleanupDatabase);

async function json(response: Response, status = 200) {
  assert.equal(response.status, status, await response.clone().text());
  return response.json();
}

type Page = {
  items: {
    id: string;
    position: number;
    archived: boolean;
    deletedAt: string | null;
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

test("board pagination reaches every board and newly created boards beyond the former ceiling", async () => {
  const { cookie, user } = await setupUser();
  await sql`INSERT INTO boards(workspace_id,name,prefix,position) SELECT workspace_id,'Board '||sequence,'B'||sequence,sequence FROM users CROSS JOIN generate_series(1,223) sequence WHERE users.id=${user.id}`;
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
  assert.equal(created.board.position, 223);
  assert.equal(created.board.name, "Created after 223 boards");
  const [columns] =
    await sql`SELECT count(*)::int AS total FROM columns WHERE board_id=${created.board.id}`;
  assert.equal(columns.total, 3);
  const expected = (await sql`SELECT id FROM boards ORDER BY position,id`).map(
    (row) => row.id,
  );
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

test("board cursor ordering preserves tied integer positions and handles inserts on either side", async () => {
  const { cookie, user } = await setupUser();
  await sql`INSERT INTO boards(workspace_id,name,prefix,position) SELECT workspace_id,'Precision '||sequence,'P'||sequence,2147483500+(sequence/4) FROM users CROSS JOIN generate_series(1,211) sequence WHERE users.id=${user.id}`;
  const expected = (await sql`SELECT id FROM boards ORDER BY position,id`).map(
    (row) => row.id,
  );
  const first: Page = await json(
    await request("/api/boards?limit=37", { cookie }),
  );
  assert.deepEqual(
    first.items.map((item) => item.id),
    expected.slice(0, 37),
  );
  assert.equal(first.items[0]!.position, 2147483500);
  assert.deepEqual(
    await traversal("/api/boards?limit=37", { cookie }, first),
    expected,
  );
  const [before] =
    await sql`INSERT INTO boards(workspace_id,name,prefix,position) SELECT workspace_id,'Before cursor','BEFORE',0 FROM users WHERE id=${user.id} RETURNING id`;
  const [after] =
    await sql`INSERT INTO boards(workspace_id,name,prefix,position) SELECT workspace_id,'After cursor','AFTER',2147483647 FROM users WHERE id=${user.id} RETURNING id`;
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

test("board pagination keeps active, archived, deleted and credential scope filters on every page", async () => {
  const { cookie, user } = await setupUser();
  await sql`INSERT INTO boards(workspace_id,name,prefix,position,archived) SELECT workspace_id,'Filtered '||sequence,'F'||sequence,sequence,(sequence BETWEEN 4 AND 6 OR sequence=8) FROM users CROSS JOIN generate_series(1,9) sequence WHERE users.id=${user.id}`;
  const boards = await sql`SELECT id,position FROM boards ORDER BY position,id`;
  const allowedIds = [
    boards[0]!.id,
    boards[2]!.id,
    boards[4]!.id,
    boards[6]!.id,
  ];
  const credential = await json(
    await request("/api/credentials", {
      cookie,
      body: { name: "Filtered reader", scopes: ["read"], boardIds: allowedIds },
    }),
    201,
  );
  await sql`UPDATE boards SET deleted_at=now() WHERE position>=7`;
  const active = await json(await request("/api/boards?limit=1", { cookie }));
  const archived = await json(
    await request("/api/boards?limit=1&archived=true", { cookie }),
  );
  const deleted = await json(
    await request("/api/boards?limit=1&deleted=true", { cookie }),
  );
  const scoped = await json(
    await request("/api/boards?limit=1", { token: credential.token }),
  );
  for (const [query, expected] of [
    ["", boards.slice(0, 3).map((row) => row.id)],
    ["&archived=true", boards.slice(3, 6).map((row) => row.id)],
    ["&deleted=true", boards.slice(6).map((row) => row.id)],
    ["&deleted=true&archived=true", boards.slice(6).map((row) => row.id)],
  ] as const) {
    const path = `/api/boards?limit=1${query}`;
    assert.deepEqual(
      await traversal(
        path,
        { cookie },
        await json(await request(path, { cookie })),
      ),
      expected,
    );
    assert.deepEqual(
      await traversal(
        path,
        { token: credential.token },
        await json(await request(path, { token: credential.token })),
      ),
      expected.filter((boardId) => allowedIds.includes(boardId)),
    );
  }
  for (const path of [
    `/api/boards?archived=true&cursor=${active.nextCursor}`,
    `/api/boards?cursor=${archived.nextCursor}`,
    `/api/boards?cursor=${deleted.nextCursor}`,
    `/api/boards?deleted=true&cursor=${archived.nextCursor}`,
  ])
    assert.equal((await request(path, { cookie })).status, 400);
  assert.equal(
    (
      await request(`/api/boards?cursor=${active.nextCursor}`, {
        token: credential.token,
      })
    ).status,
    400,
  );
  const deletedContinuation = await json(
    await request(
      `/api/boards?deleted=true&archived=true&cursor=${deleted.nextCursor}`,
      { cookie },
    ),
  );
  assert.deepEqual(
    deletedContinuation.items.map((item: { id: string }) => item.id),
    boards.slice(7).map((row) => row.id),
  );
  await sql`UPDATE credentials SET board_ids=ARRAY[]::uuid[] WHERE id=${credential.credential.id}`;
  const empty = await json(
    await request("/api/boards", { token: credential.token }),
  );
  assert.deepEqual(empty, { items: [], hasMore: false, nextCursor: null });
  assert.equal(
    (
      await request(`/api/boards?cursor=${scoped.nextCursor}`, {
        token: credential.token,
      })
    ).status,
    400,
  );
});

test("board page validation rejects malformed, missing and wrong-collection anchors", async () => {
  const { cookie } = await setupUser();
  const credential = await json(
    await request("/api/credentials", {
      cookie,
      body: { name: "Cursor boundary", scopes: ["read"] },
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
    { position: payload.position + 1 },
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

test("board cursors reject moved anchors and other reordered rows before a complete restart", async () => {
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
  await json(
    await request(`/api/boards/${boards[1].id}`, {
      cookie,
      method: "PATCH",
      body: { version: boards[1].version, beforeId: null },
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
    await sql`SELECT position FROM boards WHERE id=${boards[2].id}`;
  const [other] =
    await sql`SELECT version FROM boards WHERE id=${boards[1].id}`;
  await json(
    await request(`/api/boards/${boards[1].id}`, {
      cookie,
      method: "PATCH",
      body: { version: other.version, beforeId: boards[3].id },
    }),
  );
  const [after] =
    await sql`SELECT position FROM boards WHERE id=${boards[2].id}`;
  assert.equal(after.position, before.position);
  const movedOther = await json(
    await request(`/api/boards?limit=2&cursor=${reset.nextCursor}`, { cookie }),
    409,
  );
  assert.equal(movedOther.code, "board_list_changed");
  const final = await json(await request("/api/boards?limit=2", { cookie }));
  assert.deepEqual(await traversal("/api/boards?limit=2", { cookie }, final), [
    boards[0].id,
    boards[2].id,
    boards[1].id,
    boards[3].id,
  ]);
});

test("one board directory includes state metadata after a transition between separate collection reads", async () => {
  const { cookie, user } = await setupUser();
  await sql`INSERT INTO boards(workspace_id,name,prefix,position,archived,deleted_at) SELECT workspace_id,'Directory '||sequence,'DIR'||sequence,sequence,sequence=2,CASE WHEN sequence=3 THEN now() ELSE NULL END FROM users CROSS JOIN generate_series(1,3) sequence WHERE users.id=${user.id}`;
  const boards = await sql`SELECT * FROM boards ORDER BY position,id`;
  const activeBefore = await json(await request("/api/boards", { cookie }));
  assert.deepEqual(
    activeBefore.items.map((item: { id: string }) => item.id),
    [boards[0]!.id],
  );
  const changed = await json(
    await request(`/api/boards/${boards[1]!.id}`, {
      cookie,
      method: "PATCH",
      body: { version: boards[1]!.version, archived: false },
    }),
  );
  const archivedAfter = await json(
    await request("/api/boards?archived=true", { cookie }),
  );
  assert.equal(archivedAfter.items.length, 0);
  assert.ok(
    ![...activeBefore.items, ...archivedAfter.items].some(
      (item) => item.id === changed.board.id,
    ),
  );
  const directory = await json(
    await request("/api/boards?directory=true", { cookie }),
  );
  assert.deepEqual(
    directory.items.map((item: { id: string }) => item.id),
    boards.map((item) => item.id),
  );
  assert.equal(directory.hasMore, false);
  assert.equal(directory.nextCursor, null);
  assert.equal(directory.items[1].archived, false);
  assert.equal(directory.items[1].version, changed.board.version);
  assert.equal(directory.items[2].name, boards[2]!.name);
  assert.ok(directory.items[2].deletedAt);
  const normal = await json(
    await request("/api/boards?directory=false", { cookie }),
  );
  assert.deepEqual(
    normal.items.map((item: { id: string }) => item.id),
    boards.slice(0, 2).map((item) => item.id),
  );
});

test("directory continuation reaches all states and rejects state or metadata changes without order changes", async () => {
  const { cookie, user } = await setupUser();
  await sql`INSERT INTO boards(workspace_id,name,prefix,position,archived,deleted_at) SELECT workspace_id,'Whole directory '||sequence,'WHOLE'||sequence,sequence/4,sequence%2=1,CASE WHEN sequence%3=0 THEN now() ELSE NULL END FROM users CROSS JOIN generate_series(1,213) sequence WHERE users.id=${user.id}`;
  const expected = (await sql`SELECT id FROM boards ORDER BY position,id`).map(
    (item) => item.id,
  );
  const path = "/api/boards?directory=true&limit=100";
  let first = await json(await request(path, { cookie }));
  assert.equal(first.items.length, 100);
  assert.equal(first.hasMore, true);
  assert.deepEqual(await traversal(path, { cookie }, first), expected);
  const [unvisited] = await sql`SELECT * FROM boards WHERE prefix='WHOLE151'`;
  assert.ok(
    !first.items.some((item: { id: string }) => item.id === unvisited.id),
  );
  await json(
    await request(`/api/boards/${unvisited.id}`, {
      cookie,
      method: "PATCH",
      body: { version: unvisited.version, archived: false },
    }),
  );
  let stale = await json(
    await request(`${path}&cursor=${first.nextCursor}`, { cookie }),
    409,
  );
  assert.equal(stale.code, "board_list_changed");
  assert.deepEqual(
    (await sql`SELECT id FROM boards ORDER BY position,id`).map(
      (item) => item.id,
    ),
    expected,
  );
  first = await json(await request(path, { cookie }));
  assert.deepEqual(await traversal(path, { cookie }, first), expected);
  const [deleted] = await sql`SELECT * FROM boards WHERE prefix='WHOLE153'`;
  await json(
    await request(`/api/boards/${deleted.id}/restore`, {
      cookie,
      body: { version: deleted.version },
    }),
  );
  stale = await json(
    await request(`${path}&cursor=${first.nextCursor}`, { cookie }),
    409,
  );
  assert.equal(stale.code, "board_list_changed");
  first = await json(await request(path, { cookie }));
  const [unchangedVersion] =
    await sql`SELECT version FROM boards WHERE id=${unvisited.id}`;
  await sql`UPDATE boards SET archived=true WHERE id=${unvisited.id}`;
  const [stateChanged] =
    await sql`SELECT version FROM boards WHERE id=${unvisited.id}`;
  assert.equal(stateChanged.version, unchangedVersion.version);
  stale = await json(
    await request(`${path}&cursor=${first.nextCursor}`, { cookie }),
    409,
  );
  assert.equal(stale.code, "board_list_changed");
  first = await json(await request(path, { cookie }));
  await json(
    await request(`/api/boards/${unvisited.id}`, {
      cookie,
      method: "PATCH",
      body: { version: stateChanged.version, name: "Renamed directory board" },
    }),
  );
  stale = await json(
    await request(`${path}&cursor=${first.nextCursor}`, { cookie }),
    409,
  );
  assert.equal(stale.code, "board_list_changed");
  const reset = await json(await request(path, { cookie }));
  assert.deepEqual(await traversal(path, { cookie }, reset), expected);
});

test("directory pages preserve actor restrictions and reject cross-mode or ambiguous cursors", async () => {
  const { cookie, user } = await setupUser();
  await sql`INSERT INTO boards(workspace_id,name,prefix,position,archived) SELECT workspace_id,'Scoped directory '||sequence,'SCOPE'||sequence,sequence,sequence%2=0 FROM users CROSS JOIN generate_series(1,8) sequence WHERE users.id=${user.id}`;
  const boards = await sql`SELECT id FROM boards ORDER BY position,id`;
  const allowedIds = [
    boards[0]!.id,
    boards[1]!.id,
    boards[4]!.id,
    boards[7]!.id,
  ];
  const credential = await json(
    await request("/api/credentials", {
      cookie,
      body: {
        name: "Directory reader",
        scopes: ["read"],
        boardIds: allowedIds,
      },
    }),
    201,
  );
  await sql`UPDATE boards SET deleted_at=now() WHERE id=${boards[7]!.id}`;
  const path = "/api/boards?directory=true&limit=1";
  const full = await json(await request(path, { cookie }));
  const scoped = await json(await request(path, { token: credential.token }));
  assert.deepEqual(
    await traversal(path, { token: credential.token }, scoped),
    allowedIds,
  );
  assert.equal(
    (
      await request(`${path}&cursor=${full.nextCursor}`, {
        token: credential.token,
      })
    ).status,
    400,
  );
  assert.equal(
    (await request(`${path}&cursor=${scoped.nextCursor}`, { cookie })).status,
    400,
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
      (await request(`/api/boards?${query}`, { cookie })).status,
      400,
    );
  assert.equal((await request("/api/boards?directory=true")).status, 401);
  await sql`UPDATE credentials SET board_ids=ARRAY[]::uuid[] WHERE id=${credential.credential.id}`;
  const empty = await json(await request(path, { token: credential.token }));
  assert.deepEqual(empty, { items: [], hasMore: false, nextCursor: null });
  assert.equal(
    (
      await request(`${path}&cursor=${scoped.nextCursor}`, {
        token: credential.token,
      })
    ).status,
    400,
  );
});

test("initialized MCP clients traverse more than 100 boards and preserve board restrictions across cursors", async () => {
  const { cookie, user } = await setupUser();
  await sql`INSERT INTO boards(workspace_id,name,prefix,position) SELECT workspace_id,'MCP board '||sequence,'MCP'||sequence,sequence/4 FROM users CROSS JOIN generate_series(1,221) sequence WHERE users.id=${user.id}`;
  const expected = (await sql`SELECT id FROM boards ORDER BY position,id`).map(
    (row) => row.id as string,
  );
  const restrictedIds = expected
    .filter((_id, index) => index % 2 === 0)
    .slice(0, 100);
  const read = await json(
    await request("/api/credentials", {
      cookie,
      body: { name: "MCP read access", scopes: ["read"] },
    }),
    201,
  );
  const restricted = await json(
    await request("/api/credentials", {
      cookie,
      body: {
        name: "MCP selected boards",
        scopes: ["read"],
        boardIds: restrictedIds,
      },
    }),
    201,
  );
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
        body: { version: anchor.version, beforeId: null },
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
      await sql`SELECT id FROM boards ORDER BY position,id`
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

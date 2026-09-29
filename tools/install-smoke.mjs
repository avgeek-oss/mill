import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { createHash, randomBytes } from "node:crypto";
import { URLSearchParams } from "node:url";
import { verifyConfiguredStaticContent } from "./static-smoke.mjs";

const origin = process.env.MILL_VERIFY_URL;
const password = process.env.MILL_VERIFY_PASSWORD;
const stateFile = process.env.MILL_VERIFY_STATE;
assert.ok(
  origin && password && stateFile,
  "Supply disposable verification URL, password, and state path",
);
const target = new URL(origin);
assert.ok(
  ["127.0.0.1", "localhost"].includes(target.hostname) &&
    target.protocol === "http:",
  "Smoke verification only targets loopback HTTP",
);
const cookies = new Map();
async function request(
  path,
  method = "GET",
  data,
  expected = 200,
  jar = cookies,
  extraHeaders = {},
) {
  const response = await fetch(`${origin}${path}`, {
    method,
    headers: {
      Origin: origin,
      "Content-Type": "application/json",
      Cookie: [...jar].map(([name, value]) => `${name}=${value}`).join("; "),
      ...extraHeaders,
    },
    body: data === undefined ? undefined : JSON.stringify(data),
    signal: AbortSignal.timeout(15_000),
    redirect: "error",
  });
  for (const cookie of response.headers.getSetCookie()) {
    const [pair] = cookie.split(";", 1);
    const separator = pair.indexOf("=");
    jar.set(pair.slice(0, separator), pair.slice(separator + 1));
  }
  assert.equal(
    response.status,
    expected,
    `${method} ${path} returned expected HTTP status`,
  );
  return response.status === 204 ? null : response.json();
}
function pass(message) {
  console.log(`PASS ${message}`);
}
async function removedRoute(path, method = "GET", data) {
  const response = await fetch(`${origin}${path}`, {
    method,
    headers: {
      Origin: origin,
      "Content-Type": "application/json",
      Cookie: [...cookies]
        .map(([name, value]) => `${name}=${value}`)
        .join("; "),
    },
    body: data === undefined ? undefined : JSON.stringify(data),
    signal: AbortSignal.timeout(15_000),
    redirect: "error",
  });
  assert.equal(response.status, 404, `${method} ${path} is removed`);
}
function apiRecord(record) {
  return Object.fromEntries(
    Object.entries(record).map(([name, value]) => [
      name.replace(/_([a-z])/g, (_match, letter) => letter.toUpperCase()),
      name.endsWith("_at") && value !== null
        ? new Date(value).toISOString()
        : value,
    ]),
  );
}
function preservedRecord(actual, expected) {
  const fields = apiRecord(expected);
  assert.ok(actual, "Preserved record exists through the real API");
  assert.deepEqual(
    Object.fromEntries(Object.keys(fields).map((name) => [name, actual[name]])),
    fields,
  );
}
async function mcpRequest(
  token,
  transport,
  method,
  params,
  notification = false,
) {
  const id = notification ? undefined : ++transport.id;
  const response = await fetch(`${origin}/mcp`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      ...(transport.protocolVersion
        ? { "MCP-Protocol-Version": transport.protocolVersion }
        : {}),
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      ...(id === undefined ? {} : { id }),
      method,
      ...(params === undefined ? {} : { params }),
    }),
    signal: AbortSignal.timeout(15_000),
    redirect: "error",
  });
  if (notification) {
    assert.equal(response.status, 202, `${method} notification is accepted`);
    assert.equal(await response.text(), "");
    return;
  }
  assert.equal(response.status, 200, `${method} MCP request succeeds`);
  const type = response.headers.get("content-type") ?? "";
  const body = await response.text();
  let message;
  if (type.includes("application/json")) message = JSON.parse(body);
  else {
    assert.match(
      type,
      /text\/event-stream/,
      "MCP transport returns JSON or SSE",
    );
    const events = body
      .split(/\r?\n\r?\n/)
      .map((block) =>
        block
          .split(/\r?\n/)
          .filter((line) => line.startsWith("data:"))
          .map((line) => line.slice(5).trimStart())
          .join("\n"),
      )
      .filter(Boolean)
      .map((data) => JSON.parse(data));
    message = events.find((event) => event.id === id);
  }
  assert.ok(message, "MCP transport returns the request response");
  assert.equal(message.jsonrpc, "2.0");
  assert.equal(message.id, id);
  assert.equal(message.error, undefined, `${method} has no protocol error`);
  assert.ok("result" in message);
  return message.result;
}

const ready = await fetch(`${origin}/health/ready`, {
  signal: AbortSignal.timeout(10_000),
});
assert.equal(ready.status, 200);
const page = await fetch(`${origin}/`, { signal: AbortSignal.timeout(10_000) });
assert.equal(page.status, 200);
assert.match(page.headers.get("content-type") ?? "", /text\/html/);
assert.match(
  page.headers.get("content-security-policy") ?? "",
  /frame-ancestors/,
);
assert.equal(page.headers.get("x-content-type-options"), "nosniff");
assert.ok(page.headers.get("referrer-policy"));
assert.match(await page.text(), /<div\s+id=["']root["']/);
pass("Production web application and readiness endpoint respond");
await verifyConfiguredStaticContent();

let state;
if (process.env.MILL_VERIFY_MODE === "fresh") {
  const status = await request("/api/auth/status");
  assert.equal(status.setupRequired, true);
  await request("/api/boards", "GET", undefined, 401);
  await request(
    "/api/auth/setup",
    "POST",
    {
      workspaceName: "Disposable production verification",
      name: "Install verifier",
      email: "install-verifier@example.invalid",
      password,
    },
    201,
  );
  const me = await request("/api/auth/me");
  assert.equal(me.user.role, "admin");
  assert.equal((await request("/api/auth/status")).setupRequired, false);
  await request(
    "/api/auth/setup",
    "POST",
    {
      workspaceName: "Replay",
      name: "Replay",
      email: "replay@example.invalid",
      password,
    },
    409,
  );
  pass("Fresh setup creates one administrator and closes setup");
  const { board } = await request(
    "/api/boards",
    "POST",
    { name: "Installation evidence", prefix: "INST" },
    201,
  );
  const { task } = await request(
    `/api/boards/${board.id}/tasks`,
    "POST",
    {
      title: "Persist through restart and recovery",
      description: "A **real** task in the production container.",
      priority: "high",
      status: "todo",
      checklist: [
        {
          id: "restore-check",
          text: "Verify restored comment and member",
          done: false,
        },
      ],
    },
    201,
  );
  const { comment } = await request(
    `/api/tasks/${task.id}/comments`,
    "POST",
    { body: "Production backup must retain this comment." },
    201,
  );
  const invitation = await request(
    "/api/auth/invitations",
    "POST",
    { email: "install-member@example.invalid", role: "member" },
    201,
  );
  const invitationToken = invitation.token ?? invitation.invitation?.token;
  assert.equal(
    typeof invitationToken,
    "string",
    "Administrator receives a usable invitation link token",
  );
  const memberCookies = new Map();
  await request(
    "/api/auth/accept-invitation",
    "POST",
    {
      token: invitationToken,
      name: "Install member",
      password,
    },
    201,
    memberCookies,
  );
  const member = await request(
    "/api/auth/me",
    "GET",
    undefined,
    200,
    memberCookies,
  );
  assert.equal(member.user.role, "member");
  state = {
    boardId: board.id,
    taskId: task.id,
    commentId: comment.id,
    memberId: member.user.id,
  };
  await writeFile(stateFile, JSON.stringify(state, null, 2), { mode: 0o600 });
  pass("Production board, task, comment, and accepted membership persist");
} else {
  state = JSON.parse(await readFile(stateFile, "utf8"));
  await request("/api/auth/login", "POST", {
    email: "install-verifier@example.invalid",
    password,
  });
}
const owner = (await request("/api/auth/me")).user;
const legacyAgentState =
  process.env.MILL_VERIFY_AGENT_UPGRADE_STATE ??
  process.env.MILL_VERIFY_AGENT_RESTORE_STATE;
if (legacyAgentState) {
  const legacy = JSON.parse(await readFile(legacyAgentState, "utf8"));
  for (const field of [
    "legacyApiCredentialId",
    "legacyOAuthCredentialId",
    "legacyOAuthRequestId",
  ])
    assert.match(
      legacy[field],
      /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/,
    );
  if (process.env.MILL_VERIFY_AGENT_UPGRADE_STATE)
    assert.equal(
      (await request("/api/agents")).items.length,
      0,
      "The upgrade does not invent Agents",
    );
  for (const token of [
    process.env.MILL_VERIFY_LEGACY_API_TOKEN,
    process.env.MILL_VERIFY_LEGACY_OAUTH_TOKEN,
  ]) {
    assert.ok(
      typeof token === "string" && /^mill_[A-Za-z0-9_-]{43}$/.test(token),
      "Supply disposable legacy bearer tokens through environment variables",
    );
    await request("/api/boards", "GET", undefined, 401, new Map(), {
      Authorization: `Bearer ${token}`,
    });
    const response = await fetch(`${origin}/mcp`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-11-25",
          capabilities: {},
          clientInfo: { name: "legacy-agent-upgrade", version: "1" },
        },
      }),
      signal: AbortSignal.timeout(15000),
    });
    assert.equal(
      response.status,
      401,
      "Legacy unbound credentials cannot initialize MCP",
    );
  }
  const existing = await request("/api/credentials");
  for (const id of [
    legacy.legacyApiCredentialId,
    legacy.legacyOAuthCredentialId,
  ]) {
    const credential = existing.items.find((item) => item.id === id);
    assert.ok(
      credential?.revokedAt,
      "Legacy credential metadata remains as a revoked record",
    );
    assert.equal(credential.agentId, null);
  }
  await request(
    `/api/oauth/consent/${legacy.legacyOAuthRequestId}`,
    "GET",
    undefined,
    400,
  );
  assert.ok(
    typeof legacy.retryKey === "string" &&
      legacy.retryKey.length >= 8 &&
      legacy.retryKey.length <= 128,
    "Supply the existing logical retry key in public fixture metadata",
  );
  async function boardIds() {
    const ids = [];
    let cursor = null;
    do {
      const page = await request(
        `/api/boards?limit=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`,
      );
      ids.push(...page.items.map((board) => board.id));
      cursor = page.nextCursor;
    } while (cursor);
    return ids;
  }
  const before = await boardIds();
  const retry = await fetch(`${origin}/api/boards`, {
    method: "POST",
    headers: {
      Origin: origin,
      "Content-Type": "application/json",
      Cookie: [...cookies]
        .map(([name, value]) => `${name}=${value}`)
        .join("; "),
      "Idempotency-Key": legacy.retryKey,
    },
    body: JSON.stringify({
      name: "Earlier Agent installation",
      prefix: "INST",
    }),
    signal: AbortSignal.timeout(15000),
    redirect: "error",
  });
  assert.equal(retry.status, 410, "The exact legacy retry remains terminal");
  assert.equal(retry.headers.get("Idempotency-Replayed"), "true");
  assert.equal((await retry.json()).code, "retry_invalidated");
  assert.deepEqual(
    await boardIds(),
    before,
    "The invalidated retry creates no board",
  );
  if (process.env.MILL_VERIFY_AGENT_UPGRADE_STATE)
    assert.equal(
      (await request("/api/agents")).items.length,
      0,
      "Rejected legacy credentials and consent cannot create Agents",
    );
  pass("Legacy Agent credentials, consent and cached retries remain terminal");
}
if (!state.agentId) {
  const { agent } = await request(
    "/api/agents",
    "POST",
    { name: "Installation personal Agent", scope: "personal" },
    201,
  );
  const { agent: team } = await request(
    "/api/agents",
    "POST",
    {
      name: "Installation team Agent",
      scope: "team",
      memberIds: [owner.id, state.memberId],
    },
    201,
  );
  const detail = await request(`/api/tasks/${state.taskId}`);
  await request(`/api/tasks/${state.taskId}`, "PATCH", {
    version: detail.task.version,
    assigneeId: owner.id,
    agentId: agent.id,
  });
  state.agentId = agent.id;
  state.teamAgentId = team.id;
  state.ownerId = owner.id;
  await writeFile(stateFile, JSON.stringify(state, null, 2), { mode: 0o600 });
}
const availableAgents = await request("/api/agents");
const personalAgent = availableAgents.items.find(
  (item) => item.id === state.agentId,
);
const teamAgent = availableAgents.items.find(
  (item) => item.id === state.teamAgentId,
);
assert.equal(personalAgent?.scope, "personal");
assert.equal(personalAgent?.creatorId, state.ownerId);
assert.equal(teamAgent?.scope, "team");
assert.deepEqual(
  new Set(teamAgent.memberIds),
  new Set([state.ownerId, state.memberId]),
);
pass("Explicit personal and team Agents with current human grants persist");
const { task, comments } = await request(`/api/tasks/${state.taskId}`);
assert.equal(task.agentId, state.agentId);
assert.equal(task.agentName, personalAgent.name);
assert.equal(task.assigneeId, state.ownerId);
if (state.oauthCredentialId) {
  const listed = await request("/api/credentials");
  const metadata = listed.items.find(
    (item) => item.id === state.oauthCredentialId,
  );
  assert.equal(metadata?.agentId, state.agentId);
  assert.equal(metadata?.agentName, personalAgent.name);
  assert.equal(metadata?.tokenType, "oauth");
  assert.equal(metadata?.oauthClientId, state.oauthClientId);
  assert.equal(metadata?.revokedAt, null);
}
if (state.agentTaskId) {
  const persistedAgentTask = await request(`/api/tasks/${state.agentTaskId}`);
  assert.equal(persistedAgentTask.task.agentId, state.agentId);
  assert.equal(persistedAgentTask.task.assigneeId, state.ownerId);
}
const history = await request(`/api/tasks/${state.taskId}/activity`);
assert.ok(
  history.items.some(
    (item) =>
      item.action === "task.created" &&
      item.actorKind === "human" &&
      item.actorName === "Install verifier",
  ),
  "Persisted task creation history remains readable",
);
await removedRoute("/api/audit");
pass(
  "Task actions history remains readable and workspace Audit is unavailable",
);
const deepLink = await fetch(
  `${origin}/boards/${state.boardId}/tasks/${state.taskId}`,
  { signal: AbortSignal.timeout(10_000) },
);
assert.equal(deepLink.status, 200);
assert.match(deepLink.headers.get("content-type") ?? "", /text\/html/);
assert.match(
  deepLink.headers.get("content-security-policy") ?? "",
  /frame-ancestors/,
);
assert.equal(task.title, "Persist through restart and recovery");
assert.equal(task.boardId, state.boardId);
assert.equal(task.status, "todo");
assert.equal(task.description, "A **real** task in the production container.");
assert.equal(task.priority, "high");
assert.deepEqual(task.checklist, [
  {
    id: "restore-check",
    text: "Verify restored comment and member",
    done: false,
  },
]);
for (const name of ["columnId", "labels", "parentId", "position"])
  assert.equal(name in task, false, `Removed task field ${name} is absent`);
assert.ok(
  comments.some(
    (comment) =>
      comment.id === state.commentId &&
      comment.body === "Production backup must retain this comment.",
  ),
);
const members = await request("/api/auth/members");
assert.ok(
  members.items.some(
    (member) => member.id === state.memberId && member.role === "member",
  ),
);
assert.ok(
  members.items.every(
    (member) => !("passwordHash" in member) && !("totpSecret" in member),
  ),
);
pass(
  "Persisted task descriptions/checklists/comments and credential-free membership are readable",
);
if (
  process.env.MILL_VERIFY_MODE === "fresh" ||
  process.env.MILL_VERIFY_MODE === "agents" ||
  process.env.MILL_VERIFY_AGENT_UPGRADE_STATE ||
  process.env.MILL_VERIFY_AGENT_RESTORE_STATE ||
  process.env.MILL_VERIFY_UPGRADE_STATE
) {
  for (const [path, method, data] of [
    [`/api/boards/${state.boardId}/columns`, "GET"],
    [
      `/api/boards/${state.boardId}/columns`,
      "POST",
      { name: "Removed status" },
    ],
    [
      `/api/columns/${state.taskId}`,
      "PATCH",
      { name: "Removed status", version: 1 },
    ],
    [`/api/columns/${state.taskId}`, "DELETE", {}],
    [`/api/tasks/${state.taskId}/subtasks`, "GET"],
    ["/api/export", "GET"],
    ["/api/import", "POST", { format: "mill-portable", version: 1 }],
  ])
    await removedRoute(path, method, data);
  for (const [field, value] of [
    ["columnId", state.taskId],
    ["labels", ["removed"]],
    ["parentId", state.taskId],
    ["position", 0],
  ]) {
    await request(
      `/api/boards/${state.boardId}/tasks`,
      "POST",
      { title: "Rejected obsolete field", [field]: value },
      400,
    );
    await request(
      `/api/tasks/${state.taskId}`,
      "PATCH",
      { version: task.version, [field]: value },
      400,
    );
  }
  await request(
    "/api/boards",
    "POST",
    { name: "Rejected ranking", prefix: "REJUP", position: 0 },
    400,
  );
  await request(
    `/api/boards/${state.boardId}/tasks`,
    "POST",
    { title: "Rejected status", status: "custom" },
    400,
  );
  await request(
    `/api/tasks/${state.taskId}?subtaskLimit=1`,
    "GET",
    undefined,
    400,
  );
  for (const query of [
    `columnId=${state.taskId}`,
    "label=removed",
    `parentId=${state.taskId}`,
    "sort=position",
  ])
    await request(
      `/api/boards/${state.boardId}/tasks?${query}`,
      "GET",
      undefined,
      400,
    );
  await request(
    "/api/auth/profile",
    "PATCH",
    {
      notificationPreferences: {
        assignments: true,
        mentions: true,
        email: true,
      },
    },
    400,
  );
  const me = await request("/api/auth/me");
  assert.deepEqual(Object.keys(me.user.notificationPreferences).sort(), [
    "assignments",
    "mentions",
  ]);
  const external = await request(
    "/api/credentials",
    "POST",
    {
      name: "Disposable production capability check",
      agentId: state.agentId,
      scopes: ["read", "write"],
      boardIds: [state.boardId],
      expiresInDays: 1,
    },
    201,
  );
  const transport = { id: 0, protocolVersion: undefined };
  try {
    if (!state.oauthCredentialId) {
      const agentsBefore = (await request("/api/agents")).items.map(
        (item) => item.id,
      );
      const redirect = `${origin}/installation-oauth-callback`;
      const resource = `${origin}/mcp`;
      const verifier = randomBytes(32).toString("base64url");
      const oauthState = randomBytes(16).toString("base64url");
      const client = await request(
        "/oauth/register",
        "POST",
        {
          client_name: "Installation OAuth Agent",
          redirect_uris: [redirect],
          token_endpoint_auth_method: "none",
        },
        201,
      );
      const authorization = await fetch(
        `${origin}/oauth/authorize?${new URLSearchParams({ client_id: client.client_id, redirect_uri: redirect, resource, response_type: "code", scope: "read", state: oauthState, code_challenge_method: "S256", code_challenge: createHash("sha256").update(verifier).digest("base64url") })}`,
        { redirect: "manual", signal: AbortSignal.timeout(15000) },
      );
      assert.equal(authorization.status, 302);
      const requestId = new URL(
        authorization.headers.get("location"),
      ).searchParams.get("request");
      assert.ok(requestId);
      const details = await request(`/api/oauth/consent/${requestId}`);
      assert.equal(details.requiresAgent, true);
      assert.ok(details.agents.some((agent) => agent.id === state.agentId));
      await request(
        `/api/oauth/consent/${requestId}`,
        "POST",
        { allow: true },
        403,
      );
      const decision = await request(
        `/api/oauth/consent/${requestId}`,
        "POST",
        {
          allow: true,
          agentId: state.agentId,
          boardIds: [state.boardId],
        },
      );
      const callback = new URL(decision.redirectTo);
      assert.equal(callback.searchParams.get("state"), oauthState);
      assert.equal(callback.searchParams.get("iss"), origin);
      const response = await fetch(`${origin}/oauth/token`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          client_id: client.client_id,
          redirect_uri: redirect,
          resource,
          grant_type: "authorization_code",
          code: callback.searchParams.get("code"),
          code_verifier: verifier,
        }),
        signal: AbortSignal.timeout(15000),
      });
      assert.equal(
        response.status,
        200,
        "Selected-Agent PKCE exchange succeeds",
      );
      const issued = await response.json();
      assert.ok(
        /^mill_[A-Za-z0-9_-]{43}$/.test(issued.access_token),
        "OAuth returns a bearer credential",
      );
      const oauthTransport = { id: 0, protocolVersion: undefined };
      const initialization = await mcpRequest(
        issued.access_token,
        oauthTransport,
        "initialize",
        {
          protocolVersion: "2025-11-25",
          capabilities: {},
          clientInfo: { name: "mill-install-oauth", version: "1" },
        },
      );
      oauthTransport.protocolVersion = initialization.protocolVersion;
      await mcpRequest(
        issued.access_token,
        oauthTransport,
        "notifications/initialized",
        undefined,
        true,
      );
      const oauthRead = await mcpRequest(
        issued.access_token,
        oauthTransport,
        "tools/call",
        { name: "get_task", arguments: { taskId: state.taskId } },
      );
      assert.equal(oauthRead.isError, false);
      assert.equal(oauthRead.structuredContent.task.agentId, state.agentId);
      const metadata = (await request("/api/credentials")).items.find(
        (item) => item.oauthClientId === client.client_id,
      );
      assert.equal(metadata?.agentId, state.agentId);
      assert.equal(metadata?.agentName, personalAgent.name);
      assert.equal(metadata?.tokenType, "oauth");
      assert.deepEqual(
        (await request("/api/agents")).items.map((item) => item.id),
        agentsBefore,
        "OAuth never creates an Agent",
      );
      state.oauthCredentialId = metadata.id;
      state.oauthClientId = client.client_id;
      await writeFile(stateFile, JSON.stringify(state, null, 2), {
        mode: 0o600,
      });
      pass(
        "Actual selected-Agent OAuth consent, PKCE exchange and MCP retain bound metadata for backup",
      );
    }
    const initialized = await mcpRequest(
      external.token,
      transport,
      "initialize",
      {
        protocolVersion: "2025-11-25",
        capabilities: {},
        clientInfo: { name: "mill-production-verification", version: "1.0.0" },
      },
    );
    assert.ok(
      ["2024-11-05", "2025-03-26", "2025-06-18", "2025-11-25"].includes(
        initialized.protocolVersion,
      ),
      "Server negotiates a supported MCP protocol",
    );
    assert.ok(initialized.capabilities.tools);
    transport.protocolVersion = initialized.protocolVersion;
    await mcpRequest(
      external.token,
      transport,
      "notifications/initialized",
      undefined,
      true,
    );
    const { tools } = await mcpRequest(
      external.token,
      transport,
      "tools/list",
      {},
    );
    assert.ok(tools.some((item) => item.name === "update_task"));
    assert.ok(tools.some((item) => item.name === "list_agents"));
    assert.ok(
      !tools.some((item) => item.name === "create_board"),
      "Board-restricted MCP cannot create workspace boards",
    );
    for (const name of [
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
    ])
      assert.ok(
        !tools.some((item) => item.name === name),
        `Removed MCP capability ${name} is absent`,
      );
    for (const name of ["create_task", "update_task"]) {
      const tool = tools.find((item) => item.name === name);
      assert.ok(tool);
      assert.ok("agentId" in tool.inputSchema.properties);
      assert.deepEqual(tool.inputSchema.properties.status.enum, [
        "backlog",
        "todo",
        "in_progress",
        "in_review",
        "done",
        "wont_do",
      ]);
      for (const field of [
        "columnId",
        "labels",
        "parentId",
        "position",
        "beforeId",
      ])
        assert.equal(field in tool.inputSchema.properties, false);
    }
    const read = await mcpRequest(external.token, transport, "tools/call", {
      name: "get_task",
      arguments: { taskId: state.taskId },
    });
    assert.ok(!read.isError);
    assert.equal(read.structuredContent.task.status, "todo");
    assert.equal(read.structuredContent.task.agentId, state.agentId);
    if (!state.agentTaskId) {
      const createdAgentTask = await mcpRequest(
        external.token,
        transport,
        "tools/call",
        {
          name: "create_task",
          arguments: {
            boardId: state.boardId,
            title: "Persist explicit MCP Agent assignment",
            assigneeId: state.ownerId,
            agentId: state.agentId,
            idempotencyKey: "install-explicit-agent-task",
          },
        },
      );
      assert.equal(createdAgentTask.isError, false);
      assert.equal(
        createdAgentTask.structuredContent.task.agentId,
        state.agentId,
      );
      assert.equal(
        createdAgentTask.structuredContent.task.assigneeId,
        state.ownerId,
      );
      state.agentTaskId = createdAgentTask.structuredContent.task.id;
      await writeFile(stateFile, JSON.stringify(state, null, 2), {
        mode: 0o600,
      });
    }
    const rejected = await mcpRequest(external.token, transport, "tools/call", {
      name: "create_task",
      arguments: {
        boardId: state.boardId,
        title: "Rejected obsolete MCP field",
        columnId: state.taskId,
      },
    });
    assert.equal(rejected.isError, true);
    assert.equal(
      (
        await mcpRequest(external.token, transport, "tools/call", {
          name: "create_column",
          arguments: { boardId: state.boardId, name: "Removed" },
        })
      ).isError,
      true,
    );
    if (process.env.MILL_VERIFY_UPGRADE_STATE) {
      const upgrade = JSON.parse(
        await readFile(process.env.MILL_VERIFY_UPGRADE_STATE, "utf8"),
      );
      const outside = await fetch(
        `${origin}/api/boards/${upgrade.archivedBoardId}`,
        {
          headers: { Authorization: `Bearer ${external.token}` },
          signal: AbortSignal.timeout(15_000),
          redirect: "error",
        },
      );
      assert.equal(
        outside.status,
        403,
        "Scoped production credential cannot read another migrated board",
      );
    }
  } finally {
    await request(`/api/credentials/${external.credential.id}`, "DELETE");
  }
  pass(
    "Removed structure, ranking, import/export and email preferences are rejected; real scoped MCP advertises fixed statuses and rejects obsolete capabilities",
  );
}
if (process.env.MILL_VERIFY_UPGRADE_STATE) {
  const upgrade = JSON.parse(
    await readFile(process.env.MILL_VERIFY_UPGRADE_STATE, "utf8"),
  );
  for (const name of [
    "archivedBoardId",
    "deletedBoardId",
    "archivedColumnId",
    "deletedColumnId",
    "archivedTaskId",
    "deletedParentId",
    "deletedChildId",
    "deletedBoardTaskId",
  ])
    assert.match(
      upgrade[name],
      /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/,
    );
  const archivedBoard = await request(`/api/boards/${upgrade.archivedBoardId}`);
  assert.equal(archivedBoard.board.name, "Legacy archived board");
  assert.equal("position" in archivedBoard.board, false);
  const archived = await request(`/api/tasks/${upgrade.archivedTaskId}`);
  assert.equal(archived.task.title, "Legacy archived task");
  assert.ok(
    archived.comments.some(
      (comment) => comment.body === "Legacy migration content",
    ),
  );
  if (upgrade.taskHistory) {
    assert.equal(upgrade.taskHistory.length, 3);
    const migratedHistory = await request(
      `/api/tasks/${upgrade.archivedTaskId}/activity?limit=100`,
    );
    for (const event of upgrade.taskHistory) {
      assert.equal(event.task_id, upgrade.archivedTaskId);
      assert.equal(event.board_id, upgrade.archivedBoardId);
      assert.deepEqual(
        migratedHistory.items.find((item) => item.id === event.id),
        {
          id: event.id,
          taskId: event.task_id,
          boardId: event.board_id,
          actorId: event.actor_id,
          actorName: event.actor_name,
          actorKind: event.actor_kind,
          action: event.action,
          detail: event.detail,
          createdAt: new Date(event.created_at).toISOString(),
        },
        "Task history preserves actor attribution, action, details and time",
      );
    }
    assert.ok(
      migratedHistory.items.some(
        (item) =>
          item.actorKind === "agent" &&
          item.actorName === "Upgrade history agent",
      ),
    );
    pass(
      "Migrated human and agent task actions retain complete history through the API",
    );
  }
  const deletedIds = [
    upgrade.deletedParentId,
    upgrade.deletedChildId,
    upgrade.deletedBoardTaskId,
  ];
  for (const id of deletedIds) {
    await request(`/api/tasks/${id}`, "GET", undefined, 404);
    await request(`/api/tasks/${id}/comments`, "GET", undefined, 404);
  }
  await request(`/api/boards/${upgrade.deletedBoardId}`, "GET", undefined, 404);
  assert.match(upgrade.legacyRetry.key, /^[A-Za-z0-9._:-]{8,128}$/);
  assert.deepEqual(upgrade.legacyRetry.body, {
    name: "Legacy deleted board",
    prefix: "DELUP",
  });
  const retry = await request(
    "/api/boards",
    "POST",
    upgrade.legacyRetry.body,
    410,
    cookies,
    { "Idempotency-Key": upgrade.legacyRetry.key },
  );
  assert.equal(retry.code, "retry_invalidated");
  const afterRetry = await request("/api/boards?limit=100");
  assert.ok(!afterRetry.items.some((board) => board.prefix === "DELUP"));
  pass(
    "Migrated archived work remains usable; deleted work stays absent and its stale create retry returns terminal 410 without recreation",
  );
  if (upgrade.simplification) {
    const simplified = upgrade.simplification;
    assert.equal(simplified.tasks.length, 7);
    const foundStatuses = new Set();
    for (const expected of simplified.tasks) {
      const details = await request(
        `/api/tasks/${expected.id}?commentLimit=100&activityLimit=100`,
      );
      preservedRecord(details.task, expected);
      for (const field of ["columnId", "labels", "parentId", "position"])
        assert.equal(field in details.task, false);
      foundStatuses.add(details.task.status);
      for (const comment of simplified.comments.filter(
        (item) => item.task_id === expected.id,
      ))
        preservedRecord(
          details.comments.find((item) => item.id === comment.id),
          comment,
        );
      for (const event of simplified.activity.filter(
        (item) => item.task_id === expected.id,
      ))
        preservedRecord(
          details.activity.find((item) => item.id === event.id),
          event,
        );
    }
    assert.deepEqual(
      [...foundStatuses].sort(),
      ["backlog", "todo", "in_progress", "in_review", "done", "wont_do"].sort(),
    );
    const listed = await request(
      `/api/boards/${simplified.boardId}/tasks?limit=100`,
    );
    assert.ok(
      listed.items.some((item) => item.id === simplified.formerChildId),
      "Former subtask is independently listed",
    );
    assert.equal(listed.items.length, 7);
    const obsoleteRetry = await request(
      simplified.retry.path,
      "POST",
      simplified.retry.body,
      410,
      cookies,
      { "Idempotency-Key": simplified.retry.key },
    );
    assert.equal(obsoleteRetry.code, "retry_invalidated");
    assert.equal(
      (await request(`/api/boards/${simplified.boardId}/tasks?limit=100`)).items
        .length,
      7,
    );
    pass(
      "All six statuses, independent former subtasks and exact descriptions/checklists/comments/history survive; legacy task retries return terminal410",
    );
  }
}

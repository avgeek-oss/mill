import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { createHash, randomBytes } from "node:crypto";
import { URLSearchParams } from "node:url";
import { verifyConfiguredStaticContent } from "./static-smoke.mjs";

const origin = process.env.MILL_VERIFY_URL;
const webOrigin = process.env.MILL_VERIFY_WEB_URL;
const password = process.env.MILL_VERIFY_PASSWORD;
const stateFile = process.env.MILL_VERIFY_STATE;
assert.ok(
  origin && webOrigin && password && stateFile,
  "Supply disposable verification URL, password, and state path",
);
const target = new URL(origin);
assert.ok(
  ["127.0.0.1", "localhost"].includes(target.hostname) &&
    ["http:", "https:"].includes(target.protocol),
  "Smoke verification only targets loopback origins",
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
      Origin: webOrigin,
      "Content-Type": "application/json",
      Cookie: [...jar].map(([name, value]) => `${name}=${value}`).join("; "),
      ...extraHeaders,
    },
    body: data === undefined ? undefined : JSON.stringify(data),
    signal: AbortSignal.timeout(15_000),
    redirect: "error",
  });
  for (const cookie of response.headers.getSetCookie()) {
    if (cookie.startsWith("mill_session=")) {
      assert.match(cookie, /(?:^|;)\s*HttpOnly(?:;|$)/i);
      assert.match(cookie, /(?:^|;)\s*SameSite=Lax(?:;|$)/i);
      assert.doesNotMatch(cookie, /(?:^|;)\s*Domain=/i);
    }
    if (target.protocol === "https:" && cookie.startsWith("mill_session="))
      assert.match(
        cookie,
        /(?:^|;)\s*Secure(?:;|$)/i,
        "HTTPS sessions require Secure cookies",
      );
    const [pair] = cookie.split(";", 1);
    const separator = pair.indexOf("=");
    jar.set(pair.slice(0, separator), pair.slice(separator + 1));
  }
  assert.equal(
    response.status,
    expected,
    `${method} ${path} returned expected HTTP status`,
  );
  if (response.status === 204) return null;
  const result = await response.json();
  if (path.startsWith("/api/") && response.status >= 400) {
    const requestId = response.headers.get("x-request-id");
    assert.match(requestId, /^[A-Za-z0-9._:-]{1,100}$/);
    if (path.startsWith("/api/oauth/") && "error_description" in result) {
      assert.match(result.error, /^[a-z_]+$/);
      assert.equal(typeof result.error_description, "string");
      assert.ok(result.error_description.length > 0);
    } else {
      assert.equal(typeof result.error?.code, "string");
      assert.equal(typeof result.error?.message, "string");
      assert.equal(result.error?.requestId, requestId);
    }
  }
  return result;
}
function pass(message) {
  console.log(`PASS ${message}`);
}
async function removedRoute(path, method = "GET", data) {
  const response = await fetch(`${origin}${path}`, {
    method,
    headers: {
      Origin: webOrigin,
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
async function mcpRequest(
  token,
  transport,
  method,
  params,
  notification = false,
  expectedStatus = 200,
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
  assert.equal(
    response.status,
    expectedStatus,
    `${method} MCP request succeeds`,
  );
  if (expectedStatus !== 200) {
    await response.arrayBuffer();
    return;
  }
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
const page = await fetch(`${webOrigin}/`, {
  signal: AbortSignal.timeout(10_000),
});
assert.equal(page.status, 200);
assert.match(page.headers.get("content-type") ?? "", /text\/html/);
assert.match(
  page.headers.get("content-security-policy") ?? "",
  /frame-ancestors/,
);
assert.equal(page.headers.get("x-content-type-options"), "nosniff");
assert.ok(page.headers.get("referrer-policy"));
assert.match(await page.text(), /<div\s+id=["']root["']/);
const runtimeConfig = await fetch(`${webOrigin}/runtime-config.js`);
assert.equal(runtimeConfig.status, 200);
assert.equal(runtimeConfig.headers.get("cache-control"), "no-store");
assert.ok((await runtimeConfig.text()).includes(JSON.stringify(origin)));
assert.equal((await fetch(`${webOrigin}/api/auth/status`)).status, 404);
pass("Independent UI and API origins respond without a UI API proxy");
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
  const preflight = await fetch(`${origin}/api/auth/me`, {
    method: "OPTIONS",
    headers: {
      Origin: webOrigin,
      "Access-Control-Request-Method": "GET",
      "Access-Control-Request-Headers": "content-type",
    },
  });
  assert.equal(preflight.headers.get("access-control-allow-origin"), webOrigin);
  assert.equal(
    preflight.headers.get("access-control-allow-credentials"),
    "true",
  );
  const browserRead = await fetch(`${origin}/api/auth/me`, {
    headers: {
      Origin: webOrigin,
      Cookie: [...cookies]
        .map(([name, value]) => `${name}=${value}`)
        .join("; "),
    },
  });
  assert.equal(browserRead.status, 200);
  assert.equal(
    browserRead.headers.get("access-control-allow-origin"),
    webOrigin,
  );
  assert.equal(
    browserRead.headers.get("access-control-allow-credentials"),
    "true",
  );
  const hostileOrigin = "https://untrusted.example";
  const denied = await fetch(`${origin}/api/auth/logout`, {
    method: "POST",
    headers: {
      Origin: hostileOrigin,
      Cookie: [...cookies]
        .map(([name, value]) => `${name}=${value}`)
        .join("; "),
      "Content-Type": "application/json",
    },
    body: "{}",
  });
  assert.equal(denied.status, 403);
  assert.notEqual(
    denied.headers.get("access-control-allow-origin"),
    hostileOrigin,
  );
  assert.equal((await request("/api/auth/me")).user.id, me.user.id);
  pass(
    "Credentialed browser CORS and CSRF permit only the configured UI origin",
  );
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
async function saveState() {
  await writeFile(stateFile, JSON.stringify(state, null, 2), { mode: 0o600 });
}
state.ownerId ??= owner.id;
const currentTask = (await request(`/api/tasks/${state.taskId}`)).task;
if (currentTask.assigneeId !== owner.id)
  await request(`/api/tasks/${state.taskId}`, "PATCH", {
    version: currentTask.version,
    assigneeId: owner.id,
  });
if (!state.futureBoardId) {
  const { board } = await request(
    "/api/boards",
    "POST",
    { name: "Future board", prefix: "FUTURE" },
    201,
    cookies,
    { "Idempotency-Key": "install-future-board" },
  );
  state.futureBoardId = board.id;
  await saveState();
}
const futureCookies = new Map();
if (!state.futureMemberId) {
  const invitation = await request(
    "/api/auth/invitations",
    "POST",
    { email: "install-future-member@example.invalid", role: "member" },
    201,
  );
  const accepted = await request(
    "/api/auth/accept-invitation",
    "POST",
    {
      token: invitation.token ?? invitation.invitation?.token,
      name: "Install future member",
      password,
    },
    201,
    futureCookies,
  );
  state.futureMemberId = accepted.user.id;
  await saveState();
} else {
  await request(
    "/api/auth/login",
    "POST",
    { email: "install-future-member@example.invalid", password },
    200,
    futureCookies,
  );
}
if (!state.futureTaskId) {
  const { task } = await request(
    `/api/boards/${state.futureBoardId}/tasks`,
    "POST",
    {
      title: "Persist future member assignment",
      assigneeId: state.futureMemberId,
    },
    201,
    futureCookies,
    { "Idempotency-Key": "install-future-member-task" },
  );
  state.futureTaskId = task.id;
  await saveState();
}
const futureTask = await request(`/api/tasks/${state.futureTaskId}`);
assert.equal(futureTask.task.boardId, state.futureBoardId);
assert.equal(futureTask.task.assigneeId, state.futureMemberId);
assert.ok(
  (await request("/api/auth/members")).items.some(
    (member) => member.id === state.futureMemberId && member.role === "member",
  ),
);
pass("Future boards and members retain human task assignments");
const statuses = [
  "backlog",
  "todo",
  "in_progress",
  "in_review",
  "done",
  "wont_do",
];
state.statusTaskIds ??= {};
for (const status of statuses) {
  if (!state.statusTaskIds[status]) {
    const { task } = await request(
      `/api/boards/${state.boardId}/tasks`,
      "POST",
      { title: `Persist ${status} task`, status },
      201,
      cookies,
      { "Idempotency-Key": `install-status-${status}` },
    );
    state.statusTaskIds[status] = task.id;
    await saveState();
  }
  const { task } = await request(`/api/tasks/${state.statusTaskIds[status]}`);
  assert.equal(task.status, status);
  const filtered = await request(
    `/api/boards/${state.boardId}/tasks?status=${status}&limit=100`,
  );
  assert.ok(filtered.items.some((item) => item.id === task.id));
  assert.ok(filtered.items.every((item) => item.status === status));
}
pass(
  "All six fixed statuses persist and explicit status filters remain accurate",
);
if (!state.deletedBoardId) {
  const { board } = await request(
    "/api/boards",
    "POST",
    { name: "Disposable deletion evidence", prefix: "DELSMOKE" },
    201,
    cookies,
    { "Idempotency-Key": "install-deleted-board" },
  );
  const { task } = await request(
    `/api/boards/${board.id}/tasks`,
    "POST",
    { title: "Deleted board task" },
    201,
  );
  const { comment } = await request(
    `/api/tasks/${task.id}/comments`,
    "POST",
    { body: "Deleted with its board." },
    201,
  );
  await request(`/api/boards/${board.id}`, "DELETE", {
    version: board.version,
  });
  state.deletedBoardId = board.id;
  state.deletedTaskId = task.id;
  state.deletedCommentId = comment.id;
  await saveState();
}
for (const path of [
  `/api/boards/${state.deletedBoardId}`,
  `/api/tasks/${state.deletedTaskId}`,
  `/api/tasks/${state.deletedTaskId}/comments`,
])
  await request(path, "GET", undefined, 404);
const deletedRetry = await request(
  "/api/boards",
  "POST",
  { name: "Disposable deletion evidence", prefix: "DELSMOKE" },
  410,
  cookies,
  { "Idempotency-Key": "install-deleted-board" },
);
assert.equal(deletedRetry.error.code, "retry_invalidated");
assert.ok(
  !(await request("/api/boards?limit=100")).items.some(
    (board) => board.id === state.deletedBoardId,
  ),
);
pass(
  "Board deletion removes task/comment work and its create retry remains terminal",
);
const { task, comments } = await request(`/api/tasks/${state.taskId}`);
assert.equal(task.assigneeId, state.ownerId);
if (state.oauthCredentialId) {
  const listed = await request("/api/credentials");
  const metadata = listed.items.find(
    (item) => item.id === state.oauthCredentialId,
  );
  assert.equal(metadata?.tokenType, "oauth");
  assert.equal(metadata?.oauthClientId, state.oauthClientId);
  assert.equal(metadata?.revokedAt, null);
  assert.deepEqual(metadata?.boardIds, [state.boardId]);
  assert.equal("agentId" in metadata, false);
  assert.equal("agentName" in metadata, false);
}
if (
  process.env.MILL_VERIFY_MODE !== "fresh" &&
  state.oauthCredentialId &&
  process.env.MILL_VERIFY_OAUTH_TOKEN_FILE
) {
  const retainedToken = await readFile(
    process.env.MILL_VERIFY_OAUTH_TOKEN_FILE,
    "utf8",
  );
  const retainedTransport = { id: 0, protocolVersion: undefined };
  const retainedInit = await mcpRequest(
    retainedToken,
    retainedTransport,
    "initialize",
    {
      protocolVersion: "2025-11-25",
      capabilities: {},
      clientInfo: { name: "mill-restored-client", version: "1.0.0" },
    },
  );
  retainedTransport.protocolVersion = retainedInit.protocolVersion;
  await mcpRequest(
    retainedToken,
    retainedTransport,
    "notifications/initialized",
    undefined,
    true,
  );
  const retainedRead = await mcpRequest(
    retainedToken,
    retainedTransport,
    "tools/call",
    {
      name: "get_task",
      arguments: { taskId: state.taskId },
    },
  );
  assert.equal(retainedRead.isError, false);
  assert.equal(retainedRead.structuredContent.task.id, state.taskId);
  const retainedOutside = await mcpRequest(
    retainedToken,
    retainedTransport,
    "tools/call",
    {
      name: "get_board",
      arguments: { boardId: state.futureBoardId },
    },
  );
  assert.equal(retainedOutside.isError, true);
  pass(
    "The existing OAuth token survives restart or backup restore at its original resource origin and retains its board restriction",
  );
}
if (state.mcpTaskId) {
  const persisted = await request(`/api/tasks/${state.mcpTaskId}`);
  assert.equal(persisted.task.assigneeId, state.ownerId);
  const events = await request(`/api/tasks/${state.mcpTaskId}/activity`);
  assert.ok(events.items.some((event) => event.actorKind === "oauth"));
}
if (state.mcpUnassignedTaskId) {
  const persisted = await request(`/api/tasks/${state.mcpUnassignedTaskId}`);
  assert.equal(persisted.task.assigneeId, null);
}
for (const name of [
  "agentId",
  "agentName",
  "columnId",
  "labels",
  "parentId",
  "position",
  "checklist",
])
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
  "Persisted task descriptions/comments and credential-free membership are readable",
);
if (process.env.MILL_VERIFY_MODE === "fresh") {
  for (const [path, method, data] of [
    ["/api/agents", "GET"],
    ["/api/agents", "POST", { name: "Removed" }],
    [`/api/agents/${state.taskId}`, "PATCH", { version: 1, name: "Removed" }],
    [`/api/agents/${state.taskId}`, "DELETE", { version: 1 }],
    [
      `/api/comments/${state.commentId}`,
      "PATCH",
      { body: "Removed comment edit" },
    ],
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
    ["agentId", state.ownerId],
    ["columnId", state.taskId],
    ["labels", ["removed"]],
    ["parentId", state.taskId],
    ["position", 0],
    ["checklist", [{ id: "removed", text: "Removed", done: false }]],
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
    `agentId=${state.ownerId}`,
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
  await request(
    "/api/credentials",
    "POST",
    { name: "Incomplete production key", expiresInDays: 30 },
    400,
  );
  const external = await request(
    "/api/credentials",
    "POST",
    {
      name: "Disposable production capability check",
      access: "edit",
      includeAdmin: false,
      expiresAt: new Date(Date.now() + 30 * 86400_000).toISOString(),
    },
    201,
  );
  assert.equal("agentId" in external.credential, false);
  assert.equal("agentName" in external.credential, false);
  assert.equal(external.credential.boardIds, null);
  assert.deepEqual(external.credential.scopes, []);
  const keyTransport = { id: 0, protocolVersion: undefined };
  const keyInitialized = await mcpRequest(
    external.token,
    keyTransport,
    "initialize",
    {
      protocolVersion: "2025-11-25",
      capabilities: {},
      clientInfo: {
        name: "mill-production-key-verification",
        version: "1.0.0",
      },
    },
  );
  assert.ok(keyInitialized.capabilities.tools);
  keyTransport.protocolVersion = keyInitialized.protocolVersion;
  await mcpRequest(
    external.token,
    keyTransport,
    "notifications/initialized",
    undefined,
    true,
  );
  const keyTools = await mcpRequest(
    external.token,
    keyTransport,
    "tools/list",
    {},
  );
  assert.ok(keyTools.tools.some((tool) => tool.name === "update_task"));
  assert.ok(!keyTools.tools.some((tool) => tool.name === "list_members"));
  await request(
    `/api/tasks/${state.taskId}`,
    "GET",
    undefined,
    200,
    new Map(),
    { Authorization: `Bearer ${external.token}` },
  );
  if (!state.restKeyTaskId) {
    const created = await request(
      `/api/boards/${state.boardId}/tasks`,
      "POST",
      { title: "Persist personal REST key task" },
      201,
      new Map(),
      { Authorization: `Bearer ${external.token}` },
    );
    const events = await request(
      `/api/tasks/${created.task.id}/activity`,
      "GET",
      undefined,
      200,
      new Map(),
      { Authorization: `Bearer ${external.token}` },
    );
    assert.ok(
      events.items.some(
        (event) =>
          event.actorKind === "human" && event.actorName === owner.name,
      ),
    );
    state.restKeyTaskId = created.task.id;
    await writeFile(stateFile, JSON.stringify(state, null, 2), { mode: 0o600 });
  }
  let mcpToken;
  let oauthCredentialId;
  const transport = { id: 0, protocolVersion: undefined };
  try {
    {
      const redirect = `${origin}/installation-oauth-callback`;
      const resource = `${origin}/mcp`;
      const verifier = randomBytes(32).toString("base64url");
      const oauthState = randomBytes(16).toString("base64url");
      const client = await request(
        "/oauth/register",
        "POST",
        {
          client_name: "Installation OAuth client",
          redirect_uris: [redirect],
          token_endpoint_auth_method: "none",
        },
        201,
      );
      const authorization = await fetch(
        `${origin}/oauth/authorize?${new URLSearchParams({ client_id: client.client_id, redirect_uri: redirect, resource, response_type: "code", scope: "read write", state: oauthState, code_challenge_method: "S256", code_challenge: createHash("sha256").update(verifier).digest("base64url") })}`,
        { redirect: "manual", signal: AbortSignal.timeout(15000) },
      );
      assert.equal(authorization.status, 302);
      assert.equal(
        new URL(authorization.headers.get("location")).origin,
        webOrigin,
      );
      const requestId = new URL(
        authorization.headers.get("location"),
      ).searchParams.get("request");
      assert.ok(requestId);
      const details = await request(`/api/oauth/consent/${requestId}`);
      assert.equal("requiresAgent" in details, false);
      assert.equal("agents" in details, false);
      assert.equal(details.clientName, "Installation OAuth client");
      assert.equal(details.scope, "read write");
      assert.equal(details.canApprove, true);
      assert.ok(
        (await request("/api/boards?limit=100")).items.some(
          (board) => board.id === state.boardId,
        ),
      );
      await request(
        `/api/oauth/consent/${requestId}`,
        "POST",
        {
          allow: true,
          agentId: state.ownerId,
        },
        400,
      );
      const decision = await request(
        `/api/oauth/consent/${requestId}`,
        "POST",
        {
          allow: true,
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
        "Human-authorized PKCE exchange succeeds",
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
      assert.equal("agentId" in oauthRead.structuredContent.task, false);
      const metadata = (await request("/api/credentials")).items.find(
        (item) => item.oauthClientId === client.client_id,
      );
      assert.equal(metadata?.tokenType, "oauth");
      assert.deepEqual(metadata?.boardIds, [state.boardId]);
      assert.deepEqual(metadata?.scopes, ["read", "write"]);
      assert.equal("agentId" in metadata, false);
      assert.equal("agentName" in metadata, false);
      mcpToken = issued.access_token;
      if (process.env.MILL_VERIFY_OAUTH_TOKEN_FILE)
        await writeFile(
          process.env.MILL_VERIFY_OAUTH_TOKEN_FILE,
          issued.access_token,
          { mode: 0o600 },
        );
      oauthCredentialId = metadata.id;
      if (!state.oauthCredentialId) {
        state.oauthCredentialId = metadata.id;
        state.oauthClientId = client.client_id;
      }
      await writeFile(stateFile, JSON.stringify(state, null, 2), {
        mode: 0o600,
      });
      pass(
        "Human OAuth consent, PKCE exchange and MCP retain approved boards and client metadata for backup",
      );
    }
    const initialized = await mcpRequest(mcpToken, transport, "initialize", {
      protocolVersion: "2025-11-25",
      capabilities: {},
      clientInfo: { name: "mill-production-verification", version: "1.0.0" },
    });
    assert.ok(
      ["2024-11-05", "2025-03-26", "2025-06-18", "2025-11-25"].includes(
        initialized.protocolVersion,
      ),
      "Server negotiates a supported MCP protocol",
    );
    assert.ok(initialized.capabilities.tools);
    transport.protocolVersion = initialized.protocolVersion;
    await mcpRequest(
      mcpToken,
      transport,
      "notifications/initialized",
      undefined,
      true,
    );
    const { tools } = await mcpRequest(mcpToken, transport, "tools/list", {});
    assert.ok(tools.some((item) => item.name === "update_task"));
    assert.ok(
      !tools.some((item) => item.name === "create_board"),
      "Board-restricted MCP cannot create workspace boards",
    );
    for (const name of [
      "list_agents",
      "get_agent",
      "create_agent",
      "update_agent",
      "delete_agent",
      "edit_comment",
      "update_comment",
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
      assert.equal("agentId" in tool.inputSchema.properties, false);
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
        "checklist",
      ])
        assert.equal(field in tool.inputSchema.properties, false);
    }
    const read = await mcpRequest(mcpToken, transport, "tools/call", {
      name: "get_task",
      arguments: { taskId: state.taskId },
    });
    assert.ok(!read.isError);
    assert.equal(read.structuredContent.task.status, "todo");
    assert.equal("agentId" in read.structuredContent.task, false);
    for (const [field, title, assigneeId] of [
      ["mcpTaskId", "Persist MCP human assignment", state.ownerId],
      ["mcpUnassignedTaskId", "Persist unassigned MCP task", null],
    ]) {
      if (state[field]) continue;
      const created = await mcpRequest(mcpToken, transport, "tools/call", {
        name: "create_task",
        arguments: {
          boardId: state.boardId,
          title,
          assigneeId,
          idempotencyKey: `install-${field}`,
        },
      });
      assert.equal(created.isError, false);
      assert.equal(created.structuredContent.task.assigneeId, assigneeId);
      assert.equal("agentId" in created.structuredContent.task, false);
      state[field] = created.structuredContent.task.id;
      await saveState();
    }
    const visibleBoards = await mcpRequest(mcpToken, transport, "tools/call", {
      name: "list_boards",
      arguments: {},
    });
    assert.equal(visibleBoards.isError, false);
    assert.deepEqual(
      visibleBoards.structuredContent.items.map((item) => item.id),
      [state.boardId],
    );
    const outside = await mcpRequest(mcpToken, transport, "tools/call", {
      name: "get_board",
      arguments: { boardId: state.futureBoardId },
    });
    assert.equal(
      outside.isError,
      true,
      "The OAuth-approved board selection remains narrower than workspace access",
    );
    await request(
      `/api/boards/${state.boardId}`,
      "GET",
      undefined,
      403,
      new Map(),
      { Authorization: `Bearer ${mcpToken}` },
    );
    const outsideWrite = await mcpRequest(mcpToken, transport, "tools/call", {
      name: "create_task",
      arguments: {
        boardId: state.futureBoardId,
        title: "Rejected outside OAuth approval",
      },
    });
    assert.equal(outsideWrite.isError, true);
    const history = await request(`/api/tasks/${state.mcpTaskId}/activity`);
    assert.ok(history.items.some((event) => event.actorKind === "oauth"));
    pass(
      "OAuth-approved boards restrict reads and writes; MCP retains human assignments and client attribution",
    );
    const readonlyRedirect = `${origin}/installation-readonly-callback`;
    const readonlyClient = await request(
      "/oauth/register",
      "POST",
      {
        client_name: "Installation read-only client",
        redirect_uris: [readonlyRedirect],
        token_endpoint_auth_method: "none",
      },
      201,
    );
    const readonlyVerifier = randomBytes(32).toString("base64url");
    const readonlyAuthorization = await fetch(
      `${origin}/oauth/authorize?${new URLSearchParams({
        client_id: readonlyClient.client_id,
        redirect_uri: readonlyRedirect,
        resource: `${origin}/mcp`,
        response_type: "code",
        scope: "read",
        state: "readonly-install",
        code_challenge_method: "S256",
        code_challenge: createHash("sha256")
          .update(readonlyVerifier)
          .digest("base64url"),
      })}`,
      { redirect: "manual", signal: AbortSignal.timeout(15000) },
    );
    assert.equal(readonlyAuthorization.status, 302);
    const readonlyRequestId = new URL(
      readonlyAuthorization.headers.get("location"),
    ).searchParams.get("request");
    const readonlyDecision = await request(
      `/api/oauth/consent/${readonlyRequestId}`,
      "POST",
      {
        allow: true,
        boardIds: [state.boardId],
      },
    );
    const readonlyExchange = await fetch(`${origin}/oauth/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: readonlyClient.client_id,
        redirect_uri: readonlyRedirect,
        resource: `${origin}/mcp`,
        grant_type: "authorization_code",
        code: new URL(readonlyDecision.redirectTo).searchParams.get("code"),
        code_verifier: readonlyVerifier,
      }),
      signal: AbortSignal.timeout(15000),
    });
    assert.equal(readonlyExchange.status, 200);
    const readonlyIssued = await readonlyExchange.json();
    const readonlyMetadata = (await request("/api/credentials")).items.find(
      (item) => item.oauthClientId === readonlyClient.client_id,
    );
    assert.deepEqual(readonlyMetadata.scopes, ["read"]);
    const readonlyTransport = { id: 0, protocolVersion: undefined };
    try {
      const initializedReadonly = await mcpRequest(
        readonlyIssued.access_token,
        readonlyTransport,
        "initialize",
        {
          protocolVersion: "2025-11-25",
          capabilities: {},
          clientInfo: { name: "mill-install-readonly", version: "1.0.0" },
        },
      );
      readonlyTransport.protocolVersion = initializedReadonly.protocolVersion;
      await mcpRequest(
        readonlyIssued.access_token,
        readonlyTransport,
        "notifications/initialized",
        undefined,
        true,
      );
      const readable = await mcpRequest(
        readonlyIssued.access_token,
        readonlyTransport,
        "tools/call",
        {
          name: "get_task",
          arguments: { taskId: state.taskId },
        },
      );
      assert.equal(readable.isError, false);
      const readonlyTools = await mcpRequest(
        readonlyIssued.access_token,
        readonlyTransport,
        "tools/list",
        {},
      );
      assert.equal(
        readonlyTools.tools.some((item) => item.name === "create_task"),
        false,
      );
      await mcpRequest(
        readonlyIssued.access_token,
        readonlyTransport,
        "tools/call",
        {
          name: "create_task",
          arguments: {
            boardId: state.boardId,
            title: "Rejected read-only write",
          },
        },
        false,
        403,
      );
    } finally {
      await request(`/api/credentials/${readonlyMetadata.id}`, "DELETE");
    }
    const revoked = await fetch(`${origin}/mcp`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${readonlyIssued.access_token}`,
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/list",
        params: {},
      }),
      signal: AbortSignal.timeout(15000),
    });
    assert.equal(revoked.status, 401);
    pass(
      "Read-only OAuth omits mutation tools, rejects direct writes, and revocation invalidates the bearer token",
    );
    const rejected = await mcpRequest(mcpToken, transport, "tools/call", {
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
        await mcpRequest(mcpToken, transport, "tools/call", {
          name: "create_column",
          arguments: { boardId: state.boardId, name: "Removed" },
        })
      ).isError,
      true,
    );
  } finally {
    await request(`/api/credentials/${external.credential.id}`, "DELETE");
    if (oauthCredentialId && oauthCredentialId !== state.oauthCredentialId)
      await request(`/api/credentials/${oauthCredentialId}`, "DELETE");
  }
  pass(
    "Removed structure, ranking, import/export and email preferences are rejected; real scoped MCP advertises fixed statuses and rejects obsolete capabilities",
  );
}

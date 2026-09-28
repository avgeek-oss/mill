import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";

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
) {
  const response = await fetch(`${origin}${path}`, {
    method,
    headers: {
      Origin: origin,
      "Content-Type": "application/json",
      Cookie: [...jar].map(([name, value]) => `${name}=${value}`).join("; "),
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
      labels: ["install-smoke"],
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
const { task, comments } = await request(`/api/tasks/${state.taskId}`);
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
const exported = await request("/api/export");
assert.equal(exported.format, "mill-portable");
assert.ok(exported.tasks.some((item) => item.id === state.taskId));
assert.ok(exported.comments.some((item) => item.id === state.commentId));
assert.ok(
  exported.members.every(
    (member) => !("passwordHash" in member) && !("totpSecret" in member),
  ),
);
pass(
  "Persisted task/comment/member data and credential-free portable export are readable",
);

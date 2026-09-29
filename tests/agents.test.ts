import { after, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { Agent, Task } from "../packages/contracts/src/index.js";
import {
  cleanupDatabase,
  request,
  resetDatabase,
  setupUser,
  sql,
} from "./support.js";

beforeEach(resetDatabase);
after(cleanupDatabase);
async function json(response: Response, status = 200) {
  assert.equal(response.status, status, await response.clone().text());
  return response.json();
}
async function member(cookie: string, name: string, role = "member") {
  const email = `${name.toLowerCase()}@example.test`;
  const invitation = await json(
    await request("/api/auth/invitations", {
      cookie,
      body: { email, role },
    }),
    201,
  );
  const response = await request("/api/auth/accept-invitation", {
    body: {
      token: invitation.token,
      name,
      password: "Another secure passphrase 42!",
    },
  });
  const { user } = await json(response, 201);
  return { cookie: response.headers.get("set-cookie")!.split(";")[0]!, user };
}
async function createAgent(
  cookie: string,
  name: string,
  scope: "personal" | "team" = "personal",
  memberIds?: string[],
): Promise<Agent> {
  return (
    await json(
      await request("/api/agents", {
        cookie,
        body: { name, scope, ...(memberIds ? { memberIds } : {}) },
      }),
      201,
    )
  ).agent;
}
async function editAgent(
  cookie: string,
  agent: Agent,
  fields: Record<string, unknown>,
): Promise<Agent> {
  return (
    await json(
      await request(`/api/agents/${agent.id}`, {
        cookie,
        method: "PATCH",
        body: { version: agent.version, ...fields },
      }),
    )
  ).agent;
}
async function key(cookie: string, agent: Agent) {
  return json(
    await request("/api/credentials", {
      cookie,
      body: {
        name: "API client",
        agentId: agent.id,
        scopes: ["read", "write"],
      },
    }),
    201,
  );
}
type AgentPage = {
  items: Agent[];
  hasMore: boolean;
  nextCursor: string | null;
};
async function page(
  auth: { cookie?: string; token?: string },
  query = "",
  cursor?: string | null,
): Promise<AgentPage> {
  return json(
    await request(
      `/api/agents?limit=2${query ? "&" + query : ""}${cursor ? "&cursor=" + cursor : ""}`,
      auth,
    ),
  );
}
async function agents(
  auth: { cookie?: string; token?: string },
  query = "",
  first?: AgentPage,
) {
  let current = first ?? (await page(auth, query));
  const items = [...current.items];
  while (current.hasMore) {
    assert.ok(current.nextCursor);
    current = await page(auth, query, current.nextCursor);
    items.push(...current.items);
    assert.ok(items.length <= 1000, "Agent pagination did not terminate");
  }
  assert.equal(current.nextCursor, null);
  assert.equal(new Set(items.map((item) => item.id)).size, items.length);
  return items;
}
async function board(cookie: string) {
  return (
    await json(
      await request("/api/boards", {
        cookie,
        body: { name: "Tasks", prefix: "TASK" },
      }),
      201,
    )
  ).board;
}
async function createTask(
  cookie: string,
  boardId: string,
  title: string,
  fields: Record<string, unknown> = {},
): Promise<Task> {
  return (
    await json(
      await request(`/api/boards/${boardId}/tasks`, {
        cookie,
        body: { title, ...fields },
      }),
      201,
    )
  ).task;
}
async function editTask(
  cookie: string,
  task: Task,
  fields: Record<string, unknown>,
): Promise<Task> {
  return (
    await json(
      await request(`/api/tasks/${task.id}`, {
        cookie,
        method: "PATCH",
        body: { version: task.version, ...fields },
      }),
    )
  ).task;
}

test("personal Agents belong to their creator and remain isolated from other members and administrators", async () => {
  const admin = await setupUser();
  const owner = await member(admin.cookie, "Owner");
  const other = await member(admin.cookie, "Other");
  const mine = await createAgent(owner.cookie, "My helper");
  assert.equal(mine.scope, "personal");
  assert.equal(mine.creatorId, owner.user.id);
  assert.equal(mine.version, 1);
  assert.ok(mine.createdAt && mine.updatedAt);
  assert.deepEqual(
    (await agents({ cookie: owner.cookie })).map((item) => item.id),
    [mine.id],
  );
  for (const account of [admin, other]) {
    assert.deepEqual(await agents({ cookie: account.cookie }), []);
    assert.deepEqual(
      await agents({ cookie: account.cookie }, "manage=true"),
      [],
    );
    assert.equal(
      (
        await request(`/api/agents/${mine.id}`, {
          cookie: account.cookie,
          method: "PATCH",
          body: { version: mine.version, name: "Hijacked" },
        })
      ).status,
      403,
    );
    assert.equal(
      (
        await request(`/api/agents/${mine.id}`, {
          cookie: account.cookie,
          method: "DELETE",
          body: { version: mine.version },
        })
      ).status,
      403,
    );
  }
  const renamed = await editAgent(owner.cookie, mine, { name: "Named helper" });
  assert.equal(renamed.name, "Named helper");
  assert.equal(renamed.version, 2);
  assert.deepEqual(
    await json(
      await request(`/api/agents/${mine.id}`, {
        cookie: owner.cookie,
        method: "DELETE",
        body: { version: renamed.version },
      }),
    ),
    { ok: true },
  );
  assert.deepEqual(await agents({ cookie: owner.cookie }), []);
});

test("team management is administrator-only and assignment access requires an explicit grant", async () => {
  const admin = await setupUser();
  const writer = await member(admin.cookie, "Writer");
  const viewer = await member(admin.cookie, "Viewer", "viewer");
  let team = await createAgent(admin.cookie, "Shared helper", "team", [
    writer.user.id,
    viewer.user.id,
  ]);
  assert.deepEqual(
    [...team.memberIds].sort(),
    [writer.user.id, viewer.user.id].sort(),
  );
  const secondAdmin = await member(admin.cookie, "Secondadmin", "admin");
  assert.deepEqual(await agents({ cookie: secondAdmin.cookie }), []);
  assert.deepEqual(
    (await agents({ cookie: secondAdmin.cookie }, "manage=true")).map(
      (item) => item.id,
    ),
    [team.id],
  );
  team = await editAgent(secondAdmin.cookie, team, {
    name: "Admin-managed helper",
  });
  assert.equal(team.creatorId, admin.user.id);
  assert.deepEqual(await agents({ cookie: admin.cookie }), []);
  assert.deepEqual(
    (await agents({ cookie: admin.cookie }, "manage=true")).map(
      (item) => item.id,
    ),
    [team.id],
  );
  assert.deepEqual(
    (await agents({ cookie: writer.cookie })).map((item) => item.id),
    [team.id],
  );
  assert.deepEqual(
    (await agents({ cookie: writer.cookie }, "manage=true")).map(
      (item) => item.id,
    ),
    [team.id],
  );
  assert.deepEqual(
    (await agents({ cookie: viewer.cookie })).map((item) => item.id),
    [team.id],
  );
  for (const account of [writer, viewer]) {
    assert.equal(
      (
        await request("/api/agents", {
          cookie: account.cookie,
          body: {
            name: "Denied team",
            scope: "team",
            memberIds: [account.user.id],
          },
        })
      ).status,
      403,
    );
    for (const method of ["PATCH", "DELETE"])
      assert.equal(
        (
          await request(`/api/agents/${team.id}`, {
            cookie: account.cookie,
            method,
            body: {
              version: team.version,
              ...(method === "PATCH" ? { name: "Denied rename" } : {}),
            },
          })
        ).status,
        403,
      );
  }
  assert.equal(
    (await request("/api/agents?manage=true", { cookie: viewer.cookie }))
      .status,
    403,
  );
  assert.equal(
    (
      await request("/api/agents", {
        cookie: viewer.cookie,
        body: { name: "Denied personal", scope: "personal" },
      })
    ).status,
    403,
  );
  const granted = await editAgent(admin.cookie, team, {
    memberIds: [admin.user.id, writer.user.id],
  });
  assert.deepEqual(
    (await agents({ cookie: admin.cookie })).map((item) => item.id),
    [team.id],
  );
  assert.deepEqual(await agents({ cookie: viewer.cookie }), []);
  assert.deepEqual(
    [...granted.memberIds].sort(),
    [admin.user.id, writer.user.id].sort(),
  );
});

test("bearer clients can read eligible Agents but cannot create or manage them", async () => {
  const admin = await setupUser();
  const identity = await createAgent(admin.cookie, "Token identity");
  const visible = await createAgent(admin.cookie, "Granted team", "team", [
    admin.user.id,
  ]);
  const hidden = await createAgent(admin.cookie, "Unlisted team", "team", []);
  const credential = await key(admin.cookie, identity);
  assert.deepEqual(
    (await agents({ token: credential.token })).map((item) => item.id),
    [visible.id, identity.id],
  );
  assert.equal(
    (await request("/api/agents?manage=true", { token: credential.token }))
      .status,
    403,
  );
  assert.equal(
    (
      await request("/api/agents", {
        token: credential.token,
        body: { name: "Token-created Agent", scope: "personal" },
      })
    ).status,
    403,
  );
  for (const agent of [identity, visible, hidden])
    for (const method of ["PATCH", "DELETE"])
      assert.equal(
        (
          await request(`/api/agents/${agent.id}`, {
            token: credential.token,
            method,
            body: {
              version: agent.version,
              ...(method === "PATCH" ? { name: "Token edit" } : {}),
            },
          })
        ).status,
        403,
      );
  assert.equal((await request("/api/agents")).status, 401);
});

test("Agent validation rejects personal grants, invalid members and immutable scope without partial changes", async () => {
  const admin = await setupUser();
  const active = await member(admin.cookie, "Active");
  const disabled = await member(admin.cookie, "Disabled");
  await json(
    await request(`/api/auth/members/${disabled.user.id}`, {
      cookie: admin.cookie,
      method: "DELETE",
    }),
  );
  for (const input of [
    { name: "", scope: "personal" },
    { name: "Helper", scope: "unsupported" },
    { name: "Helper", scope: "personal", memberIds: [active.user.id] },
    {
      name: "Helper",
      scope: "team",
      memberIds: [active.user.id, active.user.id],
    },
    { name: "Helper", scope: "team", memberIds: [disabled.user.id] },
    { name: "Helper", scope: "team", memberIds: [randomUUID()] },
  ])
    assert.equal(
      (await request("/api/agents", { cookie: admin.cookie, body: input }))
        .status,
      400,
      JSON.stringify(input),
    );
  assert.deepEqual(await agents({ cookie: admin.cookie }, "manage=true"), []);
  const personal = await createAgent(admin.cookie, "Personal helper");
  for (const fields of [
    { scope: "team" },
    { creatorId: active.user.id },
    { memberIds: [active.user.id] },
  ])
    assert.equal(
      (
        await request(`/api/agents/${personal.id}`, {
          cookie: admin.cookie,
          method: "PATCH",
          body: { version: personal.version, ...fields },
        })
      ).status,
      400,
    );
  assert.deepEqual(await agents({ cookie: admin.cookie }), [personal]);
});

test("version conflicts and idempotent retries preserve one Agent and its accepted grants", async () => {
  const admin = await setupUser();
  const granted = await member(admin.cookie, "Granted");
  const headers = { "Idempotency-Key": "agent-create-retry" };
  const body = {
    name: "One helper",
    scope: "team",
    memberIds: [admin.user.id, granted.user.id],
  };
  const creates = await Promise.all([
    request("/api/agents", { cookie: admin.cookie, headers, body }),
    request("/api/agents", { cookie: admin.cookie, headers, body }),
  ]);
  const first = (await json(creates[0]!, 201)).agent as Agent;
  const replay = (await json(creates[1]!, 201)).agent as Agent;
  assert.deepEqual(replay, first);
  assert.equal(
    (await agents({ cookie: admin.cookie }, "manage=true")).length,
    1,
  );
  const edits = await Promise.all(
    ["Accepted one", "Accepted two"].map((name) =>
      request(`/api/agents/${first.id}`, {
        cookie: admin.cookie,
        method: "PATCH",
        body: { version: first.version, name },
      }),
    ),
  );
  assert.deepEqual(edits.map((response) => response.status).sort(), [200, 409]);
  const current = (await agents({ cookie: admin.cookie }))[0]!;
  assert.ok(["Accepted one", "Accepted two"].includes(current.name));
  assert.equal(current.version, first.version + 1);
  assert.deepEqual([...current.memberIds].sort(), [...first.memberIds].sort());
  const patchOptions = {
    cookie: admin.cookie,
    method: "PATCH",
    headers: { "Idempotency-Key": "agent-patch-retry" },
    body: { version: current.version, name: "Final helper" },
  };
  const patched = await json(
    await request(`/api/agents/${first.id}`, patchOptions),
  );
  const retried = await json(
    await request(`/api/agents/${first.id}`, patchOptions),
  );
  assert.deepEqual(retried, patched);
  assert.equal(patched.agent.version, current.version + 1);
  assert.equal(
    (
      await request(`/api/agents/${first.id}`, {
        cookie: admin.cookie,
        method: "DELETE",
        body: { version: first.version },
      })
    ).status,
    409,
  );
  const deleteOptions = {
    cookie: admin.cookie,
    method: "DELETE",
    headers: { "Idempotency-Key": "agent-delete-retry" },
    body: { version: patched.agent.version },
  };
  assert.deepEqual(
    await json(await request(`/api/agents/${first.id}`, deleteOptions)),
    { ok: true },
  );
  assert.deepEqual(
    await json(await request(`/api/agents/${first.id}`, deleteOptions)),
    { ok: true },
  );
  assert.deepEqual(await agents({ cookie: admin.cookie }, "manage=true"), []);
});

test("human and Agent assignment are independent and both acting user and assignee need access", async () => {
  const admin = await setupUser();
  const teammate = await member(admin.cookie, "Teammate");
  const work = await board(admin.cookie);
  const personal = await createAgent(admin.cookie, "Private helper");
  const shared = await createAgent(admin.cookie, "Shared helper", "team", [
    admin.user.id,
    teammate.user.id,
  ]);
  const restricted = await createAgent(admin.cookie, "Member helper", "team", [
    teammate.user.id,
  ]);
  let task = await createTask(admin.cookie, work.id, "Human work", {
    assigneeId: teammate.user.id,
  });
  assert.equal(task.agentId, null);
  assert.equal(task.agentName, null);
  task = await editTask(admin.cookie, task, { agentId: shared.id });
  assert.equal(task.agentId, shared.id);
  assert.equal(task.agentName, shared.name);
  assert.equal(task.assigneeId, teammate.user.id);
  for (const [fields, status] of [
    [{ agentId: personal.id }, 403],
    [{ agentId: restricted.id }, 403],
    [{ assigneeId: null }, 400],
    [{ assigneeId: randomUUID() }, 400],
  ] as const)
    assert.equal(
      (
        await request(`/api/tasks/${task.id}`, {
          cookie: admin.cookie,
          method: "PATCH",
          body: { version: task.version, ...fields },
        })
      ).status,
      status,
    );
  assert.deepEqual(
    (
      await json(
        await request(`/api/tasks/${task.id}`, { cookie: admin.cookie }),
      )
    ).task,
    task,
  );
  task = await editTask(admin.cookie, task, { assigneeId: admin.user.id });
  assert.equal(task.agentId, shared.id);
  task = await editTask(admin.cookie, task, { agentId: personal.id });
  assert.equal(task.assigneeId, admin.user.id);
  assert.equal(task.agentId, personal.id);
  task = await editTask(admin.cookie, task, { agentId: null });
  assert.equal(task.assigneeId, admin.user.id);
  assert.equal(task.agentId, null);
  assert.equal(task.agentName, null);
  task = await editTask(admin.cookie, task, { assigneeId: null });
  assert.equal(task.assigneeId, null);
  for (const [fields, status] of [
    [{ agentId: shared.id }, 400],
    [{ agentId: personal.id, assigneeId: teammate.user.id }, 403],
    [{ agentId: restricted.id, assigneeId: teammate.user.id }, 403],
  ] as const)
    assert.equal(
      (
        await request(`/api/boards/${work.id}/tasks`, {
          cookie: admin.cookie,
          body: { title: "Rejected assignment", ...fields },
        })
      ).status,
      status,
    );
  const filtered = await json(
    await request(`/api/boards/${work.id}/tasks?agentId=unassigned`, {
      cookie: admin.cookie,
    }),
  );
  assert.deepEqual(
    filtered.items.map((item: Task) => item.id),
    [task.id],
  );
  const bound = await createTask(admin.cookie, work.id, "Bound work", {
    assigneeId: teammate.user.id,
    agentId: shared.id,
  });
  const selected = await json(
    await request(
      `/api/boards/${work.id}/tasks?agentId=${shared.id}&assigneeId=${teammate.user.id}`,
      { cookie: admin.cookie },
    ),
  );
  assert.deepEqual(
    selected.items.map((item: Task) => item.id),
    [bound.id],
  );
});

test("unrelated human task edits preserve a valid Agent that the editor cannot select", async () => {
  const admin = await setupUser();
  const owner = await member(admin.cookie, "Owner");
  const editor = await member(admin.cookie, "Editor");
  const work = await board(admin.cookie);
  const privateAgent = await createAgent(owner.cookie, "Owner's helper");
  const otherPrivateAgent = await createAgent(
    owner.cookie,
    "Owner's other helper",
  );
  let task = await createTask(
    owner.cookie,
    work.id,
    "Private assignment, shared board",
    { assigneeId: owner.user.id, agentId: privateAgent.id },
  );
  assert.deepEqual(await agents({ cookie: editor.cookie }), []);
  task = await editTask(editor.cookie, task, {
    title: "Reviewed by teammate",
    status: "in_review",
    agentId: task.agentId,
    assigneeId: task.assigneeId,
  });
  assert.equal(task.agentId, privateAgent.id);
  assert.equal(task.agentName, privateAgent.name);
  assert.equal(task.assigneeId, owner.user.id);
  for (const fields of [
    { agentId: otherPrivateAgent.id },
    { assigneeId: editor.user.id },
  ])
    assert.equal(
      (
        await request(`/api/tasks/${task.id}`, {
          cookie: editor.cookie,
          method: "PATCH",
          body: { version: task.version, ...fields },
        })
      ).status,
      403,
    );
  assert.equal(
    (
      await json(
        await request(`/api/tasks/${task.id}`, { cookie: editor.cookie }),
      )
    ).task.version,
    task.version,
  );
});

test("Agent renames update current names while preserving previous task action attribution", async () => {
  const admin = await setupUser();
  const identity = await createAgent(admin.cookie, "First helper");
  const credential = await key(admin.cookie, identity);
  const work = await board(admin.cookie);
  const task = (
    await json(
      await request(`/api/boards/${work.id}/tasks`, {
        token: credential.token,
        body: {
          title: "Agent-created work",
          assigneeId: admin.user.id,
          agentId: identity.id,
        },
      }),
      201,
    )
  ).task as Task;
  const before = await json(
    await request(`/api/tasks/${task.id}/activity`, { cookie: admin.cookie }),
  );
  assert.equal(before.items.length, 1);
  assert.equal(before.items[0].actorKind, "agent");
  assert.equal(before.items[0].actorName, "First helper via Admin");
  const renamed = await editAgent(admin.cookie, identity, {
    name: "Renamed helper",
  });
  const detail = await json(
    await request(`/api/tasks/${task.id}`, { cookie: admin.cookie }),
  );
  assert.equal(detail.task.agentName, renamed.name);
  assert.equal(detail.task.agentId, identity.id);
  await json(
    await request(`/api/tasks/${task.id}`, {
      token: credential.token,
      method: "PATCH",
      body: { version: task.version, description: "New context" },
    }),
  );
  const after = await json(
    await request(`/api/tasks/${task.id}/activity`, { cookie: admin.cookie }),
  );
  assert.deepEqual(
    after.items.find((item: { id: string }) => item.id === before.items[0].id),
    before.items[0],
  );
  const updated = after.items.find(
    (item: { action: string }) => item.action === "task.updated",
  );
  assert.equal(updated.actorName, "Renamed helper via Admin");
  assert.equal(updated.actorKind, "agent");
  const listed = await json(
    await request("/api/credentials", { cookie: admin.cookie }),
  );
  assert.equal(listed.items[0].agentName, renamed.name);
  assert.equal(listed.items[0].name, "API client");
});

async function pendingConsent(userId: string, agentId: string) {
  return (
    await sql`INSERT INTO oauth_requests(client_id,client_name,client_trust,redirect_uri,resource,scope,challenge,user_id,agent_id,expires_at) VALUES('agent-regression','Pending connection','registered','https://example.test/callback','https://example.test/mcp','read','challenge',${userId},${agentId},now()+interval '1 day') RETURNING id`
  )[0]!.id as string;
}

test("grant revocation clears task bindings, revokes credentials and pending consent, and preserves work", async () => {
  const admin = await setupUser();
  const owner = await member(admin.cookie, "Owner");
  const work = await board(admin.cookie);
  let shared = await createAgent(admin.cookie, "Shared helper", "team", [
    admin.user.id,
    owner.user.id,
  ]);
  const credential = await key(owner.cookie, shared);
  const pending = await pendingConsent(owner.user.id, shared.id);
  const task = await createTask(admin.cookie, work.id, "Retained task", {
    assigneeId: owner.user.id,
    agentId: shared.id,
    description: "Preserve context",
    checklist: [{ id: "one", text: "Keep this", done: true }],
  });
  await json(
    await request(`/api/tasks/${task.id}/comments`, {
      cookie: owner.cookie,
      body: { body: "Retained discussion" },
    }),
    201,
  );
  const before = await json(
    await request(`/api/tasks/${task.id}/activity`, { cookie: admin.cookie }),
  );
  shared = await editAgent(admin.cookie, shared, {
    memberIds: [admin.user.id],
  });
  assert.deepEqual(await agents({ cookie: owner.cookie }), []);
  assert.equal(
    (await request("/api/agents", { token: credential.token })).status,
    401,
  );
  const detail = await json(
    await request(`/api/tasks/${task.id}`, { cookie: admin.cookie }),
  );
  assert.equal(detail.task.agentId, null);
  assert.equal(detail.task.agentName, null);
  assert.equal(detail.task.version, task.version + 1);
  assert.equal(detail.task.assigneeId, owner.user.id);
  assert.equal(detail.task.description, task.description);
  assert.deepEqual(detail.task.checklist, task.checklist);
  assert.equal(detail.comments[0].body, "Retained discussion");
  for (const previous of before.items)
    assert.deepEqual(
      detail.activity.find((item: { id: string }) => item.id === previous.id),
      previous,
    );
  const cleared = detail.activity.find(
    (item: { id: string }) =>
      !before.items.some((previous: { id: string }) => previous.id === item.id),
  );
  assert.equal(cleared.action, "task.updated");
  assert.equal(cleared.actorId, admin.user.id);
  assert.equal(cleared.actorKind, "human");
  const [consent] =
    await sql`SELECT consumed_at,expires_at<=now() AS expired FROM oauth_requests WHERE id=${pending}`;
  assert.ok(consent!.consumedAt);
  assert.equal(consent!.expired, true);
  assert.equal(
    (
      await request(`/api/tasks/${task.id}`, {
        cookie: admin.cookie,
        method: "PATCH",
        body: { version: detail.task.version, agentId: shared.id },
      })
    ).status,
    403,
  );
  shared = await editAgent(admin.cookie, shared, {
    memberIds: [admin.user.id, owner.user.id],
  });
  assert.equal(
    (await request("/api/agents", { token: credential.token })).status,
    401,
  );
  assert.equal(
    (
      await json(
        await request(`/api/tasks/${task.id}`, { cookie: owner.cookie }),
      )
    ).task.agentId,
    null,
  );
  const freshCredential = await key(owner.cookie, shared);
  assert.equal(
    (await request("/api/agents", { token: freshCredential.token })).status,
    200,
  );
});

test("Agent deletion clears bindings and credentials while preserving tasks, comments and historical names", async () => {
  const admin = await setupUser();
  const identity = await createAgent(admin.cookie, "Deleted helper");
  const credential = await key(admin.cookie, identity);
  const pending = await pendingConsent(admin.user.id, identity.id);
  const work = await board(admin.cookie);
  const task = (
    await json(
      await request(`/api/boards/${work.id}/tasks`, {
        token: credential.token,
        body: {
          title: "Surviving work",
          assigneeId: admin.user.id,
          agentId: identity.id,
          priority: "high",
        },
      }),
      201,
    )
  ).task as Task;
  await json(
    await request(`/api/tasks/${task.id}/comments`, {
      cookie: admin.cookie,
      body: { body: "Surviving comment" },
    }),
    201,
  );
  const before = await json(
    await request(`/api/tasks/${task.id}/activity`, { cookie: admin.cookie }),
  );
  await json(
    await request(`/api/agents/${identity.id}`, {
      cookie: admin.cookie,
      method: "DELETE",
      body: { version: identity.version },
    }),
  );
  assert.deepEqual(await agents({ cookie: admin.cookie }, "manage=true"), []);
  assert.equal(
    (await request(`/api/tasks/${task.id}`, { token: credential.token }))
      .status,
    401,
  );
  const detail = await json(
    await request(`/api/tasks/${task.id}`, { cookie: admin.cookie }),
  );
  assert.equal(detail.task.agentId, null);
  assert.equal(detail.task.agentName, null);
  assert.equal(detail.task.version, task.version + 1);
  assert.equal(detail.task.assigneeId, admin.user.id);
  assert.equal(detail.task.priority, "high");
  assert.equal(detail.comments[0].body, "Surviving comment");
  for (const previous of before.items)
    assert.deepEqual(
      detail.activity.find((item: { id: string }) => item.id === previous.id),
      previous,
    );
  assert.ok(
    detail.activity.some(
      (item: { actorName: string; actorKind: string }) =>
        item.actorKind === "agent" &&
        item.actorName === "Deleted helper via Admin",
    ),
  );
  const [consent] =
    await sql`SELECT consumed_at,expires_at<=now() AS expired FROM oauth_requests WHERE id=${pending}`;
  assert.ok(consent!.consumedAt);
  assert.equal(consent!.expired, true);
});

function encode(value: unknown) {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}
async function staleAgentPage(cookie: string, first: AgentPage) {
  assert.ok(first.nextCursor);
  const body = await json(
    await request(`/api/agents?limit=2&cursor=${first.nextCursor}`, { cookie }),
    409,
  );
  assert.equal(body.code, "agent_list_changed");
}

test("Agent directories traverse beyond 100 with alphabetical case and identifier ties", async () => {
  const admin = await setupUser();
  await sql`INSERT INTO agents(name,scope,creator_id) SELECT CASE sequence%3 WHEN 0 THEN 'Helper' WHEN 1 THEN 'helper' ELSE 'HELPER' END,'personal',${admin.user.id} FROM generate_series(1,113) sequence`;
  const expected = (
    await sql`SELECT id FROM agents ORDER BY lower(name),name,id`
  ).map((item) => item.id);
  const first: AgentPage = await json(
    await request("/api/agents", { cookie: admin.cookie }),
  );
  assert.equal(first.items.length, 100);
  assert.equal(first.hasMore, true);
  assert.deepEqual(
    (await agents({ cookie: admin.cookie }, "", first)).map((item) => item.id),
    expected,
  );
  for (const limit of ["0", "101", "-1", "1.5", "NaN"])
    assert.equal(
      (await request(`/api/agents?limit=${limit}`, { cookie: admin.cookie }))
        .status,
      400,
    );
});

test("directory snapshots detect renames, creation, deletion and eligibility changes before continuation", async () => {
  const admin = await setupUser();
  const owner = await member(admin.cookie, "Owner");
  const teams: Agent[] = [];
  for (const name of ["A", "B", "C", "D"])
    teams.push(await createAgent(admin.cookie, name, "team", [owner.user.id]));
  const privateAgent = await createAgent(owner.cookie, "Zulu");
  let first = await page({ cookie: owner.cookie });
  teams[2] = await editAgent(admin.cookie, teams[2]!, { memberIds: [] });
  await staleAgentPage(owner.cookie, first);
  assert.deepEqual(
    (await agents({ cookie: owner.cookie })).map((item) => item.id),
    [teams[0]!.id, teams[1]!.id, teams[3]!.id, privateAgent.id],
  );
  const entering = await createAgent(admin.cookie, "AA", "team", []);
  first = await page({ cookie: owner.cookie });
  await editAgent(admin.cookie, entering, { memberIds: [owner.user.id] });
  await staleAgentPage(owner.cookie, first);
  first = await page({ cookie: owner.cookie });
  const renamed = await editAgent(admin.cookie, teams[3]!, { name: "AB" });
  await staleAgentPage(owner.cookie, first);
  first = await page({ cookie: owner.cookie });
  const personal = await createAgent(owner.cookie, "AAA");
  await staleAgentPage(owner.cookie, first);
  first = await page({ cookie: owner.cookie });
  await json(
    await request(`/api/agents/${renamed.id}`, {
      cookie: admin.cookie,
      method: "DELETE",
      body: { version: renamed.version },
    }),
  );
  await staleAgentPage(owner.cookie, first);
  assert.deepEqual(
    (await agents({ cookie: owner.cookie })).map((item) => item.id),
    [teams[0]!.id, entering.id, personal.id, teams[1]!.id, privateAgent.id],
  );
});

test("member removal invalidates management pages when rendered grants change without an Agent version change", async () => {
  const admin = await setupUser();
  const granted = await member(admin.cookie, "Granted");
  const firstAgent = await createAgent(admin.cookie, "A Team", "team", [
    granted.user.id,
  ]);
  const lastAgent = await createAgent(admin.cookie, "Z Team", "team", []);
  const first: AgentPage = await json(
    await request("/api/agents?manage=true&limit=1", { cookie: admin.cookie }),
  );
  assert.ok(first.nextCursor);
  assert.deepEqual(first.items[0]!.memberIds, [granted.user.id]);
  await json(
    await request(`/api/auth/members/${granted.user.id}`, {
      cookie: admin.cookie,
      method: "DELETE",
    }),
  );
  const stale = await json(
    await request(
      `/api/agents?manage=true&limit=1&cursor=${first.nextCursor}`,
      { cookie: admin.cookie },
    ),
    409,
  );
  assert.equal(stale.code, "agent_list_changed");
  const restarted = await agents({ cookie: admin.cookie }, "manage=true");
  assert.deepEqual(
    restarted.map((agent) => agent.id),
    [firstAgent.id, lastAgent.id],
  );
  assert.deepEqual(restarted[0]!.memberIds, []);
  assert.equal(restarted[0]!.version, firstAgent.version);
});

test("Agent cursors reject forged, legacy, cross-account and wrong-mode anchors without leaking hidden Agents", async () => {
  const admin = await setupUser();
  const owner = await member(admin.cookie, "Owner");
  const hidden = await createAgent(admin.cookie, "Hidden personal");
  for (const name of ["A", "B", "C"]) await createAgent(owner.cookie, name);
  const first = await page({ cookie: owner.cookie });
  assert.ok(first.nextCursor);
  const payload = JSON.parse(
    Buffer.from(first.nextCursor, "base64url").toString(),
  );
  const { revision: _revision, ...legacy } = payload;
  for (const cursor of [
    "",
    "not-json",
    encode({}),
    encode(legacy),
    encode({ ...payload, name: "Forged name" }),
    encode({ ...payload, id: randomUUID() }),
    encode({ ...payload, id: hidden.id, name: hidden.name }),
  ])
    assert.equal(
      (await request(`/api/agents?cursor=${cursor}`, { cookie: owner.cookie }))
        .status,
      400,
    );
  assert.equal(
    (
      await request(`/api/agents?cursor=${first.nextCursor}`, {
        cookie: admin.cookie,
      })
    ).status,
    400,
  );
  assert.equal(
    (
      await request(`/api/agents?manage=true&cursor=${first.nextCursor}`, {
        cookie: owner.cookie,
      })
    ).status,
    400,
  );
  assert.equal(
    (await request("/api/agents?manage=1", { cookie: owner.cookie })).status,
    400,
  );
  await editAgent(admin.cookie, hidden, { name: "Still hidden" });
  const continued = await agents({ cookie: owner.cookie }, "", first);
  assert.deepEqual(
    continued.map((item) => item.name),
    ["A", "B", "C"],
  );
});

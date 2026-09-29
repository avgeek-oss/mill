import { after, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import {
  cleanupDatabase,
  request,
  resetDatabase,
  setupAgent,
  setupUser,
  setupOAuthAgent,
  callMcpTool,
  sql,
} from "./support.js";
import type { Tx } from "../apps/api/src/domain/helpers.js";

beforeEach(resetDatabase);
after(cleanupDatabase);
async function json(response: Response, status = 200) {
  assert.equal(response.status, status, await response.clone().text());
  return response.json();
}
async function fixture() {
  const admin = await setupUser();
  const invite = await json(
    await request("/api/auth/invitations", {
      cookie: admin.cookie,
      body: { email: "agent-race@example.test", role: "member" },
    }),
    201,
  );
  const accepted = await request("/api/auth/accept-invitation", {
    body: {
      token: invite.token,
      name: "Member",
      password: "Another secure passphrase 42!",
    },
  });
  const { user } = await json(accepted, 201);
  const memberCookie = accepted.headers.get("set-cookie")!.split(";")[0];
  const agent = await setupAgent(admin.cookie, {
    name: "Race helper",
    scope: "team",
    memberIds: [admin.user.id, user.id],
  });
  const { board } = await json(
    await request("/api/boards", {
      cookie: admin.cookie,
      body: { name: "Agent races", prefix: "RACE" },
    }),
    201,
  );
  return { ...admin, member: user, memberCookie, agent, board };
}
async function barrier() {
  let release!: () => void,
    ready!: () => void,
    fail!: (error: unknown) => void,
    pid = 0;
  const started = new Promise<void>((resolve, reject) => {
    ready = resolve;
    fail = reject;
  });
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  const holder = sql.begin(async (tx: Tx) => {
    pid = (await tx`SELECT pg_backend_pid() AS pid`)[0].pid;
    await tx`SELECT id FROM workspace FOR UPDATE`;
    ready();
    await released;
  });
  void holder.catch(fail);
  await started;
  return {
    pid,
    async release() {
      release();
      await holder;
    },
  };
}
async function waitForBlocked(pid: number, expected: number) {
  const deadline = Date.now() + 5000;
  do {
    const [row] =
      await sql`WITH RECURSIVE blocked(pid) AS (SELECT pid FROM pg_stat_activity WHERE ${pid}=ANY(pg_blocking_pids(pid)) UNION SELECT activity.pid FROM pg_stat_activity activity JOIN blocked ON blocked.pid=ANY(pg_blocking_pids(activity.pid))) SELECT count(DISTINCT pid)::int AS total FROM blocked`;
    if (row.total >= expected) return;
  } while (Date.now() < deadline);
  assert.fail(
    `Expected ${expected} actual requests blocked by authority ${pid}`,
  );
}
for (const action of ["grant", "delete", "disable"] as const) {
  for (const first of ["revocation", "binding"] as const) {
    test(`Agent ${action} and task binding serialize when ${first} acquires authority first`, async () => {
      const { cookie, user, member, agent, board } = await fixture();
      const gate = await barrier();
      const binding = () =>
        request(`/api/boards/${board.id}/tasks`, {
          cookie,
          body: {
            title: "Concurrent Agent binding",
            agentId: agent.id,
            assigneeId: member.id,
          },
        });
      const revoke = () =>
        action === "grant"
          ? request(`/api/agents/${agent.id}`, {
              cookie,
              method: "PATCH",
              body: { version: agent.version, memberIds: [user.id] },
            })
          : action === "delete"
            ? request(`/api/agents/${agent.id}`, {
                cookie,
                method: "DELETE",
                body: { version: agent.version },
              })
            : request(`/api/auth/members/${member.id}`, {
                cookie,
                method: "DELETE",
              });
      let firstResponse!: Promise<Response>, secondResponse!: Promise<Response>;
      try {
        firstResponse = first === "revocation" ? revoke() : binding();
        await waitForBlocked(gate.pid, 1);
        secondResponse = first === "revocation" ? binding() : revoke();
        await waitForBlocked(gate.pid, 2);
      } finally {
        await gate.release();
      }
      const earlier = await firstResponse,
        later = await secondResponse;
      const revoked = first === "revocation" ? earlier : later,
        assigned = first === "binding" ? earlier : later;
      await json(revoked);
      const tasks = await sql`SELECT * FROM tasks WHERE board_id=${board.id}`;
      if (first === "revocation") {
        await json(assigned, action === "disable" ? 400 : 403);
        assert.equal(tasks.length, 0);
        assert.equal(
          (await sql`SELECT next_number FROM boards WHERE id=${board.id}`)[0]
            .nextNumber,
          1,
        );
      } else {
        const { task } = await json(assigned, 201);
        assert.equal(task.agentId, agent.id);
        assert.equal(task.agentName, agent.name);
        assert.equal(tasks.length, 1);
        assert.equal(tasks[0].agentId, null);
        assert.equal(tasks[0].assigneeId, member.id);
        assert.equal(tasks[0].version, task.version + 1);
        assert.equal(
          (await sql`SELECT next_number FROM boards WHERE id=${board.id}`)[0]
            .nextNumber,
          2,
        );
        const history = await json(
          await request(`/api/tasks/${task.id}/activity`, { cookie }),
        );
        assert.equal(
          history.items.filter(
            (event: { action: string }) => event.action === "task.created",
          ).length,
          1,
        );
        assert.equal(
          history.items.filter(
            (event: { action: string }) => event.action === "task.updated",
          ).length,
          1,
        );
      }
      assert.equal(
        (await sql`SELECT * FROM tasks WHERE agent_id IS NOT NULL`).length,
        0,
      );
    });
  }
}

test("a warmed bound credential mutation queued after grant revocation cannot edit a task", async () => {
  const { cookie, user, memberCookie, agent, board } = await fixture();
  const { task } = await json(
    await request(`/api/boards/${board.id}/tasks`, {
      cookie,
      body: { title: "Preserve human work" },
    }),
    201,
  );
  const credential = await setupOAuthAgent(memberCookie, {
    agentId: agent.id,
    boardIds: [board.id],
  });
  const warmed = await callMcpTool(credential.token, "get_task", {
    taskId: task.id,
  });
  assert.equal(warmed.result?.isError, false);
  const before = await sql`SELECT * FROM tasks ORDER BY id`,
    history = await sql`SELECT * FROM activity ORDER BY id`;
  const gate = await barrier();
  let changed!: Promise<Response>, pending!: ReturnType<typeof callMcpTool>;
  try {
    changed = request(`/api/agents/${agent.id}`, {
      cookie,
      method: "PATCH",
      body: { version: agent.version, memberIds: [user.id] },
    });
    await waitForBlocked(gate.pid, 1);
    pending = callMcpTool(credential.token, "update_task", {
      taskId: task.id,
      version: task.version,
      title: "Must be denied",
      idempotencyKey: "revoked-agent-edit",
    });
    await waitForBlocked(gate.pid, 2);
  } finally {
    await gate.release();
  }
  await json(await changed);
  const denied = await pending;
  assert.ok(
    [401, 403].includes(denied.response.status) ||
      denied.result?.isError === true,
  );
  assert.deepEqual(await sql`SELECT * FROM tasks ORDER BY id`, before);
  assert.deepEqual(await sql`SELECT * FROM activity ORDER BY id`, history);
  assert.ok(
    (
      await sql`SELECT revoked_at FROM credentials WHERE id=${credential.credential.id}`
    )[0].revokedAt,
  );
  assert.equal(
    (await request(`/api/tasks/${task.id}`, { token: credential.token }))
      .status,
    401,
  );
});

test("OAuth consent returns every eligible Agent beyond the former 1000-item helper ceiling", async () => {
  const { cookie, user } = await setupUser();
  await sql`INSERT INTO agents(name,scope,creator_id) SELECT 'Helper '||lpad(sequence::text,4,'0'),'personal',${user.id} FROM generate_series(1,1005) sequence`;
  const [grant] =
    await sql`INSERT INTO oauth_requests(client_id,client_name,client_trust,redirect_uri,resource,scope,challenge,expires_at) VALUES('large-client','Large client','registered','https://example.test/callback','https://example.test/mcp','read','challenge',now()+interval '10 minutes') RETURNING id`;
  const consent = await json(
    await request(`/api/oauth/consent/${grant.id}`, { cookie }),
  );
  assert.equal(consent.agents.length, 1005);
  const expected =
    await sql`SELECT id FROM agents ORDER BY lower(name),name,id`;
  assert.deepEqual(
    consent.agents.map((agent: { id: string }) => agent.id),
    expected.map((agent) => agent.id),
  );
  assert.equal(consent.requiresAgent, true);
  assert.equal(consent.canApprove, true);
  const selected = consent.agents.at(-1);
  await json(
    await request(`/api/oauth/consent/${grant.id}`, {
      cookie,
      body: { allow: true, agentId: selected.id },
    }),
  );
  assert.equal(
    (await sql`SELECT agent_id FROM oauth_requests WHERE id=${grant.id}`)[0]
      .agentId,
    selected.id,
  );
});

test("member removal rolls back all Agent cleanup when attributed task history fails", async () => {
  const { cookie, member, memberCookie, agent, board } = await fixture();
  const { task } = await json(
    await request(`/api/boards/${board.id}/tasks`, {
      cookie,
      body: {
        title: "Keep complete human work",
        assigneeId: member.id,
        agentId: agent.id,
      },
    }),
    201,
  );
  await json(
    await request(`/api/tasks/${task.id}/comments`, {
      cookie,
      body: { body: "Keep discussion" },
    }),
    201,
  );
  await json(
    await request("/api/credentials", {
      cookie: memberCookie,
      body: { name: "Member key" },
    }),
    201,
  );
  const before = new Map<string, unknown>();
  for (const table of [
    "users",
    "sessions",
    "tasks",
    "comments",
    "activity",
    "notifications",
    "agent_members",
    "credentials",
  ])
    before.set(
      table,
      await sql`SELECT to_jsonb(${sql(table)}) AS content FROM ${sql(table)} ORDER BY to_jsonb(${sql(table)})::text`,
    );
  await sql.unsafe(
    `CREATE FUNCTION reject_agent_clear_history() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action='task.updated' AND NEW.detail->'fields'='["agentId"]'::jsonb THEN RAISE EXCEPTION 'Simulated history failure'; END IF; RETURN NEW; END; $$; CREATE TRIGGER reject_agent_clear_history BEFORE INSERT ON activity FOR EACH ROW EXECUTE FUNCTION reject_agent_clear_history();`,
  );
  try {
    assert.equal(
      (
        await request(`/api/auth/members/${member.id}`, {
          cookie,
          method: "DELETE",
        })
      ).status,
      500,
    );
    for (const table of before.keys())
      assert.deepEqual(
        await sql`SELECT to_jsonb(${sql(table)}) AS content FROM ${sql(table)} ORDER BY to_jsonb(${sql(table)})::text`,
        before.get(table),
        table,
      );
  } finally {
    await sql.unsafe("DROP TRIGGER reject_agent_clear_history ON activity");
    await sql.unsafe("DROP FUNCTION reject_agent_clear_history()");
  }
});

for (const transition of ["narrow", "remove-grant-with-all-members"] as const) {
  for (const first of ["policy", "binding"] as const) {
    test(`Agent ${transition} and task binding serialize with ${first} first without revoking retained access`, async () => {
      const { cookie, user, member, memberCookie, agent, board } =
        await fixture();
      const current = (
        await json(
          await request(`/api/agents/${agent.id}`, {
            cookie,
            method: "PATCH",
            body: { version: agent.version, allMembers: true },
          }),
        )
      ).agent;
      const credential = await setupOAuthAgent(memberCookie, {
        agentId: agent.id,
      });
      const gate = await barrier();
      const policy = () =>
        request(`/api/agents/${agent.id}`, {
          cookie,
          method: "PATCH",
          body: {
            version: current.version,
            allMembers: transition !== "narrow",
            memberIds: [user.id],
          },
        });
      const binding = () =>
        request(`/api/boards/${board.id}/tasks`, {
          cookie,
          body: {
            title: "Serialized dynamic access",
            agentId: agent.id,
            assigneeId: member.id,
          },
        });
      let early!: Promise<Response>, late!: Promise<Response>;
      try {
        early = first === "policy" ? policy() : binding();
        await waitForBlocked(gate.pid, 1);
        late = first === "policy" ? binding() : policy();
        await waitForBlocked(gate.pid, 2);
      } finally {
        await gate.release();
      }
      const policyResponse = first === "policy" ? await early : await late;
      const bindingResponse = first === "binding" ? await early : await late;
      await json(policyResponse);
      const tasks = await sql`SELECT * FROM tasks WHERE board_id=${board.id}`;
      const retained = transition === "remove-grant-with-all-members";
      if (!retained && first === "policy") {
        await json(bindingResponse, 403);
        assert.equal(tasks.length, 0);
      } else {
        const { task } = await json(bindingResponse, 201);
        assert.equal(tasks.length, 1);
        assert.equal(tasks[0].assigneeId, member.id);
        assert.equal(tasks[0].agentId, retained ? agent.id : null);
        assert.equal(tasks[0].version, task.version + (retained ? 0 : 1));
        const history =
          await sql`SELECT action,detail,actor_kind FROM activity WHERE task_id=${task.id} ORDER BY created_at,id`;
        assert.equal(history.length, retained ? 1 : 2);
        if (!retained) {
          assert.equal(history[1].action, "task.updated");
          assert.deepEqual(history[1].detail, { fields: ["agentId"] });
          assert.equal(history[1].actorKind, "human");
        }
      }
      const [stored] =
        await sql`SELECT revoked_at FROM credentials WHERE id=${credential.credential.id}`;
      assert.equal(Boolean(stored.revokedAt), !retained);
      assert.equal(
        (
          await sql`SELECT * FROM agent_members WHERE agent_id=${agent.id} AND user_id=${member.id}`
        ).length,
        0,
      );
      assert.equal(
        (
          await sql`SELECT * FROM agent_members WHERE agent_id=${agent.id} AND user_id=${user.id}`
        ).length,
        1,
      );
    });
  }
}

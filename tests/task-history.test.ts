import { after, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { randomUUID, createHash } from "node:crypto";
import type { Task } from "../packages/contracts/src/index.js";
import {
  callMcpTool,
  cleanupDatabase,
  request,
  resetDatabase,
  setupAgent,
  setupOAuthAgent,
  setupUser,
  sql,
} from "./support.js";

beforeEach(resetDatabase);
after(cleanupDatabase);
async function json(response: Response, status = 200) {
  assert.equal(response.status, status, await response.clone().text());
  return response.json();
}
async function agentTask(token: string, args: Record<string, unknown>) {
  const called = await callMcpTool(token, "update_task", args);
  assert.equal(called.response.status, 200);
  assert.equal(called.result?.isError, false, JSON.stringify(called.result));
  return called.result!.structuredContent as { task: Task };
}
async function member(cookie: string, role: "member" | "viewer") {
  const invitation = await json(
    await request("/api/auth/invitations", {
      cookie,
      body: { email: `${role}@example.test`, role },
    }),
    201,
  );
  const response = await request("/api/auth/accept-invitation", {
    body: {
      token: invitation.token,
      name: role,
      password: "Another secure passphrase 42!",
    },
  });
  const body = await json(response, 201);
  return {
    cookie: response.headers.get("set-cookie")!.split(";")[0],
    user: body.user,
  };
}

test("workspace audit is absent for every role while task history retains human, agent and comment actions", async () => {
  const { cookie, user } = await setupUser();
  const writer = await member(cookie, "member");
  const viewer = await member(cookie, "viewer");
  const { board } = await json(
    await request("/api/boards", {
      cookie,
      body: { name: "Task history", prefix: "HISTORY" },
    }),
    201,
  );
  const personalKey = await json(
    await request("/api/credentials", {
      cookie,
      body: { name: "Human task client", expiresInDays: 30 },
    }),
    201,
  );
  const credential = await setupOAuthAgent(cookie, {
    agentId: (await setupAgent(cookie, { name: "Task helper" })).id,
    boardIds: [board.id],
  });
  for (const access of [
    {},
    { cookie },
    { cookie: writer.cookie },
    { cookie: viewer.cookie },
    { token: personalKey.token },
  ])
    assert.equal((await request("/api/audit", access)).status, 404);
  let task = (
    await json(
      await request(`/api/boards/${board.id}/tasks`, {
        cookie,
        body: { title: "Retain task actions" },
      }),
      201,
    )
  ).task;
  assert.equal(task.status, "todo");
  assert.equal(
    (await request(`/api/tasks/${task.id}`, { token: credential.token }))
      .status,
    403,
  );
  assert.equal(
    (await callMcpTool(personalKey.token, "get_task", { taskId: task.id }))
      .response.status,
    403,
  );
  const comment = (
    await json(
      await request(`/api/tasks/${task.id}/comments`, {
        cookie: writer.cookie,
        body: { body: "Human comment" },
      }),
      201,
    )
  ).comment;
  const edited = (
    await json(
      await request(`/api/comments/${comment.id}`, {
        cookie: writer.cookie,
        method: "PATCH",
        body: { version: comment.version, body: "Edited human comment" },
      }),
    )
  ).comment;
  await json(
    await request(`/api/comments/${comment.id}`, {
      cookie: writer.cookie,
      method: "DELETE",
      body: { version: edited.version },
    }),
  );
  task = (
    await json(
      await request(`/api/tasks/${task.id}`, {
        token: personalKey.token,
        method: "PATCH",
        body: {
          version: task.version,
          assigneeId: writer.user.id,
          priority: "high",
        },
      }),
    )
  ).task;
  task = (
    await agentTask(credential.token, {
      taskId: task.id,
      version: task.version,
      description: "Agent edit",
    })
  ).task;
  task = (
    await agentTask(credential.token, {
      taskId: task.id,
      version: task.version,
      status: "in_progress",
    })
  ).task;
  const agentComment = await callMcpTool(credential.token, "add_comment", {
    taskId: task.id,
    body: "Agent comment",
  });
  assert.equal(agentComment.response.status, 200);
  assert.equal(
    agentComment.result?.isError,
    false,
    JSON.stringify(agentComment.result),
  );
  const history = await json(
    await request(`/api/tasks/${task.id}/activity`, { cookie: viewer.cookie }),
  );
  assert.equal(history.items.length, 8);
  assert.deepEqual(
    history.items.map((event: { action: string }) => event.action).sort(),
    [
      "task.created",
      "task.updated",
      "task.updated",
      "task.moved",
      "comment.created",
      "comment.updated",
      "comment.deleted",
      "comment.created",
    ].sort(),
  );
  const agentEvents = history.items.filter(
    (event: { actorKind: string }) => event.actorKind === "agent",
  );
  assert.equal(agentEvents.length, 3);
  assert.ok(
    agentEvents.every(
      (event: { actorId: string; actorName: string }) =>
        event.actorId === user.id &&
        event.actorName === "Task helper via Admin",
    ),
  );
  const personalKeyEvent = history.items.find(
    (event: { action: string; actorKind: string }) =>
      event.action === "task.updated" && event.actorKind === "human",
  );
  assert.equal(personalKeyEvent.actorId, user.id);
  assert.equal(personalKeyEvent.actorName, "Admin");
  assert.deepEqual(personalKeyEvent.detail, {
    fields: ["assigneeId", "priority"],
  });
  assert.ok(
    history.items.every(
      (event: { taskId: string; boardId: string }) =>
        event.taskId === task.id && event.boardId === board.id,
    ),
  );
  const before = await sql`SELECT * FROM activity ORDER BY id`;
  await json(
    await request("/api/workspace", {
      cookie,
      method: "PATCH",
      body: { name: "Updated workspace" },
    }),
  );
  await json(
    await request(`/api/credentials/${credential.credential.id}`, {
      cookie,
      method: "DELETE",
    }),
  );
  await json(
    await request(`/api/credentials/${personalKey.credential.id}`, {
      cookie,
      method: "DELETE",
    }),
  );
  await json(
    await request(`/api/auth/members/${writer.user.id}`, {
      cookie,
      method: "PATCH",
      body: { role: "viewer" },
    }),
  );
  assert.deepEqual(await sql`SELECT * FROM activity ORDER BY id`, before);
  const [tables] =
    await sql`SELECT to_regclass(${process.env.MILL_DB_SCHEMA + ".auth_audit"}) AS auth_audit`;
  assert.equal(tables.authAudit, null);
  await json(
    await request(`/api/tasks/${task.id}`, {
      cookie,
      method: "DELETE",
      body: { version: task.version },
    }),
  );
  assert.equal((await sql`SELECT * FROM activity`).length, 0);
});

test("status changes retain attributed history, reject stale versions and deduplicate retries", async () => {
  const { cookie, user } = await setupUser();
  const { board } = await json(
    await request("/api/boards", {
      cookie,
      body: { name: "Status history", prefix: "STATUS" },
    }),
    201,
  );
  const { task } = await json(
    await request(`/api/boards/${board.id}/tasks`, {
      cookie,
      body: { title: "Change status", status: "backlog" },
    }),
    201,
  );
  const { task: unrelated } = await json(
    await request(`/api/boards/${board.id}/tasks`, {
      cookie,
      body: { title: "Keep completed task", status: "done" },
    }),
    201,
  );
  const taskBefore = await sql`SELECT * FROM tasks WHERE id=${task.id}`;
  const historyBefore = await sql`SELECT * FROM activity ORDER BY id`;
  const unrelatedBefore =
    await sql`SELECT * FROM tasks WHERE id=${unrelated.id}`;
  const unrelatedHistory =
    await sql`SELECT * FROM activity WHERE task_id=${unrelated.id} ORDER BY id`;
  const credential = await setupOAuthAgent(cookie, {
    agentId: (await setupAgent(cookie, { name: "Status helper" })).id,
    boardIds: [board.id],
  });
  const stale = await callMcpTool(credential.token, "update_task", {
    taskId: task.id,
    version: task.version + 1,
    status: "in_progress",
  });
  assert.equal(stale.response.status, 200);
  assert.equal(stale.result?.isError, true);
  assert.deepEqual(stale.result?.structuredContent, {
    error: "This item changed. Reload it before saving.",
  });
  assert.deepEqual(
    await sql`SELECT * FROM tasks WHERE id=${task.id}`,
    taskBefore,
  );
  assert.deepEqual(
    await sql`SELECT * FROM activity ORDER BY id`,
    historyBefore,
  );
  const patchArgs = {
    taskId: task.id,
    version: task.version,
    status: "in_progress",
    idempotencyKey: "status-change-history",
  };
  const changed = await agentTask(credential.token, patchArgs);
  const replayed = await agentTask(credential.token, patchArgs);
  assert.deepEqual(replayed, changed);
  assert.equal(changed.task.status, "in_progress");
  assert.equal(changed.task.version, task.version + 1);
  const history = await json(
    await request(`/api/tasks/${task.id}/activity`, { cookie }),
  );
  assert.equal(history.items.length, 2);
  assert.deepEqual(
    history.items.map((event: { action: string }) => event.action).sort(),
    ["task.created", "task.moved"],
  );
  const event = history.items.find(
    (event: { action: string }) => event.action === "task.moved",
  );
  assert.equal(event.taskId, task.id);
  assert.equal(event.boardId, board.id);
  assert.equal(event.actorId, user.id);
  assert.equal(event.actorKind, "agent");
  assert.equal(event.actorName, "Status helper via Admin");
  assert.deepEqual(event.detail, {
    fromStatus: "backlog",
    status: "in_progress",
  });
  assert.deepEqual(
    await sql`SELECT * FROM tasks WHERE id=${unrelated.id}`,
    unrelatedBefore,
  );
  assert.deepEqual(
    await sql`SELECT * FROM activity WHERE task_id=${unrelated.id} ORDER BY id`,
    unrelatedHistory,
  );
});

test("personal keys retain human task history across boards and follow current membership", async () => {
  const { cookie } = await setupUser();
  const writer = await member(cookie, "member");
  const personalKey = await json(
    await request("/api/credentials", {
      cookie: writer.cookie,
      body: { name: "Personal history client", expiresInDays: 60 },
    }),
    201,
  );
  assert.equal(personalKey.credential.agentId, null);
  assert.equal(personalKey.credential.agentName, null);
  assert.deepEqual(personalKey.credential.scopes, []);
  assert.equal(personalKey.credential.boardIds, null);
  const tasks: Task[] = [];
  for (const [name, prefix] of [
    ["First history board", "FIRST"],
    ["Second history board", "SECOND"],
  ]) {
    const { board } = await json(
      await request("/api/boards", { cookie, body: { name, prefix } }),
      201,
    );
    const { task } = await json(
      await request(`/api/boards/${board.id}/tasks`, {
        token: personalKey.token,
        body: { title: `Work on ${name}`, status: "backlog" },
      }),
      201,
    );
    tasks.push(task);
  }
  const task = tasks[0]!;
  const patchOptions = {
    token: personalKey.token,
    method: "PATCH",
    headers: { "Idempotency-Key": "personal-status-history" },
    body: { version: task.version, status: "in_progress" },
  };
  const changed = await json(
    await request(`/api/tasks/${task.id}`, patchOptions),
  );
  const replayResponse = await request(`/api/tasks/${task.id}`, patchOptions);
  assert.equal(replayResponse.headers.get("Idempotency-Replayed"), "true");
  assert.deepEqual(await json(replayResponse), changed);
  const history = await json(
    await request(`/api/tasks/${task.id}/activity`, {
      token: personalKey.token,
    }),
  );
  assert.deepEqual(
    history.items.map((event: { action: string }) => event.action).sort(),
    ["task.created", "task.moved"],
  );
  assert.ok(
    history.items.every(
      (event: { actorKind: string; actorId: string; actorName: string }) =>
        event.actorKind === "human" &&
        event.actorId === writer.user.id &&
        event.actorName === writer.user.name,
    ),
  );
  const taskBefore = await sql`SELECT * FROM tasks ORDER BY id`;
  const historyBefore = await sql`SELECT * FROM activity ORDER BY id`;
  await json(
    await request(`/api/auth/members/${writer.user.id}`, {
      cookie,
      method: "PATCH",
      body: { role: "viewer" },
    }),
  );
  assert.equal(
    (
      await request(`/api/tasks/${task.id}`, {
        token: personalKey.token,
        method: "PATCH",
        body: { version: changed.task.version, status: "done" },
      })
    ).status,
    403,
  );
  const { task: other } = await json(
    await request(`/api/tasks/${tasks[1]!.id}`, { token: personalKey.token }),
  );
  assert.equal(other.id, tasks[1]!.id);
  assert.equal(other.status, "backlog");
  assert.deepEqual(await sql`SELECT * FROM tasks ORDER BY id`, taskBefore);
  assert.deepEqual(
    await sql`SELECT * FROM activity ORDER BY id`,
    historyBefore,
  );
});

test("a status change rolls back when its task history cannot be persisted", async () => {
  const { cookie } = await setupUser();
  const { board } = await json(
    await request("/api/boards", {
      cookie,
      body: { name: "Atomic history", prefix: "ATOMIC" },
    }),
    201,
  );
  const { task } = await json(
    await request(`/api/boards/${board.id}/tasks`, {
      cookie,
      body: { title: "Keep task and history consistent" },
    }),
    201,
  );
  const before = await sql`SELECT * FROM tasks WHERE id=${task.id}`;
  const historyBefore = await sql`SELECT * FROM activity ORDER BY id`;
  await sql.unsafe(`
    CREATE FUNCTION reject_task_move_history() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF NEW.action='task.moved' THEN
        RAISE EXCEPTION 'Simulated task history failure';
      END IF;
      RETURN NEW;
    END;
    $$;
    CREATE TRIGGER reject_task_move_history BEFORE INSERT ON activity
    FOR EACH ROW EXECUTE FUNCTION reject_task_move_history();
  `);
  try {
    assert.equal(
      (
        await request(`/api/tasks/${task.id}`, {
          cookie,
          method: "PATCH",
          body: { version: task.version, status: "in_progress" },
        })
      ).status,
      500,
    );
    assert.deepEqual(
      await sql`SELECT * FROM tasks WHERE id=${task.id}`,
      before,
    );
    assert.deepEqual(
      await sql`SELECT * FROM activity ORDER BY id`,
      historyBefore,
    );
  } finally {
    await sql.unsafe("DROP TRIGGER reject_task_move_history ON activity");
    await sql.unsafe("DROP FUNCTION reject_task_move_history()");
  }
});

test("fresh activity rows require an owning task in the same board", async () => {
  const { cookie, user } = await setupUser();
  const { board: first } = await json(
    await request("/api/boards", {
      cookie,
      body: { name: "First", prefix: "FIRST" },
    }),
    201,
  );
  const { board: second } = await json(
    await request("/api/boards", {
      cookie,
      body: { name: "Second", prefix: "SECOND" },
    }),
    201,
  );
  const { task } = await json(
    await request(`/api/boards/${first.id}/tasks`, {
      cookie,
      body: { title: "Owned work" },
    }),
    201,
  );
  for (const [taskId, boardId, code] of [
    [null, first.id, "23502"],
    [task.id, null, "23502"],
    [task.id, second.id, "23503"],
  ] as const)
    await assert.rejects(
      sql.begin(
        (tx) =>
          tx`INSERT INTO activity(task_id,board_id,actor_id,actor_name,actor_kind,action) VALUES(${taskId},${boardId},${user.id},'Admin','human','task.updated')`,
      ),
      { code },
    );
  assert.equal((await sql`SELECT * FROM activity`).length, 1);
});

test("006 removes existing global history and authentication audit while preserving and binding task activity", async () => {
  const schema = `history_${randomUUID().replaceAll("-", "")}`;
  await sql.begin(async (tx) => {
    await tx.unsafe(`CREATE SCHEMA "${schema}"`);
    await tx.unsafe(`SET LOCAL search_path TO "${schema}"`);
    await tx`CREATE TABLE mill_migrations(name text PRIMARY KEY,checksum text NOT NULL,applied_at timestamptz NOT NULL DEFAULT now())`;
    for (const name of [
      "001_identity.sql",
      "002_boards.sql",
      "003_external.sql",
      "004_http.sql",
      "005_permanent_deletion.sql",
    ]) {
      const source = await readFile(
        new URL(`../packages/database/migrations/${name}`, import.meta.url),
        "utf8",
      );
      await tx.unsafe(source);
      await tx`INSERT INTO mill_migrations(name,checksum) VALUES(${name},${createHash("sha256").update(source).digest("hex")})`;
    }
    const originalMigrations =
      await tx`SELECT * FROM mill_migrations ORDER BY name`;
    const [workspace] =
      await tx`INSERT INTO workspace(id,name) VALUES(${randomUUID()},'Upgrade') RETURNING id`;
    const [user] =
      await tx`INSERT INTO users(id,workspace_id,name,email,role,password_hash) VALUES(${randomUUID()},${workspace.id},'Admin','history@example.test','admin','unused') RETURNING id`;
    const [board] =
      await tx`INSERT INTO boards(workspace_id,name,prefix,position) VALUES(${workspace.id},'Work','WORK',0) RETURNING id`;
    const [other] =
      await tx`INSERT INTO boards(workspace_id,name,prefix,position) VALUES(${workspace.id},'Other','OTHER',1) RETURNING id`;
    const [column] =
      await tx`INSERT INTO columns(board_id,name,position) VALUES(${board.id},'Backlog',0) RETURNING id`;
    const [task] =
      await tx`INSERT INTO tasks(board_id,column_id,identifier,title,position,created_by) VALUES(${board.id},${column.id},'WORK-1','Keep task history',0,${user.id}) RETURNING id`;
    await tx`INSERT INTO auth_audit(id,user_id,actor_name,action,detail) VALUES(${randomUUID()},${user.id},'Admin','account.sign-in','{}')`;
    await tx`INSERT INTO activity(board_id,actor_id,actor_name,actor_kind,action) VALUES(${board.id},${user.id},'Admin','human','board.created'),(NULL,${user.id},'Admin','human','workspace.updated'),(NULL,${user.id},'Admin','human','task.deleted')`;
    for (const [boardId, kind, action] of [
      [board.id, "human", "task.created"],
      [null, "agent", "task.updated"],
      [other.id, "human", "comment.created"],
    ] as const)
      await tx`INSERT INTO activity(task_id,board_id,actor_id,actor_name,actor_kind,action,detail,created_at) VALUES(${task.id},${boardId},${user.id},'Actor',${kind},${action},${tx.json({ fields: ["description"] })},'2026-09-29T01:02:03.123456Z')`;
    const taskEvents =
      await tx`SELECT id,task_id,actor_id,actor_name,actor_kind,action,detail,created_at FROM activity WHERE task_id IS NOT NULL ORDER BY id`;
    await tx`INSERT INTO api_idempotency(actor_key,key,request_hash,response,status) VALUES(${user.id},'retained-task-cache','unchanged-hash','{}',200)`;
    const originalRetry = await tx`SELECT * FROM api_idempotency`;
    const source = await readFile(
      new URL(
        "../packages/database/migrations/006_task_activity_only.sql",
        import.meta.url,
      ),
      "utf8",
    );
    await tx.unsafe(source);
    await tx`INSERT INTO mill_migrations(name,checksum) VALUES('006_task_activity_only.sql',${createHash("sha256").update(source).digest("hex")})`;
    assert.deepEqual(
      await tx`SELECT * FROM mill_migrations WHERE name<'006' ORDER BY name`,
      originalMigrations,
    );
    assert.equal(
      (await tx`SELECT to_regclass(${schema + ".auth_audit"}) AS relation`)[0]
        .relation,
      null,
    );
    assert.deepEqual(
      await tx`SELECT id,task_id,actor_id,actor_name,actor_kind,action,detail,created_at FROM activity ORDER BY id`,
      taskEvents,
    );
    assert.ok(
      (await tx`SELECT board_id FROM activity`).every(
        (event) => event.boardId === board.id,
      ),
    );
    assert.equal(
      (await tx`SELECT * FROM activity WHERE task_id IS NULL`).length,
      0,
    );
    assert.deepEqual(await tx`SELECT * FROM api_idempotency`, originalRetry);
    await tx.unsafe("SET LOCAL search_path TO pg_catalog");
    await tx`DELETE FROM ${tx(`${schema}.tasks`)} WHERE id=${task.id}`;
    assert.equal(
      (await tx`SELECT * FROM ${tx(`${schema}.activity`)}`).length,
      0,
    );
    await tx.unsafe(`DROP SCHEMA "${schema}" CASCADE`);
  });
});

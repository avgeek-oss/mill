import assert from "node:assert/strict";
import { after, beforeEach, test } from "node:test";
import { randomUUID } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import type { Task } from "../packages/contracts/src/index.js";
import {
  callMcpTool,
  cleanupDatabase,
  request,
  resetDatabase,
  setupOAuth,
  setupUser,
  sql,
} from "./support.js";

beforeEach(resetDatabase);
after(cleanupDatabase);

async function json(response: Response, status = 200) {
  assert.equal(response.status, status, await response.clone().text());
  return response.json();
}

async function setup() {
  const { cookie } = await setupUser();
  const { board } = await json(
    await request("/api/boards", {
      cookie,
      body: { name: "Acceptance criteria", prefix: "AC" },
    }),
    201,
  );
  return { cookie, board };
}

test("REST persists separate Markdown criteria, creation properties, independent edits and searchable content", async () => {
  const { cookie, board } = await setup();
  const created = await json(
    await request(`/api/boards/${board.id}/tasks`, {
      cookie,
      body: {
        title: "Review the release",
        description: "Release notes remain separate.",
        acceptanceCriteria: "- **Keyboard review** passes\n- Unicode: ✓",
        type: "bug",
        priority: "urgent",
        status: "in_review",
      },
    }),
    201,
  );
  let task: Task = created.task;
  assert.equal(task.description, "Release notes remain separate.");
  assert.equal(
    task.acceptanceCriteria,
    "- **Keyboard review** passes\n- Unicode: ✓",
  );
  assert.equal(task.type, "bug");
  assert.equal(task.priority, "urgent");
  assert.equal(task.status, "in_review");
  const detail = await json(await request(`/api/tasks/${task.id}`, { cookie }));
  assert.equal(detail.task.acceptanceCriteria, task.acceptanceCriteria);
  const results = await json(
    await request(`/api/boards/${board.id}/tasks?q=Keyboard%20review`, {
      cookie,
    }),
  );
  assert.deepEqual(
    results.items.map((item: Task) => item.id),
    [task.id],
  );
  const version = task.version;
  task = (
    await json(
      await request(`/api/tasks/${task.id}`, {
        cookie,
        method: "PATCH",
        body: { version, acceptanceCriteria: "- Final review passes" },
      }),
    )
  ).task;
  assert.equal(task.description, "Release notes remain separate.");
  assert.equal(task.acceptanceCriteria, "- Final review passes");
  assert.equal(task.version, version + 1);
  assert.equal(
    (
      await request(`/api/tasks/${task.id}`, {
        cookie,
        method: "PATCH",
        body: { version, acceptanceCriteria: "Stale edit" },
      })
    ).status,
    409,
  );
  task = (
    await json(
      await request(`/api/tasks/${task.id}`, {
        cookie,
        method: "PATCH",
        body: { version: task.version, description: "Revised release notes" },
      }),
    )
  ).task;
  assert.equal(task.acceptanceCriteria, "- Final review passes");
  task = (
    await json(
      await request(`/api/tasks/${task.id}`, {
        cookie,
        method: "PATCH",
        body: { version: task.version, acceptanceCriteria: "" },
      }),
    )
  ).task;
  assert.equal(task.description, "Revised release notes");
  assert.equal(task.acceptanceCriteria, "");
  const [stored] =
    await sql`SELECT acceptance_criteria,description FROM tasks WHERE id=${task.id}`;
  assert.equal(stored.acceptanceCriteria, "");
  assert.equal(stored.description, "Revised release notes");
  const history = await json(
    await request(`/api/tasks/${task.id}/activity`, { cookie }),
  );
  assert.ok(
    history.items.some((item: { detail: { fields?: string[] } }) =>
      item.detail.fields?.includes("acceptanceCriteria"),
    ),
  );
  const minimal = await json(
    await request(`/api/boards/${board.id}/tasks`, {
      cookie,
      body: { title: "Minimal task" },
    }),
    201,
  );
  assert.equal(minimal.task.acceptanceCriteria, "");
  assert.equal(minimal.task.status, "todo");
  assert.equal(minimal.task.priority, "none");
  for (const invalid of [null, 123, {}, "x".repeat(100001)]) {
    assert.equal(
      (
        await request(`/api/boards/${board.id}/tasks`, {
          cookie,
          body: { title: "Invalid criteria", acceptanceCriteria: invalid },
        })
      ).status,
      400,
    );
    assert.equal(
      (
        await request(`/api/tasks/${task.id}`, {
          cookie,
          method: "PATCH",
          body: { version: task.version, acceptanceCriteria: invalid },
        })
      ).status,
      400,
    );
  }
  const boundary = await json(
    await request(`/api/boards/${board.id}/tasks`, {
      cookie,
      body: {
        title: "Maximum criteria",
        acceptanceCriteria: "✓".repeat(100000),
      },
    }),
    201,
  );
  assert.equal(boundary.task.acceptanceCriteria.length, 100000);
  const [owner] =
    await sql`SELECT id,workspace_id FROM users WHERE role='admin'`;
  const reviewerId = randomUUID();
  await sql`INSERT INTO users(id,workspace_id,name,email,role,password_hash) VALUES(${reviewerId},${owner.workspaceId},'Reviewer','reviewer@example.test','viewer','unused')`;
  task = (
    await json(
      await request(`/api/tasks/${task.id}`, {
        cookie,
        method: "PATCH",
        body: {
          version: task.version,
          acceptanceCriteria: "- Ask @reviewer@example.test to review.",
        },
      }),
    )
  ).task;
  const [mentioned] =
    await sql`SELECT count(*)::int AS count FROM notifications WHERE task_id=${task.id} AND user_id=${reviewerId} AND kind='mention'`;
  assert.equal(mentioned.count, 1);
  task = (
    await json(
      await request(`/api/tasks/${task.id}`, {
        cookie,
        method: "PATCH",
        body: {
          version: task.version,
          description: "Coordinate with @reviewer@example.test.",
        },
      }),
    )
  ).task;
  const [notRepeated] =
    await sql`SELECT count(*)::int AS count FROM notifications WHERE task_id=${task.id} AND user_id=${reviewerId} AND kind='mention'`;
  assert.equal(notRepeated.count, 1);
  await sql`UPDATE users SET role='viewer' WHERE id=${owner.id}`;
  assert.equal(
    (
      await request(`/api/tasks/${task.id}`, {
        cookie,
        method: "PATCH",
        body: {
          version: task.version,
          acceptanceCriteria: "Viewer edit denied",
        },
      })
    ).status,
    403,
  );
  const [protectedTask] =
    await sql`SELECT acceptance_criteria FROM tasks WHERE id=${task.id}`;
  assert.equal(
    protectedTask.acceptanceCriteria,
    "- Ask @reviewer@example.test to review.",
  );
});

test("MCP creates and updates criteria under its write grant and rejects invalid or read-only writes", async () => {
  const { cookie, board } = await setup();
  const writer = await setupOAuth(cookie, { accessLevel: "write" });
  const create = await callMcpTool(writer.token, "create_task", {
    boardId: board.id,
    title: "MCP criteria",
    acceptanceCriteria: "- Client behavior is verified",
  });
  assert.equal(create.result?.isError, false, JSON.stringify(create.result));
  const { task } = create.result!.structuredContent as { task: Task };
  assert.equal(task.acceptanceCriteria, "- Client behavior is verified");
  const updated = await callMcpTool(writer.token, "update_task", {
    taskId: task.id,
    version: task.version,
    acceptanceCriteria: "- Updated independently",
  });
  assert.equal(updated.result?.isError, false, JSON.stringify(updated.result));
  const saved = (updated.result!.structuredContent as { task: Task }).task;
  assert.equal(saved.acceptanceCriteria, "- Updated independently");
  assert.equal(saved.description, "");
  const reader = await setupOAuth(cookie, { accessLevel: "read" });
  const denied = await callMcpTool(reader.token, "update_task", {
    taskId: task.id,
    version: saved.version,
    acceptanceCriteria: "Denied",
  });
  assert.equal(denied.response.status, 403);
  const invalid = await callMcpTool(writer.token, "create_task", {
    boardId: board.id,
    title: "Invalid",
    acceptanceCriteria: "x".repeat(100001),
  });
  assert.ok(invalid.result?.isError || invalid.response.status >= 400);
  const [stored] =
    await sql`SELECT acceptance_criteria FROM tasks WHERE id=${task.id}`;
  assert.equal(stored.acceptanceCriteria, "- Updated independently");
});

test("the forward migration preserves existing descriptions and task state while tracking criteria activity", async () => {
  const schema = `acceptance_${randomUUID().replaceAll("-", "")}`;
  const directory = new URL(
    "../packages/database/migrations/",
    import.meta.url,
  );
  await sql.unsafe(`CREATE SCHEMA "${schema}"`);
  try {
    await sql.begin(async (tx) => {
      await tx.unsafe(`SET LOCAL search_path TO "${schema}"`);
      const names = (await readdir(directory))
        .filter((name) => name.endsWith(".sql"))
        .sort();
      for (const name of names.filter((name) => name < "008_"))
        await tx.unsafe(await readFile(new URL(name, directory), "utf8"));
      const [workspace] =
        await tx`INSERT INTO workspace(id,name) VALUES(${randomUUID()},'Upgrade') RETURNING id`;
      const [user] =
        await tx`INSERT INTO users(id,workspace_id,name,email,role,password_hash) VALUES(${randomUUID()},${workspace.id},'Admin','upgrade@example.test','admin','unused') RETURNING id`;
      const [board] =
        await tx`INSERT INTO boards(workspace_id,name,prefix) VALUES(${workspace.id},'Upgrade','UP') RETURNING id`;
      const description =
        "Existing text\n\n### Acceptance criteria\n- Existing embedded content stays intact";
      const [before] =
        await tx`INSERT INTO tasks(board_id,identifier,title,description,created_by) VALUES(${board.id},'UP-1','Existing task',${description},${user.id}) RETURNING *`;
      await tx.unsafe(
        await readFile(
          new URL("008_task_acceptance_criteria.sql", directory),
          "utf8",
        ),
      );
      const [after] = await tx`SELECT * FROM tasks WHERE id=${before.id}`;
      assert.equal(after.acceptanceCriteria, "");
      assert.equal(after.description, description);
      assert.equal(after.version, before.version);
      assert.equal(after.updatedAt.getTime(), before.updatedAt.getTime());
      assert.equal(
        after.statusChangedAt.getTime(),
        before.statusChangedAt.getTime(),
      );
      await tx`UPDATE boards SET last_activity_at='2020-01-01' WHERE id=${board.id}`;
      await tx`UPDATE tasks SET acceptance_criteria='Independent criteria' WHERE id=${before.id}`;
      const [changed] =
        await tx`SELECT last_activity_at FROM boards WHERE id=${board.id}`;
      assert.ok(
        changed.lastActivityAt.getTime() > new Date("2020-01-01").getTime(),
      );
      await tx`UPDATE boards SET last_activity_at='2021-01-01' WHERE id=${board.id}`;
      await tx`UPDATE tasks SET acceptance_criteria='Independent criteria',version=version+1 WHERE id=${before.id}`;
      const [unchanged] =
        await tx`SELECT last_activity_at FROM boards WHERE id=${board.id}`;
      assert.equal(
        unchanged.lastActivityAt.toISOString(),
        "2021-01-01T00:00:00.000Z",
      );
    });
  } finally {
    await sql.unsafe(`DROP SCHEMA "${schema}" CASCADE`);
  }
});

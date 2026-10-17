import { after, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import postgres from "postgres";
import {
  cleanupDatabase,
  request,
  resetDatabase,
  setupUser,
  sql,
} from "./support.js";
import type { BoardSummary } from "../packages/contracts/src/index.js";

beforeEach(resetDatabase);
after(cleanupDatabase);

async function json(response: Response, status = 200) {
  assert.equal(response.status, status, await response.clone().text());
  return response.json();
}

async function board(cookie: string) {
  return (
    await json(
      await request("/api/boards", {
        cookie,
        body: { name: "Product", prefix: "PRD" },
      }),
      201,
    )
  ).board;
}

async function summary(cookie: string): Promise<BoardSummary> {
  return (await json(await request("/api/boards", { cookie }))).items[0];
}

const oldActivity = "2001-01-01T00:00:00.000Z";
async function age(id: string) {
  await sql`UPDATE boards SET last_activity_at=${oldActivity} WHERE id=${id}`;
}
async function lastActivity(id: string) {
  const [row] = await sql`SELECT last_activity_at FROM boards WHERE id=${id}`;
  return row.lastActivityAt.toISOString();
}

test("board creators come from authenticated people and preserve identity after profile changes", async () => {
  const { cookie, user, body } = await setupUser();
  const created = await board(cookie);
  assert.deepEqual((await summary(cookie)).createdBy, {
    id: user.id,
    name: user.name,
    email: user.email,
    kind: "human",
  });
  await age(created.id);
  await sql`UPDATE users SET name='Renamed person' WHERE id=${user.id}`;
  assert.equal((await summary(cookie)).createdBy?.name, "Renamed person");
  assert.equal(await lastActivity(created.id), oldActivity);
  await sql`INSERT INTO boards(workspace_id,name,prefix) VALUES(${body.workspace.id},'Unknown history','OLD')`;
  const list = await json(await request("/api/boards", { cookie }));
  assert.equal(
    list.items.find((item: BoardSummary) => item.prefix === "OLD").createdBy,
    null,
  );
});

test("team API keys identify the team key instead of attributing creation to its issuer", async () => {
  const { cookie } = await setupUser();
  const key = await json(
    await request("/api/team-credentials", {
      cookie,
      body: {
        name: "Release automation",
        access: "edit",
        includeAdmin: false,
        expiresAt: null,
      },
    }),
    201,
  );
  await json(
    await request("/api/boards", {
      token: key.token,
      body: { name: "Release work", prefix: "REL" },
    }),
    201,
  );
  assert.deepEqual((await summary(cookie)).createdBy, {
    id: null,
    name: "Team API key: Release automation",
    email: null,
    kind: "team",
  });
});

test("board and task edits advance activity, while reads, unchanged values and rolled-back writes do not", async () => {
  const { cookie } = await setupUser();
  const created = await board(cookie);
  await age(created.id);
  await json(await request(`/api/boards/${created.id}`, { cookie }));
  await json(
    await request(`/api/boards/${created.id}`, {
      cookie,
      method: "PATCH",
      body: { version: 1, name: "Product" },
    }),
  );
  assert.equal(await lastActivity(created.id), oldActivity);
  await json(
    await request(`/api/boards/${created.id}`, {
      cookie,
      method: "PATCH",
      body: { version: 2, description: "New description" },
    }),
  );
  assert.ok((await lastActivity(created.id)) > oldActivity);
  await age(created.id);
  const task = (
    await json(
      await request(`/api/boards/${created.id}/tasks`, {
        cookie,
        body: { title: "Review release" },
      }),
      201,
    )
  ).task;
  assert.ok((await lastActivity(created.id)) > oldActivity);
  await age(created.id);
  await json(
    await request(`/api/tasks/${task.id}`, {
      cookie,
      method: "PATCH",
      body: { version: task.version, title: task.title },
    }),
  );
  assert.equal(await lastActivity(created.id), oldActivity);
  await json(
    await request(`/api/tasks/${task.id}`, {
      cookie,
      method: "PATCH",
      body: { version: task.version + 1, status: "in_progress" },
    }),
  );
  assert.ok((await lastActivity(created.id)) > oldActivity);
  await age(created.id);
  await assert.rejects(
    sql.begin(async (tx) => {
      await tx`UPDATE tasks SET title='Rolled back' WHERE id=${task.id}`;
      throw new Error("rollback");
    }),
    /rollback/,
  );
  assert.equal(await lastActivity(created.id), oldActivity);
  const stale = await request(`/api/tasks/${task.id}`, {
    cookie,
    method: "PATCH",
    body: { version: 1, title: "Stale edit" },
  });
  assert.equal(stale.status, 409);
  assert.equal(await lastActivity(created.id), oldActivity);
});

test("comment and task deletions leave durable board activity after their history is removed", async () => {
  const { cookie } = await setupUser();
  const created = await board(cookie);
  const task = (
    await json(
      await request(`/api/boards/${created.id}/tasks`, {
        cookie,
        body: { title: "Review release" },
      }),
      201,
    )
  ).task;
  await age(created.id);
  const comment = (
    await json(
      await request(`/api/tasks/${task.id}/comments`, {
        cookie,
        body: { body: "Ready for review" },
      }),
      201,
    )
  ).comment;
  assert.ok((await lastActivity(created.id)) > oldActivity);
  await age(created.id);
  await json(
    await request(`/api/comments/${comment.id}`, {
      cookie,
      method: "DELETE",
      body: { version: comment.version },
    }),
  );
  assert.ok((await lastActivity(created.id)) > oldActivity);
  await age(created.id);
  await json(
    await request(`/api/tasks/${task.id}`, {
      cookie,
      method: "DELETE",
      body: { version: task.version },
    }),
  );
  assert.ok((await lastActivity(created.id)) > oldActivity);
  assert.equal(
    (await summary(cookie)).lastActivityAt,
    await lastActivity(created.id),
  );
  const [state] =
    await sql`SELECT (SELECT count(*)::int FROM tasks) AS tasks,(SELECT count(*)::int FROM activity) AS activity`;
  assert.deepEqual(state, { tasks: 0, activity: 0 });
});

test("only published attachment changes advance board activity", async () => {
  const { cookie, user } = await setupUser();
  const created = await board(cookie);
  const task = (
    await json(
      await request(`/api/boards/${created.id}/tasks`, {
        cookie,
        body: { title: "Review release" },
      }),
      201,
    )
  ).task;
  await age(created.id);
  const [attachment] = await sql`
    INSERT INTO task_attachments(id,task_id,file_name,content_type,size_bytes,storage_origin,storage_bucket,upload_key,object_key,upload_expires_at,created_by)
    VALUES(gen_random_uuid(),${task.id},'example.png','image/png',100,'http://localhost:9000','local-fixture','upload/example','objects/example',now()+interval '1 hour',${user.id}) RETURNING id`;
  assert.equal(await lastActivity(created.id), oldActivity);
  await sql`UPDATE task_attachments SET state='ready' WHERE id=${attachment.id}`;
  assert.ok((await lastActivity(created.id)) > oldActivity);
  await age(created.id);
  await sql`DELETE FROM task_attachments WHERE id=${attachment.id}`;
  assert.ok((await lastActivity(created.id)) > oldActivity);
});

test("upgrading existing boards preserves records and backfills activity without guessing a creator", async () => {
  const schema = `${process.env.MILL_DB_SCHEMA}_upgrade`;
  const admin = postgres(process.env.DATABASE_URL!, {
    max: 1,
    onnotice: () => {},
  });
  await admin`CREATE SCHEMA ${admin(schema)}`;
  const db = postgres(process.env.DATABASE_URL!, {
    max: 1,
    connection: { search_path: schema },
    onnotice: () => {},
  });
  try {
    const folder = new URL("../packages/database/migrations/", import.meta.url);
    const names = (await readdir(folder))
      .filter((name) => name.endsWith(".sql"))
      .sort();
    for (const name of names.filter((name) => name < "006_"))
      await db.unsafe(await readFile(new URL(name, folder), "utf8"));
    const [workspace] =
      await db`INSERT INTO workspace(id,name) VALUES(gen_random_uuid(),'Existing workspace') RETURNING id`;
    const [person] =
      await db`INSERT INTO users(id,workspace_id,name,email,password_hash,role) VALUES(gen_random_uuid(),${workspace.id},'Existing person','existing@example.test','unused','admin') RETURNING id`;
    const [existing] =
      await db`INSERT INTO boards(workspace_id,name,prefix,created_at,updated_at) VALUES(${workspace.id},'Existing board','OLD','2020-01-01','2020-01-02') RETURNING id`;
    const [task] =
      await db`INSERT INTO tasks(board_id,identifier,title,created_by,created_at,updated_at) VALUES(${existing.id},'OLD-1','Existing task',${person.id},'2020-01-03','2020-01-04') RETURNING id`;
    await db`INSERT INTO comments(task_id,author_id,body,created_at,updated_at) VALUES(${task.id},${person.id},'Existing comment','2020-01-05','2020-01-05')`;
    await db.unsafe(
      await readFile(new URL("006_board_metadata.sql", folder), "utf8"),
    );
    const [upgraded] =
      await db`SELECT name,created_by_user_id,created_by_name,last_activity_at FROM boards WHERE id=${existing.id}`;
    assert.equal(upgraded.name, "Existing board");
    assert.equal(upgraded.created_by_user_id, null);
    assert.equal(upgraded.created_by_name, null);
    assert.equal(
      upgraded.last_activity_at.toISOString(),
      "2020-01-05T00:00:00.000Z",
    );
    assert.equal((await db`SELECT * FROM comments`).length, 1);
  } finally {
    await db.end();
    await admin`DROP SCHEMA ${admin(schema)} CASCADE`;
    await admin.end();
  }
});

import { after, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
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
async function fixture() {
  const owner = await setupUser();
  const { board } = await json(
    await request("/api/boards", {
      cookie: owner.cookie,
      body: { name: "Notification scope", prefix: "NTF" },
    }),
    201,
  );
  const { task } = await json(
    await request(`/api/boards/${board.id}/tasks`, {
      cookie: owner.cookie,
      body: { title: "Retained notification history" },
    }),
    201,
  );
  return { ...owner, board, task };
}
async function notice(
  userId: string,
  taskId: string,
  readAt: string | null = null,
) {
  const [row] =
    await sql`INSERT INTO notifications(user_id,task_id,kind,actor_name,read_at) VALUES (${userId},${taskId},'mention','Teammate',${readAt}) RETURNING id`;
  return row.id as string;
}
async function mark(
  cookie: string,
  body: Record<string, unknown>,
  retry?: string,
) {
  return json(
    await request("/api/notifications", {
      cookie,
      method: "PATCH",
      body,
      ...(retry ? { headers: { "Idempotency-Key": retry } } : {}),
    }),
  );
}

test("all unread notifications remain reachable with tied timestamps and page-independent totals", async () => {
  const owner = await fixture();
  await sql`INSERT INTO notifications(user_id,task_id,kind,actor_name,created_at) SELECT ${owner.user.id},${owner.task.id},'mention','Teammate',timestamptz '2000-01-01T00:00:00.000003Z' FROM generate_series(1,127)`;
  const ids: string[] = [];
  let cursor: string | null = null;
  do {
    const page = await json(
      await request(
        `/api/notifications?limit=17${cursor ? "&cursor=" + cursor : ""}`,
        { cookie: owner.cookie },
      ),
    );
    assert.equal(page.unreadCount, 127);
    assert.ok(page.items.length <= 17);
    assert.ok(
      page.items.every((row: { readAt: unknown }) => row.readAt === null),
    );
    ids.push(...page.items.map((row: { id: string }) => row.id));
    assert.ok(ids.length <= 127, "cursor must make progress");
    cursor = page.nextCursor;
  } while (cursor);
  assert.equal(ids.length, 127);
  assert.equal(new Set(ids).size, 127);
  const stored =
    await sql`SELECT id FROM notifications ORDER BY created_at DESC,id DESC`;
  assert.deepEqual(
    ids,
    stored.map((row) => row.id),
  );
  assert.equal((await mark(owner.cookie, { all: true })).updated, 127);
  assert.equal((await mark(owner.cookie, { all: true })).updated, 0);
  assert.equal(
    (
      await json(
        await request("/api/notifications?limit=1", { cookie: owner.cookie }),
      )
    ).unreadCount,
    0,
  );
  assert.equal(
    (await sql`SELECT count(*)::int AS count FROM notifications`)[0].count,
    127,
  );
});

test("read retention uses readAt and keeps expired history available for stable cursor anchors", async () => {
  const owner = await fixture();
  const oldUnread = await notice(owner.user.id, owner.task.id);
  const recent = await notice(owner.user.id, owner.task.id);
  const expired = await notice(owner.user.id, owner.task.id);
  await sql`UPDATE notifications SET created_at='2000-01-01T00:00:00Z' WHERE id=${oldUnread}`;
  await sql`UPDATE notifications SET created_at='2000-01-01T00:00:00Z',read_at=now()-interval '23 hours' WHERE id=${recent}`;
  await sql`UPDATE notifications SET read_at=now()-interval '25 hours' WHERE id=${expired}`;
  const page = await json(
    await request("/api/notifications?limit=1", { cookie: owner.cookie }),
  );
  assert.equal(page.unreadCount, 1);
  assert.equal(page.items.length, 1);
  assert.ok([recent, oldUnread].includes(page.items[0].id));
  const anchor = page.nextCursor;
  assert.ok(anchor);
  await sql`UPDATE notifications SET read_at=now()-interval '25 hours' WHERE id=${anchor}`;
  const next = await json(
    await request(`/api/notifications?limit=1&cursor=${anchor}`, {
      cookie: owner.cookie,
    }),
  );
  assert.equal(next.items.length, 1);
  assert.notEqual(next.items[0].id, anchor);
  assert.equal(next.nextCursor, null);
  assert.equal(
    (await sql`SELECT count(*)::int AS count FROM notifications`)[0].count,
    3,
  );
});

test("notification count and items share a snapshot when an arrival races the read", async () => {
  const owner = await fixture();
  const first = await notice(owner.user.id, owner.task.id);
  const lockKey = parseInt(randomUUID().slice(0, 7), 16);
  await sql.begin(async (tx) => {
    await tx`ALTER TABLE notifications RENAME TO notification_snapshot_rows`;
    await tx.unsafe(`
      CREATE FUNCTION notification_snapshot_gate() RETURNS boolean
      LANGUAGE plpgsql VOLATILE AS $$
        BEGIN
          PERFORM pg_advisory_xact_lock(${lockKey});
          RETURN true;
        END
      $$`);
    await tx`CREATE VIEW notifications AS SELECT * FROM notification_snapshot_rows WHERE notification_snapshot_gate()`;
  });
  let unlock!: () => void;
  let locked!: () => void;
  const ready = new Promise<void>((resolve) => {
    locked = resolve;
  });
  const release = new Promise<void>((resolve) => {
    unlock = resolve;
  });
  const blocker = sql.begin(async (tx) => {
    await tx`SELECT pg_advisory_xact_lock(${lockKey})`;
    locked();
    await release;
  });
  let pending: Promise<Response> | undefined;
  try {
    await ready;
    pending = request("/api/notifications?unread=true", {
      cookie: owner.cookie,
    });
    const deadline = Date.now() + 5000;
    let waiting = false;
    while (Date.now() < deadline) {
      const rows = await sql`
        SELECT pid FROM pg_stat_activity
        WHERE pid<>pg_backend_pid() AND wait_event='advisory'
          AND query LIKE '%notifications%'
          AND EXISTS (
            SELECT 1 FROM pg_locks
            WHERE pg_locks.pid=pg_stat_activity.pid
              AND locktype='advisory' AND objid=${lockKey} AND NOT granted
          )`;
      if (rows.length) {
        waiting = true;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.ok(waiting, "notification read must establish its snapshot first");
    await sql`INSERT INTO notification_snapshot_rows(user_id,task_id,kind,actor_name) VALUES (${owner.user.id},${owner.task.id},'mention','Arriving teammate')`;
    unlock();
    await blocker;
    const page = await json(await pending);
    assert.equal(page.unreadCount, 1);
    assert.deepEqual(
      page.items.map((row: { id: string }) => row.id),
      [first],
    );
    assert.equal(page.hasMore, false);
    assert.equal(page.nextCursor, null);
    assert.equal("unreadCount" in page.items[0], false);
    assert.equal("anchorValid" in page.items[0], false);
    const next = await json(
      await request("/api/notifications?unread=true", { cookie: owner.cookie }),
    );
    assert.equal(next.unreadCount, 2);
    assert.equal(next.items.length, 2);
  } finally {
    unlock();
    await blocker;
    await pending?.catch(() => {});
    await sql.begin(async (tx) => {
      await tx`DROP VIEW notifications`;
      await tx`ALTER TABLE notification_snapshot_rows RENAME TO notifications`;
      await tx`DROP FUNCTION notification_snapshot_gate()`;
    });
  }
});

test("mark-all preserves original receipts, isolates users and replays without consuming new arrivals", async () => {
  const owner = await fixture();
  const invitation = await json(
    await request("/api/auth/invitations", {
      cookie: owner.cookie,
      body: { email: "other@example.test", role: "viewer" },
    }),
    201,
  );
  const accepted = await request("/api/auth/accept-invitation", {
    body: {
      token: invitation.token,
      name: "Other member",
      password: "Another secure passphrase 42!",
    },
  });
  const other = (await json(accepted, 201)).user;
  const otherCookie = accepted.headers.get("set-cookie")!.split(";")[0];
  const first = await notice(owner.user.id, owner.task.id);
  const read = await notice(owner.user.id, owner.task.id);
  await sql`UPDATE notifications SET read_at=now()-interval '2 hours' WHERE id=${read}`;
  const original = (
    await sql`SELECT read_at FROM notifications WHERE id=${read}`
  )[0].readAt;
  const foreign = await notice(other.id, owner.task.id);
  assert.equal(
    (
      await request("/api/notifications", {
        cookie: owner.cookie,
        method: "PATCH",
        body: { ids: [first, foreign] },
      })
    ).status,
    403,
  );
  assert.equal(
    (
      await request(`/api/notifications?cursor=${foreign}`, {
        cookie: owner.cookie,
      })
    ).status,
    400,
  );
  assert.equal(
    (
      await request("/api/notifications", {
        cookie: otherCookie,
        method: "DELETE",
      })
    ).status,
    404,
  );
  const key = randomUUID();
  assert.equal((await mark(owner.cookie, { all: true }, key)).updated, 1);
  const arrival = await notice(owner.user.id, owner.task.id);
  const replay = await request("/api/notifications", {
    cookie: owner.cookie,
    method: "PATCH",
    body: { all: true },
    headers: { "Idempotency-Key": key },
  });
  assert.equal(replay.headers.get("idempotency-replayed"), "true");
  await json(replay);
  const receipts = await sql`SELECT id,read_at FROM notifications ORDER BY id`;
  assert.deepEqual(receipts.find((row) => row.id === read)?.readAt, original);
  assert.equal(receipts.find((row) => row.id === foreign)?.readAt, null);
  assert.equal(receipts.find((row) => row.id === arrival)?.readAt, null);
  const firstRead = receipts.find((row) => row.id === first)?.readAt;
  assert.equal((await mark(owner.cookie, { ids: [first] })).updated, 0);
  assert.deepEqual(
    (await sql`SELECT read_at FROM notifications WHERE id=${first}`)[0].readAt,
    firstRead,
  );
  assert.equal(
    (await json(await request("/api/notifications", { cookie: owner.cookie })))
      .unreadCount,
    1,
  );
  assert.equal(
    (await json(await request("/api/notifications", { cookie: otherCookie })))
      .unreadCount,
    1,
  );
  assert.equal(
    (await sql`SELECT count(*)::int AS count FROM notifications`)[0].count,
    4,
  );
});

test("mark-all statement snapshot excludes notifications arriving while its row lock waits", async () => {
  const owner = await fixture();
  const first = await notice(owner.user.id, owner.task.id);
  let unlock!: () => void;
  let locked!: () => void;
  const ready = new Promise<void>((resolve) => {
    locked = resolve;
  });
  const release = new Promise<void>((resolve) => {
    unlock = resolve;
  });
  const blocker = sql.begin(async (tx) => {
    await tx`SELECT id FROM notifications WHERE id=${first} FOR UPDATE`;
    locked();
    await release;
  });
  await ready;
  const pending = mark(owner.cookie, { all: true });
  let arrival: string | undefined;
  try {
    const deadline = Date.now() + 5000;
    let waiting = false;
    while (Date.now() < deadline) {
      const rows =
        await sql`SELECT pid FROM pg_stat_activity WHERE pid<>pg_backend_pid() AND wait_event_type='Lock' AND query LIKE '%UPDATE notifications SET read_at=%' AND query LIKE '%SELECT count(*)::int AS updated FROM marked%' AND EXISTS (SELECT 1 FROM pg_locks WHERE pg_locks.pid=pg_stat_activity.pid AND relation='notifications'::regclass)`;
      if (rows.length) {
        waiting = true;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.ok(
      waiting,
      "mark-all must reach its locked snapshot before insertion",
    );
    arrival = await notice(owner.user.id, owner.task.id);
  } finally {
    unlock();
    await blocker;
  }
  assert.equal((await pending).updated, 1);
  const rows = await sql`SELECT id,read_at FROM notifications`;
  assert.notEqual(rows.find((row) => row.id === first)?.readAt, null);
  assert.equal(rows.find((row) => row.id === arrival)?.readAt, null);
  assert.equal(
    (await json(await request("/api/notifications", { cookie: owner.cookie })))
      .unreadCount,
    1,
  );
});

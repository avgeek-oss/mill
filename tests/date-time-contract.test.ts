import { after, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import postgres from "postgres";
import {
  cleanupDatabase,
  request,
  resetDatabase,
  setupUser,
  sql,
} from "./support.js";
import {
  dateFormatSchema,
  timeFormatSchema,
} from "../apps/api/src/auth/model.js";

beforeEach(resetDatabase);
after(cleanupDatabase);
const dates = [
  "day-short-month-year",
  "short-month-day-year",
  "year-month-day",
  "day-month-year",
  "month-day-year",
] as const;
const times = [
  "24-hour",
  "12-hour",
  "24-hour-seconds",
  "12-hour-seconds",
] as const;

test("setup and identity-bound profile persistence accept every common display choice without resetting omitted preferences", async () => {
  assert.deepEqual(dateFormatSchema.options, dates);
  assert.deepEqual(timeFormatSchema.options, times);
  const account = await setupUser({
    dateFormat: "short-month-day-year",
    timeFormat: "12-hour-seconds",
    timeZone: "Asia/Kathmandu",
  });
  assert.equal(account.user.dateFormat, "short-month-day-year");
  assert.equal(account.user.timeFormat, "12-hour-seconds");
  for (const dateFormat of dates)
    for (const timeFormat of times) {
      const changed = await request("/api/auth/profile", {
        method: "PATCH",
        cookie: account.cookie,
        body: { dateFormat, timeFormat },
      });
      assert.equal(changed.status, 200);
      const { user } = await changed.json();
      assert.equal(user.dateFormat, dateFormat);
      assert.equal(user.timeFormat, timeFormat);
      assert.equal(user.timeZone, "Asia/Kathmandu");
      const [stored] =
        await sql`SELECT date_format,time_format,time_zone FROM users WHERE id=${account.user.id}`;
      assert.equal(stored.dateFormat, dateFormat);
      assert.equal(stored.timeFormat, timeFormat);
      assert.equal(stored.timeZone, "Asia/Kathmandu");
    }
  const before = (
    await (await request("/api/auth/me", { cookie: account.cookie })).json()
  ).user;
  for (const body of [
    { dateFormat: "invented" },
    { timeFormat: "12-hour-millis" },
    { timeZone: "+05:30" },
    { timeZone: "-03:00" },
  ]) {
    assert.equal(
      (
        await request("/api/auth/profile", {
          method: "PATCH",
          cookie: account.cookie,
          body,
        })
      ).status,
      400,
    );
  }
  assert.equal(
    (
      await request("/api/auth/profile", {
        method: "PATCH",
        body: { timeFormat: "24-hour-seconds" },
      })
    ).status,
    401,
  );
  const renamed = await request("/api/auth/profile", {
    method: "PATCH",
    cookie: account.cookie,
    body: { name: "Renamed owner" },
  });
  assert.equal(renamed.status, 200);
  const user = (await renamed.json()).user;
  assert.equal(user.dateFormat, before.dateFormat);
  assert.equal(user.timeFormat, before.timeFormat);
  assert.equal(user.timeZone, before.timeZone);
  await assert.rejects(
    sql`UPDATE users SET date_format='invented' WHERE id=${account.user.id}`,
    { code: "23514" },
  );
  await assert.rejects(
    sql`UPDATE users SET time_format='invented' WHERE id=${account.user.id}`,
    { code: "23514" },
  );
});

test("historically accepted offset zones survive reads and unrelated profile saves while fresh offsets are rejected", async () => {
  const account = await setupUser();
  await sql`UPDATE users SET time_zone='+05:30' WHERE id=${account.user.id}`;
  const read = await request("/api/auth/me", { cookie: account.cookie });
  assert.equal(read.status, 200);
  assert.equal((await read.json()).user.timeZone, "+05:30");
  for (const body of [
    { name: "Retained timezone" },
    { dateFormat: "short-month-day-year", timeFormat: "12-hour-seconds" },
  ]) {
    const changed = await request("/api/auth/profile", {
      method: "PATCH",
      cookie: account.cookie,
      body,
    });
    assert.equal(changed.status, 200);
    assert.equal((await changed.json()).user.timeZone, "+05:30");
    const [stored] =
      await sql`SELECT time_zone FROM users WHERE id=${account.user.id}`;
    assert.equal(stored.timeZone, "+05:30");
  }
  assert.equal(
    (
      await request("/api/auth/profile", {
        method: "PATCH",
        cookie: account.cookie,
        body: { timeZone: "+05:30" },
      })
    ).status,
    400,
  );
  assert.equal(
    (await (await request("/api/auth/me", { cookie: account.cookie })).json())
      .user.timeZone,
    "+05:30",
  );
});

test("default display preferences remain the common first date, 24-hour time, and UTC", async () => {
  const { user } = await setupUser();
  assert.equal(user.dateFormat, "day-short-month-year");
  assert.equal(user.timeFormat, "24-hour");
  assert.equal(user.timeZone, "UTC");
});

test("exact preceding schema conversion preserves every existing display choice and task calendar dates", async () => {
  const baseline = await readFile(
    new URL("../packages/database/migrations/001_initial.sql", import.meta.url),
    "utf8",
  );
  const previousBaseline = baseline
    .replace(
      "CHECK (date_format IN ('day-short-month-year','short-month-day-year','year-month-day','day-month-year','month-day-year'))",
      "CHECK (date_format IN ('day-short-month-year','day-month-year','month-day-year','year-month-day'))",
    )
    .replace(
      "CHECK (time_format IN ('24-hour','12-hour','24-hour-seconds','12-hour-seconds'))",
      "CHECK (time_format IN ('24-hour','12-hour'))",
    );
  const expected = JSON.parse(
    await readFile(
      new URL(
        "../tools/prelaunch-display-preferences-layout.json",
        import.meta.url,
      ),
      "utf8",
    ),
  );
  assert.equal(
    createHash("sha256").update(previousBaseline).digest("hex"),
    expected.migrations[0].checksum,
  );
  const { schemaLayout, rebasePrelaunch } = await import(
    new URL("../tools/rebase-prelaunch.mjs", import.meta.url).href
  );
  const database = "display_rebase_" + randomUUID().replaceAll("-", "");
  const admin = postgres(process.env.DATABASE_URL!, {
    max: 1,
    onnotice: () => {},
  });
  await admin.unsafe(`CREATE DATABASE "${database}"`);
  const url = new URL(process.env.DATABASE_URL!);
  url.pathname = "/" + database;
  const db = postgres(url.href, { max: 1, onnotice: () => {} });
  try {
    await db.unsafe(previousBaseline);
    await db`CREATE TABLE mill_migrations(name text PRIMARY KEY,checksum text NOT NULL,applied_at timestamptz NOT NULL DEFAULT now())`;
    await db`INSERT INTO mill_migrations(name,checksum) VALUES('001_initial.sql',${expected.migrations[0].checksum})`;
    assert.deepEqual(await schemaLayout(db, "public"), expected);
    const workspace = randomUUID(),
      owner = randomUUID(),
      board = randomUUID(),
      task = randomUUID();
    await db`INSERT INTO workspace(id,name) VALUES(${workspace},'Retained workspace')`;
    let index = 0;
    for (const dateFormat of dates.filter(
      (value) => value !== "short-month-day-year",
    ))
      for (const timeFormat of times.filter(
        (value) => !value.endsWith("seconds"),
      )) {
        await db`INSERT INTO users(id,workspace_id,name,email,password_hash,role,time_zone,date_format,time_format) VALUES(${index === 0 ? owner : randomUUID()},${workspace},'Retained user',${"user" + index++ + "@display.test"},'retained-password','admin','Asia/Kathmandu',${dateFormat},${timeFormat})`;
      }
    await db`UPDATE users SET time_zone='+05:30' WHERE id=${owner}`;
    await db`INSERT INTO boards(id,workspace_id,name,prefix) VALUES(${board},${workspace},'Retained board','DATE')`;
    await db`INSERT INTO tasks(id,board_id,identifier,title,created_by,start_date,due_date) VALUES(${task},${board},'DATE-1','Retained dates',${owner},'2026-09-16','2026-10-05')`;
    await db`INSERT INTO passkeys(id,user_id,name,public_key,counter) VALUES('retained-passkey',${owner},'Retained key',${Buffer.from("unchanged-key")},7)`;
    await db`INSERT INTO credentials(user_id,name,token_hash,token_prefix,scopes,token_type,expires_at) VALUES(${owner},'Retained REST key','retained-token','prefix','{}','api-key',now()+interval '1 day')`;
    const tables = [
      "workspace",
      "users",
      "boards",
      "tasks",
      "passkeys",
      "credentials",
    ];
    const before: Record<string, unknown> = {};
    for (const table of tables)
      before[table] = [
        ...(await db.unsafe(`SELECT * FROM "${table}" ORDER BY id`)),
      ];
    await db.end();
    const { stdout } = await promisify(execFile)(
      process.execPath,
      [
        fileURLToPath(
          new URL("../tools/rebase-prelaunch.mjs", import.meta.url),
        ),
        "--schema",
        "public",
      ],
      { env: { ...process.env, DATABASE_URL: url.href } },
    );
    assert.equal(JSON.parse(stdout).applied, false);
    const converting = postgres(url.href, { max: 1, onnotice: () => {} });
    try {
      const receipt = await rebasePrelaunch(converting, {
        schema: "public",
        baseline,
        expectedLegacy: expected,
        apply: true,
      });
      assert.equal(receipt.applied, true);
      for (const table of tables) {
        assert.deepEqual(
          [
            ...(await converting.unsafe(
              `SELECT * FROM "${table}" ORDER BY id`,
            )),
          ],
          before[table],
        );
        assert.deepEqual(
          [
            ...(await converting.unsafe(
              `SELECT * FROM "${receipt.archivedSchema}"."${table}" ORDER BY id`,
            )),
          ],
          before[table],
        );
      }
      await converting`UPDATE users SET date_format='short-month-day-year',time_format='24-hour-seconds' WHERE id=${owner}`;
      await converting`UPDATE users SET time_format='12-hour-seconds' WHERE id=${owner}`;
    } finally {
      await converting.end();
    }
  } finally {
    await db.end();
    await admin.unsafe(`DROP DATABASE "${database}"`);
    await admin.end();
  }
});

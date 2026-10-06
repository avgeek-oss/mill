import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import postgres from "postgres";

type Layout = Record<string, unknown>;
type Receipt = {
  applied: boolean;
  schema: string;
  archivedSchema?: string;
  counts: Record<string, number>;
  baseline: string;
  baselineChecksum?: string;
};
const { schemaLayout, rebasePrelaunch } = (await import(
  new URL("../tools/rebase-prelaunch.mjs", import.meta.url).href
)) as {
  schemaLayout: (sql: postgres.Sql, schema: string) => Promise<Layout>;
  rebasePrelaunch: (
    sql: postgres.Sql,
    input: {
      schema: string;
      baseline: string;
      expectedLegacy: Layout;
      apply?: boolean;
    },
  ) => Promise<Receipt>;
};
const execFileAsync = promisify(execFile);
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
const emailBaseline = previousBaseline
  .replace(
    /(CREATE TABLE (?:workspace|users) \([\s\S]*? {2}name text NOT NULL CHECK \(length\(name\) BETWEEN 1 AND )120(\),)/g,
    (_match, prefix, suffix) => prefix + "100" + suffix,
  )
  .replace(
    "CREATE TABLE passkeys (\n  id text PRIMARY KEY,\n  user_id uuid NOT NULL REFERENCES users(id),\n  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 120),",
    "CREATE TABLE passkeys (\n  id text PRIMARY KEY,\n  user_id uuid NOT NULL REFERENCES users(id),\n  name text NOT NULL,",
  );
const passkeyBaseline = emailBaseline
  .split("\n\nCREATE TABLE email_requests")[0]
  .replace("  email_verified boolean NOT NULL DEFAULT false,\n", "")
  .replace("  verification_required boolean NOT NULL DEFAULT false,\n", "")
  .replace(
    "  reset_mfa boolean NOT NULL DEFAULT false,\n  security_epoch integer,\n",
    "  reset_mfa boolean NOT NULL DEFAULT false,\n",
  );
const legacyBaseline = passkeyBaseline
  .replace("  passkey_authenticated_at timestamptz,\n", "")
  .replace(
    "CREATE TABLE recovery_codes",
    `CREATE TABLE authenticators (
  user_id uuid PRIMARY KEY REFERENCES users(id),
  encrypted_secret text NOT NULL,
  verified boolean NOT NULL DEFAULT false,
  last_used_step bigint NOT NULL DEFAULT -1,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE recovery_codes`,
  );
const knownLegacy = JSON.parse(
  await readFile(
    new URL("../tools/prelaunch-legacy-layout.json", import.meta.url),
    "utf8",
  ),
) as {
  tables: Record<
    string,
    {
      name: string;
      type: string;
      udt: string;
      nullable: boolean;
      default: string | null;
    }[]
  >;
};
const databaseUrl =
  process.env.DATABASE_URL ??
  "postgres://mill:mill-test-disposable@127.0.0.1:55432/mill";
async function fixture(
  run: (
    sql: postgres.Sql,
    layout: Layout,
    ids: Record<string, string>,
  ) => Promise<void>,
) {
  const database = `rebase_${randomUUID().replaceAll("-", "")}`;
  const admin = postgres(databaseUrl, { max: 1, onnotice: () => {} });
  await admin.unsafe(`CREATE DATABASE "${database}"`);
  const url = new URL(databaseUrl);
  url.pathname = `/${database}`;
  const sql = postgres(url.href, { max: 1, onnotice: () => {} });
  try {
    await sql.unsafe(legacyBaseline);
    await sql`ALTER TABLE users DROP COLUMN date_format`;
    await sql`ALTER TABLE users DROP COLUMN time_format`;
    await sql`ALTER TABLE tasks DROP COLUMN type`;
    await sql`ALTER TABLE tasks DROP COLUMN start_date`;
    await sql`CREATE TABLE mill_migrations(name text PRIMARY KEY,checksum text NOT NULL,applied_at timestamptz NOT NULL DEFAULT now())`;
    await sql`INSERT INTO mill_migrations VALUES('011_task_status_age.sql','known-fixture-checksum',now())`;
    await sql`CREATE TABLE agents(id uuid PRIMARY KEY,name text NOT NULL,scope text NOT NULL,creator_id uuid NOT NULL REFERENCES users(id),all_members boolean NOT NULL DEFAULT false,version integer NOT NULL DEFAULT 1,created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now())`;
    await sql`CREATE TABLE agent_members(agent_id uuid REFERENCES agents(id),user_id uuid REFERENCES users(id),PRIMARY KEY(agent_id,user_id))`;
    await sql`CREATE TABLE retired_task_checklists(task_id uuid PRIMARY KEY REFERENCES tasks(id),items jsonb NOT NULL)`;
    await sql`ALTER TABLE tasks ADD COLUMN agent_id uuid REFERENCES agents(id)`;
    await sql`ALTER TABLE credentials ADD COLUMN agent_id uuid REFERENCES agents(id)`;
    await sql`ALTER TABLE oauth_requests ADD COLUMN agent_id uuid REFERENCES agents(id)`;
    await sql`DROP TABLE api_idempotency`;
    const retryColumns = knownLegacy.tables.api_idempotency;
    const retryDefinitions = retryColumns.map(
      (column) =>
        `"${column.name}" ${column.type === "ARRAY" ? column.udt.slice(1) + "[]" : column.udt}${column.nullable ? "" : " NOT NULL"}${column.default ? " DEFAULT " + column.default : ""}`,
    );
    await sql.unsafe(
      `CREATE TABLE api_idempotency (${retryDefinitions.join(",")}, PRIMARY KEY(actor_key,key))`,
    );
    const observedRetryColumns =
      await sql`SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name='api_idempotency' ORDER BY ordinal_position`;
    assert.deepEqual(
      observedRetryColumns.map((column) => column.column_name),
      retryColumns.map((column) => column.name),
    );
    await sql`ALTER TABLE activity DROP CONSTRAINT activity_actor_kind_check`;
    await sql`ALTER TABLE activity ADD CONSTRAINT activity_actor_kind_check CHECK(actor_kind IN ('human','agent'))`;
    const ids = Object.fromEntries(
      [
        "workspace",
        "admin",
        "member",
        "board",
        "other",
        "personal",
        "team",
        "restricted",
        "task",
      ].map((key) => [key, randomUUID()]),
    );
    await sql`INSERT INTO workspace(id,name) VALUES(${ids.workspace},'Retained workspace')`;
    await sql`INSERT INTO users(id,workspace_id,name,email,role,password_hash) VALUES(${ids.admin},${ids.workspace},'Admin','admin@rebase.test','admin','retained-admin-hash'),(${ids.member},${ids.workspace},'Member','member@rebase.test','member','retained-member-hash')`;
    await sql`INSERT INTO boards(id,workspace_id,name,prefix) VALUES(${ids.board},${ids.workspace},'Work','WORK'),(${ids.other},${ids.workspace},'Other','OTHER')`;
    await sql`INSERT INTO agents(id,name,scope,creator_id,all_members) VALUES(${ids.personal},'Personal helper','personal',${ids.admin},false),(${ids.team},'Team helper','team',${ids.admin},true),(${ids.restricted},'Restricted helper','team',${ids.admin},false)`;
    await sql`INSERT INTO agent_members VALUES(${ids.restricted},${ids.admin})`;
    await sql`INSERT INTO tasks(id,board_id,identifier,title,description,assignee_id,agent_id,created_by,status,status_changed_at) VALUES(${ids.task},${ids.board},'WORK-1','Retained task','Retained description',${ids.member},${ids.team},${ids.admin},'done',now()-interval '2 days')`;
    await sql`INSERT INTO comments(task_id,author_id,body) VALUES(${ids.task},${ids.member},'Retained comment')`;
    await sql`INSERT INTO retired_task_checklists VALUES(${ids.task},'[{"text":"Old private checklist","done":true}]')`;
    await run(sql, await schemaLayout(sql, "public"), ids);
  } finally {
    await sql.end();
    await admin.unsafe(`DROP DATABASE "${database}"`);
    await admin.end();
  }
}

test("prelaunch conversion accepts the real historical retry-column order, preserves data and exact approved scopes, normalizes attribution, and retains source archive", async () => {
  await fixture(async (sql, _layout, ids) => {
    const personalCredential = randomUUID(),
      teamCredential = randomUUID(),
      emptyCredential = randomUUID(),
      forbiddenCredential = randomUUID(),
      revokedCredential = randomUUID();
    for (const [id, agent, user, boards, revoked] of [
      [personalCredential, ids.personal, ids.admin, null, null],
      [teamCredential, ids.team, ids.member, [ids.board], null],
      [emptyCredential, ids.team, ids.member, [], null],
      [forbiddenCredential, ids.restricted, ids.member, [ids.other], null],
      [
        revokedCredential,
        ids.team,
        ids.member,
        [ids.board],
        "2026-01-01T00:00:00Z",
      ],
    ] as const)
      await sql`INSERT INTO credentials(id,user_id,agent_id,name,token_hash,token_prefix,scopes,token_type,board_ids,expires_at,revoked_at) VALUES(${id},${user},${agent},'Retained connection',${id},'prefix',ARRAY['read'],'oauth',${boards ? sql.array([...boards], 2950) : null},now()+interval '1 day',${revoked})`;
    const request = randomUUID(),
      forbiddenRequest = randomUUID();
    for (const [id, agent] of [
      [request, ids.team],
      [forbiddenRequest, ids.restricted],
    ])
      await sql`INSERT INTO oauth_requests(id,client_id,client_name,client_trust,redirect_uri,resource,scope,challenge,user_id,agent_id,board_ids,code_hash,expires_at) VALUES(${id},'client','Retained client','unverified','https://example.test/callback','https://example.test/mcp','read','challenge',${ids.member},${agent},ARRAY[${ids.board}::uuid],${id},now()+interval '1 day')`;
    await sql`INSERT INTO activity(task_id,board_id,actor_id,actor_name,actor_kind,action,detail) VALUES(${ids.task},${ids.board},${ids.member},'Team helper via Member','agent','task.updated','{"fields":["description","agentId","title"],"agentId":"legacy","kept":true}')`;
    await sql`INSERT INTO notifications(user_id,task_id,kind,actor_name) VALUES(${ids.admin},${ids.task},'mention','Team helper via Member'),(${ids.admin},${ids.task},'mention','Retired helper via Someone')`;
    await sql`INSERT INTO api_idempotency(actor_key,key,request_hash,response,status,board_ids,task_ids,agent_ids) VALUES('credential','retry','hash','{"agentId":"legacy"}',201,ARRAY[${ids.board}::uuid],ARRAY[${ids.task}::uuid],ARRAY[${ids.team}::uuid])`;
    const beforeTasks =
      await sql`SELECT id,board_id,title,description,assignee_id,status,status_changed_at,version,created_at,updated_at FROM tasks`;
    const layout = await schemaLayout(sql, "public");
    const dry = await rebasePrelaunch(sql, {
      schema: "public",
      baseline,
      expectedLegacy: layout,
    });
    assert.equal(dry.applied, false);
    assert.deepEqual(await schemaLayout(sql, "public"), layout);
    const result = await rebasePrelaunch(sql, {
      schema: "public",
      baseline,
      expectedLegacy: layout,
      apply: true,
    });
    assert.equal(result.applied, true);
    assert.equal((await sql`SELECT type FROM tasks`)[0].type, "task");
    assert.ok(result.archivedSchema);
    assert.deepEqual(
      await sql`SELECT id,board_id,title,description,assignee_id,status,status_changed_at,version,created_at,updated_at FROM tasks`,
      beforeTasks,
    );
    assert.equal(
      (await sql`SELECT body FROM comments`)[0].body,
      "Retained comment",
    );
    assert.deepEqual(
      (
        await sql`SELECT board_ids,scopes,revoked_at FROM credentials WHERE id=${personalCredential}`
      )[0],
      { board_ids: null, scopes: ["read"], revoked_at: null },
    );
    assert.deepEqual(
      (
        await sql`SELECT board_ids,scopes,revoked_at FROM credentials WHERE id=${teamCredential}`
      )[0],
      { board_ids: [ids.board], scopes: ["read"], revoked_at: null },
    );
    assert.deepEqual(
      (
        await sql`SELECT board_ids FROM credentials WHERE id=${emptyCredential}`
      )[0].board_ids,
      [],
    );
    assert.ok(
      (
        await sql`SELECT revoked_at FROM credentials WHERE id=${forbiddenCredential}`
      )[0].revoked_at,
    );
    assert.equal(
      (
        await sql`SELECT revoked_at FROM credentials WHERE id=${revokedCredential}`
      )[0].revoked_at.toISOString(),
      "2026-01-01T00:00:00.000Z",
    );
    assert.equal(
      (await sql`SELECT consumed_at FROM oauth_requests WHERE id=${request}`)[0]
        .consumed_at,
      null,
    );
    assert.ok(
      (
        await sql`SELECT consumed_at FROM oauth_requests WHERE id=${forbiddenRequest}`
      )[0].consumed_at,
    );
    assert.deepEqual(
      (
        await sql`SELECT actor_id,actor_name,actor_kind,detail FROM activity`
      )[0],
      {
        actor_id: ids.member,
        actor_name: "Member",
        actor_kind: "oauth",
        detail: { fields: ["description", "title"], kept: true },
      },
    );
    assert.deepEqual(
      (await sql`SELECT actor_name FROM notifications ORDER BY actor_name`).map(
        (r) => r.actor_name,
      ),
      ["Member", "Workspace member"],
    );
    assert.deepEqual(
      (
        await sql`SELECT response,status,invalidation_reason FROM api_idempotency`
      )[0],
      { response: null, status: 410, invalidation_reason: "upgrade" },
    );
    assert.equal(
      (
        await sql`SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND table_name LIKE 'agent%'`
      ).length,
      0,
    );
    assert.equal(
      (
        await sql`SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND column_name LIKE 'agent%'`
      ).length,
      0,
    );
    const archive = result.archivedSchema!;
    assert.equal(
      (
        await sql.unsafe(
          `SELECT count(*)::int AS count FROM "${archive}".agents`,
        )
      )[0].count,
      3,
    );
    assert.equal(
      (
        await sql.unsafe(
          `SELECT items FROM "${archive}".retired_task_checklists`,
        )
      )[0].items[0].text,
      "Old private checklist",
    );
    assert.equal(
      (await sql.unsafe(`SELECT actor_name FROM "${archive}".activity`))[0]
        .actor_name,
      "Team helper via Member",
    );
    const functions =
      await sql`SELECT n.nspname,p.proconfig FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname IN ('public',${archive})`;
    assert.ok(functions.length);
    for (const row of functions)
      assert.ok(
        row.proconfig.some((value: string) => value.includes(row.nspname)),
      );
    await assert.rejects(
      rebasePrelaunch(sql, {
        schema: "public",
        baseline,
        expectedLegacy: layout,
        apply: true,
      }),
      /known prelaunch/,
    );
  });
});
test("prelaunch conversion rejects active clients, checksum drift, unknown source layout and failed data copy without modifying the source", async () => {
  await fixture(async (sql, layout) => {
    await assert.rejects(
      rebasePrelaunch(sql, {
        schema: "public",
        baseline: baseline + "\n-- changed",
        expectedLegacy: layout,
        apply: true,
      }),
      /baseline differs/,
    );
    await assert.rejects(
      rebasePrelaunch(sql, {
        schema: "public",
        baseline,
        expectedLegacy: { ...layout, migrations: [] },
        apply: true,
      }),
      /known prelaunch/,
    );
    const [db] = await sql`SELECT current_database() AS name`;
    const url = new URL(databaseUrl);
    url.pathname = `/${db.name}`;
    const client = postgres(url.href, { max: 1 });
    await client`SELECT 1`;
    try {
      await assert.rejects(
        rebasePrelaunch(sql, {
          schema: "public",
          baseline,
          expectedLegacy: layout,
          apply: true,
        }),
        /Stop every application/,
      );
    } finally {
      await client.end();
    }
    assert.deepEqual(await schemaLayout(sql, "public"), layout);
    await sql`ALTER TABLE tasks DROP CONSTRAINT tasks_title_check`;
    await sql`UPDATE tasks SET title=repeat('x',301)`;
    const changed = await schemaLayout(sql, "public");
    await assert.rejects(
      rebasePrelaunch(sql, {
        schema: "public",
        baseline,
        expectedLegacy: changed,
        apply: true,
      }),
      { code: "23514" },
    );
    assert.deepEqual(await schemaLayout(sql, "public"), changed);
    assert.equal(
      (await sql`SELECT length(title) AS length FROM tasks`)[0].length,
      301,
    );
    assert.equal(
      (
        await sql`SELECT nspname FROM pg_namespace WHERE nspname LIKE 'mill_prelaunch_%'`
      ).length,
      0,
    );
  });
});

for (const source of [
  {
    name: "c49f109 auth and account preference baseline",
    file: "prelaunch-auth-settings-layout.json",
    hasType: true,
    hasStartDate: true,
    hasPreferences: true,
  },
  {
    name: "preceding clean baseline",
    file: "prelaunch-task-type-layout.json",
    hasType: false,
  },
  {
    name: "previous complete task baseline",
    file: "prelaunch-account-preferences-layout.json",
    hasType: true,
    hasStartDate: true,
  },
  {
    name: "Task and Bug baseline",
    file: "prelaunch-start-date-layout.json",
    hasType: true,
  },
])
  test(`${source.name} gains nullable start dates without changing retained task data, credentials or attribution`, async () => {
    const database = `type_rebase_${randomUUID().replaceAll("-", "")}`;
    const admin = postgres(databaseUrl, { max: 1, onnotice: () => {} });
    await admin.unsafe(`CREATE DATABASE "${database}"`);
    const url = new URL(databaseUrl);
    url.pathname = `/${database}`;
    const sql = postgres(url.href, { max: 1, onnotice: () => {} });
    try {
      const expected = JSON.parse(
        await readFile(
          new URL(`../tools/${source.file}`, import.meta.url),
          "utf8",
        ),
      );
      const withoutPreferences = legacyBaseline
        .split("\n")
        .filter(
          (line) =>
            !line.startsWith("  date_format ") &&
            !line.startsWith("  time_format "),
        )
        .join("\n");
      const preferenceBaseline = source.hasPreferences
        ? legacyBaseline
        : withoutPreferences;
      const sourceBaseline = source.hasStartDate
        ? preferenceBaseline
        : preferenceBaseline.replace("  start_date date,\n", "");
      if (source.hasPreferences)
        assert.equal(
          createHash("sha256").update(sourceBaseline).digest("hex"),
          expected.migrations[0].checksum,
        );
      await sql.unsafe(
        source.hasType
          ? sourceBaseline
          : sourceBaseline.replace(
              "  type text NOT NULL DEFAULT 'task' CHECK (type IN ('task','bug')),\n",
              "",
            ),
      );
      await sql`CREATE TABLE mill_migrations(name text PRIMARY KEY,checksum text NOT NULL,applied_at timestamptz NOT NULL DEFAULT now())`;
      await sql`INSERT INTO mill_migrations(name,checksum) VALUES('001_initial.sql',${expected.migrations[0].checksum})`;
      const workspace = randomUUID(),
        user = randomUUID(),
        board = randomUUID(),
        task = randomUUID();
      await sql`INSERT INTO workspace(id,name) VALUES(${workspace},'Preserved workspace')`;
      await sql`INSERT INTO users(id,workspace_id,name,email,password_hash,role) VALUES(${user},${workspace},'Owner','owner@example.test','hash','admin')`;
      if (source.hasPreferences) {
        await sql`UPDATE users SET date_format='year-month-day',time_format='12-hour',time_zone='Asia/Kolkata',notification_preferences='{"assignments":false,"mentions":true}' WHERE id=${user}`;
        await sql`INSERT INTO authenticators(user_id,encrypted_secret,verified) VALUES(${user},'preserved-retired-factor',true)`;
        await sql`INSERT INTO passkeys(id,user_id,name,public_key,counter) VALUES('preserved-passkey',${user},'Owner passkey',${Buffer.from("preserved-public-key")},7)`;
        await sql`INSERT INTO recovery_codes(user_id,code_hash) VALUES(${user},'preserved-retired-recovery')`;
        await sql`INSERT INTO sessions(id,user_id,token_hash,security_epoch,user_agent,expires_at) VALUES(${randomUUID()},${user},'preserved-browser-hash',0,'Preserved browser',now()+interval '1 day')`;
      }
      await sql`INSERT INTO boards(id,workspace_id,name,prefix) VALUES(${board},${workspace},'Preserved board','KEEP')`;
      await sql`INSERT INTO tasks(id,board_id,identifier,title,description,created_by,assignee_id,priority,status,version,status_changed_at) VALUES(${task},${board},'KEEP-1','Preserved task','All original content',${user},${user},'urgent','done',9,now()-interval '3 days')`;
      if (source.hasType)
        await sql`UPDATE tasks SET type='bug' WHERE id=${task}`;
      if (source.hasStartDate)
        await sql`UPDATE tasks SET start_date='2026-10-08' WHERE id=${task}`;
      await sql`UPDATE tasks SET due_date='2026-10-11' WHERE id=${task}`;
      await sql`INSERT INTO comments(task_id,author_id,body) VALUES(${task},${user},'Preserved discussion')`;
      await sql`INSERT INTO activity(task_id,board_id,actor_id,actor_name,actor_kind,action,detail) VALUES(${task},${board},${user},'Historical owner name','oauth','task.updated','{"fields":["title"]}')`;
      await sql`INSERT INTO credentials(user_id,name,token_hash,token_prefix,scopes,token_type,board_ids,expires_at) VALUES(${user},'Existing connection','retained-hash','prefix',ARRAY['read','write'],'oauth',ARRAY[${board}::uuid],now()+interval '1 day')`;
      await sql`INSERT INTO api_idempotency(actor_key,key,request_hash,response,status,board_ids,task_ids) VALUES('owner','retry','retained-request','{"task":{"title":"cached old task"}}',201,ARRAY[${board}::uuid],ARRAY[${task}::uuid])`;
      if (source.hasPreferences) {
        const [key] = await sql`DELETE FROM passkeys RETURNING *`;
        await assert.rejects(
          execFileAsync(
            process.execPath,
            [
              fileURLToPath(
                new URL("../tools/rebase-prelaunch.mjs", import.meta.url),
              ),
              "--schema",
              "public",
            ],
            { env: { ...process.env, DATABASE_URL: url.href } },
          ),
          /active authenticator-only accounts.*security factors cannot be silently removed/,
        );
        assert.equal((await sql`SELECT * FROM authenticators`).length, 1);
        assert.equal((await sql`SELECT * FROM recovery_codes`).length, 1);
        assert.equal(
          (
            await sql`SELECT nspname FROM pg_namespace WHERE nspname LIKE 'mill_prelaunch_%'`
          ).length,
          0,
        );
        await sql`INSERT INTO passkeys ${sql(key)}`;
      }
      const before = [...(await sql`SELECT * FROM tasks`)];
      const users = [...(await sql`SELECT * FROM users`)];
      const credentials = [...(await sql`SELECT * FROM credentials`)];
      const activity = [...(await sql`SELECT * FROM activity`)];
      const comments = [...(await sql`SELECT * FROM comments`)];
      const passkeys = [...(await sql`SELECT * FROM passkeys`)];
      const sessions = [...(await sql`SELECT * FROM sessions`)];
      const layout = await schemaLayout(sql, "public");
      assert.deepEqual(layout, expected);
      const inspection = await execFileAsync(
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
      assert.equal(JSON.parse(inspection.stdout).applied, false);
      assert.equal(JSON.parse(inspection.stdout).counts.tasks, 1);
      assert.deepEqual(await schemaLayout(sql, "public"), layout);
      const dry = await rebasePrelaunch(sql, {
        schema: "public",
        baseline,
        expectedLegacy: expected,
      });
      assert.equal(dry.applied, false);
      assert.deepEqual(await schemaLayout(sql, "public"), layout);
      await sql`ALTER TABLE tasks ADD COLUMN unexpected text`;
      await assert.rejects(
        rebasePrelaunch(sql, {
          schema: "public",
          baseline,
          expectedLegacy: expected,
          apply: true,
        }),
        /does not match/,
      );
      await sql`ALTER TABLE tasks DROP COLUMN unexpected`;
      const converted = await rebasePrelaunch(sql, {
        schema: "public",
        baseline,
        expectedLegacy: expected,
        apply: true,
      });
      assert.equal(converted.applied, true);
      const tasks = [...(await sql`SELECT * FROM tasks`)];
      assert.equal(tasks[0].type, source.hasType ? "bug" : "task");
      assert.deepEqual(
        tasks[0].start_date,
        source.hasStartDate ? before[0].start_date : null,
      );
      const retained = { ...tasks[0] };
      if (!source.hasStartDate) delete retained.start_date;
      const rawConvertedUsers = [...(await sql`SELECT * FROM users`)];
      assert.ok(
        rawConvertedUsers.every((user) => user.email_verified === false),
      );
      const convertedUsers = rawConvertedUsers.map(
        ({ email_verified: _verified, ...user }) => user,
      );
      if (source.hasPreferences) assert.deepEqual(convertedUsers, users);
      else {
        assert.equal(convertedUsers[0].date_format, "day-short-month-year");
        assert.equal(convertedUsers[0].time_format, "24-hour");
        assert.deepEqual(
          convertedUsers.map(
            ({ date_format: _dateFormat, time_format: _timeFormat, ...user }) =>
              user,
          ),
          users,
        );
      }
      assert.deepEqual([...(await sql`SELECT * FROM passkeys`)], passkeys);
      assert.deepEqual(
        [...(await sql`SELECT * FROM sessions`)],
        sessions.map((session) => ({
          ...session,
          authenticated_at: new Date(0),
          passkey_authenticated_at: null,
        })),
      );
      if (source.hasPreferences) {
        assert.equal((await sql`SELECT * FROM recovery_codes`).length, 0);
        assert.equal(
          (
            await sql.unsafe(
              `SELECT encrypted_secret FROM "${converted.archivedSchema}".authenticators`,
            )
          )[0].encrypted_secret,
          "preserved-retired-factor",
        );
        assert.equal(
          (
            await sql.unsafe(
              `SELECT code_hash FROM "${converted.archivedSchema}".recovery_codes`,
            )
          )[0].code_hash,
          "preserved-retired-recovery",
        );
      }
      if (!source.hasType) delete retained.type;
      assert.deepEqual(retained, before[0]);
      assert.deepEqual(
        [...(await sql`SELECT * FROM credentials`)],
        credentials,
      );
      assert.deepEqual([...(await sql`SELECT * FROM activity`)], activity);
      assert.deepEqual([...(await sql`SELECT * FROM comments`)], comments);
      assert.deepEqual(
        [
          ...(await sql.unsafe(
            `SELECT * FROM "${converted.archivedSchema}".tasks`,
          )),
        ],
        before,
      );
      assert.deepEqual(
        [
          ...(await sql`SELECT response,status,invalidation_reason,key,request_hash FROM api_idempotency`),
        ],
        [
          {
            response: null,
            status: 410,
            invalidation_reason: "upgrade",
            key: "retry",
            request_hash: "retained-request",
          },
        ],
      );
      assert.deepEqual(
        [...(await sql`SELECT name,checksum FROM mill_migrations`)],
        [{ name: "001_initial.sql", checksum: converted.baselineChecksum }],
      );
    } finally {
      await sql.end();
      await admin.unsafe(`DROP DATABASE "${database}"`);
      await admin.end();
    }
  });

test("prelaunch conversion blocks authenticator-only downgrade and archives legacy recovery while requiring fresh proof", async () => {
  await fixture(async (sql, layout, ids) => {
    await sql`INSERT INTO authenticators(user_id,encrypted_secret,verified) VALUES(${ids.admin},'legacy-encrypted-secret',true)`;
    await sql`INSERT INTO recovery_codes(user_id,code_hash) VALUES(${ids.admin},'legacy-recovery-digest')`;
    const session = randomUUID();
    await sql`INSERT INTO sessions(id,user_id,token_hash,security_epoch,user_agent,expires_at) VALUES(${session},${ids.admin},'retained-session-digest',0,'Retained browser',now()+interval '1 day')`;
    for (const apply of [false, true])
      await assert.rejects(
        rebasePrelaunch(sql, {
          schema: "public",
          baseline,
          expectedLegacy: layout,
          apply,
        }),
        /active authenticator-only accounts.*security factors cannot be silently removed/,
      );
    assert.deepEqual(await schemaLayout(sql, "public"), layout);
    assert.equal((await sql`SELECT * FROM authenticators`).length, 1);
    assert.equal(
      (
        await sql`SELECT nspname FROM pg_namespace WHERE nspname LIKE 'mill_prelaunch_%'`
      ).length,
      0,
    );
    await sql`INSERT INTO passkeys(id,user_id,name,public_key,counter) VALUES('retained-passkey',${ids.admin},'Retained passkey',${Buffer.from("retained-public-key")},0)`;
    const receipt = await rebasePrelaunch(sql, {
      schema: "public",
      baseline,
      expectedLegacy: layout,
      apply: true,
    });
    assert.equal((await sql`SELECT * FROM recovery_codes`).length, 0);
    const [retained] =
      await sql`SELECT authenticated_at,passkey_authenticated_at FROM sessions WHERE id=${session}`;
    assert.equal(retained.authenticated_at.getTime(), 0);
    assert.equal(retained.passkey_authenticated_at, null);
    assert.equal(
      (await sql`SELECT id FROM passkeys`)[0].id,
      "retained-passkey",
    );
    const archived = receipt.archivedSchema!;
    assert.equal(
      (await sql.unsafe(`SELECT * FROM "${archived}".authenticators`)).length,
      1,
    );
    assert.equal(
      (
        await sql.unsafe(`SELECT code_hash FROM "${archived}".recovery_codes`)
      )[0].code_hash,
      "legacy-recovery-digest",
    );
  });
});

test("removed authenticator-only members do not block inspection or conversion and their retired factors stay in the source archive", async () => {
  await fixture(async (sql, layout, ids) => {
    await sql`UPDATE users SET disabled_at=now(),security_epoch=security_epoch+1 WHERE id=${ids.member}`;
    await sql`INSERT INTO authenticators(user_id,encrypted_secret,verified,last_used_step) VALUES(${ids.member},'removed-member-retired-secret',true,42)`;
    await sql`INSERT INTO recovery_codes(user_id,code_hash) VALUES(${ids.member},'removed-member-recovery-digest')`;
    const members = [...(await sql`SELECT * FROM users ORDER BY id`)];
    const authenticators = [...(await sql`SELECT * FROM authenticators`)];
    const recoveryCodes = [...(await sql`SELECT * FROM recovery_codes`)];
    const tasks = [...(await sql`SELECT * FROM tasks`)];
    const dry = await rebasePrelaunch(sql, {
      schema: "public",
      baseline,
      expectedLegacy: layout,
    });
    assert.equal(dry.applied, false);
    assert.equal(dry.counts.authenticators, 1);
    assert.deepEqual(await schemaLayout(sql, "public"), layout);
    assert.deepEqual(
      [...(await sql`SELECT * FROM authenticators`)],
      authenticators,
    );
    assert.deepEqual(
      [...(await sql`SELECT * FROM recovery_codes`)],
      recoveryCodes,
    );
    assert.equal(
      (
        await sql`SELECT nspname FROM pg_namespace WHERE nspname LIKE 'mill_prelaunch_%'`
      ).length,
      0,
    );
    const converted = await rebasePrelaunch(sql, {
      schema: "public",
      baseline,
      expectedLegacy: layout,
      apply: true,
    });
    assert.equal(converted.applied, true);
    const convertedMembers = [...(await sql`SELECT * FROM users ORDER BY id`)];
    assert.deepEqual(
      convertedMembers.map(
        ({
          date_format: _dateFormat,
          time_format: _timeFormat,
          email_verified: _verified,
          ...member
        }) => member,
      ),
      members,
    );
    assert.ok(
      convertedMembers.find((member) => member.id === ids.member)?.disabled_at,
    );
    assert.equal((await sql`SELECT * FROM recovery_codes`).length, 0);
    assert.equal(
      (
        await sql`SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND table_name='authenticators'`
      ).length,
      0,
    );
    const archived = converted.archivedSchema!;
    assert.deepEqual(
      [...(await sql.unsafe(`SELECT * FROM "${archived}".authenticators`))],
      authenticators,
    );
    assert.deepEqual(
      [...(await sql.unsafe(`SELECT * FROM "${archived}".recovery_codes`))],
      recoveryCodes,
    );
    assert.deepEqual(
      [...(await sql.unsafe(`SELECT * FROM "${archived}".users ORDER BY id`))],
      members,
    );
    assert.deepEqual(
      [...(await sql.unsafe(`SELECT * FROM "${archived}".tasks`))],
      tasks,
    );
  });
});

test("exact PR4 passkey baseline converts without fabricating email proof, preserves current passkey sessions, and archives old recovery links", async () => {
  const database = `email_rebase_${randomUUID().replaceAll("-", "")}`;
  const admin = postgres(databaseUrl, { max: 1, onnotice: () => {} });
  await admin.unsafe(`CREATE DATABASE "${database}"`);
  const url = new URL(databaseUrl);
  url.pathname = `/${database}`;
  const db = postgres(url.href, { max: 1, onnotice: () => {} });
  try {
    const checksum = createHash("sha256").update(passkeyBaseline).digest("hex");
    assert.equal(
      checksum,
      "070ba86deb3dd76c9489b580bf79f1b65e217d80cb3cedc2ca00fc3b8d9e4a22",
    );
    await db.unsafe(passkeyBaseline);
    await db`CREATE TABLE mill_migrations(name text PRIMARY KEY,checksum text NOT NULL,applied_at timestamptz NOT NULL DEFAULT now())`;
    await db`INSERT INTO mill_migrations(name,checksum) VALUES('001_initial.sql',${checksum})`;
    const expected = JSON.parse(
      await readFile(
        new URL("../tools/prelaunch-passkey-layout.json", import.meta.url),
        "utf8",
      ),
    );
    assert.deepEqual(await schemaLayout(db, "public"), expected);
    const workspace = randomUUID(),
      user = randomUUID();
    await db`INSERT INTO workspace(id,name) VALUES(${workspace},'Retained workspace')`;
    await db`INSERT INTO users(id,workspace_id,name,email,password_hash,role,time_zone,date_format,time_format) VALUES(${user},${workspace},'Owner','owner@example.test','retained-password-hash','admin','Asia/Kolkata','year-month-day','12-hour')`;
    await db`INSERT INTO passkeys(id,user_id,name,public_key,counter) VALUES('actual-key',${user},'Actual key',${Buffer.from("real-retained-public-key")},12)`;
    await db`INSERT INTO sessions(id,user_id,token_hash,security_epoch,user_agent,expires_at,passkey_authenticated_at) VALUES(${randomUUID()},${user},'actual-session',0,'Actual browser',now()+interval '1 day',now())`;
    await db`INSERT INTO account_recovery(token_hash,user_id,expires_at) VALUES('old-recovery-token-hash',${user},now()+interval '1 hour')`;
    await db`INSERT INTO invitations(id,email,role,token_hash,invited_by,expires_at) VALUES(${randomUUID()},'invited@example.test','member','old-private-invite',${user},now()+interval '1 day')`;
    const sessions = [...(await db`SELECT * FROM sessions`)],
      keys = [...(await db`SELECT * FROM passkeys`)],
      recoveries = [...(await db`SELECT * FROM account_recovery`)];
    await db.end();
    const inspected = await execFileAsync(
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
    assert.equal(JSON.parse(inspected.stdout).applied, false);
    const converting = postgres(url.href, { max: 1, onnotice: () => {} });
    try {
      const result = await rebasePrelaunch(converting, {
        schema: "public",
        baseline,
        expectedLegacy: expected,
        apply: true,
      });
      assert.equal(result.applied, true);
      assert.deepEqual(
        [...(await converting`SELECT * FROM sessions`)],
        sessions,
      );
      assert.deepEqual([...(await converting`SELECT * FROM passkeys`)], keys);
      assert.equal(
        (await converting`SELECT email_verified FROM users`)[0].email_verified,
        false,
      );
      assert.equal(
        (await converting`SELECT verification_required FROM invitations`)[0]
          .verification_required,
        false,
      );
      assert.equal(
        (await converting`SELECT security_epoch FROM account_recovery`)[0]
          .security_epoch,
        null,
      );
      assert.equal(
        (await converting`SELECT count(*)::int AS count FROM email_requests`)[0]
          .count,
        0,
      );
      assert.equal(
        (await converting`SELECT count(*)::int AS count FROM email_outbox`)[0]
          .count,
        0,
      );
      assert.deepEqual(
        [
          ...(await converting.unsafe(
            `SELECT * FROM "${result.archivedSchema}".account_recovery`,
          )),
        ],
        recoveries,
      );
    } finally {
      await converting.end();
    }
  } finally {
    await db.end();
    await admin.unsafe(`DROP DATABASE IF EXISTS "${database}"`);
    await admin.end();
  }
});

test("the exact previous email baseline widens common names and preserves verified facts, pending proof, opaque mail payload and passkey state", async () => {
  const database = `name_rebase_${randomUUID().replaceAll("-", "")}`,
    admin = postgres(databaseUrl, { max: 1, onnotice: () => {} });
  await admin.unsafe(`CREATE DATABASE "${database}"`);
  const url = new URL(databaseUrl);
  url.pathname = `/${database}`;
  const db = postgres(url.href, { max: 1, onnotice: () => {} });
  try {
    const checksum = createHash("sha256").update(emailBaseline).digest("hex");
    assert.equal(
      checksum,
      "0121c0c04b67d6bfcb890d1df8d849a7e00b8a21ebea422ad2467c13201182bd",
    );
    await db.unsafe(emailBaseline);
    await db`CREATE TABLE mill_migrations(name text PRIMARY KEY,checksum text NOT NULL,applied_at timestamptz NOT NULL DEFAULT now())`;
    await db`INSERT INTO mill_migrations(name,checksum) VALUES('001_initial.sql',${checksum})`;
    const expected = JSON.parse(
      await readFile(
        new URL("../tools/prelaunch-email-layout.json", import.meta.url),
        "utf8",
      ),
    );
    assert.deepEqual(await schemaLayout(db, "public"), expected);
    const workspace = randomUUID(),
      user = randomUUID(),
      invitation = randomUUID(),
      proof = randomUUID(),
      mail = randomUUID();
    await db`INSERT INTO workspace(id,name) VALUES(${workspace},${"W".repeat(100)})`;
    await db`INSERT INTO users(id,workspace_id,name,email,email_verified,password_hash,security_epoch,role) VALUES(${user},${workspace},${"U".repeat(100)},'verified@example.test',true,'retained-password',7,'admin')`;
    await db`INSERT INTO invitations(id,email,role,token_hash,invited_by,verification_required,expires_at) VALUES(${invitation},'invitee@example.test','member','retained-invitation',${user},true,now()+interval '1 day')`;
    await db`INSERT INTO account_recovery(token_hash,user_id,security_epoch,expires_at) VALUES('retained-recovery',${user},7,now()+interval '1 hour')`;
    await db`INSERT INTO passkeys(id,user_id,name,public_key,counter) VALUES('retained-key',${user},${"P".repeat(100)},${Buffer.from("retained-public-key")},9)`;
    await db`INSERT INTO sessions(id,user_id,token_hash,security_epoch,user_agent,expires_at,passkey_authenticated_at) VALUES(${randomUUID()},${user},'retained-session',7,'Browser',now()+interval '1 day',now())`;
    await db`INSERT INTO email_requests(id,user_id,purpose,email,previous_email,security_epoch,token_hash,expires_at) VALUES(${proof},${user},'change','new@example.test','verified@example.test',7,'retained-proof-digest',now()+interval '1 hour')`;
    await db`INSERT INTO email_outbox(id,request_id,payload,expires_at) VALUES(${mail},${proof},'opaque-sealed-payload',now()+interval '1 hour')`;
    const tables = [
      "users",
      "workspace",
      "invitations",
      "account_recovery",
      "passkeys",
      "sessions",
      "email_requests",
      "email_outbox",
    ];
    const before: Record<string, unknown> = {};
    for (const table of tables)
      before[table] = [...(await db.unsafe(`SELECT * FROM "${table}"`))];
    await db.end();
    const inspection = await execFileAsync(
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
    assert.equal(JSON.parse(inspection.stdout).counts.email_outbox, 1);
    const converting = postgres(url.href, { max: 1, onnotice: () => {} });
    try {
      const result = await rebasePrelaunch(converting, {
        schema: "public",
        baseline,
        expectedLegacy: expected,
        apply: true,
      });
      assert.equal(result.applied, true);
      for (const table of tables) {
        assert.deepEqual(
          [...(await converting.unsafe(`SELECT * FROM "${table}"`))],
          before[table],
        );
        assert.deepEqual(
          [
            ...(await converting.unsafe(
              `SELECT * FROM "${result.archivedSchema}"."${table}"`,
            )),
          ],
          before[table],
        );
      }
      await converting`UPDATE users SET name=${"U".repeat(120)} WHERE id=${user}`;
      await converting`UPDATE workspace SET name=${"W".repeat(120)}`;
      await converting`UPDATE passkeys SET name=${"P".repeat(120)}`;
      await assert.rejects(
        converting`UPDATE passkeys SET name=${"P".repeat(121)}`,
        { code: "23514" },
      );
    } finally {
      await converting.end();
    }
  } finally {
    await db.end();
    await admin.unsafe(`DROP DATABASE IF EXISTS "${database}"`);
    await admin.end();
  }
});

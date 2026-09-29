import assert from "node:assert/strict";
import {
  createCipheriv,
  createHash,
  randomBytes,
  randomUUID,
} from "node:crypto";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const runId = `${Date.now()}-${randomBytes(4).toString("hex")}`;
const project = `mill-verify-${runId}`;
const recoveryProject = `${project}-restore`;
const image = `mill:verify-${runId}`;
const scannerCache = `${project}-scanner-cache`;
const evidence = resolve(root, "tmp", "verification", project);
const privateDirectory = await mkdtemp(join(tmpdir(), "mill-verify-"));
const controller = new AbortController();
for (const signal of ["SIGINT", "SIGTERM"])
  process.once(signal, () => controller.abort());
const secrets = [
  randomBytes(32).toString("hex"),
  randomBytes(48).toString("hex"),
  `${randomBytes(32).toString("base64url")}Aa1!`,
];
const results = [];
const projects = [];
await mkdir(evidence, { recursive: true });
function redact(value) {
  for (const secret of secrets) value = value.replaceAll(secret, "[redacted]");
  return value;
}
async function run(
  name,
  command,
  args,
  extraEnv = {},
  timeout = 120_000,
  cleanup = false,
) {
  const started = Date.now();
  let output = "";
  let exitCode;
  try {
    const child = spawn(command, args, {
      cwd: root,
      env: { ...process.env, ...extraEnv },
      stdio: ["ignore", "pipe", "pipe"],
      signal: cleanup ? undefined : controller.signal,
    });
    const timer = setTimeout(() => child.kill("SIGTERM"), timeout);
    child.stdout.on("data", (data) => {
      output += data;
    });
    child.stderr.on("data", (data) => {
      output += data;
    });
    exitCode = await new Promise((resolveCode, reject) => {
      child.once("error", reject);
      child.once("close", resolveCode);
    }).finally(() => clearTimeout(timer));
    assert.equal(exitCode, 0, `${name} must pass`);
    console.log(`PASS ${name}`);
    return output.trim();
  } finally {
    await writeFile(join(evidence, `${name}.log`), redact(output), {
      mode: 0o600,
    });
    results.push({
      step: name,
      exitCode: exitCode ?? null,
      elapsedMs: Date.now() - started,
    });
    await writeFile(
      join(evidence, "results.json"),
      JSON.stringify({ project, image, results }, null, 2),
    );
  }
}
async function port() {
  const server = createServer();
  await new Promise((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolveListen);
  });
  const number = server.address().port;
  await new Promise((resolveClose, reject) =>
    server.close((error) => (error ? reject(error) : resolveClose())),
  );
  return number;
}
function databaseArguments(configuration, statement) {
  return [
    ...configuration.compose,
    "exec",
    "-T",
    "postgres",
    "psql",
    "-U",
    "mill",
    "-d",
    "mill",
    "-v",
    "ON_ERROR_STOP=1",
    "--tuples-only",
    "--no-align",
    "-c",
    statement,
  ];
}
async function configuration(name, targetPort) {
  const envFile = join(privateDirectory, `${name}.env`);
  await writeFile(
    envFile,
    [
      `POSTGRES_PASSWORD=${secrets[0]}`,
      `MILL_SECRET=${secrets[1]}`,
      `MILL_BASE_URL=http://127.0.0.1:${targetPort}`,
      `MILL_PORT=${targetPort}`,
      "MILL_BIND_ADDRESS=127.0.0.1",
      "ALLOW_INSECURE_LOCALHOST=true",
      `MILL_IMAGE=${image}`,
      `SOURCE_COMMIT=${sourceRevision}${sourceDirty ? "-dirty" : ""}`,
      "",
    ].join("\n"),
    { mode: 0o600 },
  );
  const compose = [
    "compose",
    "--project-name",
    name,
    "--env-file",
    envFile,
    "--file",
    "docker-compose.yml",
  ];
  projects.push(compose);
  return { envFile, compose, url: `http://127.0.0.1:${targetPort}` };
}
const state = join(evidence, "fixture-state.json");
const backup = join(privateDirectory, "mill.dump");
const staticManifest = join(evidence, "static-content-manifest.json");
const legacyAuthAuditTable = `CREATE TABLE auth_audit (
  id uuid PRIMARY KEY,
  user_id uuid REFERENCES users(id),
  actor_name text NOT NULL,
  action text NOT NULL,
  detail jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now()
)`;
let primary;
let sourceRevision;
let sourceDirty;
try {
  sourceRevision = await run("source-revision", "git", ["rev-parse", "HEAD"]);
  sourceDirty = Boolean(
    await run("source-working-tree", "git", ["status", "--porcelain"]),
  );
  await run("docker-required", "docker", [
    "info",
    "--format",
    "{{.ServerVersion}}",
  ]);
  primary = await configuration(project, await port());
  await run("compose-configuration", "docker", [
    ...primary.compose,
    "config",
    "--quiet",
  ]);
  await run(
    "production-image-build",
    "docker",
    [...primary.compose, "build", "--pull", "mill"],
    {},
    1_800_000,
  );
  await run(
    "fresh-production-start",
    "docker",
    [
      ...primary.compose,
      "up",
      "--no-build",
      "--detach",
      "--wait",
      "--wait-timeout",
      "180",
    ],
    {},
    240_000,
  );
  const builtStaticManifest = await run(
    "production-static-manifest",
    "docker",
    [
      ...primary.compose,
      "exec",
      "-T",
      "--env",
      "MILL_STATIC_MODE=manifest",
      "--env",
      "MILL_STATIC_ROOT=/app/apps/web/dist",
      "mill",
      "node",
      "--input-type=module",
      "-e",
      await readFile(resolve(root, "tools/static-smoke.mjs"), "utf8"),
    ],
  );
  const staticContent = JSON.parse(builtStaticManifest);
  assert.equal(staticContent.format, "mill-static-content-v1");
  await writeFile(staticManifest, JSON.stringify(staticContent, null, 2));
  const verifyEnv = {
    MILL_VERIFY_URL: primary.url,
    MILL_VERIFY_PASSWORD: secrets[2],
    MILL_VERIFY_STATE: state,
    MILL_VERIFY_STATIC_MANIFEST: staticManifest,
  };
  await run("fresh-install-journey", "node", ["tools/install-smoke.mjs"], {
    ...verifyEnv,
    MILL_VERIFY_MODE: "fresh",
  });
  const user = await run("image-non-root", "docker", [
    "image",
    "inspect",
    image,
    "--format",
    "{{.Config.User}}",
  ]);
  assert.equal(user, "node");
  await run("runtime-production-dependencies", "docker", [
    ...primary.compose,
    "exec",
    "-T",
    "mill",
    "node",
    "--input-type=module",
    "-e",
    "import assert from 'node:assert/strict';import{existsSync}from'node:fs';assert.equal(existsSync('/app/node_modules/typescript'),false);assert.equal(existsSync('/usr/local/lib/node_modules/npm'),false);",
  ]);
  await run(
    "persistent-container-recreation",
    "docker",
    [
      ...primary.compose,
      "up",
      "--no-build",
      "--force-recreate",
      "--detach",
      "--wait",
      "mill",
    ],
    {},
    240_000,
  );
  await run(
    "restart-persistence",
    "node",
    ["tools/install-smoke.mjs"],
    verifyEnv,
  );
  await run("database-fault-stop", "docker", [
    ...primary.compose,
    "stop",
    "--timeout",
    "10",
    "postgres",
  ]);
  await run(
    "database-fault-health",
    "node",
    ["tools/health-smoke.mjs", "unavailable"],
    verifyEnv,
    15_000,
  );
  await run(
    "database-fault-restart",
    "docker",
    [
      ...primary.compose,
      "up",
      "--detach",
      "--wait",
      "--wait-timeout",
      "120",
      "postgres",
    ],
    {},
    150_000,
  );
  await run(
    "database-recovered-health",
    "node",
    ["tools/health-smoke.mjs", "recovered"],
    verifyEnv,
    15_000,
  );
  await run(
    "database-recovered-persistence",
    "node",
    ["tools/install-smoke.mjs"],
    verifyEnv,
  );
  await run("upgrade-stop", "docker", [...primary.compose, "stop", "mill"]);
  const previousMigrationsQuery = `SELECT json_agg(json_build_object('name',name,'checksum',checksum,'appliedAt',applied_at) ORDER BY name)::text
    FROM mill_migrations WHERE name NOT IN ('005_permanent_deletion.sql','006_task_activity_only.sql')`;
  const previousMigrations = JSON.parse(
    await run(
      "upgrade-existing-migrations",
      "docker",
      databaseArguments(primary, previousMigrationsQuery),
    ),
  );
  assert.equal(previousMigrations.length, 4);
  const upgradeFixture = {
    archivedBoardId: randomUUID(),
    deletedBoardId: randomUUID(),
    archivedColumnId: randomUUID(),
    deletedColumnId: randomUUID(),
    archivedTaskId: randomUUID(),
    deletedParentId: randomUUID(),
    deletedChildId: randomUUID(),
    deletedBoardTaskId: randomUUID(),
  };
  const legacyRetry = {
    key: randomUUID(),
    body: { name: "Legacy deleted board", prefix: "DELUP" },
  };
  const legacyRequestHash = createHash("sha256")
    .update(`POST\n/api/boards\n${JSON.stringify(legacyRetry.body)}`)
    .digest("hex");
  const legacyIv = randomBytes(12);
  const legacyCipher = createCipheriv(
    "aes-256-gcm",
    createHash("sha256").update(secrets[1]).digest(),
    legacyIv,
  );
  const legacyCiphertext = Buffer.concat([
    legacyCipher.update(
      JSON.stringify({
        board: { id: upgradeFixture.deletedBoardId, ...legacyRetry.body },
      }),
      "utf8",
    ),
    legacyCipher.final(),
  ]);
  const legacyResponse = {
    iv: legacyIv.toString("base64"),
    tag: legacyCipher.getAuthTag().toString("base64"),
    data: legacyCiphertext.toString("base64"),
  };
  const upgradeState = join(evidence, "upgrade-fixture.json");
  await writeFile(
    upgradeState,
    JSON.stringify({ ...upgradeFixture, legacyRetry }, null, 2),
    { mode: 0o600 },
  );
  const deletedTaskIds = [
    upgradeFixture.deletedParentId,
    upgradeFixture.deletedChildId,
    upgradeFixture.deletedBoardTaskId,
  ]
    .map((id) => `'${id}'::uuid`)
    .join(",");
  // Reconstruct pre-005 local tables and retain every earlier migration record.
  await run(
    "earlier-local-schema",
    "docker",
    databaseArguments(
      primary,
      `BEGIN;
      DROP TRIGGER clean_deleted_board ON boards;
      DROP TRIGGER clean_deleted_task ON tasks;
      DROP FUNCTION clean_deleted_board();
      DROP FUNCTION clean_deleted_task();
      DROP INDEX api_idempotency_boards;
      DROP INDEX api_idempotency_tasks;
      ALTER TABLE api_idempotency DROP COLUMN board_ids, DROP COLUMN task_ids,
        DROP COLUMN invalidation_reason;
      ALTER TABLE boards ADD COLUMN archived boolean NOT NULL DEFAULT false,
        ADD COLUMN deleted_at timestamptz;
      ALTER TABLE tasks ADD COLUMN archived boolean NOT NULL DEFAULT false,
        ADD COLUMN deleted_at timestamptz;
      ALTER TABLE columns DROP CONSTRAINT columns_board_id_fkey,
        ADD FOREIGN KEY (board_id) REFERENCES boards(id);
      ALTER TABLE tasks DROP CONSTRAINT tasks_board_id_fkey,
        DROP CONSTRAINT tasks_column_id_board_id_fkey,
        DROP CONSTRAINT tasks_parent_id_board_id_fkey,
        ADD FOREIGN KEY (board_id) REFERENCES boards(id),
        ADD FOREIGN KEY (column_id,board_id) REFERENCES columns(id,board_id),
        ADD FOREIGN KEY (parent_id,board_id) REFERENCES tasks(id,board_id);
      ALTER TABLE comments DROP CONSTRAINT comments_task_id_fkey,
        ADD FOREIGN KEY (task_id) REFERENCES tasks(id);
      ALTER TABLE activity DROP CONSTRAINT activity_task_board_fkey,
        DROP CONSTRAINT activity_board_id_fkey,
        ALTER COLUMN task_id DROP NOT NULL,
        ALTER COLUMN board_id DROP NOT NULL,
        ADD FOREIGN KEY (task_id) REFERENCES tasks(id),
        ADD FOREIGN KEY (board_id) REFERENCES boards(id);
      ${legacyAuthAuditTable};
      ALTER TABLE notifications DROP CONSTRAINT notifications_task_id_fkey,
        ADD FOREIGN KEY (task_id) REFERENCES tasks(id);
      DELETE FROM mill_migrations WHERE name IN ('005_permanent_deletion.sql','006_task_activity_only.sql');
      INSERT INTO boards (id,workspace_id,name,prefix,position,next_number,archived,deleted_at)
        SELECT '${upgradeFixture.archivedBoardId}',id,'Legacy archived board','ARCHUP',2,4,true,NULL FROM workspace;
      INSERT INTO boards (id,workspace_id,name,prefix,position,next_number,archived,deleted_at)
        SELECT '${upgradeFixture.deletedBoardId}',id,'Legacy deleted board','DELUP',1,2,false,now() FROM workspace;
      INSERT INTO columns (id,board_id,name,position) VALUES
        ('${upgradeFixture.archivedColumnId}','${upgradeFixture.archivedBoardId}','Backlog',0),
        ('${upgradeFixture.deletedColumnId}','${upgradeFixture.deletedBoardId}','Backlog',0);
      INSERT INTO tasks (id,board_id,column_id,identifier,title,position,archived,deleted_at,created_by)
        SELECT '${upgradeFixture.archivedTaskId}','${upgradeFixture.archivedBoardId}',
          '${upgradeFixture.archivedColumnId}','ARCHUP-1','Legacy archived task',2,true,NULL,id
        FROM users WHERE email='install-verifier@example.invalid';
      INSERT INTO tasks (id,board_id,column_id,identifier,title,position,deleted_at,created_by)
        SELECT '${upgradeFixture.deletedParentId}','${upgradeFixture.archivedBoardId}',
          '${upgradeFixture.archivedColumnId}','ARCHUP-2','Legacy deleted parent',0,now(),id
        FROM users WHERE email='install-verifier@example.invalid';
      INSERT INTO tasks (id,board_id,column_id,identifier,title,parent_id,position,created_by)
        SELECT '${upgradeFixture.deletedChildId}','${upgradeFixture.archivedBoardId}',
          '${upgradeFixture.archivedColumnId}','ARCHUP-3','Child of deleted parent',
          '${upgradeFixture.deletedParentId}',1,id FROM users WHERE email='install-verifier@example.invalid';
      INSERT INTO tasks (id,board_id,column_id,identifier,title,position,created_by)
        SELECT '${upgradeFixture.deletedBoardTaskId}','${upgradeFixture.deletedBoardId}',
          '${upgradeFixture.deletedColumnId}','DELUP-1','Task owned by deleted board',0,id
        FROM users WHERE email='install-verifier@example.invalid';
      INSERT INTO comments (task_id,author_id,body)
        SELECT tasks.id,users.id,'Legacy migration content' FROM tasks CROSS JOIN users
        WHERE tasks.id IN ('${upgradeFixture.archivedTaskId}',${deletedTaskIds})
          AND users.email='install-verifier@example.invalid';
      INSERT INTO activity (task_id,board_id,actor_id,actor_name,actor_kind,action)
        SELECT tasks.id,tasks.board_id,users.id,'Upgrade fixture','human','task.created'
        FROM tasks CROSS JOIN users WHERE tasks.id IN (${deletedTaskIds})
          AND users.email='install-verifier@example.invalid';
      INSERT INTO notifications (task_id,user_id,kind,actor_name)
        SELECT tasks.id,users.id,'assignment','Upgrade fixture' FROM tasks CROSS JOIN users
        WHERE tasks.id IN (${deletedTaskIds}) AND users.email='install-member@example.invalid';
      INSERT INTO api_idempotency (actor_key,key,request_hash,response,status)
        SELECT id::text,'${legacyRetry.key}','${legacyRequestHash}','${JSON.stringify(legacyResponse)}'::jsonb,201
        FROM users WHERE email='install-verifier@example.invalid';
      COMMIT;`,
    ),
  );
  const seeded = JSON.parse(
    await run(
      "upgrade-legacy-fixture",
      "docker",
      databaseArguments(
        primary,
        `SELECT json_build_object(
          'archivedBoards',(SELECT count(*) FROM boards WHERE id='${upgradeFixture.archivedBoardId}' AND archived),
          'deletedBoards',(SELECT count(*) FROM boards WHERE id='${upgradeFixture.deletedBoardId}' AND deleted_at IS NOT NULL),
          'archivedTasks',(SELECT count(*) FROM tasks WHERE id='${upgradeFixture.archivedTaskId}' AND archived),
          'deletedParents',(SELECT count(*) FROM tasks WHERE id='${upgradeFixture.deletedParentId}' AND deleted_at IS NOT NULL),
          'children',(SELECT count(*) FROM tasks WHERE id='${upgradeFixture.deletedChildId}' AND parent_id='${upgradeFixture.deletedParentId}' AND deleted_at IS NULL),
          'deletedBoardTasks',(SELECT count(*) FROM tasks WHERE id='${upgradeFixture.deletedBoardTaskId}' AND deleted_at IS NULL),
          'comments',(SELECT count(*) FROM comments WHERE task_id IN ('${upgradeFixture.archivedTaskId}',${deletedTaskIds})),
          'activity',(SELECT count(*) FROM activity WHERE task_id IN (${deletedTaskIds})),
          'notifications',(SELECT count(*) FROM notifications WHERE task_id IN (${deletedTaskIds})),
          'completedLegacyResponses',(SELECT count(*) FROM api_idempotency WHERE key='${legacyRetry.key}' AND status=201 AND response IS NOT NULL),
          'legacyRetryIdentity',(SELECT json_build_object('actorKey',actor_key,'key',key,'requestHash',request_hash,'createdAt',created_at) FROM api_idempotency WHERE key='${legacyRetry.key}')
        )::text`,
      ),
    ),
  );
  const { legacyRetryIdentity, ...seededCounts } = seeded;
  assert.equal(legacyRetryIdentity.key, legacyRetry.key);
  assert.equal(legacyRetryIdentity.requestHash, legacyRequestHash);
  assert.deepEqual(seededCounts, {
    archivedBoards: 1,
    deletedBoards: 1,
    archivedTasks: 1,
    deletedParents: 1,
    children: 1,
    deletedBoardTasks: 1,
    comments: 4,
    activity: 3,
    notifications: 3,
    completedLegacyResponses: 1,
  });
  await run(
    "automatic-schema-upgrade",
    "docker",
    [
      ...primary.compose,
      "up",
      "--no-build",
      "--force-recreate",
      "--detach",
      "--wait",
      "mill",
    ],
    {},
    240_000,
  );
  await run("upgrade-persistence", "node", ["tools/install-smoke.mjs"], {
    ...verifyEnv,
    MILL_VERIFY_UPGRADE_STATE: upgradeState,
  });
  const migrationCount = await run("upgrade-migration-record", "docker", [
    ...primary.compose,
    "exec",
    "-T",
    "postgres",
    "psql",
    "-U",
    "mill",
    "-d",
    "mill",
    "--tuples-only",
    "--no-align",
    "-c",
    "SELECT checksum FROM mill_migrations WHERE name='005_permanent_deletion.sql'",
  ]);
  const upgradeChecksum = createHash("sha256")
    .update(
      await readFile(
        join(root, "packages/database/migrations/005_permanent_deletion.sql"),
      ),
    )
    .digest("hex");
  assert.equal(migrationCount, upgradeChecksum);
  assert.deepEqual(
    JSON.parse(
      await run(
        "upgrade-previous-checksums",
        "docker",
        databaseArguments(primary, previousMigrationsQuery),
      ),
    ),
    previousMigrations,
  );
  const upgradedFixtureQuery = `SELECT json_build_object(
    'archivedBoardsActive',(SELECT count(*) FROM boards WHERE id='${upgradeFixture.archivedBoardId}' AND position=1),
    'archivedTasksActive',(SELECT count(*) FROM tasks WHERE id='${upgradeFixture.archivedTaskId}' AND position=0),
    'archivedCommentsKept',(SELECT count(*) FROM comments WHERE task_id='${upgradeFixture.archivedTaskId}'),
    'deletedBoardsRemaining',(SELECT count(*) FROM boards WHERE id='${upgradeFixture.deletedBoardId}'),
    'deletedColumnsRemaining',(SELECT count(*) FROM columns WHERE id='${upgradeFixture.deletedColumnId}'),
    'deletedTasksRemaining',(SELECT count(*) FROM tasks WHERE id IN (${deletedTaskIds})),
    'deletedCommentsRemaining',(SELECT count(*) FROM comments WHERE task_id IN (${deletedTaskIds})),
    'deletedActivityRemaining',(SELECT count(*) FROM activity WHERE task_id IN (${deletedTaskIds}) OR board_id='${upgradeFixture.deletedBoardId}'),
    'deletedNotificationsRemaining',(SELECT count(*) FROM notifications WHERE task_id IN (${deletedTaskIds})),
    'legacyTombstones',(SELECT count(*) FROM api_idempotency WHERE key='${legacyRetry.key}' AND status=410 AND invalidation_reason='upgrade' AND response IS NULL AND board_ids='{}'::uuid[] AND task_ids='{}'::uuid[]),
    'legacyResponsesRemaining',(SELECT count(*) FROM api_idempotency WHERE key='${legacyRetry.key}' AND response IS NOT NULL),
    'legacyRetryIdentity',(SELECT json_build_object('actorKey',actor_key,'key',key,'requestHash',request_hash,'createdAt',created_at) FROM api_idempotency WHERE key='${legacyRetry.key}'),
    'legacyColumns',(SELECT count(*) FROM information_schema.columns WHERE table_schema=current_schema() AND table_name IN ('boards','tasks') AND column_name IN ('archived','deleted_at')),
    'migration005Checksum',(SELECT checksum FROM mill_migrations WHERE name='005_permanent_deletion.sql'),
    'previousMigrations',(${previousMigrationsQuery})::json
  )::text`;
  const expectedUpgradedFixture = {
    archivedBoardsActive: 1,
    archivedTasksActive: 1,
    archivedCommentsKept: 1,
    deletedBoardsRemaining: 0,
    deletedColumnsRemaining: 0,
    deletedTasksRemaining: 0,
    deletedCommentsRemaining: 0,
    deletedActivityRemaining: 0,
    deletedNotificationsRemaining: 0,
    legacyTombstones: 1,
    legacyResponsesRemaining: 0,
    legacyRetryIdentity,
    legacyColumns: 0,
    migration005Checksum: upgradeChecksum,
    previousMigrations,
  };
  assert.deepEqual(
    JSON.parse(
      await run(
        "upgrade-permanent-deletion",
        "docker",
        databaseArguments(primary, upgradedFixtureQuery),
      ),
    ),
    expectedUpgradedFixture,
  );
  await run("task-history-upgrade-stop", "docker", [
    ...primary.compose,
    "stop",
    "mill",
  ]);
  const taskHistoryPreviousMigrationsQuery = `SELECT json_agg(json_build_object('name',name,'checksum',checksum,'appliedAt',applied_at) ORDER BY name)::text
    FROM mill_migrations WHERE name<>'006_task_activity_only.sql'`;
  const taskHistoryPreviousMigrations = JSON.parse(
    await run(
      "task-history-existing-migrations",
      "docker",
      databaseArguments(primary, taskHistoryPreviousMigrationsQuery),
    ),
  );
  assert.equal(taskHistoryPreviousMigrations.length, 5);
  assert.deepEqual(
    taskHistoryPreviousMigrations.slice(0, 4),
    previousMigrations,
  );
  assert.equal(taskHistoryPreviousMigrations[4].checksum, upgradeChecksum);
  const originalFixture = JSON.parse(await readFile(state, "utf8"));
  const historyFixture = {
    humanId: randomUUID(),
    agentId: randomUUID(),
    missingBoardId: randomUUID(),
  };
  // Reconstruct only pre-006 history storage; keep 001–005 untouched.
  await run(
    "earlier-task-history-schema",
    "docker",
    databaseArguments(
      primary,
      `BEGIN;
      ALTER TABLE activity DROP CONSTRAINT activity_task_board_fkey,
        ALTER COLUMN task_id DROP NOT NULL,
        ALTER COLUMN board_id DROP NOT NULL,
        ADD FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE;
      ${legacyAuthAuditTable};
      DELETE FROM mill_migrations WHERE name='006_task_activity_only.sql';
      INSERT INTO auth_audit (id,user_id,actor_name,action,detail)
        SELECT gen_random_uuid(),id,'Legacy administrator',event.action,'{"fixture":"legacy-global-auth"}'::jsonb
        FROM users CROSS JOIN (VALUES ('login'),('profile.updated')) AS event(action)
        WHERE email='install-verifier@example.invalid';
      INSERT INTO activity (board_id,actor_id,actor_name,actor_kind,action,detail)
        SELECT event.board_id,id,'Legacy workspace actor','human',event.action,'{"fixture":"legacy-global-activity"}'::jsonb
        FROM users CROSS JOIN (VALUES ('${upgradeFixture.archivedBoardId}'::uuid,'board.created'),
          (NULL::uuid,'workspace.updated')) AS event(board_id,action)
        WHERE email='install-verifier@example.invalid';
      INSERT INTO activity (id,task_id,board_id,actor_id,actor_name,actor_kind,action,detail,created_at)
        SELECT event.id,'${upgradeFixture.archivedTaskId}',event.board_id,users.id,
          event.actor_name,event.actor_kind,event.action,event.detail,event.created_at
        FROM users CROSS JOIN (VALUES
          ('${historyFixture.humanId}'::uuid,'${originalFixture.boardId}'::uuid,'Upgrade history person','human',
            'task.updated','{"fields":["title"],"title":"Legacy archived task"}'::jsonb,'2001-01-01T00:00:00Z'::timestamptz),
          ('${historyFixture.agentId}'::uuid,'${upgradeFixture.archivedBoardId}'::uuid,'Upgrade history agent','agent',
            'comment.created','{"body":"Historical agent comment"}'::jsonb,'2001-01-02T00:00:00Z'::timestamptz),
          ('${historyFixture.missingBoardId}'::uuid,NULL::uuid,'Upgrade history person','human',
            'task.moved','{"column":"Backlog"}'::jsonb,'2001-01-03T00:00:00Z'::timestamptz)
        ) AS event(id,board_id,actor_name,actor_kind,action,detail,created_at)
        WHERE users.email='install-verifier@example.invalid';
      COMMIT;`,
    ),
  );
  const normalizedTaskHistoryQuery = `SELECT jsonb_agg(to_jsonb(activity)||jsonb_build_object('board_id',tasks.board_id) ORDER BY activity.id)::text
    FROM activity JOIN tasks ON tasks.id=activity.task_id`;
  const historyBefore = JSON.parse(
    await run(
      "task-history-legacy-fixture",
      "docker",
      databaseArguments(
        primary,
        `SELECT json_build_object(
          'authAudit',(SELECT count(*) FROM auth_audit),
          'globalActivity',(SELECT count(*) FROM activity WHERE task_id IS NULL),
          'incorrectBoardReferences',(SELECT count(*) FROM activity JOIN tasks ON tasks.id=activity.task_id WHERE activity.board_id IS DISTINCT FROM tasks.board_id),
          'taskHistory',(${normalizedTaskHistoryQuery})::json,
          'previousMigrations',(${taskHistoryPreviousMigrationsQuery})::json
        )::text`,
      ),
    ),
  );
  assert.equal(historyBefore.authAudit, 2);
  assert.equal(historyBefore.globalActivity, 2);
  assert.equal(historyBefore.incorrectBoardReferences, 2);
  assert.deepEqual(
    historyBefore.previousMigrations,
    taskHistoryPreviousMigrations,
  );
  const expectedTaskHistory = historyBefore.taskHistory;
  const historyIds = Object.values(historyFixture);
  assert.equal(
    expectedTaskHistory.filter((item) => historyIds.includes(item.id)).length,
    3,
  );
  assert.ok(
    expectedTaskHistory.some(
      (item) =>
        item.task_id === originalFixture.taskId &&
        item.action === "task.created",
    ),
    "Fresh-install task creation history exists before upgrade",
  );
  await writeFile(
    upgradeState,
    JSON.stringify(
      {
        ...upgradeFixture,
        legacyRetry,
        taskHistory: expectedTaskHistory.filter((item) =>
          historyIds.includes(item.id),
        ),
      },
      null,
      2,
    ),
    { mode: 0o600 },
  );
  await run(
    "automatic-task-history-upgrade",
    "docker",
    [
      ...primary.compose,
      "up",
      "--no-build",
      "--force-recreate",
      "--detach",
      "--wait",
      "mill",
    ],
    {},
    240_000,
  );
  const taskHistoryChecksum = createHash("sha256")
    .update(
      await readFile(
        join(root, "packages/database/migrations/006_task_activity_only.sql"),
      ),
    )
    .digest("hex");
  const taskHistoryQuery = `SELECT json_build_object(
    'authAuditRemoved',to_regclass('auth_audit') IS NULL,
    'globalActivityRemaining',(SELECT count(*) FROM activity WHERE task_id IS NULL),
    'incorrectBoardReferences',(SELECT count(*) FROM activity JOIN tasks ON tasks.id=activity.task_id WHERE activity.board_id IS DISTINCT FROM tasks.board_id),
    'requiredTaskOwnership',(SELECT count(*) FROM information_schema.columns WHERE table_schema=current_schema() AND table_name='activity' AND column_name IN ('task_id','board_id') AND is_nullable='NO'),
    'taskBoardConstraint',(SELECT count(*) FROM pg_constraint WHERE conrelid='activity'::regclass AND conname='activity_task_board_fkey' AND contype='f' AND confrelid='tasks'::regclass AND confdeltype='c' AND convalidated
      AND conkey=ARRAY[(SELECT attnum FROM pg_attribute WHERE attrelid='activity'::regclass AND attname='task_id'),(SELECT attnum FROM pg_attribute WHERE attrelid='activity'::regclass AND attname='board_id')]
      AND confkey=ARRAY[(SELECT attnum FROM pg_attribute WHERE attrelid='tasks'::regclass AND attname='id'),(SELECT attnum FROM pg_attribute WHERE attrelid='tasks'::regclass AND attname='board_id')]),
    'taskHistory',(${normalizedTaskHistoryQuery})::json,
    'migration006Checksum',(SELECT checksum FROM mill_migrations WHERE name='006_task_activity_only.sql'),
    'previousMigrations',(${taskHistoryPreviousMigrationsQuery})::json
  )::text`;
  const expectedTaskHistoryState = {
    authAuditRemoved: true,
    globalActivityRemaining: 0,
    incorrectBoardReferences: 0,
    requiredTaskOwnership: 2,
    taskBoardConstraint: 1,
    taskHistory: expectedTaskHistory,
    migration006Checksum: taskHistoryChecksum,
    previousMigrations: taskHistoryPreviousMigrations,
  };
  assert.deepEqual(
    JSON.parse(
      await run(
        "upgrade-task-history",
        "docker",
        databaseArguments(primary, taskHistoryQuery),
      ),
    ),
    expectedTaskHistoryState,
  );
  await run(
    "task-history-upgrade-persistence",
    "node",
    ["tools/install-smoke.mjs"],
    {
      ...verifyEnv,
      MILL_VERIFY_UPGRADE_STATE: upgradeState,
    },
  );
  assert.deepEqual(
    JSON.parse(
      await run(
        "task-history-upgrade-permanent-deletion",
        "docker",
        databaseArguments(primary, upgradedFixtureQuery),
      ),
    ),
    expectedUpgradedFixture,
  );
  await run("backup-full-database", "bash", [
    "tools/backup.sh",
    "--project",
    project,
    "--env-file",
    primary.envFile,
    "--output",
    backup,
  ]);
  const recovery = await configuration(recoveryProject, await port());
  await run(
    "empty-recovery-postgres",
    "docker",
    [...recovery.compose, "up", "--detach", "--wait", "postgres"],
    {},
    240_000,
  );
  await run(
    "restore-full-database",
    "bash",
    [
      "tools/restore.sh",
      "--project",
      recoveryProject,
      "--confirm-project",
      recoveryProject,
      "--env-file",
      recovery.envFile,
      "--input",
      backup,
    ],
    {},
    240_000,
  );
  await run("restored-data-journey", "node", ["tools/install-smoke.mjs"], {
    ...verifyEnv,
    MILL_VERIFY_URL: recovery.url,
    MILL_VERIFY_UPGRADE_STATE: upgradeState,
  });
  assert.deepEqual(
    JSON.parse(
      await run(
        "restored-permanent-deletion",
        "docker",
        databaseArguments(recovery, upgradedFixtureQuery),
      ),
    ),
    expectedUpgradedFixture,
  );
  assert.deepEqual(
    JSON.parse(
      await run(
        "restored-task-history",
        "docker",
        databaseArguments(recovery, taskHistoryQuery),
      ),
    ),
    expectedTaskHistoryState,
  );
  await run(
    "production-image-security",
    "docker",
    [
      "run",
      "--rm",
      "--name",
      `${project}-scanner`,
      "--label",
      `mill.verification=${project}`,
      "--cpus",
      "2",
      "--memory",
      "2g",
      "--volume",
      "/var/run/docker.sock:/var/run/docker.sock",
      "--volume",
      `${scannerCache}:/root/.cache/trivy`,
      "--volume",
      `${evidence}:/verification`,
      "aquasec/trivy:0.74.0@sha256:62b1e65e8869bc4b4c6aa4fa2b21595256c7c2f6018a9d9ad61caf87187c1969",
      "image",
      "--scanners",
      "vuln",
      "--severity",
      "HIGH,CRITICAL",
      "--exit-code",
      "1",
      "--format",
      "json",
      "--output",
      "/verification/image-vulnerabilities.json",
      image,
    ],
    {},
    600_000,
  );
  const fixture = JSON.parse(await readFile(state, "utf8"));
  await writeFile(
    join(evidence, "evidence.json"),
    JSON.stringify(
      {
        project,
        image,
        sourceRevision,
        sourceDirty,
        primaryUrl: primary.url,
        fixture,
        staticContent: {
          manifest: "static-content-manifest.json",
          resources: staticContent.resources.length,
          verification:
            "Container-built notices, all guides and their local CSS/font resource closure match anonymous HTTP bytes across installation, database outage/recovery, upgrade and restore",
        },
        schemaUpgrade:
          "Reconstructed pre-005 local schema; packaged migrations keep archived work active, permanently purge deleted work and retain content-free terminal retry tombstones. A separate pre-006 reconstruction seeds auth/workspace events plus human/agent task history, verifies removal of global history, repair/enforcement of task board ownership, preservation of all task activity fields, exact source migration checksums and unchanged 001–005 records",
        upgradeFixture: {
          ...upgradeFixture,
          legacyRetry,
          migrationChecksum: upgradeChecksum,
          previousMigrations,
          verifiedDatabaseState: expectedUpgradedFixture,
        },
        taskHistoryUpgrade: {
          ...historyFixture,
          migrationChecksum: taskHistoryChecksum,
          previousMigrations: taskHistoryPreviousMigrations,
          verifiedDatabaseState: expectedTaskHistoryState,
        },
        restore:
          "Post-upgrade custom-format pg_dump restored transactionally into a separate empty project; password login, original task/comment/member data, activated archived work, permanent legacy deletion, terminal stale-create retry, absent global audit storage/endpoint and unchanged human/agent task history verified",
        cookieLimit:
          "Explicitly forwarded disposable cookies on loopback HTTP; this does not prove browser Secure-cookie policy or physical passkeys",
        completedAt: new Date().toISOString(),
      },
      null,
      2,
    ),
  );
  console.log(`Production verification evidence: ${evidence}`);
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
  if (primary) {
    await run(
      "failure-container-state",
      "docker",
      [...primary.compose, "ps", "--all"],
      {},
      30_000,
      true,
    ).catch(() => {});
  }
} finally {
  for (const [index, compose] of projects.entries()) {
    await run(
      `cleanup-project-${index}`,
      "docker",
      [...compose, "down", "--volumes", "--remove-orphans", "--timeout", "20"],
      {},
      60_000,
      true,
    ).catch((error) => {
      console.error(error.message);
      process.exitCode = 1;
    });
  }
  const imageId = await run(
    "cleanup-image-inventory",
    "docker",
    ["image", "ls", "--quiet", image],
    {},
    30_000,
    true,
  ).catch(() => "");
  if (imageId)
    await run(
      "cleanup-image",
      "docker",
      ["image", "rm", image],
      {},
      60_000,
      true,
    ).catch((error) => {
      console.error(error.message);
      process.exitCode = 1;
    });
  const scannerId = await run(
    "cleanup-scanner-inventory",
    "docker",
    [
      "container",
      "ls",
      "--all",
      "--quiet",
      "--filter",
      `label=mill.verification=${project}`,
    ],
    {},
    30_000,
    true,
  ).catch(() => "");
  if (scannerId)
    await run(
      "cleanup-scanner",
      "docker",
      ["container", "rm", "--force", scannerId],
      {},
      30_000,
      true,
    ).catch((error) => {
      console.error(error.message);
      process.exitCode = 1;
    });
  const cache = await run(
    "cleanup-cache-inventory",
    "docker",
    ["volume", "ls", "--quiet", "--filter", `name=^${scannerCache}$`],
    {},
    30_000,
    true,
  ).catch(() => "");
  if (cache)
    await run(
      "cleanup-scanner-cache",
      "docker",
      ["volume", "rm", scannerCache],
      {},
      30_000,
      true,
    ).catch((error) => {
      console.error(error.message);
      process.exitCode = 1;
    });
  await rm(privateDirectory, { recursive: true, force: true });
}

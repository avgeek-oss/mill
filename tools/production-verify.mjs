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
function packagedMigrationArguments(configuration, through) {
  assert.ok([5, 6, 7].includes(through));
  return [
    ...configuration.compose,
    "run",
    "--rm",
    "--no-deps",
    "--entrypoint",
    "node",
    "mill",
    "--input-type=module",
    "-e",
    `import assert from 'node:assert/strict';
    import {copyFile,mkdtemp,readdir,rm} from 'node:fs/promises';
    import {tmpdir} from 'node:os';import {join} from 'node:path';
    const source='/app/packages/database/migrations';
    const directory=await mkdtemp(join(tmpdir(),'mill-migration-stage-'));
    const names=(await readdir(source)).filter(name=>/^\\d{3}_.*\\.sql$/.test(name)&&Number(name.slice(0,3))<=${through}).sort();
    assert.equal(names.length,${through});
    process.env.MILL_MIGRATIONS_DIR=directory;
    const {migrate}=await import('/app/dist/packages/database/src/migrate.js');
    const {closeDatabase}=await import('/app/dist/packages/database/src/index.js');
    try{for(const name of names)await copyFile(join(source,name),join(directory,name));
      await migrate();console.log(JSON.stringify({packagedMigrations:names}));
    }finally{await closeDatabase();await rm(directory,{recursive:true,force:true});}`,
  ];
}
function encryptedLegacyResponse(value) {
  const iv = randomBytes(12);
  const cipher = createCipheriv(
    "aes-256-gcm",
    createHash("sha256").update(secrets[1]).digest(),
    iv,
  );
  const ciphertext = Buffer.concat([
    cipher.update(JSON.stringify(value), "utf8"),
    cipher.final(),
  ]);
  return {
    iv: iv.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
    data: ciphertext.toString("base64"),
  };
}
function sqlString(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
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
  const originalFixture = JSON.parse(await readFile(state, "utf8"));
  const originalContentQuery = `SELECT json_build_object(
    'task',(SELECT json_build_object('id',id,'boardId',board_id,'identifier',identifier,'title',title,'description',description,'checklist',checklist,'priority',priority,'assigneeId',assignee_id,'dueDate',due_date,'createdBy',created_by,'createdAt',created_at) FROM tasks WHERE id='${originalFixture.taskId}'),
    'comments',(SELECT jsonb_agg(to_jsonb(comments) ORDER BY id) FROM comments WHERE task_id='${originalFixture.taskId}'),
    'member',(SELECT json_build_object('id',id,'name',name,'email',email,'role',role) FROM users WHERE id='${originalFixture.memberId}')
  )::text`;
  const originalContent = JSON.parse(
    await run(
      "upgrade-original-content",
      "docker",
      databaseArguments(primary, originalContentQuery),
    ),
  );
  await run(
    "earlier-board-structure",
    "docker",
    databaseArguments(
      primary,
      `BEGIN;
      DROP INDEX tasks_board_created;
      DROP INDEX tasks_board_status_created;
      DROP INDEX boards_name;
      ALTER TABLE boards ADD COLUMN position integer NOT NULL DEFAULT 0 CHECK(position>=0);
      CREATE TABLE columns (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        board_id uuid NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
        name text NOT NULL CHECK(length(name) BETWEEN 1 AND 80),
        color text NOT NULL DEFAULT 'gray',
        position integer NOT NULL CHECK(position>=0),
        version integer NOT NULL DEFAULT 1,
        UNIQUE(id,board_id)
      );
      INSERT INTO columns (board_id,name,position)
        SELECT boards.id,status.name,status.position FROM boards CROSS JOIN
        (VALUES ('backlog','Backlog',0),('todo','To do',1),('in_progress','In progress',2),
          ('in_review','In review',3),('done','Done',4),('wont_do','Won''t do',5))
        AS status(value,name,position);
      ALTER TABLE tasks ADD COLUMN column_id uuid,
        ADD COLUMN labels text[] NOT NULL DEFAULT '{}',
        ADD COLUMN parent_id uuid,
        ADD COLUMN position integer NOT NULL DEFAULT 0 CHECK(position>=0);
      UPDATE tasks SET column_id=columns.id FROM columns WHERE columns.board_id=tasks.board_id
        AND columns.name=CASE tasks.status WHEN 'backlog' THEN 'Backlog' WHEN 'todo' THEN 'To do'
          WHEN 'in_progress' THEN 'In progress' WHEN 'in_review' THEN 'In review'
          WHEN 'done' THEN 'Done' WHEN 'wont_do' THEN 'Won''t do' END;
      ALTER TABLE tasks ALTER COLUMN column_id SET NOT NULL,
        ADD FOREIGN KEY(column_id,board_id) REFERENCES columns(id,board_id),
        ADD FOREIGN KEY(parent_id,board_id) REFERENCES tasks(id,board_id) ON DELETE CASCADE,
        ADD CHECK(parent_id IS NULL OR parent_id<>id),
        DROP COLUMN status;
      CREATE INDEX tasks_board_order ON tasks(board_id,column_id,position,id);
      DELETE FROM mill_migrations WHERE name='007_fixed_task_statuses.sql';
      COMMIT;`,
    ),
  );
  const previousMigrationsQuery = `SELECT json_agg(json_build_object('name',name,'checksum',checksum,'appliedAt',applied_at) ORDER BY name)::text
    FROM mill_migrations WHERE name NOT IN ('005_permanent_deletion.sql','006_task_activity_only.sql','007_fixed_task_statuses.sql')`;
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
  const legacyResponse = encryptedLegacyResponse({
    board: { id: upgradeFixture.deletedBoardId, ...legacyRetry.body },
  });
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
    packagedMigrationArguments(primary, 5),
    {},
    240_000,
  );
  assert.deepEqual(
    JSON.parse(
      await run(
        "upgrade-persistence",
        "docker",
        databaseArguments(primary, originalContentQuery),
      ),
    ),
    originalContent,
  );
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
    FROM mill_migrations WHERE name NOT IN ('006_task_activity_only.sql','007_fixed_task_statuses.sql')`;
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
  const historyFixture = {
    humanId: randomUUID(),
    agentId: randomUUID(),
    missingBoardId: randomUUID(),
  };
  // Packaged migration 005 leaves a legitimate pre-006 schema with 001–005 untouched.
  await run(
    "earlier-task-history-schema",
    "docker",
    databaseArguments(
      primary,
      `BEGIN;
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
    packagedMigrationArguments(primary, 6),
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
  assert.deepEqual(
    JSON.parse(
      await run(
        "task-history-upgrade-persistence",
        "docker",
        databaseArguments(primary, originalContentQuery),
      ),
    ),
    originalContent,
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
  const simplificationBoardId = randomUUID();
  const statusCases = [
    ["Backlog", "backlog"],
    ["To do", "todo"],
    ["In progress", "in_progress"],
    ["In review", "in_review"],
    ["Done", "done"],
    ["Won't do", "wont_do"],
    ["Custom review queue", "todo"],
  ].map(([legacyName, status], index) => ({
    legacyName,
    status,
    columnId: randomUUID(),
    taskId: randomUUID(),
    title:
      index === 6 ? "Former child retained" : `Preserved ${legacyName} task`,
    description: `Legacy **${legacyName}** description must survive.`,
    checklist: [
      {
        id: "legacy-check",
        text: `Keep ${legacyName} content`,
        done: index % 2 === 0,
      },
    ],
  }));
  const simplificationRetry = {
    key: randomUUID(),
    path: `/api/boards/${simplificationBoardId}/tasks`,
    body: {
      title: statusCases[6].title,
      columnId: statusCases[6].columnId,
      parentId: statusCases[0].taskId,
    },
  };
  const simplificationRequestHash = createHash("sha256")
    .update(
      `POST\n${simplificationRetry.path}\n${JSON.stringify(simplificationRetry.body)}`,
    )
    .digest("hex");
  const simplificationResponse = encryptedLegacyResponse({
    task: {
      id: statusCases[6].taskId,
      boardId: simplificationBoardId,
      ...simplificationRetry.body,
      labels: ["legacy"],
      position: 6,
    },
  });
  const simplificationPreviousMigrationsQuery = `SELECT json_agg(json_build_object('name',name,'checksum',checksum,'appliedAt',applied_at) ORDER BY name)::text
    FROM mill_migrations WHERE name<>'007_fixed_task_statuses.sql'`;
  const simplificationPreviousMigrations = JSON.parse(
    await run(
      "simplification-existing-migrations",
      "docker",
      databaseArguments(primary, simplificationPreviousMigrationsQuery),
    ),
  );
  assert.equal(simplificationPreviousMigrations.length, 6);
  assert.deepEqual(
    simplificationPreviousMigrations.slice(0, 5),
    taskHistoryPreviousMigrations,
  );
  assert.equal(
    simplificationPreviousMigrations[5].checksum,
    taskHistoryChecksum,
  );
  const legacyTasksSql = statusCases
    .map(
      (item, index) => `
    INSERT INTO tasks (id,board_id,column_id,identifier,title,description,assignee_id,priority,labels,due_date,checklist,parent_id,position,created_by)
      SELECT '${item.taskId}','${simplificationBoardId}','${item.columnId}','SIMUP-${index + 1}',
        ${sqlString(item.title)},${sqlString(item.description)},member.id,'medium',ARRAY['legacy'],'2027-01-01'::date,
        ${sqlString(JSON.stringify(item.checklist))}::jsonb,${index === 6 ? `'${statusCases[0].taskId}'::uuid` : "NULL::uuid"},${index},administrator.id
      FROM users AS administrator CROSS JOIN users AS member
      WHERE administrator.email='install-verifier@example.invalid' AND member.email='install-member@example.invalid';`,
    )
    .join("\n");
  await run(
    "simplification-legacy-fixture",
    "docker",
    databaseArguments(
      primary,
      `BEGIN;
    INSERT INTO boards (id,workspace_id,name,prefix,description,position,next_number)
      SELECT '${simplificationBoardId}',id,'Legacy simplified board','SIMUP','Preserve existing work',2,8 FROM workspace;
    INSERT INTO columns (id,board_id,name,position) VALUES
      ${statusCases.map((item, index) => `('${item.columnId}','${simplificationBoardId}',${sqlString(item.legacyName)},${index})`).join(",")};
    ${legacyTasksSql}
    INSERT INTO comments (task_id,author_id,body)
      SELECT tasks.id,users.id,'Keep original comment for '||tasks.identifier FROM tasks CROSS JOIN users
      WHERE tasks.board_id='${simplificationBoardId}' AND users.email='install-verifier@example.invalid';
    INSERT INTO activity (task_id,board_id,actor_id,actor_name,actor_kind,action,detail)
      SELECT tasks.id,tasks.board_id,users.id,'Legacy task person','human','task.created',jsonb_build_object('title',tasks.title,'identifier',tasks.identifier)
      FROM tasks CROSS JOIN users WHERE tasks.board_id='${simplificationBoardId}' AND users.email='install-verifier@example.invalid';
    INSERT INTO activity (task_id,board_id,actor_id,actor_name,actor_kind,action,detail)
      SELECT '${statusCases[3].taskId}','${simplificationBoardId}',id,'Legacy task agent','agent','task.moved',
        jsonb_build_object('columnId','${statusCases[3].columnId}','fromColumnId','${statusCases[0].columnId}',
          'status','In review','position',3,'parentId','${statusCases[0].taskId}','labels',jsonb_build_array('legacy'),
          'fields',jsonb_build_array('columnId','description','labels'))
      FROM users WHERE email='install-verifier@example.invalid';
    UPDATE users SET notification_preferences='{"assignments":false,"mentions":true,"email":true}'::jsonb
      WHERE email='install-member@example.invalid';
    INSERT INTO api_idempotency (actor_key,key,request_hash,response,status,board_ids,task_ids)
      SELECT id::text,'${simplificationRetry.key}','${simplificationRequestHash}',
        ${sqlString(JSON.stringify(simplificationResponse))}::jsonb,201,
        ARRAY['${simplificationBoardId}'::uuid],ARRAY['${statusCases[6].taskId}'::uuid]
      FROM users WHERE email='install-verifier@example.invalid';
    COMMIT;`,
    ),
  );
  const simplificationDataQuery = `SELECT json_build_object(
    'boards',(SELECT jsonb_agg(to_jsonb(boards)-'position' ORDER BY id) FROM boards),
    'tasks',(SELECT jsonb_agg(to_jsonb(tasks)-'column_id'-'labels'-'parent_id'-'position' ORDER BY id) FROM tasks),
    'comments',(SELECT jsonb_agg(to_jsonb(comments) ORDER BY id) FROM comments),
    'activity',(SELECT jsonb_agg(to_jsonb(activity) ORDER BY id) FROM activity),
    'inAppPreferences',(SELECT json_agg(json_build_object('id',id,'preferences',notification_preferences-'email') ORDER BY id) FROM users),
    'previousMigrations',(${simplificationPreviousMigrationsQuery})::json,
    'retryIdentity',(SELECT json_build_object('actorKey',actor_key,'key',key,'requestHash',request_hash,'createdAt',created_at) FROM api_idempotency WHERE key='${simplificationRetry.key}')
  )::text`;
  const simplificationBefore = JSON.parse(
    await run(
      "simplification-original-content",
      "docker",
      databaseArguments(
        primary,
        `SELECT json_build_object(
    'data',(${simplificationDataQuery})::json,
    'formerChildren',(SELECT count(*) FROM tasks WHERE id='${statusCases[6].taskId}' AND parent_id='${statusCases[0].taskId}'),
    'legacyLabels',(SELECT count(*) FROM tasks WHERE board_id='${simplificationBoardId}' AND labels=ARRAY['legacy']),
    'legacyEmailPreferences',(SELECT count(*) FROM users WHERE notification_preferences ? 'email'),
    'completedResponses',(SELECT count(*) FROM api_idempotency WHERE key='${simplificationRetry.key}' AND status=201 AND response IS NOT NULL AND invalidation_reason IS NULL)
  )::text`,
      ),
    ),
  );
  assert.equal(simplificationBefore.formerChildren, 1);
  assert.equal(simplificationBefore.legacyLabels, 7);
  assert.equal(simplificationBefore.legacyEmailPreferences, 1);
  assert.equal(simplificationBefore.completedResponses, 1);
  const expectedSimplificationData = simplificationBefore.data;
  assert.equal(expectedSimplificationData.tasks.length, 9);
  assert.deepEqual(
    expectedSimplificationData.previousMigrations,
    simplificationPreviousMigrations,
  );
  assert.equal(
    expectedSimplificationData.retryIdentity.requestHash,
    simplificationRequestHash,
  );
  expectedSimplificationData.tasks = expectedSimplificationData.tasks.map(
    (item) => ({
      ...item,
      status:
        item.id === originalFixture.taskId
          ? "todo"
          : item.id === upgradeFixture.archivedTaskId
            ? "backlog"
            : statusCases.find((entry) => entry.taskId === item.id)?.status,
    }),
  );
  assert.ok(expectedSimplificationData.tasks.every((item) => item.status));
  await run(
    "packaged-simplification-upgrade",
    "docker",
    packagedMigrationArguments(primary, 7),
    {},
    240_000,
  );
  const simplificationChecksum = createHash("sha256")
    .update(
      await readFile(
        join(root, "packages/database/migrations/007_fixed_task_statuses.sql"),
      ),
    )
    .digest("hex");
  const simplificationQuery = `SELECT json_build_object(
    'data',(${simplificationDataQuery})::json,
    'columnsRemoved',to_regclass('columns') IS NULL,
    'legacyStorageColumns',(SELECT count(*) FROM information_schema.columns WHERE table_schema=current_schema() AND ((table_name='tasks' AND column_name IN ('column_id','labels','parent_id','position')) OR (table_name='boards' AND column_name='position'))),
    'emailPreferencesRemaining',(SELECT count(*) FROM users WHERE notification_preferences ? 'email'),
    'statuses',(SELECT json_agg(status ORDER BY status) FROM (SELECT DISTINCT status FROM tasks) AS available),
    'terminalRetries',(SELECT count(*) FROM api_idempotency WHERE key='${simplificationRetry.key}' AND status=410 AND invalidation_reason='upgrade' AND response IS NULL AND board_ids='{}'::uuid[] AND task_ids='{}'::uuid[]),
    'migration007Checksum',(SELECT checksum FROM mill_migrations WHERE name='007_fixed_task_statuses.sql')
  )::text`;
  const expectedSimplificationState = {
    data: expectedSimplificationData,
    columnsRemoved: true,
    legacyStorageColumns: 0,
    emailPreferencesRemaining: 0,
    statuses: [
      "backlog",
      "todo",
      "in_progress",
      "in_review",
      "done",
      "wont_do",
    ].sort(),
    terminalRetries: 1,
    migration007Checksum: simplificationChecksum,
  };
  assert.deepEqual(
    JSON.parse(
      await run(
        "upgrade-simplified-content",
        "docker",
        databaseArguments(primary, simplificationQuery),
      ),
    ),
    expectedSimplificationState,
  );
  const retainedHistoryQuery = taskHistoryQuery.replace(
    normalizedTaskHistoryQuery,
    `${normalizedTaskHistoryQuery} WHERE activity.id IN (${expectedTaskHistory.map((item) => `'${item.id}'::uuid`).join(",")})`,
  );
  assert.deepEqual(
    JSON.parse(
      await run(
        "simplification-retained-task-history",
        "docker",
        databaseArguments(primary, retainedHistoryQuery),
      ),
    ),
    expectedTaskHistoryState,
  );
  const finalDeletionQuery = upgradedFixtureQuery
    .replace(" AND position=1", "")
    .replace(" AND position=0", "")
    .replace(
      `'deletedColumnsRemaining',(SELECT count(*) FROM columns WHERE id='${upgradeFixture.deletedColumnId}')`,
      "'columnsRemoved',to_regclass('columns') IS NULL",
    );
  const {
    deletedColumnsRemaining: _removedColumnCount,
    ...finalDeletionState
  } = expectedUpgradedFixture;
  finalDeletionState.columnsRemoved = true;
  assert.deepEqual(
    JSON.parse(
      await run(
        "simplification-permanent-deletion",
        "docker",
        databaseArguments(primary, finalDeletionQuery),
      ),
    ),
    finalDeletionState,
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
        simplification: {
          boardId: simplificationBoardId,
          formerChildId: statusCases[6].taskId,
          tasks: expectedSimplificationData.tasks.filter(
            (item) => item.board_id === simplificationBoardId,
          ),
          comments: expectedSimplificationData.comments.filter((item) =>
            statusCases.some((entry) => entry.taskId === item.task_id),
          ),
          activity: expectedSimplificationData.activity.filter((item) =>
            statusCases.some((entry) => entry.taskId === item.task_id),
          ),
          retry: simplificationRetry,
        },
      },
      null,
      2,
    ),
    { mode: 0o600 },
  );
  await run(
    "simplified-production-start",
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
  await run("simplified-upgrade-api", "node", ["tools/install-smoke.mjs"], {
    ...verifyEnv,
    MILL_VERIFY_UPGRADE_STATE: upgradeState,
  });
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
        databaseArguments(recovery, finalDeletionQuery),
      ),
    ),
    finalDeletionState,
  );
  assert.deepEqual(
    JSON.parse(
      await run(
        "restored-task-history",
        "docker",
        databaseArguments(recovery, retainedHistoryQuery),
      ),
    ),
    expectedTaskHistoryState,
  );
  assert.deepEqual(
    JSON.parse(
      await run(
        "restored-simplified-content",
        "docker",
        databaseArguments(recovery, simplificationQuery),
      ),
    ),
    expectedSimplificationState,
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
          "Reconstructed pre-005 local schema; isolated packaged migration stages through 005 and 006 verify permanent deletion, terminal retries, task ownership and unchanged history while the current app is stopped. Packaged migration 007 preserves all task/board content, comments and activity, converts all six known statuses and an unknown status, retains former subtasks independently, removes obsolete live structure/email preferences, and invalidates legacy cached responses while preserving exact 001–006 records. The compatible current API then verifies the final model",
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
        simplificationUpgrade: {
          boardId: simplificationBoardId,
          statusCases,
          formerChildId: statusCases[6].taskId,
          retry: simplificationRetry,
          migrationChecksum: simplificationChecksum,
          previousMigrations: simplificationPreviousMigrations,
          verifiedDatabaseState: expectedSimplificationState,
          finalPermanentDeletionState: finalDeletionState,
        },
        restore:
          "Post-007 custom-format pg_dump restored transactionally into a separate empty project; real API reads and exact database snapshots verify original and legacy task/comment/member contents, unchanged human/agent task history, fixed statuses, independent former subtasks, absent global audit and removed model/routes, permanent deletion and both terminal stale-create retries",
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

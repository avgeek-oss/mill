import { after, test } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type postgres from "postgres";
import { cleanupDatabase, resetDatabase, sql } from "./support.js";

after(cleanupDatabase);
const baselineUrl = new URL(
  "../packages/database/migrations/001_initial.sql",
  import.meta.url,
);
const source = await readFile(baselineUrl, "utf8");
const checksum = createHash("sha256").update(source).digest("hex");
const policySource = await readFile(
  new URL(
    "../packages/database/migrations/002_key_policies.sql",
    import.meta.url,
  ),
  "utf8",
);
const policyChecksum = createHash("sha256").update(policySource).digest("hex");
const attachmentSource = await readFile(
  new URL(
    "../packages/database/migrations/003_task_attachments.sql",
    import.meta.url,
  ),
  "utf8",
);
const attachmentChecksum = createHash("sha256")
  .update(attachmentSource)
  .digest("hex");
const permissionMigrationSource = await readFile(
  new URL(
    "../packages/database/migrations/004_oauth_admin_consent.sql",
    import.meta.url,
  ),
  "utf8",
);
const permissionMigrationChecksum = createHash("sha256")
  .update(permissionMigrationSource)
  .digest("hex");
const reauthorizationSource = await readFile(
  new URL(
    "../packages/database/migrations/005_oauth_role_change_reauthorization.sql",
    import.meta.url,
  ),
  "utf8",
);
const reauthorizationChecksum = createHash("sha256")
  .update(reauthorizationSource)
  .digest("hex");
const boardMetadataSource = await readFile(
  new URL(
    "../packages/database/migrations/006_board_metadata.sql",
    import.meta.url,
  ),
  "utf8",
);
const boardMetadataChecksum = createHash("sha256")
  .update(boardMetadataSource)
  .digest("hex");
const commentRepliesSource = await readFile(
  new URL(
    "../packages/database/migrations/007_comment_replies.sql",
    import.meta.url,
  ),
  "utf8",
);
const commentRepliesChecksum = createHash("sha256")
  .update(commentRepliesSource)
  .digest("hex");
const acceptanceCriteriaSource = await readFile(
  new URL(
    "../packages/database/migrations/008_task_acceptance_criteria.sql",
    import.meta.url,
  ),
  "utf8",
);
const acceptanceCriteriaChecksum = createHash("sha256")
  .update(acceptanceCriteriaSource)
  .digest("hex");
const roleScopesSource = await readFile(
  new URL(
    "../packages/database/migrations/009_role_named_oauth_scopes.sql",
    import.meta.url,
  ),
  "utf8",
);
const roleScopesChecksum = createHash("sha256")
  .update(roleScopesSource)
  .digest("hex");
function runMigration(schema: string, directory?: string) {
  return new Promise<{ code: number | null; output: string }>(
    (resolve, reject) => {
      const child = spawn(
        process.execPath,
        [
          "--import",
          "tsx",
          "--input-type=module",
          "-e",
          `import {migrate} from './packages/database/src/migrate.ts';import{closeDatabase}from './packages/database/src/index.ts';try{await migrate()}catch(error){console.error(error.message);process.exitCode=1}finally{await closeDatabase()}`,
        ],
        {
          cwd: new URL("../", import.meta.url),
          env: {
            ...process.env,
            MILL_DB_SCHEMA: schema,
            ...(directory ? { MILL_MIGRATIONS_DIR: directory } : {}),
          },
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
      let output = "";
      child.stdout.on("data", (data) => {
        output += data;
      });
      child.stderr.on("data", (data) => {
        output += data;
      });
      child.once("error", reject);
      child.once("close", (code) => resolve({ code, output }));
    },
  );
}
async function inSchema<T>(
  schema: string,
  callback: (
    tx: postgres.TransactionSql<{ calendarDate: string }>,
  ) => Promise<T>,
) {
  return sql.begin(async (tx) => {
    await tx.unsafe(`SET LOCAL search_path TO "${schema}"`);
    return callback(tx);
  });
}

test("single clean baseline supports concurrent fresh startup, repeat startup and checksum enforcement", async () => {
  assert.deepEqual(
    (
      await readdir(
        new URL("../packages/database/migrations/", import.meta.url),
      )
    ).filter((name) => name.endsWith(".sql")),
    [
      "001_initial.sql",
      "002_key_policies.sql",
      "003_task_attachments.sql",
      "004_oauth_admin_consent.sql",
      "005_oauth_role_change_reauthorization.sql",
      "006_board_metadata.sql",
      "007_comment_replies.sql",
      "008_task_acceptance_criteria.sql",
      "009_role_named_oauth_scopes.sql",
    ],
  );
  const schema = `baseline_${randomUUID().replaceAll("-", "")}`;
  const directory = await mkdtemp(join(tmpdir(), "mill-checksum-"));
  await sql.unsafe(`CREATE SCHEMA "${schema}"`);
  try {
    const concurrent = await Promise.all([
      runMigration(schema),
      runMigration(schema),
    ]);
    for (const result of concurrent)
      assert.equal(result.code, 0, result.output);
    await inSchema(schema, async (tx) => {
      assert.deepEqual(
        [...(await tx`SELECT name,checksum FROM mill_migrations`)],
        [
          { name: "001_initial.sql", checksum },
          { name: "002_key_policies.sql", checksum: policyChecksum },
          { name: "003_task_attachments.sql", checksum: attachmentChecksum },
          {
            name: "004_oauth_admin_consent.sql",
            checksum: permissionMigrationChecksum,
          },
          {
            name: "005_oauth_role_change_reauthorization.sql",
            checksum: reauthorizationChecksum,
          },
          { name: "006_board_metadata.sql", checksum: boardMetadataChecksum },
          { name: "007_comment_replies.sql", checksum: commentRepliesChecksum },
          {
            name: "008_task_acceptance_criteria.sql",
            checksum: acceptanceCriteriaChecksum,
          },
          {
            name: "009_role_named_oauth_scopes.sql",
            checksum: roleScopesChecksum,
          },
        ],
      );
      const tables = (
        await tx`SELECT tablename FROM pg_tables WHERE schemaname=${schema} ORDER BY tablename`
      ).map((row) => row.tablename);
      assert.deepEqual(tables, [
        "account_recovery",
        "activity",
        "api_idempotency",
        "attachment_cleanup",
        "auth_challenges",
        "auth_rate_limits",
        "boards",
        "comments",
        "credentials",
        "email_outbox",
        "email_requests",
        "invitations",
        "mill_migrations",
        "notifications",
        "oauth_clients",
        "oauth_requests",
        "passkeys",
        "recovery_codes",
        "request_limits",
        "sessions",
        "task_attachments",
        "tasks",
        "users",
        "workspace",
      ]);
      const retiredConcepts =
        await tx`SELECT column_name FROM information_schema.columns WHERE table_schema=${schema} AND (column_name IN ('agent_id','agent_ids','agent_name','all_boards','all_members') OR table_name IN ('agents','agent_members','agent_boards'))`;
      assert.equal(retiredConcepts.length, 0);
      const removed =
        await tx`SELECT column_name FROM information_schema.columns WHERE table_schema=${schema} AND table_name='tasks' AND column_name IN ('agent_id','checklist','parent_id','labels','column_id','position','archived','deleted_at')`;
      assert.equal(removed.length, 0);
      await tx`INSERT INTO workspace(id,name) VALUES(${randomUUID()},'Persistent workspace')`;
    });
    assert.equal((await runMigration(schema)).code, 0);
    await writeFile(
      join(directory, "001_initial.sql"),
      source + "\n-- changed after installation\n",
    );
    await writeFile(join(directory, "002_key_policies.sql"), policySource);
    await writeFile(
      join(directory, "003_task_attachments.sql"),
      attachmentSource,
    );
    await writeFile(
      join(directory, "004_oauth_admin_consent.sql"),
      permissionMigrationSource,
    );
    await writeFile(
      join(directory, "005_oauth_role_change_reauthorization.sql"),
      reauthorizationSource,
    );
    await writeFile(
      join(directory, "006_board_metadata.sql"),
      boardMetadataSource,
    );
    await writeFile(
      join(directory, "007_comment_replies.sql"),
      commentRepliesSource,
    );
    await writeFile(
      join(directory, "008_task_acceptance_criteria.sql"),
      acceptanceCriteriaSource,
    );
    await writeFile(
      join(directory, "009_role_named_oauth_scopes.sql"),
      roleScopesSource,
    );
    const changed = await runMigration(schema, directory);
    assert.equal(changed.code, 1);
    assert.match(changed.output, /Migration changed: 001_initial.sql/);
    await inSchema(schema, async (tx) => {
      assert.equal(
        (await tx`SELECT name FROM workspace`)[0].name,
        "Persistent workspace",
      );
      assert.equal(
        (await tx`SELECT checksum FROM mill_migrations`)[0].checksum,
        checksum,
      );
    });
  } finally {
    await sql.unsafe(`DROP SCHEMA "${schema}" CASCADE`);
    await rm(directory, { recursive: true, force: true });
  }
});

test("forward OAuth migration preserves restricted tokens and invalidates unsnapshotted codes", async () => {
  const schema = `oauth_upgrade_${randomUUID().replaceAll("-", "")}`;
  const directory = await mkdtemp(join(tmpdir(), "mill-oauth-upgrade-"));
  const ownerId = randomUUID();
  const otherOwnerId = randomUUID();
  const boardId = randomUUID();
  const credentialId = randomUUID();
  const otherCredentialId = randomUUID();
  const approvedId = randomUUID();
  const pendingId = randomUUID();
  await sql.unsafe(`CREATE SCHEMA "${schema}"`);
  try {
    for (const [name, content] of [
      ["001_initial.sql", source],
      ["002_key_policies.sql", policySource],
      ["003_task_attachments.sql", attachmentSource],
      ["004_oauth_admin_consent.sql", permissionMigrationSource],
    ])
      await writeFile(join(directory, name), content);
    assert.equal((await runMigration(schema, directory)).code, 0);
    await inSchema(schema, async (tx) => {
      const workspaceId = randomUUID();
      await tx`INSERT INTO workspace(id,name) VALUES(${workspaceId},'Upgrade workspace')`;
      await tx`INSERT INTO users(id,workspace_id,name,email,password_hash,role) VALUES(${ownerId},${workspaceId},'Owner','owner@example.test','hash','admin')`;
      await tx`INSERT INTO users(id,workspace_id,name,email,password_hash,role) VALUES(${otherOwnerId},${workspaceId},'Other owner','other@example.test','hash','admin')`;
      await tx`INSERT INTO boards(id,workspace_id,name,prefix) VALUES(${boardId},${workspaceId},'Limited board','LIMIT')`;
      await tx`INSERT INTO credentials(id,user_id,created_by,name,token_hash,token_prefix,scopes,board_ids,token_type,oauth_client_id,resource,expires_at,access_level,include_admin) VALUES(${credentialId},${ownerId},${ownerId},'Old client','old-token','prefix',ARRAY['read','write'],ARRAY[${boardId}::uuid],'oauth','client','https://example.test/mcp',now()+interval '1 day','edit',false)`;
      await tx`INSERT INTO credentials(id,user_id,created_by,name,token_hash,token_prefix,scopes,board_ids,token_type,oauth_client_id,resource,expires_at,access_level,include_admin) VALUES(${otherCredentialId},${otherOwnerId},${otherOwnerId},'Other client','other-token','prefix',ARRAY['read'],NULL,'oauth','other-client','https://example.test/mcp',now()+interval '1 day','read',false)`;
      await tx`INSERT INTO oauth_requests(id,client_id,client_name,client_trust,redirect_uri,resource,scope,challenge,user_id,board_ids,code_hash,expires_at) VALUES(${approvedId},'client','Old client','unverified','https://example.test/callback','https://example.test/mcp','read write','challenge',${ownerId},ARRAY[${boardId}::uuid],'old-code',now()+interval '1 day')`;
      await tx`INSERT INTO oauth_requests(id,client_id,client_name,client_trust,redirect_uri,resource,scope,challenge,expires_at) VALUES(${pendingId},'client','Old client','unverified','https://example.test/callback','https://example.test/mcp','read','challenge',now()+interval '1 day')`;
    });
    await writeFile(
      join(directory, "005_oauth_role_change_reauthorization.sql"),
      reauthorizationSource,
    );
    const upgraded = await runMigration(schema, directory);
    assert.equal(upgraded.code, 0, upgraded.output);
    await inSchema(schema, async (tx) => {
      const [credential] =
        await tx`SELECT board_ids,revoked_at FROM credentials WHERE id=${credentialId}`;
      assert.deepEqual(credential.boardIds, [boardId]);
      assert.equal(credential.revokedAt, null);
      const requests =
        await tx`SELECT id,board_ids,consumed_at,expires_at FROM oauth_requests WHERE id IN (${approvedId},${pendingId})`;
      assert.deepEqual(
        requests.find((entry) => entry.id === approvedId)?.boardIds,
        [boardId],
      );
      assert.ok(requests.find((entry) => entry.id === approvedId)?.consumedAt);
      assert.equal(
        requests.find((entry) => entry.id === pendingId)?.consumedAt,
        null,
      );
      const [{ databaseNow }] =
        await tx`SELECT clock_timestamp() AS database_now`;
      assert.ok(
        requests.find((entry) => entry.id === approvedId)!.expiresAt <=
          databaseNow,
      );
      assert.ok(
        requests.find((entry) => entry.id === pendingId)!.expiresAt >
          databaseNow,
      );
      await tx`UPDATE users SET role='member' WHERE id=${ownerId}`;
      assert.ok(
        (
          await tx`SELECT revoked_at FROM credentials WHERE id=${credentialId}`
        )[0]?.revokedAt,
      );
      assert.equal(
        (
          await tx`SELECT revoked_at FROM credentials WHERE id=${otherCredentialId}`
        )[0]?.revokedAt,
        null,
      );
      assert.deepEqual(
        (await tx`SELECT name,checksum FROM mill_migrations ORDER BY name`).map(
          ({ name, checksum }) => ({ name, checksum }),
        ),
        [
          { name: "001_initial.sql", checksum },
          { name: "002_key_policies.sql", checksum: policyChecksum },
          { name: "003_task_attachments.sql", checksum: attachmentChecksum },
          {
            name: "004_oauth_admin_consent.sql",
            checksum: permissionMigrationChecksum,
          },
          {
            name: "005_oauth_role_change_reauthorization.sql",
            checksum: reauthorizationChecksum,
          },
        ],
      );
    });
  } finally {
    await sql.unsafe(`DROP SCHEMA "${schema}" CASCADE`);
    await rm(directory, { recursive: true, force: true });
  }
});

test("role-named OAuth migration preserves grants and board limits, then rejects old wire scopes", async () => {
  const schema = `oauth_scopes_${randomUUID().replaceAll("-", "")}`;
  const directory = await mkdtemp(join(tmpdir(), "mill-oauth-scopes-"));
  const ownerId = randomUUID();
  const boardId = randomUUID();
  const adminCredentialId = randomUUID();
  const readCredentialId = randomUUID();
  const teamKeyId = randomUUID();
  const approvedId = randomUUID();
  const pendingId = randomUUID();
  const unknownId = randomUUID();
  await sql.unsafe(`CREATE SCHEMA "${schema}"`);
  try {
    for (const [name, content] of [
      ["001_initial.sql", source],
      ["002_key_policies.sql", policySource],
      ["003_task_attachments.sql", attachmentSource],
      ["004_oauth_admin_consent.sql", permissionMigrationSource],
      ["005_oauth_role_change_reauthorization.sql", reauthorizationSource],
      ["006_board_metadata.sql", boardMetadataSource],
      ["007_comment_replies.sql", commentRepliesSource],
      ["008_task_acceptance_criteria.sql", acceptanceCriteriaSource],
    ])
      await writeFile(join(directory, name), content);
    assert.equal((await runMigration(schema, directory)).code, 0);
    await inSchema(schema, async (tx) => {
      const workspaceId = randomUUID();
      await tx`INSERT INTO workspace(id,name) VALUES(${workspaceId},'Scope upgrade')`;
      await tx`INSERT INTO users(id,workspace_id,name,email,password_hash,role) VALUES(${ownerId},${workspaceId},'Owner','owner@example.test','hash','admin')`;
      await tx`INSERT INTO boards(id,workspace_id,name,prefix) VALUES(${boardId},${workspaceId},'Restricted board','RESTRICT')`;
      await tx`INSERT INTO credentials(id,user_id,created_by,name,token_hash,token_prefix,scopes,board_ids,token_type,oauth_client_id,resource,expires_at,access_level,include_admin) VALUES(${adminCredentialId},${ownerId},${ownerId},'Admin connection','admin-token','prefix',ARRAY['read','write','admin'],ARRAY[${boardId}::uuid],'oauth','client','https://example.test/mcp',now()+interval '1 day','edit',true)`;
      await tx`INSERT INTO credentials(id,user_id,created_by,name,token_hash,token_prefix,scopes,board_ids,token_type,oauth_client_id,resource,expires_at,access_level,include_admin) VALUES(${readCredentialId},${ownerId},${ownerId},'Read connection','read-token','prefix',ARRAY['read'],NULL,'oauth','read-client','https://example.test/mcp',now()+interval '1 day','read',false)`;
      await tx`INSERT INTO credentials(id,user_id,created_by,name,token_hash,token_prefix,scopes,token_type,expires_at,access_level,include_admin) VALUES(${teamKeyId},NULL,${ownerId},'Team key','team-token','prefix','{}'::text[],'api-key',now()+interval '1 day','edit',false)`;
      await tx`INSERT INTO oauth_requests(id,client_id,client_name,client_trust,redirect_uri,resource,scope,challenge,user_id,approved_role,board_ids,code_hash,expires_at) VALUES(${approvedId},'client','Admin connection','unverified','https://example.test/callback','https://example.test/mcp','read write admin','challenge',${ownerId},'admin',ARRAY[${boardId}::uuid],'approved-code',now()+interval '1 day')`;
      await tx`INSERT INTO oauth_requests(id,client_id,client_name,client_trust,redirect_uri,resource,scope,challenge,expires_at) VALUES(${pendingId},'client','Pending connection','unverified','https://example.test/callback','https://example.test/mcp','read','challenge',now()+interval '1 day')`;
      await tx`INSERT INTO oauth_requests(id,client_id,client_name,client_trust,redirect_uri,resource,scope,challenge,expires_at) VALUES(${unknownId},'client','Unknown scope','unverified','https://example.test/callback','https://example.test/mcp','read export','challenge',now()+interval '1 day')`;
    });
    await writeFile(
      join(directory, "009_role_named_oauth_scopes.sql"),
      roleScopesSource,
    );
    const rejected = await runMigration(schema, directory);
    assert.equal(rejected.code, 1);
    assert.match(rejected.output, /Unknown OAuth scope/);
    await inSchema(schema, async (tx) => {
      assert.deepEqual(
        (
          await tx`SELECT scopes FROM credentials WHERE id=${adminCredentialId}`
        )[0]?.scopes,
        ["read", "write", "admin"],
      );
      assert.equal(
        (
          await tx`SELECT count(*)::int AS count FROM mill_migrations WHERE name='009_role_named_oauth_scopes.sql'`
        )[0]?.count,
        0,
      );
      await tx`DELETE FROM oauth_requests WHERE id=${unknownId}`;
    });
    const upgraded = await runMigration(schema, directory);
    assert.equal(upgraded.code, 0, upgraded.output);
    await inSchema(schema, async (tx) => {
      const [adminCredential] =
        await tx`SELECT scopes,board_ids,revoked_at,include_admin FROM credentials WHERE id=${adminCredentialId}`;
      assert.deepEqual(adminCredential.scopes, ["viewer", "member", "admin"]);
      assert.deepEqual(adminCredential.boardIds, [boardId]);
      assert.equal(adminCredential.revokedAt, null);
      assert.equal(adminCredential.includeAdmin, true);
      assert.deepEqual(
        (
          await tx`SELECT scopes FROM credentials WHERE id=${readCredentialId}`
        )[0]?.scopes,
        ["viewer"],
      );
      assert.deepEqual(
        (await tx`SELECT scopes FROM credentials WHERE id=${teamKeyId}`)[0]
          ?.scopes,
        [],
      );
      assert.deepEqual(
        (
          await tx`SELECT scope,board_ids FROM oauth_requests WHERE id=${approvedId}`
        )[0],
        { scope: "viewer member admin", boardIds: [boardId] },
      );
      assert.equal(
        (await tx`SELECT scope FROM oauth_requests WHERE id=${pendingId}`)[0]
          ?.scope,
        "viewer",
      );
      assert.equal(
        (
          await tx`SELECT checksum FROM mill_migrations WHERE name='009_role_named_oauth_scopes.sql'`
        )[0]?.checksum,
        roleScopesChecksum,
      );
    });
    await assert.rejects(
      inSchema(schema, async (tx) => {
        await tx`UPDATE credentials SET scopes=ARRAY['read'] WHERE id=${readCredentialId}`;
      }),
      /credentials_access_shape/,
    );
    await assert.rejects(
      inSchema(schema, async (tx) => {
        await tx`UPDATE oauth_requests SET scope='read' WHERE id=${pendingId}`;
      }),
      /oauth_requests_scope_shape/,
    );
  } finally {
    await sql.unsafe(`DROP SCHEMA "${schema}" CASCADE`);
    await rm(directory, { recursive: true, force: true });
  }
});

test("legacy migration records refuse adoption without changing retained data", async () => {
  const schema = `legacy_guard_${randomUUID().replaceAll("-", "")}`;
  await sql.unsafe(`CREATE SCHEMA "${schema}"`);
  try {
    await inSchema(schema, async (tx) => {
      await tx`CREATE TABLE mill_migrations(name text PRIMARY KEY,checksum text NOT NULL,applied_at timestamptz NOT NULL DEFAULT now())`;
      await tx`INSERT INTO mill_migrations(name,checksum) VALUES('001_identity.sql','retained-original-checksum')`;
      await tx`CREATE TABLE retained_private_data(value text NOT NULL)`;
      await tx`INSERT INTO retained_private_data VALUES('Preserve this installation')`;
    });
    const result = await runMigration(schema);
    assert.equal(result.code, 1);
    assert.match(result.output, /previous prelaunch schema/);
    await inSchema(schema, async (tx) => {
      assert.equal(
        (await tx`SELECT value FROM retained_private_data`)[0].value,
        "Preserve this installation",
      );
      assert.equal(
        (await tx`SELECT count(*)::int AS count FROM mill_migrations`)[0].count,
        1,
      );
      assert.equal(
        (
          await tx`SELECT count(*)::int AS count FROM pg_tables WHERE schemaname=${schema}`
        )[0].count,
        2,
      );
    });
  } finally {
    await sql.unsafe(`DROP SCHEMA "${schema}" CASCADE`);
  }
});

test("failed baseline execution rolls back its schema and ledger atomically", async () => {
  const schema = `baseline_failure_${randomUUID().replaceAll("-", "")}`;
  const directory = await mkdtemp(join(tmpdir(), "mill-failing-baseline-"));
  await sql.unsafe(`CREATE SCHEMA "${schema}"`);
  try {
    await writeFile(
      join(directory, "001_initial.sql"),
      source + "\nSELECT missing_baseline_function();\n",
    );
    assert.equal((await runMigration(schema, directory)).code, 1);
    assert.equal(
      (await sql`SELECT tablename FROM pg_tables WHERE schemaname=${schema}`)
        .length,
      0,
    );
  } finally {
    await sql.unsafe(`DROP SCHEMA "${schema}" CASCADE`);
    await rm(directory, { recursive: true, force: true });
  }
});
test("baseline status clock resets only for a status change and preserves independent content edits", async () => {
  // Formerly its own file with beforeEach(resetDatabase) and one test.
  await resetDatabase();
  const id = randomUUID();
  await sql`INSERT INTO workspace(id,name) VALUES(${id},'Status age')`;
  const [user] =
    await sql`INSERT INTO users(id,workspace_id,name,email,role,password_hash) VALUES(${randomUUID()},${id},'Admin','age@example.test','admin','unused') RETURNING id`;
  const [board] =
    await sql`INSERT INTO boards(workspace_id,name,prefix) VALUES(${id},'Status board','AGE') RETURNING id`;
  const [task] =
    await sql`INSERT INTO tasks(board_id,identifier,title,status,created_by,status_changed_at) VALUES(${board.id},'AGE-1','Task','done',${user.id},now()-interval '2 days') RETURNING id,status_changed_at`;
  await sql`UPDATE tasks SET title='Updated text',status='done',version=version+1,updated_at=now() WHERE id=${task.id}`;
  const [edited] =
    await sql`SELECT status_changed_at,version FROM tasks WHERE id=${task.id}`;
  assert.equal(
    edited.statusChangedAt.getTime(),
    task.statusChangedAt.getTime(),
  );
  assert.equal(edited.version, 2);
  await sql`UPDATE tasks SET status='wont_do' WHERE id=${task.id}`;
  const [moved] =
    await sql`SELECT status_changed_at,version FROM tasks WHERE id=${task.id}`;
  assert.ok(moved.statusChangedAt.getTime() > task.statusChangedAt.getTime());
  assert.equal(moved.version, 2);
  const [fresh] =
    await sql`INSERT INTO tasks(board_id,identifier,title,status,created_by) VALUES(${board.id},'AGE-2','Fresh terminal','done',${user.id}) RETURNING status_changed_at=created_at AS clock_matches`;
  assert.equal(fresh.clockMatches, true);
});

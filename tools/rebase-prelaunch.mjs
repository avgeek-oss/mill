import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import postgres from "postgres";

const root = fileURLToPath(new URL("../", import.meta.url));
const baselineName = "001_initial.sql";
const reviewedBaselineChecksum =
  "0db7924eada8cea6c3c9bfd3181e3753e6148198d2d0c9d6396f2d66a819b804";
const digest = (value) => createHash("sha256").update(value).digest("hex");
const quote = (name) => `"${name.replaceAll('"', '""')}"`;
const qualify = (schema, name) => `${quote(schema)}.${quote(name)}`;
const validateSchema = (schema) => {
  if (!/^[a-z][a-z0-9_]{0,62}$/.test(schema) || schema.startsWith("pg_"))
    throw new Error("Use an explicit ordinary Mill schema name");
};
const unqualify = (text, schema) =>
  text.replaceAll(`${quote(schema)}.`, "").replaceAll(`${schema}.`, "");

export async function schemaLayout(sql, schema) {
  validateSchema(schema);
  const columns =
    await sql`SELECT table_name,column_name,data_type,udt_name,is_nullable,column_default FROM information_schema.columns WHERE table_schema=${schema} ORDER BY table_name,ordinal_position`;
  const tables = Object.fromEntries(
    [...new Set(columns.map((column) => column.table_name))].map((table) => [
      table,
      columns
        .filter((column) => column.table_name === table)
        .map((column) => ({
          name: column.column_name,
          type: column.data_type,
          udt: column.udt_name,
          nullable: column.is_nullable === "YES",
          default: column.column_default,
        })),
    ]),
  );
  const constraints = (
    await sql`SELECT c.relname AS table,t.conname AS name,t.contype AS type,pg_get_constraintdef(t.oid) AS definition FROM pg_constraint t JOIN pg_class c ON c.oid=t.conrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=${schema} ORDER BY c.relname,t.conname`
  ).map((entry) => ({
    ...entry,
    definition: unqualify(entry.definition, schema),
  }));
  const functions = (
    await sql`SELECT proname AS name,pg_get_function_identity_arguments(p.oid) AS arguments,prosrc AS body,l.lanname AS language,proconfig AS config,prosecdef AS security_definer,provolatile AS volatility,prokind AS kind FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace JOIN pg_language l ON l.oid=p.prolang WHERE n.nspname=${schema} ORDER BY proname,arguments`
  ).map((entry) => ({
    ...entry,
    body: digest(entry.body),
    config:
      entry.config?.map((value) => value.replaceAll(schema, "<schema>")) ?? [],
  }));
  const triggers = (
    await sql`SELECT c.relname AS table,t.tgname AS name,t.tgenabled AS enabled,pg_get_triggerdef(t.oid) AS definition FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=${schema} AND NOT t.tgisinternal ORDER BY c.relname,t.tgname`
  ).map((entry) => ({
    ...entry,
    definition: unqualify(entry.definition, schema),
  }));
  const migrations = await sql.unsafe(
    `SELECT name,checksum FROM ${qualify(schema, "mill_migrations")} ORDER BY name`,
  );
  const indexes = (
    await sql`SELECT c.relname AS table,i.relname AS name,pg_get_indexdef(i.oid) AS definition FROM pg_index x JOIN pg_class c ON c.oid=x.indrelid JOIN pg_class i ON i.oid=x.indexrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=${schema} ORDER BY c.relname,i.relname`
  ).map((entry) => ({
    ...entry,
    definition: unqualify(entry.definition, schema),
  }));
  const relations = (
    await sql`SELECT c.relname AS name,c.relkind AS kind,c.relrowsecurity AS row_security,c.relforcerowsecurity AS force_row_security FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=${schema} ORDER BY c.relname`
  ).map((entry) => ({ ...entry }));
  const types = (
    await sql`SELECT t.typname AS name,t.typtype AS kind FROM pg_type t JOIN pg_namespace n ON n.oid=t.typnamespace WHERE n.nspname=${schema} AND t.typrelid=0 AND t.typelem=0 ORDER BY t.typname`
  ).map((entry) => ({ ...entry }));
  return {
    migrations: migrations.map(({ name, checksum }) => ({ name, checksum })),
    tables,
    constraints,
    functions,
    triggers,
    indexes,
    relations,
    types,
  };
}

export function requireKnownLegacy(actual, expected) {
  try {
    assert.deepEqual(actual, expected);
  } catch {
    throw new Error(
      "This installation does not match the known prelaunch migration ledger and schema. Nothing was converted.",
    );
  }
}

async function requireStopped(sql) {
  const [row] =
    await sql`SELECT count(*)::int AS count FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid() AND backend_type='client backend'`;
  if (row.count)
    throw new Error(
      "Stop every application, worker, migration and database client for this Mill database before applying the rebase",
    );
}

async function repinFunctions(sql, schema) {
  const functions =
    await sql`SELECT p.proname,pg_get_function_identity_arguments(p.oid) AS arguments FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname=${schema}`;
  for (const fn of functions)
    await sql.unsafe(
      `ALTER FUNCTION ${qualify(schema, fn.proname)}(${fn.arguments}) SET search_path TO pg_catalog, ${quote(schema)}, pg_temp`,
    );
}

async function tableOrder(sql, schema, tables) {
  const references =
    await sql`SELECT child.relname AS child,parent.relname AS parent FROM pg_constraint fk JOIN pg_class child ON child.oid=fk.conrelid JOIN pg_class parent ON parent.oid=fk.confrelid JOIN pg_namespace n ON n.oid=child.relnamespace WHERE fk.contype='f' AND n.nspname=${schema}`;
  const remaining = new Set(tables),
    ordered = [];
  while (remaining.size) {
    const ready = [...remaining].filter(
      (name) =>
        !references.some(
          (ref) =>
            ref.child === name &&
            ref.parent !== name &&
            remaining.has(ref.parent),
        ),
    );
    if (!ready.length)
      throw new Error("Unexpected foreign-key cycle in the clean baseline");
    for (const name of ready) {
      ordered.push(name);
      remaining.delete(name);
    }
  }
  return ordered;
}

async function verifyCommonColumns(
  sql,
  source,
  target,
  table,
  columns,
  projection = {},
  sourceWhere = "true",
) {
  const names = columns.map(quote).join(",");
  const expected = columns
    .map((name) => projection[name] ?? `s.${quote(name)}`)
    .join(",");
  const [row] = await sql.unsafe(
    `SELECT EXISTS((SELECT ${expected} FROM ${qualify(source, table)} s WHERE ${sourceWhere} EXCEPT ALL SELECT ${names} FROM ${qualify(target, table)}) UNION ALL (SELECT ${names} FROM ${qualify(target, table)} EXCEPT ALL SELECT ${expected} FROM ${qualify(source, table)} s WHERE ${sourceWhere})) AS changed`,
  );
  if (row.changed)
    throw new Error(
      `Copied content did not match for ${table}; conversion rolled back`,
    );
}

export async function rebasePrelaunch(
  sql,
  { schema, apply = false, baseline, expectedLegacy },
) {
  validateSchema(schema);
  if (digest(baseline) !== reviewedBaselineChecksum)
    throw new Error(
      "The baseline differs from the reviewed prelaunch conversion; review the helper before proceeding",
    );
  if (schema.startsWith("mill_prelaunch_"))
    throw new Error("Do not rebase an archived or staging schema");
  const staging = `mill_prelaunch_stage_${randomUUID().replaceAll("-", "").slice(0, 16)}`;
  const archived = `mill_prelaunch_backup_${randomUUID().replaceAll("-", "").slice(0, 16)}`;
  return sql.begin(async (tx) => {
    await tx.unsafe(
      apply
        ? "SET TRANSACTION ISOLATION LEVEL REPEATABLE READ"
        : "SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY",
    );
    await tx`SELECT pg_advisory_xact_lock(69115501)`;
    const original = await schemaLayout(tx, schema);
    requireKnownLegacy(original, expectedLegacy);
    const counts = {};
    if (!apply) {
      for (const table of Object.keys(original.tables)) {
        const [row] = await tx.unsafe(
          `SELECT count(*)::int AS count FROM ${qualify(schema, table)}`,
        );
        counts[table] = row.count;
      }
      return { applied: false, schema, counts, baseline: baselineName };
    }
    await requireStopped(tx);
    const sourceTables = Object.keys(original.tables);
    await tx.unsafe(
      `LOCK TABLE ${sourceTables.map((name) => qualify(schema, name)).join(",")} IN ACCESS EXCLUSIVE MODE`,
    );
    requireKnownLegacy(await schemaLayout(tx, schema), expectedLegacy);
    if (sourceTables.includes("authenticators")) {
      const [unprotected] = await tx.unsafe(
        `SELECT EXISTS(SELECT 1 FROM ${qualify(schema, "authenticators")} a WHERE a.verified AND NOT EXISTS(SELECT 1 FROM ${qualify(schema, "passkeys")} p WHERE p.user_id=a.user_id)) AS blocked`,
      );
      if (unprotected.blocked)
        throw new Error(
          "Add passkeys or explicitly recover authenticator-only accounts before conversion; security factors cannot be silently removed",
        );
    }
    await tx.unsafe(`CREATE SCHEMA ${quote(staging)}`);
    await tx.unsafe(`SET LOCAL search_path TO ${quote(staging)}, pg_catalog`);
    await tx.unsafe(baseline);
    await tx.unsafe(
      `CREATE TABLE mill_migrations (name text PRIMARY KEY,checksum text NOT NULL,applied_at timestamptz NOT NULL DEFAULT now())`,
    );
    await tx.unsafe(
      `INSERT INTO mill_migrations(name,checksum) VALUES ($1,$2)`,
      [baselineName, digest(baseline)],
    );
    const clean = await schemaLayout(tx, staging);
    const removedTables = new Set([
      "authenticators",
      "agents",
      "agent_members",
      "retired_task_checklists",
      "mill_migrations",
    ]);
    const sourceHasPasskeyProof = original.tables.sessions.some(
      (column) => column.name === "passkey_authenticated_at",
    );
    const sourceHasAgents = sourceTables.includes("agents");
    const sourceHasDateFormat = original.tables.users.some(
      (column) => column.name === "date_format",
    );
    const sourceHasTimeFormat = original.tables.users.some(
      (column) => column.name === "time_format",
    );
    const sourceHasTaskType = original.tables.tasks.some(
      (column) => column.name === "type",
    );
    const sourceHasStartDate = original.tables.tasks.some(
      (column) => column.name === "start_date",
    );
    const retiredColumns = {
      tasks: ["agent_id"],
      credentials: ["agent_id"],
      oauth_requests: ["agent_id"],
      api_idempotency: ["agent_ids"],
    };
    assert.deepEqual(
      Object.keys(clean.tables).sort(),
      Object.keys(original.tables)
        .filter((name) => !removedTables.has(name))
        .concat("mill_migrations")
        .sort(),
      "Unexpected baseline table changes",
    );
    for (const [table, columns] of Object.entries(original.tables)) {
      if (removedTables.has(table)) continue;
      const expectedColumns = columns
        .filter(
          (column) => !(retiredColumns[table] ?? []).includes(column.name),
        )
        .map((column) => column.name);
      if (table === "tasks" && !sourceHasTaskType) expectedColumns.push("type");
      if (table === "tasks" && !sourceHasStartDate)
        expectedColumns.push("start_date");
      if (table === "users" && !sourceHasDateFormat)
        expectedColumns.push("date_format");
      if (table === "users" && !sourceHasTimeFormat)
        expectedColumns.push("time_format");
      if (table === "sessions" && !sourceHasPasskeyProof)
        expectedColumns.push("passkey_authenticated_at");
      expectedColumns.sort();
      assert.deepEqual(
        clean.tables[table].map((column) => column.name).sort(),
        expectedColumns,
        `Unexpected baseline column changes in ${table}`,
      );
    }
    const activeTables = Object.keys(clean.tables).filter(
      (name) => name !== "mill_migrations",
    );
    for (const name of activeTables)
      await tx.unsafe(
        `ALTER TABLE ${qualify(staging, name)} DISABLE TRIGGER USER`,
      );
    const activeOwner = `EXISTS(SELECT 1 FROM ${qualify(schema, "users")} u WHERE u.id=s.user_id AND u.disabled_at IS NULL)`;
    const eligibleLegacyIdentity = `EXISTS(SELECT 1 FROM ${qualify(schema, "agents")} a WHERE a.id=s.agent_id AND ((a.scope='personal' AND a.creator_id=s.user_id) OR (a.scope='team' AND (a.all_members OR EXISTS(SELECT 1 FROM ${qualify(schema, "agent_members")} m WHERE m.agent_id=a.id AND m.user_id=s.user_id)))))`;
    const invalidGrant = `NOT (${activeOwner}) OR (s.token_type='oauth' AND NOT (${eligibleLegacyIdentity}))`;
    const invalidApproval = `s.code_hash IS NOT NULL AND (NOT (${activeOwner}) OR NOT (${eligibleLegacyIdentity}))`;
    const notificationOwner = `(SELECT CASE WHEN count(DISTINCT u.id)=1 THEN min(u.name) ELSE 'Workspace member' END FROM ${qualify(schema, "users")} u JOIN ${qualify(schema, "agents")} a ON s.actor_name=a.name || ' via ' || u.name)`;
    const sourceFilters = {
      recovery_codes: sourceTables.includes("authenticators")
        ? "false"
        : "true",
    };
    const projections = {
      sessions: {
        ...(!sourceHasPasskeyProof
          ? {
              passkey_authenticated_at: "NULL::timestamptz",
              authenticated_at: "to_timestamp(0)",
            }
          : {}),
      },
      users: {
        ...(!sourceHasDateFormat
          ? { date_format: "'day-short-month-year'::text" }
          : {}),
        ...(!sourceHasTimeFormat ? { time_format: "'24-hour'::text" } : {}),
      },
      tasks: {
        ...(!sourceHasTaskType ? { type: "'task'::text" } : {}),
        ...(!sourceHasStartDate ? { start_date: "NULL::date" } : {}),
      },
      api_idempotency: {
        response: "NULL::jsonb",
        status: "410",
        invalidation_reason: "'upgrade'::text",
        board_ids: "'{}'::uuid[]",
        task_ids: "'{}'::uuid[]",
      },
      ...(sourceHasAgents
        ? {
            credentials: {
              revoked_at: `CASE WHEN s.revoked_at IS NULL AND (${invalidGrant}) THEN now() ELSE s.revoked_at END`,
            },
            oauth_requests: {
              consumed_at: `CASE WHEN ${invalidApproval} THEN COALESCE(s.consumed_at,now()) ELSE s.consumed_at END`,
              expires_at: `CASE WHEN ${invalidApproval} THEN LEAST(s.expires_at,now()) ELSE s.expires_at END`,
            },
            activity: {
              actor_kind:
                "CASE WHEN s.actor_kind='agent' THEN 'oauth' ELSE s.actor_kind END",
              actor_name: `CASE WHEN s.actor_kind='agent' THEN (SELECT name FROM ${qualify(schema, "users")} u WHERE u.id=s.actor_id) ELSE s.actor_name END`,
              detail: `(s.detail - 'agentId' - 'agentName') || CASE WHEN jsonb_typeof(s.detail->'fields')='array' THEN jsonb_build_object('fields',COALESCE((SELECT jsonb_agg(value ORDER BY ordinal) FROM jsonb_array_elements(s.detail->'fields') WITH ORDINALITY e(value,ordinal) WHERE value NOT IN ('"agentId"'::jsonb,'"agentName"'::jsonb)),'[]'::jsonb)) ELSE '{}'::jsonb END`,
            },
            notifications: {
              actor_name: `CASE WHEN EXISTS(SELECT 1 FROM ${qualify(schema, "users")} u WHERE u.name=s.actor_name) THEN s.actor_name WHEN strpos(s.actor_name,' via ')>0 THEN ${notificationOwner} ELSE s.actor_name END`,
            },
          }
        : {}),
    };
    const commonColumns = {};
    for (const table of await tableOrder(tx, staging, activeTables)) {
      const common = clean.tables[table].map((column) => column.name);
      commonColumns[table] = common;
      const names = common.map(quote).join(",");
      const values = common
        .map((name) => projections[table]?.[name] ?? `s.${quote(name)}`)
        .join(",");
      await tx.unsafe(
        `INSERT INTO ${qualify(staging, table)}(${names}) SELECT ${values} FROM ${qualify(schema, table)} s WHERE ${sourceFilters[table] ?? "true"}`,
      );
      await verifyCommonColumns(
        tx,
        schema,
        staging,
        table,
        common,
        projections[table],
        sourceFilters[table],
      );
      const [row] = await tx.unsafe(
        `SELECT count(*)::int AS count FROM ${qualify(staging, table)}`,
      );
      counts[table] = row.count;
    }
    for (const table of activeTables)
      await verifyCommonColumns(
        tx,
        schema,
        staging,
        table,
        commonColumns[table],
        projections[table],
        sourceFilters[table],
      );
    for (const table of activeTables)
      await tx.unsafe(
        `ALTER TABLE ${qualify(staging, table)} ENABLE TRIGGER USER`,
      );
    await tx.unsafe("SET CONSTRAINTS ALL IMMEDIATE");
    requireKnownLegacy(await schemaLayout(tx, staging), clean);
    await requireStopped(tx);
    await tx.unsafe(
      `ALTER SCHEMA ${quote(schema)} RENAME TO ${quote(archived)}`,
    );
    await tx.unsafe(
      `ALTER SCHEMA ${quote(staging)} RENAME TO ${quote(schema)}`,
    );
    await repinFunctions(tx, archived);
    await repinFunctions(tx, schema);
    await tx.unsafe(`SET LOCAL search_path TO ${quote(schema)}, pg_catalog`);
    return {
      applied: true,
      schema,
      archivedSchema: archived,
      counts,
      baseline: baselineName,
      baselineChecksum: digest(baseline),
    };
  });
}

async function main(args) {
  if (args.includes("--help")) {
    console.log(
      "Usage: node --env-file=.env tools/rebase-prelaunch.mjs [--schema public] [--apply]\nDefault is read-only inspection. Apply requires every Mill database client stopped. The full old schema is retained as an archived snapshot.",
    );
    return;
  }
  let schema = process.env.MILL_DB_SCHEMA || "public",
    apply = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--apply") apply = true;
    else if (args[i] === "--schema" && args[i + 1]) schema = args[++i];
    else throw new Error("Unknown option; use --help");
  }
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required");
  const files = (
    await readdir(path.join(root, "packages/database/migrations"))
  ).filter((name) => name.endsWith(".sql"));
  if (files.length !== 1 || files[0] !== baselineName)
    throw new Error(
      "The rebase requires the single reviewed 001_initial.sql baseline",
    );
  const baseline = await readFile(
    path.join(root, "packages/database/migrations", baselineName),
    "utf8",
  );
  const sql = postgres(process.env.DATABASE_URL, {
    max: 1,
    connect_timeout: 5,
    onnotice: () => {},
    connection: { application_name: "mill-prelaunch-rebase" },
  });
  try {
    validateSchema(schema);
    const installed = await sql.unsafe(
      `SELECT name,checksum FROM ${qualify(schema, "mill_migrations")} ORDER BY name`,
    );
    const knownSources = await Promise.all(
      [
        "prelaunch-display-preferences-layout.json",
        "prelaunch-account-preferences-layout.json",
        "prelaunch-start-date-layout.json",
        "prelaunch-task-type-layout.json",
        "prelaunch-legacy-layout.json",
      ].map(async (file) =>
        JSON.parse(await readFile(path.join(root, "tools", file), "utf8")),
      ),
    );
    const expectedLegacy = knownSources.find((source) => {
      try {
        assert.deepEqual(
          installed.map(({ name, checksum }) => ({ name, checksum })),
          source.migrations,
        );
        return true;
      } catch {
        return false;
      }
    });
    if (!expectedLegacy)
      throw new Error(
        "This installation does not match a known prelaunch migration ledger. Nothing was converted.",
      );
    console.log(
      JSON.stringify(
        await rebasePrelaunch(sql, { schema, apply, baseline, expectedLegacy }),
        null,
        2,
      ),
    );
  } finally {
    await sql.end();
  }
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(
      error instanceof Error && !error.code
        ? error.message
        : "Prelaunch conversion failed; no success was recorded. Inspect the source and any archive schemas before retrying.",
    );
    process.exitCode = 1;
  });
}

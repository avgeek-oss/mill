import { readdir, readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { sql } from "./index.js";
export async function migrate() {
  const dir =
    process.env.MILL_MIGRATIONS_DIR ??
    fileURLToPath(new URL("../migrations/", import.meta.url));
  await sql.begin(async (tx) => {
    await tx`SELECT pg_advisory_xact_lock(69115501)`;
    await tx`CREATE TABLE IF NOT EXISTS mill_migrations (name text PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())`;
    const names = (await readdir(dir)).filter((n) => n.endsWith(".sql")).sort();
    const installed = await tx<
      { name: string }[]
    >`SELECT name FROM mill_migrations ORDER BY name`;
    const retired = installed.filter((entry) => !names.includes(entry.name));
    if (retired.length)
      throw new Error(
        `This database uses a previous prelaunch schema (${retired.map((entry) => entry.name).join(", ")}). Keep a verified backup and use the prelaunch conversion tool or a separate empty database. No migration was applied.`,
      );
    for (const name of names) {
      const body = await readFile(`${dir}/${name}`, "utf8");
      const checksum = createHash("sha256").update(body).digest("hex");
      const [existing] =
        await tx`SELECT checksum FROM mill_migrations WHERE name=${name}`;
      if (existing) {
        if (existing.checksum !== checksum)
          throw new Error(`Migration changed: ${name}`);
        continue;
      }
      await tx.unsafe(body);
      await tx`INSERT INTO mill_migrations (name,checksum) VALUES (${name},${checksum})`;
    }
  });
}

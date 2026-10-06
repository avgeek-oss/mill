import type { TransactionSql } from "postgres";

export async function lockAuthority(tx: TransactionSql): Promise<void> {
  await tx`SELECT id FROM workspace FOR UPDATE`;
}

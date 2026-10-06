import { AsyncLocalStorage } from "node:async_hooks";
import postgres from "postgres";
const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL is required. See .env.example");
const connection = postgres(databaseUrl, {
  max: 12,
  connect_timeout: 5,
  connection: process.env.MILL_DB_SCHEMA
    ? { search_path: process.env.MILL_DB_SCHEMA }
    : undefined,
  types: {
    calendarDate: {
      to: 1082,
      from: [1082],
      serialize: (value: unknown) =>
        value instanceof Date
          ? value.toISOString().slice(0, 10)
          : String(value),
      parse: (value: string) => value,
    },
  },
  transform: postgres.camel,
  onnotice: () => {},
});
const transactions = new AsyncLocalStorage<postgres.TransactionSql>();
export const sql = new Proxy(connection, {
  apply(target, thisArg, args) {
    return Reflect.apply(transactions.getStore() ?? target, thisArg, args);
  },
  get(target, key) {
    const tx = transactions.getStore();
    if (tx && key === "begin")
      return (
        optionsOrCallback:
          string | ((nested: postgres.TransactionSql) => Promise<unknown>),
        callback?: (nested: postgres.TransactionSql) => Promise<unknown>,
      ) => {
        const run =
          typeof optionsOrCallback === "function"
            ? optionsOrCallback
            : callback;
        if (!run)
          throw new TypeError("A nested transaction requires a callback");
        // Isolation belongs to the outer transaction; its authority lock protects nested reads.
        return tx.savepoint((nested) =>
          transactions.run(nested, () => run(nested)),
        );
      };
    const source = tx && key !== "end" ? tx : target;
    const value = Reflect.get(source, key);
    return typeof value === "function" ? value.bind(source) : value;
  },
});
export async function withDatabaseTransaction<T>(
  callback: () => Promise<T>,
): Promise<T> {
  const existing = transactions.getStore();
  if (existing)
    return existing.savepoint((tx) =>
      transactions.run(tx, callback),
    ) as Promise<T>;
  return connection.begin((tx) => transactions.run(tx, callback)) as Promise<T>;
}
export async function closeDatabase() {
  await connection.end();
}
export type Database = typeof sql;

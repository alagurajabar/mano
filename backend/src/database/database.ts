import { createClient } from "@libsql/client";
import type { Client, InArgs, Transaction } from "@libsql/client";
import { mkdir, readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const migrationsDirectory = process.env.VERCEL === "1"
  ? path.resolve(process.cwd(), "backend", "migrations")
  : fileURLToPath(new URL("../../migrations/", import.meta.url));

export interface DatabaseExecutor {
  get<T>(sql: string, args?: InArgs): Promise<T | undefined>;
  all<T>(sql: string, args?: InArgs): Promise<T[]>;
  run(sql: string, args?: InArgs): Promise<void>;
}

export interface DriveVaultDatabase extends DatabaseExecutor {
  transaction<T>(operation: (transaction: DatabaseExecutor) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

class LibsqlExecutor implements DatabaseExecutor {
  constructor(protected readonly executor: Client | Transaction) {}

  async get<T>(sql: string, args: InArgs = []): Promise<T | undefined> {
    const result = await this.executor.execute({ sql, args });
    const row = result.rows[0];
    if (!row) return undefined;
    return Object.fromEntries(result.columns.map((column, index) => [column, row[index]])) as T;
  }

  async all<T>(sql: string, args: InArgs = []): Promise<T[]> {
    const result = await this.executor.execute({ sql, args });
    return result.rows.map((row) =>
      Object.fromEntries(result.columns.map((column, index) => [column, row[index]])) as T
    );
  }

  async run(sql: string, args: InArgs = []): Promise<void> {
    await this.executor.execute({ sql, args });
  }
}

class LibsqlDatabase extends LibsqlExecutor implements DriveVaultDatabase {
  constructor(private readonly client: Client) {
    super(client);
  }

  async transaction<T>(operation: (transaction: DatabaseExecutor) => Promise<T>): Promise<T> {
    const transaction = await this.client.transaction("write");
    try {
      const result = await operation(new LibsqlExecutor(transaction));
      await transaction.commit();
      return result;
    } catch (error) {
      await transaction.rollback();
      throw error;
    }
  }

  async close(): Promise<void> {
    this.client.close();
  }
}

export async function createDatabase(databasePath: string): Promise<DriveVaultDatabase> {
  const url = process.env.TURSO_DATABASE_URL;
  const authToken = process.env.TURSO_DATABASE_TURSO_AUTH_TOKEN
    ?? process.env.TURSO_DATABASE_AUTH_TOKEN
    ?? process.env.TURSO_AUTH_TOKEN;

  if (process.env.VERCEL === "1" && !url) {
    throw new Error("TURSO_DATABASE_URL is required on Vercel; refusing to use ephemeral database storage.");
  }
  if (url && !authToken) {
    throw new Error("Turso database URL is configured but its authentication token is missing.");
  }

  let client: Client;
  if (url) {
    client = createClient({ url, authToken });
  } else {
    const absolutePath = databasePath === ":memory:" ? databasePath : path.resolve(databasePath);
    if (absolutePath !== ":memory:") {
      await mkdir(path.dirname(absolutePath), { recursive: true });
    }
    client = createClient({
      url: absolutePath === ":memory:" ? "file::memory:" : `file:${absolutePath}`,
    });
  }

  const database = new LibsqlDatabase(client);
  try {
    await runMigrations(database);
    return database;
  } catch (error) {
    await database.close();
    throw error;
  }
}

async function runMigrations(database: DriveVaultDatabase): Promise<void> {
  await database.run(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      name TEXT PRIMARY KEY,
      applied_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);

  const migrationFiles = (await readdir(migrationsDirectory))
    .filter((name) => name.endsWith(".sql"))
    .sort();

  for (const name of migrationFiles) {
    const sql = await readFile(path.join(migrationsDirectory, name), "utf8");
    await database.transaction(async (transaction) => {
      const applied = await transaction.get<{ name: string }>(
        "SELECT name FROM schema_migrations WHERE name = ?",
        [name],
      );
      if (applied) return;
      for (const statement of sql.split(";").map((part) => part.trim()).filter(Boolean)) {
        await transaction.run(statement);
      }
      await transaction.run("INSERT INTO schema_migrations (name) VALUES (?)", [name]);
    });
  }
}

import Database from "better-sqlite3";
import { mkdir, readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const migrationsDirectory = fileURLToPath(new URL("../../migrations/", import.meta.url));

export async function createDatabase(databasePath: string): Promise<Database.Database> {
  const absolutePath = databasePath === ":memory:" ? databasePath : path.resolve(databasePath);
  if (absolutePath !== ":memory:") {
    await mkdir(path.dirname(absolutePath), { recursive: true });
  }

  const database = new Database(absolutePath);
  database.pragma("foreign_keys = ON");
  database.pragma("journal_mode = WAL");
  database.pragma("busy_timeout = 5000");
  await runMigrations(database);
  return database;
}

async function runMigrations(database: Database.Database): Promise<void> {
  database.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      name TEXT PRIMARY KEY,
      applied_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);

  const migrationFiles = (await readdir(migrationsDirectory))
    .filter((name) => name.endsWith(".sql"))
    .sort();

  for (const name of migrationFiles) {
    const applied = database
      .prepare("SELECT 1 FROM schema_migrations WHERE name = ?")
      .get(name);
    if (applied) continue;

    const sql = await readFile(path.join(migrationsDirectory, name), "utf8");
    database.transaction(() => {
      database.exec(sql);
      database.prepare("INSERT INTO schema_migrations (name) VALUES (?)").run(name);
    })();
  }
}

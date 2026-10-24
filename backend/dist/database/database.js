import { createClient } from "@libsql/client";
import { mkdir, readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
const migrationsDirectory = process.env.VERCEL === "1"
    ? path.resolve(process.cwd(), "backend", "migrations")
    : fileURLToPath(new URL("../../migrations/", import.meta.url));
class LibsqlExecutor {
    executor;
    constructor(executor) {
        this.executor = executor;
    }
    async get(sql, args = []) {
        const result = await this.executor.execute({ sql, args });
        const row = result.rows[0];
        if (!row)
            return undefined;
        return Object.fromEntries(result.columns.map((column, index) => [column, row[index]]));
    }
    async all(sql, args = []) {
        const result = await this.executor.execute({ sql, args });
        return result.rows.map((row) => Object.fromEntries(result.columns.map((column, index) => [column, row[index]])));
    }
    async run(sql, args = []) {
        await this.executor.execute({ sql, args });
    }
}
class LibsqlDatabase extends LibsqlExecutor {
    client;
    constructor(client) {
        super(client);
        this.client = client;
    }
    async transaction(operation) {
        const transaction = await this.client.transaction("write");
        try {
            const result = await operation(new LibsqlExecutor(transaction));
            await transaction.commit();
            return result;
        }
        catch (error) {
            await transaction.rollback();
            throw error;
        }
    }
    async close() {
        this.client.close();
    }
}
export async function createDatabase(databasePath) {
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
    let client;
    if (url) {
        client = createClient({ url, authToken });
    }
    else {
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
    }
    catch (error) {
        await database.close();
        throw error;
    }
}
async function runMigrations(database) {
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
            const applied = await transaction.get("SELECT name FROM schema_migrations WHERE name = ?", [name]);
            if (applied)
                return;
            for (const statement of sql.split(";").map((part) => part.trim()).filter(Boolean)) {
                await transaction.run(statement);
            }
            await transaction.run("INSERT INTO schema_migrations (name) VALUES (?)", [name]);
        });
    }
}

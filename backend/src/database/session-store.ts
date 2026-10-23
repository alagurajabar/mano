import type { Database, Statement } from "better-sqlite3";
import session from "express-session";

type StoredSession = session.SessionData & { cookie: session.Cookie };

export class SQLiteSessionStore extends session.Store {
  private readonly readStatement: Statement;
  private readonly writeStatement: Statement;
  private readonly deleteStatement: Statement;
  private readonly touchStatement: Statement;

  constructor(private readonly database: Database) {
    super();
    database.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        sid TEXT PRIMARY KEY,
        sess TEXT NOT NULL,
        expires_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS sessions_expires_at_idx ON sessions (expires_at);
    `);
    this.readStatement = database.prepare(
      "SELECT sess FROM sessions WHERE sid = ? AND expires_at > ?",
    );
    this.writeStatement = database.prepare(
      `INSERT INTO sessions (sid, sess, expires_at) VALUES (?, ?, ?)
       ON CONFLICT(sid) DO UPDATE SET sess = excluded.sess, expires_at = excluded.expires_at`,
    );
    this.deleteStatement = database.prepare("DELETE FROM sessions WHERE sid = ?");
    this.touchStatement = database.prepare(
      "UPDATE sessions SET expires_at = ? WHERE sid = ?",
    );
  }

  get(
    sid: string,
    callback: (error?: Error | null, session?: StoredSession | null) => void,
  ): void {
    try {
      const row = this.readStatement.get(sid, Date.now()) as { sess: string } | undefined;
      callback(null, row ? (JSON.parse(row.sess) as StoredSession) : null);
    } catch (error) {
      callback(error instanceof Error ? error : new Error("Unable to read session"));
    }
  }

  set(sid: string, value: StoredSession, callback?: (error?: Error | null) => void): void {
    try {
      const expiresAt = value.cookie.expires
        ? new Date(value.cookie.expires).getTime()
        : Date.now() + 24 * 60 * 60 * 1000;
      this.writeStatement.run(sid, JSON.stringify(value), expiresAt);
      callback?.(null);
    } catch (error) {
      callback?.(error instanceof Error ? error : new Error("Unable to save session"));
    }
  }

  destroy(sid: string, callback?: (error?: Error | null) => void): void {
    try {
      this.deleteStatement.run(sid);
      callback?.(null);
    } catch (error) {
      callback?.(error instanceof Error ? error : new Error("Unable to delete session"));
    }
  }

  touch(sid: string, value: StoredSession, callback?: (error?: Error | null) => void): void {
    try {
      const expiresAt = value.cookie.expires
        ? new Date(value.cookie.expires).getTime()
        : Date.now() + 24 * 60 * 60 * 1000;
      this.touchStatement.run(expiresAt, sid);
      callback?.(null);
    } catch (error) {
      callback?.(error instanceof Error ? error : new Error("Unable to update session"));
    }
  }
}

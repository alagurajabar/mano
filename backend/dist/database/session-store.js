import session from "express-session";
export class SQLiteSessionStore extends session.Store {
    database;
    readStatement;
    writeStatement;
    deleteStatement;
    touchStatement;
    constructor(database) {
        super();
        this.database = database;
        database.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        sid TEXT PRIMARY KEY,
        sess TEXT NOT NULL,
        expires_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS sessions_expires_at_idx ON sessions (expires_at);
    `);
        this.readStatement = database.prepare("SELECT sess FROM sessions WHERE sid = ? AND expires_at > ?");
        this.writeStatement = database.prepare(`INSERT INTO sessions (sid, sess, expires_at) VALUES (?, ?, ?)
       ON CONFLICT(sid) DO UPDATE SET sess = excluded.sess, expires_at = excluded.expires_at`);
        this.deleteStatement = database.prepare("DELETE FROM sessions WHERE sid = ?");
        this.touchStatement = database.prepare("UPDATE sessions SET expires_at = ? WHERE sid = ?");
    }
    get(sid, callback) {
        try {
            const row = this.readStatement.get(sid, Date.now());
            callback(null, row ? JSON.parse(row.sess) : null);
        }
        catch (error) {
            callback(error instanceof Error ? error : new Error("Unable to read session"));
        }
    }
    set(sid, value, callback) {
        try {
            const expiresAt = value.cookie.expires
                ? new Date(value.cookie.expires).getTime()
                : Date.now() + 24 * 60 * 60 * 1000;
            this.writeStatement.run(sid, JSON.stringify(value), expiresAt);
            callback?.(null);
        }
        catch (error) {
            callback?.(error instanceof Error ? error : new Error("Unable to save session"));
        }
    }
    destroy(sid, callback) {
        try {
            this.deleteStatement.run(sid);
            callback?.(null);
        }
        catch (error) {
            callback?.(error instanceof Error ? error : new Error("Unable to delete session"));
        }
    }
    touch(sid, value, callback) {
        try {
            const expiresAt = value.cookie.expires
                ? new Date(value.cookie.expires).getTime()
                : Date.now() + 24 * 60 * 60 * 1000;
            this.touchStatement.run(expiresAt, sid);
            callback?.(null);
        }
        catch (error) {
            callback?.(error instanceof Error ? error : new Error("Unable to update session"));
        }
    }
}

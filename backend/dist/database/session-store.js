import session from "express-session";
export class LibsqlSessionStore extends session.Store {
    database;
    constructor(database) {
        super();
        this.database = database;
    }
    get(sid, callback) {
        void this.database.get("SELECT sess FROM sessions WHERE sid = ? AND expires_at > ?", [sid, Date.now()]).then((row) => {
            callback(null, row ? JSON.parse(row.sess) : null);
        }).catch((error) => {
            callback(error instanceof Error ? error : new Error("Unable to read session"));
        });
    }
    set(sid, value, callback) {
        const expiresAt = value.cookie.expires
            ? new Date(value.cookie.expires).getTime()
            : Date.now() + 24 * 60 * 60 * 1000;
        void this.database.run(`INSERT INTO sessions (sid, sess, expires_at) VALUES (?, ?, ?)
       ON CONFLICT(sid) DO UPDATE SET sess = excluded.sess, expires_at = excluded.expires_at`, [sid, JSON.stringify(value), expiresAt]).then(() => callback?.(null)).catch((error) => {
            callback?.(error instanceof Error ? error : new Error("Unable to save session"));
        });
    }
    destroy(sid, callback) {
        void this.database.run("DELETE FROM sessions WHERE sid = ?", [sid])
            .then(() => callback?.(null)).catch((error) => {
            callback?.(error instanceof Error ? error : new Error("Unable to delete session"));
        });
    }
    touch(sid, value, callback) {
        const expiresAt = value.cookie.expires
            ? new Date(value.cookie.expires).getTime()
            : Date.now() + 24 * 60 * 60 * 1000;
        void this.database.run("UPDATE sessions SET expires_at = ? WHERE sid = ?", [expiresAt, sid]).then(() => callback?.(null)).catch((error) => {
            callback?.(error instanceof Error ? error : new Error("Unable to update session"));
        });
    }
}

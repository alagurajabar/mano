import session from "express-session";
import type { DriveVaultDatabase } from "./database.js";

type StoredSession = session.SessionData & { cookie: session.Cookie };

export class LibsqlSessionStore extends session.Store {
  constructor(private readonly database: DriveVaultDatabase) {
    super();
  }

  get(
    sid: string,
    callback: (error?: Error | null, session?: StoredSession | null) => void,
  ): void {
    void this.database.get<{ sess: string }>(
      "SELECT sess FROM sessions WHERE sid = ? AND expires_at > ?",
      [sid, Date.now()],
    ).then((row) => {
      callback(null, row ? JSON.parse(row.sess) as StoredSession : null);
    }).catch((error: unknown) => {
      callback(error instanceof Error ? error : new Error("Unable to read session"));
    });
  }

  set(sid: string, value: StoredSession, callback?: (error?: Error | null) => void): void {
    const expiresAt = value.cookie.expires
      ? new Date(value.cookie.expires).getTime()
      : Date.now() + 24 * 60 * 60 * 1000;
    void this.database.run(
      `INSERT INTO sessions (sid, sess, expires_at) VALUES (?, ?, ?)
       ON CONFLICT(sid) DO UPDATE SET sess = excluded.sess, expires_at = excluded.expires_at`,
      [sid, JSON.stringify(value), expiresAt],
    ).then(() => callback?.(null)).catch((error: unknown) => {
      callback?.(error instanceof Error ? error : new Error("Unable to save session"));
    });
  }

  destroy(sid: string, callback?: (error?: Error | null) => void): void {
    void this.database.run("DELETE FROM sessions WHERE sid = ?", [sid])
      .then(() => callback?.(null)).catch((error: unknown) => {
        callback?.(error instanceof Error ? error : new Error("Unable to delete session"));
      });
  }

  touch(sid: string, value: StoredSession, callback?: (error?: Error | null) => void): void {
    const expiresAt = value.cookie.expires
      ? new Date(value.cookie.expires).getTime()
      : Date.now() + 24 * 60 * 60 * 1000;
    void this.database.run(
      "UPDATE sessions SET expires_at = ? WHERE sid = ?",
      [expiresAt, sid],
    ).then(() => callback?.(null)).catch((error: unknown) => {
      callback?.(error instanceof Error ? error : new Error("Unable to update session"));
    });
  }
}

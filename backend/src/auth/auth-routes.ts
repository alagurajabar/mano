import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { Router } from "express";
import { rateLimit } from "express-rate-limit";
import { z } from "zod";
import type { config as appConfig } from "../config.js";
import type { DriveVaultDatabase } from "../database/database.js";
import { hashPassword, verifyPassword } from "./password.js";

const setupSchema = z.object({
  setupKey: z.string().min(1),
  email: z.string().trim().email().max(254),
  password: z.string().min(12).max(72).refine((value) => Buffer.byteLength(value, "utf8") <= 72),
});
const loginSchema = z.object({
  email: z.string().trim().email().max(254),
  password: z.string().min(1).max(72).refine((value) => Buffer.byteLength(value, "utf8") <= 72),
});
const passwordResetSchema = z.object({
  setupKey: z.string().min(1),
  email: z.string().trim().email().max(254),
  password: z.string().min(12).max(72).refine((value) => Buffer.byteLength(value, "utf8") <= 72),
});
const authenticationRateLimit = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  message: { error: "Too many authentication attempts. Try again later." },
});

interface UserRow {
  id: string;
  email: string;
  password_hash: string;
}

export function createAuthRouter(database: DriveVaultDatabase, settings: typeof appConfig): Router {
  const router = Router();

  router.get("/status", async (_request, response) => {
    const row = await database.get<{ count: number }>("SELECT COUNT(*) AS count FROM users");
    if (!row) throw new Error("Unable to read administrator setup status.");
    response.json({ setupRequired: row.count === 0 });
  });

  router.post("/setup", authenticationRateLimit, async (request, response, next) => {
    const parsed = setupSchema.safeParse(request.body);
    if (!parsed.success) {
      response.status(400).json({ error: "Enter a valid email and a password of at least 12 characters (maximum 72 UTF-8 bytes)." });
      return;
    }

    const supplied = Buffer.from(parsed.data.setupKey);
    const expected = Buffer.from(settings.INITIAL_ADMIN_SETUP_KEY);
    if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) {
      response.status(403).json({ error: "Setup key is invalid." });
      return;
    }

    try {
      const passwordHash = await hashPassword(parsed.data.password);
      const userId = randomUUID();
      const created = await database.transaction(async (transaction) => {
        const existing = await transaction.get("SELECT 1 AS present FROM users LIMIT 1");
        if (existing) return false;
        await transaction.run(
          "INSERT INTO users (id, email, password_hash) VALUES (?, ?, ?)",
          [userId, parsed.data.email.toLowerCase(), passwordHash],
        );
        return true;
      });

      if (!created) {
        response.status(409).json({ error: "An administrator account already exists." });
        return;
      }

      request.session.regenerate((error) => {
        if (error) return next(error);
        request.session.userId = userId;
        request.session.csrfToken = randomBytes(32).toString("hex");
        request.session.save((saveError) => {
          if (saveError) return next(saveError);
          response.status(201).json({
            user: { id: userId, email: parsed.data.email.toLowerCase() },
            csrfToken: request.session.csrfToken,
          });
        });
      });
    } catch (error) {
      next(error);
    }
  });

  router.post("/login", authenticationRateLimit, async (request, response, next) => {
    const parsed = loginSchema.safeParse(request.body);
    if (!parsed.success) {
      response.status(400).json({ error: "Enter a valid email and password." });
      return;
    }

    try {
      const user = await database.get<UserRow>(
        "SELECT id, email, password_hash FROM users WHERE email = ?",
        [parsed.data.email.toLowerCase()],
      );
      const isValid = user
        ? await verifyPassword(parsed.data.password, user.password_hash)
        : false;

      if (!user || !isValid) {
        response.status(401).json({ error: "Email or password is incorrect." });
        return;
      }

      request.session.regenerate((error) => {
        if (error) return next(error);
        request.session.userId = user.id;
        request.session.csrfToken = randomBytes(32).toString("hex");
        request.session.save((saveError) => {
          if (saveError) return next(saveError);
          response.json({ user: { id: user.id, email: user.email }, csrfToken: request.session.csrfToken });
        });
      });
    } catch (error) {
      next(error);
    }
  });

  router.post("/reset-password", authenticationRateLimit, async (request, response, next) => {
    const parsed = passwordResetSchema.safeParse(request.body);
    if (!parsed.success) {
      response.status(400).json({
        error: "Enter a valid email, recovery key, and a new password of at least 12 characters (maximum 72 UTF-8 bytes).",
      });
      return;
    }

    const supplied = Buffer.from(parsed.data.setupKey);
    const expected = Buffer.from(settings.INITIAL_ADMIN_SETUP_KEY);
    if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) {
      response.status(403).json({ error: "Recovery key is invalid." });
      return;
    }

    try {
      const passwordHash = await hashPassword(parsed.data.password);
      const reset = await database.transaction(async (transaction) => {
        const user = await transaction.get<{ id: string }>(
          "SELECT id FROM users WHERE email = ?",
          [parsed.data.email.toLowerCase()],
        );
        if (!user) return false;
        await transaction.run("UPDATE users SET password_hash = ?, updated_at = datetime('now') WHERE id = ?", [
          passwordHash,
          user.id,
        ]);
        await transaction.run("DELETE FROM sessions");
        return true;
      });

      if (!reset) {
        response.status(403).json({ error: "Recovery key or administrator email is invalid." });
        return;
      }

      response.status(204).end();
    } catch (error) {
      next(error);
    }
  });

  router.get("/me", async (request, response) => {
    if (!request.session.userId) {
      response.status(401).json({ error: "Authentication required." });
      return;
    }
    const user = await database.get<{ id: string; email: string }>(
      "SELECT id, email FROM users WHERE id = ?",
      [request.session.userId],
    );
    if (!user) {
      request.session.destroy(() => undefined);
      response.status(401).json({ error: "Authentication required." });
      return;
    }
    response.json({ user });
  });

  router.post("/logout", (request, response, next) => {
    request.session.destroy((error) => {
      if (error) return next(error);
      response.clearCookie("drivevault.sid", {
        httpOnly: true,
        sameSite: "strict",
        secure: settings.COOKIE_SECURE,
        path: "/",
      });
      response.status(204).end();
    });
  });

  return router;
}

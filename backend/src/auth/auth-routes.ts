import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { Router } from "express";
import type { Database } from "better-sqlite3";
import { rateLimit } from "express-rate-limit";
import { z } from "zod";
import type { config as appConfig } from "../config.js";
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

export function createAuthRouter(database: Database, settings: typeof appConfig): Router {
  const router = Router();

  router.get("/status", (_request, response) => {
    const row = database.prepare("SELECT COUNT(*) AS count FROM users").get() as {
      count: number;
    };
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
      const createAdmin = database.transaction(() => {
        const existing = database.prepare("SELECT 1 FROM users LIMIT 1").get();
        if (existing) return false;
        database
          .prepare("INSERT INTO users (id, email, password_hash) VALUES (?, ?, ?)")
          .run(userId, parsed.data.email.toLowerCase(), passwordHash);
        return true;
      });

      if (!createAdmin()) {
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
      const user = database
        .prepare("SELECT id, email, password_hash FROM users WHERE email = ?")
        .get(parsed.data.email.toLowerCase()) as UserRow | undefined;
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

  router.get("/me", (request, response) => {
    if (!request.session.userId) {
      response.status(401).json({ error: "Authentication required." });
      return;
    }
    const user = database
      .prepare("SELECT id, email FROM users WHERE id = ?")
      .get(request.session.userId) as { id: string; email: string } | undefined;
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

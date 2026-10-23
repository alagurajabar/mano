import { afterEach, describe, expect, it } from "vitest";
import request from "supertest";
import type { Database } from "better-sqlite3";
import { createApp } from "../src/app.js";
import { createDatabase } from "../src/database/database.js";

const settings = {
  NODE_ENV: "test",
  PORT: 4000,
  FRONTEND_ORIGIN: "http://localhost:5173",
  DATABASE_PATH: ":memory:",
  SESSION_SECRET: "test-session-secret-at-least-32-characters",
  INITIAL_ADMIN_SETUP_KEY: "test-initial-setup-key-at-least-32-characters",
  GOOGLE_CLIENT_ID: "",
  GOOGLE_CLIENT_SECRET: "",
  GOOGLE_REDIRECT_URI: "http://localhost:4000/api/oauth/google/callback",
  TOKEN_ENCRYPTION_KEY: "",
  TRUST_PROXY_HOPS: 0,
  COOKIE_SECURE: false,
} as const;

let database: Database | undefined;

afterEach(() => {
  database?.close();
  database = undefined;
});

async function createTestApp() {
  database = await createDatabase(":memory:");
  return createApp(database, settings);
}

describe("administrator authentication", () => {
  it("creates one administrator, persists a session, and supports logout/login", async () => {
    const app = await createTestApp();
    const client = request.agent(app);

    expect((await client.get("/api/auth/status")).body).toEqual({ setupRequired: true });
    const csrfResponse = await client.get("/api/auth/csrf");
    const csrfToken = csrfResponse.body.csrfToken as string;
    expect(csrfResponse.headers["set-cookie"]?.[0]).toContain("HttpOnly");
    expect(csrfResponse.headers["set-cookie"]?.[0]).toContain("SameSite=Strict");

    const rejectedSetup = await client.post("/api/auth/setup")
      .set("x-csrf-token", csrfToken)
      .send({
        setupKey: "incorrect setup key",
        email: "admin@example.com",
        password: "a-very-long-test-password",
      });
    expect(rejectedSetup.status).toBe(403);

    const setup = await client.post("/api/auth/setup")
      .set("x-csrf-token", csrfToken)
      .send({
        setupKey: settings.INITIAL_ADMIN_SETUP_KEY,
        email: "Admin@example.com",
        password: "a-very-long-test-password",
      });
    expect(setup.status).toBe(201);
    expect(setup.body.user.email).toBe("admin@example.com");
    expect(setup.body).not.toHaveProperty("password_hash");
    expect((await client.get("/api/auth/me")).body.user.email).toBe("admin@example.com");

    const duplicateSetup = await client.post("/api/auth/setup")
      .set("x-csrf-token", setup.body.csrfToken)
      .send({
        setupKey: settings.INITIAL_ADMIN_SETUP_KEY,
        email: "other@example.com",
        password: "a-very-long-test-password",
      });
    expect(duplicateSetup.status).toBe(409);

    const logout = await client.post("/api/auth/logout")
      .set("x-csrf-token", setup.body.csrfToken);
    expect(logout.status).toBe(204);
    expect((await client.get("/api/auth/me")).status).toBe(401);

    const loginCsrf = (await client.get("/api/auth/csrf")).body.csrfToken as string;
    const login = await client.post("/api/auth/login")
      .set("x-csrf-token", loginCsrf)
      .send({ email: "ADMIN@example.com", password: "a-very-long-test-password" });
    expect(login.status).toBe(200);
    expect(login.body.user.email).toBe("admin@example.com");
    expect((await client.get("/api/auth/me")).status).toBe(200);
    const postLoginLogout = await client.post("/api/auth/logout")
      .set("x-csrf-token", login.body.csrfToken);
    expect(postLoginLogout.status).toBe(204);
  });

  it("rejects state-changing requests without a session CSRF token", async () => {
    const app = await createTestApp();
    const response = await request(app)
      .post("/api/auth/setup")
      .send({
        setupKey: settings.INITIAL_ADMIN_SETUP_KEY,
        email: "admin@example.com",
        password: "a-very-long-test-password",
      });
    expect(response.status).toBe(403);
  });
});

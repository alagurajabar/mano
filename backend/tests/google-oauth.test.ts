import { afterEach, describe, expect, it, vi } from "vitest";
import request from "supertest";
import { createApp } from "../src/app.js";
import { createDatabase } from "../src/database/database.js";
import type { DriveVaultDatabase } from "../src/database/database.js";

const settings = {
  NODE_ENV: "test",
  PORT: 4000,
  FRONTEND_ORIGIN: "http://localhost:5173",
  DATABASE_PATH: ":memory:",
  SESSION_SECRET: "test-session-secret-at-least-32-characters",
  INITIAL_ADMIN_SETUP_KEY: "test-initial-setup-key-at-least-32-characters",
  GOOGLE_CLIENT_ID: "test-client-id",
  GOOGLE_CLIENT_SECRET: "test-client-secret",
  GOOGLE_REDIRECT_URI: "http://localhost:4000/api/oauth/google/callback",
  TOKEN_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString("base64url"),
  TRUST_PROXY_HOPS: 0,
  COOKIE_SECURE: false,
} as const;

let database: DriveVaultDatabase | undefined;

afterEach(async () => {
  vi.unstubAllGlobals();
  await database?.close();
  database = undefined;
});

async function createAuthenticatedClient() {
  database = await createDatabase(":memory:");
  const app = createApp(database, settings);
  const client = request.agent(app);
  const csrfToken = (await client.get("/api/auth/csrf")).body.csrfToken as string;
  const setup = await client.post("/api/auth/setup")
    .set("x-csrf-token", csrfToken)
    .send({
      setupKey: settings.INITIAL_ADMIN_SETUP_KEY,
      email: "admin@example.com",
      password: "a-very-long-test-password",
    });
  expect(setup.status).toBe(201);
  return { app, client };
}

describe("Google Drive OAuth", () => {
  it("requires an authenticated administrator and reports missing configuration", async () => {
    database = await createDatabase(":memory:");
    const app = createApp(database, { ...settings, GOOGLE_CLIENT_ID: "", GOOGLE_CLIENT_SECRET: "", TOKEN_ENCRYPTION_KEY: "" });
    expect((await request(app).get("/api/google/oauth/start")).status).toBe(401);

    const client = request.agent(app);
    const csrfToken = (await client.get("/api/auth/csrf")).body.csrfToken as string;
    await client.post("/api/auth/setup")
      .set("x-csrf-token", csrfToken)
      .send({
        setupKey: settings.INITIAL_ADMIN_SETUP_KEY,
        email: "admin@example.com",
        password: "a-very-long-test-password",
      });

    const accounts = await client.get("/api/google/accounts");
    expect(accounts.status).toBe(200);
    expect(accounts.body).toMatchObject({
      configured: false,
      setupError: expect.stringContaining("Vercel Project Settings > Environment Variables"),
      accounts: [],
    });
    expect((await client.get("/api/google/oauth/start")).status).toBe(503);
  });

  it("connects an account, persists only encrypted tokens, and consumes OAuth state once", async () => {
    const { client } = await createAuthenticatedClient();
    const start = await client.get("/api/google/oauth/start");
    expect(start.status).toBe(200);
    const authorizationUrl = new URL(start.body.authorizationUrl as string);
    expect(authorizationUrl.origin).toBe("https://accounts.google.com");
    expect(authorizationUrl.searchParams.get("redirect_uri")).toBe(settings.GOOGLE_REDIRECT_URI);
    const state = authorizationUrl.searchParams.get("state");
    expect(state).toBeTruthy();

    const fetchMock = vi.fn<typeof fetch>(async (input) => {
      const url = String(input);
      if (url === "https://oauth2.googleapis.com/token") {
        return new Response(JSON.stringify({
          access_token: "access-secret",
          refresh_token: "refresh-secret",
          expires_in: 3600,
        }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      if (url === "https://openidconnect.googleapis.com/v1/userinfo") {
        return new Response(JSON.stringify({
          email: "drive@example.com",
          email_verified: true,
          name: "Drive User",
          picture: "https://example.com/photo.png",
        }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      if (url.startsWith("https://www.googleapis.com/drive/v3/about")) {
        return new Response(JSON.stringify({
          storageQuota: { usage: "1234", limit: "5678" },
        }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      if (url.startsWith("https://www.googleapis.com/drive/v3/files?")) {
        return new Response(JSON.stringify({
          files: [{ id: "folder-123", name: "Documents", mimeType: "application/vnd.google-apps.folder" }],
        }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      throw new Error(`Unexpected Google request: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const callback = await client.get("/api/oauth/google/callback")
      .query({ code: "test-code", state });
    expect(callback.status).toBe(303);
    expect(callback.headers.location).toBe("http://localhost:5173/?drive=connected");

    const accountResponse = await client.get("/api/google/accounts");
    expect(accountResponse.body).toMatchObject({
      configured: true,
      accounts: [{
        email: "drive@example.com",
        displayName: "Drive User",
        storageUsedBytes: 1234,
        storageTotalBytes: 5678,
        connectionStatus: "connected",
      }],
    });
    expect(JSON.stringify(accountResponse.body)).not.toContain("access-secret");
    expect(JSON.stringify(accountResponse.body)).not.toContain("refresh-secret");
    const accountId = accountResponse.body.accounts[0].id as string;
    const filesResponse = await client.get("/api/google/files").query({ accountId });
    expect(filesResponse.status).toBe(200);
    expect(filesResponse.body.files).toEqual([
      { id: "folder-123", name: "Documents", mimeType: "application/vnd.google-apps.folder" },
    ]);

    const stored = await database?.get<{
      encrypted_access_token: string;
      encrypted_refresh_token: string;
    }>("SELECT encrypted_access_token, encrypted_refresh_token FROM drive_accounts");
    expect(stored).toBeDefined();
    if (!stored) throw new Error("Expected the connected account to be stored.");
    expect(stored.encrypted_access_token).not.toContain("access-secret");
    expect(stored.encrypted_refresh_token).not.toContain("refresh-secret");

    const replay = await client.get("/api/oauth/google/callback")
      .query({ code: "test-code", state });
    expect(replay.status).toBe(303);
    expect(replay.headers.location).toBe("http://localhost:5173/?driveError=invalid_state");
    expect(authorizationUrl.searchParams.get("scope")).toContain("https://www.googleapis.com/auth/drive");
    expect(authorizationUrl.searchParams.get("prompt")).toBe("consent select_account");
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });
});

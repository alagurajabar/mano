import { afterEach, describe, expect, it, vi } from "vitest";
import { createDatabase } from "../src/database/database.js";

afterEach(async () => {
  vi.unstubAllEnvs();
});

describe("database storage", () => {
  it("refuses to use temporary local storage on Vercel without Turso", async () => {
    vi.stubEnv("VERCEL", "1");
    vi.stubEnv("TURSO_DATABASE_URL", "");
    vi.stubEnv("TURSO_DATABASE_TURSO_AUTH_TOKEN", "");

    await expect(createDatabase("./data/drivevault.sqlite"))
      .rejects.toThrow("TURSO_DATABASE_URL is required on Vercel");
  });
});

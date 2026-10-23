import dotenv from "dotenv";
import { existsSync } from "node:fs";
import path from "node:path";
import { z } from "zod";

const environmentFile = [path.resolve(process.cwd(), ".env"), path.resolve(process.cwd(), "..", ".env")]
  .find((candidate) => existsSync(candidate));
dotenv.config(environmentFile ? { path: environmentFile } : undefined);

const environmentSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().positive().default(4000),
  FRONTEND_ORIGIN: z.string().url().default("http://localhost:5173"),
  DATABASE_PATH: z.string().min(1).default("./data/drivevault.sqlite"),
  SESSION_SECRET: z.string().min(32),
  INITIAL_ADMIN_SETUP_KEY: z.string().min(32),
  GOOGLE_CLIENT_ID: z.string().default(""),
  GOOGLE_CLIENT_SECRET: z.string().default(""),
  GOOGLE_REDIRECT_URI: z.string().url().default("http://localhost:4000/api/oauth/google/callback"),
  TOKEN_ENCRYPTION_KEY: z.string().default(""),
  TRUST_PROXY_HOPS: z.coerce.number().int().nonnegative().default(0),
  COOKIE_SECURE: z
    .enum(["true", "false"])
    .default("false")
    .transform((value) => value === "true"),
});

export const config = environmentSchema.parse(process.env);

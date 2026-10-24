import express from "express";
import session from "express-session";
import helmet from "helmet";
import path from "node:path";
import type { config as appConfig } from "./config.js";
import { createAuthRouter } from "./auth/auth-routes.js";
import type { DriveVaultDatabase } from "./database/database.js";
import { LibsqlSessionStore } from "./database/session-store.js";
import { createGoogleRouter } from "./google-drive/oauth-routes.js";
import { provideCsrfToken, verifyCsrfToken } from "./middleware/csrf.js";

export function createApp(
  database: DriveVaultDatabase,
  settings: typeof appConfig,
  app: express.Express = express(),
): express.Express {
  app.disable("x-powered-by");
  if (settings.TRUST_PROXY_HOPS > 0) {
    app.set("trust proxy", settings.TRUST_PROXY_HOPS);
  }
  app.use(helmet());
  app.use(express.json({ limit: "16kb" }));
  app.use(
    session({
      name: "drivevault.sid",
      secret: settings.SESSION_SECRET,
      store: new LibsqlSessionStore(database),
      resave: false,
      saveUninitialized: false,
      cookie: {
        httpOnly: true,
        sameSite: "strict",
        secure: settings.COOKIE_SECURE,
        maxAge: 12 * 60 * 60 * 1000,
        path: "/",
      },
    }),
  );

  if (process.env.VERCEL === "1") {
    const publicDirectory = path.resolve(process.cwd(), "public");
    app.get("/", (_request, response, next) => {
      response.sendFile(path.join(publicDirectory, "index.html"), (error) => {
        if (error) next(error);
      });
    });
    app.get("/assets/:asset", (request, response, next) => {
      response.sendFile(request.params.asset, { root: path.join(publicDirectory, "assets") }, (error) => {
        if (error) next(error);
      });
    });
  }

  app.get("/api/health", (_request, response) => response.json({ status: "ok" }));
  app.get("/api/auth/csrf", provideCsrfToken);
  app.use("/api/auth", verifyCsrfToken);
  app.use("/api/auth", createAuthRouter(database, settings));
  app.use("/api", createGoogleRouter(database, settings));

  app.use((_request, response) => {
    response.status(404).json({ error: "Not found." });
  });
  app.use(
    (
      error: unknown,
      _request: express.Request,
      response: express.Response,
      _next: express.NextFunction,
    ) => {
      if (
        typeof error === "object" &&
        error !== null &&
        "type" in error &&
        error.type === "entity.too.large"
      ) {
        response.status(413).json({ error: "The request is too large. File uploads are limited to 4 MB." });
        return;
      }
      console.error("Unhandled API error", error);
      response.status(500).json({ error: "Something went wrong. Please try again." });
    },
  );
  return app;
}

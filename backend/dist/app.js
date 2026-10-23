import express from "express";
import session from "express-session";
import helmet from "helmet";
import { createAuthRouter } from "./auth/auth-routes.js";
import { SQLiteSessionStore } from "./database/session-store.js";
import { createGoogleRouter } from "./google-drive/oauth-routes.js";
import { provideCsrfToken, verifyCsrfToken } from "./middleware/csrf.js";
export function createApp(database, settings) {
    const app = express();
    app.disable("x-powered-by");
    if (settings.TRUST_PROXY_HOPS > 0) {
        app.set("trust proxy", settings.TRUST_PROXY_HOPS);
    }
    app.use(helmet());
    app.use(express.json({ limit: "16kb" }));
    app.use(session({
        name: "drivevault.sid",
        secret: settings.SESSION_SECRET,
        store: new SQLiteSessionStore(database),
        resave: false,
        saveUninitialized: false,
        cookie: {
            httpOnly: true,
            sameSite: "strict",
            secure: settings.COOKIE_SECURE,
            maxAge: 12 * 60 * 60 * 1000,
            path: "/",
        },
    }));
    app.get("/api/health", (_request, response) => response.json({ status: "ok" }));
    app.get("/api/auth/csrf", provideCsrfToken);
    app.use("/api/auth", verifyCsrfToken);
    app.use("/api/auth", createAuthRouter(database, settings));
    app.use("/api", createGoogleRouter(database, settings));
    app.use((_request, response) => {
        response.status(404).json({ error: "Not found." });
    });
    app.use((error, _request, response, _next) => {
        console.error("Unhandled API error", error);
        response.status(500).json({ error: "Something went wrong. Please try again." });
    });
    return app;
}

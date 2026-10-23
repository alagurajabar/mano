import { createHash, randomBytes, randomUUID } from "node:crypto";
import { Router } from "express";
import { z } from "zod";
import { requireAuthentication } from "../middleware/authentication.js";
import { encryptToken } from "./token-crypto.js";
const MAX_DRIVE_ACCOUNTS = 10;
const OAUTH_STATE_TTL_MS = 10 * 60 * 1000;
const GOOGLE_SCOPES = [
    "openid",
    "email",
    "profile",
    "https://www.googleapis.com/auth/drive.metadata.readonly",
].join(" ");
const tokenResponseSchema = z.object({
    access_token: z.string().min(1),
    refresh_token: z.string().min(1).optional(),
    expires_in: z.number().positive(),
});
const aboutResponseSchema = z.object({
    user: z.object({
        emailAddress: z.string().email(),
        displayName: z.string().optional(),
        photoLink: z.string().url().optional(),
    }),
    storageQuota: z.object({
        usage: z.string().optional(),
        limit: z.string().optional(),
    }).optional(),
});
function readOAuthCredentials(settings) {
    const placeholders = [settings.GOOGLE_CLIENT_ID, settings.GOOGLE_CLIENT_SECRET]
        .some((value) => !value.trim() || value.toLowerCase().startsWith("replace-with-"));
    if (placeholders) {
        return {
            credentials: null,
            error: "Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET in the backend .env file.",
        };
    }
    if (!settings.TOKEN_ENCRYPTION_KEY.trim() ||
        settings.TOKEN_ENCRYPTION_KEY.toLowerCase().startsWith("replace-with-")) {
        return {
            credentials: null,
            error: "Set TOKEN_ENCRYPTION_KEY to a Base64URL-encoded 32-byte key in the backend .env file.",
        };
    }
    const encryptionKeyText = settings.TOKEN_ENCRYPTION_KEY.trim();
    const encryptionKey = Buffer.from(encryptionKeyText, "base64url");
    if (!/^[A-Za-z0-9_-]{43}$/.test(encryptionKeyText) || encryptionKey.length !== 32) {
        return {
            credentials: null,
            error: "TOKEN_ENCRYPTION_KEY must decode to exactly 32 bytes.",
        };
    }
    return {
        credentials: {
            clientId: settings.GOOGLE_CLIENT_ID.trim(),
            clientSecret: settings.GOOGLE_CLIENT_SECRET.trim(),
            redirectUri: settings.GOOGLE_REDIRECT_URI,
            encryptionKey,
        },
        error: null,
    };
}
function hashState(state) {
    return createHash("sha256").update(state).digest("hex");
}
function redirectToFrontend(response, settings, query) {
    const target = new URL("/", settings.FRONTEND_ORIGIN);
    for (const [key, value] of Object.entries(query))
        target.searchParams.set(key, value);
    response.redirect(303, target.toString());
}
function parseQuota(value) {
    if (!value || !/^\d+$/.test(value))
        return null;
    const parsed = Number(value);
    return Number.isSafeInteger(parsed) ? parsed : null;
}
export function createGoogleRouter(database, settings) {
    const router = Router();
    router.get("/google/accounts", requireAuthentication, (request, response) => {
        const configured = readOAuthCredentials(settings);
        const accounts = database.prepare(`
      SELECT id, email, display_name, storage_used_bytes,
             storage_total_bytes, connection_status
      FROM drive_accounts
      WHERE user_id = ?
      ORDER BY created_at
    `).all(request.session.userId);
        response.json({
            configured: configured.credentials !== null,
            setupError: configured.error,
            accounts: accounts.map((account) => ({
                id: account.id,
                email: account.email,
                displayName: account.display_name,
                storageUsedBytes: account.storage_used_bytes,
                storageTotalBytes: account.storage_total_bytes,
                connectionStatus: account.connection_status,
            })),
        });
    });
    router.get("/google/oauth/start", requireAuthentication, (request, response) => {
        const result = readOAuthCredentials(settings);
        if (!result.credentials) {
            response.status(503).json({ error: result.error });
            return;
        }
        const userId = request.session.userId;
        const accountCount = database.prepare("SELECT COUNT(*) AS count FROM drive_accounts WHERE user_id = ?").get(userId);
        if (accountCount.count >= MAX_DRIVE_ACCOUNTS) {
            response.status(409).json({ error: `You can connect up to ${MAX_DRIVE_ACCOUNTS} Google Drive accounts.` });
            return;
        }
        const state = randomBytes(32).toString("base64url");
        const insertState = database.transaction(() => {
            database.prepare("DELETE FROM google_oauth_states WHERE expires_at <= ?").run(Date.now());
            database.prepare("INSERT INTO google_oauth_states (state_hash, user_id, expires_at) VALUES (?, ?, ?)").run(hashState(state), userId, Date.now() + OAUTH_STATE_TTL_MS);
        });
        insertState();
        const authorizationUrl = new URL("https://accounts.google.com/o/oauth2/v2/auth");
        authorizationUrl.searchParams.set("client_id", result.credentials.clientId);
        authorizationUrl.searchParams.set("redirect_uri", result.credentials.redirectUri);
        authorizationUrl.searchParams.set("response_type", "code");
        authorizationUrl.searchParams.set("scope", GOOGLE_SCOPES);
        authorizationUrl.searchParams.set("access_type", "offline");
        authorizationUrl.searchParams.set("include_granted_scopes", "true");
        authorizationUrl.searchParams.set("prompt", "consent");
        authorizationUrl.searchParams.set("state", state);
        response.json({ authorizationUrl: authorizationUrl.toString() });
    });
    router.get("/oauth/google/callback", async (request, response, next) => {
        const state = typeof request.query.state === "string" ? request.query.state : "";
        if (!state) {
            redirectToFrontend(response, settings, { driveError: "invalid_state" });
            return;
        }
        const consumeState = database.transaction(() => {
            const pending = database.prepare("SELECT user_id FROM google_oauth_states WHERE state_hash = ? AND expires_at > ?").get(hashState(state), Date.now());
            database.prepare("DELETE FROM google_oauth_states WHERE state_hash = ?").run(hashState(state));
            return pending;
        });
        const pending = consumeState();
        if (!pending) {
            redirectToFrontend(response, settings, { driveError: "invalid_state" });
            return;
        }
        if (request.query.error) {
            redirectToFrontend(response, settings, { driveError: "cancelled" });
            return;
        }
        const code = typeof request.query.code === "string" ? request.query.code : "";
        const result = readOAuthCredentials(settings);
        if (!result.credentials || !code) {
            redirectToFrontend(response, settings, { driveError: "configuration" });
            return;
        }
        try {
            const tokenResponse = await fetch("https://oauth2.googleapis.com/token", {
                method: "POST",
                headers: { "Content-Type": "application/x-www-form-urlencoded" },
                body: new URLSearchParams({
                    code,
                    client_id: result.credentials.clientId,
                    client_secret: result.credentials.clientSecret,
                    redirect_uri: result.credentials.redirectUri,
                    grant_type: "authorization_code",
                }),
            });
            if (!tokenResponse.ok) {
                redirectToFrontend(response, settings, { driveError: "token_exchange" });
                return;
            }
            const token = tokenResponseSchema.safeParse(await tokenResponse.json());
            if (!token.success) {
                redirectToFrontend(response, settings, { driveError: "token_exchange" });
                return;
            }
            const aboutResponse = await fetch("https://www.googleapis.com/drive/v3/about?fields=user(displayName,emailAddress,photoLink),storageQuota", { headers: { Authorization: `Bearer ${token.data.access_token}` } });
            if (!aboutResponse.ok) {
                redirectToFrontend(response, settings, { driveError: "profile" });
                return;
            }
            const about = aboutResponseSchema.safeParse(await aboutResponse.json());
            if (!about.success) {
                redirectToFrontend(response, settings, { driveError: "profile" });
                return;
            }
            const accountId = randomUUID();
            const encryptedAccessToken = encryptToken(token.data.access_token, result.credentials.encryptionKey);
            const encryptedRefreshToken = token.data.refresh_token
                ? encryptToken(token.data.refresh_token, result.credentials.encryptionKey)
                : null;
            const expiresAt = new Date(Date.now() + token.data.expires_in * 1000).toISOString();
            const insertAccount = database.transaction(() => {
                const existing = database.prepare("SELECT 1 FROM drive_accounts WHERE user_id = ? AND email = ? COLLATE NOCASE").get(pending.user_id, about.data.user.emailAddress);
                const count = database.prepare("SELECT COUNT(*) AS count FROM drive_accounts WHERE user_id = ?").get(pending.user_id);
                if (!existing && count.count >= MAX_DRIVE_ACCOUNTS)
                    return false;
                database.prepare(`
          INSERT INTO drive_accounts (
            id, user_id, email, display_name, photo_url, encrypted_access_token,
            encrypted_refresh_token, token_expires_at, storage_used_bytes,
            storage_total_bytes, connection_status
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'connected')
          ON CONFLICT(user_id, email) DO UPDATE SET
            display_name = excluded.display_name,
            photo_url = excluded.photo_url,
            encrypted_access_token = excluded.encrypted_access_token,
            encrypted_refresh_token = COALESCE(excluded.encrypted_refresh_token, drive_accounts.encrypted_refresh_token),
            token_expires_at = excluded.token_expires_at,
            storage_used_bytes = excluded.storage_used_bytes,
            storage_total_bytes = excluded.storage_total_bytes,
            connection_status = 'connected',
            updated_at = datetime('now')
        `).run(accountId, pending.user_id, about.data.user.emailAddress.toLowerCase(), about.data.user.displayName ?? null, about.data.user.photoLink ?? null, encryptedAccessToken, encryptedRefreshToken, expiresAt, parseQuota(about.data.storageQuota?.usage), parseQuota(about.data.storageQuota?.limit));
                return true;
            });
            if (!insertAccount()) {
                redirectToFrontend(response, settings, { driveError: "account_limit" });
                return;
            }
            redirectToFrontend(response, settings, { drive: "connected" });
        }
        catch (error) {
            next(error);
        }
    });
    return router;
}

import { createHash, randomBytes, randomUUID } from "node:crypto";
import express, { Router } from "express";
import { z } from "zod";
import { requireAuthentication } from "../middleware/authentication.js";
import { verifyCsrfToken } from "../middleware/csrf.js";
import { decryptToken, encryptToken } from "./token-crypto.js";
const MAX_DRIVE_ACCOUNTS = 10;
const OAUTH_STATE_TTL_MS = 10 * 60 * 1000;
const GOOGLE_SCOPES = [
    "openid",
    "email",
    "profile",
    "https://www.googleapis.com/auth/drive",
].join(" ");
const MAX_UPLOAD_BYTES = 4 * 1024 * 1024;
const GOOGLE_FILE_ID = /^[A-Za-z0-9_-]+$/;
const GOOGLE_EXPORT_TYPES = {
    "application/vnd.google-apps.document": {
        mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        extension: ".docx",
    },
    "application/vnd.google-apps.spreadsheet": {
        mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        extension: ".xlsx",
    },
    "application/vnd.google-apps.presentation": {
        mimeType: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
        extension: ".pptx",
    },
    "application/vnd.google-apps.drawing": {
        mimeType: "image/png",
        extension: ".png",
    },
};
class DriveRequestError extends Error {
    status;
    constructor(message, status) {
        super(message);
        this.status = status;
    }
}
const tokenResponseSchema = z.object({
    access_token: z.string().min(1),
    refresh_token: z.string().min(1).optional(),
    expires_in: z.number().positive(),
});
const driveTokenResponseSchema = z.object({
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
const fileListSchema = z.object({
    files: z.array(z.object({
        id: z.string(),
        name: z.string(),
        mimeType: z.string(),
        size: z.string().optional(),
        modifiedTime: z.string().optional(),
        webViewLink: z.string().url().optional(),
        parents: z.array(z.string()).optional(),
    })),
    nextPageToken: z.string().optional(),
});
async function getDriveAccessToken(database, settings, userId, accountId) {
    const configured = readOAuthCredentials(settings);
    if (!configured.credentials)
        throw new DriveRequestError(configured.error, 503);
    const account = await database.get(`
    SELECT id, encrypted_access_token, encrypted_refresh_token, token_expires_at
    FROM drive_accounts
    WHERE id = ? AND user_id = ?
  `, [accountId, userId]);
    if (!account)
        throw new DriveRequestError("Connected Google Drive account not found.", 404);
    if (!account.encrypted_access_token) {
        throw new DriveRequestError("Reconnect this Google Drive account to restore access.", 401);
    }
    const expiresAt = account.token_expires_at ? Date.parse(account.token_expires_at) : 0;
    if (expiresAt > Date.now() + 60_000) {
        return {
            accessToken: decryptToken(account.encrypted_access_token, configured.credentials.encryptionKey),
            credentials: configured.credentials,
        };
    }
    if (!account.encrypted_refresh_token) {
        await database.run("UPDATE drive_accounts SET connection_status = 'reauth_required' WHERE id = ? AND user_id = ?", [accountId, userId]);
        throw new DriveRequestError("Reconnect this Google Drive account to restore access.", 401);
    }
    const refreshToken = decryptToken(account.encrypted_refresh_token, configured.credentials.encryptionKey);
    const response = await fetch("https://oauth2.googleapis.com/token", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
            client_id: configured.credentials.clientId,
            client_secret: configured.credentials.clientSecret,
            refresh_token: refreshToken,
            grant_type: "refresh_token",
        }),
    });
    if (!response.ok) {
        await database.run("UPDATE drive_accounts SET connection_status = 'reauth_required' WHERE id = ? AND user_id = ?", [accountId, userId]);
        throw new DriveRequestError("Google authorization expired. Reconnect this account.", 401);
    }
    const refreshed = driveTokenResponseSchema.safeParse(await response.json());
    if (!refreshed.success)
        throw new DriveRequestError("Google returned an invalid token response.", 502);
    const nextExpiry = new Date(Date.now() + refreshed.data.expires_in * 1000).toISOString();
    await database.run(`
    UPDATE drive_accounts
    SET encrypted_access_token = ?, token_expires_at = ?,
        connection_status = 'connected', updated_at = datetime('now')
    WHERE id = ? AND user_id = ?
  `, [
        encryptToken(refreshed.data.access_token, configured.credentials.encryptionKey),
        nextExpiry,
        accountId,
        userId,
    ]);
    return { accessToken: refreshed.data.access_token, credentials: configured.credentials };
}
function accountIdFromRequest(request) {
    const parsed = z.string().uuid().safeParse(request.query.accountId);
    if (!parsed.success)
        throw new DriveRequestError("Select a valid connected Drive account.", 400);
    return parsed.data;
}
function requireFileId(fileId) {
    if (typeof fileId !== "string" || !GOOGLE_FILE_ID.test(fileId)) {
        throw new DriveRequestError("Invalid Google Drive file ID.", 400);
    }
    return fileId;
}
function sendDriveError(error, response, next) {
    if (error instanceof DriveRequestError) {
        response.status(error.status).json({ error: error.message });
        return;
    }
    next(error);
}
function googleApiUrl(endpoint, params) {
    const url = new URL(`https://www.googleapis.com/drive/v3/${endpoint}`);
    for (const [key, value] of Object.entries(params))
        url.searchParams.set(key, value);
    return url;
}
function readOAuthCredentials(settings) {
    const placeholders = [settings.GOOGLE_CLIENT_ID, settings.GOOGLE_CLIENT_SECRET]
        .some((value) => !value.trim() || value.toLowerCase().startsWith("replace-with-"));
    if (placeholders) {
        return {
            credentials: null,
            error: "Configure GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET in the deployment environment (Vercel Project Settings > Environment Variables for production, or backend .env for local development).",
        };
    }
    if (!settings.TOKEN_ENCRYPTION_KEY.trim() ||
        settings.TOKEN_ENCRYPTION_KEY.toLowerCase().startsWith("replace-with-")) {
        return {
            credentials: null,
            error: "Configure TOKEN_ENCRYPTION_KEY as a Base64URL-encoded 32-byte key in the deployment environment (Vercel Project Settings > Environment Variables for production, or backend .env for local development).",
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
    router.use(verifyCsrfToken);
    router.get("/google/accounts", requireAuthentication, async (request, response) => {
        const userId = request.session.userId;
        if (!userId) {
            response.status(401).json({ error: "Authentication required." });
            return;
        }
        const configured = readOAuthCredentials(settings);
        const accounts = await database.all(`
      SELECT id, email, display_name, storage_used_bytes,
             storage_total_bytes, connection_status
      FROM drive_accounts
      WHERE user_id = ?
      ORDER BY created_at
    `, [userId]);
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
    router.get("/google/files", requireAuthentication, async (request, response, next) => {
        try {
            const userId = request.session.userId;
            if (!userId)
                throw new DriveRequestError("Authentication required.", 401);
            const accountId = accountIdFromRequest(request);
            const folderId = typeof request.query.folderId === "string"
                ? requireFileId(request.query.folderId)
                : "root";
            const pageToken = typeof request.query.pageToken === "string" ? request.query.pageToken : "";
            const { accessToken } = await getDriveAccessToken(database, settings, userId, accountId);
            const url = googleApiUrl("files", {
                q: `'${folderId.replaceAll("\\", "\\\\").replaceAll("'", "\\'")}' in parents and trashed = false`,
                pageSize: "100",
                orderBy: "folder,name",
                fields: "nextPageToken,files(id,name,mimeType,size,modifiedTime,webViewLink,parents)",
                includeItemsFromAllDrives: "true",
                supportsAllDrives: "true",
            });
            if (pageToken)
                url.searchParams.set("pageToken", pageToken);
            const googleResponse = await fetch(url, {
                headers: { Authorization: `Bearer ${accessToken}` },
            });
            if (!googleResponse.ok) {
                if (googleResponse.status === 401 || googleResponse.status === 403) {
                    await database.run("UPDATE drive_accounts SET connection_status = 'reauth_required' WHERE id = ? AND user_id = ?", [accountId, userId]);
                    throw new DriveRequestError("Reconnect this account and approve Drive file access to browse its files.", 401);
                }
                throw new DriveRequestError("Google Drive could not list files for this account.", 502);
            }
            const result = fileListSchema.safeParse(await googleResponse.json());
            if (!result.success)
                throw new DriveRequestError("Google Drive returned an invalid file list.", 502);
            response.json(result.data);
        }
        catch (error) {
            sendDriveError(error, response, next);
        }
    });
    router.get("/google/files/:fileId/download", requireAuthentication, async (request, response, next) => {
        try {
            const userId = request.session.userId;
            if (!userId)
                throw new DriveRequestError("Authentication required.", 401);
            const accountId = accountIdFromRequest(request);
            const fileId = requireFileId(request.params.fileId);
            const { accessToken } = await getDriveAccessToken(database, settings, userId, accountId);
            const sourceMimeType = typeof request.query.mimeType === "string" ? request.query.mimeType : "";
            const exportType = GOOGLE_EXPORT_TYPES[sourceMimeType];
            const endpoint = exportType
                ? `files/${encodeURIComponent(fileId)}/export`
                : `files/${encodeURIComponent(fileId)}`;
            const params = exportType
                ? { mimeType: exportType.mimeType }
                : { alt: "media", supportsAllDrives: "true" };
            const googleResponse = await fetch(googleApiUrl(endpoint, params), { headers: { Authorization: `Bearer ${accessToken}` } });
            if (!googleResponse.ok || !googleResponse.body) {
                throw new DriveRequestError("Google Drive could not download this file.", 502);
            }
            response.setHeader("Content-Type", googleResponse.headers.get("content-type") ?? "application/octet-stream");
            response.setHeader("Cache-Control", "private, no-store");
            const contentLength = googleResponse.headers.get("content-length");
            if (contentLength)
                response.setHeader("Content-Length", contentLength);
            const requestedName = typeof request.query.name === "string" ? request.query.name.slice(0, 200) : "download";
            const downloadName = exportType && !requestedName.toLowerCase().endsWith(exportType.extension)
                ? `${requestedName}${exportType.extension}`
                : requestedName;
            const dispositionName = encodeURIComponent(downloadName);
            response.setHeader("Content-Disposition", `attachment; filename*=UTF-8''${dispositionName}`);
            const { Readable } = await import("node:stream");
            const { pipeline } = await import("node:stream/promises");
            await pipeline(Readable.from(googleResponse.body), response);
        }
        catch (error) {
            if (response.headersSent) {
                response.destroy(error instanceof Error ? error : new Error("Drive download failed."));
                return;
            }
            sendDriveError(error, response, next);
        }
    });
    router.post("/google/files", requireAuthentication, express.raw({ type: "application/octet-stream", limit: MAX_UPLOAD_BYTES }), async (request, response, next) => {
        try {
            const userId = request.session.userId;
            if (!userId)
                throw new DriveRequestError("Authentication required.", 401);
            const accountId = accountIdFromRequest(request);
            const body = z.object({
                name: z.string().trim().min(1).max(255),
                mimeType: z.string().trim().min(1).max(255),
                parentId: z.string().optional(),
            }).safeParse(request.query);
            if (!body.success)
                throw new DriveRequestError("Provide a valid file name and type.", 400);
            if (!Buffer.isBuffer(request.body))
                throw new DriveRequestError("Choose a file to upload.", 400);
            if (body.data.parentId)
                requireFileId(body.data.parentId);
            const { accessToken } = await getDriveAccessToken(database, settings, userId, accountId);
            const boundary = `drivevault-${randomBytes(12).toString("hex")}`;
            const metadata = {
                name: body.data.name,
                mimeType: body.data.mimeType,
            };
            if (body.data.parentId)
                metadata.parents = [body.data.parentId];
            const prefix = Buffer.from(`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n` +
                `--${boundary}\r\nContent-Type: ${body.data.mimeType}\r\n\r\n`);
            const suffix = Buffer.from(`\r\n--${boundary}--`);
            const googleResponse = await fetch(googleApiUrl("files", { uploadType: "multipart", fields: "id,name,mimeType,size,modifiedTime,webViewLink,parents" }), {
                method: "POST",
                headers: {
                    Authorization: `Bearer ${accessToken}`,
                    "Content-Type": `multipart/related; boundary=${boundary}`,
                },
                body: Buffer.concat([prefix, request.body, suffix]),
            });
            if (!googleResponse.ok)
                throw new DriveRequestError("Google Drive rejected the file upload.", 502);
            response.status(201).json(await googleResponse.json());
        }
        catch (error) {
            sendDriveError(error, response, next);
        }
    });
    router.post("/google/folders", requireAuthentication, async (request, response, next) => {
        try {
            const userId = request.session.userId;
            if (!userId)
                throw new DriveRequestError("Authentication required.", 401);
            const accountId = accountIdFromRequest(request);
            const folder = z.object({
                name: z.string().trim().min(1).max(255),
                parentId: z.string().optional(),
            }).safeParse(request.body);
            if (!folder.success)
                throw new DriveRequestError("Provide a valid folder name.", 400);
            if (folder.data.parentId)
                requireFileId(folder.data.parentId);
            const { accessToken } = await getDriveAccessToken(database, settings, userId, accountId);
            const googleResponse = await fetch(googleApiUrl("files", {
                fields: "id,name,mimeType,modifiedTime,webViewLink,parents",
            }), {
                method: "POST",
                headers: {
                    Authorization: `Bearer ${accessToken}`,
                    "Content-Type": "application/json",
                },
                body: JSON.stringify({
                    name: folder.data.name,
                    mimeType: "application/vnd.google-apps.folder",
                    ...(folder.data.parentId ? { parents: [folder.data.parentId] } : {}),
                }),
            });
            if (!googleResponse.ok)
                throw new DriveRequestError("Google Drive could not create the folder.", 502);
            response.status(201).json(await googleResponse.json());
        }
        catch (error) {
            sendDriveError(error, response, next);
        }
    });
    router.patch("/google/files/:fileId", requireAuthentication, async (request, response, next) => {
        try {
            const userId = request.session.userId;
            if (!userId)
                throw new DriveRequestError("Authentication required.", 401);
            const accountId = accountIdFromRequest(request);
            const fileId = requireFileId(request.params.fileId);
            const rename = z.object({ name: z.string().trim().min(1).max(255) }).safeParse(request.body);
            if (!rename.success)
                throw new DriveRequestError("Provide a valid file name.", 400);
            const { accessToken } = await getDriveAccessToken(database, settings, userId, accountId);
            const googleResponse = await fetch(googleApiUrl(`files/${encodeURIComponent(fileId)}`, {
                fields: "id,name,mimeType,size,modifiedTime,webViewLink,parents",
                supportsAllDrives: "true",
            }), {
                method: "PATCH",
                headers: {
                    Authorization: `Bearer ${accessToken}`,
                    "Content-Type": "application/json",
                },
                body: JSON.stringify(rename.data),
            });
            if (!googleResponse.ok)
                throw new DriveRequestError("Google Drive could not rename this file.", 502);
            response.json(await googleResponse.json());
        }
        catch (error) {
            sendDriveError(error, response, next);
        }
    });
    router.delete("/google/files/:fileId", requireAuthentication, async (request, response, next) => {
        try {
            const userId = request.session.userId;
            if (!userId)
                throw new DriveRequestError("Authentication required.", 401);
            const accountId = accountIdFromRequest(request);
            const fileId = requireFileId(request.params.fileId);
            const { accessToken } = await getDriveAccessToken(database, settings, userId, accountId);
            const googleResponse = await fetch(googleApiUrl(`files/${encodeURIComponent(fileId)}`, {
                supportsAllDrives: "true",
            }), {
                method: "PATCH",
                headers: {
                    Authorization: `Bearer ${accessToken}`,
                    "Content-Type": "application/json",
                },
                body: JSON.stringify({ trashed: true }),
            });
            if (!googleResponse.ok)
                throw new DriveRequestError("Google Drive could not move this file to Trash.", 502);
            response.status(204).end();
        }
        catch (error) {
            sendDriveError(error, response, next);
        }
    });
    router.get("/google/oauth/start", requireAuthentication, async (request, response) => {
        const result = readOAuthCredentials(settings);
        if (!result.credentials) {
            response.status(503).json({ error: result.error });
            return;
        }
        const userId = request.session.userId;
        if (!userId) {
            response.status(401).json({ error: "Authentication required." });
            return;
        }
        const state = randomBytes(32).toString("base64url");
        await database.transaction(async (transaction) => {
            await transaction.run("DELETE FROM google_oauth_states WHERE expires_at <= ?", [Date.now()]);
            await transaction.run("INSERT INTO google_oauth_states (state_hash, user_id, expires_at) VALUES (?, ?, ?)", [hashState(state), userId, Date.now() + OAUTH_STATE_TTL_MS]);
        });
        const authorizationUrl = new URL("https://accounts.google.com/o/oauth2/v2/auth");
        authorizationUrl.searchParams.set("client_id", result.credentials.clientId);
        authorizationUrl.searchParams.set("redirect_uri", result.credentials.redirectUri);
        authorizationUrl.searchParams.set("response_type", "code");
        authorizationUrl.searchParams.set("scope", GOOGLE_SCOPES);
        authorizationUrl.searchParams.set("access_type", "offline");
        authorizationUrl.searchParams.set("include_granted_scopes", "true");
        authorizationUrl.searchParams.set("prompt", "consent select_account");
        authorizationUrl.searchParams.set("state", state);
        response.json({ authorizationUrl: authorizationUrl.toString() });
    });
    router.get("/oauth/google/callback", async (request, response, next) => {
        const state = typeof request.query.state === "string" ? request.query.state : "";
        if (!state) {
            redirectToFrontend(response, settings, { driveError: "invalid_state" });
            return;
        }
        const pending = await database.transaction(async (transaction) => {
            const pending = await transaction.get("SELECT user_id FROM google_oauth_states WHERE state_hash = ? AND expires_at > ?", [hashState(state), Date.now()]);
            await transaction.run("DELETE FROM google_oauth_states WHERE state_hash = ?", [hashState(state)]);
            return pending;
        });
        if (!pending) {
            redirectToFrontend(response, settings, { driveError: "invalid_state" });
            return;
        }
        if (request.query.error) {
            redirectToFrontend(response, settings, {
                driveError: request.query.error === "access_denied" ? "access_denied" : "cancelled",
            });
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
            const inserted = await database.transaction(async (transaction) => {
                const existing = await transaction.get("SELECT 1 AS present FROM drive_accounts WHERE user_id = ? AND email = ? COLLATE NOCASE", [pending.user_id, about.data.user.emailAddress]);
                const count = await transaction.get("SELECT COUNT(*) AS count FROM drive_accounts WHERE user_id = ?", [pending.user_id]);
                if (!count)
                    throw new Error("Unable to count connected Google Drive accounts.");
                if (!existing && count.count >= MAX_DRIVE_ACCOUNTS)
                    return false;
                await transaction.run(`
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
        `, [
                    accountId,
                    pending.user_id,
                    about.data.user.emailAddress.toLowerCase(),
                    about.data.user.displayName ?? null,
                    about.data.user.photoLink ?? null,
                    encryptedAccessToken,
                    encryptedRefreshToken,
                    expiresAt,
                    parseQuota(about.data.storageQuota?.usage),
                    parseQuota(about.data.storageQuota?.limit),
                ]);
                return true;
            });
            if (!inserted) {
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

# DriveVault

DriveVault is a private, single-admin cloud and media dashboard. Original files remain in connected Google Drive accounts; DriveVault stores account credentials securely and maintains a metadata/index layer.

## Architecture

- **Frontend:** React, TypeScript, Vite, Tailwind CSS, and Lucide. The browser calls only the DriveVault API.
- **Backend:** Node.js, TypeScript, and Express. Google Drive access belongs in a server-only service layer; OAuth tokens, Drive file IDs, and resumable upload URLs must never be returned to the browser.
- **Database:** SQLite-compatible libSQL with versioned SQL migrations. Local development uses a file database; Vercel uses the shared Turso database so administrator accounts, sessions, and connected Drive accounts persist across function instances and deployments.
- **Authentication:** One administrator account, bcrypt password hashes, server-side SQLite sessions, HTTP-only SameSite cookies, a per-session CSRF token, and a one-time bootstrap secret.

### Database schema (Phase 1 foundation)

| Table | Purpose |
| --- | --- |
| `users` | Administrator identity and password hash |
| `sessions` | Server-side session payload and expiry |
| `drive_accounts` | Drive identity, encrypted token fields, quota, and connection state |
| `virtual_folders` | User-visible folder tree and optional Drive-folder mapping |
| `files` | File metadata, Drive mapping, integrity metadata, and upload state |
| `shares` | Hashed share token, target file/folder, download and expiry policy |
| `upload_sessions` | Resumable upload state and byte progress |
| `download_logs` | Completed/partial transfer audit data |
| `app_settings` | Persisted application and transfer preferences |

All migrations are additive and tracked in `schema_migrations`; OAuth states and encrypted account tokens remain server-side.

### Project layout

```text
frontend/
  src/                 React app, API client, styles
backend/
  migrations/          Versioned SQL migrations
  src/
    auth/              Login, setup, password handling
    database/          SQLite initialization and session store
    middleware/         Authentication and CSRF middleware
    google-drive/       Google OAuth and token handling
    routes/             API route modules (Phase 2+)
    services/           Domain services (Phase 2+)
.env.example
```

### Planned flows

1. **Google Drive (partially implemented):** An authenticated admin can connect up to ten accounts, browse folders, download files, create folders, upload files up to 4 MB, rename files, and move files to Trash. OAuth tokens stay encrypted on the server and are refreshed automatically. Large/resumable transfers, sharing, and Google Workspace document export are not implemented yet.
2. **Large uploads (Phase 4):** The client streams chunks; the API streams them into a Drive resumable session without holding full files in memory. The chosen single account must have enough free quota. Persist session state, report progress, retry transient errors with bounded exponential backoff, verify final Drive metadata, then atomically mark the virtual file complete. Reconcile Drive success if the metadata transaction fails.
3. **Downloads and previews (Phases 5–6):** API routes authorize the owner or share before each response, proxy Drive media as a stream, and forward validated HTTP Range requests for seeking and resumable downloads. Do not expose Drive URLs or IDs.
4. **Share links (Phase 7):** Generate a cryptographically random bearer token, persist only its hash, and check token, target scope, expiry, disabled status, password, and download policy on every request. Folder grants are confined to the selected folder subtree.
5. **Deployment:** Serve UI and API from one HTTPS origin behind a reverse proxy. Inject secrets through the deployment environment, persist and back up the SQLite data directory, set secure cookies, and configure Google OAuth redirect URIs to the production callback.

### Vercel demo deployment

The Vercel configuration builds the Express API as a function and serves the Vite frontend from `public/`. Connect a Turso database to the Vercel project and expose its production variables as `TURSO_DATABASE_URL` and `TURSO_DATABASE_TURSO_AUTH_TOKEN`. Set `SESSION_SECRET`, `INITIAL_ADMIN_SETUP_KEY`, and the Google OAuth variables in Vercel Production as well. The API refuses to start on Vercel if the durable database URL is missing; it does not silently fall back to per-instance `/tmp` storage. Existing migrations are applied automatically at startup.

## Requirements

- Node.js 20 or newer
- npm 8 or newer
- Google Cloud project and OAuth credentials (needed from Phase 2 onward)

## Install and run

```powershell
Copy-Item .env.example .env
# Set SESSION_SECRET and INITIAL_ADMIN_SETUP_KEY to separate random values of 32+ characters.
npm install
npm run dev
```

The API is available at `http://localhost:4000`; the Vite app is at `http://localhost:5173`. With the workspace script, the default SQLite file is created under `backend/data/`.
On first visit, create the administrator using the configured setup key and a password of at least 12 characters. The setup route permits only one administrator and becomes unavailable after creation.

## Phase 1 test procedure

1. Run `npm run typecheck`, `npm test`, and `npm run build`.
2. Start with a new `DATABASE_PATH`; open the frontend and confirm first-time setup is shown.
3. Submit an invalid setup key and confirm setup is rejected. Submit a valid key, email, and password; confirm the dashboard appears.
4. Refresh; confirm the session is restored. Sign out and sign back in; confirm access returns.
5. Confirm a second setup attempt is rejected and that the database is created under `data/`.

## Google Cloud setup

1. Create a Google Cloud project and enable the Google Drive API.
2. Configure the OAuth consent screen for the intended users and add every Google account to **Test users** while the app is in Testing. This app requests the broad `https://www.googleapis.com/auth/drive` scope so it can manage files across each connected Drive. Google may require OAuth verification (and additional review) before accounts outside the tester list can authorize it. Google also expires refresh tokens after seven days for external apps left in Testing when they request Drive scopes, so publishing and completing the required verification is necessary for persistent connections.
3. Create an OAuth client with application type **Web application**. Keep the client secret on the backend only.
4. Add `http://localhost:4000/api/oauth/google/callback` to Authorized redirect URIs for local development and the HTTPS callback URL for production.
5. For local development, set `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REDIRECT_URI`, and `TOKEN_ENCRYPTION_KEY` in `backend/.env` (or the workspace `.env`); never commit real values. For Vercel production, set the same variables in Project Settings → Environment Variables for the Production environment, then redeploy. The client ID and secret must come from the same OAuth client. The setup key is unrelated to Google OAuth. Generate `TOKEN_ENCRYPTION_KEY` with:

   ```powershell
   node -e "console.log(require('node:crypto').randomBytes(32).toString('base64url'))"
   ```

   Restart both services after updating `.env`. Open **Storage Accounts** and select **Connect Google Drive**. Google account selection appears for each connection. If an account was previously connected with metadata-only access, reconnect it to grant the file-management permission. In Google Cloud Console, add each account under OAuth consent screen → Audience → Test users while the app remains in Testing.

## Production checklist

- Use HTTPS and `COOKIE_SECURE=true`; terminate TLS at a trusted reverse proxy.
- Set `TRUST_PROXY_HOPS` to the exact number of trusted proxy hops (commonly `1`) so Express recognizes HTTPS forwarding. Do not trust arbitrary client-supplied forwarding headers.
- Use independent, high-entropy session, bootstrap, OAuth encryption, and database backup credentials.
- Keep the Turso auth token and OAuth encryption key private, and configure database backups/restore procedures for the Turso database.
- Configure proxy trust only for the known proxy, rate limits, monitoring, and tested restore procedures.
- Do not expose backend OAuth secrets or Drive IDs through frontend bundles, logs, or public responses.
- Vercel uploads are currently limited to 4 MB per file; use Google Drive directly for larger files until resumable transfer support is added.

Generate local secrets with Node's cryptographic random generator, for example:

```powershell
node -e "console.log(require('node:crypto').randomBytes(32).toString('base64url'))"
```

Use a different generated value for each secret. Generate `TOKEN_ENCRYPTION_KEY` as 32 random bytes encoded with Base64URL; keep a protected backup because losing it makes encrypted Drive credentials unrecoverable.

## Troubleshooting

- **The frontend cannot connect:** Confirm both Vite (`5173`) and the API (`4000`) are running; Vite proxies `/api` to the API.
- **Setup key rejected:** Confirm the `INITIAL_ADMIN_SETUP_KEY` in `.env` matches the submitted value. Setup can create only the first administrator.
- **Secure cookie does not persist locally:** Use `COOKIE_SECURE=false` only for local HTTP development. Set it to `true` behind HTTPS in production.
- **Database or migrations fail to open:** Locally, check that `DATABASE_PATH` points to a writable location. On Vercel, verify the Turso URL and auth token are attached to the Production environment.
- **Google OAuth redirect mismatch:** The callback URL in Google Cloud Console must exactly match `GOOGLE_REDIRECT_URI`, including scheme, host, port, and path.

## Current implementation scope

The app includes secure admin bootstrap/login/logout, persisted sessions, CSRF validation, authentication throttling, Google OAuth account connection, encrypted token storage, and Drive account quota metadata. File browsing and operations, transfers, and shares are still scheduled for later phases; the navigation entries for those sections are currently placeholders.

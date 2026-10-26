import { useEffect, useState } from "react";
import {
  ArrowDownToLine,
  ArrowUpFromLine,
  ChartNoAxesCombined,
  ChevronRight,
  Cloud,
  Download,
  ExternalLink,
  File,
  FileText,
  FileSpreadsheet,
  Film,
  Folder,
  FolderPlus,
  HardDrive,
  Image,
  LayoutDashboard,
  LogOut,
  Music2,
  Pencil,
  Plus,
  Presentation,
  RefreshCw,
  Search,
  Settings,
  ShieldCheck,
  Share2,
  Trash2,
  Upload,
} from "lucide-react";
import { apiRequest, ApiRequestError, clearCsrfToken } from "./api";

interface User {
  id: string;
  email: string;
}

interface AuthStatus {
  setupRequired: boolean;
}

type Section = "Dashboard" | "My Files" | "Videos" | "PDFs" | "Shared" | "Transfers" | "Storage Accounts" | "Settings";

const navigation: { label: Section; icon: typeof LayoutDashboard }[] = [
  { label: "Dashboard", icon: LayoutDashboard },
  { label: "My Files", icon: Folder },
  { label: "Videos", icon: Film },
  { label: "PDFs", icon: FileText },
  { label: "Shared", icon: Share2 },
  { label: "Transfers", icon: ArrowUpFromLine },
  { label: "Storage Accounts", icon: HardDrive },
  { label: "Settings", icon: Settings },
];
const mobileNavigation = navigation.filter(({ label }) =>
  ["Dashboard", "My Files", "Transfers", "Storage Accounts"].includes(label),
);

function AuthScreen({
  setupRequired,
  onAuthenticated,
}: {
  setupRequired: boolean;
  onAuthenticated: (user: User) => void;
}) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [setupKey, setSetupKey] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [resetMode, setResetMode] = useState(false);

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      if (resetMode) {
        await apiRequest<void>("/api/auth/reset-password", {
          method: "POST",
          body: JSON.stringify({ email, password, setupKey }),
        });
        setPassword("");
        setSetupKey("");
        setResetMode(false);
        setNotice("Password reset. Sign in with your new password.");
      } else {
        const response = await apiRequest<{ user: User }>(
          `/api/auth/${setupRequired ? "setup" : "login"}`,
          {
            method: "POST",
            body: JSON.stringify(
              setupRequired ? { email, password, setupKey } : { email, password },
            ),
          },
        );
        onAuthenticated(response.user);
      }
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Unable to sign in.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="auth-page">
      <div className="auth-card">
        <Brand />
        <div className="auth-heading">
          <span className="eyebrow">{setupRequired ? "FIRST-TIME SETUP" : resetMode ? "ACCOUNT RECOVERY" : "PRIVATE CLOUD STORAGE"}</span>
          <h1>{setupRequired ? "Create your vault" : resetMode ? "Reset your password" : "Welcome back"}</h1>
          <p>{setupRequired ? "Set up the administrator account to get started." : resetMode ? "Use the recovery key configured in Vercel to set a new administrator password." : "Sign in to access your DriveVault."}</p>
        </div>
        <form onSubmit={submit} className="auth-form">
          {(setupRequired || resetMode) && (
            <label>
              {resetMode ? "Recovery key" : "Setup key"}
              <input value={setupKey} onChange={(event) => setSetupKey(event.target.value)} required autoComplete="off" />
            </label>
          )}
          <label>
            Email address
            <input type="email" value={email} onChange={(event) => setEmail(event.target.value)} required autoComplete="email" />
          </label>
          <label>
            {resetMode ? "New password" : "Password"}
            <input type="password" value={password} onChange={(event) => setPassword(event.target.value)} required minLength={setupRequired || resetMode ? 12 : 1} autoComplete={setupRequired || resetMode ? "new-password" : "current-password"} />
            {(setupRequired || resetMode) && <small>Use at least 12 characters.</small>}
          </label>
          {error && <div role="alert" className="form-error">{error}</div>}
          {notice && <div role="status" className="drive-success">{notice}</div>}
          <button className="button button-primary button-full" type="submit" disabled={busy}>
            {busy ? "Please wait…" : setupRequired ? "Create administrator account" : resetMode ? "Reset password" : "Sign in"}
          </button>
        </form>
        {!setupRequired && (
          <button
            className="auth-mode-button"
            type="button"
            onClick={() => {
              setResetMode(!resetMode);
              setError("");
              setNotice("");
              setPassword("");
              setSetupKey("");
            }}
          >
            {resetMode ? "Back to sign in" : "Forgot password?"}
          </button>
        )}
        <div className="auth-footnote"><ShieldCheck size={15} /> Your files stay in your Google Drive accounts.</div>
      </div>
    </main>
  );
}

function Brand() {
  return (
    <div className="brand">
      <span className="brand-mark"><Cloud size={19} strokeWidth={2.3} /></span>
      <span>Drive<span className="brand-vault">Vault</span></span>
    </div>
  );
}

function Dashboard({ user, onLogout }: { user: User; onLogout: () => void }) {
  const [active, setActive] = useState<Section>("Dashboard");
  const [accounts, setAccounts] = useState<DriveAccount[]>([]);
  const [accountsConfigured, setAccountsConfigured] = useState(false);
  const [accountsSetupError, setAccountsSetupError] = useState("");
  const [accountsError, setAccountsError] = useState("");
  const [connecting, setConnecting] = useState(false);
  const storageTotal = accounts.reduce((total, account) => total + (account.storageTotalBytes ?? 0), 0);
  const storageUsed = accounts.reduce((total, account) => total + (account.storageUsedBytes ?? 0), 0);
  const hasStorageQuota = accounts.some((account) => account.storageTotalBytes !== null);
  const storageProgress = storageTotal > 0 ? Math.min(100, Math.round(storageUsed / storageTotal * 100)) : 0;

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const driveStatus = params.get("drive");
    const driveError = params.get("driveError");
    if (driveStatus || driveError) {
      window.history.replaceState({}, "", window.location.pathname);
      if (driveStatus === "connected" || driveError) setActive("Storage Accounts");
      if (driveError) setAccountsError(driveErrorMessage(driveError));
    }
  }, []);

  useEffect(() => {
    async function loadAccounts() {
      try {
        const result = await apiRequest<{
          configured: boolean;
          setupError: string | null;
          accounts: DriveAccount[];
        }>("/api/google/accounts");
        setAccounts(result.accounts);
        setAccountsConfigured(result.configured);
        setAccountsSetupError(result.setupError ?? "");
      } catch (error) {
        setAccountsError(error instanceof Error ? error.message : "Unable to load connected accounts.");
      }
    }
    void loadAccounts();
  }, []);

  async function connectDrive() {
    setConnecting(true);
    setAccountsError("");
    try {
      const result = await apiRequest<{ authorizationUrl: string }>("/api/google/oauth/start");
      window.location.assign(result.authorizationUrl);
    } catch (error) {
      setAccountsError(error instanceof Error ? error.message : "Unable to start Google Drive connection.");
      setConnecting(false);
    }
  }

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <Brand />
        <div className="workspace-label">WORKSPACE</div>
        <nav aria-label="Main navigation">
          {navigation.map(({ label, icon: Icon }) => (
            <button key={label} className={`nav-item ${active === label ? "active" : ""}`} onClick={() => setActive(label)}>
              <Icon size={17} strokeWidth={1.8} /><span>{label}</span>
            </button>
          ))}
        </nav>
        <div className="sidebar-bottom">
          <div className="storage-mini">
            <div className="storage-title"><span><HardDrive size={14} /> Storage</span><span>{accounts.length ? `${accounts.length} connected` : "Not connected"}</span></div>
            <div className="progress-track"><div className="progress-fill" style={{ width: `${storageProgress}%` }} /></div>
            <div className="storage-caption">{hasStorageQuota ? `${formatBytes(storageUsed)} of ${formatBytes(storageTotal)} used` : "Connect a Drive account to begin"}</div>
          </div>
          <button className="profile-button" onClick={onLogout}>
            <span className="avatar">{user.email.slice(0, 1).toUpperCase()}</span>
            <span className="profile-copy"><strong>{user.email}</strong><small>Administrator · Sign out</small></span>
            <LogOut size={15} />
          </button>
        </div>
      </aside>

      <main className="main-area">
        <header className="topbar">
          <div className="mobile-brand"><Brand /></div>
          <div className="breadcrumbs"><span>Workspace</span><span className="crumb-slash">/</span><strong>{active}</strong></div>
          <div className="topbar-actions">
            <button className="search-button" aria-label="Search files"><Search size={16} /><span>Search files</span><kbd>⌘ K</kbd></button>
            <button className="icon-button" aria-label="Settings" onClick={() => setActive("Settings")}><Settings size={17} /></button>
            <span className="avatar">{user.email.slice(0, 1).toUpperCase()}</span>
          </div>
        </header>

        <div className="page-content">
          <div className="welcome-row">
            <div>
              <div className="eyebrow">WEDNESDAY, OCTOBER 21</div>
              <h1>{active === "Dashboard" ? "Your vault, at a glance." : active}</h1>
              <p className="page-subtitle">{active === "Dashboard" ? "A calm place for everything you keep." : `Manage your ${active.toLowerCase()} in one place.`}</p>
            </div>
            {active !== "Storage Accounts" && <button className="button button-primary" onClick={() => setActive("Storage Accounts")}><Upload size={16} /> Connect a Drive</button>}
          </div>

          {active === "Storage Accounts" ? (
            <section className="panel accounts-panel">
              <div className="panel-heading">
                <div><h2>Google Drive accounts</h2><p>Connect an account to authorize DriveVault.</p></div>
                <span className="accounts-count">{accounts.length} / 10 accounts</span>
              </div>
              {accountsError && <div className="form-error" role="alert">{accountsError}</div>}
              {accounts.map((account) => (
                <article className="connected-account" key={account.id}>
                  <span className="avatar">{account.email.slice(0, 1).toUpperCase()}</span>
                  <span className="connected-account-copy"><strong>{account.displayName || account.email}</strong><small>{account.email}</small></span>
                  <span className="connected-status">{account.connectionStatus === "connected" ? "Connected" : "Reconnect required"}</span>
                </article>
              ))}
              {accounts.length === 0 && (
                <div className="empty-state accounts-empty">
                  <span className="empty-icon"><Cloud size={23} /></span>
                  <h3>No Google Drive accounts connected</h3>
                  <p>Authorize DriveVault with Google to connect your account. Your password is never shared with DriveVault.</p>
                </div>
              )}
              {!accountsConfigured && <div className="setup-notice">{accountsSetupError || "Google OAuth is not configured on the server."} See the Google Cloud setup steps in README.md.</div>}
              <button
                className="button button-primary connect-account-button"
                disabled={!accountsConfigured || connecting}
                onClick={() => void connectDrive()}
              >
                <Upload size={15} /> {connecting ? "Opening Google…" : "Connect Google Drive"}
              </button>
            </section>
          ) : active === "My Files" || active === "Videos" || active === "PDFs" ? (
            <FilesBrowser accounts={accounts} section={active} />
          ) : active === "Dashboard" ? (
          <>
          <section className="stats-grid" aria-label="Storage overview">
            <StatCard icon={Cloud} label="TOTAL STORAGE" value={hasStorageQuota ? formatBytes(storageTotal) : "—"} detail="Across connected accounts" />
            <StatCard icon={ChartNoAxesCombined} label="USED STORAGE" value={hasStorageQuota ? formatBytes(storageUsed) : "—"} detail="Across all accounts" />
            <StatCard icon={ArrowDownToLine} label="AVAILABLE" value={hasStorageQuota ? formatBytes(Math.max(0, storageTotal - storageUsed)) : "—"} detail="Combined free space" />
            <StatCard icon={HardDrive} label="ACCOUNTS" value={String(accounts.length)} detail="Up to 10 accounts" />
          </section>

          <section className="content-grid">
            <div className="panel recent-panel">
              <div className="panel-heading">
                <div><h2>Recent files</h2><p>Your latest additions, all in one view.</p></div>
                <button className="text-button" onClick={() => setActive("My Files")}>View all <span>→</span></button>
              </div>
              <div className="empty-state">
                <span className="empty-icon"><FolderPlus size={23} strokeWidth={1.6} /></span>
                <h3>Your files will feel at home here</h3>
                <p>Connect a Google Drive account to see and manage your files.</p>
                <button className="button button-secondary" onClick={() => setActive("Storage Accounts")}>Connect your first account</button>
              </div>
            </div>
            <div className="panel quick-panel">
              <div className="panel-heading"><div><h2>Quick access</h2><p>Jump into your library.</p></div></div>
              <div className="quick-links">
                <QuickLink icon={Folder} title="All files" count="Browse your library" onClick={() => setActive("My Files")} />
                <QuickLink icon={Film} title="Videos" count="Stream your collection" onClick={() => setActive("Videos")} />
                <QuickLink icon={FileText} title="Documents" count="PDFs and more" onClick={() => setActive("PDFs")} />
                <QuickLink icon={Share2} title="Shared links" count="Manage your shares" onClick={() => setActive("Shared")} />
              </div>
            </div>
          </section>
          <div className="privacy-note"><ShieldCheck size={15} /> Your files remain in your Google Drive. DriveVault stores organization and account metadata.</div>
          </>
          ) : (
            <section className="panel section-placeholder">
              <span className="empty-icon"><Folder size={23} /></span>
              <h2>{active} is not available yet</h2>
              <p>Google Drive browsing is available. Transfers, sharing, and these settings are still being built.</p>
              <button className="button button-secondary" onClick={() => setActive("Storage Accounts")}>Manage Drive accounts</button>
            </section>
          )}
        </div>
        <nav className="mobile-bottom-nav" aria-label="Compact navigation">
          {mobileNavigation.map(({ label, icon: Icon }) => (
            <button
              key={label}
              className={active === label ? "active" : ""}
              aria-current={active === label ? "page" : undefined}
              onClick={() => setActive(label)}
            >
              <Icon size={18} strokeWidth={1.8} />
              <span>{label === "Storage Accounts" ? "Accounts" : label}</span>
            </button>
          ))}
        </nav>
      </main>
    </div>
  );
}

interface DriveAccount {
  id: string;
  email: string;
  displayName: string | null;
  storageUsedBytes: number | null;
  storageTotalBytes: number | null;
  connectionStatus: string;
}

interface DriveFile {
  id: string;
  name: string;
  mimeType: string;
  size?: string;
  modifiedTime?: string;
  webViewLink?: string;
}

const GOOGLE_FOLDER_MIME = "application/vnd.google-apps.folder";
const MAX_UPLOAD_BYTES = 4 * 1024 * 1024;
type DriveFileCategory = "Images" | "Audio" | "Videos" | "PDFs" | "Documents" | "Spreadsheets" | "Presentations" | "Other";
const driveFileCategories: DriveFileCategory[] = [
  "Images",
  "Audio",
  "Videos",
  "PDFs",
  "Documents",
  "Spreadsheets",
  "Presentations",
  "Other",
];
const googleExportMimeTypes = new Set([
  "application/vnd.google-apps.document",
  "application/vnd.google-apps.spreadsheet",
  "application/vnd.google-apps.presentation",
  "application/vnd.google-apps.drawing",
]);

function getDriveFileCategory(file: DriveFile): DriveFileCategory {
  const mimeType = file.mimeType.toLowerCase();
  const extension = file.name.toLowerCase().split(".").pop() ?? "";
  if (mimeType.startsWith("image/") || mimeType === "application/vnd.google-apps.drawing" || ["png", "jpg", "jpeg", "gif", "webp", "bmp", "svg", "heic", "tiff"].includes(extension)) return "Images";
  if (mimeType.startsWith("audio/") || ["mp3", "wav", "m4a", "aac", "flac", "ogg", "wma"].includes(extension)) return "Audio";
  if (mimeType.startsWith("video/") || ["mp4", "mov", "avi", "mkv", "webm", "wmv", "m4v"].includes(extension)) return "Videos";
  if (mimeType === "application/pdf" || extension === "pdf") return "PDFs";
  if (
    mimeType === "application/vnd.google-apps.document" ||
    mimeType.includes("wordprocessing") ||
    mimeType.includes("msword") ||
    mimeType === "text/plain" ||
    mimeType === "text/rtf" ||
    ["doc", "docx", "odt", "rtf", "txt"].includes(extension)
  ) return "Documents";
  if (
    mimeType === "application/vnd.google-apps.spreadsheet" ||
    mimeType.includes("spreadsheet") ||
    mimeType.includes("excel") ||
    ["csv", "xls", "xlsx", "ods"].includes(extension)
  ) return "Spreadsheets";
  if (
    mimeType === "application/vnd.google-apps.presentation" ||
    mimeType.includes("presentation") ||
    mimeType.includes("powerpoint") ||
    ["ppt", "pptx", "odp"].includes(extension)
  ) return "Presentations";
  return "Other";
}

function driveFileCategoryIcon(category: DriveFileCategory): typeof File {
  switch (category) {
    case "Images": return Image;
    case "Audio": return Music2;
    case "Videos": return Film;
    case "PDFs":
    case "Documents": return FileText;
    case "Spreadsheets": return FileSpreadsheet;
    case "Presentations": return Presentation;
    default: return File;
  }
}

function FilesBrowser({ accounts, section }: { accounts: DriveAccount[]; section: "My Files" | "Videos" | "PDFs" }) {
  const [accountId, setAccountId] = useState("");
  const [folderPath, setFolderPath] = useState<{ id: string; name: string }[]>([]);
  const [files, setFiles] = useState<DriveFile[]>([]);
  const [fileType, setFileType] = useState<DriveFileCategory | "All files">("All files");
  const [nextPageToken, setNextPageToken] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const folderId = folderPath.at(-1)?.id;

  useEffect(() => {
    if (!accounts.length) {
      setAccountId("");
      setFiles([]);
      return;
    }
    if (!accounts.some((account) => account.id === accountId)) {
      setAccountId(accounts[0].id);
      setFolderPath([]);
    }
  }, [accounts, accountId]);

  async function loadFiles(loadMore = false) {
    if (!accountId) return;
    setLoading(true);
    setError("");
    try {
      const params = new URLSearchParams({ accountId });
      if (folderId) params.set("folderId", folderId);
      if (loadMore && nextPageToken) params.set("pageToken", nextPageToken);
      const result = await apiRequest<{ files: DriveFile[]; nextPageToken?: string }>(
        `/api/google/files?${params.toString()}`,
      );
      setFiles((current) => loadMore ? [...current, ...result.files] : result.files);
      setNextPageToken(result.nextPageToken ?? "");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Unable to load Drive files.");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    setFolderPath([]);
  }, [accountId]);

  useEffect(() => {
    setFiles([]);
    setNextPageToken("");
    void loadFiles();
  }, [accountId, folderId]);

  const visibleFiles = files.filter((file) => {
    if (file.mimeType === GOOGLE_FOLDER_MIME) return section === "My Files";
    const category = getDriveFileCategory(file);
    if (section === "Videos") return category === "Videos";
    if (section === "PDFs") return category === "PDFs";
    return fileType === "All files" || category === fileType;
  });

  async function createFolder() {
    const name = window.prompt("New folder name");
    if (!name?.trim()) return;
    setBusy(true);
    setError("");
    try {
      await apiRequest("/api/google/folders", {
        method: "POST",
        body: JSON.stringify({ name, ...(folderId ? { parentId: folderId } : {}) }),
      });
      setNotice("Folder created.");
      await loadFiles();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Unable to create the folder.");
    } finally {
      setBusy(false);
    }
  }

  async function uploadFile(file: File) {
    if (file.size > MAX_UPLOAD_BYTES) {
      setError("Uploads are limited to 4 MB per file on this deployment.");
      return;
    }
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const params = new URLSearchParams({
        accountId,
        name: file.name,
        mimeType: file.type || "application/octet-stream",
      });
      if (folderId) params.set("parentId", folderId);
      await apiRequest(`/api/google/files?${params.toString()}`, {
        method: "POST",
        headers: { "Content-Type": "application/octet-stream" },
        body: file,
      });
      setNotice("File uploaded.");
      await loadFiles();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Unable to upload this file.");
    } finally {
      setBusy(false);
    }
  }

  async function renameFile(file: DriveFile) {
    const name = window.prompt("Rename file", file.name);
    if (!name?.trim() || name === file.name) return;
    setBusy(true);
    setError("");
    try {
      await apiRequest(`/api/google/files/${encodeURIComponent(file.id)}?accountId=${encodeURIComponent(accountId)}`, {
        method: "PATCH",
        body: JSON.stringify({ name }),
      });
      setNotice("File renamed.");
      await loadFiles();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Unable to rename this file.");
    } finally {
      setBusy(false);
    }
  }

  async function trashFile(file: DriveFile) {
    if (!window.confirm(`Move "${file.name}" to Google Drive Trash?`)) return;
    setBusy(true);
    setError("");
    try {
      await apiRequest(`/api/google/files/${encodeURIComponent(file.id)}?accountId=${encodeURIComponent(accountId)}`, {
        method: "DELETE",
      });
      setNotice("File moved to Trash.");
      await loadFiles();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Unable to move this file to Trash.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="panel drive-browser">
      <div className="panel-heading drive-browser-heading">
        <div><h2>{section === "My Files" ? "Drive files" : section}</h2><p>Browse and manage files from your connected Google Drive accounts. Uploads are limited to 4 MB each.</p></div>
        <select aria-label="Google Drive account" value={accountId} onChange={(event) => setAccountId(event.target.value)} disabled={!accounts.length}>
          {accounts.length === 0 ? <option value="">No accounts</option> : accounts.map((account) => <option value={account.id} key={account.id}>{account.email}</option>)}
        </select>
      </div>
      {!accounts.length ? (
        <div className="empty-state"><span className="empty-icon"><Cloud size={23} /></span><h3>Connect a Google Drive account</h3><p>Your connected Drive files will appear here.</p></div>
      ) : (
        <>
          <div className="drive-toolbar">
            <div className="drive-breadcrumbs">
              <button className="text-button" onClick={() => setFolderPath([])}>My Drive</button>
              {folderPath.map((folder, index) => (
                <span key={folder.id} className="drive-crumb">
                  <ChevronRight size={13} />
                  <button className="text-button" onClick={() => setFolderPath(folderPath.slice(0, index + 1))}>{folder.name}</button>
                </span>
              ))}
            </div>
            {section === "My Files" && (
              <select className="drive-type-filter" aria-label="Filter by file type" value={fileType} onChange={(event) => setFileType(event.target.value as DriveFileCategory | "All files")}>
                <option value="All files">All file types</option>
                {driveFileCategories.map((category) => <option key={category} value={category}>{category}</option>)}
              </select>
            )}
            <div className="drive-actions">
              <button className="button button-secondary" onClick={() => void loadFiles()} disabled={loading || busy} aria-label="Refresh files"><RefreshCw size={14} /> Refresh</button>
              <button className="button button-secondary" onClick={() => void createFolder()} disabled={busy}><Plus size={14} /> New folder</button>
              <label className={`button button-primary upload-file-button ${busy ? "disabled" : ""}`}>
                <Upload size={14} /> Upload
                <input type="file" disabled={busy} onChange={(event) => {
                  const file = event.target.files?.[0];
                  if (file) void uploadFile(file);
                  event.currentTarget.value = "";
                }} />
              </label>
            </div>
          </div>
          {error && <div className="form-error drive-message" role="alert">{error}</div>}
          {notice && <div className="drive-success" role="status">{notice}</div>}
          {loading && !files.length ? <div className="drive-loading">Loading files…</div> : (
            <div className="drive-file-list">
              {visibleFiles.map((file) => {
                const isFolder = file.mimeType === GOOGLE_FOLDER_MIME;
                const category = getDriveFileCategory(file);
                const FileIcon = driveFileCategoryIcon(category);
                const canDownload = !file.mimeType.startsWith("application/vnd.google-apps.") || googleExportMimeTypes.has(file.mimeType);
                const downloadParams = new URLSearchParams({
                  accountId,
                  name: file.name,
                  mimeType: file.mimeType,
                });
                const downloadUrl = `/api/google/files/${encodeURIComponent(file.id)}/download?${downloadParams.toString()}`;
                return (
                  <article className="drive-file-row" key={file.id}>
                    <span className="drive-file-icon">{isFolder ? <Folder size={18} /> : <FileIcon size={18} />}</span>
                    <div className="drive-file-copy">
                      {isFolder ? (
                        <button className="drive-file-name" onClick={() => setFolderPath((current) => [...current, { id: file.id, name: file.name }])}>{file.name}</button>
                      ) : <strong className="drive-file-name">{file.name}</strong>}
                      <small>{isFolder ? "Folder" : `${category} · ${file.size ? formatBytes(Number(file.size)) : "Google Drive file"}${file.modifiedTime ? ` · ${new Date(file.modifiedTime).toLocaleDateString()}` : ""}`}</small>
                    </div>
                    {!isFolder && canDownload && <a className="icon-button drive-icon-action" href={downloadUrl} aria-label={`Download ${file.name}`} title="Download"><Download size={16} /></a>}
                    {!isFolder && file.webViewLink && <a className="icon-button drive-icon-action" href={file.webViewLink} target="_blank" rel="noreferrer" aria-label={`Open ${file.name} in Google Drive`} title="Open in Google Drive"><ExternalLink size={15} /></a>}
                    <button className="icon-button drive-icon-action" onClick={() => void renameFile(file)} disabled={busy} aria-label={`Rename ${file.name}`} title="Rename"><Pencil size={15} /></button>
                    <button className="icon-button drive-icon-action" onClick={() => void trashFile(file)} disabled={busy} aria-label={`Move ${file.name} to Trash`} title="Move to Trash"><Trash2 size={15} /></button>
                  </article>
                );
              })}
              {!loading && !visibleFiles.length && <div className="drive-empty">{files.length ? `No ${section.toLowerCase()} in this folder.` : "This folder is empty."}</div>}
              {nextPageToken && <button className="button button-secondary drive-load-more" onClick={() => void loadFiles(true)} disabled={loading}>{loading ? "Loading…" : "Load more"}</button>}
            </div>
          )}
        </>
      )}
    </section>
  );
}

function driveErrorMessage(error: string): string {
  switch (error) {
    case "cancelled": return "Google Drive connection was cancelled.";
    case "invalid_state": return "The Google sign-in session expired or was invalid. Try connecting again.";
    case "configuration": return "Google OAuth configuration is missing. Check the backend .env file.";
    case "token_exchange": return "Google could not complete authorization. Check the OAuth client and redirect URI.";
    case "profile": return "DriveVault could not read the Google account profile. Check the consent-screen scopes.";
    case "account_limit": return "You have reached the limit of 10 connected Google Drive accounts.";
    case "access_denied": return "Google blocked this account because the OAuth app is in Testing. Add this Google account as a test user in Google Cloud Console, or complete OAuth verification.";
    default: return "Google Drive could not be connected. Please try again.";
  }
}

function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const unitIndex = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  return `${(bytes / 1024 ** unitIndex).toFixed(unitIndex === 0 ? 0 : 1)} ${units[unitIndex]}`;
}

function StatCard({ icon: Icon, label, value, detail }: { icon: typeof Cloud; label: string; value: string; detail: string }) {
  return <article className="stat-card"><div className="stat-top"><span>{label}</span><Icon size={17} /></div><div className="stat-value">{value}</div><div className="stat-detail">{detail}</div></article>;
}

function QuickLink({ icon: Icon, title, count, onClick }: { icon: typeof File; title: string; count: string; onClick: () => void }) {
  return <button className="quick-link" onClick={onClick}><span className="quick-icon"><Icon size={17} /></span><span className="quick-copy"><strong>{title}</strong><small>{count}</small></span><span className="quick-arrow">↗</span></button>;
}

export default function App() {
  const [user, setUser] = useState<User | null>(null);
  const [setupRequired, setSetupRequired] = useState(false);
  const [loading, setLoading] = useState(true);
  const [initializationError, setInitializationError] = useState("");

  useEffect(() => {
    async function initialize() {
      try {
        const status = await apiRequest<AuthStatus>("/api/auth/status");
        setSetupRequired(status.setupRequired);
        if (!status.setupRequired) {
          try {
            const result = await apiRequest<{ user: User }>("/api/auth/me");
            setUser(result.user);
          } catch (error) {
            if (!(error instanceof ApiRequestError) || error.status !== 401) throw error;
          }
        }
      } catch (error) {
        setInitializationError(error instanceof Error ? error.message : "Could not connect to DriveVault.");
      } finally {
        setLoading(false);
      }
    }
    void initialize();
  }, []);

  async function logout() {
    try {
      await apiRequest<void>("/api/auth/logout", { method: "POST" });
      clearCsrfToken();
      setUser(null);
    } catch (error) {
      setInitializationError(error instanceof Error ? error.message : "Unable to sign out.");
    }
  }

  if (loading) return <div className="loading-screen"><span className="loading-mark"><Cloud size={20} /></span></div>;
  if (initializationError) {
    return <main className="auth-page"><div className="auth-card"><Brand /><div role="alert" className="form-error">{initializationError}</div><p className="auth-help">If this keeps happening, close the app window and run start-all.bat.</p></div></main>;
  }
  if (!user) return <AuthScreen setupRequired={setupRequired} onAuthenticated={setUser} />;
  return <Dashboard user={user} onLogout={() => void logout()} />;
}

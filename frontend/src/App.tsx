import { useEffect, useState } from "react";
import {
  ArrowDownToLine,
  ArrowUpFromLine,
  ChartNoAxesCombined,
  Cloud,
  File,
  FileText,
  Film,
  Folder,
  FolderPlus,
  HardDrive,
  LayoutDashboard,
  LogOut,
  Search,
  Settings,
  ShieldCheck,
  Share2,
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
  const [busy, setBusy] = useState(false);

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
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
          <span className="eyebrow">{setupRequired ? "FIRST-TIME SETUP" : "PRIVATE CLOUD STORAGE"}</span>
          <h1>{setupRequired ? "Create your vault" : "Welcome back"}</h1>
          <p>{setupRequired ? "Set up the administrator account to get started." : "Sign in to access your DriveVault."}</p>
        </div>
        <form onSubmit={submit} className="auth-form">
          {setupRequired && (
            <label>
              Setup key
              <input value={setupKey} onChange={(event) => setSetupKey(event.target.value)} required autoComplete="off" />
            </label>
          )}
          <label>
            Email address
            <input type="email" value={email} onChange={(event) => setEmail(event.target.value)} required autoComplete="email" />
          </label>
          <label>
            Password
            <input type="password" value={password} onChange={(event) => setPassword(event.target.value)} required minLength={setupRequired ? 12 : 1} autoComplete={setupRequired ? "new-password" : "current-password"} />
            {setupRequired && <small>Use at least 12 characters.</small>}
          </label>
          {error && <div role="alert" className="form-error">{error}</div>}
          <button className="button button-primary button-full" type="submit" disabled={busy}>
            {busy ? "Please wait…" : setupRequired ? "Create administrator account" : "Sign in"}
          </button>
        </form>
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
                disabled={!accountsConfigured || connecting || accounts.length >= 10}
                onClick={() => void connectDrive()}
              >
                <Upload size={15} /> {connecting ? "Opening Google…" : "Connect Google Drive"}
              </button>
            </section>
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
              <p>Google Drive account connection is ready. Browsing files, transfers, sharing, and settings are still being built.</p>
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

function driveErrorMessage(error: string): string {
  switch (error) {
    case "cancelled": return "Google Drive connection was cancelled.";
    case "invalid_state": return "The Google sign-in session expired or was invalid. Try connecting again.";
    case "configuration": return "Google OAuth configuration is missing. Check the backend .env file.";
    case "token_exchange": return "Google could not complete authorization. Check the OAuth client and redirect URI.";
    case "profile": return "DriveVault could not read the Google account profile. Check the consent-screen scopes.";
    case "account_limit": return "You have reached the limit of 10 connected Google Drive accounts.";
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

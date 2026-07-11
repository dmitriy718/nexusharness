import React, { useState } from "react";
import { NavLink, Outlet, useLocation } from "react-router-dom";
import {
  Activity,
  Bot,
  Boxes,
  BrainCircuit,
  ChevronLeft,
  Command,
  Cpu,
  Clipboard,
  CircleAlert,
  FileClock,
  FolderTree,
  Gauge,
  Menu,
  PanelLeftClose,
  Settings,
  ShieldCheck,
  Sparkles,
  RotateCcw,
  X
} from "lucide-react";
import { useHarness } from "./StoreProvider";
import { failureDetails, freshnessLabel } from "../features/feedback/feedbackModel";

const destinations = [
  { to: "/dashboard", label: "Overview", icon: Gauge },
  { to: "/runs", label: "Runs", icon: Activity },
  { to: "/agents", label: "Agents", icon: Bot },
  { to: "/models", label: "Models", icon: Cpu },
  { to: "/tools", label: "Tools & MCP", icon: Boxes },
  { to: "/workspace", label: "Workspace", icon: FolderTree },
  { to: "/memory", label: "Memory", icon: BrainCircuit },
  { to: "/approvals", label: "Approvals", icon: ShieldCheck },
  { to: "/audit", label: "Audit", icon: FileClock },
  { to: "/settings", label: "Settings", icon: Settings }
];

export function AppShell() {
  const { store, health, error, failure, clearError, notices, dismissNotice, refreshing, refresh, connectionState, lastSyncedAt } = useHarness();
  const [collapsed, setCollapsed] = useState(false);
  const [mobileOpen, setMobileOpen] = useState(false);
  const location = useLocation();
  const pending = store?.approvals.filter((item) => item.decision === "pending").length ?? 0;
  const activeRun = store?.runs.find((run) => run.status === "running" || run.status === "waiting_approval");
  const versionMismatch = health && health.version !== __NEXUSHARNESS_BUILD__.version;
  const failureInfo = error ? failureDetails(failure ?? new Error(error)) : null;

  const closeMobile = () => setMobileOpen(false);

  return (
    <div className={"app-shell" + (collapsed ? " nav-collapsed" : "")}>
      <a className="skip-link" href="#main-content">Skip to main content</a>
      <header className="mobile-bar">
        <button className="icon-button" aria-label="Open navigation" onClick={() => setMobileOpen(true)}><Menu /></button>
        <Brand compact />
        {pending > 0 && <NavLink to="/approvals" className="attention-count" aria-label={pending + " pending approvals"}>{pending}</NavLink>}
      </header>

      {mobileOpen && <button className="nav-scrim" aria-label="Close navigation" onClick={closeMobile} />}
      <aside className={"app-nav" + (mobileOpen ? " mobile-open" : "")}>
        <div className="nav-head">
          <Brand compact={collapsed} />
          <button className="icon-button mobile-close" aria-label="Close navigation" onClick={closeMobile}><X /></button>
        </div>
        <nav aria-label="Primary navigation">
          <p className="nav-section-label">Mission control</p>
          {destinations.map(({ to, label, icon: Icon }) => (
            <NavLink
              key={to}
              to={to}
              onClick={closeMobile}
              className={({ isActive }) => "nav-link" + (isActive || (to === "/runs" && location.pathname.startsWith("/runs/")) ? " active" : "")}
            >
              <Icon aria-hidden="true" />
              <span>{label}</span>
              {to === "/approvals" && pending > 0 && <em>{pending}</em>}
            </NavLink>
          ))}
        </nav>
        <div className="nav-footer">
          <div className={`local-chip state-${connectionState}`}><span />{collapsed ? "" : connectionLabel(connectionState)}</div>
          <button className="collapse-button" onClick={() => setCollapsed((value) => !value)}>
            {collapsed ? <ChevronLeft className="flip" /> : <PanelLeftClose />}
            <span>{collapsed ? "Expand" : "Collapse"}</span>
          </button>
          {!collapsed && <span className="version-label">v{__NEXUSHARNESS_BUILD__.version}</span>}
        </div>
      </aside>

      <div className="app-stage">
        <header className="context-bar">
          <div className="workspace-context">
            <span className="context-kicker">Workspace</span>
            <strong title={store?.settings.workspaceRoot}>{store?.settings.workspaceRoot.split(/[\\/]/).filter(Boolean).at(-1) ?? "Not configured"}</strong>
          </div>
          <div className="context-actions">
            {activeRun && <NavLink className="live-run-chip" to={"/runs/" + activeRun.id}><span />{activeRun.phase} · iteration {activeRun.iteration}</NavLink>}
            <span className={`live-state state-${connectionState}`} role="status"><span />{refreshing ? "Syncing…" : connectionState === "online" ? freshnessLabel(lastSyncedAt) : connectionLabel(connectionState)}</span>
            <button className="command-button" aria-label="Open command palette (coming in v2)" title="Command palette"><Command /><kbd>⌘K</kbd></button>
            <NavLink to="/approvals" className={"approval-button" + (pending ? " has-attention" : "")}>
              <ShieldCheck /> <span>{pending ? pending + " pending" : "No approvals"}</span>
            </NavLink>
          </div>
        </header>

        {versionMismatch && (
          <div className="build-warning" role="alert">
            Client v{__NEXUSHARNESS_BUILD__.version} and API v{health.version} do not match. Rebuild and restart NexusHarness.
          </div>
        )}
        {failureInfo && (
          <div className={`global-error error-${failureInfo.category}`} role="alert">
            <CircleAlert />
            <span><strong>{failureInfo.title}</strong><small>{failureInfo.message}</small></span>
            <div>{failureInfo.retryable && <button className="button secondary" onClick={() => void refresh().catch(() => undefined)}><RotateCcw />Retry</button>}<button className="button quiet" onClick={() => void navigator.clipboard.writeText(failureInfo.technical)}><Clipboard />Copy details</button><button className="icon-button" aria-label="Dismiss error" onClick={clearError}><X /></button></div>
          </div>
        )}

        <main id="main-content" tabIndex={-1}>
          <Outlet />
        </main>
      </div>

      <div className="toast-region" aria-live="polite" aria-label="Notifications">
        {notices.map((notice) => (
          <div key={notice.id} className={"toast toast-" + notice.tone} role="status">
            <span>{notice.message}</span><button aria-label="Dismiss notification" onClick={() => dismissNotice(notice.id)}><X aria-hidden="true" /></button>
          </div>
        ))}
      </div>
    </div>
  );
}

function connectionLabel(state: "booting" | "online" | "reconnecting" | "stale" | "offline") {
  if (state === "online") return "Local API online";
  if (state === "reconnecting") return "Reconnecting…";
  if (state === "stale") return "Data may be stale";
  if (state === "booting") return "Connecting…";
  return "Local API offline";
}

function Brand({ compact = false }: { compact?: boolean }) {
  return (
    <NavLink to="/dashboard" className="brand" aria-label="NexusHarness overview">
      <span className="brand-mark"><Sparkles aria-hidden="true" /></span>
      {!compact && <span><strong>Nexus</strong><em>Harness</em></span>}
    </NavLink>
  );
}

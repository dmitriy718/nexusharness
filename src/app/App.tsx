import React from "react";
import { Navigate, Route, Routes } from "react-router-dom";
import { LoaderCircle, RotateCcw } from "lucide-react";
import { useHarness } from "./StoreProvider";
import { AppShell } from "./AppShell";
import { OnboardingPage } from "../features/onboarding/OnboardingPage";
import { DashboardPage } from "../features/dashboard/DashboardPage";
import { RunsPage } from "../features/runs/RunsPage";
import { RunDetailPage } from "../features/runs/RunDetailPage";
import { ApprovalsPage } from "../features/approvals/ApprovalsPage";
import { AuditPage } from "../features/audit/AuditPage";
import { ModelsPage } from "../features/models/ModelsPage";
import { AgentsPage } from "../features/agents/AgentAssignments";
import { ToolsPage } from "../features/tools/ToolsPage";
import { WorkspacePage } from "../features/workspace/WorkspacePage";
import { MemoryPage } from "../features/memory/MemoryPage";
import { SettingsPage } from "../features/settings/SettingsPage";

export function App() {
  const { store, loading, error, refresh } = useHarness();

  if (loading && !store) {
    return (
      <div className="boot-screen" role="status">
        <div className="brand-mark large"><LoaderCircle className="spin" /></div>
        <p className="eyebrow">NexusHarness v{__NEXUSHARNESS_BUILD__.version}</p>
        <h1>Preparing your local control room</h1>
        <p>Connecting to the local API and restoring workspace state.</p>
      </div>
    );
  }

  if (!store) {
    return (
      <div className="boot-screen boot-error">
        <div className="brand-mark large"><RotateCcw /></div>
        <p className="eyebrow">Local API unavailable</p>
        <h1>NexusHarness could not connect</h1>
        <p>{error || "Start the API, then retry the connection."}</p>
        <button className="button primary" onClick={() => void refresh().catch(() => undefined)}>Retry connection</button>
      </div>
    );
  }

  return (
    <Routes>
      <Route path="/onboarding" element={<OnboardingPage />} />
      <Route element={<AppShell />}>
        <Route path="/dashboard" element={<DashboardPage />} />
        <Route path="/runs" element={<RunsPage />} />
        <Route path="/runs/:runId" element={<RunDetailPage />} />
        <Route path="/agents" element={<AgentsPage />} />
        <Route path="/models" element={<ModelsPage />} />
        <Route path="/tools" element={<ToolsPage />} />
        <Route path="/workspace" element={<WorkspacePage />} />
        <Route path="/memory" element={<MemoryPage />} />
        <Route path="/approvals" element={<ApprovalsPage />} />
        <Route path="/audit" element={<AuditPage />} />
        <Route path="/settings" element={<SettingsPage />} />
        <Route path="/settings/:section" element={<SettingsPage />} />
      </Route>
      <Route path="/" element={<Navigate replace to={store.settings.layout ? "/dashboard" : "/onboarding"} />} />
      <Route path="*" element={<Navigate replace to="/dashboard" />} />
    </Routes>
  );
}

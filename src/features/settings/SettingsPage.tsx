import React, { useEffect, useMemo, useRef, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { AlertTriangle, BookOpen, Check, CircleHelp, Cpu, Database, FolderCode, Info, Palette, RotateCcw, Save, Settings, ShieldCheck, Workflow } from "lucide-react";
import type { LayoutMode, SettingsShape } from "../../api/types";
import { useHarness } from "../../app/StoreProvider";
import { Field, InlineAlert, PageHeader } from "../../components/ui";
import { dirtySettingSections, restoreSettingsSection, sectionHasChanges, validateSettings, type SettingsSectionId } from "./settingsModel";

const sections: Array<{ id: SettingsSectionId; label: string; detail: string; icon: React.ReactNode }> = [
  { id: "workspace", label: "Workspace", detail: "Paths and validation", icon: <FolderCode /> },
  { id: "execution", label: "Execution", detail: "Agent loop bounds", icon: <Workflow /> },
  { id: "safety", label: "Safety", detail: "Approval policy", icon: <ShieldCheck /> },
  { id: "integrations", label: "Integrations", detail: "MCP discovery", icon: <Cpu /> },
  { id: "memory", label: "Memory", detail: "Retrieval budget", icon: <Database /> },
  { id: "appearance", label: "Appearance", detail: "Run perspective", icon: <Palette /> },
  { id: "help", label: "Help", detail: "Workflows and recovery", icon: <CircleHelp /> },
  { id: "about", label: "About", detail: "Build and local storage", icon: <Info /> }
];

export function SettingsPage() {
  const { section } = useParams();
  const { store, health, saveSettings, notify } = useHarness();
  const [draft, setDraft] = useState<SettingsShape | null>(store?.settings ?? null);
  const savedSettingsRef = useRef(JSON.stringify(store?.settings ?? null));
  const [saving, setSaving] = useState(false);
  const [localError, setLocalError] = useState("");
  useEffect(() => {
    if (!store) return;
    const nextSaved = JSON.stringify(store.settings);
    setDraft((current) => {
      const wasClean = current === null || JSON.stringify(current) === savedSettingsRef.current;
      savedSettingsRef.current = nextSaved;
      return wasClean ? store.settings : current;
    });
  }, [store?.settings]);
  const dirty = useMemo(() => Boolean(store && draft && JSON.stringify(store.settings) !== JSON.stringify(draft)), [draft, store]);
  const requestedSection = section === "advanced" ? "about" : section;
  const active = sections.some((item) => item.id === requestedSection) ? requestedSection as SettingsSectionId : "workspace";
  const errors = draft ? validateSettings(draft) : {};
  const dirtySections = store && draft ? dirtySettingSections(store.settings, draft) : [];

  useEffect(() => {
    if (!dirty) return;
    const unload = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ""; };
    const links = (event: MouseEvent) => {
      const anchor = (event.target as Element | null)?.closest<HTMLAnchorElement>("a[href]");
      if (!anchor || anchor.target || event.defaultPrevented) return;
      const destination = new URL(anchor.href, window.location.href);
      if (destination.origin === window.location.origin && destination.pathname.startsWith("/settings")) return;
      if (!window.confirm("Leave settings and discard unsaved changes?")) { event.preventDefault(); event.stopPropagation(); }
    };
    window.addEventListener("beforeunload", unload);
    document.addEventListener("click", links, true);
    return () => { window.removeEventListener("beforeunload", unload); document.removeEventListener("click", links, true); };
  }, [dirty]);
  if (!store || !draft) return null;

  const save = async () => {
    setSaving(true); setLocalError("");
    try { await saveSettings(draft); }
    catch (caught) { setLocalError(caught instanceof Error ? caught.message : String(caught)); }
    finally { setSaving(false); }
  };
  const setNumber = (key: keyof SettingsShape, value: string) => setDraft({ ...draft, [key]: Number(value) });
  const restore = () => setDraft(restoreSettingsSection(draft, active));
  const activeMeta = sections.find((item) => item.id === active)!;

  return <div className="page settings-page">
    <PageHeader eyebrow="Operator preferences" title="Settings" detail="Configure local boundaries, execution policy, integrations, memory, and presentation with protected drafts." />
    {localError && <InlineAlert tone="danger" title="Settings could not be saved">{localError}</InlineAlert>}
    <div className="settings-workspace-v2">
      <nav className="settings-nav" aria-label="Settings sections">{sections.map((item) => <Link className={active === item.id ? "active" : ""} to={`/settings/${item.id}`} key={item.id}><span>{item.icon}</span><span><strong>{item.label}</strong><small>{item.detail}</small></span>{dirtySections.includes(item.id) && <i aria-label="Unsaved changes" />}</Link>)}</nav>
      <section className="settings-route"><header><span className="setting-route-icon">{activeMeta.icon}</span><div><p className="eyebrow">Settings section</p><h2>{activeMeta.label}</h2><p>{activeMeta.detail}</p></div>{!(["help", "about"] as SettingsSectionId[]).includes(active) && <button className="button quiet" disabled={!sectionHasChanges(store.settings, draft, active)} onClick={restore}><RotateCcw />Restore section defaults</button>}</header>
        <div className="settings-route-body">{active === "workspace" && <WorkspaceSettings draft={draft} setDraft={setDraft} errors={errors} />}{active === "execution" && <ExecutionSettings draft={draft} setNumber={setNumber} errors={errors} />}{active === "safety" && <SafetySettings draft={draft} setDraft={setDraft} />}{active === "integrations" && <IntegrationSettings draft={draft} setDraft={setDraft} setNumber={setNumber} errors={errors} />}{active === "memory" && <MemorySettings draft={draft} setNumber={setNumber} errors={errors} />}{active === "appearance" && <AppearanceSettings draft={draft} setDraft={setDraft} />}{active === "help" && <HelpSettings />}{active === "about" && <AboutSettings health={health} notify={notify} />}</div>
      </section>
    </div>
    {dirty && <div className="dirty-bar dirty-bar-v2" role="status"><span><AlertTriangle /><span><strong>{dirtySections.length} section{dirtySections.length === 1 ? "" : "s"} changed</strong><small>Unsaved settings are protected if you navigate away or close the window.</small></span></span><div><button className="button quiet" onClick={() => setDraft(store.settings)}><RotateCcw />Discard all</button><button className="button primary" disabled={saving || Object.keys(errors).length > 0} onClick={() => void save()}><Save />{saving ? "Validating and saving…" : "Save changes"}</button></div></div>}
  </div>;
}

function WorkspaceSettings({ draft, setDraft, errors }: { draft: SettingsShape; setDraft: (value: SettingsShape) => void; errors: Record<string, string> }) {
  return <><div className="setting-callout"><FolderCode /><div><strong>Workspace boundary</strong><p>Every built-in file and shell capability resolves against this existing directory. Saving revalidates it on the server.</p></div></div><FieldError id="settings-workspace" error={errors.workspaceRoot}><Field label="Workspace root" htmlFor="settings-workspace" hint="Existing absolute directory; paths cannot escape it."><input id="settings-workspace" aria-invalid={Boolean(errors.workspaceRoot)} aria-describedby={`settings-workspace-hint${errors.workspaceRoot ? " settings-workspace-error" : ""}`} value={draft.workspaceRoot} onChange={(event) => setDraft({ ...draft, workspaceRoot: event.target.value })} /></Field></FieldError><div className="form-grid"><Field label="Test command" htmlFor="settings-test" hint="Optional objective-validation command."><input id="settings-test" aria-describedby="settings-test-hint" value={draft.testCommand} onChange={(event) => setDraft({ ...draft, testCommand: event.target.value })} placeholder="npm test" /></Field><Field label="Lint command" htmlFor="settings-lint" hint="Optional objective-validation command."><input id="settings-lint" aria-describedby="settings-lint-hint" value={draft.lintCommand} onChange={(event) => setDraft({ ...draft, lintCommand: event.target.value })} placeholder="npm run lint" /></Field></div><FieldError id="settings-shell" error={errors.shellPath}><Field label="Shell executable" htmlFor="settings-shell" hint="Executable used for approved validation and agent shell commands."><input id="settings-shell" aria-invalid={Boolean(errors.shellPath)} aria-describedby={`settings-shell-hint${errors.shellPath ? " settings-shell-error" : ""}`} value={draft.shellPath} onChange={(event) => setDraft({ ...draft, shellPath: event.target.value })} /></Field></FieldError></>;
}

function ExecutionSettings({ draft, setNumber, errors }: { draft: SettingsShape; setNumber: (key: keyof SettingsShape, value: string) => void; errors: Record<string, string> }) {
  return <><div className="setting-callout"><Workflow /><div><strong>Bounded iteration</strong><p>These limits apply to each run and prevent unbounded agent loops or local concurrency.</p></div></div><div className="form-grid three-fields"><NumberSetting id="settings-iterations" label="Max iterations" value={draft.maxIterations} min={1} max={25} unit="cycles" error={errors.maxIterations} onChange={(value) => setNumber("maxIterations", value)} /><NumberSetting id="settings-executors" label="Parallel executors" value={draft.maxParallelExecutors} min={1} max={12} unit="agents" error={errors.maxParallelExecutors} onChange={(value) => setNumber("maxParallelExecutors", value)} /><NumberSetting id="settings-threshold" label="Critic threshold" value={draft.criticThreshold} min={1} max={10} unit="/ 10" error={errors.criticThreshold} onChange={(value) => setNumber("criticThreshold", value)} /></div></>;
}

function SafetySettings({ draft, setDraft }: { draft: SettingsShape; setDraft: (value: SettingsShape) => void }) {
  return <><label className="setting-toggle"><span className="setting-symbol"><ShieldCheck /></span><span><strong>Approval mode</strong><small>Pause writes, deletes, and shell commands for contextual review.</small></span><input type="checkbox" checked={draft.approvalMode} onChange={(event) => { if (!event.target.checked && !window.confirm("Disable approval mode? Agents may perform permitted writes and commands without pausing.")) return; setDraft({ ...draft, approvalMode: event.target.checked }); }} /><i /></label>{!draft.approvalMode && <InlineAlert tone="warning" title="Approval mode is disabled">High-impact local operations will not pause. Use only in a trusted, restorable workspace.</InlineAlert>}<div className="setting-callout safe"><ShieldCheck /><div><strong>Always enforced</strong><p>Workspace realpath boundaries, response limits, and audit recording remain active even when approval mode is off.</p></div></div></>;
}

function IntegrationSettings({ draft, setDraft, setNumber, errors }: { draft: SettingsShape; setDraft: (value: SettingsShape) => void; setNumber: (key: keyof SettingsShape, value: string) => void; errors: Record<string, string> }) {
  return <><label className="setting-toggle"><span className="setting-symbol"><Cpu /></span><span><strong>MCP auto-discovery</strong><small>Allow manual localhost scans only inside the configured range.</small></span><input type="checkbox" checked={draft.mcpAutoDiscovery} onChange={(event) => setDraft({ ...draft, mcpAutoDiscovery: event.target.checked })} /><i /></label><div className="form-grid"><NumberSetting id="settings-port-start" label="Discovery port start" value={draft.mcpPortStart} min={1} max={65535} unit="port" error={errors.mcpPortStart} onChange={(value) => setNumber("mcpPortStart", value)} /><NumberSetting id="settings-port-end" label="Discovery port end" value={draft.mcpPortEnd} min={1} max={65535} unit="port" error={errors.mcpPortEnd} onChange={(value) => setNumber("mcpPortEnd", value)} /></div><p className="setting-footnote"><Info />Scans run in truthful chunks of at most 500 ports and can be canceled from Tools & MCP.</p></>;
}

function MemorySettings({ draft, setNumber, errors }: { draft: SettingsShape; setNumber: (key: keyof SettingsShape, value: string) => void; errors: Record<string, string> }) {
  return <><div className="setting-callout"><Database /><div><strong>Retrieval context budget</strong><p>Limits how much selected local memory can be added to an agent prompt. Zero disables memory injection without deleting entries.</p></div></div><NumberSetting id="settings-memory-budget" label="Memory token budget" value={draft.memoryTokenBudget} min={0} max={50000} unit="tokens" error={errors.memoryTokenBudget} onChange={(value) => setNumber("memoryTokenBudget", value)} /></>;
}

function AppearanceSettings({ draft, setDraft }: { draft: SettingsShape; setDraft: (value: SettingsShape) => void }) {
  return <><div className="appearance-options">{([['chat', 'Focus', 'Timeline-first'], ['ide', 'Studio', 'Workspace and timeline canvas'], ['agents', 'Orchestrate', 'Agent and subtask activity']] as Array<[LayoutMode, string, string]>).map(([id, name, description]) => <button className={draft.layout === id ? "selected" : ""} onClick={() => setDraft({ ...draft, layout: id })} key={id}><span>{id === "chat" ? <Check /> : id === "ide" ? <Settings /> : <Workflow />}</span><strong>{name}</strong><small>{description}</small>{draft.layout === id && <Check className="choice-check" />}</button>)}</div><div className="setting-callout"><Palette /><div><strong>Midnight Prism</strong><p>The v2 theme is fixed during prerelease. Reduced motion and contrast preferences follow operating-system settings.</p></div></div></>;
}

function HelpSettings() {
  return <><div className="setting-callout"><BookOpen /><div><strong>Start with readiness</strong><p>Connect a runtime in Models, assign Planner/Executor/Critic in Agents, confirm the workspace boundary, then create a focused task in Runs.</p></div></div><div className="advanced-facts"><div><span><strong>Choose a run view</strong><small>Focus narrates decisions; Studio adds bounded workspace context; Orchestrate shows agents, subtasks, approvals, and audit activity.</small></span><Link className="text-link" to="/runs">Open Runs</Link></div><div><span><strong>When work pauses</strong><small>Review the exact command, path, diff, or delete scope. Rejecting ends that originating run safely; approval applies once.</small></span><Link className="text-link" to="/approvals">Open Approvals</Link></div><div><span><strong>Connection recovery</strong><small>Start or restart the local API, use Retry in the error banner, then verify runtime health without saving over the current configuration.</small></span><Link className="text-link" to="/models">Open Models</Link></div><div><span><strong>Keyboard paths</strong><small>Use the skip link, arrow keys in tabs and Workspace entries, Escape in navigation/dialogs, and visible focus throughout.</small></span><Link className="text-link" to="/workspace">Open Workspace</Link></div></div><InlineAlert tone="info" title="Local-first help">No cloud account or telemetry is required. Project state stays in the local NexusHarness data file; workspace tools remain constrained to the configured root.</InlineAlert></>;
}

function AboutSettings({ health, notify }: { health: ReturnType<typeof useHarness>["health"]; notify: ReturnType<typeof useHarness>["notify"] }) {
  const diagnostics = { client: __NEXUSHARNESS_BUILD__, api: health, storage: ".nexusharness/store.json", telemetry: false };
  const copy = async () => {
    try { await navigator.clipboard.writeText(JSON.stringify(diagnostics, null, 2)); notify("Build diagnostics copied."); }
    catch { notify("The browser did not allow diagnostics to be copied.", "danger"); }
  };
  return <><div className="advanced-facts"><div><span><strong>Client version</strong><small>Synchronized Semantic Version</small></span><code>{__NEXUSHARNESS_BUILD__.version}</code></div><div><span><strong>API version</strong><small>{health ? "Connected local service" : "API identity unavailable"}</small></span><code>{health?.version ?? "offline"}</code></div><div><span><strong>Commit</strong><small>Client / API build provenance</small></span><code>{__NEXUSHARNESS_BUILD__.commit} / {health?.commit ?? "offline"}</code></div><div><span><strong>Built</strong><small>{__NEXUSHARNESS_BUILD__.mode} client</small></span><code>{__NEXUSHARNESS_BUILD__.builtAt}</code></div><div><span><strong>Storage</strong><small>Local project state; no telemetry</small></span><code>.nexusharness/store.json</code></div></div><div className="form-actions"><button className="button secondary" onClick={() => void copy()}><BookOpen />Copy build diagnostics</button></div><InlineAlert tone="info" title="NexusHarness v2 beta">This build completes the planned interface renovation. Final v2.0.0 identity and tag remain gated by assistive-technology and owner release approval.</InlineAlert></>;
}

function NumberSetting({ id, label, value, min, max, unit, error, onChange }: { id: string; label: string; value: number; min: number; max: number; unit: string; error?: string; onChange: (value: string) => void }) {
  return <FieldError id={id} error={error}><Field label={label} htmlFor={id} hint={`${min.toLocaleString()}–${max.toLocaleString()} ${unit}`}><div className="number-control"><input id={id} aria-invalid={Boolean(error)} aria-describedby={`${id}-hint${error ? ` ${id}-error` : ""}`} type="number" min={min} max={max} value={value} onChange={(event) => onChange(event.target.value)} /><span>{unit}</span></div></Field></FieldError>;
}

function FieldError({ id, error, children }: { id: string; error?: string; children: React.ReactNode }) {
  return <div className="field-with-error">{children}{error && <p className="field-error" id={`${id}-error`} role="alert">{error}</p>}</div>;
}

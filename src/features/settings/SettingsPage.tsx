import React, { useEffect, useMemo, useRef, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { AlertTriangle, BookOpen, Check, CircleHelp, Cpu, Database, FolderCode, Info, Palette, RotateCcw, Save, Settings, ShieldCheck, Workflow } from "lucide-react";
import type { LayoutMode, SettingsShape } from "../../api/types";
import { useHarness } from "../../app/StoreProvider";
import { Field, InlineAlert, PageHeader } from "../../components/ui";
import { defaultClientMemoryEmbeddings, defaultClientMemoryRetrieval, dirtySettingSections, restoreSettingsSection, sectionHasChanges, validateSettings, type SettingsSectionId } from "./settingsModel";

const sections: Array<{ id: SettingsSectionId; label: string; detail: string; icon: React.ReactNode }> = [
  { id: "workspace", label: "Workspace", detail: "Paths and validation", icon: <FolderCode /> },
  { id: "execution", label: "Execution", detail: "Agent loop bounds", icon: <Workflow /> },
  { id: "safety", label: "Safety", detail: "Approval policy", icon: <ShieldCheck /> },
  { id: "integrations", label: "Integrations", detail: "MCP discovery", icon: <Cpu /> },
  { id: "memory", label: "Memory", detail: "Semantic retrieval and indexing", icon: <Database /> },
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
        <div className="settings-route-body">{active === "workspace" && <WorkspaceSettings draft={draft} setDraft={setDraft} errors={errors} />}{active === "execution" && <ExecutionSettings draft={draft} setNumber={setNumber} errors={errors} />}{active === "safety" && <SafetySettings draft={draft} setDraft={setDraft} />}{active === "integrations" && <IntegrationSettings draft={draft} setDraft={setDraft} setNumber={setNumber} errors={errors} />}{active === "memory" && <MemorySettings draft={draft} setDraft={setDraft} setNumber={setNumber} errors={errors} />}{active === "appearance" && <AppearanceSettings draft={draft} setDraft={setDraft} />}{active === "help" && <HelpSettings />}{active === "about" && <AboutSettings health={health} notify={notify} />}</div>
      </section>
    </div>
    {dirty && <div className="dirty-bar dirty-bar-v2" role="status"><span><AlertTriangle /><span><strong>{dirtySections.length} section{dirtySections.length === 1 ? "" : "s"} changed</strong><small>Unsaved settings are protected if you navigate away or close the window.</small></span></span><div><button className="button quiet" onClick={() => setDraft(store.settings)}><RotateCcw />Discard all</button><button className="button primary" disabled={saving || Object.keys(errors).length > 0} onClick={() => void save()}><Save />{saving ? "Validating and saving…" : "Save changes"}</button></div></div>}
  </div>;
}

function WorkspaceSettings({ draft, setDraft, errors }: { draft: SettingsShape; setDraft: (value: SettingsShape) => void; errors: Record<string, string> }) {
  return <><div className="setting-callout"><FolderCode /><div><strong>Source and run separation</strong><p>This directory remains source context for browsing and memory. Every new task creates and promotes deliverables only inside the current user's .nexusharness/&lt;task-id&gt; export repository.</p></div></div><FieldError id="settings-workspace" error={errors.workspaceRoot}><Field label="Source workspace root" htmlFor="settings-workspace" hint="Existing absolute source directory, separate from the NexusHarness installation and isolated run exports."><input id="settings-workspace" aria-invalid={Boolean(errors.workspaceRoot)} aria-describedby={`settings-workspace-hint${errors.workspaceRoot ? " settings-workspace-error" : ""}`} value={draft.workspaceRoot} onChange={(event) => setDraft({ ...draft, workspaceRoot: event.target.value })} /></Field></FieldError><div className="form-grid"><Field label="Test command" htmlFor="settings-test" hint="Objective validation run inside each isolated export transaction."><input id="settings-test" aria-describedby="settings-test-hint" value={draft.testCommand} onChange={(event) => setDraft({ ...draft, testCommand: event.target.value })} placeholder="npm test" /></Field><Field label="Lint command" htmlFor="settings-lint" hint="Additional validation run inside each isolated export transaction."><input id="settings-lint" aria-describedby="settings-lint-hint" value={draft.lintCommand} onChange={(event) => setDraft({ ...draft, lintCommand: event.target.value })} placeholder="npm run lint" /></Field></div><FieldError id="settings-shell" error={errors.shellPath}><Field label="Shell executable" htmlFor="settings-shell" hint="Used for operator-configured validation. Legacy host execution additionally requires explicit server opt-in and per-action approval."><input id="settings-shell" aria-invalid={Boolean(errors.shellPath)} aria-describedby={`settings-shell-hint${errors.shellPath ? " settings-shell-error" : ""}`} value={draft.shellPath} onChange={(event) => setDraft({ ...draft, shellPath: event.target.value })} /></Field></FieldError></>;
}

function ExecutionSettings({ draft, setNumber, errors }: { draft: SettingsShape; setNumber: (key: keyof SettingsShape, value: string) => void; errors: Record<string, string> }) {
  return <><div className="setting-callout"><Workflow /><div><strong>Bounded iteration</strong><p>These limits apply to each run and prevent unbounded agent loops or local concurrency.</p></div></div><div className="form-grid three-fields"><NumberSetting id="settings-iterations" label="Max iterations" value={draft.maxIterations} min={1} max={25} unit="cycles" error={errors.maxIterations} onChange={(value) => setNumber("maxIterations", value)} /><NumberSetting id="settings-executors" label="Parallel executors" value={draft.maxParallelExecutors} min={1} max={12} unit="agents" error={errors.maxParallelExecutors} onChange={(value) => setNumber("maxParallelExecutors", value)} /><NumberSetting id="settings-threshold" label="Critic threshold" value={draft.criticThreshold} min={1} max={10} unit="/ 10" error={errors.criticThreshold} onChange={(value) => setNumber("criticThreshold", value)} /></div></>;
}

function SafetySettings({ draft, setDraft }: { draft: SettingsShape; setDraft: (value: SettingsShape) => void }) {
  return <><label className="setting-toggle"><span className="setting-symbol"><ShieldCheck /></span><span><strong>Approval mode</strong><small>Pause writes, deletes, and shell commands for contextual review.</small></span><input type="checkbox" checked={draft.approvalMode} onChange={(event) => { if (!event.target.checked && !window.confirm("Disable approval mode? Transactional actions remain brokered, but compatibility-mode host execution will be blocked.")) return; setDraft({ ...draft, approvalMode: event.target.checked }); }} /><i /></label>{!draft.approvalMode && <InlineAlert tone="warning" title="Approval mode is disabled">Compatibility-mode host execution is prohibited. Use only with a transactional execution provider.</InlineAlert>}<div className="setting-callout safe"><ShieldCheck /><div><strong>Server-enforced run gates</strong><p>Execution mode must be explicit, installation/workspace overlap is rejected, and compatibility mode cannot run without approvals.</p></div></div></>;
}

function IntegrationSettings({ draft, setDraft, setNumber, errors }: { draft: SettingsShape; setDraft: (value: SettingsShape) => void; setNumber: (key: keyof SettingsShape, value: string) => void; errors: Record<string, string> }) {
  return <><label className="setting-toggle"><span className="setting-symbol"><Cpu /></span><span><strong>MCP auto-discovery</strong><small>Allow manual localhost scans only inside the configured range.</small></span><input type="checkbox" checked={draft.mcpAutoDiscovery} onChange={(event) => setDraft({ ...draft, mcpAutoDiscovery: event.target.checked })} /><i /></label><div className="form-grid"><NumberSetting id="settings-port-start" label="Discovery port start" value={draft.mcpPortStart} min={1} max={65535} unit="port" error={errors.mcpPortStart} onChange={(value) => setNumber("mcpPortStart", value)} /><NumberSetting id="settings-port-end" label="Discovery port end" value={draft.mcpPortEnd} min={1} max={65535} unit="port" error={errors.mcpPortEnd} onChange={(value) => setNumber("mcpPortEnd", value)} /></div><p className="setting-footnote"><Info />Scans run in truthful chunks of at most 500 ports and can be canceled from Tools & MCP.</p></>;
}

function MemorySettings({ draft, setDraft, setNumber, errors }: { draft: SettingsShape; setDraft: (value: SettingsShape) => void; setNumber: (key: keyof SettingsShape, value: string) => void; errors: Record<string, string> }) {
  const retrieval = { ...defaultClientMemoryRetrieval, ...(draft.memoryRetrieval ?? {}) };
  const embeddings = { ...defaultClientMemoryEmbeddings, ...(draft.memoryEmbeddings ?? {}) };
  const updateRetrieval = (patch: Partial<typeof retrieval>) => setDraft({ ...draft, memoryRetrieval: { ...retrieval, ...patch } });
  const updateEmbeddings = (patch: Partial<typeof embeddings>) => setDraft({ ...draft, memoryEmbeddings: { ...embeddings, ...patch } });
  const httpProvider = embeddings.provider !== "transformers-local";
  return <>
    <div className="setting-callout"><Database /><div><strong>Staged semantic retrieval</strong><p>Lexical-only is the instant rollback. Shadow computes semantic rankings without changing prompts; hybrid combines both signals. Stored memory is always treated as untrusted reference data.</p></div></div>
    <div className="form-grid"><Field label="Retrieval mode" htmlFor="settings-memory-mode" hint="Use shadow before enabling hybrid in an existing deployment."><select id="settings-memory-mode" value={retrieval.mode} onChange={(event) => updateRetrieval({ mode: event.target.value as typeof retrieval.mode })}><option value="lexical_only">Lexical only</option><option value="shadow_semantic">Shadow semantic</option><option value="hybrid">Hybrid</option><option value="semantic_only">Semantic only (diagnostic)</option></select></Field><NumberSetting id="settings-memory-budget" label="Memory token budget" value={draft.memoryTokenBudget} min={0} max={50000} unit="tokens" error={errors.memoryTokenBudget} onChange={(value) => setNumber("memoryTokenBudget", value)} /></div>
    <div className="form-grid"><Field label="Embedding provider" htmlFor="settings-memory-provider" hint={httpProvider ? "Remote endpoints require explicit consent below." : "Runs neural inference inside this Node process."}><select id="settings-memory-provider" value={embeddings.provider} onChange={(event) => updateEmbeddings({ provider: event.target.value as typeof embeddings.provider, endpoint: event.target.value === "ollama" ? "http://127.0.0.1:11434" : event.target.value === "openai-compatible" ? "http://127.0.0.1:1234/v1" : "" })}><option value="transformers-local">Transformers.js local</option><option value="ollama">Ollama</option><option value="openai-compatible">OpenAI-compatible</option></select></Field><FieldError id="settings-memory-model" error={errors.memoryEmbeddingModel}><Field label="Embedding model" htmlFor="settings-memory-model" hint="Model identity is part of the vector generation."><input id="settings-memory-model" value={embeddings.model} onChange={(event) => updateEmbeddings({ model: event.target.value })} aria-invalid={Boolean(errors.memoryEmbeddingModel)} /></Field></FieldError></div>
    {httpProvider && <FieldError id="settings-memory-endpoint" error={errors.memoryEmbeddingEndpoint}><Field label="Embedding endpoint" htmlFor="settings-memory-endpoint" hint="Only embedding requests use this endpoint; credentials stay in the configured environment variable."><input id="settings-memory-endpoint" value={embeddings.endpoint} onChange={(event) => updateEmbeddings({ endpoint: event.target.value })} aria-invalid={Boolean(errors.memoryEmbeddingEndpoint)} /></Field></FieldError>}
    <div className="form-grid three-fields"><NumberSetting id="settings-memory-top-k" label="Candidate count" value={retrieval.topKCandidates} min={1} max={500} unit="candidates" error={errors.memoryTopK} onChange={(value) => updateRetrieval({ topKCandidates: Number(value) })} /><NumberSetting id="settings-memory-final" label="Final memory limit" value={retrieval.finalMemoryLimit} min={1} max={100} unit="memories" error={errors.memoryFinalLimit} onChange={(value) => updateRetrieval({ finalMemoryLimit: Number(value) })} /><NumberSetting id="settings-memory-min-score" label="Minimum semantic score" value={retrieval.minimumSemanticScore} min={0} max={1} step={0.01} unit="0–1" error={errors.memoryMinimumScore} onChange={(value) => updateRetrieval({ minimumSemanticScore: Number(value) })} /></div>
    <label className="setting-toggle"><span className="setting-symbol"><Database /></span><span><strong>Diversity reranking</strong><small>Use maximal marginal relevance so duplicate memories do not consume the context budget.</small></span><input type="checkbox" checked={retrieval.diversityReranking} onChange={(event) => updateRetrieval({ diversityReranking: event.target.checked })} /><i /></label>
    <label className="setting-toggle"><span className="setting-symbol"><ShieldCheck /></span><span><strong>Embed on write</strong><small>Index new and changed memory immediately in semantic modes.</small></span><input type="checkbox" checked={embeddings.embedOnWrite} onChange={(event) => updateEmbeddings({ embedOnWrite: event.target.checked })} /><i /></label>
    {embeddings.provider === "transformers-local" && <label className="setting-toggle"><span className="setting-symbol"><Cpu /></span><span><strong>Permit model download</strong><small>Downloads model weights only. Memory text remains inside this process. Disable after the model is cached for offline use.</small></span><input type="checkbox" checked={embeddings.allowModelDownload} onChange={(event) => updateEmbeddings({ allowModelDownload: event.target.checked })} /><i /></label>}
    {httpProvider && <label className="setting-toggle"><span className="setting-symbol"><AlertTriangle /></span><span><strong>Allow memory content off-device</strong><small>Required for non-loopback endpoints. Review provider retention and privacy terms first.</small></span><input type="checkbox" checked={embeddings.allowRemoteContent} onChange={(event) => updateEmbeddings({ allowRemoteContent: event.target.checked })} /><i /></label>}
    <details className="settings-advanced"><summary>Ranking, chunking, cache, and failure controls</summary><div className="settings-route-body">
      <div className="form-grid three-fields"><NumberSetting id="settings-memory-semantic-weight" label="Semantic weight" value={retrieval.semanticWeight} min={0} max={1} step={0.01} unit="weight" error={errors.memoryWeights} onChange={(value) => updateRetrieval({ semanticWeight: Number(value) })} /><NumberSetting id="settings-memory-lexical-weight" label="Lexical weight" value={retrieval.lexicalWeight} min={0} max={1} step={0.01} unit="weight" onChange={(value) => updateRetrieval({ lexicalWeight: Number(value) })} /><NumberSetting id="settings-memory-task-weight" label="Task-type weight" value={retrieval.taskTypeWeight} min={0} max={1} step={0.01} unit="weight" onChange={(value) => updateRetrieval({ taskTypeWeight: Number(value) })} /></div>
      <div className="form-grid three-fields"><NumberSetting id="settings-memory-recency-weight" label="Recency weight" value={retrieval.recencyWeight} min={0} max={1} step={0.01} unit="weight" onChange={(value) => updateRetrieval({ recencyWeight: Number(value) })} /><NumberSetting id="settings-memory-importance-weight" label="Importance weight" value={retrieval.importanceWeight} min={0} max={1} step={0.01} unit="weight" onChange={(value) => updateRetrieval({ importanceWeight: Number(value) })} /><NumberSetting id="settings-memory-diversity" label="MMR relevance" value={retrieval.diversityLambda} min={0} max={1} step={0.01} unit="lambda" onChange={(value) => updateRetrieval({ diversityLambda: Number(value) })} /></div>
      <div className="form-grid three-fields"><NumberSetting id="settings-memory-batch" label="Embedding batch" value={embeddings.batchSize} min={1} max={256} unit="texts" onChange={(value) => updateEmbeddings({ batchSize: Number(value) })} /><NumberSetting id="settings-memory-input" label="Model input limit" value={embeddings.maxInputTokens} min={32} max={1000000} unit="tokens" onChange={(value) => updateEmbeddings({ maxInputTokens: Number(value) })} /><NumberSetting id="settings-memory-chunk" label="Chunk size" value={embeddings.chunkSizeTokens} min={16} max={100000} unit="tokens" error={errors.memoryChunkSize} onChange={(value) => updateEmbeddings({ chunkSizeTokens: Number(value) })} /></div>
      <div className="form-grid three-fields"><NumberSetting id="settings-memory-overlap" label="Chunk overlap" value={embeddings.chunkOverlapTokens} min={0} max={50000} unit="tokens" error={errors.memoryChunkOverlap} onChange={(value) => updateEmbeddings({ chunkOverlapTokens: Number(value) })} /><NumberSetting id="settings-memory-timeout" label="Provider timeout" value={embeddings.timeoutMs} min={1000} max={300000} unit="ms" onChange={(value) => updateEmbeddings({ timeoutMs: Number(value) })} /><NumberSetting id="settings-memory-retries" label="Provider retries" value={embeddings.maxRetries} min={0} max={10} unit="retries" onChange={(value) => updateEmbeddings({ maxRetries: Number(value) })} /></div>
      <div className="form-grid"><Field label="Failure policy" htmlFor="settings-memory-failure" hint="Lexical fallback is recommended for interactive use."><select id="settings-memory-failure" value={embeddings.failurePolicy} onChange={(event) => updateEmbeddings({ failurePolicy: event.target.value as typeof embeddings.failurePolicy })}><option value="lexical_fallback">Visible lexical fallback</option><option value="fail_closed">Fail the run</option></select></Field><Field label="Pinned policy" htmlFor="settings-memory-pinned" hint="Always-include entries are packed before discretionary results."><select id="settings-memory-pinned" value={retrieval.pinnedPolicy} onChange={(event) => updateRetrieval({ pinnedPolicy: event.target.value as typeof retrieval.pinnedPolicy })}><option value="always_include">Always include</option><option value="ranked">Rank normally</option></select></Field></div>
      <label className="setting-toggle"><span className="setting-symbol"><Database /></span><span><strong>Embedding cache</strong><small>Cache keys include provider, model, revision, preprocessing version, and normalized text hash.</small></span><input type="checkbox" checked={embeddings.cacheEnabled} onChange={(event) => updateEmbeddings({ cacheEnabled: event.target.checked })} /><i /></label>
      <label className="setting-toggle"><span className="setting-symbol"><Workflow /></span><span><strong>Asynchronous legacy backfill</strong><small>Resume bounded backfill after startup or a semantic configuration change.</small></span><input type="checkbox" checked={embeddings.allowAsyncBackfill} onChange={(event) => updateEmbeddings({ allowAsyncBackfill: event.target.checked })} /><i /></label>
    </div></details>
  </>;
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
  return <><div className="advanced-facts"><div><span><strong>Client version</strong><small>Synchronized Semantic Version</small></span><code>{__NEXUSHARNESS_BUILD__.version}</code></div><div><span><strong>API version</strong><small>{health ? "Connected local service" : "API identity unavailable"}</small></span><code>{health?.version ?? "offline"}</code></div><div><span><strong>Commit</strong><small>Client / API build provenance</small></span><code>{__NEXUSHARNESS_BUILD__.commit} / {health?.commit ?? "offline"}</code></div><div><span><strong>Built</strong><small>{__NEXUSHARNESS_BUILD__.mode} client</small></span><code>{__NEXUSHARNESS_BUILD__.builtAt}</code></div><div><span><strong>Storage</strong><small>JSON source data plus local SQLite vector index; no telemetry</small></span><code>.nexusharness/</code></div></div><div className="form-actions"><button className="button secondary" onClick={() => void copy()}><BookOpen />Copy build diagnostics</button></div><InlineAlert tone="info" title="NexusHarness v2">Version identity is synchronized across the client, API, package, and release metadata.</InlineAlert></>;
}

function NumberSetting({ id, label, value, min, max, step = 1, unit, error, onChange }: { id: string; label: string; value: number; min: number; max: number; step?: number; unit: string; error?: string; onChange: (value: string) => void }) {
  return <FieldError id={id} error={error}><Field label={label} htmlFor={id} hint={`${min.toLocaleString()}–${max.toLocaleString()} ${unit}`}><div className="number-control"><input id={id} aria-invalid={Boolean(error)} aria-describedby={`${id}-hint${error ? ` ${id}-error` : ""}`} type="number" min={min} max={max} step={step} value={value} onChange={(event) => onChange(event.target.value)} /><span>{unit}</span></div></Field></FieldError>;
}

function FieldError({ id, error, children }: { id: string; error?: string; children: React.ReactNode }) {
  return <div className="field-with-error">{children}{error && <p className="field-error" id={`${id}-error`} role="alert">{error}</p>}</div>;
}

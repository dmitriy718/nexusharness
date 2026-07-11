import React, { useCallback, useEffect, useState } from "react";
import { Activity, Check, Clock3, Cpu, Gauge, Plus, RefreshCw, Search, Server, Trash2, X } from "lucide-react";
import { api, errorMessage } from "../../api/client";
import type { Model, Runtime, RuntimeKind, RuntimeTestResult } from "../../api/types";
import { useHarness } from "../../app/StoreProvider";
import { EmptyState, Field, InlineAlert, PageHeader, StatusBadge, formatDate } from "../../components/ui";
import { AgentAssignments } from "../agents/AgentAssignments";
import { assignmentImpact, changeRuntimeKind, runtimeDraft, runtimePayload, validateRuntimeDraft, type RuntimeDraft } from "./runtimeModel";

type RuntimeHealth = { status: "online" | "error"; latencyMs: number; checkedAt: string; error?: string };

export function ModelsPage() {
  const { store, refresh, notify } = useHarness();
  const [models, setModels] = useState<Model[]>([]);
  const [health, setHealth] = useState<Record<string, RuntimeHealth>>({});
  const [inventoryBusy, setInventoryBusy] = useState(false);
  const [query, setQuery] = useState("");
  const [wizardOpen, setWizardOpen] = useState(false);
  const [draft, setDraft] = useState<RuntimeDraft>(() => runtimeDraft());
  const [tested, setTested] = useState<RuntimeTestResult | null>(null);
  const [testing, setTesting] = useState(false);
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState("");
  const [submitted, setSubmitted] = useState(false);

  const loadModels = useCallback(async (fresh = false) => {
    if (!store) return;
    setInventoryBusy(true);
    const results = await Promise.all(store.runtimes.map(async (runtime) => {
      const started = performance.now();
      try {
        const runtimeModels = await api<Model[]>(`/api/runtimes/${runtime.id}/models${fresh ? "?fresh=1" : ""}`);
        return { runtimeId: runtime.id, models: runtimeModels, health: { status: "online", latencyMs: Math.max(1, Math.round(performance.now() - started)), checkedAt: new Date().toISOString() } as RuntimeHealth };
      } catch (caught) {
        return { runtimeId: runtime.id, models: [] as Model[], health: { status: "error", latencyMs: Math.max(1, Math.round(performance.now() - started)), checkedAt: new Date().toISOString(), error: errorMessage(caught) } as RuntimeHealth };
      }
    }));
    setModels(results.flatMap((result) => result.models));
    setHealth(Object.fromEntries(results.map((result) => [result.runtimeId, result.health])));
    setInventoryBusy(false);
  }, [store]);

  useEffect(() => { void loadModels(); }, [loadModels]);
  useEffect(() => { if (store && !store.runtimes.length) setWizardOpen(true); }, [store]);
  if (!store) return null;

  const errors = validateRuntimeDraft(draft);
  const visibleModels = models.filter((model) => {
    const runtime = store.runtimes.find((item) => item.id === model.runtimeId);
    return !query || [model.name, model.quantization, runtime?.name, runtime?.kind, model.supportsTools ? "tools" : "text"].join(" ").toLowerCase().includes(query.toLowerCase());
  });
  const onlineCount = Object.values(health).filter((item) => item.status === "online").length;

  const updateDraft = <K extends keyof RuntimeDraft>(key: K, value: RuntimeDraft[K]) => {
    setDraft((current) => key === "kind" ? changeRuntimeKind(current, value as RuntimeKind) : { ...current, [key]: value });
    setTested(null);
    setFormError("");
  };

  const testConnection = async () => {
    setSubmitted(true);
    setFormError("");
    if (Object.keys(errors).length) return;
    setTesting(true);
    try {
      setTested(await api<RuntimeTestResult>("/api/runtimes/test", { method: "POST", body: JSON.stringify(runtimePayload(draft)) }));
    } catch (caught) {
      setTested(null);
      setFormError(errorMessage(caught));
    } finally {
      setTesting(false);
    }
  };

  const saveRuntime = async () => {
    if (!tested) return;
    setSaving(true);
    setFormError("");
    try {
      await api("/api/runtimes", { method: "POST", body: JSON.stringify(runtimePayload(draft)) });
      await refresh();
      setDraft(runtimeDraft(draft.kind));
      setTested(null);
      setSubmitted(false);
      setWizardOpen(false);
      notify("Runtime saved after a successful connection test.");
    } catch (caught) {
      setFormError(errorMessage(caught));
    } finally {
      setSaving(false);
    }
  };

  const remove = async (runtime: Runtime) => {
    const impacted = assignmentImpact(runtime, store.settings.agentModels);
    const impact = impacted.length ? `\n\nThe ${impacted.join(", ")} role${impacted.length === 1 ? "" : "s"} will become unassigned.` : "\n\nNo agent assignment uses this runtime.";
    if (!window.confirm(`Remove ${runtime.name}?${impact}`)) return;
    try {
      await api(`/api/runtimes/${runtime.id}`, { method: "DELETE" });
      await refresh();
      setModels((current) => current.filter((model) => model.runtimeId !== runtime.id));
      notify("Runtime removed and dependent assignments updated.", "info");
    } catch (caught) {
      notify(`Runtime removal failed: ${errorMessage(caught)}`, "danger");
    }
  };

  return <div className="page models-page">
    <PageHeader eyebrow="Local intelligence" title="Models & runtimes" detail="Test private model connections, inspect capabilities, and assign the right model to each agent role." actions={<><button className="button secondary" disabled={inventoryBusy} onClick={() => void loadModels(true)}><RefreshCw className={inventoryBusy ? "spin" : ""} />{inventoryBusy ? "Checking…" : "Check all"}</button><button className="button primary" onClick={() => setWizardOpen(true)}><Plus />Add runtime</button></>} />

    <div className="runtime-overview metric-grid">
      <article className="metric-card metric-violet"><span className="metric-icon"><Server /></span><div><p>Connections</p><strong>{store.runtimes.length}</strong><small>configured runtimes</small></div></article>
      <article className="metric-card metric-green"><span className="metric-icon"><Activity /></span><div><p>Healthy</p><strong>{onlineCount}</strong><small>responding this session</small></div></article>
      <article className="metric-card metric-cyan"><span className="metric-icon"><Cpu /></span><div><p>Models</p><strong>{models.length}</strong><small>detected locally</small></div></article>
    </div>

    {wizardOpen && <RuntimeWizard draft={draft} updateDraft={updateDraft} errors={submitted ? errors : {}} tested={tested} testing={testing} saving={saving} formError={formError} testConnection={testConnection} saveRuntime={saveRuntime} close={() => { setWizardOpen(false); setFormError(""); }} />}

    <section className="section-block">
      <div className="section-heading responsive-heading"><div><p className="eyebrow">Connections</p><h2>{store.runtimes.length} configured</h2></div><span className="section-note">Health is checked locally and never sent to a cloud service.</span></div>
      {store.runtimes.length ? <div className="runtime-grid">{store.runtimes.map((runtime) => {
        const runtimeModels = models.filter((model) => model.runtimeId === runtime.id);
        const state = health[runtime.id];
        const impacted = assignmentImpact(runtime, store.settings.agentModels);
        return <article className="runtime-card runtime-card-v2" key={runtime.id}>
          <header><span className="metric-icon metric-violet"><Cpu /></span><div><h3>{runtime.name}</h3><p>{runtimeLabel(runtime.kind)}</p></div><StatusBadge status={state?.status ?? "unknown"} /></header>
          <code>{runtime.endpoint || runtime.binaryPath}</code>
          <div className="runtime-health-grid"><span><Gauge /><strong>{state ? `${state.latencyMs} ms` : "Not checked"}</strong><small>response time</small></span><span><Clock3 /><strong>{state ? formatDate(state.checkedAt) : "—"}</strong><small>last checked</small></span><span><Cpu /><strong>{runtimeModels.length}</strong><small>models found</small></span></div>
          {state?.error && <InlineAlert tone="danger" title="Connection check failed">{state.error}</InlineAlert>}
          <footer><span>{impacted.length ? `${impacted.join(", ")} assigned` : "No assigned roles"}</span><button className="button danger-quiet" onClick={() => void remove(runtime)}><Trash2 />Remove</button></footer>
        </article>;
      })}</div> : <EmptyState icon={<Cpu />} title="No runtime connected" detail="Use the guided connection test to discover local models before saving a runtime." action={<button className="button primary" onClick={() => setWizardOpen(true)}><Plus />Add your first runtime</button>} />}
    </section>

    <section className="section-block">
      <div className="section-heading responsive-heading"><div><p className="eyebrow">Model inventory</p><h2>{visibleModels.length} visible</h2></div><label className="search-control"><Search /><span className="sr-only">Search model inventory</span><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search models, runtimes, capabilities" /></label></div>
      {visibleModels.length ? <div className="model-table-wrap"><table className="model-table"><thead><tr><th>Model</th><th>Runtime</th><th>Context</th><th>Quantization</th><th>Tool calls</th></tr></thead><tbody>{visibleModels.map((model) => { const runtime = store.runtimes.find((item) => item.id === model.runtimeId); return <tr key={model.id}><td><strong>{model.name}</strong><code>{model.id}</code></td><td>{runtime?.name ?? "Unknown runtime"}</td><td>{model.contextWindow?.toLocaleString() ?? "Unknown"}</td><td>{model.quantization ?? "Unknown"}</td><td><StatusBadge status={model.supportsTools ? "native" : "fallback"} /></td></tr>; })}</tbody></table></div> : <EmptyState icon={<Search />} title={models.length ? "No matching models" : "No models discovered"} detail={models.length ? "Try a broader inventory search." : "Connect a healthy runtime or check existing connections again."} />}
    </section>

    <section className="section-block"><div className="section-heading"><div><p className="eyebrow">Crew configuration</p><h2>Agent assignments</h2></div></div><AgentAssignments models={models} compact /></section>
  </div>;
}

function RuntimeWizard({ draft, updateDraft, errors, tested, testing, saving, formError, testConnection, saveRuntime, close }: { draft: RuntimeDraft; updateDraft: <K extends keyof RuntimeDraft>(key: K, value: RuntimeDraft[K]) => void; errors: ReturnType<typeof validateRuntimeDraft>; tested: RuntimeTestResult | null; testing: boolean; saving: boolean; formError: string; testConnection: () => Promise<void>; saveRuntime: () => Promise<void>; close: () => void }) {
  const httpRuntime = draft.kind !== "llamacpp-cli";
  return <section className="section-block runtime-wizard" aria-labelledby="runtime-wizard-title">
    <header><div><p className="eyebrow">Guided connection</p><h2 id="runtime-wizard-title">Add a local runtime</h2><p>Configure, test without saving, then review the discovered capability inventory.</p></div><button className="icon-button" aria-label="Close runtime setup" onClick={close}><X /></button></header>
    <ol className="runtime-test-steps"><li className="complete"><Check /><span><strong>Configure</strong><small>Connector-specific fields</small></span></li><li className={testing ? "active" : tested ? "complete" : formError ? "error" : "pending"}>{testing ? <RefreshCw className="spin" /> : tested ? <Check /> : <span>2</span>}<span><strong>Test</strong><small>Reachability and response</small></span></li><li className={tested ? "complete" : "pending"}>{tested ? <Check /> : <span>3</span>}<span><strong>Review</strong><small>Models and capabilities</small></span></li></ol>
    <div className="runtime-wizard-grid"><div className="runtime-form">
      <Field label="Connection name" htmlFor="runtime-name"><input id="runtime-name" aria-invalid={Boolean(errors.name)} aria-describedby={errors.name ? "runtime-name-error" : undefined} value={draft.name} onChange={(event) => updateDraft("name", event.target.value)} placeholder="Local Ollama" /></Field>{errors.name && <small className="field-error" id="runtime-name-error">{errors.name}</small>}
      <Field label="Runtime type" htmlFor="runtime-kind" hint="Only fields used by this connector are shown."><select id="runtime-kind" value={draft.kind} onChange={(event) => updateDraft("kind", event.target.value as RuntimeKind)}><option value="ollama">Ollama REST</option><option value="lmstudio">LM Studio OpenAI API</option><option value="llamacpp-server">llama.cpp server</option><option value="llamacpp-cli">llama.cpp CLI</option></select></Field>
      {httpRuntime ? <><Field label="Endpoint URL" htmlFor="runtime-endpoint" hint="The local HTTP endpoint exposed by the runtime."><input id="runtime-endpoint" aria-invalid={Boolean(errors.endpoint)} aria-describedby={errors.endpoint ? "runtime-endpoint-error" : "runtime-endpoint-hint"} value={draft.endpoint} onChange={(event) => updateDraft("endpoint", event.target.value)} /></Field>{errors.endpoint && <small className="field-error" id="runtime-endpoint-error">{errors.endpoint}</small>}</> : <><Field label="llama.cpp executable" htmlFor="runtime-binary" hint="Absolute path to llama-cli or llama-cli.exe."><input id="runtime-binary" aria-invalid={Boolean(errors.binaryPath)} value={draft.binaryPath} onChange={(event) => updateDraft("binaryPath", event.target.value)} placeholder="C:\\llama.cpp\\llama-cli.exe" /></Field>{errors.binaryPath && <small className="field-error">{errors.binaryPath}</small>}<Field label="GGUF model file" htmlFor="runtime-model-path"><input id="runtime-model-path" aria-invalid={Boolean(errors.modelPath)} value={draft.modelPath} onChange={(event) => updateDraft("modelPath", event.target.value)} placeholder="D:\\models\\model.gguf" /></Field>{errors.modelPath && <small className="field-error">{errors.modelPath}</small>}</>}
      <Field label="Connection timeout" htmlFor="runtime-timeout" hint="Milliseconds; 1,000–300,000."><input id="runtime-timeout" type="number" min="1000" max="300000" value={draft.timeoutMs} onChange={(event) => updateDraft("timeoutMs", Number(event.target.value))} /></Field>{errors.timeoutMs && <small className="field-error">{errors.timeoutMs}</small>}
      {formError && <InlineAlert tone="danger" title="Connection test failed">{formError}</InlineAlert>}
      <button className="button secondary" disabled={testing || saving} onClick={() => void testConnection()}><Activity />{testing ? "Testing endpoint…" : tested ? "Test again" : "Test connection"}</button>
    </div><div className="runtime-test-result">
      {tested ? <><span className="result-orb"><Check /></span><p className="eyebrow">Connection verified</p><h3>{tested.models.length} model{tested.models.length === 1 ? "" : "s"} discovered</h3><p>The endpoint responded in {tested.latencyMs} ms at {formatDate(tested.checkedAt)}. Saving will repeat the test to prevent stale configuration.</p><div className="test-model-list">{tested.models.slice(0, 8).map((model) => <div key={model.id}><span><strong>{model.name}</strong><small>{model.contextWindow ? `${model.contextWindow.toLocaleString()} context` : "Context unknown"}</small></span><StatusBadge status={model.supportsTools ? "native tools" : "JSON fallback"} /></div>)}</div><button className="button primary" disabled={saving} onClick={() => void saveRuntime()}><Server />{saving ? "Rechecking and saving…" : "Save verified runtime"}</button></> : <><span className="result-orb waiting"><Activity /></span><p className="eyebrow">Nothing saved yet</p><h3>Verify before persistence</h3><p>NexusHarness will validate the form, contact only the configured local endpoint, and inspect its model inventory. Review the result here before saving.</p></>}
    </div></div>
  </section>;
}

function runtimeLabel(kind: string) {
  if (kind === "ollama") return "Ollama REST";
  if (kind === "lmstudio") return "LM Studio OpenAI API";
  if (kind === "llamacpp-server") return "llama.cpp server";
  return "llama.cpp CLI";
}

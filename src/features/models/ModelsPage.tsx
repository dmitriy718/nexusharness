import React, { useCallback, useEffect, useState } from "react";
import { Bot, Check, Cpu, Plus, RefreshCw, Trash2, Wrench } from "lucide-react";
import { api, errorMessage } from "../../api/client";
import type { Model, Runtime } from "../../api/types";
import { useHarness } from "../../app/StoreProvider";
import { EmptyState, Field, InlineAlert, PageHeader, StatusBadge } from "../../components/ui";

export function ModelsPage() {
  const { store, refresh, notify, saveSettings } = useHarness();
  const [models, setModels] = useState<Model[]>([]);
  const [modelErrors, setModelErrors] = useState<Record<string, string>>({});
  const [inventoryBusy, setInventoryBusy] = useState(false);
  const [adding, setAdding] = useState(false);
  const [formError, setFormError] = useState("");
  const [form, setForm] = useState({ name: "", kind: "ollama", endpoint: "http://127.0.0.1:11434", binaryPath: "", modelPath: "", timeoutMs: 60000 });

  const loadModels = useCallback(async (fresh = false) => {
    if (!store) return;
    setInventoryBusy(true);
    const results = await Promise.all(store.runtimes.map(async (runtime) => {
      try {
        return { runtimeId: runtime.id, models: await api<Model[]>("/api/runtimes/" + runtime.id + "/models" + (fresh ? "?fresh=1" : "")) };
      } catch (error) {
        return { runtimeId: runtime.id, models: [] as Model[], error: errorMessage(error) };
      }
    }));
    setModels(results.flatMap((result) => result.models));
    setModelErrors(Object.fromEntries(results.filter((result) => result.error).map((result) => [result.runtimeId, result.error as string])));
    setInventoryBusy(false);
  }, [store]);

  useEffect(() => { void loadModels(); }, [loadModels]);
  if (!store) return null;
  const httpRuntime = form.kind !== "llamacpp-cli";

  const add = async () => {
    setAdding(true);
    setFormError("");
    try {
      await api("/api/runtimes", { method: "POST", body: JSON.stringify(form) });
      await refresh();
      setForm((current) => ({ ...current, name: "" }));
      notify("Runtime connected.");
    } catch (error) {
      setFormError(errorMessage(error));
    } finally {
      setAdding(false);
    }
  };

  const remove = async (runtime: Runtime) => {
    if (!window.confirm("Remove " + runtime.name + "? Agent roles using its models will become unassigned.")) return;
    try {
      await api("/api/runtimes/" + runtime.id, { method: "DELETE" });
      await refresh();
      setModels((current) => current.filter((model) => model.runtimeId !== runtime.id));
      notify("Runtime removed.", "info");
    } catch (error) {
      setFormError(errorMessage(error));
    }
  };

  const assign = async (role: string, modelId: string) => {
    await saveSettings({ ...store.settings, agentModels: { ...store.settings.agentModels, [role]: modelId || undefined } });
  };

  return (
    <div className="page">
      <PageHeader eyebrow="Local intelligence" title="Models & runtimes" detail="Connect private endpoints, inspect capabilities, and assign the right model to each agent role." actions={<button className="button secondary" disabled={inventoryBusy} onClick={() => void loadModels(true)}><RefreshCw className={inventoryBusy ? "spin" : ""} />{inventoryBusy ? "Refreshing…" : "Refresh inventory"}</button>} />

      <div className="settings-layout">
        <section className="section-block form-panel">
          <div className="section-heading"><div><p className="eyebrow">New connection</p><h2>Add runtime</h2></div><span className="summary-icon"><Plus /></span></div>
          <div className="setup-form">
            <Field label="Connection name" htmlFor="runtime-name"><input id="runtime-name" value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} placeholder="Local Ollama" /></Field>
            <Field label="Runtime type" htmlFor="runtime-kind"><select id="runtime-kind" value={form.kind} onChange={(event) => setForm({ ...form, kind: event.target.value })}><option value="ollama">Ollama REST</option><option value="lmstudio">LM Studio OpenAI API</option><option value="llamacpp-server">llama.cpp server</option><option value="llamacpp-cli">llama.cpp CLI</option></select></Field>
            {httpRuntime ? <Field label="Endpoint URL" htmlFor="runtime-endpoint" hint="The local HTTP endpoint exposed by your runtime."><input id="runtime-endpoint" value={form.endpoint} onChange={(event) => setForm({ ...form, endpoint: event.target.value })} aria-describedby="runtime-endpoint-hint" /></Field> : <>
              <Field label="llama.cpp binary" htmlFor="runtime-binary"><input id="runtime-binary" value={form.binaryPath} onChange={(event) => setForm({ ...form, binaryPath: event.target.value })} placeholder="C:\llama.cpp\llama-cli.exe" /></Field>
              <Field label="GGUF model" htmlFor="runtime-model-path"><input id="runtime-model-path" value={form.modelPath} onChange={(event) => setForm({ ...form, modelPath: event.target.value })} placeholder="D:\models\model.gguf" /></Field>
            </>}
            {formError && <InlineAlert title="Runtime could not be saved">{formError}</InlineAlert>}
            <button className="button primary" disabled={adding || !form.name.trim()} onClick={() => void add()}><Cpu />{adding ? "Testing connection…" : "Test and connect"}</button>
          </div>
        </section>

        <section className="section-block form-panel">
          <div className="section-heading"><div><p className="eyebrow">Crew configuration</p><h2>Agent assignments</h2></div><span className="summary-icon"><Bot /></span></div>
          <div className="assignment-list">
            {["planner", "executor", "critic"].map((role) => <label className="assignment-row" key={role}><span><strong>{role}</strong><small>{roleDescription(role)}</small></span><select aria-label={role + " model"} value={store.settings.agentModels[role] ?? ""} onChange={(event) => void assign(role, event.target.value)}><option value="">Unassigned</option>{models.map((model) => {
              const runtime = store.runtimes.find((item) => item.id === model.runtimeId);
              return <option value={model.id} key={model.id}>{model.name} · {runtime?.name ?? "runtime"}{model.supportsTools ? " · tools" : ""}</option>;
            })}</select></label>)}
          </div>
        </section>
      </div>

      <section className="section-block">
        <div className="section-heading"><div><p className="eyebrow">Connections</p><h2>{store.runtimes.length} configured</h2></div></div>
        {store.runtimes.length ? <div className="runtime-grid">{store.runtimes.map((runtime) => {
          const runtimeModels = models.filter((model) => model.runtimeId === runtime.id);
          return <article className="runtime-card" key={runtime.id}><header><span className="metric-icon metric-violet"><Cpu /></span><div><h3>{runtime.name}</h3><p>{runtime.kind}</p></div><StatusBadge status={modelErrors[runtime.id] ? "error" : runtimeModels.length ? "online" : "unknown"} /></header><code>{runtime.endpoint || runtime.binaryPath}</code>{modelErrors[runtime.id] && <InlineAlert title="Connection failed">{modelErrors[runtime.id]}</InlineAlert>}<div className="model-inventory">{runtimeModels.map((model) => <div key={model.id}><span><strong>{model.name}</strong><small>{model.quantization ?? "quantization unknown"}</small></span><span>{model.contextWindow ? model.contextWindow.toLocaleString() + " ctx" : "context unknown"}</span><em>{model.supportsTools ? <><Wrench />tools</> : "text"}</em></div>)}</div><footer><span>{runtimeModels.length} models detected</span><button className="button danger-quiet" onClick={() => void remove(runtime)}><Trash2 />Remove</button></footer></article>;
        })}</div> : <EmptyState icon={<Cpu />} title="No runtime connected" detail="Add a local runtime above to discover its available models." />}
      </section>
    </div>
  );
}

export function AgentsPage() {
  const { store } = useHarness();
  if (!store) return null;
  const roles = ["planner", "executor", "critic"];
  return (
    <div className="page">
      <PageHeader eyebrow="Agent crew" title="Roles & assignments" detail="A clear division of labor keeps planning, execution, and quality control legible." />
      <div className="agent-role-grid">{roles.map((role, index) => {
        const model = store.settings.agentModels[role];
        return <article className={"agent-role-card role-" + role} key={role}><header><span>0{index + 1}</span><StatusBadge status={model ? "ready" : "unassigned"} /></header><div className="agent-avatar"><Bot /></div><p className="eyebrow">{role}</p><h2>{model || "Choose a model"}</h2><p>{roleDescription(role)}</p><ul><li><Check />Bounded role context</li><li><Check />Audited activity</li><li><Check />Local model execution</li></ul></article>;
      })}</div>
    </div>
  );
}

function roleDescription(role: string) {
  if (role === "planner") return "Decomposes the objective into bounded, ordered subtasks.";
  if (role === "executor") return "Uses local and MCP tools to produce and revise the work.";
  return "Challenges quality and scores the result before objective validation.";
}

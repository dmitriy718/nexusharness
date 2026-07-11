import React, { useEffect, useMemo, useState } from "react";
import { AlertTriangle, Bot, Check, Save, Undo2, Wrench } from "lucide-react";
import { api, errorMessage } from "../../api/client";
import type { Model } from "../../api/types";
import { useHarness } from "../../app/StoreProvider";
import { InlineAlert, StatusBadge } from "../../components/ui";
import { assignedModel, roleCapability } from "../models/runtimeModel";

export const agentRoles = ["planner", "executor", "critic"] as const;

export function roleDescription(role: string) {
  if (role === "planner") return "Decomposes the objective into bounded, ordered subtasks.";
  if (role === "executor") return "Uses local and MCP tools to produce and revise the work.";
  return "Challenges quality and scores the result after objective validation.";
}

export function AgentAssignments({ models, compact = false }: { models: Model[]; compact?: boolean }) {
  const { store, saveSettings } = useHarness();
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const persisted = useMemo(() => Object.fromEntries(agentRoles.map((role) => [role, store?.settings.agentModels[role] ?? ""])), [store?.settings.agentModels]);

  useEffect(() => setDraft(persisted), [persisted]);
  if (!store) return null;
  const dirty = agentRoles.some((role) => (draft[role] ?? "") !== persisted[role]);

  const save = async () => {
    setBusy(true);
    setError("");
    try {
      await saveSettings({
        ...store.settings,
        agentModels: Object.fromEntries(agentRoles.map((role) => [role, draft[role] || undefined]))
      });
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  };

  return <div className={`agent-assignment-editor${compact ? " compact" : ""}`}>
    <div className="assignment-list">{agentRoles.map((role) => {
      const model = assignedModel(draft[role], models);
      const unavailable = Boolean(draft[role] && !model);
      const capability = model ? roleCapability(role, model) : null;
      return <div className="assignment-row-v2" key={role}>
        <span className={`agent-mini-avatar role-${role}`}><Bot /></span>
        <div className="assignment-copy"><strong>{role}</strong><small>{roleDescription(role)}</small></div>
        <label><span className="sr-only">{role} model</span><select value={draft[role] ?? ""} onChange={(event) => setDraft((current) => ({ ...current, [role]: event.target.value }))}><option value="">Unassigned</option>{unavailable && <option value={draft[role]}>Unavailable · {draft[role]}</option>}{store.runtimes.map((runtime) => <optgroup label={runtime.name} key={runtime.id}>{models.filter((modelOption) => modelOption.runtimeId === runtime.id).map((modelOption) => <option key={modelOption.id} value={modelOption.id}>{modelOption.name}{modelOption.supportsTools ? " · native tools" : ""}</option>)}</optgroup>)}</select></label>
        <span className={`capability-note capability-${capability?.tone ?? "missing"}`}>{capability?.tone === "native" ? <Wrench /> : capability ? <Check /> : <AlertTriangle />}<span><strong>{capability?.label ?? (unavailable ? "Unavailable" : "Model required")}</strong><small>{capability?.detail ?? (unavailable ? "The saved assignment is not present in the current runtime inventory." : "Assign a discovered model before starting a run.")}</small></span></span>
      </div>;
    })}</div>
    {error && <InlineAlert tone="danger" title="Assignments could not be saved">{error}</InlineAlert>}
    <div className="assignment-savebar"><span>{dirty ? "Unsaved assignment changes" : "Assignments match saved settings"}</span><div><button className="button quiet" disabled={!dirty || busy} onClick={() => setDraft(persisted)}><Undo2 />Discard</button><button className="button primary" disabled={!dirty || busy} onClick={() => void save()}><Save />{busy ? "Saving…" : "Save assignments"}</button></div></div>
  </div>;
}

export function AgentsPage() {
  const { store } = useHarness();
  const [models, setModels] = useState<Model[]>([]);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!store) return;
    let active = true;
    void Promise.all(store.runtimes.map((runtime) => api<Model[]>(`/api/runtimes/${runtime.id}/models`).catch(() => []))).then((groups) => {
      if (active) setModels(groups.flat());
    }).catch((caught) => active && setError(errorMessage(caught)));
    return () => { active = false; };
  }, [store]);
  if (!store) return null;

  return <div className="page">
    <div className="page-header"><div><p className="eyebrow">Agent crew</p><h1>Roles & assignments</h1><p>A clear division of labor keeps planning, execution, and quality control legible.</p></div></div>
    {error && <InlineAlert tone="danger" title="Model inventory unavailable">{error}</InlineAlert>}
    <div className="agent-role-grid">{agentRoles.map((role, index) => {
      const assignmentId = store.settings.agentModels[role];
      const model = assignedModel(assignmentId, models);
      const runtime = model ? store.runtimes.find((item) => item.id === model.runtimeId) : undefined;
      const capability = model ? roleCapability(role, model) : null;
      const unavailableName = assignmentId?.split(":").slice(1).join(":");
      return <article className={`agent-role-card role-${role}`} key={role}><header><span>0{index + 1}</span><StatusBadge status={model ? "ready" : assignmentId ? "unavailable" : "unassigned"} /></header><div className="agent-avatar"><Bot /></div><p className="eyebrow">{role}</p><h2>{model?.name ?? unavailableName ?? "Choose a model"}</h2><p>{runtime ? `${runtime.name} · ${capability?.label}` : assignmentId ? "Saved assignment is absent from the current inventory." : roleDescription(role)}</p><ul><li><Check />Bounded role context</li><li><Check />Audited activity</li><li>{role === "executor" ? <Wrench /> : <Check />}{role === "executor" ? capability?.detail ?? "Tool-capable model needed" : "Structured local inference"}</li></ul></article>;
    })}</div>
    <section className="section-block"><div className="section-heading"><div><p className="eyebrow">Crew configuration</p><h2>Assignment matrix</h2></div></div><AgentAssignments models={models} /></section>
  </div>;
}

import React, { useEffect, useMemo, useState } from "react";
import { AlertTriangle, Check, Cpu, FolderCode, Palette, RotateCcw, Save, Settings, ShieldCheck, Workflow } from "lucide-react";
import type { LayoutMode, SettingsShape } from "../../api/types";
import { useHarness } from "../../app/StoreProvider";
import { Field, InlineAlert, PageHeader } from "../../components/ui";

export function SettingsPage() {
  const { store, saveSettings } = useHarness();
  const [draft, setDraft] = useState<SettingsShape | null>(store?.settings ?? null);
  const [saving, setSaving] = useState(false);
  const [localError, setLocalError] = useState("");
  useEffect(() => { if (store) setDraft(store.settings); }, [store]);
  const dirty = useMemo(() => Boolean(store && draft && JSON.stringify(store.settings) !== JSON.stringify(draft)), [draft, store]);
  if (!store || !draft) return null;

  const save = async () => {
    setSaving(true);
    setLocalError("");
    try {
      await saveSettings(draft);
    } catch (error) {
      setLocalError(error instanceof Error ? error.message : String(error));
    } finally {
      setSaving(false);
    }
  };

  const setNumber = (key: keyof SettingsShape, value: string) => setDraft({ ...draft, [key]: Number(value) });

  return (
    <div className="page settings-page">
      <PageHeader eyebrow="Operator preferences" title="Settings" detail="Configure workspace boundaries, execution policy, integrations, and appearance." />
      {localError && <InlineAlert title="Settings could not be saved">{localError}</InlineAlert>}
      <div className="settings-sections">
        <SettingsSection icon={<FolderCode />} title="Workspace" detail="Local paths and objective validation">
          <Field label="Workspace root" htmlFor="settings-workspace" hint="All local file tools remain constrained to this existing directory."><input id="settings-workspace" value={draft.workspaceRoot} onChange={(event) => setDraft({ ...draft, workspaceRoot: event.target.value })} aria-describedby="settings-workspace-hint" /></Field>
          <div className="form-grid"><Field label="Test command" htmlFor="settings-test"><input id="settings-test" value={draft.testCommand} onChange={(event) => setDraft({ ...draft, testCommand: event.target.value })} placeholder="npm test" /></Field><Field label="Lint command" htmlFor="settings-lint"><input id="settings-lint" value={draft.lintCommand} onChange={(event) => setDraft({ ...draft, lintCommand: event.target.value })} placeholder="npm run lint" /></Field></div>
          <Field label="Shell executable" htmlFor="settings-shell"><input id="settings-shell" value={draft.shellPath} onChange={(event) => setDraft({ ...draft, shellPath: event.target.value })} /></Field>
        </SettingsSection>

        <SettingsSection icon={<Workflow />} title="Execution" detail="Agent loop bounds and quality threshold">
          <div className="form-grid three-fields">
            <NumberSetting id="settings-iterations" label="Max iterations" value={draft.maxIterations} min={1} max={25} unit="cycles" onChange={(value) => setNumber("maxIterations", value)} />
            <NumberSetting id="settings-executors" label="Parallel executors" value={draft.maxParallelExecutors} min={1} max={12} unit="agents" onChange={(value) => setNumber("maxParallelExecutors", value)} />
            <NumberSetting id="settings-threshold" label="Critic threshold" value={draft.criticThreshold} min={1} max={10} unit="/ 10" onChange={(value) => setNumber("criticThreshold", value)} />
          </div>
        </SettingsSection>

        <SettingsSection icon={<ShieldCheck />} title="Safety" detail="Operator review before consequential actions">
          <label className="setting-toggle"><span className="setting-symbol"><ShieldCheck /></span><span><strong>Approval mode</strong><small>Pause writes, deletes, and shell commands for review.</small></span><input type="checkbox" checked={draft.approvalMode} onChange={(event) => {
            if (!event.target.checked && !window.confirm("Disable approval mode? Agents may perform permitted writes and commands without pausing.")) return;
            setDraft({ ...draft, approvalMode: event.target.checked });
          }} /><i /></label>
          {!draft.approvalMode && <InlineAlert tone="warning" title="Approval mode is disabled"><p>Use this only in a trusted workspace you can restore.</p></InlineAlert>}
        </SettingsSection>

        <SettingsSection icon={<Cpu />} title="Integrations" detail="MCP discovery and memory retrieval">
          <label className="setting-toggle"><span className="setting-symbol"><Cpu /></span><span><strong>MCP auto-discovery</strong><small>Allow manual localhost scans within the configured range.</small></span><input type="checkbox" checked={draft.mcpAutoDiscovery} onChange={(event) => setDraft({ ...draft, mcpAutoDiscovery: event.target.checked })} /><i /></label>
          <div className="form-grid three-fields"><NumberSetting id="settings-port-start" label="Port start" value={draft.mcpPortStart} min={1} max={65535} unit="port" onChange={(value) => setNumber("mcpPortStart", value)} /><NumberSetting id="settings-port-end" label="Port end" value={draft.mcpPortEnd} min={1} max={65535} unit="port" onChange={(value) => setNumber("mcpPortEnd", value)} /><NumberSetting id="settings-memory-budget" label="Memory budget" value={draft.memoryTokenBudget} min={0} max={50000} unit="tokens" onChange={(value) => setNumber("memoryTokenBudget", value)} /></div>
          {draft.mcpPortStart > draft.mcpPortEnd && <p className="field-error" role="alert">Port start must be less than or equal to port end.</p>}
        </SettingsSection>

        <SettingsSection icon={<Palette />} title="Appearance" detail="Starting run workspace perspective">
          <div className="appearance-options">{([["chat", "Focus", "Timeline-first"], ["ide", "Studio", "Workspace split"], ["agents", "Orchestrate", "Agent activity"]] as Array<[LayoutMode, string, string]>).map(([id, name, description]) => <button className={draft.layout === id ? "selected" : ""} onClick={() => setDraft({ ...draft, layout: id })} key={id}><span>{id === "chat" ? <Check /> : id === "ide" ? <Settings /> : <Workflow />}</span><strong>{name}</strong><small>{description}</small>{draft.layout === id && <Check className="choice-check" />}</button>)}</div>
        </SettingsSection>
      </div>

      {dirty && <div className="dirty-bar" role="status"><span><AlertTriangle />You have unsaved settings.</span><div><button className="button quiet" onClick={() => setDraft(store.settings)}><RotateCcw />Discard</button><button className="button primary" disabled={saving || draft.mcpPortStart > draft.mcpPortEnd} onClick={() => void save()}><Save />{saving ? "Saving…" : "Save changes"}</button></div></div>}
    </div>
  );
}

function SettingsSection({ icon, title, detail, children }: { icon: React.ReactNode; title: string; detail: string; children: React.ReactNode }) {
  return <section className="settings-section"><header><span>{icon}</span><div><h2>{title}</h2><p>{detail}</p></div></header><div className="settings-body">{children}</div></section>;
}

function NumberSetting({ id, label, value, min, max, unit, onChange }: { id: string; label: string; value: number; min: number; max: number; unit: string; onChange: (value: string) => void }) {
  return <Field label={label} htmlFor={id} hint={min + "–" + max + " " + unit}><div className="number-control"><input id={id} type="number" min={min} max={max} value={value} onChange={(event) => onChange(event.target.value)} /><span>{unit}</span></div></Field>;
}

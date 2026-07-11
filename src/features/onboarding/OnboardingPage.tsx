import React, { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  ArrowLeft,
  ArrowRight,
  Bot,
  Check,
  Cpu,
  FolderCode,
  LayoutDashboard,
  MessageSquare,
  ShieldCheck,
  Sparkles,
  Workflow
} from "lucide-react";
import type { LayoutMode, SettingsShape } from "../../api/types";
import { useHarness } from "../../app/StoreProvider";
import { Field, InlineAlert } from "../../components/ui";

const steps = [
  { label: "Welcome", icon: Sparkles },
  { label: "Runtime", icon: Cpu },
  { label: "Agents", icon: Bot },
  { label: "Workspace", icon: FolderCode },
  { label: "Safety", icon: ShieldCheck },
  { label: "Mode", icon: LayoutDashboard }
];

export function OnboardingPage() {
  const { store, saveSettings } = useHarness();
  const navigate = useNavigate();
  const [step, setStep] = useState(0);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [draft, setDraft] = useState<SettingsShape | null>(store ? { ...store.settings, layout: store.settings.layout ?? "chat" } : null);
  const rolesReady = useMemo(() => store ? ["planner", "executor", "critic"].filter((role) => store.settings.agentModels[role]).length : 0, [store]);
  if (!store || !draft) return null;

  const finish = async () => {
    setSaving(true);
    setError("");
    try {
      await saveSettings(draft);
      navigate("/dashboard");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="onboarding-shell">
      <aside className="onboarding-aside">
        <div className="onboarding-brand"><span className="brand-mark"><Sparkles /></span><div><strong>NexusHarness</strong><small>Local agent control room</small></div></div>
        <ol className="setup-steps">
          {steps.map(({ label, icon: Icon }, index) => <li className={index === step ? "active" : index < step ? "complete" : ""} key={label}><span>{index < step ? <Check /> : <Icon />}</span><div><small>0{index + 1}</small><strong>{label}</strong></div></li>)}
        </ol>
        <p className="local-promise"><ShieldCheck />Your settings and run data stay on this machine.</p>
      </aside>

      <main className="onboarding-main">
        <div className="setup-progress"><span style={{ width: ((step + 1) / steps.length) * 100 + "%" }} /></div>
        <div className="setup-content">
          {step === 0 && <WelcomeStep />}
          {step === 1 && <RuntimeStep count={store.runtimes.length} onOpen={() => navigate("/models")} />}
          {step === 2 && <AgentsStep count={rolesReady} models={Object.entries(store.settings.agentModels)} onOpen={() => navigate("/agents")} />}
          {step === 3 && <WorkspaceStep draft={draft} setDraft={setDraft} />}
          {step === 4 && <SafetyStep draft={draft} setDraft={setDraft} />}
          {step === 5 && <ModeStep value={draft.layout ?? "chat"} setValue={(layout) => setDraft({ ...draft, layout })} />}
          {error && <InlineAlert title="Setup could not be saved">{error}</InlineAlert>}
        </div>
        <footer className="setup-footer">
          <button className="button quiet" disabled={step === 0 || saving} onClick={() => setStep((value) => value - 1)}><ArrowLeft />Back</button>
          <span>Step {step + 1} of {steps.length}</span>
          {step < steps.length - 1 ? <button className="button primary" onClick={() => setStep((value) => value + 1)}>Continue<ArrowRight /></button> : <button className="button primary glow" disabled={saving} onClick={() => void finish()}>{saving ? "Saving…" : "Enter NexusHarness"}<ArrowRight /></button>}
        </footer>
      </main>
    </div>
  );
}

function WelcomeStep() {
  return (
    <section className="setup-step">
      <p className="eyebrow">Welcome to v{__NEXUSHARNESS_BUILD__.version}</p>
      <h1>Your local models.<br /><span>Your mission control.</span></h1>
      <p className="setup-lead">Connect private runtimes to a clear, auditable workflow. NexusHarness plans, executes, critiques, and validates while you stay in control of every risky action.</p>
      <div className="setup-feature-grid">
        <article><span><Cpu /></span><h2>Runtime agnostic</h2><p>Ollama, LM Studio, and llama.cpp stay on your machine.</p></article>
        <article><span><Workflow /></span><h2>Multi-agent flow</h2><p>Purpose-built Planner, Executor, and Critic roles.</p></article>
        <article><span><ShieldCheck /></span><h2>Permission aware</h2><p>Writes and commands pause for contextual review.</p></article>
      </div>
    </section>
  );
}

function RuntimeStep({ count, onOpen }: { count: number; onOpen: () => void }) {
  return (
    <section className="setup-step">
      <p className="eyebrow">Runtime connection</p><h1>Bring your own intelligence.</h1><p className="setup-lead">NexusHarness uses the local endpoints you configure. No cloud account or telemetry is required.</p>
      <div className={"setup-check-card " + (count ? "ready" : "")}><span>{count ? <Check /> : <Cpu />}</span><div><h2>{count ? count + " runtime" + (count === 1 ? "" : "s") + " connected" : "Connect a runtime"}</h2><p>{count ? "Your configured runtime inventory is ready to inspect." : "Add Ollama, LM Studio, or llama.cpp and validate its model inventory."}</p></div><button className="button secondary" onClick={onOpen}>{count ? "Review runtimes" : "Open runtime setup"}<ArrowRight /></button></div>
      <p className="setup-skip-note">You may continue setup while a runtime is offline, but a run cannot start without valid role assignments.</p>
    </section>
  );
}

function AgentsStep({ count, models, onOpen }: { count: number; models: Array<[string, string | undefined]>; onOpen: () => void }) {
  return (
    <section className="setup-step">
      <p className="eyebrow">Agent roles</p><h1>Build a balanced crew.</h1><p className="setup-lead">Assign models for planning, execution, and critique. You can use one capable model for every role or specialize.</p>
      <div className="agent-setup-grid">{["planner", "executor", "critic"].map((role) => {
        const model = models.find(([name]) => name === role)?.[1];
        return <article className={model ? "ready" : ""} key={role}><span><Bot /></span><small>{role}</small><h2>{model ?? "Unassigned"}</h2><p>{role === "planner" ? "Breaks outcomes into bounded work." : role === "executor" ? "Uses tools and produces changes." : "Challenges quality before validation."}</p>{model && <em><Check />ready</em>}</article>;
      })}</div>
      <button className="button secondary" onClick={onOpen}>{count === 3 ? "Review assignments" : "Assign models"}<ArrowRight /></button>
    </section>
  );
}

function WorkspaceStep({ draft, setDraft }: { draft: SettingsShape; setDraft: (value: SettingsShape) => void }) {
  return (
    <section className="setup-step">
      <p className="eyebrow">Workspace and validation</p><h1>Define the safe boundary.</h1><p className="setup-lead">Local file and shell tools are constrained to this existing directory.</p>
      <div className="setup-form">
        <Field label="Workspace root" htmlFor="setup-workspace" hint="Use an absolute path to an existing directory."><input id="setup-workspace" value={draft.workspaceRoot} onChange={(event) => setDraft({ ...draft, workspaceRoot: event.target.value })} aria-describedby="setup-workspace-hint" /></Field>
        <div className="form-grid">
          <Field label="Test command" htmlFor="setup-test" hint="Optional objective validation."><input id="setup-test" value={draft.testCommand} onChange={(event) => setDraft({ ...draft, testCommand: event.target.value })} aria-describedby="setup-test-hint" placeholder="npm test" /></Field>
          <Field label="Lint command" htmlFor="setup-lint" hint="Optional code-quality validation."><input id="setup-lint" value={draft.lintCommand} onChange={(event) => setDraft({ ...draft, lintCommand: event.target.value })} aria-describedby="setup-lint-hint" placeholder="npm run lint" /></Field>
        </div>
      </div>
    </section>
  );
}

function SafetyStep({ draft, setDraft }: { draft: SettingsShape; setDraft: (value: SettingsShape) => void }) {
  return (
    <section className="setup-step">
      <p className="eyebrow">Safety boundary</p><h1>Keep consequential actions visible.</h1><p className="setup-lead">Approval mode pauses writes, deletes, and shell commands so you can inspect their exact scope.</p>
      <button className={"safety-choice " + (draft.approvalMode ? "selected" : "")} onClick={() => setDraft({ ...draft, approvalMode: true })}><span><ShieldCheck /></span><div><strong>Approval mode on</strong><p>Recommended. Review risky actions once before execution.</p></div>{draft.approvalMode && <Check />}</button>
      <button className={"safety-choice danger-choice " + (!draft.approvalMode ? "selected" : "")} onClick={() => setDraft({ ...draft, approvalMode: false })}><span><ShieldCheck /></span><div><strong>Approval mode off</strong><p>Agents may perform permitted writes and commands without pausing.</p></div>{!draft.approvalMode && <Check />}</button>
      {!draft.approvalMode && <InlineAlert tone="warning" title="Reduced safety">Only disable approvals in workspaces you fully control and can restore.</InlineAlert>}
    </section>
  );
}

function ModeStep({ value, setValue }: { value: LayoutMode; setValue: (value: LayoutMode) => void }) {
  const modes: Array<{ id: LayoutMode; name: string; detail: string; icon: React.ComponentType }> = [
    { id: "chat", name: "Focus", detail: "A calm timeline and persistent task composer.", icon: MessageSquare },
    { id: "ide", name: "Studio", detail: "Workspace, diffs, and execution in a split canvas.", icon: LayoutDashboard },
    { id: "agents", name: "Orchestrate", detail: "Phases, subtasks, agents, and approvals at a glance.", icon: Workflow }
  ];
  return (
    <section className="setup-step">
      <p className="eyebrow">Workspace mode</p><h1>Choose your starting perspective.</h1><p className="setup-lead">Modes change the run canvas, not your data. Switch whenever the work calls for a different view.</p>
      <div className="mode-choice-grid">{modes.map(({ id, name, detail, icon: Icon }) => <button className={value === id ? "selected" : ""} onClick={() => setValue(id)} key={id}><span className="mode-preview"><i /><i /><i /><b><Icon /></b></span><span><strong>{name}</strong>{id === "chat" && <em>Recommended</em>}</span><p>{detail}</p>{value === id && <Check className="choice-check" />}</button>)}</div>
    </section>
  );
}

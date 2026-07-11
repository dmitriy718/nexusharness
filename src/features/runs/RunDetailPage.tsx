import React, { useMemo, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import {
  ArrowLeft,
  Bot,
  BrainCircuit,
  Check,
  Circle,
  Clipboard,
  Copy,
  Code2,
  FlaskConical,
  GitPullRequestArrow,
  MoreHorizontal,
  RotateCcw,
  Square,
  X
} from "lucide-react";
import { api, errorMessage } from "../../api/client";
import type { RunPhase, TaskRun } from "../../api/types";
import { useHarness } from "../../app/StoreProvider";
import { EmptyState, InlineAlert, RunStatusBadge, formatDate, formatDuration, handleTabListKeyDown, shortId } from "../../components/ui";
import { displayRunValue, phaseState, runActions, runSummary } from "./runModel";
import { modeFromLayout, type RunMode } from "./runModeModel";
import { OrchestrateMode, StudioMode } from "./RunModes";

const phases: Array<{ id: RunPhase; label: string; icon: React.ComponentType<{ className?: string }> }> = [
  { id: "plan", label: "Plan", icon: Clipboard },
  { id: "execute", label: "Execute", icon: Code2 },
  { id: "test", label: "Validate", icon: FlaskConical },
  { id: "critic", label: "Critique", icon: BrainCircuit },
  { id: "retrospective", label: "Reflect", icon: GitPullRequestArrow },
  { id: "done", label: "Done", icon: Check }
];

export function RunDetailPage() {
  const { runId } = useParams();
  const { store, refresh, notify } = useHarness();
  const navigate = useNavigate();
  const [busy, setBusy] = useState("");
  const [actionError, setActionError] = useState("");
  const [inspector, setInspector] = useState<"overview" | "outputs" | "activity">("overview");
  const [mode, setMode] = useState<RunMode>(() => (localStorage.getItem("nexusharness.runMode") as RunMode | null) ?? modeFromLayout(store?.settings.layout ?? null));
  const run = store?.runs.find((item) => item.id === runId);

  const events = useMemo(() => store?.audit.filter((event) => {
    const details = JSON.stringify(event.details ?? "");
    return details.includes(runId ?? "") || event.message.includes(runId ?? "");
  }).slice(0, 30) ?? [], [runId, store?.audit]);

  if (!store) return null;
  if (!run) return <div className="page"><EmptyState title="Run not found" detail="This run may have been removed from local history." action={<Link className="button secondary" to="/runs">Back to runs</Link>} /></div>;
  const eligibility = runActions(run);

  const action = async (kind: "resume" | "cancel") => {
    setBusy(kind);
    setActionError("");
    try {
      if (kind === "cancel" && !window.confirm("Cancel this running workflow? Completed activity remains in the audit log.")) {
        setBusy("");
        return;
      }
      await api("/api/tasks/" + run.id + "/" + kind, { method: "POST" });
      await refresh();
      notify(kind === "cancel" ? "Run canceled." : "Run resumed.");
    } catch (error) {
      setActionError(errorMessage(error));
    } finally {
      setBusy("");
    }
  };

  return (
    <div className="run-detail-page">
      <header className="run-detail-header">
        <button className="icon-button" aria-label="Back to runs" onClick={() => navigate("/runs")}><ArrowLeft /></button>
        <div className="run-title"><div><span>#{shortId(run.id)}</span><RunStatusBadge status={run.status} /></div><h1>{run.task}</h1><p>Started {formatDate(run.createdAt)} · {formatDuration(run.createdAt, run.updatedAt)} · iteration {run.iteration}/{run.maxIterations}</p></div>
        <div className="run-header-actions">
          <Link className="button secondary" to={"/runs?duplicate=" + run.id}><Copy />Duplicate</Link>
          {eligibility.canResume && <button className="button secondary" disabled={Boolean(busy)} onClick={() => void action("resume")}><RotateCcw />{busy === "resume" ? "Resuming…" : run.status === "waiting_approval" ? "Resume after decision" : "Retry"}</button>}
          {eligibility.canCancel && <button className="button danger-quiet" disabled={Boolean(busy)} onClick={() => void action("cancel")}><Square />{busy === "cancel" ? "Canceling…" : "Cancel"}</button>}
          <button className="icon-button" aria-label="More run actions"><MoreHorizontal /></button>
        </div>
      </header>

      {actionError && <InlineAlert title="Run action failed">{actionError}</InlineAlert>}
      {run.status === "waiting_approval" && <InlineAlert tone="warning" title="Operator decision required"><Link className="text-link" to="/approvals">Review the pending approval before resuming this run.</Link></InlineAlert>}

      <div className="mode-switcher" aria-label="Workspace mode">
        {(["focus", "studio", "orchestrate"] as RunMode[]).map((item) => <button className={mode === item ? "active" : ""} aria-pressed={mode === item} onClick={() => { setMode(item); localStorage.setItem("nexusharness.runMode", item); }} key={item}>{item}</button>)}
      </div>

      <PhaseRail run={run} />

      {mode === "focus" && <div className="run-workspace mode-focus">
        <section className="timeline-panel">
          <div className="panel-heading"><div><p className="eyebrow">Live narrative</p><h2>Run timeline</h2></div><span className="live-indicator"><span />{run.status === "running" ? "Live" : "Saved"}</span></div>
          <div className="timeline">
            <TimelineItem icon={<Bot />} actor="Operator" title="Task received" time={formatDate(run.createdAt)}><p>{run.task}</p></TimelineItem>
            {run.plan && <TimelineItem icon={<Clipboard />} actor="Planner" title={"Plan · " + run.plan.length + " steps"} time="Phase output"><ol>{run.plan.map((item, index) => <li key={index}>{displayRunValue(item)}</li>)}</ol></TimelineItem>}
            {run.subtaskResults?.map((item, index) => <TimelineItem icon={<Code2 />} actor={"Executor " + (index + 1)} title={displayRunValue(item.subtask)} time="Subtask"><pre>{displayRunValue(item.output)}</pre></TimelineItem>)}
            {run.criticFeedback && <TimelineItem icon={<BrainCircuit />} actor="Critic" title={"Review" + (run.criticScore !== undefined ? " · " + run.criticScore + "/10" : "")} time="Assessment"><p>{run.criticFeedback}</p></TimelineItem>}
            {run.validationOutput && <TimelineItem icon={<FlaskConical />} actor="Validator" title="Validation output" time="Checks"><pre>{run.validationOutput}</pre></TimelineItem>}
            {run.result && <TimelineItem icon={<Check />} actor="System" title="Final result" time={formatDate(run.updatedAt)}><p>{run.result}</p></TimelineItem>}
            {run.error && <TimelineItem icon={<X />} actor="System" title="Run stopped" time={formatDate(run.updatedAt)} tone="danger"><p>{run.error}</p></TimelineItem>}
            {events.length > 0 && <TimelineItem icon={<Code2 />} actor="Audit" title={events.length + " linked events"} time="Activity"><p>Open the inspector to review detailed tool and system events.</p></TimelineItem>}
          </div>
        </section>

        <aside className="run-inspector">
          <div className="inspector-tabs" role="tablist" aria-label="Run inspector" onKeyDown={handleTabListKeyDown}>
            <button role="tab" tabIndex={inspector === "overview" ? 0 : -1} aria-selected={inspector === "overview"} className={inspector === "overview" ? "active" : ""} onClick={() => setInspector("overview")}>Overview</button>
            <button role="tab" tabIndex={inspector === "outputs" ? 0 : -1} aria-selected={inspector === "outputs"} className={inspector === "outputs" ? "active" : ""} onClick={() => setInspector("outputs")}>Outputs</button>
            <button role="tab" tabIndex={inspector === "activity" ? 0 : -1} aria-selected={inspector === "activity"} className={inspector === "activity" ? "active" : ""} onClick={() => setInspector("activity")}>Activity</button>
          </div>
          {inspector === "overview" && <><dl className="inspector-stats">
            <div><dt>Status</dt><dd><RunStatusBadge status={run.status} /></dd></div>
            <div><dt>Current phase</dt><dd>{run.phase}</dd></div>
            <div><dt>Iteration</dt><dd>{run.iteration} / {run.maxIterations}</dd></div>
            <div><dt>Critic score</dt><dd>{run.criticScore !== undefined ? run.criticScore + " / 10" : "Not scored"}</dd></div>
            <div><dt>Plan steps</dt><dd>{run.plan?.length ?? 0}</dd></div>
            <div><dt>Subtasks</dt><dd>{run.subtaskResults?.length ?? 0}</dd></div>
          </dl>
          <div className="inspector-section"><p className="eyebrow">Agent assignments</p>{["planner", "executor", "critic"].map((role) => <div className="agent-mini" key={role}><span><Bot /></span><div><strong>{role}</strong><small>{store.settings.agentModels[role] ?? "Unassigned"}</small></div></div>)}</div>
          </>}
          {inspector === "outputs" && <div className="inspector-scroll">
            <InspectorOutput label="Executor" value={run.executorOutput} />
            <InspectorOutput label="Critic" value={run.criticFeedback} />
            <InspectorOutput label="Validation" value={run.validationOutput} />
            <InspectorOutput label="Result" value={run.result} />
            <InspectorOutput label="Error" value={run.error} />
            {!run.executorOutput && !run.criticFeedback && !run.validationOutput && !run.result && !run.error && <p className="inspector-empty">No terminal outputs were saved for this run.</p>}
          </div>}
          {inspector === "activity" && <div className="inspector-scroll">
            {events.map((event) => <details className="inspector-event" key={event.id}><summary><span>{event.actor}</span><strong>{event.action}</strong><small>{formatDate(event.at)}</small></summary>{event.details !== undefined && <pre>{typeof event.details === "string" ? event.details : JSON.stringify(event.details, null, 2)}</pre>}</details>)}
            {!events.length && <p className="inspector-empty">No audit events could be linked to this legacy run.</p>}
          </div>}
          <button className="button secondary full-width" onClick={async () => {
            try {
              await navigator.clipboard.writeText(runSummary(run));
              notify("Run summary copied.");
            } catch {
              setActionError("The browser did not allow clipboard access.");
            }
          }}><Clipboard />Copy summary</button>
        </aside>
      </div>}
      {mode === "studio" && <StudioMode run={run} store={store} />}
      {mode === "orchestrate" && <OrchestrateMode run={run} store={store} />}
    </div>
  );
}

function PhaseRail({ run }: { run: TaskRun }) {
  return (
    <ol className="phase-rail" aria-label="Run phases">
      {phases.map((phase, index) => {
        const state = phaseState(run, phase.id);
        const Icon = phase.icon;
        return <li className={"phase-" + state} key={phase.id}><span className="phase-node">{state === "complete" ? <Check /> : state === "pending" ? <Circle /> : <Icon />}</span><div><strong>{phase.label}</strong><small>{state}</small></div>{index < phases.length - 1 && <i />}</li>;
      })}
    </ol>
  );
}

function TimelineItem({ icon, actor, title, time, tone = "default", children }: { icon: React.ReactNode; actor: string; title: string; time: string; tone?: string; children: React.ReactNode }) {
  return <article className={"timeline-item tone-" + tone}><span className="timeline-icon">{icon}</span><div className="timeline-body"><header><div><small>{actor}</small><h3>{title}</h3></div><time>{time}</time></header><div className="timeline-content">{children}</div></div></article>;
}

function InspectorOutput({ label, value }: { label: string; value?: string }) {
  if (!value) return null;
  return <section className="inspector-output"><p className="eyebrow">{label}</p><pre>{value}</pre></section>;
}

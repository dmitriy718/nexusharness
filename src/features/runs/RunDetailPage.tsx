import React, { useMemo, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import {
  ArrowLeft,
  Bot,
  BrainCircuit,
  Check,
  Circle,
  Clipboard,
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
import { EmptyState, InlineAlert, RunStatusBadge, formatDate, formatDuration, shortId } from "../../components/ui";

const phases: Array<{ id: RunPhase; label: string; icon: React.ComponentType<{ className?: string }> }> = [
  { id: "plan", label: "Plan", icon: Clipboard },
  { id: "execute", label: "Execute", icon: Code2 },
  { id: "critic", label: "Critique", icon: BrainCircuit },
  { id: "test", label: "Validate", icon: FlaskConical },
  { id: "retrospective", label: "Reflect", icon: GitPullRequestArrow },
  { id: "done", label: "Done", icon: Check }
];

export function RunDetailPage() {
  const { runId } = useParams();
  const { store, refresh, notify } = useHarness();
  const navigate = useNavigate();
  const [busy, setBusy] = useState("");
  const [actionError, setActionError] = useState("");
  const [mode, setMode] = useState<"focus" | "studio" | "orchestrate">("focus");
  const run = store?.runs.find((item) => item.id === runId);

  const events = useMemo(() => store?.audit.filter((event) => {
    const details = JSON.stringify(event.details ?? "");
    return details.includes(runId ?? "") || event.message.includes(runId ?? "");
  }).slice(0, 30) ?? [], [runId, store?.audit]);

  if (!store) return null;
  if (!run) return <div className="page"><EmptyState title="Run not found" detail="This run may have been removed from local history." action={<Link className="button secondary" to="/runs">Back to runs</Link>} /></div>;

  const action = async (kind: "resume" | "cancel") => {
    setBusy(kind);
    setActionError("");
    try {
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
          {["failed", "canceled", "waiting_approval"].includes(run.status) && <button className="button secondary" disabled={Boolean(busy)} onClick={() => void action("resume")}><RotateCcw />{busy === "resume" ? "Resuming…" : "Resume"}</button>}
          {run.status === "running" && <button className="button danger-quiet" disabled={Boolean(busy)} onClick={() => void action("cancel")}><Square />{busy === "cancel" ? "Canceling…" : "Cancel"}</button>}
          <button className="icon-button" aria-label="More run actions"><MoreHorizontal /></button>
        </div>
      </header>

      {actionError && <InlineAlert title="Run action failed">{actionError}</InlineAlert>}

      <div className="mode-switcher" aria-label="Workspace mode">
        <button className={mode === "focus" ? "active" : ""} onClick={() => setMode("focus")}>Focus</button>
        <button className={mode === "studio" ? "active" : ""} onClick={() => setMode("studio")}>Studio <span>Preview</span></button>
        <button className={mode === "orchestrate" ? "active" : ""} onClick={() => setMode("orchestrate")}>Orchestrate <span>Preview</span></button>
      </div>

      <PhaseRail run={run} />

      <div className={"run-workspace mode-" + mode}>
        <section className="timeline-panel">
          <div className="panel-heading"><div><p className="eyebrow">Live narrative</p><h2>Run timeline</h2></div><span className="live-indicator"><span />{run.status === "running" ? "Live" : "Saved"}</span></div>
          <div className="timeline">
            <TimelineItem icon={<Bot />} actor="Operator" title="Task received" time={formatDate(run.createdAt)}><p>{run.task}</p></TimelineItem>
            {run.plan && <TimelineItem icon={<Clipboard />} actor="Planner" title={"Plan · " + run.plan.length + " steps"} time="Phase output"><ol>{run.plan.map((item, index) => <li key={index}>{displayValue(item)}</li>)}</ol></TimelineItem>}
            {run.subtaskResults?.map((item, index) => <TimelineItem icon={<Code2 />} actor={"Executor " + (index + 1)} title={displayValue(item.subtask)} time="Subtask"><pre>{displayValue(item.output)}</pre></TimelineItem>)}
            {run.criticFeedback && <TimelineItem icon={<BrainCircuit />} actor="Critic" title={"Review" + (run.criticScore !== undefined ? " · " + run.criticScore + "/10" : "")} time="Assessment"><p>{run.criticFeedback}</p></TimelineItem>}
            {run.validationOutput && <TimelineItem icon={<FlaskConical />} actor="Validator" title="Validation output" time="Checks"><pre>{run.validationOutput}</pre></TimelineItem>}
            {run.result && <TimelineItem icon={<Check />} actor="System" title="Final result" time={formatDate(run.updatedAt)}><p>{run.result}</p></TimelineItem>}
            {run.error && <TimelineItem icon={<X />} actor="System" title="Run stopped" time={formatDate(run.updatedAt)} tone="danger"><p>{run.error}</p></TimelineItem>}
            {events.length > 0 && <TimelineItem icon={<Code2 />} actor="Audit" title={events.length + " linked events"} time="Activity"><p>Open the inspector to review detailed tool and system events.</p></TimelineItem>}
          </div>
        </section>

        <aside className="run-inspector">
          <div className="inspector-tabs"><button className="active">Overview</button><button>Files</button><button>Raw log</button></div>
          <dl className="inspector-stats">
            <div><dt>Status</dt><dd><RunStatusBadge status={run.status} /></dd></div>
            <div><dt>Current phase</dt><dd>{run.phase}</dd></div>
            <div><dt>Iteration</dt><dd>{run.iteration} / {run.maxIterations}</dd></div>
            <div><dt>Critic score</dt><dd>{run.criticScore !== undefined ? run.criticScore + " / 10" : "Not scored"}</dd></div>
            <div><dt>Plan steps</dt><dd>{run.plan?.length ?? 0}</dd></div>
            <div><dt>Subtasks</dt><dd>{run.subtaskResults?.length ?? 0}</dd></div>
          </dl>
          <div className="inspector-section"><p className="eyebrow">Agent assignments</p>{["planner", "executor", "critic"].map((role) => <div className="agent-mini" key={role}><span><Bot /></span><div><strong>{role}</strong><small>{store.settings.agentModels[role] ?? "Unassigned"}</small></div></div>)}</div>
          <button className="button secondary full-width" onClick={() => void navigator.clipboard?.writeText(run.result || run.error || run.task)}><Clipboard />Copy summary</button>
        </aside>
      </div>
    </div>
  );
}

function PhaseRail({ run }: { run: TaskRun }) {
  const current = phases.findIndex((phase) => phase.id === run.phase);
  return (
    <ol className="phase-rail" aria-label="Run phases">
      {phases.map((phase, index) => {
        const state = index < current ? "complete" : index === current ? run.status === "failed" ? "failed" : run.status === "canceled" ? "canceled" : run.status === "waiting_approval" ? "waiting" : "active" : "pending";
        const Icon = phase.icon;
        return <li className={"phase-" + state} key={phase.id}><span className="phase-node">{state === "complete" ? <Check /> : state === "pending" ? <Circle /> : <Icon />}</span><div><strong>{phase.label}</strong><small>{state}</small></div>{index < phases.length - 1 && <i />}</li>;
      })}
    </ol>
  );
}

function TimelineItem({ icon, actor, title, time, tone = "default", children }: { icon: React.ReactNode; actor: string; title: string; time: string; tone?: string; children: React.ReactNode }) {
  return <article className={"timeline-item tone-" + tone}><span className="timeline-icon">{icon}</span><div className="timeline-body"><header><div><small>{actor}</small><h3>{title}</h3></div><time>{time}</time></header><div className="timeline-content">{children}</div></div></article>;
}

function displayValue(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === null || value === undefined) return "";
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    for (const key of ["title", "task", "description", "name", "content", "output"]) {
      if (typeof record[key] === "string" && record[key]) return record[key];
    }
    try {
      return JSON.stringify(value, null, 2);
    } catch {
      return "Unrecognized legacy output";
    }
  }
  return String(value);
}

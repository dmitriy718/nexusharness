import React from "react";
import { AlertTriangle, Box, Check, Circle, Clock3, GitCommit, Network, RotateCcw, ShieldAlert, ShieldCheck, X } from "lucide-react";
import type { ExecutionCellState, RunExecutionSummary } from "../../api/types";
import { InlineAlert, StatusBadge, formatDate } from "../../components/ui";

const lifecycle: Array<{ id: ExecutionCellState; label: string }> = [
  { id: "preparing", label: "Preparing" },
  { id: "isolated", label: "Isolated" },
  { id: "executing", label: "Executing" },
  { id: "verifying", label: "Verifying" },
  { id: "ready_to_commit", label: "Ready" },
  { id: "committed", label: "Committed" }
];

export function ExecutionInspector({ summary, busy, onCommit, onRollback }: {
  summary: RunExecutionSummary;
  busy?: "commit" | "rollback" | "";
  onCommit?: () => void;
  onRollback?: () => void;
}) {
  const commitEnabled = summary.commit.available && Boolean(onCommit) && !busy;
  const rollbackEnabled = summary.rollback.available && Boolean(onRollback) && !busy;
  const commitReason = summary.commit.available && !onCommit ? "Commit action is not connected to the backend yet." : summary.commit.reason;
  const rollbackReason = summary.rollback.available && !onRollback ? "Rollback action is not connected to the backend yet." : summary.rollback.reason;
  const capabilityGroups = Object.entries(summary.capabilities).filter(([, values]) => values.length);
  return <section className="execution-inspector" aria-labelledby="execution-inspector-title">
    <header className="execution-inspector-header">
      <span className="execution-symbol"><Box /></span>
      <div><p className="eyebrow">Transaction execution</p><h2 id="execution-inspector-title">Execution cell</h2><p>Inspect the bounded environment, evidence, and promotion state for this run.</p></div>
      <StatusBadge status={summary.state} />
    </header>

    {!summary.securityBoundary && <InlineAlert tone="warning" title="Transaction isolation only"><p>{summary.boundaryDescription}</p></InlineAlert>}
    {summary.securityBoundary && <InlineAlert tone="info" title="Hardened provider reported"><p>{summary.boundaryDescription}</p></InlineAlert>}

    <ol className="execution-lifecycle" aria-label="Execution cell lifecycle">
      {lifecycle.map((step) => {
        const state = lifecycleState(summary.state, step.id);
        return <li className={`execution-step execution-step-${state}`} aria-current={state === "current" ? "step" : undefined} key={step.id}>
          <span>{state === "complete" ? <Check /> : state === "current" ? <Clock3 /> : <Circle />}</span><strong>{step.label}</strong><small>{state}</small>
        </li>;
      })}
    </ol>

    {terminalMessage(summary.state)}

    <div className="execution-facts">
      <div><small>Provider</small><strong>{providerLabel(summary.provider)}</strong><span>{summary.securityBoundary ? <><ShieldCheck />Security boundary</> : <><ShieldAlert />Transaction boundary</>}</span></div>
      <div><small>Base revision</small><code title={summary.baseRevision}>{summary.baseRevision.slice(0, 12)}</code><span>Compare-and-swap protected</span></div>
      <div><small>Network</small><strong><Network />Denied by default</strong><span>{summary.capabilities.network.length ? `${summary.capabilities.network.length} allowlisted origin${summary.capabilities.network.length === 1 ? "" : "s"}` : "No network lease"}</span></div>
      <div><small>Updated</small><strong>{formatDate(summary.updatedAt)}</strong><span>Cell #{summary.cellId.slice(0, 12)}</span></div>
    </div>

    <div className="execution-detail-grid">
      <section aria-labelledby="execution-capabilities-title"><header><div><p className="eyebrow">Authority</p><h3 id="execution-capabilities-title">Capability envelope</h3></div><span>{capabilityGroups.reduce((total, [, values]) => total + values.length, 0)} grants</span></header>
        {capabilityGroups.length ? <div className="capability-groups">{capabilityGroups.map(([kind, values]) => <div key={kind}><strong>{kind}</strong><ul>{values.map((value) => <li key={value}><code>{value}</code></li>)}</ul></div>)}</div> : <p className="execution-empty">No capabilities were granted.</p>}
      </section>
      <section aria-labelledby="execution-budget-title"><header><div><p className="eyebrow">Limits</p><h3 id="execution-budget-title">Resource budget</h3></div></header>
        <dl className="execution-budget"><div><dt>Wall time</dt><dd>{duration(summary.budget.wallTimeMs)}</dd></div><div><dt>CPU time</dt><dd>{duration(summary.budget.cpuTimeMs)}</dd></div><div><dt>Memory</dt><dd>{bytes(summary.budget.memoryBytes)}</dd></div><div><dt>Disk</dt><dd>{bytes(summary.budget.diskBytes)}</dd></div><div><dt>Processes</dt><dd>{summary.budget.processCount}</dd></div><div><dt>Output</dt><dd>{bytes(summary.budget.outputBytes)}</dd></div></dl>
      </section>
    </div>

    <div className="execution-detail-grid">
      <section aria-labelledby="execution-effects-title"><header><div><p className="eyebrow">Observed state</p><h3 id="execution-effects-title">File effects</h3></div><span>{summary.effects.length}</span></header>
        {summary.effects.length ? <ul className="execution-record-list">{summary.effects.map((effect, index) => <li key={`${effect.kind}:${effect.target}:${index}`}><span className={`effect-mark effect-${effect.status}`}><Box /></span><div><strong>{effect.kind.replace("file.", "")}</strong><code>{effect.target}</code></div><StatusBadge status={effect.status} /></li>)}</ul> : <p className="execution-empty">No file effects have been observed.</p>}
      </section>
      <section aria-labelledby="execution-evidence-title"><header><div><p className="eyebrow">Proof</p><h3 id="execution-evidence-title">Verification evidence</h3></div><span>{summary.evidence.length}</span></header>
        {summary.evidence.length ? <ul className="execution-record-list">{summary.evidence.map((item, index) => <li key={`${item.kind}:${item.name}:${index}`}><span className={`evidence-mark evidence-${item.status}`}>{item.status === "passed" ? <Check /> : item.status === "failed" ? <X /> : <AlertTriangle />}</span><div><strong>{item.name}</strong><small>{item.kind}{item.detail ? ` · ${item.detail}` : ""}</small></div><StatusBadge status={item.status} /></li>)}</ul> : <p className="execution-empty">No verification evidence has been attached.</p>}
      </section>
    </div>

    {summary.variances.length > 0 && <section className="execution-variance" aria-labelledby="execution-variance-title"><header><div><p className="eyebrow">Predicted versus observed</p><h3 id="execution-variance-title">Effect variance</h3></div><span>{summary.variances.filter((item) => item.severity === "blocking").length} blocking</span></header>{summary.variances.map((variance, index) => <InlineAlert tone={variance.severity === "blocking" ? "danger" : "warning"} title={`${variance.kind} · ${variance.effectTarget}`} key={`${variance.effectTarget}:${index}`}><p>{variance.detail}</p></InlineAlert>)}</section>}

    <footer className="execution-actions">
      <div><strong>Promotion is evidence-gated</strong><small>{commitReason}</small></div>
      <button className="button danger-quiet" disabled={!rollbackEnabled} title={!rollbackEnabled ? rollbackReason : undefined} onClick={onRollback}><RotateCcw />{busy === "rollback" ? "Rolling back…" : "Roll back"}</button>
      <button className="button primary" disabled={!commitEnabled} title={!commitEnabled ? commitReason : undefined} onClick={onCommit}><GitCommit />{busy === "commit" ? "Committing…" : "Commit result"}</button>
    </footer>
  </section>;
}

function lifecycleState(current: ExecutionCellState, step: ExecutionCellState) {
  if (["failed", "rolled_back", "destroyed"].includes(current)) return "pending";
  const currentIndex = lifecycle.findIndex((item) => item.id === current);
  const stepIndex = lifecycle.findIndex((item) => item.id === step);
  if (stepIndex < currentIndex) return "complete";
  if (stepIndex === currentIndex) return "current";
  return "pending";
}

function terminalMessage(state: ExecutionCellState) {
  if (state === "failed") return <InlineAlert tone="danger" title="Execution cell failed"><p>The cell is retained for evidence and must be rolled back or destroyed before reuse.</p></InlineAlert>;
  if (state === "rolled_back") return <InlineAlert tone="info" title="Cell rolled back"><p>The disposable transaction was not promoted to the primary workspace.</p></InlineAlert>;
  if (state === "destroyed") return <InlineAlert tone="info" title="Cell destroyed"><p>Only its persisted receipts and audit evidence remain.</p></InlineAlert>;
  return null;
}

function providerLabel(provider: RunExecutionSummary["provider"]) {
  if (provider === "portable-worktree") return "Portable Git worktree";
  if (provider === "windows-sandbox") return "Windows Sandbox";
  if (provider === "firecracker") return "Firecracker microVM";
  return "Remote operator-owned worker";
}

function duration(milliseconds: number) {
  if (milliseconds < 1000) return `${milliseconds} ms`;
  if (milliseconds < 60_000) return `${Math.round(milliseconds / 100) / 10} sec`;
  return `${Math.round(milliseconds / 6000) / 10} min`;
}

function bytes(value: number) {
  if (value < 1024) return `${value} B`;
  if (value < 1024 ** 2) return `${Math.round(value / 1024)} KiB`;
  if (value < 1024 ** 3) return `${Math.round(value / 1024 ** 2)} MiB`;
  return `${Math.round(value / 1024 ** 3 * 10) / 10} GiB`;
}

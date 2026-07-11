import React, { useState } from "react";
import { Link } from "react-router-dom";
import {
  AlertTriangle,
  Bot,
  Check,
  CheckCircle2,
  ChevronRight,
  Code2,
  FileCode2,
  Filter,
  Search,
  ShieldAlert,
  ShieldCheck,
  Terminal,
  X
} from "lucide-react";
import { api, errorMessage } from "../../api/client";
import type { Approval, AuditEvent } from "../../api/types";
import { useHarness } from "../../app/StoreProvider";
import { EmptyState, InlineAlert, PageHeader, StatusBadge, formatDate, shortId } from "../../components/ui";
import {
  approvalCommand,
  approvalDiff,
  approvalPayload,
  approvalTarget,
  humanApprovalAction,
  parseDiff,
  redactPayload
} from "./approvalModel";

export function ApprovalsPage() {
  const { store, refresh, notify } = useHarness();
  const pending = store?.approvals.filter((item) => item.decision === "pending") ?? [];
  const history = store?.approvals.filter((item) => item.decision !== "pending") ?? [];
  const [selectedId, setSelectedId] = useState("");
  const [busy, setBusy] = useState("");
  const [actionError, setActionError] = useState("");
  const selected = pending.find((item) => item.id === selectedId) ?? pending[0];
  if (!store) return null;

  const decide = async (decision: "approved" | "rejected") => {
    if (!selected || busy) return;
    setBusy(decision);
    setActionError("");
    try {
      await api("/api/approvals/" + selected.id + "/" + decision, { method: "POST" });
      await refresh();
      notify(decision === "approved" ? "Action approved once." : "Action rejected.", decision === "approved" ? "success" : "info");
      setSelectedId("");
    } catch (error) {
      setActionError(errorMessage(error));
    } finally {
      setBusy("");
    }
  };

  return (
    <div className="page approvals-page">
      <PageHeader eyebrow="Safety gate" title="Approvals" detail="Review exactly what a local agent wants to do before it touches your machine." />
      <div className="approval-summary">
        <div><span className="summary-icon attention"><ShieldAlert /></span><strong>{pending.length}</strong><p>waiting for review</p></div>
        <div><span className="summary-icon safe"><ShieldCheck /></span><strong>{history.filter((item) => item.decision === "approved").length}</strong><p>approved previously</p></div>
        <div><span className="summary-icon neutral"><X /></span><strong>{history.filter((item) => item.decision === "rejected").length}</strong><p>rejected previously</p></div>
      </div>

      {pending.length ? (
        <div className="approval-workspace">
          <section className="approval-queue" aria-label="Pending approval queue">
            <div className="queue-heading"><div><p className="eyebrow">Attention queue</p><h2>Pending</h2></div><span>{pending.length}</span></div>
            {pending.map((approval) => (
              <button key={approval.id} className={"approval-queue-item" + (approval.id === selected?.id ? " active" : "")} onClick={() => setSelectedId(approval.id)}>
                <span className={"risk-symbol risk-" + approval.risk}>{approvalIcon(approval)}</span>
                <span><strong>{humanApprovalAction(approval.action)}</strong><small>{approval.subtask || approval.actor} · {formatDate(approval.createdAt)}</small><em>{approval.risk} risk{approval.runId ? " · run #" + shortId(approval.runId) : ""}</em></span>
                <ChevronRight />
              </button>
            ))}
          </section>
          {selected && (
            <section className="approval-review">
              <header className="review-header">
                <div className={"risk-symbol large risk-" + selected.risk}>{approvalIcon(selected)}</div>
                <div><p className="eyebrow">{selected.risk} risk · approval #{shortId(selected.id)}</p><h2>{humanApprovalAction(selected.action)}</h2><p>Requested by {selected.actor} at {formatDate(selected.createdAt)}</p></div>
              </header>
              {(selected.runId || selected.subtask) && <div className="approval-origin"><Bot /><div><small>Origin</small><strong>{selected.subtask || "Executor workflow"}</strong>{selected.runId && <Link to={"/runs/" + selected.runId}>Open run #{shortId(selected.runId)} <ChevronRight /></Link>}</div></div>}
              {actionError && <InlineAlert title="Decision could not be saved">{actionError}</InlineAlert>}
              <InlineAlert tone={selected.risk === "read" ? "info" : "warning"} title={riskTitle(selected.risk)}>
                {riskDescription(selected.risk)}
              </InlineAlert>
              <PayloadPreview approval={selected} />
              <div className="decision-note"><ShieldCheck /><p><strong>This decision applies once.</strong> The same action must request a new approval if an agent tries it again.</p></div>
              <div className="decision-bar">
                <button className="button reject" disabled={Boolean(busy)} onClick={() => void decide("rejected")}><X />{busy === "rejected" ? "Rejecting…" : "Reject"}</button>
                <span>Review the target and payload before deciding.</span>
                <button className="button approve" disabled={Boolean(busy)} onClick={() => void decide("approved")}><Check />{busy === "approved" ? "Approving…" : "Approve once"}</button>
              </div>
            </section>
          )}
        </div>
      ) : <EmptyState icon={<CheckCircle2 />} title="The approval queue is clear" detail="When an agent requests a write, delete, shell command, or other gated action, it will pause here with review context." />}

      <section className="section-block approval-history">
        <div className="section-heading"><div><p className="eyebrow">Decision record</p><h2>Recent history</h2></div></div>
        {history.slice(0, 12).map((approval) => <div className="history-row" key={approval.id}><span className={"decision-mark " + approval.decision}>{approval.decision === "approved" ? <Check /> : <X />}</span><span><strong>{humanApprovalAction(approval.action)}</strong><small>{approval.subtask || approval.actor} · {formatDate(approval.decidedAt ?? approval.createdAt)}</small></span><StatusBadge status={approval.decision} /></div>)}
        {!history.length && <p className="muted-copy">No completed approval decisions yet.</p>}
      </section>
    </div>
  );
}

function PayloadPreview({ approval }: { approval: Approval }) {
  const [tab, setTab] = useState<"review" | "raw">("review");
  const payload = approvalPayload(approval);
  const command = approvalCommand(approval);
  const target = approvalTarget(approval);
  const diff = approvalDiff(approval);
  const redacted = redactPayload(approval.payload);
  return (
    <div className="payload-preview">
      <div className="preview-tabs" role="tablist" aria-label="Approval payload view"><button role="tab" aria-selected={tab === "review"} className={tab === "review" ? "active" : ""} onClick={() => setTab("review")}>Review</button><button role="tab" aria-selected={tab === "raw"} className={tab === "raw" ? "active" : ""} onClick={() => setTab("raw")}>Redacted raw</button></div>
      {tab === "review" ? <>
        {target && <div className="payload-section"><span><FileCode2 /></span><div><small>{payload.cwd ? "Working directory" : "Target"}</small><code>{target}</code></div></div>}
        {command && <div className="payload-section command-section"><span><Terminal /></span><div><small>Command · {String(payload.shell ?? "configured shell")}</small><pre>{command}</pre></div></div>}
        {diff && <div className="diff-review"><header><span><FileCode2 /></span><div><small>Proposed change</small><strong>{String(payload.relativePath ?? "Unified diff")}</strong></div><em>{String(payload.previousBytes ?? 0)} → {String(payload.bytes ?? 0)} bytes</em></header><pre>{parseDiff(diff).map((line, index) => <span className={"diff-" + line.kind} key={index}>{line.text || " "}</span>)}</pre></div>}
        {payload.targetType && <div className="delete-review"><AlertTriangle /><div><strong>Delete {String(payload.targetType)}</strong><p>{payload.recursive ? "This removes the directory and its descendants." : "This removes the selected file."}</p></div></div>}
        {!target && !command && !diff && <div className="payload-section command-section"><span><Code2 /></span><div><small>Requested payload</small><pre>{JSON.stringify(redacted, null, 2)}</pre></div></div>}
        {(payload.previousSha256 || payload.nextSha256) && <dl className="hash-review"><div><dt>Previous SHA-256</dt><dd><code>{String(payload.previousSha256 ?? "new file")}</code></dd></div><div><dt>Proposed SHA-256</dt><dd><code>{String(payload.nextSha256)}</code></dd></div></dl>}
      </> : <pre className="raw-payload">{JSON.stringify(redacted, null, 2)}</pre>}
    </div>
  );
}

export function AuditPage() {
  const { store } = useHarness();
  const [query, setQuery] = useState("");
  const [risk, setRisk] = useState("all");
  if (!store) return null;
  const events = store.audit.filter((event) => {
    const haystack = [event.actor, event.action, event.message, event.status].join(" ").toLowerCase();
    return (!query || haystack.includes(query.toLowerCase())) && (risk === "all" || event.risk === risk);
  });
  return (
    <div className="page audit-page">
      <PageHeader eyebrow="Local event ledger" title="Audit" detail="Reconstruct agent, tool, approval, and system activity without leaving your machine." />
      <section className="section-block">
        <div className="section-heading responsive-heading">
          <div><p className="eyebrow">Events</p><h2>{events.length} visible</h2></div>
          <div className="filter-row">
            <label className="search-control"><Search /><span className="sr-only">Search audit</span><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search activity" /></label>
            <label className="select-control"><Filter /><span className="sr-only">Risk</span><select value={risk} onChange={(event) => setRisk(event.target.value)}><option value="all">All risks</option><option value="read">Read</option><option value="write">Write</option><option value="execute">Execute</option><option value="network">Network</option></select></label>
          </div>
        </div>
        <div className="audit-table" role="table" aria-label="Audit events">
          <div className="audit-head" role="row"><span>Time</span><span>Actor</span><span>Action</span><span>Risk</span><span>Status</span><span>Message</span></div>
          {events.map((event) => <AuditRow event={event} key={event.id} />)}
        </div>
        {!events.length && <EmptyState title="No matching events" detail="Adjust the search or risk filter." />}
      </section>
    </div>
  );
}

function AuditRow({ event }: { event: AuditEvent }) {
  return (
    <details className="audit-row">
      <summary><time>{formatDate(event.at)}</time><span>{event.actor}</span><strong>{event.action}</strong><span><StatusBadge status={event.risk} /></span><span><StatusBadge status={event.status} /></span><span>{event.message}</span></summary>
      {event.details !== undefined && <pre>{typeof event.details === "string" ? event.details : JSON.stringify(event.details, null, 2)}</pre>}
    </details>
  );
}

function approvalIcon(approval: Approval) {
  return approval.action.includes("shell") ? <Terminal /> : approval.action.includes("file") ? <FileCode2 /> : <ShieldAlert />;
}

function riskTitle(risk: string) {
  if (risk === "execute") return "This will execute a local command";
  if (risk === "write") return "This will change local data";
  if (risk === "network") return "This will contact a configured endpoint";
  return "This action reads local data";
}

function riskDescription(risk: string) {
  if (risk === "execute") return "Commands run with your current operating-system permissions inside the configured workspace.";
  if (risk === "write") return "Review the target and proposed content carefully before allowing the change.";
  if (risk === "network") return "Confirm the destination belongs to a runtime or MCP server you trust.";
  return "Confirm the requested scope is necessary for the task.";
}

import React, { useEffect, useState } from "react";
import { AlertTriangle, ArrowLeft, Bot, Check, ChevronRight, File, FileCode2, Folder, Gauge, LoaderCircle, Paperclip, ShieldCheck, Workflow } from "lucide-react";
import { api, errorMessage } from "../../api/client";
import type { Store, TaskRun, WorkspaceNode, WorkspacePreview } from "../../api/types";
import { EmptyState, InlineAlert, RunStatusBadge, StatusBadge, formatDate } from "../../components/ui";
import { formatBytes, parentWorkspacePath, previewLines, runDraftForPath } from "../workspace/workspaceModel";
import { subtaskLanes } from "./runModeModel";

export function StudioMode({ run, store }: { run: TaskRun; store: Store }) {
  const [path, setPath] = useState(".");
  const [entries, setEntries] = useState<WorkspaceNode[]>([]);
  const [selected, setSelected] = useState<WorkspaceNode | null>(null);
  const [preview, setPreview] = useState<WorkspacePreview | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [treeWidth, setTreeWidth] = useState(() => Number(localStorage.getItem("nexusharness.studioTreeWidth") ?? 28));

  useEffect(() => {
    let active = true; setLoading(true); setError("");
    void api<WorkspaceNode[]>(`/api/workspace/entries?path=${encodeURIComponent(path)}`).then((value) => active && setEntries(value)).catch((caught) => active && setError(errorMessage(caught))).finally(() => active && setLoading(false));
    return () => { active = false; };
  }, [path]);

  const choose = async (node: WorkspaceNode) => {
    if (node.type === "directory") { setPath(node.path); setSelected(null); setPreview(null); return; }
    setSelected(node); setPreview(null); setError("");
    if (node.blocked) return;
    try { setPreview(await api<WorkspacePreview>(`/api/workspace/preview?path=${encodeURIComponent(node.path)}`)); }
    catch (caught) { setError(errorMessage(caught)); }
  };

  const attach = () => {
    if (!selected) return;
    sessionStorage.setItem("nexusharness.runDraft", `${run.task}\n\n${runDraftForPath(selected.path)}`);
  };

  const events = store.audit.filter((event) => JSON.stringify(event.details ?? "").includes(run.id) || event.message.includes(run.id)).slice(0, 20);
  return <div className="studio-mode" style={{ "--studio-tree": `${treeWidth}%` } as React.CSSProperties}>
    <section className="studio-tree"><header><div><p className="eyebrow">Workspace context</p><h2>{path === "." ? store.settings.workspaceRoot.split(/[\\/]/).at(-1) : path}</h2></div>{path !== "." && <button className="icon-button" aria-label="Parent directory" onClick={() => setPath(parentWorkspacePath(path))}><ArrowLeft /></button>}</header><label className="studio-resizer"><span>Tree width</span><input type="range" min="20" max="42" value={treeWidth} onChange={(event) => { const value = Number(event.target.value); setTreeWidth(value); localStorage.setItem("nexusharness.studioTreeWidth", String(value)); }} /><output>{treeWidth}%</output></label>{loading ? <div className="preview-loading"><LoaderCircle className="spin" />Loading…</div> : <div className="studio-entry-list">{entries.map((node) => <button className={selected?.path === node.path ? "selected" : ""} key={node.path} onClick={() => void choose(node)}>{node.type === "directory" ? <Folder /> : <File />}<span><strong>{node.name}</strong><small>{node.type === "file" ? formatBytes(node.size) : node.type}</small></span>{node.type === "directory" && <ChevronRight />}</button>)}</div>}</section>
    <section className="studio-canvas">{error && <InlineAlert tone="danger" title="Studio workspace action failed">{error}</InlineAlert>}{preview ? <><header><div><p className="eyebrow">Read-only file canvas</p><h2>{preview.name}</h2><code>{preview.path}</code></div><button className="button secondary" onClick={attach}><Paperclip />Use in duplicate draft</button></header><pre className="studio-code">{preview.binary ? "Binary content is not rendered." : previewLines(preview.content).map((line) => <span key={line.number}><i>{line.number}</i><code>{line.text || " "}</code></span>)}</pre></> : <EmptyState icon={<FileCode2 />} title="Select a workspace file" detail="Browse real workspace entries, inspect bounded content, and attach its path to a duplicate run draft." />}</section>
    <aside className="studio-timeline"><header><p className="eyebrow">Run timeline</p><h2>{run.phase}</h2><RunStatusBadge status={run.status} /></header><ol>{events.map((event) => <li key={event.id}><span /><div><strong>{event.action}</strong><small>{event.actor} · {formatDate(event.at)}</small><p>{event.message}</p></div></li>)}</ol>{!events.length && <p className="inspector-empty">No linked events for this legacy run.</p>}</aside>
  </div>;
}

export function OrchestrateMode({ run, store }: { run: TaskRun; store: Store }) {
  const lanes = subtaskLanes(run);
  const approvals = store.approvals.filter((approval) => approval.runId === run.id);
  const events = store.audit.filter((event) => JSON.stringify(event.details ?? "").includes(run.id) || event.message.includes(run.id));
  return <div className="orchestrate-mode">
    <section className="orchestrate-summary"><article><Gauge /><span><small>Run state</small><strong>{run.status}</strong></span></article><article><Workflow /><span><small>Subtasks</small><strong>{run.subtaskResults?.length ?? 0} / {run.plan?.length ?? 0}</strong></span></article><article><ShieldCheck /><span><small>Approvals</small><strong>{approvals.filter((item) => item.decision === "pending").length} pending</strong></span></article><article><Bot /><span><small>Audit activity</small><strong>{events.length} events</strong></span></article></section>
    <section className="orchestrate-board"><div className="panel-heading"><div><p className="eyebrow">Execution lanes</p><h2>Subtask activity</h2></div><span className="live-indicator"><span />{run.status === "running" ? "Live" : "Saved"}</span></div>{lanes.length ? <div className="subtask-lanes">{lanes.map((lane) => <article className={`lane-${lane.state}`} key={lane.index}><header><span>0{lane.index + 1}</span><StatusBadge status={lane.state} /></header><h3>{lane.title}</h3>{lane.output !== undefined ? <pre>{String(typeof lane.output === "object" ? JSON.stringify(lane.output, null, 2) : lane.output)}</pre> : <p>{lane.state === "active" ? "Executor is working on this lane." : lane.state === "blocked" ? "Run stopped before this lane completed." : "Waiting for an executor slot."}</p>}</article>)}</div> : <EmptyState icon={<Workflow />} title="No subtask lanes" detail="The planner has not saved a structured plan for this run." />}</section>
    <aside className="orchestrate-side"><section><p className="eyebrow">Agent crew</p>{["planner", "executor", "critic"].map((role) => <div className="agent-mini" key={role}><span><Bot /></span><div><strong>{role}</strong><small>{store.settings.agentModels[role] ?? "Unassigned"}</small></div></div>)}</section><section><p className="eyebrow">Approval activity</p>{approvals.map((approval) => <div className="orchestrate-approval" key={approval.id}>{approval.decision === "approved" ? <Check /> : approval.decision === "pending" ? <AlertTriangle /> : <ShieldCheck />}<span><strong>{approval.action}</strong><small>{approval.decision} · {approval.risk}</small></span></div>)}{!approvals.length && <p className="inspector-empty">No approval activity for this run.</p>}</section></aside>
  </div>;
}

import React from "react";
import { Link } from "react-router-dom";
import {
  Activity,
  ArrowRight,
  Bot,
  Check,
  Cpu,
  Play,
  ShieldCheck,
  Sparkles,
  Wrench
} from "lucide-react";
import { useHarness } from "../../app/StoreProvider";
import { EmptyState, PageHeader, RunStatusBadge, formatDate, shortId } from "../../components/ui";

export function DashboardPage() {
  const { store } = useHarness();
  if (!store) return null;

  const active = store.runs.find((run) => run.status === "running" || run.status === "waiting_approval");
  const pending = store.approvals.filter((item) => item.decision === "pending");
  const connected = store.runtimes.length;
  const enabledTools = store.mcpServers.filter((server) => server.enabled).flatMap((server) => server.tools.filter((tool) => tool.enabled)).length;
  const assigned = ["planner", "executor", "critic"].filter((role) => store.settings.agentModels[role]).length;
  const readiness = [
    { label: "Runtime connected", ready: connected > 0, to: "/models" },
    { label: "Agent roles assigned", ready: assigned === 3, to: "/agents" },
    { label: "Workspace selected", ready: Boolean(store.settings.workspaceRoot), to: "/settings" },
    { label: "Safety gate active", ready: store.settings.approvalMode, to: "/settings" }
  ];
  const readyCount = readiness.filter((item) => item.ready).length;

  return (
    <div className="page dashboard-page">
      <PageHeader
        eyebrow="Mission control"
        title="Good evening, operator."
        detail="Your local agents, tools, and workspace—clear at a glance."
        actions={<Link className="button primary glow" to="/runs"><Play />New run</Link>}
      />

      <section className="hero-grid" aria-label="Workspace overview">
        <article className="mission-card">
          <div className="mission-orbit" aria-hidden="true"><span /><span /><span /></div>
          <div className="mission-content">
            <p className="eyebrow">{active ? "Live mission" : "System ready"}</p>
            {active ? (
              <>
                <div className="mission-title-row"><h2>{active.task}</h2><RunStatusBadge status={active.status} /></div>
                <p>Phase <strong>{active.phase}</strong> · iteration {active.iteration} of {active.maxIterations}</p>
                <div className="mission-progress"><span style={{ width: phasePercent(active.phase) + "%" }} /></div>
                <Link className="text-link" to={"/runs/" + active.id}>Open live run <ArrowRight /></Link>
              </>
            ) : (
              <>
                <h2>Everything is quiet.</h2>
                <p>Start a focused run when you are ready. NexusHarness will keep decisions, tool activity, and validation visible.</p>
                <Link className="text-link" to="/runs">Compose a task <ArrowRight /></Link>
              </>
            )}
          </div>
        </article>

        <article className="readiness-card">
          <div className="radial-score" style={{ "--score": readyCount / readiness.length } as React.CSSProperties}>
            <strong>{readyCount}/{readiness.length}</strong><span>ready</span>
          </div>
          <div>
            <p className="eyebrow">Launch readiness</p>
            <h2>{readyCount === readiness.length ? "All systems aligned" : "A few checks remain"}</h2>
            <div className="readiness-list">
              {readiness.map((item) => (
                <Link to={item.to} key={item.label} className={item.ready ? "is-ready" : ""}>
                  <span>{item.ready ? <Check /> : <ArrowRight />}</span>{item.label}
                </Link>
              ))}
            </div>
          </div>
        </article>
      </section>

      <section className="metric-grid" aria-label="System metrics">
        <Metric icon={<Cpu />} label="Runtimes" value={String(connected)} detail={connected ? "configured locally" : "connection needed"} tone="violet" />
        <Metric icon={<Bot />} label="Agent roles" value={assigned + "/3"} detail="planner · executor · critic" tone="cyan" />
        <Metric icon={<Wrench />} label="Enabled tools" value={String(enabledTools)} detail={store.mcpServers.length + " MCP connections"} tone="blue" />
        <Metric icon={<ShieldCheck />} label="Approvals" value={String(pending.length)} detail={pending.length ? "waiting for review" : "inbox is clear"} tone={pending.length ? "amber" : "green"} />
      </section>

      <section className="content-grid">
        <div className="section-block">
          <div className="section-heading"><div><p className="eyebrow">Recent activity</p><h2>Runs</h2></div><Link to="/runs">View all <ArrowRight /></Link></div>
          {store.runs.length ? (
            <div className="run-list compact-list">
              {store.runs.slice(0, 4).map((run) => (
                <Link to={"/runs/" + run.id} key={run.id} className="run-row">
                  <span className="run-icon"><Activity /></span>
                  <span className="run-primary"><strong>{run.task}</strong><small>{formatDate(run.updatedAt)} · #{shortId(run.id)}</small></span>
                  <span className="run-meta">{run.phase} · {run.iteration}/{run.maxIterations}</span>
                  <RunStatusBadge status={run.status} />
                  <ArrowRight className="row-arrow" />
                </Link>
              ))}
            </div>
          ) : <EmptyState icon={<Sparkles />} title="No runs yet" detail="Your first local agent workflow will appear here." action={<Link className="button secondary" to="/runs">Create first run</Link>} />}
        </div>

        <div className="section-block attention-block">
          <div className="section-heading"><div><p className="eyebrow">Attention queue</p><h2>Approvals</h2></div><Link to="/approvals">Review all <ArrowRight /></Link></div>
          {pending.length ? pending.slice(0, 3).map((approval) => (
            <Link className="attention-row" to="/approvals" key={approval.id}>
              <span className={"risk-symbol risk-" + approval.risk}><ShieldCheck /></span>
              <span><strong>{approval.action}</strong><small>{approval.actor} · {formatDate(approval.createdAt)}</small></span>
              <ArrowRight />
            </Link>
          )) : <div className="all-clear"><Check /><div><strong>No decisions waiting</strong><p>Risky actions will pause here for your review.</p></div></div>}
        </div>
      </section>
    </div>
  );
}

function Metric({ icon, label, value, detail, tone }: { icon: React.ReactNode; label: string; value: string; detail: string; tone: string }) {
  return <article className={"metric-card metric-" + tone}><span className="metric-icon">{icon}</span><div><p>{label}</p><strong>{value}</strong><small>{detail}</small></div></article>;
}

function phasePercent(phase: string) {
  const phases = ["plan", "execute", "critic", "test", "retrospective", "done"];
  return ((phases.indexOf(phase) + 1) / phases.length) * 100;
}

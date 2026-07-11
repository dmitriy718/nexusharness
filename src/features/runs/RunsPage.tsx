import React, { useMemo, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { ArrowRight, Clock3, Filter, Play, Search, Sparkles } from "lucide-react";
import { api, errorMessage } from "../../api/client";
import type { TaskRun } from "../../api/types";
import { useHarness } from "../../app/StoreProvider";
import { EmptyState, Field, PageHeader, RunStatusBadge, formatDate, formatDuration, shortId } from "../../components/ui";

export function RunsPage() {
  const { store, refresh, notify } = useHarness();
  const navigate = useNavigate();
  const [task, setTask] = useState("");
  const [starting, setStarting] = useState(false);
  const [localError, setLocalError] = useState("");
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState("all");
  if (!store) return null;

  const runs = useMemo(() => store.runs.filter((run) => {
    const matchesQuery = !query || run.task.toLowerCase().includes(query.toLowerCase()) || run.id.toLowerCase().includes(query.toLowerCase());
    return matchesQuery && (status === "all" || run.status === status);
  }), [query, status, store.runs]);

  const start = async () => {
    if (!task.trim() || starting) return;
    setStarting(true);
    setLocalError("");
    try {
      const run = await api<TaskRun>("/api/tasks", { method: "POST", body: JSON.stringify({ task }) });
      setTask("");
      await refresh();
      notify("Run started.");
      navigate("/runs/" + run.id);
    } catch (error) {
      setLocalError(errorMessage(error));
    } finally {
      setStarting(false);
    }
  };

  return (
    <div className="page runs-page">
      <PageHeader eyebrow="Execution" title="Runs" detail="Plan, execute, critique, and validate local work with every decision visible." />
      <section className="composer-card">
        <div className="composer-head"><span className="pulse-dot" /><div><strong>Start a new mission</strong><p>Planner → Executors → Critic → Validation</p></div></div>
        <Field label="Task" htmlFor="new-task" hint="Describe the outcome, constraints, and how success should be verified.">
          <textarea
            id="new-task"
            value={task}
            onChange={(event) => setTask(event.target.value)}
            onKeyDown={(event) => {
              if ((event.metaKey || event.ctrlKey) && event.key === "Enter") void start();
            }}
            aria-describedby="new-task-hint"
            placeholder="Build a searchable settings view and verify it at mobile and desktop widths..."
          />
        </Field>
        {localError && <p className="field-error" role="alert">{localError}</p>}
        <div className="composer-footer"><span><kbd>Ctrl</kbd><b>+</b><kbd>Enter</kbd> to run</span><button className="button primary glow" disabled={!task.trim() || starting} onClick={() => void start()}><Play />{starting ? "Starting…" : "Start run"}</button></div>
      </section>

      <section className="section-block runs-section">
        <div className="section-heading responsive-heading">
          <div><p className="eyebrow">History</p><h2>{runs.length} runs</h2></div>
          <div className="filter-row">
            <label className="search-control"><Search /><span className="sr-only">Search runs</span><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search runs" /></label>
            <label className="select-control"><Filter /><span className="sr-only">Filter by status</span><select value={status} onChange={(event) => setStatus(event.target.value)}><option value="all">All statuses</option><option value="running">Running</option><option value="waiting_approval">Waiting approval</option><option value="passed">Passed</option><option value="failed">Failed</option><option value="canceled">Canceled</option></select></label>
          </div>
        </div>
        {runs.length ? (
          <div className="run-list">
            {runs.map((run) => <RunRow run={run} key={run.id} />)}
          </div>
        ) : <EmptyState icon={<Sparkles />} title={store.runs.length ? "No matching runs" : "No runs yet"} detail={store.runs.length ? "Try a different search or status filter." : "Describe a task above to begin your first local workflow."} />}
      </section>
    </div>
  );
}

function RunRow({ run }: { run: TaskRun }) {
  return (
    <Link to={"/runs/" + run.id} className="run-row">
      <span className={"run-icon run-" + run.status}><Clock3 /></span>
      <span className="run-primary"><strong>{run.task}</strong><small>{formatDate(run.createdAt)} · #{shortId(run.id)}</small></span>
      <span className="run-meta"><b>{run.phase}</b><small>iteration {run.iteration}/{run.maxIterations}</small></span>
      <span className="run-duration"><b>{formatDuration(run.createdAt, run.updatedAt)}</b><small>duration</small></span>
      <RunStatusBadge status={run.status} />
      <ArrowRight className="row-arrow" />
    </Link>
  );
}

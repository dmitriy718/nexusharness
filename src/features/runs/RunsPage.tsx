import React, { useEffect, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { ArrowRight, Clock3, Filter, Play, Search, Sparkles, X } from "lucide-react";
import { api, errorMessage } from "../../api/client";
import type { RunDetailRecord, RunHistoryPage, TaskRun } from "../../api/types";
import { useHarness } from "../../app/StoreProvider";
import { EmptyState, Field, PageHeader, RunStatusBadge, formatDate, formatDuration, shortId } from "../../components/ui";

const historyPageSize = 100;

export function RunsPage() {
  const { store, refresh, notify } = useHarness();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const [task, setTask] = useState(() => window.sessionStorage.getItem("nexusharness.runDraft") ?? "");
  const [starting, setStarting] = useState(false);
  const [localError, setLocalError] = useState("");
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState("all");
  const [runs, setRuns] = useState<TaskRun[]>(store?.runs ?? []);
  const [totalRuns, setTotalRuns] = useState(store?.runs.length ?? 0);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyError, setHistoryError] = useState("");

  useEffect(() => {
    window.sessionStorage.setItem("nexusharness.runDraft", task);
  }, [task]);

  useEffect(() => {
    const duplicateId = searchParams.get("duplicate");
    if (!duplicateId) return;
    const controller = new AbortController();
    const source = store?.runs.find((run) => run.id === duplicateId);
    if (source) {
      setTask(source.task);
      setSearchParams({}, { replace: true });
      return () => controller.abort();
    }
    void api<RunDetailRecord>(`/api/runs/${encodeURIComponent(duplicateId)}`, { signal: controller.signal }).then((record) => {
      setTask(record.run.task);
      setSearchParams({}, { replace: true });
    }).catch((caught) => { if (!controller.signal.aborted) setLocalError(`Run could not be duplicated: ${errorMessage(caught)}`); });
    return () => controller.abort();
  }, [searchParams, setSearchParams, store?.runs]);

  useEffect(() => {
    const controller = new AbortController();
    const timer = window.setTimeout(async () => {
      setHistoryLoading(true);
      setHistoryError("");
      try {
        const page = await api<RunHistoryPage>(`/api/runs?offset=0&limit=${historyPageSize}&query=${encodeURIComponent(query.trim())}&status=${encodeURIComponent(status)}`, { signal: controller.signal });
        setRuns(page.items);
        setTotalRuns(page.total);
      } catch (caught) {
        if (!controller.signal.aborted) setHistoryError(errorMessage(caught));
      } finally {
        if (!controller.signal.aborted) setHistoryLoading(false);
      }
    }, query.trim() ? 180 : 0);
    return () => { window.clearTimeout(timer); controller.abort(); };
  }, [query, status]);

  if (!store) return null;

  const start = async () => {
    if (!task.trim() || starting) return;
    setStarting(true);
    setLocalError("");
    try {
      const run = await api<TaskRun>("/api/tasks", { method: "POST", body: JSON.stringify({ task }) });
      setTask("");
      window.sessionStorage.removeItem("nexusharness.runDraft");
      await refresh();
      notify("Run started.");
      navigate("/runs/" + run.id);
    } catch (error) {
      setLocalError(errorMessage(error));
    } finally {
      setStarting(false);
    }
  };

  const loadMore = async () => {
    if (historyLoading || runs.length >= totalRuns) return;
    setHistoryLoading(true);
    setHistoryError("");
    try {
      const page = await api<RunHistoryPage>(`/api/runs?offset=${runs.length}&limit=${historyPageSize}&query=${encodeURIComponent(query.trim())}&status=${encodeURIComponent(status)}`);
      setRuns((current) => [...current, ...page.items]);
      setTotalRuns(page.total);
    } catch (caught) {
      setHistoryError(errorMessage(caught));
    } finally {
      setHistoryLoading(false);
    }
  };

  return (
    <div className="page runs-page">
      <PageHeader eyebrow="Execution" title="Runs" detail="Plan, execute, validate, and critique local work with every decision visible." />
      <section className="composer-card">
        <div className="composer-head"><span className="pulse-dot" /><div><strong>Start a new mission</strong><p>Planner → Executors → Validation → Critic</p></div></div>
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
        <div className="composer-footer">
          <span><kbd>Ctrl</kbd><b>+</b><kbd>Enter</kbd> to run · {task.length.toLocaleString()} / 20,000</span>
          <div className="composer-actions">
            {task && <button className="button quiet" onClick={() => setTask("")}><X />Clear draft</button>}
            <button className="button primary glow" disabled={!task.trim() || starting || task.length > 20000} onClick={() => void start()}><Play />{starting ? "Starting…" : "Start run"}</button>
          </div>
        </div>
      </section>

      <section className="section-block runs-section">
        <div className="section-heading responsive-heading">
          <div><p className="eyebrow">History</p><h2>{totalRuns} runs</h2></div>
          <div className="filter-row">
            <label className="search-control"><Search /><span className="sr-only">Search runs</span><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search runs" /></label>
            <label className="select-control"><Filter /><span className="sr-only">Filter by status</span><select value={status} onChange={(event) => setStatus(event.target.value)}><option value="all">All statuses</option><option value="running">Running</option><option value="waiting_approval">Waiting approval</option><option value="passed">Passed</option><option value="failed">Failed</option><option value="canceled">Canceled</option></select></label>
          </div>
        </div>
        {historyError && <p className="field-error" role="alert">Run history could not be loaded: {historyError}</p>}
        {runs.length ? (
          <div className="run-list" aria-busy={historyLoading}>
            {runs.map((run) => <RunRow run={run} key={run.id} />)}
          </div>
        ) : <EmptyState icon={<Sparkles />} title={store.runs.length ? "No matching runs" : "No runs yet"} detail={store.runs.length ? "Try a different search or status filter." : "Describe a task above to begin your first local workflow."} />}
        {runs.length < totalRuns && <div className="run-load-more"><p>Showing {runs.length} of {totalRuns} runs to keep history responsive.</p><button className="button secondary" disabled={historyLoading} onClick={() => void loadMore()}>{historyLoading ? "Loading history…" : `Load ${Math.min(historyPageSize, totalRuns - runs.length)} more`}</button></div>}
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

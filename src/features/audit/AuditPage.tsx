import React, { useCallback, useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { Check, ChevronRight, Clipboard, Download, Filter, RefreshCw, Search, ShieldCheck, X } from "lucide-react";
import { api, errorMessage } from "../../api/client";
import type { AuditEvent } from "../../api/types";
import { useHarness } from "../../app/StoreProvider";
import { EmptyState, InlineAlert, PageHeader, StatusBadge, formatDate, shortId } from "../../components/ui";
import {
  auditRecords,
  exportAuditRecords,
  humanAuditAction,
  redactAuditValue,
  relativeAuditTime,
  type AuditFilters,
  type AuditRecord
} from "./auditModel";

const initialFilters: AuditFilters = { query: "", actor: "all", risk: "all", status: "all", action: "all", sort: "newest" };
const pageSize = 100;

export function AuditPage() {
  const { store, notify } = useHarness();
  const [events, setEvents] = useState<AuditEvent[]>(store?.audit ?? []);
  const [filters, setFilters] = useState(initialFilters);
  const [visibleCount, setVisibleCount] = useState(pageSize);
  const [selectedId, setSelectedId] = useState("");
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [lastUpdated, setLastUpdated] = useState("");

  const load = useCallback(async (quiet = false) => {
    if (!quiet) setLoading(true);
    try {
      const next = await api<AuditEvent[]>("/api/audit");
      setEvents(next);
      setLoadError("");
      setLastUpdated(new Date().toISOString());
    } catch (caught) {
      setLoadError(errorMessage(caught));
    } finally {
      if (!quiet) setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") void load(true);
    }, 10000);
    return () => window.clearInterval(timer);
  }, [load]);

  useEffect(() => setVisibleCount(pageSize), [filters]);

  const records = useMemo(() => auditRecords(events, store?.runs ?? [], filters), [events, filters, store?.runs]);
  const visible = records.slice(0, visibleCount);
  const selected = records.find(({ event }) => event.id === selectedId) ?? null;
  const actions = useMemo(() => [...new Set(events.map((event) => event.action))].sort(), [events]);

  const updateFilter = (key: keyof AuditFilters, value: string) => setFilters((current) => ({ ...current, [key]: value }));

  const downloadExport = () => {
    const blob = new Blob([exportAuditRecords(records)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `nexusharness-audit-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
    anchor.click();
    URL.revokeObjectURL(url);
    notify(`Exported ${records.length} redacted audit event${records.length === 1 ? "" : "s"}.`);
  };

  return (
    <div className="page audit-page">
      <PageHeader
        eyebrow="Local event ledger"
        title="Audit"
        detail="Reconstruct agent, tool, approval, and system activity with a redacted, local-first record."
        actions={<><button className="button secondary" disabled={loading} onClick={() => void load()}><RefreshCw className={loading ? "spin" : ""} />Refresh</button><button className="button primary" disabled={!records.length} onClick={downloadExport}><Download />Export JSON</button></>}
      />

      {loadError && <InlineAlert tone="danger" title="Full ledger refresh failed">{loadError}. Showing the last available local events.</InlineAlert>}

      <section className="audit-controls" aria-label="Audit filters">
        <label className="filter-field audit-search"><span>Search events</span><span className="filter-input"><Search /><input value={filters.query} onChange={(event) => updateFilter("query", event.target.value)} placeholder="Actor, action, run, target, or message" /></span></label>
        <FilterSelect label="Actor" value={filters.actor} onChange={(value) => updateFilter("actor", value)} options={["operator", "planner", "executor", "critic", "system"]} />
        <FilterSelect label="Risk" value={filters.risk} onChange={(value) => updateFilter("risk", value)} options={["read", "write", "execute", "network"]} />
        <FilterSelect label="Status" value={filters.status} onChange={(value) => updateFilter("status", value)} options={["ok", "error", "pending", "approved", "rejected"]} />
        <FilterSelect label="Action" value={filters.action} onChange={(value) => updateFilter("action", value)} options={actions} humanize />
        <label className="filter-field"><span>Order</span><span className="filter-input"><Filter /><select value={filters.sort} onChange={(event) => updateFilter("sort", event.target.value)}><option value="newest">Newest first</option><option value="oldest">Oldest first</option></select></span></label>
      </section>

      <div className={`audit-workspace${selected ? " has-inspector" : ""}`}>
        <section className="section-block audit-ledger" aria-labelledby="audit-events-title">
          <div className="section-heading responsive-heading">
            <div><p className="eyebrow">Events</p><h2 id="audit-events-title">{records.length} matching</h2></div>
            <div className="ledger-status" role="status"><span className="live-dot" />Live{lastUpdated ? ` · updated ${relativeAuditTime(lastUpdated)}` : ""}<small>Export scope: current filters · secrets redacted</small></div>
          </div>
          {records.length ? <div className="audit-table-wrap"><table className="audit-data-table"><thead><tr><th>Time</th><th>Actor</th><th>Action</th><th>Run</th><th>Risk</th><th>Status</th><th>Target / message</th><th><span className="sr-only">Review</span></th></tr></thead><tbody>{visible.map((record) => <AuditTableRow key={record.event.id} record={record} selected={record.event.id === selectedId} onSelect={() => setSelectedId(record.event.id)} />)}</tbody></table></div> : <EmptyState title={loading ? "Loading audit events" : "No matching events"} detail={loading ? "Reading the full local ledger." : "Adjust or clear the filters to broaden this view."} />}
          {visible.length < records.length && <div className="audit-load-more"><p>Showing {visible.length} of {records.length} events to keep the ledger responsive.</p><button className="button secondary" onClick={() => setVisibleCount((count) => count + pageSize)}>Load {Math.min(pageSize, records.length - visible.length)} more</button></div>}
        </section>
        {selected && <AuditInspector record={selected} close={() => setSelectedId("")} notify={notify} />}
      </div>
    </div>
  );
}

function FilterSelect({ label, value, onChange, options, humanize = false }: { label: string; value: string; onChange: (value: string) => void; options: string[]; humanize?: boolean }) {
  const allLabel = label === "Status" ? "All statuses" : `All ${label.toLowerCase()}s`;
  return <label className="filter-field"><span>{label}</span><span className="filter-input"><Filter /><select value={value} onChange={(event) => onChange(event.target.value)}><option value="all">{allLabel}</option>{options.map((option) => <option key={option} value={option}>{humanize ? humanAuditAction(option) : option[0].toUpperCase() + option.slice(1)}</option>)}</select></span></label>;
}

function AuditTableRow({ record, selected, onSelect }: { record: AuditRecord; selected: boolean; onSelect: () => void }) {
  const { event, runId, target } = record;
  return <tr className={selected ? "selected" : ""}>
    <td><time dateTime={event.at} title={formatDate(event.at)}>{relativeAuditTime(event.at)}<small>{formatDate(event.at)}</small></time></td>
    <td><span className={`actor-mark actor-${event.actor}`}>{event.actor.slice(0, 1).toUpperCase()}</span>{event.actor}</td>
    <td><strong>{humanAuditAction(event.action)}</strong><code>{event.action}</code></td>
    <td>{runId ? <Link to={`/runs/${runId}`}>#{shortId(runId)}</Link> : <span className="muted">—</span>}</td>
    <td><StatusBadge status={event.risk} /></td>
    <td><StatusBadge status={event.status} /></td>
    <td><span className="audit-target">{target || event.message}</span>{target && <small>{event.message}</small>}</td>
    <td><button className="icon-button audit-review-button" aria-label={`Review ${humanAuditAction(event.action)} event`} onClick={onSelect}><ChevronRight /></button></td>
  </tr>;
}

function AuditInspector({ record, close, notify }: { record: AuditRecord; close: () => void; notify: (message: string, tone?: "success" | "danger" | "info") => void }) {
  const [tab, setTab] = useState<"details" | "raw">("details");
  const { event, runId, target } = record;
  const redacted = redactAuditValue(event.details);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(exportAuditRecords([record]));
      notify("Copied one redacted audit event.");
    } catch (caught) {
      notify(`Copy failed: ${errorMessage(caught)}`, "danger");
    }
  };
  return <aside className="audit-inspector" aria-labelledby="audit-inspector-title">
    <header><div><p className="eyebrow">Event detail</p><h2 id="audit-inspector-title">{humanAuditAction(event.action)}</h2></div><button className="icon-button" aria-label="Close event detail" onClick={close}><X /></button></header>
    <div className="audit-inspector-summary"><span className={`actor-mark actor-${event.actor}`}>{event.actor.slice(0, 1).toUpperCase()}</span><div><strong>{event.actor}</strong><time dateTime={event.at}>{formatDate(event.at)}</time></div><StatusBadge status={event.status} /></div>
    <dl className="audit-facts"><div><dt>Risk</dt><dd><StatusBadge status={event.risk} /></dd></div><div><dt>Event ID</dt><dd><code>{event.id}</code></dd></div>{runId && <div><dt>Run</dt><dd><Link to={`/runs/${runId}`}>Open run #{shortId(runId)}</Link></dd></div>}{target && <div><dt>Target</dt><dd><code>{String(redactAuditValue(target))}</code></dd></div>}<div><dt>Message</dt><dd>{String(redactAuditValue(event.message))}</dd></div></dl>
    <div className="preview-tabs" role="tablist" aria-label="Event data view"><button role="tab" aria-selected={tab === "details"} className={tab === "details" ? "active" : ""} onClick={() => setTab("details")}>Formatted</button><button role="tab" aria-selected={tab === "raw"} className={tab === "raw" ? "active" : ""} onClick={() => setTab("raw")}>Redacted raw</button></div>
    {tab === "details" ? <FormattedDetails details={redacted} /> : <pre className="raw-payload">{JSON.stringify(redacted, null, 2)}</pre>}
    <footer><span><ShieldCheck />Sensitive fields and inline credentials are redacted.</span><button className="button secondary" onClick={() => void copy()}><Clipboard />Copy redacted event</button></footer>
  </aside>;
}

function FormattedDetails({ details }: { details: unknown }) {
  if (details === undefined) return <div className="audit-no-details"><Check /><p>No additional payload was recorded for this event.</p></div>;
  if (!details || typeof details !== "object" || Array.isArray(details)) return <div className="audit-detail-value"><span>Recorded detail</span><pre>{typeof details === "string" ? details : JSON.stringify(details, null, 2)}</pre></div>;
  return <dl className="audit-detail-list">{Object.entries(details as Record<string, unknown>).map(([key, value]) => <div key={key}><dt>{humanAuditAction(key)}</dt><dd>{value && typeof value === "object" ? <pre>{JSON.stringify(value, null, 2)}</pre> : <code>{String(value)}</code>}</dd></div>)}</dl>;
}

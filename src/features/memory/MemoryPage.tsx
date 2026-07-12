import React, { useEffect, useRef, useState } from "react";
import { BrainCircuit, Check, Clock3, Edit3, Filter, Pin, Plus, RotateCcw, Search, Trash2, X } from "lucide-react";
import { api, errorMessage } from "../../api/client";
import type { MemoryEntry } from "../../api/types";
import { useHarness } from "../../app/StoreProvider";
import { EmptyState, Field, InlineAlert, PageHeader, StatusBadge, formatDate } from "../../components/ui";
import { filterMemory, memoryExcerpt, memoryFacets, memoryPayload, type MemoryFilters } from "./memoryModel";

const blankEntry: MemoryEntry = { id: "", kind: "context", taskType: "", title: "", content: "", pinned: false, source: "operator" };
const initialFilters: MemoryFilters = { query: "", kind: "all", taskType: "all", source: "all", sort: "updated" };

export function MemoryPage() {
  const { store, refresh, notify } = useHarness();
  const [draft, setDraft] = useState<MemoryEntry>(blankEntry);
  const [editing, setEditing] = useState<MemoryEntry | null>(null);
  const [formOpen, setFormOpen] = useState(false);
  const [filters, setFilters] = useState(initialFilters);
  const [busy, setBusy] = useState("");
  const [localError, setLocalError] = useState("");
  const [deleted, setDeleted] = useState<MemoryEntry | null>(null);
  const undoTimer = useRef<number | null>(null);
  useEffect(() => () => { if (undoTimer.current) window.clearTimeout(undoTimer.current); }, []);
  if (!store) return null;

  const entries = filterMemory(store.memory, filters);
  const facets = memoryFacets(store.memory);
  const pinnedCount = store.memory.filter((item) => item.pinned).length;
  const retrospectiveCount = store.memory.filter((item) => item.kind === "retrospective").length;
  const updateFilter = (key: keyof MemoryFilters, value: string) => setFilters((current) => ({ ...current, [key]: value } as MemoryFilters));

  const saveNew = async () => {
    setBusy("save"); setLocalError("");
    try {
      await api("/api/memory", { method: "POST", body: JSON.stringify(memoryPayload(draft)) });
      await refresh(); setDraft(blankEntry); setFormOpen(false); notify("Memory saved to the local knowledge base.");
    } catch (caught) { setLocalError(errorMessage(caught)); }
    finally { setBusy(""); }
  };

  const update = async (item: MemoryEntry, close = true) => {
    setBusy(item.id); setLocalError("");
    try {
      await api(`/api/memory/${item.id}`, { method: "PUT", body: JSON.stringify(memoryPayload(item)) });
      await refresh(); if (close) setEditing(null); notify(close ? "Memory changes saved." : item.pinned ? "Memory pinned." : "Memory unpinned.");
    } catch (caught) { setLocalError(errorMessage(caught)); }
    finally { setBusy(""); }
  };

  const remove = async (item: MemoryEntry) => {
    if (!window.confirm(`Delete memory “${item.title}”? You will have 10 seconds to undo.`)) return;
    setBusy(item.id); setLocalError("");
    try {
      await api(`/api/memory/${item.id}`, { method: "DELETE" });
      await refresh(); setDeleted(item); notify("Memory deleted. Undo is available on this page.", "info");
      if (undoTimer.current) window.clearTimeout(undoTimer.current);
      undoTimer.current = window.setTimeout(() => setDeleted(null), 10000);
    } catch (caught) { setLocalError(errorMessage(caught)); }
    finally { setBusy(""); }
  };

  const undoDelete = async () => {
    if (!deleted) return;
    setBusy("undo"); setLocalError("");
    try {
      await api("/api/memory", { method: "POST", body: JSON.stringify(memoryPayload(deleted)) });
      await refresh(); setDeleted(null); if (undoTimer.current) window.clearTimeout(undoTimer.current); notify("Deleted memory restored.");
    } catch (caught) { setLocalError(errorMessage(caught)); }
    finally { setBusy(""); }
  };

  return <div className="page memory-page">
    <PageHeader eyebrow="Persistent context" title="Memory" detail="Curate local knowledge, reusable snippets, and run retrospectives with clear provenance." actions={<button className="button primary" onClick={() => { setDraft(blankEntry); setFormOpen(true); }}><Plus />Add memory</button>} />
    {localError && <InlineAlert tone="danger" title="Memory action failed">{localError}</InlineAlert>}
    {deleted && <div className="memory-undo" role="status"><RotateCcw /><span><strong>“{deleted.title}” deleted</strong><small>Undo recreates this entry in the local knowledge base.</small></span><button className="button secondary" disabled={busy === "undo"} onClick={() => void undoDelete()}>{busy === "undo" ? "Restoring…" : "Undo delete"}</button><button className="icon-button" aria-label="Dismiss undo" onClick={() => setDeleted(null)}><X /></button></div>}
    <div className="memory-metrics metric-grid"><article className="metric-card metric-violet"><span className="metric-icon"><BrainCircuit /></span><div><p>Entries</p><strong>{store.memory.length}</strong><small>local memories</small></div></article><article className="metric-card metric-cyan"><span className="metric-icon"><Pin /></span><div><p>Pinned</p><strong>{pinnedCount}</strong><small>retrieval priority</small></div></article><article className="metric-card metric-green"><span className="metric-icon"><Clock3 /></span><div><p>Retrospectives</p><strong>{retrospectiveCount}</strong><small>run-generated lessons</small></div></article></div>
    {(formOpen || editing) && <MemoryEditor title={editing ? `Edit ${editing.title}` : "New memory"} entry={editing ?? draft} setEntry={editing ? setEditing : setDraft} busy={busy === "save" || busy === editing?.id} save={() => editing ? update(editing) : saveNew()} cancel={() => { setFormOpen(false); setEditing(null); }} />}
    <section className="section-block"><div className="section-heading"><div><p className="eyebrow">Knowledge base</p><h2>{entries.length} matching</h2></div></div><div className="memory-filterbar"><label className="filter-field memory-search"><span>Search memory</span><span className="filter-input"><Search /><input value={filters.query} onChange={(event) => updateFilter("query", event.target.value)} placeholder="Title, content, task type, or source" /></span></label><MemorySelect label="Kind" value={filters.kind} change={(value) => updateFilter("kind", value)} options={["context", "snippet", "retrospective"]} /><MemorySelect label="Task type" value={filters.taskType} change={(value) => updateFilter("taskType", value)} options={facets.taskTypes} /><MemorySelect label="Source" value={filters.source} change={(value) => updateFilter("source", value)} options={facets.sources} /><label className="filter-field"><span>Sort</span><span className="filter-input"><Filter /><select value={filters.sort} onChange={(event) => updateFilter("sort", event.target.value)}><option value="updated">Recently updated</option><option value="created">Recently created</option><option value="title">Title A–Z</option></select></span></label></div>
      {entries.length ? <div className="memory-grid memory-grid-v2">{entries.map((item) => <article className={`memory-card memory-${item.kind}`} key={item.id}><header><StatusBadge status={item.kind} />{item.pinned && <span className="pin-label"><Pin />Pinned</span>}</header><div className="memory-card-body"><p className="eyebrow">{item.taskType}</p><h3>{item.title}</h3><p className="memory-excerpt">{memoryExcerpt(item.content)}</p></div><dl className="memory-provenance"><div><dt>Source</dt><dd>{item.source || "unknown"}</dd></div><div><dt>Created</dt><dd>{formatDate(item.createdAt)}</dd></div><div><dt>Updated</dt><dd>{formatDate(item.updatedAt ?? item.createdAt)}</dd></div><div><dt>Vector index</dt><dd>{item.indexing?.status ?? "legacy"}</dd></div></dl><footer><button className="button quiet" disabled={busy === item.id} onClick={() => void update({ ...item, pinned: !item.pinned }, false)}><Pin />{item.pinned ? "Unpin" : "Pin"}</button><button className="button quiet" disabled={Boolean(busy)} onClick={() => { setEditing({ ...item }); setFormOpen(false); }}><Edit3 />Edit</button><button className="button danger-quiet" disabled={busy === item.id} onClick={() => void remove(item)}><Trash2 />Delete</button></footer></article>)}</div> : <EmptyState icon={<BrainCircuit />} title="No matching memory" detail={store.memory.length ? "Adjust search, kind, task type, source, or sort." : "Add operator context or let completed runs create retrospectives."} />}
    </section>
  </div>;
}

function MemorySelect({ label, value, change, options }: { label: string; value: string; change: (value: string) => void; options: string[] }) {
  return <label className="filter-field"><span>{label}</span><span className="filter-input"><Filter /><select value={value} onChange={(event) => change(event.target.value)}><option value="all">All {label.toLowerCase()}s</option>{options.map((option) => <option value={option} key={option}>{option}</option>)}</select></span></label>;
}

function MemoryEditor({ title, entry, setEntry, busy, save, cancel }: { title: string; entry: MemoryEntry; setEntry: (entry: MemoryEntry) => void; busy: boolean; save: () => void | Promise<void>; cancel: () => void }) {
  const valid = entry.title.trim() && entry.taskType.trim() && entry.content.trim();
  return <section className="section-block memory-form memory-editor"><div className="section-heading"><div><p className="eyebrow">Memory editor</p><h2>{title}</h2><p>Every saved field stays local and can be searched as future run context.</p></div><button className="icon-button" aria-label="Close editor" onClick={cancel}><X /></button></div><div className="form-grid"><Field label="Kind" htmlFor={`memory-kind-${entry.id || "new"}`} hint="Context is operator guidance; snippets are reusable content; retrospectives capture run lessons."><select id={`memory-kind-${entry.id || "new"}`} value={entry.kind} onChange={(event) => setEntry({ ...entry, kind: event.target.value as MemoryEntry["kind"] })}><option value="context">Context</option><option value="snippet">Snippet</option><option value="retrospective">Retrospective</option></select></Field><Field label="Task type" htmlFor={`memory-task-${entry.id || "new"}`} hint="A stable category such as frontend, debugging, or documentation."><input id={`memory-task-${entry.id || "new"}`} value={entry.taskType} onChange={(event) => setEntry({ ...entry, taskType: event.target.value })} /></Field><Field label="Source" htmlFor={`memory-source-${entry.id || "new"}`} hint="Where this knowledge came from: operator, document, or run reference."><input id={`memory-source-${entry.id || "new"}`} value={entry.source ?? ""} onChange={(event) => setEntry({ ...entry, source: event.target.value })} /></Field><Field label="Title" htmlFor={`memory-title-${entry.id || "new"}`}><input id={`memory-title-${entry.id || "new"}`} value={entry.title} onChange={(event) => setEntry({ ...entry, title: event.target.value })} /></Field></div><Field label="Content" htmlFor={`memory-content-${entry.id || "new"}`} hint={`${entry.content.length.toLocaleString()} / 2,000,000 characters`}><textarea id={`memory-content-${entry.id || "new"}`} rows={9} maxLength={2000000} value={entry.content} onChange={(event) => setEntry({ ...entry, content: event.target.value })} /></Field><label className="check-control"><input type="checkbox" checked={entry.pinned} onChange={(event) => setEntry({ ...entry, pinned: event.target.checked })} /><span><Pin /></span>Pin this memory for retrieval priority</label><div className="form-actions"><button className="button quiet" onClick={cancel}>Cancel</button><button className="button primary" disabled={busy || !valid} onClick={() => void save()}><Check />{busy ? "Saving locally…" : "Save memory"}</button></div></section>;
}

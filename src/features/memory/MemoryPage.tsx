import React, { useMemo, useState } from "react";
import { BrainCircuit, Check, Edit3, Pin, Plus, Search, Trash2, X } from "lucide-react";
import { api, errorMessage } from "../../api/client";
import type { MemoryEntry } from "../../api/types";
import { useHarness } from "../../app/StoreProvider";
import { EmptyState, Field, InlineAlert, PageHeader, StatusBadge, formatDate } from "../../components/ui";

const blankEntry: Omit<MemoryEntry, "id"> = { kind: "context", taskType: "", title: "", content: "", pinned: false, source: "operator" };

export function MemoryPage() {
  const { store, refresh, notify } = useHarness();
  const [entry, setEntry] = useState(blankEntry);
  const [editing, setEditing] = useState<MemoryEntry | null>(null);
  const [formOpen, setFormOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [kind, setKind] = useState("all");
  const [busy, setBusy] = useState(false);
  const [localError, setLocalError] = useState("");
  if (!store) return null;

  const entries = useMemo(() => store.memory
    .filter((item) => kind === "all" || item.kind === kind)
    .filter((item) => !query || [item.title, item.taskType, item.content].join(" ").toLowerCase().includes(query.toLowerCase()))
    .sort((a, b) => Number(b.pinned) - Number(a.pinned)), [kind, query, store.memory]);

  const saveNew = async () => {
    setBusy(true);
    setLocalError("");
    try {
      await api("/api/memory", { method: "POST", body: JSON.stringify(entry) });
      await refresh();
      setEntry(blankEntry);
      setFormOpen(false);
      notify("Memory saved.");
    } catch (error) {
      setLocalError(errorMessage(error));
    } finally {
      setBusy(false);
    }
  };

  const update = async (item: MemoryEntry) => {
    setBusy(true);
    setLocalError("");
    try {
      await api("/api/memory/" + item.id, { method: "PUT", body: JSON.stringify(item) });
      await refresh();
      setEditing(null);
      notify("Memory updated.");
    } catch (error) {
      setLocalError(errorMessage(error));
    } finally {
      setBusy(false);
    }
  };

  const remove = async (item: MemoryEntry) => {
    if (!window.confirm("Delete memory \"" + item.title + "\"?")) return;
    try {
      await api("/api/memory/" + item.id, { method: "DELETE" });
      await refresh();
      notify("Memory deleted.", "info");
    } catch (error) {
      setLocalError(errorMessage(error));
    }
  };

  return (
    <div className="page">
      <PageHeader eyebrow="Persistent context" title="Memory" detail="Curate local knowledge, useful snippets, and retrospectives that improve future runs." actions={<button className="button primary" onClick={() => setFormOpen(true)}><Plus />Add memory</button>} />
      {localError && <InlineAlert title="Memory action failed">{localError}</InlineAlert>}
      {formOpen && <MemoryForm title="New memory" entry={entry as MemoryEntry} setEntry={(value) => setEntry(value)} busy={busy} save={saveNew} cancel={() => setFormOpen(false)} />}
      <section className="section-block">
        <div className="section-heading responsive-heading"><div><p className="eyebrow">Knowledge base</p><h2>{entries.length} entries</h2></div><div className="filter-row"><label className="search-control"><Search /><span className="sr-only">Search memory</span><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search memory" /></label><label className="select-control"><BrainCircuit /><span className="sr-only">Memory kind</span><select value={kind} onChange={(event) => setKind(event.target.value)}><option value="all">All kinds</option><option value="context">Context</option><option value="snippet">Snippet</option><option value="retrospective">Retrospective</option></select></label></div></div>
        {entries.length ? <div className="memory-grid">{entries.map((item) => editing?.id === item.id ? <MemoryForm key={item.id} title={"Edit " + item.title} entry={editing} setEntry={setEditing} busy={busy} save={() => update(editing)} cancel={() => setEditing(null)} /> : <article className={"memory-card memory-" + item.kind} key={item.id}><header><StatusBadge status={item.kind} />{item.pinned && <span className="pin-label"><Pin />Pinned</span>}</header><h3>{item.title}</h3><p className="memory-meta">{item.taskType} · {item.source || "unknown source"} · {formatDate(item.updatedAt || item.createdAt)}</p><p className="memory-excerpt">{item.content}</p><footer><button className="button quiet" onClick={() => void update({ ...item, pinned: !item.pinned })}><Pin />{item.pinned ? "Unpin" : "Pin"}</button><button className="button quiet" onClick={() => setEditing(item)}><Edit3 />Edit</button><button className="button danger-quiet" onClick={() => void remove(item)}><Trash2 />Delete</button></footer></article>)}</div> : <EmptyState icon={<BrainCircuit />} title="No matching memory" detail={store.memory.length ? "Adjust your search or kind filter." : "Add operator context or let completed runs create retrospectives."} />}
      </section>
    </div>
  );
}

function MemoryForm({ title, entry, setEntry, busy, save, cancel }: { title: string; entry: MemoryEntry; setEntry: (entry: MemoryEntry) => void; busy: boolean; save: () => void | Promise<void>; cancel: () => void }) {
  return <section className="section-block memory-form"><div className="section-heading"><div><p className="eyebrow">Memory editor</p><h2>{title}</h2></div><button className="icon-button" aria-label="Close editor" onClick={cancel}><X /></button></div><div className="form-grid"><Field label="Kind" htmlFor={"memory-kind-" + (entry.id || "new")}><select id={"memory-kind-" + (entry.id || "new")} value={entry.kind} onChange={(event) => setEntry({ ...entry, kind: event.target.value as MemoryEntry["kind"] })}><option value="context">Context</option><option value="snippet">Snippet</option><option value="retrospective">Retrospective</option></select></Field><Field label="Task type" htmlFor={"memory-task-" + (entry.id || "new")}><input id={"memory-task-" + (entry.id || "new")} value={entry.taskType} onChange={(event) => setEntry({ ...entry, taskType: event.target.value })} placeholder="frontend, debugging, documentation..." /></Field></div><Field label="Title" htmlFor={"memory-title-" + (entry.id || "new")}><input id={"memory-title-" + (entry.id || "new")} value={entry.title} onChange={(event) => setEntry({ ...entry, title: event.target.value })} /></Field><Field label="Content" htmlFor={"memory-content-" + (entry.id || "new")}><textarea id={"memory-content-" + (entry.id || "new")} value={entry.content} onChange={(event) => setEntry({ ...entry, content: event.target.value })} /></Field><label className="check-control"><input type="checkbox" checked={entry.pinned} onChange={(event) => setEntry({ ...entry, pinned: event.target.checked })} /><span><Pin /></span>Pin this memory for retrieval</label><div className="form-actions"><button className="button quiet" onClick={cancel}>Cancel</button><button className="button primary" disabled={busy || !entry.title.trim() || !entry.taskType.trim() || !entry.content.trim()} onClick={() => void save()}><Check />{busy ? "Saving…" : "Save memory"}</button></div></section>;
}

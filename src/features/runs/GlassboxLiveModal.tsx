import React, { useEffect, useMemo, useRef, useState } from "react";
import { Activity, BrainCircuit, CircleAlert, Eye, Radio, Trash2, Wrench, X } from "lucide-react";
import type { LiveRunEvent, LiveRunEventKind, TaskRun } from "../../api/types";
import { useFocusTrap } from "../../components/useFocusTrap";

type GlassboxLiveModalProps = {
  open: boolean;
  onClose: () => void;
  runs: TaskRun[];
  preferredRunId?: string;
};

type StreamState = "connecting" | "live" | "reconnecting" | "closed";
type EventFilter = "all" | "reasoning" | "output" | "actions";

const actionKinds = new Set<LiveRunEventKind>(["run_status", "phase", "model_start", "model_complete", "tool_call", "tool_result", "validation", "critic", "audit", "error"]);

export function GlassboxLiveModal({ open, onClose, runs, preferredRunId }: GlassboxLiveModalProps) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const feedRef = useRef<HTMLOListElement>(null);
  const [selectedRunId, setSelectedRunId] = useState("");
  const [events, setEvents] = useState<LiveRunEvent[]>([]);
  const [streamState, setStreamState] = useState<StreamState>("closed");
  const [filter, setFilter] = useState<EventFilter>("all");
  const [follow, setFollow] = useState(true);
  useFocusTrap(open, dialogRef, onClose);

  useEffect(() => {
    if (!open) return;
    const preferred = preferredRunId && runs.some((run) => run.id === preferredRunId)
      ? preferredRunId
      : runs.find((run) => run.status === "running" || run.status === "waiting_approval")?.id ?? runs[0]?.id ?? "";
    setSelectedRunId((current) => runs.some((run) => run.id === current) ? current : preferred);
  }, [open, preferredRunId, runs]);

  useEffect(() => {
    if (!open || !selectedRunId) {
      setStreamState("closed");
      return;
    }
    setEvents([]);
    setStreamState("connecting");
    const source = new EventSource(`/api/runs/${encodeURIComponent(selectedRunId)}/events`);
    source.onopen = () => setStreamState("live");
    source.onmessage = (message) => {
      try {
        const event = JSON.parse(message.data) as LiveRunEvent;
        setEvents((current) => {
          const existing = current.findIndex((item) => item.id === event.id);
          if (existing !== -1) {
            const next = [...current];
            next[existing] = event;
            return next;
          }
          return [...current, event].slice(-300);
        });
      } catch {
        // A malformed observer event is ignored; EventSource remains connected.
      }
    };
    source.onerror = () => setStreamState("reconnecting");
    return () => {
      source.close();
      setStreamState("closed");
    };
  }, [open, selectedRunId]);

  const visibleEvents = useMemo(() => events.filter((event) => {
    if (filter === "all") return true;
    if (filter === "reasoning") return event.kind === "reasoning";
    if (filter === "output") return event.kind === "model_output";
    return actionKinds.has(event.kind);
  }), [events, filter]);
  const selectedRun = runs.find((run) => run.id === selectedRunId);

  useEffect(() => {
    if (!follow) return;
    (feedRef.current?.lastElementChild as HTMLElement | null)?.scrollIntoView?.({ block: "end" });
  }, [follow, visibleEvents]);

  if (!open) return null;
  return (
    <div className="glassbox-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <div ref={dialogRef} className="glassbox-modal" role="dialog" aria-modal="true" aria-labelledby="glassbox-title" aria-describedby="glassbox-description" tabIndex={-1}>
        <header className="glassbox-header">
          <div className="glassbox-mark"><Eye aria-hidden="true" /></div>
          <div>
            <span className="eyebrow">Transparent execution</span>
            <h2 id="glassbox-title">Glassbox Live</h2>
            <p id="glassbox-description">Model output, provider-emitted reasoning, tool calls, results, validation, and critic decisions—as they happen.</p>
          </div>
          <button className="icon-button" aria-label="Close Glassbox Live" onClick={onClose}><X /></button>
        </header>

        <div className="glassbox-disclosure">
          <BrainCircuit aria-hidden="true" />
          <p><strong>Literal, not inferred.</strong> Reasoning appears only when a model provider emits a separate reasoning channel. Nexus never invents or relabels hidden chain-of-thought.</p>
        </div>

        <div className="glassbox-toolbar">
          <label>
            <span>Run</span>
            <select value={selectedRunId} onChange={(event) => setSelectedRunId(event.target.value)}>
              {!runs.length && <option value="">No runs yet</option>}
              {runs.map((run) => <option key={run.id} value={run.id}>{run.status} · {run.task.slice(0, 72)}</option>)}
            </select>
          </label>
          <div className="glassbox-filters" role="group" aria-label="Filter live events">
            {(["all", "reasoning", "output", "actions"] as const).map((item) => <button key={item} className={filter === item ? "active" : ""} aria-pressed={filter === item} onClick={() => setFilter(item)}>{item}</button>)}
          </div>
          <span className={`glassbox-stream state-${streamState}`} role="status"><Radio aria-hidden="true" />{streamLabel(streamState)}</span>
        </div>

        <div className="glassbox-runline">
          <span>{selectedRun ? `${selectedRun.phase} · iteration ${selectedRun.iteration}/${selectedRun.maxIterations}` : "Choose a run to observe"}</span>
          <span>{events.length} event{events.length === 1 ? "" : "s"}</span>
        </div>

        <ol ref={feedRef} className="glassbox-feed">
          {!selectedRunId && <GlassboxEmpty title="No run selected" detail="Start a run, then open Glassbox Live to watch it unfold." />}
          {selectedRunId && !visibleEvents.length && <GlassboxEmpty title={streamState === "live" ? "Waiting for activity" : "Opening the live stream"} detail={filter === "all" ? "New model and action events will appear here immediately." : `No ${filter} events have been emitted for this run.`} />}
          {visibleEvents.map((event) => <GlassboxEventRow key={event.id} event={event} />)}
        </ol>

        <footer className="glassbox-footer">
          <label><input type="checkbox" checked={follow} onChange={(event) => setFollow(event.target.checked)} /> Follow newest event</label>
          <button className="button quiet" disabled={!events.length} onClick={() => setEvents([])}><Trash2 />Clear view</button>
        </footer>
      </div>
    </div>
  );
}

function GlassboxEventRow({ event }: { event: LiveRunEvent }) {
  const Icon = event.kind === "reasoning" ? BrainCircuit : event.kind === "tool_call" || event.kind === "tool_result" ? Wrench : event.kind === "error" ? CircleAlert : Activity;
  return (
    <li className={`glassbox-event kind-${event.kind} status-${event.status ?? "active"}`}>
      <span className="glassbox-event-icon"><Icon aria-hidden="true" /></span>
      <article>
        <header>
          <strong>{event.title}</strong>
          <time dateTime={event.at}>{new Date(event.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })}</time>
        </header>
        <div className="glassbox-event-meta">
          <span>{event.kind.replaceAll("_", " ")}</span>
          {event.role && <span>{event.role}</span>}
          {event.phase && <span>{event.phase}</span>}
          {event.subtask && <span title={event.subtask}>{event.subtask}</span>}
        </div>
        {event.content && <pre>{event.content}</pre>}
      </article>
    </li>
  );
}

function GlassboxEmpty({ title, detail }: { title: string; detail: string }) {
  return <li className="glassbox-empty"><Eye aria-hidden="true" /><strong>{title}</strong><p>{detail}</p></li>;
}

function streamLabel(state: StreamState): string {
  if (state === "live") return "Live";
  if (state === "reconnecting") return "Reconnecting";
  if (state === "connecting") return "Connecting";
  return "Closed";
}

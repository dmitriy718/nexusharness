import { nanoid } from "nanoid";
import type { AgentRole, TaskRun } from "./types.js";

export type LiveRunEventKind =
  | "run_status"
  | "phase"
  | "model_start"
  | "reasoning"
  | "model_output"
  | "model_complete"
  | "tool_call"
  | "tool_result"
  | "validation"
  | "critic"
  | "audit"
  | "error";

export interface LiveRunEvent {
  id: string;
  sequence: number;
  runId: string;
  at: string;
  kind: LiveRunEventKind;
  title: string;
  content?: string;
  role?: AgentRole;
  phase?: TaskRun["phase"];
  subtask?: string;
  status?: "active" | "ok" | "error" | "waiting";
}

export type LiveRunEventInput = Omit<LiveRunEvent, "id" | "sequence" | "at"> & { at?: string };
type Subscriber = (event: LiveRunEvent) => void;
type RunEventState = { sequence: number; events: LiveRunEvent[]; subscribers: Set<Subscriber>; lastTouched: number };

const MAX_EVENTS_PER_RUN = 300;
const MAX_TRACKED_RUNS = 25;
const MAX_EVENT_CONTENT = 20_000;
const STREAM_COALESCE_MS = 350;
const states = new Map<string, RunEventState>();

function stateFor(runId: string): RunEventState {
  let state = states.get(runId);
  if (!state) {
    state = { sequence: 0, events: [], subscribers: new Set(), lastTouched: Date.now() };
    states.set(runId, state);
    pruneStates();
  }
  state.lastTouched = Date.now();
  return state;
}

function pruneStates(): void {
  if (states.size <= MAX_TRACKED_RUNS) return;
  const removable = [...states.entries()]
    .filter(([, state]) => state.subscribers.size === 0)
    .sort((left, right) => left[1].lastTouched - right[1].lastTouched);
  while (states.size > MAX_TRACKED_RUNS && removable.length) states.delete(removable.shift()![0]);
}

function boundedContent(content: string | undefined): string | undefined {
  if (!content) return undefined;
  if (content.length <= MAX_EVENT_CONTENT) return content;
  return `${content.slice(0, MAX_EVENT_CONTENT)}\n[Live event truncated by NexusHarness]`;
}

function canCoalesce(previous: LiveRunEvent | undefined, input: LiveRunEventInput, at: string): previous is LiveRunEvent {
  return Boolean(
    previous
    && (input.kind === "reasoning" || input.kind === "model_output")
    && previous.kind === input.kind
    && previous.role === input.role
    && previous.phase === input.phase
    && previous.subtask === input.subtask
    && Date.parse(at) - Date.parse(previous.at) <= STREAM_COALESCE_MS
  );
}

export function publishLiveRunEvent(input: LiveRunEventInput): LiveRunEvent {
  const state = stateFor(input.runId);
  const at = input.at ?? new Date().toISOString();
  const previous = state.events.at(-1);
  let event: LiveRunEvent;
  if (canCoalesce(previous, input, at)) {
    event = {
      ...previous,
      at,
      title: input.title,
      content: boundedContent(`${previous.content ?? ""}${input.content ?? ""}`),
      status: input.status ?? previous.status
    };
    state.events[state.events.length - 1] = event;
  } else {
    event = {
      ...input,
      id: nanoid(),
      sequence: ++state.sequence,
      at,
      content: boundedContent(input.content)
    };
    state.events.push(event);
    if (state.events.length > MAX_EVENTS_PER_RUN) state.events.splice(0, state.events.length - MAX_EVENTS_PER_RUN);
  }
  for (const subscriber of state.subscribers) {
    try { subscriber(structuredClone(event)); } catch { /* A disconnected observer cannot affect a run. */ }
  }
  return structuredClone(event);
}

export function liveRunEventSnapshot(runId: string): LiveRunEvent[] {
  return states.get(runId)?.events.map((event) => structuredClone(event)) ?? [];
}

export function subscribeToLiveRunEvents(runId: string, subscriber: Subscriber): () => void {
  const state = stateFor(runId);
  state.subscribers.add(subscriber);
  return () => state.subscribers.delete(subscriber);
}

export function clearLiveRunEventsForTests(): void {
  states.clear();
}

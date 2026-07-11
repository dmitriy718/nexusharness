import { ApiError } from "../../api/client";
import type { Store } from "../../api/types";

export type FailureCategory = "validation" | "conflict" | "connection" | "authorization" | "not_found" | "unknown";
export type FailureDetails = { category: FailureCategory; title: string; message: string; retryable: boolean; status?: number; technical: string };

function payloadMessage(payload: unknown): string {
  const error = payload && typeof payload === "object" ? (payload as { error?: unknown }).error : undefined;
  if (Array.isArray(error)) return error.map((issue) => {
    if (!issue || typeof issue !== "object") return String(issue);
    const value = issue as { path?: unknown[]; message?: unknown };
    const path = Array.isArray(value.path) && value.path.length ? `${value.path.join(".")}: ` : "";
    return `${path}${String(value.message ?? "Invalid value")}`;
  }).join(" · ");
  return typeof error === "string" ? error : "";
}

export function failureDetails(error: unknown): FailureDetails {
  if (error instanceof ApiError) {
    const message = payloadMessage(error.payload) || error.message || "The local API rejected the request.";
    const category: FailureCategory = error.status === 400 || error.status === 422 ? "validation" : error.status === 409 ? "conflict" : error.status === 401 || error.status === 403 ? "authorization" : error.status === 404 ? "not_found" : error.status >= 500 ? "connection" : "unknown";
    const titles: Record<FailureCategory, string> = { validation: "Check the highlighted values", conflict: "State changed before this action", connection: "Local service could not complete the action", authorization: "Action is not permitted", not_found: "Requested item no longer exists", unknown: "Action could not be completed" };
    return { category, title: titles[category], message, retryable: category === "connection" || category === "conflict", status: error.status, technical: `HTTP ${error.status}\n${JSON.stringify(error.payload, null, 2)}` };
  }
  const message = error instanceof Error ? error.message : String(error);
  const connection = error instanceof TypeError || /fetch|network|connect|offline/i.test(message);
  return { category: connection ? "connection" : "unknown", title: connection ? "Local API connection lost" : "Unexpected local error", message, retryable: connection, technical: error instanceof Error ? error.stack ?? error.message : message };
}

export function freshnessLabel(lastSyncedAt: string | null, now = Date.now()): string {
  if (!lastSyncedAt) return "Never synced";
  const seconds = Math.max(0, Math.round((now - new Date(lastSyncedAt).getTime()) / 1000));
  if (seconds < 5) return "Updated now";
  if (seconds < 60) return `Updated ${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  return `Updated ${minutes}m ago`;
}

function stableSlice<T>(previous: T, next: T): T {
  return JSON.stringify(previous) === JSON.stringify(next) ? previous : next;
}

export function stabilizeStore(previous: Store | null, next: Store): Store {
  if (!previous) return next;
  const stable: Store = {
    settings: stableSlice(previous.settings, next.settings),
    runtimes: stableSlice(previous.runtimes, next.runtimes),
    mcpServers: stableSlice(previous.mcpServers, next.mcpServers),
    memory: stableSlice(previous.memory, next.memory),
    audit: stableSlice(previous.audit, next.audit),
    approvals: stableSlice(previous.approvals, next.approvals),
    runs: stableSlice(previous.runs, next.runs)
  };
  return Object.keys(stable).every((key) => stable[key as keyof Store] === previous[key as keyof Store]) ? previous : stable;
}

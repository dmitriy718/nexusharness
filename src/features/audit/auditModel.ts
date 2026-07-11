import type { AuditEvent, TaskRun } from "../../api/types";

export type AuditSort = "newest" | "oldest";

export type AuditFilters = {
  query: string;
  actor: string;
  risk: string;
  status: string;
  action: string;
  sort: AuditSort;
};

export type AuditRecord = {
  event: AuditEvent;
  runId: string;
  target: string;
};

function detailsRecord(event: AuditEvent): Record<string, unknown> {
  return event.details && typeof event.details === "object" && !Array.isArray(event.details)
    ? event.details as Record<string, unknown>
    : {};
}

export function auditRunId(event: AuditEvent, runs: TaskRun[]): string {
  const direct = detailsRecord(event).runId;
  if (typeof direct === "string" && direct) return direct;
  return runs.find((run) => (run as TaskRun & { log?: AuditEvent[] }).log?.some((item) => item.id === event.id))?.id ?? "";
}

export function auditTarget(event: AuditEvent): string {
  const details = detailsRecord(event);
  const target = details.relativePath ?? details.path ?? details.file ?? details.cwd ?? details.endpoint ?? details.workspaceRoot;
  if (typeof target === "string" && target) return target;
  if (/^(file\.|run\.cancel|runtime\.remove|mcp\.delete|memory\.delete)/.test(event.action)) return event.message;
  return "";
}

export function humanAuditAction(action: string): string {
  return action.replaceAll(".", " ").replaceAll("_", " ").replace(/\b\w/g, (value) => value.toUpperCase());
}

export function auditRecords(events: AuditEvent[], runs: TaskRun[], filters: AuditFilters): AuditRecord[] {
  const query = filters.query.trim().toLowerCase();
  return events
    .map((event) => ({ event, runId: auditRunId(event, runs), target: auditTarget(event) }))
    .filter(({ event, runId, target }) => {
      const haystack = [event.at, event.actor, event.action, humanAuditAction(event.action), event.risk, event.status, event.message, runId, target].join(" ").toLowerCase();
      return (!query || haystack.includes(query))
        && (filters.actor === "all" || event.actor === filters.actor)
        && (filters.risk === "all" || event.risk === filters.risk)
        && (filters.status === "all" || event.status === filters.status)
        && (filters.action === "all" || event.action === filters.action);
    })
    .sort((left, right) => filters.sort === "newest"
      ? right.event.at.localeCompare(left.event.at)
      : left.event.at.localeCompare(right.event.at));
}

function redactText(value: string): string {
  return value
    .replace(/(authorization\s*[:=]\s*)(?:(?:Basic|Bearer)\s+)?[^'"\s,;}]+/gi, "$1[redacted]")
    .replace(/((?:api[_-]?key|token|password|secret|cookie)\s*[:=]\s*)([^\s,;}]+)/gi, "$1[redacted]")
    .replace(/(Bearer\s+)[A-Za-z0-9._~+/-]+=*/gi, "$1[redacted]")
    .replace(/(https?:\/\/[^\s:/]+:)[^\s@/]+@/gi, "$1[redacted]@");
}

export function redactAuditValue(value: unknown, key = ""): unknown {
  if (/token|password|secret|authorization|api[-_]?key|cookie/i.test(key)) return "[redacted]";
  if (Array.isArray(value)) return value.map((item) => redactAuditValue(item));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([childKey, childValue]) => [childKey, redactAuditValue(childValue, childKey)]));
  }
  return typeof value === "string" ? redactText(value) : value;
}

export function exportAuditRecords(records: AuditRecord[], exportedAt = new Date().toISOString()): string {
  return JSON.stringify({
    schemaVersion: 1,
    exportedAt,
    scope: "filtered-local-audit-events",
    redacted: true,
    count: records.length,
    events: records.map(({ event, runId, target }) => ({
      id: event.id,
      at: event.at,
      actor: event.actor,
      action: event.action,
      runId: runId || null,
      risk: event.risk,
      status: event.status,
      target: redactAuditValue(target),
      message: redactAuditValue(event.message),
      details: redactAuditValue(event.details)
    }))
  }, null, 2);
}

export function relativeAuditTime(value: string, now = Date.now()): string {
  const seconds = Math.round((new Date(value).getTime() - now) / 1000);
  const formatter = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });
  if (Math.abs(seconds) < 60) return formatter.format(seconds, "second");
  const minutes = Math.round(seconds / 60);
  if (Math.abs(minutes) < 60) return formatter.format(minutes, "minute");
  const hours = Math.round(minutes / 60);
  if (Math.abs(hours) < 24) return formatter.format(hours, "hour");
  return formatter.format(Math.round(hours / 24), "day");
}

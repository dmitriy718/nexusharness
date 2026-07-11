import type { Approval } from "../../api/types";

export type DiffLine = {
  text: string;
  kind: "header" | "addition" | "deletion" | "context";
};

export function approvalPayload(approval: Approval): Record<string, unknown> {
  return approval.payload && typeof approval.payload === "object"
    ? approval.payload as Record<string, unknown>
    : { value: approval.payload };
}

export function approvalTarget(approval: Approval): string {
  const payload = approvalPayload(approval);
  return String(payload.relativePath ?? payload.path ?? payload.file ?? payload.cwd ?? payload.workspaceRoot ?? "");
}

export function approvalCommand(approval: Approval): string {
  const payload = approvalPayload(approval);
  return String(payload.command ?? payload.cmd ?? "");
}

export function approvalDiff(approval: Approval): string {
  const payload = approvalPayload(approval);
  return typeof payload.diff === "string" ? payload.diff : "";
}

export function parseDiff(diff: string): DiffLine[] {
  return diff.split(/\r?\n/).map((text) => ({
    text,
    kind: text.startsWith("+++") || text.startsWith("---") || text.startsWith("@@")
      ? "header"
      : text.startsWith("+")
        ? "addition"
        : text.startsWith("-")
          ? "deletion"
          : "context"
  }));
}

export function humanApprovalAction(action: string): string {
  return action.replaceAll(".", " ").replaceAll("_", " ").replace(/\b\w/g, (value) => value.toUpperCase());
}

export function redactPayload(value: unknown, key = ""): unknown {
  if (/token|password|secret|authorization|api[-_]?key|cookie/i.test(key)) return "[redacted]";
  if (Array.isArray(value)) return value.map((item) => redactPayload(item));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([childKey, childValue]) => [childKey, redactPayload(childValue, childKey)]));
  }
  return value;
}

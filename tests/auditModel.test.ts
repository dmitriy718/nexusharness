import { describe, expect, it } from "vitest";
import type { AuditEvent, TaskRun } from "../src/api/types";
import {
  auditRecords,
  auditRunId,
  auditTarget,
  exportAuditRecords,
  redactAuditValue,
  relativeAuditTime,
  type AuditFilters
} from "../src/features/audit/auditModel";

function event(overrides: Partial<AuditEvent> = {}): AuditEvent {
  return {
    id: "event-1",
    at: "2026-07-11T00:00:00.000Z",
    actor: "executor",
    action: "file.write",
    risk: "write",
    status: "ok",
    message: "src/App.tsx",
    details: { relativePath: "src/App.tsx" },
    ...overrides
  };
}

function run(overrides: Partial<TaskRun> = {}): TaskRun {
  return {
    id: "run-1",
    task: "Update the application",
    status: "passed",
    phase: "done",
    iteration: 1,
    maxIterations: 3,
    createdAt: "2026-07-11T00:00:00.000Z",
    updatedAt: "2026-07-11T00:01:00.000Z",
    ...overrides
  };
}

const filters: AuditFilters = { query: "", actor: "all", risk: "all", status: "all", action: "all", sort: "newest" };

describe("audit ledger model", () => {
  it("links events to direct context or the originating run log", () => {
    const direct = event({ details: { runId: "run-direct" } });
    const logged = event({ id: "event-logged", details: undefined });
    const loggedRun = run() as TaskRun & { log: AuditEvent[] };
    loggedRun.log = [logged];
    expect(auditRunId(direct, [])).toBe("run-direct");
    expect(auditRunId(logged, [loggedRun])).toBe("run-1");
  });

  it("extracts useful targets from structured and legacy events", () => {
    expect(auditTarget(event())).toBe("src/App.tsx");
    expect(auditTarget(event({ action: "file.delete", message: "tmp/output", details: undefined }))).toBe("tmp/output");
    expect(auditTarget(event({ action: "critic.score", message: "Score 8/10", details: undefined }))).toBe("");
  });

  it("filters across operator-facing fields and sorts chronologically", () => {
    const older = event({ id: "older", at: "2026-07-10T23:00:00.000Z", actor: "system", action: "validation.passed", risk: "execute" });
    const newer = event({ id: "newer", at: "2026-07-11T01:00:00.000Z", details: { runId: "run-special", cwd: "D:/projects/nexus" } });
    expect(auditRecords([older, newer], [], filters).map((item) => item.event.id)).toEqual(["newer", "older"]);
    expect(auditRecords([older, newer], [], { ...filters, query: "run-special", risk: "write" }).map((item) => item.event.id)).toEqual(["newer"]);
    expect(auditRecords([older, newer], [], { ...filters, actor: "system" }).map((item) => item.event.id)).toEqual(["older"]);
  });

  it("redacts nested and inline secrets before review or export", () => {
    const value = redactAuditValue({ token: "nested-secret", command: "curl -H 'Authorization: Bearer inline-secret' https://user:url-secret@example.test" });
    expect(JSON.stringify(value)).not.toContain("nested-secret");
    expect(JSON.stringify(value)).not.toContain("inline-secret");
    expect(JSON.stringify(value)).not.toContain("url-secret");
    expect(value).toEqual({ token: "[redacted]", command: "curl -H 'Authorization: [redacted]' https://user:[redacted]@example.test" });
  });

  it("exports only redacted filtered records with explicit scope metadata", () => {
    const secretEvent = event({ details: { apiKey: "do-not-export" }, message: "token=message-secret" });
    const record = auditRecords([secretEvent], [], filters);
    const exported = exportAuditRecords(record, "2026-07-11T02:00:00.000Z");
    expect(exported).not.toContain("do-not-export");
    expect(exported).not.toContain("message-secret");
    expect(JSON.parse(exported)).toMatchObject({ schemaVersion: 1, redacted: true, count: 1, scope: "filtered-local-audit-events" });
  });

  it("provides stable relative time labels", () => {
    expect(relativeAuditTime("2026-07-11T00:00:00.000Z", Date.parse("2026-07-11T00:02:00.000Z"))).toBe("2 minutes ago");
  });
});

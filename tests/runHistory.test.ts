import { describe, expect, it } from "vitest";
import { parseRunHistoryQuery, runHistoryPage } from "../server/runHistory";
import type { RunExecutionSummary, TaskRun } from "../server/types";

const run = (id: string, task: string, status: TaskRun["status"] = "passed"): TaskRun => ({
  id,
  task,
  status,
  phase: status === "passed" ? "done" : "execute",
  iteration: 1,
  maxIterations: 5,
  log: [],
  createdAt: "2026-07-11T08:00:00.000Z",
  updatedAt: "2026-07-11T08:01:00.000Z"
});

describe("run history API model", () => {
  it("applies bounded defaults and parses query strings", () => {
    expect(parseRunHistoryQuery({})).toEqual({ offset: 0, limit: 100, query: "", status: "all" });
    expect(parseRunHistoryQuery({ offset: "20", limit: "40", query: " audit ", status: "failed" })).toEqual({ offset: 20, limit: 40, query: "audit", status: "failed" });
  });

  it("rejects unbounded, negative, and unknown filters", () => {
    expect(() => parseRunHistoryQuery({ limit: "101" })).toThrow();
    expect(() => parseRunHistoryQuery({ offset: "-1" })).toThrow();
    expect(() => parseRunHistoryQuery({ status: "mystery" })).toThrow();
  });

  it("filters before paging and reports truthful continuation state", () => {
    const runs = [run("run-1", "Audit workspace"), run("run-2", "Fix settings", "failed"), run("run-3", "Audit approvals", "failed"), run("run-4", "Ship release")];
    expect(runHistoryPage(runs, { offset: 0, limit: 1, query: "audit", status: "failed" })).toEqual({ items: [runs[2]], total: 1, offset: 0, limit: 1, hasMore: false });
    expect(runHistoryPage(runs, { offset: 1, limit: 2, query: "", status: "all" })).toEqual({ items: [runs[1], runs[2]], total: 4, offset: 1, limit: 2, hasMore: true });
  });

  it("keeps full execution evidence on the source run but excludes it from paged history", () => {
    const source = run("run-cell", "Inspect a transaction");
    source.execution = execution();
    const page = runHistoryPage([source], { offset: 0, limit: 10, query: "", status: "all" });
    expect(source.execution?.effects).toHaveLength(1);
    expect(page.items[0]).not.toHaveProperty("execution");
  });
});

function execution(): RunExecutionSummary {
  return {
    schemaVersion: 1,
    cellId: "cell-1",
    provider: "portable-worktree",
    securityBoundary: false,
    boundaryDescription: "Transaction isolation only.",
    state: "verifying",
    baseRevision: "a".repeat(40),
    networkDefault: "deny",
    capabilities: { read: ["**"], write: [], delete: [], execute: [], network: [], secrets: [] },
    budget: { wallTimeMs: 1000, cpuTimeMs: 1000, memoryBytes: 16 * 1024 * 1024, diskBytes: 1024 * 1024, processCount: 1, outputBytes: 1024 },
    effects: [{ kind: "file.update", target: "src/main.ts", status: "changed" }],
    variances: [],
    evidence: [],
    commit: { available: false, reason: "Verifying." },
    rollback: { available: true, reason: "Discard cell." },
    updatedAt: "2026-07-11T08:00:00.000Z"
  };
}

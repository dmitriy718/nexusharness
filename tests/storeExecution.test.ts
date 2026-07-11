import { describe, expect, it } from "vitest";
import { attachRunExecutionSummary } from "../server/store";
import type { RunExecutionSummary, StoreShape } from "../server/types";

describe("execution attempt rebinding", () => {
  it("allows a new cell only after the prior cell is truthfully destroyed", () => {
    const store = fixture();
    attachRunExecutionSummary(store, "run-1", summary("cell-1", "isolated", "2026-07-11T10:00:01.000Z"));
    expect(() => attachRunExecutionSummary(store, "run-1", summary("cell-2", "isolated", "2026-07-11T10:00:02.000Z"))).toThrow(/already bound/);

    attachRunExecutionSummary(store, "run-1", summary("cell-1", "destroyed", "2026-07-11T10:00:03.000Z"));
    expect(() => attachRunExecutionSummary(store, "run-1", summary("cell-2", "isolated", "2026-07-11T10:00:04.000Z"))).not.toThrow();
    expect(store.runs[0].execution).toMatchObject({ cellId: "cell-2", state: "isolated" });
  });
});

function summary(cellId: string, state: RunExecutionSummary["state"], updatedAt: string): RunExecutionSummary {
  return {
    schemaVersion: 1,
    cellId,
    provider: "portable-worktree",
    securityBoundary: false,
    boundaryDescription: "Disposable worktree; not a security boundary.",
    state,
    baseRevision: "a".repeat(40),
    networkDefault: "deny",
    capabilities: { read: ["**"], write: ["**"], delete: ["**"], execute: [], network: [], secrets: [] },
    budget: { wallTimeMs: 1000, cpuTimeMs: 1000, memoryBytes: 16 * 1024 * 1024, diskBytes: 1024 * 1024, processCount: 1, outputBytes: 1024 },
    effects: [],
    variances: [],
    evidence: [],
    commit: { available: false, reason: "Unavailable." },
    rollback: { available: state !== "destroyed", reason: state === "destroyed" ? "Destroyed." : "Disposable." },
    updatedAt
  };
}

function fixture(): StoreShape {
  return {
    settings: {
      workspaceRoot: ".", layout: "chat", maxIterations: 1, maxParallelExecutors: 1, criticThreshold: 7,
      approvalMode: true, shellPath: "shell", testCommand: "test", lintCommand: "lint", mcpAutoDiscovery: false,
      mcpPortStart: 3000, mcpPortEnd: 3001, memoryTokenBudget: 100, agentModels: {}
    },
    runtimes: [], mcpServers: [], memory: [], audit: [], approvals: [],
    runs: [{ id: "run-1", task: "test", status: "running", phase: "execute", iteration: 1, maxIterations: 1, log: [], createdAt: "2026-07-11T10:00:00.000Z", updatedAt: "2026-07-11T10:00:00.000Z" }]
  };
}

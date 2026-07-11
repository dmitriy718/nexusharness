import { describe, expect, it } from "vitest";
import {
  assertCellTransition,
  cellSnapshotSchema,
  effectSetSchema,
  executionCellSchema,
  executionDigest,
  type CapabilityLease,
  type CellSpec,
  type CellState,
  type ContractedAction,
  type ExecutionCell,
  type ExecutionCellProvider
} from "../server/execution/contracts";
import { createRunTransactionService } from "../server/execution/runTransactions";
import { attachRunExecutionSummary } from "../server/store";
import type { RunExecutionSummary, StoreShape, TaskRun } from "../server/types";

const at = "2026-07-11T10:00:00.000Z";
const later = "2026-07-11T10:00:01.000Z";
const digest = `sha256:${"a".repeat(64)}`;
const base = "a".repeat(40);

describe("run transaction persistence", () => {
  it("attaches a mutation-safe execution summary to exactly one run", () => {
    const store = storeFixture();
    const input = summary();
    const attached = attachRunExecutionSummary(store, "run-1", input, new Date(later));
    input.capabilities.read.push("tampered/**");

    expect(attached.execution).toMatchObject({ cellId: "cell-1", state: "isolated" });
    expect(attached.execution?.capabilities.read).toEqual(["src/**"]);
    expect(attached.updatedAt).toBe(later);
    expect(store.runs[1]?.execution).toBeUndefined();
  });

  it("rejects unknown runs, cell rebinding, stale summaries, and malformed timestamps", () => {
    const store = storeFixture();
    attachRunExecutionSummary(store, "run-1", summary({ updatedAt: later }));
    expect(() => attachRunExecutionSummary(store, "missing", summary())).toThrow("unknown run");
    expect(() => attachRunExecutionSummary(store, "run-1", summary({ cellId: "cell-2", updatedAt: later }))).toThrow("already bound");
    expect(() => attachRunExecutionSummary(store, "run-1", summary({ updatedAt: at }))).toThrow("older");
    expect(() => attachRunExecutionSummary(storeFixture(), "run-1", summary({ updatedAt: "not-a-date" }))).toThrow("invalid");
  });

  it("binds every service lifecycle publication to the owning run", async () => {
    const store = storeFixture();
    const publications: Array<{ runId: string; state: string }> = [];
    const service = createRunTransactionService({
      runId: " run-1 ",
      provider: new LifecycleProvider(),
      now: () => new Date(later),
      persist: (runId, execution) => {
        publications.push({ runId, state: execution.state });
        attachRunExecutionSummary(store, runId, execution, new Date(later));
      }
    });

    await service.prepare(spec());
    await service.rollback("cell-1");
    await service.destroy("cell-1");

    expect(publications).toEqual([
      { runId: "run-1", state: "isolated" },
      { runId: "run-1", state: "rolled_back" },
      { runId: "run-1", state: "destroyed" }
    ]);
    expect(store.runs[0]?.execution).toMatchObject({ cellId: "cell-1", state: "destroyed" });
  });

  it("requires a non-empty run identity before a provider can be used", () => {
    expect(() => createRunTransactionService({ runId: " ", provider: new LifecycleProvider() })).toThrow("run identifier");
  });
});

class LifecycleProvider implements ExecutionCellProvider {
  readonly securityBoundary = false;
  readonly boundaryDescription = "Lifecycle fixture without a hostile-code boundary.";
  private cell?: ExecutionCell;

  async prepare(input: CellSpec) {
    this.cell = executionCellSchema.parse({
      schemaVersion: 1,
      id: input.id,
      specDigest: executionDigest(input),
      provider: input.provider,
      providerRef: `fixture:${input.id}`,
      baseRevision: input.baseRevision,
      state: "isolated",
      preparedAt: at,
      updatedAt: at
    });
    return this.cell;
  }

  async execute(_cellId: string, _contract: ContractedAction, _lease: CapabilityLease): Promise<never> {
    void _cellId;
    void _contract;
    void _lease;
    throw new Error("The persistence fixture does not execute actions.");
  }

  async transition(cellId: string, nextState: CellState) {
    const cell = this.requireCell(cellId);
    assertCellTransition(cell.state, nextState);
    this.cell = executionCellSchema.parse({ ...cell, state: nextState, updatedAt: later });
    return this.cell;
  }

  async snapshot(cellId: string, reason: string) {
    const cell = this.requireCell(cellId);
    return cellSnapshotSchema.parse({ schemaVersion: 1, id: `snapshot-${cell.state}`, cellId, state: cell.state, reason, stateDigest: digest, createdAt: later });
  }

  async diff(cellId: string) {
    this.requireCell(cellId);
    return effectSetSchema.parse({ schemaVersion: 1, cellId, baseRevision: base, capturedAt: later, effects: [], effectsDigest: executionDigest([]) });
  }

  async commit(): Promise<never> {
    throw new Error("The persistence fixture does not commit.");
  }

  async destroy(cellId: string) {
    const cell = this.requireCell(cellId);
    this.cell = executionCellSchema.parse({ ...cell, state: "destroyed", updatedAt: later });
  }

  private requireCell(cellId: string) {
    if (!this.cell || this.cell.id !== cellId) throw new Error(`Unknown fixture cell: ${cellId}.`);
    return this.cell;
  }
}

function spec(): CellSpec {
  return {
    schemaVersion: 1,
    id: "cell-1",
    objectiveId: "objective-1",
    provider: "portable-worktree",
    baseRevision: base,
    workspaceRootDigest: digest,
    capabilities: { read: ["src/**"], write: [], delete: [], execute: [], network: [], secrets: [] },
    budget: { wallTimeMs: 1000, cpuTimeMs: 1000, memoryBytes: 16 * 1024 * 1024, diskBytes: 1024 * 1024, processCount: 1, outputBytes: 1024 },
    networkDefault: "deny",
    retention: { keepFailedMs: 0, keepCommittedMs: 0 },
    createdAt: at
  };
}

function summary(overrides: Partial<RunExecutionSummary> = {}): RunExecutionSummary {
  return {
    schemaVersion: 1,
    cellId: "cell-1",
    provider: "portable-worktree",
    securityBoundary: false,
    boundaryDescription: "Disposable Git worktree only.",
    state: "isolated",
    baseRevision: base,
    networkDefault: "deny",
    capabilities: { read: ["src/**"], write: [], delete: [], execute: [], network: [], secrets: [] },
    budget: { wallTimeMs: 1000, cpuTimeMs: 1000, memoryBytes: 16 * 1024 * 1024, diskBytes: 1024 * 1024, processCount: 1, outputBytes: 1024 },
    effects: [],
    variances: [],
    evidence: [],
    commit: { available: false, reason: "Not verified." },
    rollback: { available: true, reason: "Disposable." },
    updatedAt: at,
    ...overrides
  };
}

function storeFixture(): StoreShape {
  return {
    settings: {
      workspaceRoot: ".", layout: "chat", maxIterations: 1, maxParallelExecutors: 1, criticThreshold: 7,
      approvalMode: true, shellPath: "shell", testCommand: "", lintCommand: "", mcpAutoDiscovery: false,
      mcpPortStart: 3000, mcpPortEnd: 3001, memoryTokenBudget: 100, agentModels: {}
    },
    runtimes: [], mcpServers: [], memory: [], audit: [], approvals: [],
    runs: [run("run-1"), run("run-2")]
  };
}

function run(id: string): TaskRun {
  return { id, task: id, status: "running", phase: "execute", iteration: 1, maxIterations: 1, log: [], createdAt: at, updatedAt: at };
}

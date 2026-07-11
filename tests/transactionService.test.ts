import { describe, expect, it } from "vitest";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import {
  actionReceiptSchema,
  assertCellTransition,
  capabilityLeaseSchema,
  cellSnapshotSchema,
  cellSpecSchema,
  commitReceiptSchema,
  contractedActionSchema,
  effectSetSchema,
  executionCellSchema,
  executionDigest,
  type ActionReceipt,
  type CapabilityLease,
  type CellSpec,
  type CellState,
  type CommitReceipt,
  type ContractedAction,
  type ExecutionCell,
  type ExecutionCellProvider
} from "../server/execution/contracts";
import { TransactionService } from "../server/execution/transactionService";
import { PortableWorktreeProvider, portableWorkspaceDigest } from "../server/execution/portableWorktreeProvider";
import type { RunExecutionSummary } from "../server/types";

const at = "2026-07-11T10:00:00.000Z";
const digest = `sha256:${"a".repeat(64)}`;
const base = "a".repeat(40);

describe("transaction service", () => {
  it("owns the prepare, execute, verify, and receipt-backed commit lifecycle", async () => {
    const provider = new FakeProvider();
    const published: RunExecutionSummary[] = [];
    const service = transactionService(provider, published);

    const prepared = await service.prepare(spec());
    expect(prepared).toMatchObject({ state: "isolated", securityBoundary: false, commit: { available: false }, rollback: { available: true } });

    const executed = await service.execute("cell-1", contract(), lease());
    expect(executed.summary).toMatchObject({ state: "verifying", effects: [{ kind: "file.update", target: "src/main.ts", status: "changed" }] });
    expect(executed.summary.evidence).toEqual([expect.objectContaining({ name: "Policy and tests", status: "passed" })]);

    const verified = await service.verify("cell-1");
    expect(verified).toMatchObject({ ready: true, summary: { state: "ready_to_commit", commit: { available: true } } });

    const committed = await service.commit("cell-1");
    expect(committed.receipt).toMatchObject({ status: "committed", effectReceiptDigests: [executionDigest(executed.receipt)] });
    expect(committed.summary).toMatchObject({ state: "committed", commit: { available: false }, rollback: { available: false } });
    expect(published.map((summary) => summary.state)).toEqual(expect.arrayContaining(["isolated", "executing", "verifying", "ready_to_commit", "committed"]));
  });

  it("holds promotion when proof fails and publishes the reason", async () => {
    const provider = new FakeProvider({ receipts: [receipt({
      evidence: [{ kind: "test", name: "Unit tests", status: "failed", digest, detail: "One test failed." }]
    })] });
    const service = transactionService(provider);
    await service.prepare(spec());
    await service.execute("cell-1", contract(), lease());

    const result = await service.verify("cell-1");
    expect(result).toMatchObject({ ready: false, reason: "Failed verification evidence must be resolved before promotion.", summary: { state: "verifying", commit: { available: false } } });
    expect(provider.transitions).not.toContain("ready_to_commit");
  });

  it("rolls back only unpromoted cells and destroys provider-owned resources separately", async () => {
    const provider = new FakeProvider();
    const service = transactionService(provider);
    await service.prepare(spec());

    expect(await service.rollback("cell-1")).toMatchObject({ state: "rolled_back", rollback: { available: false } });
    expect(await service.destroy("cell-1")).toMatchObject({ state: "destroyed" });
    expect(provider.destroyed).toBe(true);

    const committedProvider = new FakeProvider();
    const committedService = transactionService(committedProvider);
    await committedService.prepare(spec());
    await committedService.execute("cell-1", contract(), lease());
    await committedService.verify("cell-1");
    await committedService.commit("cell-1");
    await expect(committedService.rollback("cell-1")).rejects.toThrow("compensating transaction");
  });

  it("rejects mismatched provider identity before publishing a managed cell", async () => {
    const provider = new FakeProvider({ preparedId: "cell-other" });
    const service = transactionService(provider);
    await expect(service.prepare(spec())).rejects.toThrow("does not match its specification");
    expect(() => service.getSummary("cell-1")).toThrow("not managed");
  });

  it("serializes concurrent actions within one cell", async () => {
    const provider = new FakeProvider({ executeDelay: true });
    const service = transactionService(provider);
    await service.prepare(spec());
    await Promise.all([
      service.execute("cell-1", contract(), lease()),
      service.execute("cell-1", contract({ id: "action-2", leaseId: "lease-2" }), lease({ id: "lease-2" }))
    ]);
    expect(provider.maximumConcurrentExecutions).toBe(1);
    expect(provider.transitions.filter((state) => state === "executing")).toHaveLength(2);
  });

  it("leaves a cell isolated and retryable when action preflight requires operator input", async () => {
    const provider = new FakeProvider({ authorizationError: new Error("Approval required for file.write.") });
    const service = transactionService(provider);
    await service.prepare(spec());
    await expect(service.execute("cell-1", contract(), lease())).rejects.toThrow("Approval required");
    expect(service.getSummary("cell-1")).toMatchObject({ state: "isolated", rollback: { available: true } });
    expect(provider.transitions).not.toContain("executing");
    expect(provider.executeCalls).toBe(0);
  });

  it("caps receipt count and returns mutation-safe summary copies", async () => {
    const provider = new FakeProvider();
    const service = transactionService(provider, [], 1);
    await service.prepare(spec());
    const first = await service.execute("cell-1", contract(), lease());
    first.summary.capabilities.read.push("tampered/**");
    expect(service.getSummary("cell-1").capabilities.read).toEqual(["src/**"]);
    await expect(service.execute("cell-1", contract({ id: "action-2", leaseId: "lease-2" }), lease({ id: "lease-2" }))).rejects.toThrow("receipt limit");
  });

  it("normalizes revision identity and discloses bounded summary projection", async () => {
    const manyEffects = Array.from({ length: 501 }, (_, index) => ({ ...observedEffect(), target: `src/generated-${index}.ts` }));
    const provider = new FakeProvider({ receipts: [receipt({ observedEffects: manyEffects })] });
    const service = transactionService(provider);
    await service.prepare(spec({ baseRevision: base.toUpperCase() }));
    const result = await service.execute("cell-1", contract(), lease());
    expect(result.summary.baseRevision).toBe(base);
    expect(result.summary.effects).toHaveLength(500);
    expect(result.summary.evidence).toContainEqual(expect.objectContaining({ name: "Execution summary truncated", status: "warning" }));
  });

  it("refreshes and publishes terminal provider state when execution throws", async () => {
    const provider = new FakeProvider({ executeError: new Error("executor unavailable") });
    const published: RunExecutionSummary[] = [];
    const service = transactionService(provider, published);
    await service.prepare(spec());
    await expect(service.execute("cell-1", contract(), lease())).rejects.toThrow("executor unavailable");
    expect(service.getSummary("cell-1")).toMatchObject({ state: "failed", commit: { available: false }, rollback: { available: true } });
    expect(published.at(-1)?.state).toBe("failed");
  });

  it("composes with the portable provider to promote one proven isolated change", async () => {
    const sandbox = await mkdtemp(join(tmpdir(), "nexus-transaction-service-"));
    const root = join(sandbox, "repository");
    const dataRoot = join(sandbox, "cells");
    await mkdir(join(root, "src"), { recursive: true });
    try {
      await git(root, ["init"]);
      await git(root, ["config", "user.name", "Transaction Test"]);
      await git(root, ["config", "user.email", "transaction@example.invalid"]);
      await writeFile(join(root, "src", "main.ts"), "export const value = 1;\n", "utf8");
      await git(root, ["add", "."]);
      await git(root, ["commit", "-m", "base"]);
      const revision = await git(root, ["rev-parse", "HEAD"]);
      const provider = new PortableWorktreeProvider({
        workspaceRoot: root,
        dataRoot,
        actionExecutor: {
          async execute({ workingDirectory, contract: input }) {
            await writeFile(join(workingDirectory, "src", "main.ts"), "export const value = 2;\n", "utf8");
            return receipt({ contractId: input.id, cellId: input.cellId });
          }
        },
        now: () => new Date(at),
        id: () => "provider-receipt-1"
      });
      const service = new TransactionService({ provider, now: () => new Date(at) });
      const cellSpec = spec({ baseRevision: revision, workspaceRootDigest: portableWorkspaceDigest(root) });
      await service.prepare(cellSpec);
      await service.execute("cell-1", contract(), lease());
      expect(await readFile(join(root, "src", "main.ts"), "utf8")).toContain("value = 1");
      expect(await service.verify("cell-1")).toMatchObject({ ready: true });
      expect(await service.commit("cell-1")).toMatchObject({ receipt: { status: "committed" }, summary: { state: "committed" } });
      expect(await readFile(join(root, "src", "main.ts"), "utf8")).toContain("value = 2");
      expect(await service.destroy("cell-1")).toMatchObject({ state: "destroyed" });
    } finally {
      await rm(sandbox, { recursive: true, force: true });
    }
  });
});

function transactionService(provider: FakeProvider, published: RunExecutionSummary[] = [], maxReceiptsPerCell = 1000) {
  return new TransactionService({
    provider,
    now: () => new Date(at),
    maxReceiptsPerCell,
    persistSummary: (_cellId, summary) => { published.push(summary); }
  });
}

class FakeProvider implements ExecutionCellProvider {
  readonly securityBoundary = false;
  readonly boundaryDescription = "Disposable test transaction; not a hostile-code boundary.";
  readonly transitions: CellState[] = [];
  readonly commitCalls: string[][] = [];
  destroyed = false;
  maximumConcurrentExecutions = 0;
  executeCalls = 0;
  private activeExecutions = 0;
  private cell?: ExecutionCell;
  private readonly receipts: ActionReceipt[];

  constructor(private readonly options: {
    preparedId?: string;
    receipts?: ActionReceipt[];
    executeDelay?: boolean;
    executeError?: Error;
    authorizationError?: Error;
  } = {}) {
    this.receipts = [...(options.receipts ?? [receipt()])];
  }

  async prepare(input: CellSpec) {
    this.cell = executionCellSchema.parse({
      schemaVersion: 1,
      id: this.options.preparedId ?? input.id,
      specDigest: executionDigest(input),
      provider: input.provider,
      providerRef: `fake:${input.id}`,
      baseRevision: input.baseRevision,
      state: "isolated",
      preparedAt: at,
      updatedAt: at
    });
    return this.cell;
  }

  async authorize(cellId: string, input: ContractedAction, authority: CapabilityLease) {
    this.requireCell(cellId);
    if (input.cellId !== cellId || authority.cellId !== cellId) throw new Error("Fake authorization identity mismatch.");
    if (this.options.authorizationError) throw this.options.authorizationError;
  }

  async execute(cellId: string, input: ContractedAction, _lease: CapabilityLease) {
    void _lease;
    const cell = this.requireCell(cellId);
    this.executeCalls += 1;
    if (cell.state !== "executing") throw new Error(`Fake provider cannot execute from ${cell.state}.`);
    this.activeExecutions += 1;
    this.maximumConcurrentExecutions = Math.max(this.maximumConcurrentExecutions, this.activeExecutions);
    try {
      if (this.options.executeDelay) await new Promise((resolve) => setTimeout(resolve, 5));
      if (this.options.executeError) {
        this.setState("failed");
        throw this.options.executeError;
      }
      const next = this.receipts.shift() ?? receipt({ id: `receipt-${input.id}`, contractId: input.id });
      const parsed = actionReceiptSchema.parse({ ...next, contractId: input.id, cellId });
      this.setState(parsed.status === "succeeded" ? "verifying" : "failed");
      return parsed;
    } finally {
      this.activeExecutions -= 1;
    }
  }

  async transition(cellId: string, nextState: CellState) {
    const cell = this.requireCell(cellId);
    assertCellTransition(cell.state, nextState);
    this.transitions.push(nextState);
    return this.setState(nextState);
  }

  async snapshot(cellId: string, reason: string) {
    const cell = this.requireCell(cellId);
    return cellSnapshotSchema.parse({ schemaVersion: 1, id: `snapshot-${reason.replaceAll(" ", "-")}`, cellId, state: cell.state, reason, stateDigest: digest, createdAt: at });
  }

  async diff(cellId: string) {
    this.requireCell(cellId);
    const effects = [observedEffect()];
    return effectSetSchema.parse({ schemaVersion: 1, cellId, baseRevision: base, capturedAt: at, effects, effectsDigest: executionDigest(effects) });
  }

  async commit(cellId: string, expectedBase: string, effectReceiptDigests: string[]): Promise<CommitReceipt> {
    this.requireCell(cellId);
    this.commitCalls.push(effectReceiptDigests);
    this.setState("committed");
    return commitReceiptSchema.parse({
      schemaVersion: 1,
      id: "commit-1",
      cellId,
      status: "committed",
      expectedBase,
      actualBase: expectedBase,
      resultingRevision: "b".repeat(40),
      effectReceiptDigests,
      committedAt: at,
      reason: "Promoted by the fake provider."
    });
  }

  async destroy(cellId: string) {
    this.requireCell(cellId);
    this.destroyed = true;
    this.cell = executionCellSchema.parse({ ...this.cell!, state: "destroyed", updatedAt: at });
  }

  private requireCell(cellId: string) {
    if (!this.cell || this.cell.id !== cellId) throw new Error(`Unknown fake cell: ${cellId}.`);
    return this.cell;
  }

  private setState(state: CellState) {
    this.cell = executionCellSchema.parse({ ...this.cell!, state, updatedAt: at });
    return this.cell;
  }
}

function capabilities() {
  return { read: ["src/**"], write: ["src/**"], delete: [], execute: ["npm"], network: [], secrets: [] };
}

function spec(overrides: Record<string, unknown> = {}): CellSpec {
  return cellSpecSchema.parse({
    schemaVersion: 1,
    id: "cell-1",
    objectiveId: "objective-1",
    provider: "portable-worktree",
    baseRevision: base,
    workspaceRootDigest: digest,
    capabilities: capabilities(),
    budget: { wallTimeMs: 1000, cpuTimeMs: 1000, memoryBytes: 16 * 1024 * 1024, diskBytes: 1024 * 1024, processCount: 1, outputBytes: 1024 },
    networkDefault: "deny",
    retention: { keepFailedMs: 0, keepCommittedMs: 0 },
    createdAt: at,
    ...overrides
  });
}

function contract(overrides: Record<string, unknown> = {}): ContractedAction {
  return contractedActionSchema.parse({
    schemaVersion: 1,
    id: "action-1",
    objectiveId: "objective-1",
    cellId: "cell-1",
    leaseId: "lease-1",
    issuedAt: at,
    expiresAt: "2026-07-11T11:00:00.000Z",
    purpose: "Update one source file.",
    action: { kind: "file.write", risk: "write", payloadDigest: digest },
    capabilities: capabilities(),
    requires: [{ kind: "write", value: "src/**" }],
    preconditions: [],
    expectedEffects: [{ kind: "file.update", target: "src/main.ts", description: "Update main source." }],
    forbiddenEffects: [],
    invariants: ["Only the declared file changes."],
    successEvidence: ["Tests pass."],
    rollback: { kind: "discard_cell", description: "Discard the cell." },
    ...overrides
  });
}

function lease(overrides: Record<string, unknown> = {}): CapabilityLease {
  return capabilityLeaseSchema.parse({
    schemaVersion: 1,
    id: "lease-1",
    objectiveId: "objective-1",
    cellId: "cell-1",
    issuedAt: at,
    expiresAt: "2026-07-11T11:00:00.000Z",
    singleUse: true,
    status: "active",
    capabilities: capabilities(),
    policyVersion: "policy-v1",
    ...overrides
  });
}

function receipt(overrides: Record<string, unknown> = {}): ActionReceipt {
  return actionReceiptSchema.parse({
    schemaVersion: 1,
    id: "receipt-1",
    contractId: "action-1",
    cellId: "cell-1",
    status: "succeeded",
    startedAt: at,
    completedAt: at,
    policyVersion: "policy-v1",
    contractDigest: digest,
    leaseDigest: digest,
    predictedEffectsDigest: digest,
    observedEffects: [observedEffect()],
    variances: [],
    evidence: [{ kind: "test", name: "Policy and tests", status: "passed", digest }],
    outputDigest: digest,
    ...overrides
  });
}

function observedEffect() {
  return { kind: "file.update" as const, target: "src/main.ts", status: "changed" as const, observedAt: at, beforeDigest: digest, afterDigest: digest };
}

function git(cwd: string, args: string[]) {
  return new Promise<string>((resolve, reject) => {
    const child = spawn("git", args, { cwd, windowsHide: true, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve(Buffer.concat(stdout).toString("utf8").trim());
      else reject(new Error(`git ${args[0]} failed (${code}): ${Buffer.concat(stderr).toString("utf8")}`));
    });
  });
}

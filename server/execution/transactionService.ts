import {
  actionReceiptSchema,
  canTransitionCell,
  cellSpecSchema,
  commitReceiptSchema,
  executionCellSchema,
  executionDigest,
  type ActionReceipt,
  type CapabilityLease,
  type CellSpec,
  type ContractedAction,
  type EffectSet,
  type ExecutionCell,
  type ExecutionCellProvider
} from "./contracts.js";
import type { RunExecutionSummary } from "../types.js";

const SUMMARY_EFFECT_LIMIT = 500;
const SUMMARY_VARIANCE_LIMIT = 250;
const SUMMARY_EVIDENCE_LIMIT = 250;

interface CellSession {
  spec: CellSpec;
  cell: ExecutionCell;
  receipts: ActionReceipt[];
  effects?: EffectSet;
  lastCommitRejection?: string;
  summary: RunExecutionSummary;
}

export interface TransactionServiceOptions {
  provider: ExecutionCellProvider;
  persistSummary?: (cellId: string, summary: RunExecutionSummary) => void | Promise<void>;
  now?: () => Date;
  maxReceiptsPerCell?: number;
}

export class TransactionService {
  private readonly sessions = new Map<string, CellSession>();
  private readonly operations = new Map<string, Promise<void>>();
  private readonly now: () => Date;
  private readonly maxReceiptsPerCell: number;

  constructor(private readonly options: TransactionServiceOptions) {
    this.now = options.now ?? (() => new Date());
    this.maxReceiptsPerCell = options.maxReceiptsPerCell ?? 1000;
    if (!Number.isSafeInteger(this.maxReceiptsPerCell) || this.maxReceiptsPerCell < 1 || this.maxReceiptsPerCell > 10_000) {
      throw new Error("maxReceiptsPerCell must be an integer from 1 through 10000.");
    }
  }

  async prepare(input: CellSpec) {
    const parsed = cellSpecSchema.parse(input);
    const spec = cellSpecSchema.parse({ ...parsed, baseRevision: parsed.baseRevision.toLowerCase() });
    return this.exclusive(spec.id, async () => {
      if (this.sessions.has(spec.id)) throw new Error(`Execution cell is already managed: ${spec.id}.`);
      const cell = executionCellSchema.parse(await this.options.provider.prepare(spec));
      this.assertPreparedCell(spec, cell);
      const session = { spec, cell, receipts: [] as ActionReceipt[], summary: this.project(spec, cell, [], undefined) };
      this.sessions.set(spec.id, session);
      await this.publish(session);
      return clone(session.summary);
    });
  }

  async execute(cellId: string, contract: ContractedAction, lease: CapabilityLease) {
    return this.exclusive(cellId, async () => {
      const session = this.session(cellId);
      if (session.receipts.length >= this.maxReceiptsPerCell) throw new Error(`Execution cell ${cellId} reached its receipt limit.`);
      if (session.cell.state !== "isolated" && session.cell.state !== "verifying") {
        throw new Error(`Execution cell ${cellId} cannot execute from ${session.cell.state}.`);
      }
      if (contract.cellId !== cellId || lease.cellId !== cellId) throw new Error("Contract and lease must target the managed execution cell.");

      await this.options.provider.authorize?.(cellId, contract, lease);
      session.lastCommitRejection = undefined;
      session.cell = executionCellSchema.parse(await this.options.provider.transition(cellId, "executing"));
      await this.refresh(session, "Contracted action started", false);
      try {
        const receipt = actionReceiptSchema.parse(await this.options.provider.execute(cellId, contract, lease));
        if (receipt.cellId !== cellId || receipt.contractId !== contract.id) throw new Error("Provider returned a receipt for a different execution cell or contract.");
        session.receipts.push(receipt);
        await this.refresh(session, "Contracted action completed");
        return { receipt: clone(receipt), summary: clone(session.summary) };
      } catch (error) {
        await this.refreshAfterFailure(session, "Contracted action failed");
        throw error;
      }
    });
  }

  async verify(cellId: string) {
    return this.exclusive(cellId, async () => {
      const session = this.session(cellId);
      if (session.cell.state !== "verifying") throw new Error(`Execution cell ${cellId} cannot verify from ${session.cell.state}.`);
      session.effects = await this.options.provider.diff(cellId);
      const blocker = verificationBlocker(session.receipts);
      if (blocker) {
        await this.refresh(session, "Verification did not satisfy the promotion gate", false);
        return { ready: false, reason: blocker, summary: clone(session.summary) };
      }
      session.cell = executionCellSchema.parse(await this.options.provider.transition(cellId, "ready_to_commit"));
      session.lastCommitRejection = undefined;
      await this.refresh(session, "Verification passed", false);
      return { ready: true, reason: "All receipts and evidence satisfy the promotion gate.", summary: clone(session.summary) };
    });
  }

  async commit(cellId: string) {
    return this.exclusive(cellId, async () => {
      const session = this.session(cellId);
      if (session.cell.state !== "ready_to_commit") throw new Error(`Execution cell ${cellId} cannot commit from ${session.cell.state}.`);
      const blocker = verificationBlocker(session.receipts);
      if (blocker) throw new Error(`Execution cell ${cellId} is not eligible to commit: ${blocker}`);
      const receiptDigests = session.receipts.map((receipt) => executionDigest(receipt));
      const receipt = commitReceiptSchema.parse(await this.options.provider.commit(cellId, session.cell.baseRevision, receiptDigests));
      if (receipt.cellId !== cellId) throw new Error("Provider returned a commit receipt for a different execution cell.");
      session.lastCommitRejection = receipt.status === "rejected" ? receipt.reason : undefined;
      await this.refresh(session, receipt.status === "committed" ? "Cell committed" : "Cell commit rejected");
      return { receipt: clone(receipt), summary: clone(session.summary) };
    });
  }

  async rollback(cellId: string) {
    return this.exclusive(cellId, async () => {
      const session = this.session(cellId);
      if (session.cell.state === "committed") throw new Error("Committed primary changes require a new compensating transaction, not a cell rollback.");
      if (!canTransitionCell(session.cell.state, "rolled_back")) throw new Error(`Execution cell ${cellId} cannot roll back from ${session.cell.state}.`);
      session.cell = executionCellSchema.parse(await this.options.provider.transition(cellId, "rolled_back"));
      await this.refresh(session, "Cell rolled back", false);
      return clone(session.summary);
    });
  }

  async destroy(cellId: string) {
    return this.exclusive(cellId, async () => {
      const session = this.session(cellId);
      await this.options.provider.destroy(cellId);
      session.cell = executionCellSchema.parse({ ...session.cell, state: "destroyed", updatedAt: this.now().toISOString() });
      session.summary = this.project(session.spec, session.cell, session.receipts, session.effects, session.lastCommitRejection);
      await this.publish(session);
      return clone(session.summary);
    });
  }

  getSummary(cellId: string) {
    return clone(this.session(cellId).summary);
  }

  private async refresh(session: CellSession, reason: string, readEffects = true) {
    const snapshot = await this.options.provider.snapshot(session.cell.id, reason);
    session.cell = executionCellSchema.parse({ ...session.cell, state: snapshot.state, updatedAt: snapshot.createdAt });
    if (readEffects) session.effects = await this.options.provider.diff(session.cell.id);
    session.summary = this.project(session.spec, session.cell, session.receipts, session.effects, session.lastCommitRejection);
    await this.publish(session);
  }

  private async refreshAfterFailure(session: CellSession, reason: string) {
    try {
      await this.refresh(session, reason);
    } catch {
      session.summary = this.project(session.spec, session.cell, session.receipts, session.effects, session.lastCommitRejection);
      await this.publish(session);
    }
  }

  private project(spec: CellSpec, cell: ExecutionCell, receipts: ActionReceipt[], effects?: EffectSet, lastCommitRejection?: string): RunExecutionSummary {
    const receiptEffects = receipts.flatMap((receipt) => receipt.observedEffects);
    const observedEffects = uniqueBy([...receiptEffects, ...(effects?.effects ?? [])], (effect) => `${effect.kind}\0${effect.target}\0${effect.status}`);
    const variances = receipts.flatMap((receipt) => receipt.variances);
    const evidence = receipts.flatMap((receipt) => receipt.evidence);
    const truncated = observedEffects.length > SUMMARY_EFFECT_LIMIT || variances.length > SUMMARY_VARIANCE_LIMIT || evidence.length > SUMMARY_EVIDENCE_LIMIT;
    const projectedEvidence = evidence.slice(-(truncated ? SUMMARY_EVIDENCE_LIMIT - 1 : SUMMARY_EVIDENCE_LIMIT)).map(({ kind, name, status, detail }) => ({
      kind, name, status, ...(detail === undefined ? {} : { detail })
    }));
    if (truncated) projectedEvidence.push({
      kind: "custom",
      name: "Execution summary truncated",
      status: "warning",
      detail: `Full cell records contain ${observedEffects.length} effects, ${variances.length} variances, and ${evidence.length} evidence records; this run summary retains bounded recent entries.`
    });
    const blocker = verificationBlocker(receipts);
    const rollbackAvailable = !["committed", "rolled_back", "destroyed"].includes(cell.state) && canTransitionCell(cell.state, "rolled_back");
    return {
      schemaVersion: 1,
      cellId: cell.id,
      provider: cell.provider,
      securityBoundary: this.options.provider.securityBoundary,
      boundaryDescription: this.options.provider.boundaryDescription,
      state: cell.state,
      baseRevision: cell.baseRevision,
      networkDefault: spec.networkDefault,
      capabilities: clone(spec.capabilities),
      budget: clone(spec.budget),
      effects: observedEffects.slice(-SUMMARY_EFFECT_LIMIT).map(({ kind, target, status }) => ({ kind, target, status })),
      variances: variances.slice(-SUMMARY_VARIANCE_LIMIT).map(({ kind, severity, effectTarget, detail }) => ({ kind, severity, effectTarget, detail })),
      evidence: projectedEvidence,
      commit: {
        available: cell.state === "ready_to_commit" && !blocker,
        reason: cell.state === "ready_to_commit" && !blocker
          ? lastCommitRejection ? `Previous promotion attempt was rejected: ${lastCommitRejection}` : "Verification passed; promotion is available."
          : blocker ?? `Commit is unavailable while the cell is ${cell.state}.`
      },
      rollback: {
        available: rollbackAvailable,
        reason: rollbackAvailable ? "The isolated cell can be discarded without promoting its effects." : rollbackReason(cell.state)
      },
      updatedAt: this.now().toISOString()
    };
  }

  private assertPreparedCell(spec: CellSpec, cell: ExecutionCell) {
    if (cell.id !== spec.id || cell.provider !== spec.provider || cell.baseRevision !== spec.baseRevision) {
      throw new Error("Provider returned a cell that does not match its specification.");
    }
    if (cell.specDigest !== executionDigest(spec)) throw new Error("Provider returned a cell with an invalid specification digest.");
    if (cell.state !== "isolated") throw new Error(`Prepared execution cell must be isolated, not ${cell.state}.`);
  }

  private session(cellId: string) {
    const session = this.sessions.get(cellId);
    if (!session) throw new Error(`Execution cell is not managed: ${cellId}.`);
    return session;
  }

  private async publish(session: CellSession) {
    await this.options.persistSummary?.(session.cell.id, clone(session.summary));
  }

  private async exclusive<T>(cellId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.operations.get(cellId) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => { release = resolve; });
    const queued = previous.then(() => current);
    this.operations.set(cellId, queued);
    await previous;
    try {
      return await operation();
    } finally {
      release();
      if (this.operations.get(cellId) === queued) this.operations.delete(cellId);
    }
  }
}

function verificationBlocker(receipts: ActionReceipt[]) {
  if (!receipts.length) return "At least one contracted action receipt is required.";
  if (receipts.some((receipt) => receipt.status !== "succeeded")) return "Every contracted action must succeed before promotion.";
  if (receipts.some((receipt) => receipt.variances.some((variance) => variance.severity === "blocking"))) return "Blocking effect variance must be resolved before promotion.";
  if (receipts.some((receipt) => receipt.evidence.some((evidence) => evidence.status === "failed"))) return "Failed verification evidence must be resolved before promotion.";
  if (!receipts.some((receipt) => receipt.evidence.some((evidence) => evidence.status === "passed"))) return "At least one passing evidence record is required.";
  return undefined;
}

function rollbackReason(state: ExecutionCell["state"]) {
  if (state === "committed") return "Committed primary changes require a new compensating transaction.";
  if (state === "rolled_back") return "The cell has already been rolled back.";
  if (state === "destroyed") return "The cell has been destroyed.";
  return `Rollback is unavailable while the cell is ${state}.`;
}

function uniqueBy<T>(values: T[], identity: (value: T) => string) {
  const seen = new Set<string>();
  return values.filter((value) => {
    const key = identity(value);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

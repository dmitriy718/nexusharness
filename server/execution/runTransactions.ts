import type { ExecutionCellProvider } from "./contracts.js";
import { TransactionService } from "./transactionService.js";
import { persistRunExecutionSummary } from "../store.js";
import type { RunExecutionSummary } from "../types.js";

export interface RunTransactionOptions {
  runId: string;
  provider: ExecutionCellProvider;
  persist?: (runId: string, summary: RunExecutionSummary) => void | Promise<void>;
  now?: () => Date;
  maxReceiptsPerCell?: number;
}

export function createRunTransactionService(options: RunTransactionOptions) {
  const runId = options.runId.trim();
  if (!runId) throw new Error("A run transaction requires a run identifier.");
  const persist = options.persist ?? persistRunExecutionSummary;
  return new TransactionService({
    provider: options.provider,
    ...(options.now ? { now: options.now } : {}),
    ...(options.maxReceiptsPerCell === undefined ? {} : { maxReceiptsPerCell: options.maxReceiptsPerCell }),
    persistSummary: async (_cellId, summary) => {
      await persist(runId, summary);
    }
  });
}

import {
  ContractCapabilityBroker,
  InMemoryLeaseUseStore,
  InMemoryReceiptChainStore,
  type BrokerAuditSink,
  type EffectObservation
} from "./broker.js";
import { executionDigest, type CapabilityLease, type ContractedAction, type ObservedEffect } from "./contracts.js";
import type { PortableActionExecutor } from "./portableWorktreeProvider.js";
import {
  authorizeWorkspaceFileDelete,
  executePreparedWorkspaceFileDelete,
  inspectWorkspaceFileDelete,
  workspaceFileDigest,
  type LocalApprovalAuthorizer,
  type LocalAuditWriter,
  type WorkspaceFileDeletePlan
} from "../localTools.js";
import type { ApprovalContext, Settings } from "../types.js";

interface RegisteredFileDelete {
  settings: Settings;
  relativePath: string;
  context: ApprovalContext;
  payloadDigest: string;
  beforeDigest: string;
  beforeBytes: number;
}

interface PreparedFileDelete extends RegisteredFileDelete {
  cellSettings: Settings;
  plan: WorkspaceFileDeletePlan;
}

export interface FileDeleteExecutorOptions {
  authorize?: LocalApprovalAuthorizer;
  toolAudit?: LocalAuditWriter;
  brokerAudit: BrokerAuditSink;
  now?: () => Date;
  id?: () => string;
}

export class PortableFileDeleteExecutor implements PortableActionExecutor {
  private readonly registered = new Map<string, RegisteredFileDelete>();
  private readonly registering = new Set<string>();
  private readonly prepared = new Map<string, PreparedFileDelete>();
  private readonly active = new Map<string, PreparedFileDelete>();
  private readonly broker: ContractCapabilityBroker;

  constructor(private readonly options: FileDeleteExecutorOptions) {
    this.broker = new ContractCapabilityBroker({
      mode: "enforced",
      policy: { evaluate: async ({ contract, lease }) => this.policy(contract, lease) },
      observer: { observe: (cellId, operation) => this.observe(cellId, operation) },
      leases: new InMemoryLeaseUseStore(),
      receipts: new InMemoryReceiptChainStore(),
      audit: options.brokerAudit,
      ...(options.now ? { now: options.now } : {}),
      ...(options.id ? { id: options.id } : {})
    });
  }

  async registerFileDelete(contractId: string, input: { settings: Settings; relativePath: string; context?: ApprovalContext }) {
    if (!contractId.trim()) throw new Error("A file-delete action requires a contract identifier.");
    if (this.registered.has(contractId) || this.prepared.has(contractId) || this.registering.has(contractId)) {
      throw new Error(`File-delete action contract is already registered: ${contractId}.`);
    }
    this.registering.add(contractId);
    try {
      const relativePath = normalizedFilePath(input.relativePath);
      const plan = await inspectWorkspaceFileDelete(input.settings, relativePath);
      const beforeDigest = `sha256:${plan.previousSha256}`;
      const payloadDigest = executionDigest({ kind: "file.delete", relativePath, beforeDigest, beforeBytes: plan.previousBytes });
      this.registered.set(contractId, {
        settings: structuredClone(input.settings),
        relativePath,
        context: structuredClone(input.context ?? {}),
        payloadDigest,
        beforeDigest,
        beforeBytes: plan.previousBytes
      });
      return { payloadDigest, beforeDigest, beforeBytes: plan.previousBytes, relativePath };
    } finally {
      this.registering.delete(contractId);
    }
  }

  release(contractId: string) {
    this.registered.delete(contractId);
    this.prepared.delete(contractId);
  }

  async authorize({ workingDirectory, contract, lease }: Parameters<NonNullable<PortableActionExecutor["authorize"]>>[0]) {
    const registration = this.requireRegistration(contract, lease);
    const cellSettings = { ...registration.settings, workspaceRoot: workingDirectory };
    const plan = await inspectWorkspaceFileDelete(cellSettings, registration.relativePath);
    if (`sha256:${plan.previousSha256}` !== registration.beforeDigest || plan.previousBytes !== registration.beforeBytes) {
      throw new Error(`File-delete target changed before approval: ${registration.relativePath}`);
    }
    await authorizeWorkspaceFileDelete(cellSettings, plan, registration.context, this.options.authorize);
    this.prepared.set(contract.id, { ...registration, cellSettings, plan });
  }

  async execute({ cell, contract, lease }: Parameters<PortableActionExecutor["execute"]>[0]) {
    this.requireRegistration(contract, lease);
    const prepared = this.prepared.get(contract.id);
    if (!prepared) throw new Error(`File-delete action was not admitted before execution: ${contract.id}.`);
    this.active.set(cell.id, prepared);
    try {
      return await this.broker.execute(contract, lease, () => executePreparedWorkspaceFileDelete(
        prepared.cellSettings,
        prepared.plan,
        this.options.toolAudit
      ));
    } finally {
      this.active.delete(cell.id);
      this.release(contract.id);
    }
  }

  private requireRegistration(contract: ContractedAction, lease: CapabilityLease) {
    const registration = this.registered.get(contract.id) ?? this.prepared.get(contract.id);
    if (!registration) throw new Error(`No file-delete action is registered for contract ${contract.id}.`);
    if (contract.action.kind !== "file.delete" || contract.action.risk !== "write") throw new Error("Registered file deletions require a write-risk file.delete contract.");
    if (contract.action.payloadDigest !== registration.payloadDigest) throw new Error("File-delete payload does not match its registered target state.");
    if (contract.leaseId !== lease.id || contract.cellId !== lease.cellId) throw new Error("File-delete contract and lease identities do not match.");
    if (!contract.capabilities.delete.includes(registration.relativePath)) throw new Error("File-delete path is outside the contract delete capability.");
    if (!contract.expectedEffects.some((effect) => effect.kind === "file.delete" && effect.target === registration.relativePath && effect.required && !effect.expectedDigest)) {
      throw new Error("File-delete contract must predict one required deletion effect without an after-state digest.");
    }
    return registration;
  }

  private async policy(contract: ContractedAction, lease: CapabilityLease) {
    let allowed = true;
    let reason = "Registered deterministic file deletion matches its contract and lease.";
    try {
      this.requireRegistration(contract, lease);
    } catch {
      allowed = false;
      reason = "Registered deterministic file deletion does not match its contract or lease.";
    }
    return {
      allowed,
      policyVersion: lease.policyVersion,
      reason,
      evidenceDigest: executionDigest({ policy: "portable-file-delete-v1", allowed, contractId: contract.id })
    };
  }

  private async observe<T>(cellId: string, operation: () => Promise<T>): Promise<EffectObservation<T>> {
    const prepared = this.active.get(cellId);
    if (!prepared) throw new Error(`No admitted file-delete action is active for cell ${cellId}.`);
    let outcome: EffectObservation<T>["outcome"];
    try {
      outcome = { status: "succeeded", value: await operation() };
    } catch (error) {
      outcome = { status: "failed", errorDigest: executionDigest({ kind: "file-delete-failure", errorType: error instanceof Error ? error.name : typeof error }) };
    }
    const finalState = await workspaceFileDigest(prepared.cellSettings, prepared.relativePath);
    const effects: ObservedEffect[] = finalState ? [] : [{
      kind: "file.delete",
      target: prepared.relativePath,
      status: "deleted",
      observedAt: (this.options.now ?? (() => new Date()))().toISOString(),
      beforeDigest: prepared.beforeDigest,
      bytesChanged: prepared.beforeBytes
    }];
    return { outcome, effects };
  }
}

function normalizedFilePath(value: string) {
  const normalized = value.replaceAll("\\", "/").replace(/^\.\//, "");
  if (!normalized || normalized === "." || normalized.startsWith("/") || /^[A-Za-z]:\//.test(normalized) || normalized.split("/").includes("..")) {
    throw new Error(`File-delete path must be repository-relative: ${value}`);
  }
  return normalized;
}

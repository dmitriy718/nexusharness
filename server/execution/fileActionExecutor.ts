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
  executePreparedWorkspaceFileWrite,
  prepareWorkspaceFileWrite,
  workspaceFileDigest,
  type LocalApprovalAuthorizer,
  type LocalAuditWriter,
  type WorkspaceFileWritePlan
} from "../localTools.js";
import type { ApprovalContext, Settings } from "../types.js";

interface RegisteredFileWrite {
  settings: Settings;
  relativePath: string;
  content: string;
  context: ApprovalContext;
  payloadDigest: string;
  afterDigest: string;
}

interface PreparedFileWrite extends RegisteredFileWrite {
  cellSettings: Settings;
  plan: WorkspaceFileWritePlan;
}

export interface FileActionExecutorOptions {
  authorize?: LocalApprovalAuthorizer;
  toolAudit?: LocalAuditWriter;
  brokerAudit: BrokerAuditSink;
  now?: () => Date;
  id?: () => string;
}

export class PortableFileActionExecutor implements PortableActionExecutor {
  private readonly registered = new Map<string, RegisteredFileWrite>();
  private readonly prepared = new Map<string, PreparedFileWrite>();
  private readonly active = new Map<string, PreparedFileWrite>();
  private readonly broker: ContractCapabilityBroker;

  constructor(private readonly options: FileActionExecutorOptions) {
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

  registerFileWrite(contractId: string, input: { settings: Settings; relativePath: string; content: string; context?: ApprovalContext }) {
    if (!contractId.trim()) throw new Error("A file action requires a contract identifier.");
    if (this.registered.has(contractId) || this.prepared.has(contractId)) throw new Error(`File action contract is already registered: ${contractId}.`);
    const relativePath = normalizedFilePath(input.relativePath);
    const payloadDigest = executionDigest({ kind: "file.write", relativePath, content: input.content });
    const afterDigest = contentDigest(input.content);
    this.registered.set(contractId, {
      settings: structuredClone(input.settings),
      relativePath,
      content: input.content,
      context: structuredClone(input.context ?? {}),
      payloadDigest,
      afterDigest
    });
    return { payloadDigest, afterDigest, relativePath };
  }

  release(contractId: string) {
    this.registered.delete(contractId);
    this.prepared.delete(contractId);
  }

  async authorize({ workingDirectory, contract, lease }: Parameters<NonNullable<PortableActionExecutor["authorize"]>>[0]) {
    const registration = this.requireRegistration(contract, lease);
    const cellSettings = { ...registration.settings, workspaceRoot: workingDirectory };
    const plan = await prepareWorkspaceFileWrite(
      cellSettings,
      registration.relativePath,
      registration.content,
      registration.context,
      this.options.authorize
    );
    this.prepared.set(contract.id, { ...registration, cellSettings, plan });
  }

  async execute({ cell, contract, lease }: Parameters<PortableActionExecutor["execute"]>[0]) {
    this.requireRegistration(contract, lease);
    const prepared = this.prepared.get(contract.id);
    if (!prepared) throw new Error(`File action was not admitted before execution: ${contract.id}.`);
    this.active.set(cell.id, prepared);
    try {
      return await this.broker.execute(contract, lease, () => executePreparedWorkspaceFileWrite(
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
    if (!registration) throw new Error(`No file action is registered for contract ${contract.id}.`);
    if (contract.action.kind !== "file.write" || contract.action.risk !== "write") throw new Error("Registered file writes require a write-risk file.write contract.");
    if (contract.action.payloadDigest !== registration.payloadDigest) throw new Error("File action payload does not match its registered content.");
    if (contract.leaseId !== lease.id || contract.cellId !== lease.cellId) throw new Error("File action contract and lease identities do not match.");
    if (!contract.capabilities.write.includes(registration.relativePath)) throw new Error("File action path is outside the contract write capability.");
    const predictsWrite = contract.expectedEffects.some((effect) =>
      ["file.create", "file.update"].includes(effect.kind) && effect.target === registration.relativePath && effect.expectedDigest === registration.afterDigest
    );
    if (!predictsWrite) throw new Error("File action contract does not predict the registered content digest.");
    return registration;
  }

  private async policy(contract: ContractedAction, lease: CapabilityLease) {
    let allowed = true;
    let reason = "Registered deterministic file write matches its contract and lease.";
    try {
      this.requireRegistration(contract, lease);
    } catch {
      allowed = false;
      reason = "Registered deterministic file write does not match its contract or lease.";
    }
    return {
      allowed,
      policyVersion: lease.policyVersion,
      reason,
      evidenceDigest: executionDigest({ policy: "portable-file-write-v1", allowed, contractId: contract.id })
    };
  }

  private async observe<T>(cellId: string, operation: () => Promise<T>): Promise<EffectObservation<T>> {
    const prepared = this.active.get(cellId);
    if (!prepared) throw new Error(`No admitted file action is active for cell ${cellId}.`);
    let outcome: EffectObservation<T>["outcome"];
    try {
      outcome = { status: "succeeded", value: await operation() };
    } catch (error) {
      outcome = { status: "failed", errorDigest: executionDigest({ kind: "file-write-failure", errorType: error instanceof Error ? error.name : typeof error }) };
    }
    const changed = prepared.plan.previousSha256 !== prepared.plan.nextSha256;
    const effect: ObservedEffect = {
      kind: prepared.plan.previousSha256 === null ? "file.create" : "file.update",
      target: prepared.relativePath,
      status: changed ? prepared.plan.previousSha256 === null ? "created" : "changed" : "unchanged",
      observedAt: (this.options.now ?? (() => new Date()))().toISOString(),
      ...(prepared.plan.previousSha256 ? { beforeDigest: `sha256:${prepared.plan.previousSha256}` } : {}),
      afterDigest: prepared.afterDigest,
      bytesChanged: Math.abs(prepared.plan.nextBytes - (prepared.plan.previousBytes ?? 0))
    };
    const finalState = await workspaceFileDigest(prepared.cellSettings, prepared.relativePath);
    return { outcome, effects: finalState?.sha256 === prepared.plan.nextSha256 ? [effect] : [] };
  }
}

function normalizedFilePath(value: string) {
  const normalized = value.replaceAll("\\", "/").replace(/^\.\//, "");
  if (!normalized || normalized === "." || normalized.startsWith("/") || /^[A-Za-z]:\//.test(normalized) || normalized.split("/").includes("..")) {
    throw new Error(`File action path must be repository-relative: ${value}`);
  }
  return normalized;
}

function contentDigest(content: string) {
  return `sha256:${createHash("sha256").update(content).digest("hex")}`;
}
import { createHash } from "node:crypto";

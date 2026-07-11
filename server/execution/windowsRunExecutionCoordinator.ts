import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { InMemoryLeaseUseStore, InMemoryReceiptChainStore, type BrokerAuditSink } from "./broker.js";
import { CompositePortableActionExecutor } from "./compositeActionExecutor.js";
import { capabilityLeaseSchema, cellSpecSchema, contractedActionSchema, type CapabilityLease, type ContractedAction } from "./contracts.js";
import { PortableFileActionExecutor } from "./fileActionExecutor.js";
import { PortableFileDeleteExecutor } from "./fileDeleteExecutor.js";
import { portableWorkspaceDigest } from "./portableWorktreeProvider.js";
import { createRunTransactionService } from "./runTransactions.js";
import { WindowsSandboxCommandExecutor, type SandboxCommandLauncher } from "./windowsSandboxCommandExecutor.js";
import { WindowsSandboxProvider, type WindowsSandboxActionExecutor } from "./windowsSandboxProvider.js";
import { listFiles, readWorkspaceFile, type LocalApprovalAuthorizer, type LocalAuditWriter } from "../localTools.js";
import type { ApprovalContext, RunExecutionSummary, Settings } from "../types.js";

const execFileAsync = promisify(execFile);

export interface PredictedSandboxEffect {
  kind: "file.create" | "file.update" | "file.delete";
  target: string;
  description: string;
  required?: boolean;
}

export interface WindowsRunExecutionCoordinatorOptions {
  runId: string;
  cellIdentity?: string;
  settings: Settings;
  dataRoot: string;
  configurationDirectory: string;
  brokerAudit: BrokerAuditSink;
  validationCommands?: readonly string[];
  authorize?: LocalApprovalAuthorizer;
  toolAudit?: LocalAuditWriter;
  launcher?: SandboxCommandLauncher;
  persist?: (runId: string, summary: RunExecutionSummary) => void | Promise<void>;
  now?: () => Date;
  id?: () => string;
}

class WindowsSandboxActionRouter extends CompositePortableActionExecutor implements WindowsSandboxActionExecutor {
  readonly isolation = "windows-sandbox" as const;
}

export class WindowsRunExecutionCoordinator {
  readonly securityBoundary = true;
  readonly boundaryDescription = "Model-originated PowerShell commands execute in verified Windows Sandbox; deterministic file actions remain brokered inside the owned transaction worktree.";
  readonly cellId: string;
  readonly objectiveId: string;
  private readonly settings: Settings;
  private readonly validationCommands: Set<string>;
  private readonly passedValidations = new Set<string>();
  private readonly provider: WindowsSandboxProvider;
  private readonly service: ReturnType<typeof createRunTransactionService>;
  private readonly writes: PortableFileActionExecutor;
  private readonly deletes: PortableFileDeleteExecutor;
  private readonly commands: WindowsSandboxCommandExecutor;
  private readonly now: () => Date;
  private readonly id: () => string;
  private prepared = false;
  private destroyed = false;
  private verificationReady = false;

  constructor(private readonly options: WindowsRunExecutionCoordinatorOptions) {
    const runId = options.runId.trim();
    if (!runId) throw new Error("A Windows run coordinator requires a run identifier.");
    const configured = (options.validationCommands ?? [options.settings.lintCommand, options.settings.testCommand]).map((command) => command.trim()).filter(Boolean);
    if (!configured.length || new Set(configured).size !== configured.length) throw new Error("Windows transactional runs require a non-empty unique validation command set.");
    this.settings = structuredClone(options.settings);
    this.validationCommands = new Set(configured);
    this.now = options.now ?? (() => new Date());
    this.id = options.id ?? randomUUID;
    const attemptIdentity = options.cellIdentity?.trim() || runId;
    if (attemptIdentity.length > 4000) throw new Error("Windows run cell identity exceeds the 4,000 character limit.");
    this.cellId = `run-${createHash("sha256").update(attemptIdentity).digest("hex").slice(0, 32)}`;
    this.objectiveId = `objective-${createHash("sha256").update(runId).digest("hex").slice(0, 32)}`;
    const leases = new InMemoryLeaseUseStore();
    const receipts = new InMemoryReceiptChainStore();
    const common = {
      brokerAudit: options.brokerAudit,
      leases,
      receipts,
      ...(options.authorize ? { authorize: options.authorize } : {}),
      ...(options.toolAudit ? { toolAudit: options.toolAudit } : {}),
      now: this.now,
      id: this.id
    };
    this.writes = new PortableFileActionExecutor(common);
    this.deletes = new PortableFileDeleteExecutor(common);
    this.commands = new WindowsSandboxCommandExecutor({
      configurationDirectory: options.configurationDirectory,
      brokerAudit: options.brokerAudit,
      leases,
      receipts,
      ...(options.authorize ? { authorize: options.authorize } : {}),
      ...(options.launcher ? { launcher: options.launcher } : {}),
      now: this.now,
      id: this.id
    });
    const router = new WindowsSandboxActionRouter([
      { kinds: ["file.write"], executor: this.writes },
      { kinds: ["file.delete"], executor: this.deletes },
      { kinds: ["shell.exec"], executor: this.commands }
    ]);
    this.provider = new WindowsSandboxProvider({ workspaceRoot: this.settings.workspaceRoot, dataRoot: options.dataRoot, actionExecutor: router, now: this.now, id: this.id });
    this.service = createRunTransactionService({ runId, provider: this.provider, ...(options.persist ? { persist: options.persist } : {}), now: this.now });
  }

  async prepare() {
    if (this.destroyed || this.prepared) throw new Error("Windows run coordinator can prepare exactly once.");
    const baseRevision = (await execFileAsync("git", ["rev-parse", "--verify", "HEAD^{commit}"], { cwd: this.settings.workspaceRoot, windowsHide: true, maxBuffer: 1024 * 1024 })).stdout.trim().toLowerCase();
    const specification = cellSpecSchema.parse({
      schemaVersion: 1,
      id: this.cellId,
      objectiveId: this.objectiveId,
      provider: "windows-sandbox",
      baseRevision,
      workspaceRootDigest: portableWorkspaceDigest(this.settings.workspaceRoot),
      capabilities: { read: ["**"], write: ["**"], delete: ["**"], execute: ["powershell.exe"], network: [], secrets: [] },
      budget: { wallTimeMs: 60 * 60_000, cpuTimeMs: 30 * 60_000, memoryBytes: 2 * 1024 * 1024 * 1024, diskBytes: 10 * 1024 * 1024 * 1024, processCount: 100, outputBytes: 10 * 1024 * 1024 },
      networkDefault: "deny",
      retention: { keepFailedMs: 24 * 60 * 60_000, keepCommittedMs: 0 },
      createdAt: this.now().toISOString()
    });
    try {
      const summary = await this.service.prepare(specification);
      this.prepared = true;
      return summary;
    } catch (error) {
      let managed = false;
      try { this.service.getSummary(this.cellId); managed = true; } catch { managed = false; }
      if (managed) {
        await this.service.destroy(this.cellId).catch(() => undefined);
        this.destroyed = true;
      }
      throw error;
    }
  }

  async recoverAndDiscard(cellId: string) {
    if (this.prepared || this.destroyed) throw new Error("Interrupted Windows-cell recovery requires a fresh coordinator before preparation.");
    const recovered = await this.provider.recoverCell(cellId, this.objectiveId);
    await this.provider.destroy(cellId);
    return recovered;
  }

  async recoverAndDiscardOrphans() {
    if (this.prepared || this.destroyed) throw new Error("Windows orphan recovery requires a fresh coordinator before preparation.");
    const records = await this.provider.recoverObjective(this.objectiveId);
    const discarded: Array<(typeof records)[number] & { effects?: Awaited<ReturnType<WindowsSandboxProvider["diff"]>> }> = [];
    for (const record of records) {
      if (record.cell.state === "destroyed") continue;
      const effects = await this.provider.diff(record.cell.id).catch(() => undefined);
      discarded.push({ ...record, ...(effects ? { effects } : {}) });
      await this.provider.destroy(record.cell.id);
    }
    return discarded;
  }

  async list(relativePath = ".") { return listFiles(await this.cellSettings(), relativePath); }
  async read(relativePath: string, options: { offset?: number; limit?: number } = {}) { return readWorkspaceFile(await this.cellSettings(), relativePath, options); }

  async write(relativePath: string, content: string, context: ApprovalContext = {}) {
    this.requirePrepared();
    const contractId = this.actionId("write");
    const registration = this.writes.registerFileWrite(contractId, { settings: this.settings, relativePath, content, context });
    const authority = this.lease(this.actionId("lease"), { write: [registration.relativePath] });
    const contract = contractedActionSchema.parse({
      ...this.contractBase(contractId, authority, "Write one exact file in the Windows run transaction."),
      action: { kind: "file.write", risk: "write", payloadDigest: registration.payloadDigest }, capabilities: authority.capabilities,
      requires: [{ kind: "write", value: registration.relativePath }], preconditions: ["The file still matches the approved pre-image."],
      expectedEffects: [
        { kind: "file.create", target: registration.relativePath, required: false, expectedDigest: registration.afterDigest, description: "Create the approved file." },
        { kind: "file.update", target: registration.relativePath, required: false, expectedDigest: registration.afterDigest, description: "Update the approved file." }
      ], forbiddenEffects: [], invariants: ["No other repository path changes."], successEvidence: ["Broker observes the approved content digest."], rollback: { kind: "discard_cell", description: "Discard the run transaction." }
    });
    try {
      this.invalidateValidation();
      return await this.service.execute(this.cellId, contract, authority);
    } catch (error) { this.writes.release(contractId); throw error; }
  }

  async delete(relativePath: string, context: ApprovalContext = {}) {
    this.requirePrepared();
    const contractId = this.actionId("delete");
    const registration = await this.deletes.registerFileDelete(contractId, { settings: await this.cellSettings(), relativePath, context });
    const authority = this.lease(this.actionId("lease"), { delete: [registration.relativePath] });
    const contract = contractedActionSchema.parse({
      ...this.contractBase(contractId, authority, "Delete one exact regular file in the Windows run transaction."),
      action: { kind: "file.delete", risk: "write", payloadDigest: registration.payloadDigest }, capabilities: authority.capabilities,
      requires: [{ kind: "delete", value: registration.relativePath }], preconditions: ["The file still matches the approved pre-image."],
      expectedEffects: [{ kind: "file.delete", target: registration.relativePath, description: "Delete the approved regular file." }], forbiddenEffects: [],
      invariants: ["No other repository path changes."], successEvidence: ["Broker observes the exact deletion."], rollback: { kind: "discard_cell", description: "Discard the run transaction." }
    });
    try {
      this.invalidateValidation();
      return await this.service.execute(this.cellId, contract, authority);
    } catch (error) { this.deletes.release(contractId); throw error; }
  }

  async shell(command: string, expectedEffects: readonly PredictedSandboxEffect[], context: ApprovalContext = {}, signal?: AbortSignal) {
    this.requirePrepared();
    const normalized = command.trim();
    const contractId = this.actionId("sandbox-command");
    const registration = this.commands.register(contractId, { command: normalized, settings: this.settings, context, ...(signal ? { signal } : {}) });
    const authority = this.lease(this.actionId("lease"), { execute: ["powershell.exe"] });
    const contract = contractedActionSchema.parse({
      ...this.contractBase(contractId, authority, "Run one predicted-effect PowerShell command inside Windows Sandbox."),
      action: { kind: "shell.exec", risk: "execute", payloadDigest: registration.payloadDigest }, capabilities: authority.capabilities,
      requires: [{ kind: "execute", value: "powershell.exe" }], preconditions: ["The command and predicted effects match operator-approved input."],
      expectedEffects: expectedEffects.map((effect) => ({ ...effect, required: effect.required ?? true })), forbiddenEffects: [],
      invariants: ["The primary checkout remains unchanged until promotion."], successEvidence: ["The Sandbox command exits zero and broker-observed effects match prediction."], rollback: { kind: "discard_cell", description: "Discard the run transaction." }
    });
    try {
      this.invalidateValidation();
      const execution = await this.service.execute(this.cellId, contract, authority);
      const result = this.commands.takeResult(contractId);
      if (execution.receipt.status === "succeeded" && result && this.validationCommands.has(normalized) && expectedEffects.length === 0) this.passedValidations.add(normalized);
      return { ...execution, result, diagnostic: this.commands.takeDiagnostic(contractId) };
    } catch (error) { this.commands.release(contractId); throw error; }
  }

  async validate(command: string, context: ApprovalContext = {}, signal?: AbortSignal) {
    if (!this.validationCommands.has(command.trim())) throw new Error("Validation command is not present in the trusted Windows allowlist.");
    return this.shell(command, [], context, signal);
  }

  async verify() {
    this.requirePrepared();
    const missing = [...this.validationCommands].filter((command) => !this.passedValidations.has(command));
    if (missing.length) return { ready: false, reason: `Every configured Windows validation command must pass after the latest mutation (${missing.length} remaining).`, summary: this.service.getSummary(this.cellId) };
    if (this.verificationReady) return { ready: true, reason: "Configured Sandbox validation and transaction verification passed.", summary: this.service.getSummary(this.cellId) };
    const verification = await this.service.verify(this.cellId);
    this.verificationReady = verification.ready;
    return verification;
  }

  async commit() { const verification = await this.verify(); if (!verification.ready) throw new Error(`Windows run transaction is not eligible for promotion: ${verification.reason}`); return this.service.commit(this.cellId); }
  async rollback() { this.requirePrepared(); return this.service.rollback(this.cellId); }
  async destroy() { this.requirePrepared(); const summary = await this.service.destroy(this.cellId); this.prepared = false; this.destroyed = true; return summary; }
  summary() { this.requirePrepared(); return this.service.getSummary(this.cellId); }

  private async cellSettings() { this.requirePrepared(); return { ...this.settings, workspaceRoot: await this.provider.trustedWorkspacePath(this.cellId) }; }
  private invalidateValidation() { this.passedValidations.clear(); this.verificationReady = false; }
  private lease(id: string, capability: { write?: string[]; delete?: string[]; execute?: string[] }) {
    const issuedAt = this.now();
    return capabilityLeaseSchema.parse({ schemaVersion: 1, id, objectiveId: this.objectiveId, cellId: this.cellId, issuedAt: issuedAt.toISOString(), expiresAt: new Date(issuedAt.getTime() + 10 * 60_000).toISOString(), singleUse: true, status: "active", capabilities: { read: ["**"], write: capability.write ?? [], delete: capability.delete ?? [], execute: capability.execute ?? [], network: [], secrets: [] }, policyVersion: "windows-run-transaction-v1" });
  }
  private contractBase(id: string, lease: CapabilityLease, purpose: string): Pick<ContractedAction, "schemaVersion" | "id" | "objectiveId" | "cellId" | "leaseId" | "issuedAt" | "expiresAt" | "purpose"> { return { schemaVersion: 1, id, objectiveId: this.objectiveId, cellId: this.cellId, leaseId: lease.id, issuedAt: lease.issuedAt, expiresAt: lease.expiresAt, purpose }; }
  private actionId(kind: string) { const suffix = this.id().replace(/[^A-Za-z0-9._-]/g, "-").slice(0, 100); if (!suffix) throw new Error("Windows run identifier source returned an unsafe value."); return `${kind}-${suffix}`; }
  private requirePrepared() { if (!this.prepared) throw new Error("Windows run execution cell is not prepared."); }
}

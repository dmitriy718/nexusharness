import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  InMemoryLeaseUseStore,
  InMemoryReceiptChainStore,
  type BrokerAuditSink
} from "./broker.js";
import { CompositePortableActionExecutor } from "./compositeActionExecutor.js";
import {
  capabilityLeaseSchema,
  cellSpecSchema,
  contractedActionSchema,
  type CapabilityLease,
  type ContractedAction
} from "./contracts.js";
import { PortableFileActionExecutor } from "./fileActionExecutor.js";
import { PortableFileDeleteExecutor } from "./fileDeleteExecutor.js";
import { PortableWorktreeProvider, portableWorkspaceDigest } from "./portableWorktreeProvider.js";
import { PortableValidationCommandExecutor } from "./portableShellExecutor.js";
import { createRunTransactionService } from "./runTransactions.js";
import { listFiles, readWorkspaceFile, type LocalApprovalAuthorizer, type LocalAuditWriter } from "../localTools.js";
import type { ApprovalContext, RunExecutionSummary, Settings } from "../types.js";

const execFileAsync = promisify(execFile);

export interface RunExecutionCoordinatorOptions {
  runId: string;
  cellIdentity?: string;
  settings: Settings;
  dataRoot: string;
  brokerAudit: BrokerAuditSink;
  validationCommands?: readonly string[];
  additionalValidationCommands?: readonly string[];
  authorize?: LocalApprovalAuthorizer;
  toolAudit?: LocalAuditWriter;
  persist?: (runId: string, summary: RunExecutionSummary) => void | Promise<void>;
  now?: () => Date;
  id?: () => string;
}

export class RunExecutionCoordinator {
  readonly securityBoundary = false;
  readonly boundaryDescription = "Run-scoped disposable Git worktree with brokered deterministic file actions and allowlisted host validation; not hostile-process or network isolation.";
  readonly cellId: string;
  readonly objectiveId: string;
  private readonly settings: Settings;
  private readonly validationCommands: Set<string>;
  private readonly passedValidations = new Set<string>();
  private readonly provider: PortableWorktreeProvider;
  private readonly service: ReturnType<typeof createRunTransactionService>;
  private readonly writes: PortableFileActionExecutor;
  private readonly deletes: PortableFileDeleteExecutor;
  private readonly validations: PortableValidationCommandExecutor;
  private readonly now: () => Date;
  private readonly id: () => string;
  private prepared = false;
  private destroyed = false;
  private verificationReady = false;

  constructor(private readonly options: RunExecutionCoordinatorOptions) {
    const runId = options.runId.trim();
    if (!runId) throw new Error("A run execution coordinator requires a run identifier.");
    this.settings = structuredClone(options.settings);
    const configured = (options.validationCommands ?? [this.settings.lintCommand, this.settings.testCommand])
      .map((command) => command.trim())
      .filter(Boolean);
    if (!configured.length) throw new Error("Transactional runs require at least one configured validation command.");
    this.validationCommands = new Set(configured);
    if (this.validationCommands.size !== configured.length) throw new Error("Transactional validation commands must be unique.");
    const additional = (options.additionalValidationCommands ?? []).map((command) => command.trim()).filter(Boolean);
    const allowedValidations = [...new Set([...configured, ...additional])];
    const cellIdentity = options.cellIdentity?.trim() || runId;
    if (cellIdentity.length > 4000) throw new Error("Run execution cell identity exceeds the 4,000 character limit.");
    const runIdentity = createHash("sha256").update(runId).digest("hex").slice(0, 32);
    const attemptIdentity = createHash("sha256").update(cellIdentity).digest("hex").slice(0, 32);
    this.cellId = `run-${attemptIdentity}`;
    this.objectiveId = `objective-${runIdentity}`;
    this.now = options.now ?? (() => new Date());
    this.id = options.id ?? randomUUID;
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
    this.validations = new PortableValidationCommandExecutor({ ...common, allowedCommands: allowedValidations });
    this.provider = new PortableWorktreeProvider({
      workspaceRoot: this.settings.workspaceRoot,
      dataRoot: options.dataRoot,
      actionExecutor: new CompositePortableActionExecutor([
        { kinds: ["file.write"], executor: this.writes },
        { kinds: ["file.delete"], executor: this.deletes },
        { kinds: ["shell.exec"], executor: this.validations }
      ]),
      now: this.now,
      id: this.id
    });
    this.service = createRunTransactionService({
      runId,
      provider: this.provider,
      ...(options.persist ? { persist: options.persist } : {}),
      now: this.now
    });
  }

  async prepare() {
    if (this.destroyed) throw new Error("A destroyed run execution coordinator cannot be prepared again.");
    if (this.prepared) throw new Error(`Run execution cell is already prepared: ${this.cellId}.`);
    const baseRevision = (await execFileAsync("git", ["rev-parse", "--verify", "HEAD^{commit}"], {
      cwd: this.settings.workspaceRoot,
      windowsHide: true,
      maxBuffer: 1024 * 1024
    })).stdout.trim().toLowerCase();
    const specification = cellSpecSchema.parse({
      schemaVersion: 1,
      id: this.cellId,
      objectiveId: this.objectiveId,
      provider: "portable-worktree",
      baseRevision,
      workspaceRootDigest: portableWorkspaceDigest(this.settings.workspaceRoot),
      capabilities: { read: ["**"], write: ["**"], delete: ["**"], execute: [this.settings.shellPath], network: [], secrets: [] },
      budget: {
        wallTimeMs: 60 * 60_000,
        cpuTimeMs: 30 * 60_000,
        memoryBytes: 2 * 1024 * 1024 * 1024,
        diskBytes: 10 * 1024 * 1024 * 1024,
        processCount: 100,
        outputBytes: 10 * 1024 * 1024
      },
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
    if (this.prepared || this.destroyed) throw new Error("Interrupted-cell recovery requires a fresh coordinator before preparation.");
    const recovered = await this.provider.recoverCell(cellId, this.objectiveId);
    if (recovered.provider !== "portable-worktree") throw new Error(`Cannot recover ${recovered.provider} through the portable run coordinator.`);
    await this.provider.destroy(cellId);
    return recovered;
  }

  async list(relativePath = ".") {
    return listFiles(await this.cellSettings(), relativePath);
  }

  async read(relativePath: string, options: { offset?: number; limit?: number } = {}) {
    return readWorkspaceFile(await this.cellSettings(), relativePath, options);
  }

  async write(relativePath: string, content: string, context: ApprovalContext = {}) {
    this.requirePrepared();
    const contractId = this.actionId("write");
    const registration = this.writes.registerFileWrite(contractId, { settings: this.settings, relativePath, content, context });
    const authority = this.lease(this.actionId("lease"), { write: [registration.relativePath] });
    const contract = contractedActionSchema.parse({
      ...this.contractBase(contractId, authority, "Write one exact file in the run transaction."),
      action: { kind: "file.write", risk: "write", payloadDigest: registration.payloadDigest },
      capabilities: authority.capabilities,
      requires: [{ kind: "write", value: registration.relativePath }],
      preconditions: ["The file still matches the approval pre-image."],
      expectedEffects: [
        { kind: "file.create", target: registration.relativePath, required: false, expectedDigest: registration.afterDigest, description: "Create the approved file." },
        { kind: "file.update", target: registration.relativePath, required: false, expectedDigest: registration.afterDigest, description: "Update the approved file." }
      ],
      forbiddenEffects: [],
      invariants: ["No other repository path changes."],
      successEvidence: ["The broker observes the approved content digest."],
      rollback: { kind: "discard_cell", description: "Discard the run transaction." }
    });
    try {
      this.passedValidations.clear();
      this.verificationReady = false;
      const execution = await this.service.execute(this.cellId, contract, authority);
      return execution;
    } catch (error) {
      this.writes.release(contractId);
      throw error;
    }
  }

  async delete(relativePath: string, context: ApprovalContext = {}) {
    this.requirePrepared();
    const contractId = this.actionId("delete");
    const registration = await this.deletes.registerFileDelete(contractId, { settings: await this.cellSettings(), relativePath, context });
    const authority = this.lease(this.actionId("lease"), { delete: [registration.relativePath] });
    const contract = contractedActionSchema.parse({
      ...this.contractBase(contractId, authority, "Delete one exact regular file in the run transaction."),
      action: { kind: "file.delete", risk: "write", payloadDigest: registration.payloadDigest },
      capabilities: authority.capabilities,
      requires: [{ kind: "delete", value: registration.relativePath }],
      preconditions: ["The regular file still matches the approval pre-image."],
      expectedEffects: [{ kind: "file.delete", target: registration.relativePath, required: true, description: "Delete the approved regular file." }],
      forbiddenEffects: [],
      invariants: ["No other repository path changes."],
      successEvidence: ["The broker observes the exact deletion."],
      rollback: { kind: "discard_cell", description: "Discard the run transaction." }
    });
    try {
      this.passedValidations.clear();
      this.verificationReady = false;
      const execution = await this.service.execute(this.cellId, contract, authority);
      return execution;
    } catch (error) {
      this.deletes.release(contractId);
      throw error;
    }
  }

  async validate(command: string, context: ApprovalContext = {}, signal?: AbortSignal) {
    this.requirePrepared();
    const normalized = command.trim();
    const contractId = this.actionId("validation");
    const registration = this.validations.register(contractId, { command: normalized, settings: this.settings, context, ...(signal ? { signal } : {}) });
    const authority = this.lease(this.actionId("lease"), { execute: [registration.shell] });
    const contract = contractedActionSchema.parse({
      ...this.contractBase(contractId, authority, "Run one configured validation command without repository mutation."),
      action: { kind: "shell.exec", risk: "execute", payloadDigest: registration.payloadDigest },
      capabilities: authority.capabilities,
      requires: [{ kind: "execute", value: registration.shell }],
      preconditions: ["The command is an exact operator-configured validation command."],
      expectedEffects: [],
      forbiddenEffects: [],
      invariants: ["No Git-visible repository path changes."],
      successEvidence: ["The command exits zero and the broker observes no new repository effects."],
      rollback: { kind: "discard_cell", description: "Discard the run transaction." }
    });
    try {
      const execution = await this.service.execute(this.cellId, contract, authority);
      if (execution.receipt.status === "succeeded") {
        if (this.validationCommands.has(normalized)) this.passedValidations.add(normalized);
        this.verificationReady = false;
      } else {
        this.passedValidations.clear();
      }
      return { ...execution, result: this.validations.takeResult(contractId) };
    } catch (error) {
      this.validations.release(contractId);
      throw error;
    }
  }

  async verify() {
    this.requirePrepared();
    const missing = [...this.validationCommands].filter((command) => !this.passedValidations.has(command));
    if (missing.length) return { ready: false, reason: `Every configured validation command must pass after the latest mutation (${missing.length} remaining).`, summary: this.service.getSummary(this.cellId) };
    if (this.verificationReady) return { ready: true, reason: "Configured validation and transaction verification passed.", summary: this.service.getSummary(this.cellId) };
    const verification = await this.service.verify(this.cellId);
    this.verificationReady = verification.ready;
    return verification;
  }

  async commit() {
    const verification = await this.verify();
    if (!verification.ready) throw new Error(`Run transaction is not eligible for promotion: ${verification.reason}`);
    return this.service.commit(this.cellId);
  }

  async rollback() {
    this.requirePrepared();
    return this.service.rollback(this.cellId);
  }

  async destroy() {
    this.requirePrepared();
    const summary = await this.service.destroy(this.cellId);
    this.prepared = false;
    this.destroyed = true;
    return summary;
  }

  summary() {
    this.requirePrepared();
    return this.service.getSummary(this.cellId);
  }

  private async cellSettings() {
    this.requirePrepared();
    return { ...this.settings, workspaceRoot: await this.provider.trustedWorkspacePath(this.cellId) };
  }

  private lease(id: string, capability: { write?: string[]; delete?: string[]; execute?: string[] }) {
    const issuedAt = this.now();
    return capabilityLeaseSchema.parse({
      schemaVersion: 1,
      id,
      objectiveId: this.objectiveId,
      cellId: this.cellId,
      issuedAt: issuedAt.toISOString(),
      expiresAt: new Date(issuedAt.getTime() + 10 * 60_000).toISOString(),
      singleUse: true,
      status: "active",
      capabilities: { read: ["**"], write: capability.write ?? [], delete: capability.delete ?? [], execute: capability.execute ?? [], network: [], secrets: [] },
      policyVersion: "run-transaction-v1"
    });
  }

  private contractBase(id: string, lease: CapabilityLease, purpose: string): Pick<ContractedAction, "schemaVersion" | "id" | "objectiveId" | "cellId" | "leaseId" | "issuedAt" | "expiresAt" | "purpose"> {
    return { schemaVersion: 1, id, objectiveId: this.objectiveId, cellId: this.cellId, leaseId: lease.id, issuedAt: lease.issuedAt, expiresAt: lease.expiresAt, purpose };
  }

  private actionId(kind: string) {
    const suffix = this.id().replace(/[^A-Za-z0-9._-]/g, "-").slice(0, 100);
    if (!suffix) throw new Error("Run transaction identifier source returned an unsafe value.");
    return `${kind}-${suffix}`;
  }

  private requirePrepared() {
    if (!this.prepared) throw new Error("Run execution cell is not prepared.");
  }
}

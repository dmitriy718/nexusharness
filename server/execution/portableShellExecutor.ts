import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { lstat, readFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import {
  ContractCapabilityBroker,
  InMemoryLeaseUseStore,
  InMemoryReceiptChainStore,
  type BrokerAuditSink,
  type EffectObservation,
  type LeaseUseStore,
  type ReceiptChainStore
} from "./broker.js";
import { executionDigest, type CapabilityLease, type ContractedAction, type ObservedEffect } from "./contracts.js";
import type { PortableActionExecutor } from "./portableWorktreeProvider.js";
import { requireApproval, runShell, type LocalApprovalAuthorizer, type LocalAuditWriter } from "../localTools.js";
import type { ApprovalContext, Settings } from "../types.js";

interface RegisteredValidationCommand {
  command: string;
  settings: Settings;
  context: ApprovalContext;
  payloadDigest: string;
  signal?: AbortSignal;
}

interface PreparedValidationCommand extends RegisteredValidationCommand {
  cellSettings: Settings;
}

export interface PortableValidationCommandExecutorOptions {
  allowedCommands: readonly string[];
  authorize?: LocalApprovalAuthorizer;
  toolAudit?: LocalAuditWriter;
  brokerAudit: BrokerAuditSink;
  leases?: LeaseUseStore;
  receipts?: ReceiptChainStore;
  now?: () => Date;
  id?: () => string;
}

export class PortableValidationCommandExecutor implements PortableActionExecutor {
  readonly securityBoundary = false;
  readonly boundaryDescription = "Allowlisted host validation in a disposable Git worktree; no hostile-process or network isolation.";
  private readonly allowedCommands: Set<string>;
  private readonly registered = new Map<string, RegisteredValidationCommand>();
  private readonly prepared = new Map<string, PreparedValidationCommand>();
  private readonly active = new Map<string, PreparedValidationCommand>();
  private readonly completed = new Map<string, Awaited<ReturnType<typeof runShell>>>();
  private readonly broker: ContractCapabilityBroker;

  constructor(private readonly options: PortableValidationCommandExecutorOptions) {
    const commands = options.allowedCommands.map((command) => command.trim());
    if (!commands.length || commands.length > 100 || commands.some((command) => !command || command.length > 100_000) || new Set(commands).size !== commands.length) {
      throw new Error("Portable validation commands require a non-empty unique allowlist of bounded commands.");
    }
    this.allowedCommands = new Set(commands);
    this.broker = new ContractCapabilityBroker({
      mode: "enforced",
      policy: { evaluate: async ({ contract, lease }) => this.policy(contract, lease) },
      observer: { observe: (cellId, operation) => this.observe(cellId, operation) },
      leases: options.leases ?? new InMemoryLeaseUseStore(),
      receipts: options.receipts ?? new InMemoryReceiptChainStore(),
      audit: options.brokerAudit,
      ...(options.now ? { now: options.now } : {}),
      ...(options.id ? { id: options.id } : {})
    });
  }

  register(contractId: string, input: { command: string; settings: Settings; context?: ApprovalContext; signal?: AbortSignal }) {
    if (!contractId.trim() || this.registered.has(contractId) || this.prepared.has(contractId)) throw new Error(`Invalid or duplicate validation command contract: ${contractId}.`);
    const command = input.command.trim();
    if (!this.allowedCommands.has(command)) throw new Error("Validation command is not present in the trusted allowlist.");
    const payloadDigest = executionDigest({ kind: "shell.exec", shell: input.settings.shellPath, command });
    this.completed.delete(contractId);
    this.registered.set(contractId, {
      command,
      settings: structuredClone(input.settings),
      context: structuredClone(input.context ?? {}),
      payloadDigest,
      ...(input.signal ? { signal: input.signal } : {})
    });
    return { payloadDigest, shell: input.settings.shellPath, command };
  }

  takeResult(contractId: string) {
    const result = this.completed.get(contractId);
    this.completed.delete(contractId);
    return result ? structuredClone(result) : undefined;
  }

  release(contractId: string) {
    this.registered.delete(contractId);
    this.prepared.delete(contractId);
  }

  async authorize({ workingDirectory, contract, lease }: Parameters<NonNullable<PortableActionExecutor["authorize"]>>[0]) {
    const registration = this.requireRegistration(contract, lease);
    const cellSettings = { ...registration.settings, workspaceRoot: workingDirectory };
    await (this.options.authorize ?? requireApproval)(cellSettings, "shell.exec", "execute", {
      command: registration.command,
      cwd: workingDirectory,
      shell: registration.settings.shellPath,
      transactionBoundary: "portable-worktree"
    }, registration.context);
    this.prepared.set(contract.id, { ...registration, cellSettings });
  }

  async execute({ cell, contract, lease }: Parameters<PortableActionExecutor["execute"]>[0]) {
    this.requireRegistration(contract, lease);
    const prepared = this.prepared.get(contract.id);
    if (!prepared) throw new Error(`Validation command was not admitted before execution: ${contract.id}.`);
    this.active.set(cell.id, prepared);
    try {
      let completed: Awaited<ReturnType<typeof runShell>> | undefined;
      const receipt = await this.broker.execute(contract, lease, async () => {
        completed = await runShell(
          prepared.cellSettings,
          prepared.command,
          prepared.signal,
          prepared.context,
          async () => undefined,
          this.options.toolAudit,
          { throwOnNonZero: false }
        );
        return completed;
      });
      if (receipt.status === "succeeded" && completed) this.completed.set(contract.id, structuredClone(completed));
      return receipt;
    } finally {
      this.active.delete(cell.id);
      this.release(contract.id);
    }
  }

  private requireRegistration(contract: ContractedAction, lease: CapabilityLease) {
    const registration = this.registered.get(contract.id) ?? this.prepared.get(contract.id);
    if (!registration) throw new Error(`No validation command is registered for contract ${contract.id}.`);
    if (contract.action.kind !== "shell.exec" || contract.action.risk !== "execute") throw new Error("Validation commands require an execute-risk shell.exec contract.");
    if (contract.action.payloadDigest !== registration.payloadDigest) throw new Error("Validation command payload does not match its registration.");
    if (contract.leaseId !== lease.id || contract.cellId !== lease.cellId) throw new Error("Validation command contract and lease identities do not match.");
    if (!contract.capabilities.execute.includes(registration.settings.shellPath)) throw new Error("Validation command contract lacks its configured shell capability.");
    if (contract.expectedEffects.length) throw new Error("Portable validation commands must not predict repository mutations.");
    if (contract.capabilities.network.length || contract.capabilities.secrets.length) throw new Error("Portable validation commands cannot receive network or secret capabilities.");
    return registration;
  }

  private async policy(contract: ContractedAction, lease: CapabilityLease) {
    let allowed = true;
    try { this.requireRegistration(contract, lease); } catch { allowed = false; }
    return {
      allowed,
      policyVersion: lease.policyVersion,
      reason: allowed ? "Registered allowlisted validation command matches its contract and lease." : "Validation command does not match its registration, allowlist, or authority.",
      evidenceDigest: executionDigest({ policy: "portable-validation-command-v1", allowed, contractId: contract.id })
    };
  }

  private async observe<T>(cellId: string, operation: () => Promise<T>): Promise<EffectObservation<T>> {
    const prepared = this.active.get(cellId);
    if (!prepared) throw new Error(`No validation command is active for cell ${cellId}.`);
    const before = await workspaceState(prepared.cellSettings.workspaceRoot);
    let outcome: EffectObservation<T>["outcome"];
    try {
      outcome = { status: "succeeded", value: await operation() };
    } catch (error) {
      outcome = { status: "failed", errorDigest: executionDigest({ kind: "validation-command-failure", errorType: error instanceof Error ? error.name : typeof error }) };
    }
    const after = await workspaceState(prepared.cellSettings.workspaceRoot);
    return { outcome, effects: changedEffects(before, after, this.options.now?.() ?? new Date()) };
  }
}

type FileState = { kind: ObservedEffect["kind"]; digest?: string };
const execFileAsync = promisify(execFile);

async function workspaceState(root: string) {
  const { stdout } = await execFileAsync("git", ["status", "--porcelain=v1", "-z", "--untracked-files=all"], {
    cwd: root,
    windowsHide: true,
    maxBuffer: 20 * 1024 * 1024
  });
  const state = new Map<string, FileState>();
  for (const record of stdout.split("\0").filter(Boolean)) {
    const status = record.slice(0, 2);
    const target = record.slice(3).replaceAll("\\", "/");
    const kind = status === "??" ? "file.create" : status.includes("D") ? "file.delete" : "file.update";
    let digest: string | undefined;
    if (kind !== "file.delete") {
      const file = path.join(root, target);
      const details = await lstat(file).catch(() => undefined);
      if (details?.isFile()) {
        if (details.size > 20 * 1024 * 1024) throw new Error(`Validation effect file exceeds the 20 MiB inspection limit: ${target}`);
        digest = `sha256:${createHash("sha256").update(await readFile(file)).digest("hex")}`;
      }
    }
    state.set(target, { kind, ...(digest ? { digest } : {}) });
  }
  return state;
}

function changedEffects(before: Map<string, FileState>, after: Map<string, FileState>, now: Date) {
  const effects: ObservedEffect[] = [];
  for (const [target, current] of after) {
    const previous = before.get(target);
    if (previous?.kind === current.kind && previous.digest === current.digest) continue;
    effects.push({
      kind: current.kind,
      target,
      status: current.kind === "file.create" ? "created" : current.kind === "file.delete" ? "deleted" : "changed",
      observedAt: now.toISOString(),
      ...(previous?.digest ? { beforeDigest: previous.digest } : {}),
      ...(current.digest ? { afterDigest: current.digest } : {})
    });
  }
  for (const [target, previous] of before) {
    if (after.has(target)) continue;
    effects.push({ kind: "file.update", target, status: "changed", observedAt: now.toISOString(), ...(previous.digest ? { beforeDigest: previous.digest } : {}) });
  }
  return effects.sort((left, right) => left.target.localeCompare(right.target));
}

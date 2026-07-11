import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { lstat, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
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
import {
  WindowsSandboxLauncher,
  parseWindowsSandboxJson,
  type WindowsSandboxActionExecutor,
  type WindowsSandboxLaunchInput
} from "./windowsSandboxProvider.js";
import { requireApproval, type LocalApprovalAuthorizer } from "../localTools.js";
import type { ApprovalContext, Settings } from "../types.js";

interface RegisteredCommand {
  command: string;
  settings: Settings;
  context: ApprovalContext;
  payloadDigest: string;
  signal?: AbortSignal;
}

interface PreparedCommand extends RegisteredCommand {
  workingDirectory: string;
}

export interface SandboxCommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface SandboxCommandDiagnostic {
  stage: "bootstrap-write" | "sandbox-launch" | "result-read" | "result-parse" | "result-validate" | "guest-bootstrap" | "guest-exit" | "complete";
  exitCode: number | null;
  errorType?: string;
  guestStage?: string;
}

export function windowsSandboxCommandAssertionReport(input: {
  receipt: Awaited<ReturnType<WindowsSandboxCommandExecutor["execute"]>>;
  result?: SandboxCommandResult;
  primaryUnchanged: boolean;
  effects: ObservedEffect[];
  expectedTarget: string;
  diagnostic?: SandboxCommandDiagnostic;
}) {
  const checks = {
    receiptSucceeded: input.receipt.status === "succeeded",
    resultAvailable: Boolean(input.result),
    exitCodeZero: input.result?.exitCode === 0,
    primaryUnchanged: input.primaryUnchanged,
    expectedEffectObserved: input.effects.some((effect) => effect.kind === "file.create" && effect.target === input.expectedTarget)
  };
  return {
    receipt: input.receipt.status,
    exitCode: input.result?.exitCode ?? null,
    primaryUnchanged: input.primaryUnchanged,
    effects: input.effects.map(({ kind, target, status }) => ({ kind, target, status })),
    variances: input.receipt.variances.map(({ kind, severity, effectTarget }) => ({ kind, severity, effectTarget })),
    evidence: input.receipt.evidence.map(({ kind, name, status }) => ({ kind, name, status })),
    diagnostic: input.diagnostic ?? null,
    checks,
    executionPassed: Object.values(checks).every(Boolean)
  };
}

export interface SandboxCommandLauncher {
  launch(input: WindowsSandboxLaunchInput): Promise<void>;
}

export interface WindowsSandboxCommandExecutorOptions {
  configurationDirectory: string;
  brokerAudit: BrokerAuditSink;
  launcher?: SandboxCommandLauncher;
  authorize?: LocalApprovalAuthorizer;
  leases?: LeaseUseStore;
  receipts?: ReceiptChainStore;
  now?: () => Date;
  id?: () => string;
}

export class WindowsSandboxCommandExecutor implements WindowsSandboxActionExecutor {
  readonly isolation = "windows-sandbox" as const;
  private readonly registered = new Map<string, RegisteredCommand>();
  private readonly prepared = new Map<string, PreparedCommand>();
  private readonly active = new Map<string, PreparedCommand>();
  private readonly completed = new Map<string, SandboxCommandResult>();
  private readonly diagnostics = new Map<string, SandboxCommandDiagnostic>();
  private readonly launcher: SandboxCommandLauncher;
  private readonly broker: ContractCapabilityBroker;

  constructor(private readonly options: WindowsSandboxCommandExecutorOptions) {
    this.launcher = options.launcher ?? new WindowsSandboxLauncher();
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
    if (!contractId.trim() || this.registered.has(contractId) || this.prepared.has(contractId)) throw new Error(`Invalid or duplicate Sandbox command contract: ${contractId}.`);
    if (!input.command.trim() || input.command.length > 100_000) throw new Error("Sandbox command must contain 1 through 100000 characters.");
    const payloadDigest = executionDigest({ kind: "shell.exec", shell: "powershell.exe", command: input.command });
    this.completed.delete(contractId);
    this.diagnostics.delete(contractId);
    this.registered.set(contractId, { command: input.command, settings: structuredClone(input.settings), context: structuredClone(input.context ?? {}), payloadDigest, ...(input.signal ? { signal: input.signal } : {}) });
    return { payloadDigest };
  }

  release(contractId: string) {
    this.registered.delete(contractId);
    this.prepared.delete(contractId);
  }

  takeResult(contractId: string) {
    const result = this.completed.get(contractId);
    this.completed.delete(contractId);
    return result ? structuredClone(result) : undefined;
  }

  takeDiagnostic(contractId: string) {
    const diagnostic = this.diagnostics.get(contractId);
    this.diagnostics.delete(contractId);
    return diagnostic ? structuredClone(diagnostic) : undefined;
  }

  async authorize({ workingDirectory, contract, lease }: Parameters<NonNullable<WindowsSandboxActionExecutor["authorize"]>>[0]) {
    const registration = this.requireRegistration(contract, lease);
    const settings = { ...registration.settings, workspaceRoot: workingDirectory };
    await (this.options.authorize ?? requireApproval)(settings, "shell.exec", "execute", {
      command: registration.command,
      cwd: "C:\\NexusCell",
      shell: "windows-sandbox:powershell.exe"
    }, registration.context);
    this.prepared.set(contract.id, { ...registration, workingDirectory });
  }

  async execute({ cell, contract, lease }: Parameters<WindowsSandboxActionExecutor["execute"]>[0]) {
    this.requireRegistration(contract, lease);
    const prepared = this.prepared.get(contract.id);
    if (!prepared) throw new Error(`Sandbox command was not admitted before execution: ${contract.id}.`);
    this.active.set(cell.id, prepared);
    try {
      return await this.broker.execute(contract, lease, () => this.launch(contract.id, prepared));
    } finally {
      this.active.delete(cell.id);
      this.release(contract.id);
    }
  }

  private requireRegistration(contract: ContractedAction, lease: CapabilityLease) {
    const registration = this.registered.get(contract.id) ?? this.prepared.get(contract.id);
    if (!registration) throw new Error(`No Sandbox command is registered for contract ${contract.id}.`);
    if (contract.action.kind !== "shell.exec" || contract.action.risk !== "execute") throw new Error("Sandbox commands require an execute-risk shell.exec contract.");
    if (contract.action.payloadDigest !== registration.payloadDigest) throw new Error("Sandbox command payload does not match its registration.");
    if (contract.leaseId !== lease.id || contract.cellId !== lease.cellId) throw new Error("Sandbox command contract and lease identities do not match.");
    if (!contract.capabilities.execute.includes("powershell.exe")) throw new Error("Sandbox command contract lacks powershell.exe capability.");
    return registration;
  }

  private async policy(contract: ContractedAction, lease: CapabilityLease) {
    let allowed = true;
    try { this.requireRegistration(contract, lease); } catch { allowed = false; }
    return {
      allowed,
      policyVersion: lease.policyVersion,
      reason: allowed ? "Registered command matches the Windows Sandbox contract." : "Registered command does not match the Windows Sandbox contract.",
      evidenceDigest: executionDigest({ policy: "windows-sandbox-command-v1", allowed, contractId: contract.id })
    };
  }

  private async launch(contractId: string, prepared: PreparedCommand): Promise<SandboxCommandResult> {
    const token = safeToken(contractId);
    const bootstrapScript = `nexus-${token}.bootstrap.ps1`;
    const completionFile = `nexus-${token}.result.json`;
    const bootstrapPath = path.join(prepared.workingDirectory, bootstrapScript);
    const resultPath = path.join(prepared.workingDirectory, completionFile);
    const encoded = Buffer.from(prepared.command, "utf16le").toString("base64");
    let diagnostic: SandboxCommandDiagnostic = { stage: "bootstrap-write", exitCode: null };
    this.diagnostics.set(contractId, diagnostic);
    try {
      await writeFile(bootstrapPath, bootstrap(encoded, completionFile), { encoding: "utf8", flag: "wx" });
      diagnostic = { stage: "sandbox-launch", exitCode: null };
      this.diagnostics.set(contractId, diagnostic);
      await this.launcher.launch({
        hostFolder: prepared.workingDirectory,
        configurationDirectory: this.options.configurationDirectory,
        bootstrapScript,
        completionFile,
        timeoutMs: 10 * 60_000,
        ...(prepared.signal ? { signal: prepared.signal } : {})
      });
      diagnostic = { stage: "result-read", exitCode: null };
      this.diagnostics.set(contractId, diagnostic);
      const content = await readFile(resultPath, "utf8");
      diagnostic = { stage: "result-parse", exitCode: null };
      this.diagnostics.set(contractId, diagnostic);
      const payload = parseWindowsSandboxJson<Partial<SandboxCommandResult> & { transportStatus?: unknown; transportStage?: unknown; transportErrorType?: unknown }>(content);
      if (payload.transportStatus === "failed") {
        diagnostic = {
          stage: "guest-bootstrap",
          exitCode: null,
          guestStage: safeDiagnosticValue(payload.transportStage),
          errorType: safeDiagnosticValue(payload.transportErrorType)
        };
        this.diagnostics.set(contractId, diagnostic);
        throw new Error("Sandbox guest bootstrap reported a transport failure.");
      }
      diagnostic = { stage: "result-validate", exitCode: Number.isInteger(payload.exitCode) ? payload.exitCode as number : null };
      this.diagnostics.set(contractId, diagnostic);
      if (!Number.isInteger(payload.exitCode) || typeof payload.stdout !== "string" || typeof payload.stderr !== "string" || payload.stdout.length > 10 * 1024 * 1024 || payload.stderr.length > 10 * 1024 * 1024) {
        throw new Error("Sandbox command returned an invalid or oversized result.");
      }
      const result = { exitCode: payload.exitCode as number, stdout: payload.stdout, stderr: payload.stderr };
      if (result.exitCode !== 0) {
        diagnostic = { stage: "guest-exit", exitCode: result.exitCode };
        this.diagnostics.set(contractId, diagnostic);
        throw new Error(`Sandbox command failed with exit code ${result.exitCode}.`);
      }
      this.completed.set(contractId, structuredClone(result));
      diagnostic = { stage: "complete", exitCode: result.exitCode };
      this.diagnostics.set(contractId, diagnostic);
      return result;
    } catch (error) {
      if (!diagnostic.errorType) {
        diagnostic = { ...diagnostic, errorType: safeDiagnosticValue(error instanceof Error ? error.name : typeof error) };
        this.diagnostics.set(contractId, diagnostic);
      }
      throw error;
    } finally {
      await Promise.all([bootstrapPath, resultPath].map((target) => rm(target, { force: true })));
    }
  }

  private async observe<T>(cellId: string, operation: () => Promise<T>): Promise<EffectObservation<T>> {
    const prepared = this.active.get(cellId);
    if (!prepared) throw new Error(`No Sandbox command is active for cell ${cellId}.`);
    const before = await workspaceState(prepared.workingDirectory);
    let outcome: EffectObservation<T>["outcome"];
    try { outcome = { status: "succeeded", value: await operation() }; }
    catch (error) { outcome = { status: "failed", errorDigest: executionDigest({ kind: "sandbox-command-failure", errorType: error instanceof Error ? error.name : typeof error }) }; }
    const after = await workspaceState(prepared.workingDirectory);
    return { outcome, effects: changedEffects(before, after, this.options.now?.() ?? new Date()) };
  }
}

function bootstrap(encodedCommand: string, completionFile: string) {
  return `$ErrorActionPreference = 'Stop'\n$stdoutPath = 'C:\\NexusCell\\.nexus-stdout.txt'\n$stderrPath = 'C:\\NexusCell\\.nexus-stderr.txt'\n$transportStage = 'process-execute'\ntry {\n  & powershell.exe -NoLogo -NoProfile -NonInteractive -EncodedCommand '${encodedCommand}' 1> $stdoutPath 2> $stderrPath\n  $exitCode = $LASTEXITCODE\n  $transportStage = 'output-read'\n  $stdout = Get-Content $stdoutPath -Raw -ErrorAction SilentlyContinue\n  $stderr = Get-Content $stderrPath -Raw -ErrorAction SilentlyContinue\n  if ($null -eq $stdout) { $stdout = '' }\n  if ($null -eq $stderr) { $stderr = '' }\n  $result = [ordered]@{ exitCode = $exitCode; stdout = [string]$stdout; stderr = [string]$stderr; transportStatus = 'completed'; transportStage = 'complete'; transportErrorType = $null }\n} catch {\n  $result = [ordered]@{ exitCode = $null; stdout = ''; stderr = ''; transportStatus = 'failed'; transportStage = $transportStage; transportErrorType = $_.Exception.GetType().FullName }\n} finally {\n  Remove-Item $stdoutPath,$stderrPath -Force -ErrorAction SilentlyContinue\n}\n[IO.File]::WriteAllText('C:\\NexusCell\\${completionFile}', ($result | ConvertTo-Json -Compress), [Text.UTF8Encoding]::new($false))\n`;
}

function safeDiagnosticValue(value: unknown) {
  return typeof value === "string" && /^[A-Za-z0-9_.-]{1,200}$/.test(value) ? value : "invalid";
}

async function workspaceState(root: string) {
  const output = await git(root, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]);
  const state = new Map<string, { kind: ObservedEffect["kind"]; digest?: string }>();
  for (const record of output.split("\0").filter(Boolean)) {
    const status = record.slice(0, 2);
    const target = record.slice(3).replaceAll("\\", "/");
    const kind = status === "??" ? "file.create" : status.includes("D") ? "file.delete" : "file.update";
    let digest: string | undefined;
    if (kind !== "file.delete") {
      const file = path.join(root, target);
      const details = await lstat(file).catch(() => undefined);
      if (details?.isFile()) digest = `sha256:${createHash("sha256").update(await readFile(file)).digest("hex")}`;
    }
    state.set(target, { kind, ...(digest ? { digest } : {}) });
  }
  return state;
}

function changedEffects(before: Map<string, { kind: ObservedEffect["kind"]; digest?: string }>, after: Map<string, { kind: ObservedEffect["kind"]; digest?: string }>, now: Date) {
  const effects: ObservedEffect[] = [];
  for (const [target, current] of after) {
    const previous = before.get(target);
    if (previous?.kind === current.kind && previous.digest === current.digest) continue;
    effects.push({ kind: current.kind, target, status: current.kind === "file.create" ? "created" : current.kind === "file.delete" ? "deleted" : "changed", observedAt: now.toISOString(), ...(previous?.digest ? { beforeDigest: previous.digest } : {}), ...(current.digest ? { afterDigest: current.digest } : {}) });
  }
  return effects.sort((left, right) => left.target.localeCompare(right.target));
}

function git(cwd: string, args: string[]) {
  return new Promise<string>((resolve, reject) => {
    const child = spawn("git", args, { cwd, windowsHide: true });
    let stdout = ""; let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code) => code === 0 ? resolve(stdout) : reject(new Error(`git status failed: ${stderr}`)));
  });
}

function safeToken(value: string) {
  const token = value.replace(/[^A-Za-z0-9_-]/g, "-").slice(0, 80);
  if (!token) throw new Error("Sandbox command identifier is invalid.");
  return token;
}

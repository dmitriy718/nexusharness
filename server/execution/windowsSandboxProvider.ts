import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { access, mkdir, realpath, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  cellSnapshotSchema,
  cellSpecSchema,
  executionCellSchema,
  executionDigest,
  type ActionReceipt,
  type CapabilityLease,
  type CellSpec,
  type CellState,
  type CommitReceipt,
  type ContractedAction,
  type EffectSet,
  type ExecutionCell,
  type ExecutionCellProvider
} from "./contracts.js";
import {
  PortableWorktreeProvider,
  type PortableActionExecutor,
  type PortableWorktreeProviderOptions
} from "./portableWorktreeProvider.js";

export const WINDOWS_SANDBOX_SESSION_QUERY = "$processes = @(Get-Process -Name 'WindowsSandboxRemoteSession' -ErrorAction SilentlyContinue); if ($processes.Count -gt 0) { $processes | Select-Object -ExpandProperty Id }; exit 0";

export interface WindowsSandboxProbe {
  launcherPresent: boolean;
  platformSupported: boolean;
  available: boolean;
  executable: string;
  reason: string;
}

export interface WindowsSandboxProcessRunner {
  run(executable: string, configurationPath: string, timeoutMs: number, signal?: AbortSignal): Promise<void>;
}

export interface WindowsSandboxLauncherOptions {
  executable?: string;
  platform?: NodeJS.Platform;
  runner?: WindowsSandboxProcessRunner;
  id?: () => string;
}

export interface WindowsSandboxLaunchInput {
  hostFolder: string;
  configurationDirectory: string;
  bootstrapScript: string;
  completionFile: string;
  memoryMb?: number;
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface WindowsSandboxActionExecutor extends PortableActionExecutor {
  readonly isolation: "windows-sandbox";
}

export interface WindowsSandboxProviderOptions extends Omit<PortableWorktreeProviderOptions, "actionExecutor"> {
  actionExecutor: WindowsSandboxActionExecutor;
}

export class WindowsSandboxProvider implements ExecutionCellProvider {
  readonly securityBoundary = true;
  readonly boundaryDescription = "Actions execute behind the HR-004-verified Windows Sandbox boundary; Git worktree staging provides effect inspection and atomic promotion.";
  private readonly transactions: PortableWorktreeProvider;

  constructor(options: WindowsSandboxProviderOptions) {
    if (options.actionExecutor.isolation !== "windows-sandbox") {
      throw new Error("Windows Sandbox cells require a Windows Sandbox-isolated action executor.");
    }
    this.transactions = new PortableWorktreeProvider(options);
  }

  async prepare(input: CellSpec): Promise<ExecutionCell> {
    const spec = cellSpecSchema.parse(input);
    if (spec.provider !== "windows-sandbox") throw new Error(`Windows Sandbox provider cannot prepare ${spec.provider} cells.`);
    const portableSpec = portableSpecFor(spec);
    return externalCell(await this.transactions.prepare(portableSpec), spec);
  }

  async authorize(cellId: string, contract: ContractedAction, lease: CapabilityLease) {
    await this.transactions.authorize(cellId, contract, lease);
  }

  execute(cellId: string, contract: ContractedAction, lease: CapabilityLease): Promise<ActionReceipt> {
    return this.transactions.execute(cellId, contract, lease);
  }

  async transition(cellId: string, nextState: CellState) {
    const cell = await this.transactions.transition(cellId, nextState);
    const { spec } = await this.transactions.inspect(cellId);
    return externalCell(cell, windowsSpecFor(spec));
  }

  async snapshot(cellId: string, reason: string) {
    const snapshot = await this.transactions.snapshot(cellId, reason);
    const [{ spec, cell }, effects] = await Promise.all([
      this.transactions.inspect(cellId),
      this.transactions.diff(cellId)
    ]);
    const mappedCell = externalCell(cell, windowsSpecFor(spec));
    return cellSnapshotSchema.parse({
      ...snapshot,
      state: mappedCell.state,
      stateDigest: executionDigest({ cell: mappedCell, effects })
    });
  }

  diff(cellId: string): Promise<EffectSet> {
    return this.transactions.diff(cellId);
  }

  commit(cellId: string, expectedBase: string, effectReceiptDigests: string[]): Promise<CommitReceipt> {
    return this.transactions.commit(cellId, expectedBase, effectReceiptDigests);
  }

  destroy(cellId: string) {
    return this.transactions.destroy(cellId);
  }

  async recover() {
    const recovered = await this.transactions.recover();
    return Promise.all(recovered.map(async (cell) => {
      const { spec } = await this.transactions.inspect(cell.id);
      return externalCell(cell, windowsSpecFor(spec));
    }));
  }
}

export class WindowsSandboxLauncher {
  readonly securityBoundary = true;
  readonly boundaryDescription = "Windows Sandbox virtualization with disabled network and redirection surfaces; real-host seed, writeback, identity, and egress isolation verified by HR-004.";
  private readonly executable: string;
  private readonly platform: NodeJS.Platform;
  private readonly runner: WindowsSandboxProcessRunner;
  private readonly id: () => string;

  constructor(options: WindowsSandboxLauncherOptions = {}) {
    this.platform = options.platform ?? process.platform;
    this.executable = path.resolve(options.executable ?? path.join(process.env.WINDIR ?? "C:\\Windows", "System32", "WindowsSandbox.exe"));
    this.runner = options.runner ?? new NativeWindowsSandboxRunner();
    this.id = options.id ?? randomUUID;
  }

  async probe(): Promise<WindowsSandboxProbe> {
    const platformSupported = this.platform === "win32";
    let launcherPresent = false;
    try {
      await access(this.executable);
      launcherPresent = true;
    } catch {
      launcherPresent = false;
    }
    const available = platformSupported && launcherPresent;
    return {
      launcherPresent,
      platformSupported,
      available,
      executable: this.executable,
      reason: available
        ? "Windows Sandbox launcher is present; real-host boundary verification is still required."
        : !platformSupported ? "Windows Sandbox requires a Windows host." : "Windows Sandbox launcher is not installed or enabled."
    };
  }

  async launch(input: WindowsSandboxLaunchInput) {
    const probe = await this.probe();
    if (!probe.available) throw new Error(probe.reason);
    const timeoutMs = boundedInteger(input.timeoutMs ?? 10 * 60_000, 10_000, 60 * 60_000, "timeoutMs");
    const memoryMb = boundedInteger(input.memoryMb ?? 4096, 2048, 32_768, "memoryMb");
    const bootstrapScript = bootstrapName(input.bootstrapScript);
    const completionFile = safeCellFileName(input.completionFile, "completionFile");
    const hostFolder = await existingDirectory(input.hostFolder, "hostFolder");
    if (path.dirname(hostFolder) === hostFolder) throw new Error("Windows Sandbox cannot map a filesystem root as its cell folder.");
    const bootstrapPath = path.join(hostFolder, bootstrapScript);
    const bootstrapStat = await stat(bootstrapPath).catch(() => undefined);
    if (!bootstrapStat?.isFile()) throw new Error(`Windows Sandbox bootstrap script does not exist: ${bootstrapScript}.`);
    const completionPath = path.join(hostFolder, completionFile);
    await rm(completionPath, { force: true });

    const configurationDirectory = path.resolve(input.configurationDirectory);
    await mkdir(configurationDirectory, { recursive: true });
    const configurationReal = await realpath(configurationDirectory);
    if (pathsOverlap(hostFolder, configurationReal)) throw new Error("Windows Sandbox configuration files must remain outside the mapped cell folder.");
    const configurationPath = path.join(configurationReal, `nexus-${safeId(this.id())}.wsb`);
    const profile = createWindowsSandboxProfile({ hostFolder, bootstrapScript, memoryMb });
    await writeFile(configurationPath, profile, { encoding: "utf8", flag: "wx" });
    try {
      const startedAt = Date.now();
      await this.runner.run(this.executable, configurationPath, timeoutMs, input.signal);
      const remainingMs = Math.max(1, timeoutMs - (Date.now() - startedAt));
      await waitForFile(completionPath, remainingMs, input.signal);
    } finally {
      await rm(configurationPath, { force: true });
    }
  }
}

export class NativeWindowsSandboxRunner implements WindowsSandboxProcessRunner {
  run(executable: string, configurationPath: string, timeoutMs: number, signal?: AbortSignal) {
    return new Promise<void>((resolve, reject) => {
      if (signal?.aborted) return reject(signal.reason ?? new Error("Windows Sandbox launch was aborted."));
      const child = spawn(executable, [configurationPath], {
        windowsHide: true,
        stdio: "ignore",
        env: { SystemRoot: process.env.SystemRoot, WINDIR: process.env.WINDIR }
      });
      let settled = false;
      const finish = (error?: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener("abort", abort);
        if (error) reject(error);
        else resolve();
      };
      const abort = () => {
        child.kill();
        finish(signal?.reason instanceof Error ? signal.reason : new Error("Windows Sandbox launch was aborted."));
      };
      const timer = setTimeout(() => {
        child.kill();
        finish(new Error(`Windows Sandbox exceeded its ${timeoutMs} ms deadline.`));
      }, timeoutMs);
      signal?.addEventListener("abort", abort, { once: true });
      child.once("error", (error) => finish(error));
      child.once("exit", (code, childSignal) => {
        if (code === 0) finish();
        else finish(new Error(`Windows Sandbox exited without success (code ${code ?? "none"}, signal ${childSignal ?? "none"}).`));
      });
    });
  }
}

export function createWindowsSandboxProfile(input: { hostFolder: string; bootstrapScript: string; memoryMb?: number }) {
  const hostFolder = path.resolve(input.hostFolder);
  if (!path.isAbsolute(input.hostFolder) || path.dirname(hostFolder) === hostFolder) throw new Error("Windows Sandbox hostFolder must be an absolute non-root path.");
  const bootstrapScript = bootstrapName(input.bootstrapScript);
  const memoryMb = boundedInteger(input.memoryMb ?? 4096, 2048, 32_768, "memoryMb");
  const command = `powershell.exe -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "C:\\NexusCell\\${bootstrapScript}"`;
  return [
    "<Configuration>",
    "  <vGPU>Disable</vGPU>",
    "  <Networking>Disable</Networking>",
    "  <AudioInput>Disable</AudioInput>",
    "  <VideoInput>Disable</VideoInput>",
    "  <PrinterRedirection>Disable</PrinterRedirection>",
    "  <ClipboardRedirection>Disable</ClipboardRedirection>",
    "  <ProtectedClient>Enable</ProtectedClient>",
    `  <MemoryInMB>${memoryMb}</MemoryInMB>`,
    "  <MappedFolders>",
    "    <MappedFolder>",
    `      <HostFolder>${xml(hostFolder)}</HostFolder>`,
    "      <SandboxFolder>C:\\NexusCell</SandboxFolder>",
    "      <ReadOnly>false</ReadOnly>",
    "    </MappedFolder>",
    "  </MappedFolders>",
    "  <LogonCommand>",
    `    <Command>${xml(command)}</Command>`,
    "  </LogonCommand>",
    "</Configuration>",
    ""
  ].join("\n");
}

export function parseWindowsSandboxJson<T>(content: string): T {
  return JSON.parse(content.replace(/^\uFEFF/, "")) as T;
}

export function parseWindowsSandboxSessionIds(stdout: string) {
  return new Set(stdout.split(/\r?\n/).map((value) => Number(value.trim())).filter((value) => Number.isSafeInteger(value) && value > 0));
}

function portableSpecFor(spec: CellSpec): CellSpec {
  return cellSpecSchema.parse({ ...spec, provider: "portable-worktree" });
}

function windowsSpecFor(spec: CellSpec): CellSpec {
  return cellSpecSchema.parse({ ...spec, provider: "windows-sandbox" });
}

function externalCell(cell: ExecutionCell, spec: CellSpec) {
  return executionCellSchema.parse({
    ...cell,
    provider: "windows-sandbox",
    providerRef: `windows-sandbox:${cell.id}`,
    specDigest: executionDigest(spec)
  });
}

async function existingDirectory(value: string, label: string) {
  const resolved = path.resolve(value);
  const details = await stat(resolved).catch(() => undefined);
  if (!details?.isDirectory()) throw new Error(`Windows Sandbox ${label} must be an existing directory.`);
  return realpath(resolved);
}

function bootstrapName(value: string) {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,199}\.ps1$/i.test(value) || path.basename(value) !== value) {
    throw new Error("Windows Sandbox bootstrapScript must be one safe .ps1 filename.");
  }
  return value;
}

function safeCellFileName(value: string, label: string) {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/.test(value) || path.basename(value) !== value) {
    throw new Error(`Windows Sandbox ${label} must be one safe filename.`);
  }
  return value;
}

function boundedInteger(value: number, minimum: number, maximum: number, label: string) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`Windows Sandbox ${label} must be an integer from ${minimum} through ${maximum}.`);
  }
  return value;
}

function safeId(value: string) {
  const normalized = value.replace(/[^A-Za-z0-9_-]/g, "-").slice(0, 100);
  if (!normalized) throw new Error("Windows Sandbox configuration identifier is invalid.");
  return normalized;
}

function pathsOverlap(left: string, right: string) {
  const relativeLeft = path.relative(left, right);
  const relativeRight = path.relative(right, left);
  return relativeLeft === "" || (!relativeLeft.startsWith("..") && !path.isAbsolute(relativeLeft)) || (!relativeRight.startsWith("..") && !path.isAbsolute(relativeRight));
}

function xml(value: string) {
  // XML 1.0 forbids these exact control-code ranges.
  // eslint-disable-next-line no-control-regex
  if (/[ -\x08\x0B\x0C\x0E-\x1F]/.test(value)) throw new Error("Windows Sandbox profile values cannot contain XML control characters.");
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&apos;");
}

async function waitForFile(filePath: string, timeoutMs: number, signal?: AbortSignal) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (signal?.aborted) throw signal.reason ?? new Error("Windows Sandbox launch was aborted.");
    try {
      const details = await stat(filePath);
      if (details.isFile()) return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Windows Sandbox did not create its completion file within ${timeoutMs} ms.`);
}

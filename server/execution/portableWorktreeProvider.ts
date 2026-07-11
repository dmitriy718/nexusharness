import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import {
  lstat,
  mkdir,
  readFile,
  readdir,
  readlink,
  realpath,
  rename,
  rm,
  stat,
  writeFile
} from "node:fs/promises";
import path from "node:path";
import {
  actionReceiptSchema,
  assertCellTransition,
  canTransitionCell,
  cellSnapshotSchema,
  cellSpecSchema,
  commitReceiptSchema,
  effectSetSchema,
  executionCellSchema,
  executionDigest,
  observedEffectSchema,
  type ActionReceipt,
  type CapabilityLease,
  type CellSnapshot,
  type CellSpec,
  type CellState,
  type CommitReceipt,
  type ContractedAction,
  type EffectSet,
  type ExecutionCell,
  type ExecutionCellProvider,
  type ObservedEffect
} from "./contracts.js";

export interface PortableActionExecutor {
  authorize?(input: { cell: ExecutionCell; workingDirectory: string; contract: ContractedAction; lease: CapabilityLease }): Promise<void>;
  execute(input: { cell: ExecutionCell; workingDirectory: string; contract: ContractedAction; lease: CapabilityLease }): Promise<ActionReceipt>;
}

export interface PortableWorktreeProviderOptions {
  workspaceRoot: string;
  dataRoot: string;
  actionExecutor: PortableActionExecutor;
  now?: () => Date;
  id?: () => string;
}

interface StoredCell {
  schemaVersion: 1;
  spec: CellSpec;
  cell: ExecutionCell;
  worktreePath: string;
  candidateRevision?: string;
}

export class PortableWorktreeProvider implements ExecutionCellProvider {
  readonly securityBoundary = false;
  readonly boundaryDescription = "Disposable Git worktree transaction isolation; not a hostile-code security sandbox.";
  private readonly workspaceRoot: string;
  private readonly dataRoot: string;
  private readonly worktreesRoot: string;
  private readonly recordsRoot: string;
  private readonly locksRoot: string;
  private readonly hooksRoot: string;
  private readonly now: () => Date;
  private readonly id: () => string;
  private initialized = false;

  constructor(private readonly options: PortableWorktreeProviderOptions) {
    this.workspaceRoot = path.resolve(options.workspaceRoot);
    this.dataRoot = path.resolve(options.dataRoot);
    this.worktreesRoot = path.join(this.dataRoot, "worktrees");
    this.recordsRoot = path.join(this.dataRoot, "records");
    this.locksRoot = path.join(this.dataRoot, "locks");
    this.hooksRoot = path.join(this.dataRoot, "empty-hooks");
    this.now = options.now ?? (() => new Date());
    this.id = options.id ?? randomUUID;
  }

  async prepare(input: CellSpec): Promise<ExecutionCell> {
    await this.initialize();
    const parsed = cellSpecSchema.parse(input);
    if (parsed.provider !== "portable-worktree") throw new Error(`Portable provider cannot prepare ${parsed.provider} cells.`);
    if (parsed.workspaceRootDigest !== portableWorkspaceDigest(this.workspaceRoot)) throw new Error("Cell workspace digest does not match the configured repository.");
    return this.withCellLock(parsed.id, async () => {
      if (await exists(this.recordPath(parsed.id))) throw new Error(`Execution cell already exists: ${parsed.id}`);
      await this.assertPrimaryClean();
      const actualBase = await this.revision(parsed.baseRevision, this.workspaceRoot);
      const currentBase = await this.revision("HEAD", this.workspaceRoot);
      if (actualBase !== currentBase) throw new Error(`Cell base ${actualBase} is not the current primary revision ${currentBase}.`);
      const spec = cellSpecSchema.parse({ ...parsed, baseRevision: actualBase });
      const worktreePath = this.safeWorktreePath(spec.id);
      let added = false;
      try {
        await this.runGit(this.workspaceRoot, ["worktree", "add", "--detach", "--lock", "--reason", `NexusHarness cell ${spec.id}`, worktreePath, actualBase]);
        added = true;
        const preparedAt = this.now().toISOString();
        const cell = executionCellSchema.parse({
          schemaVersion: 1,
          id: spec.id,
          specDigest: executionDigest(spec),
          provider: "portable-worktree",
          providerRef: `portable-worktree:${spec.id}`,
          baseRevision: actualBase,
          state: "isolated",
          preparedAt,
          updatedAt: preparedAt
        });
        await this.writeRecord({ schemaVersion: 1, spec, cell, worktreePath });
        return cell;
      } catch (error) {
        if (added) await this.removeOwnedWorktree(worktreePath, spec.id);
        throw error;
      }
    });
  }

  async execute(cellId: string, contract: ContractedAction, lease: CapabilityLease): Promise<ActionReceipt> {
    await this.initialize();
    return this.withCellLock(cellId, async () => {
      const record = await this.readRecord(cellId);
      if (record.cell.state !== "isolated" && record.cell.state !== "executing") throw new Error(`Cell ${cellId} cannot execute from ${record.cell.state}.`);
      if (contract.cellId !== cellId || lease.cellId !== cellId || contract.leaseId !== lease.id) throw new Error("Contract, lease, and portable cell identities do not match.");
      if (record.cell.state !== "executing") await this.updateState(record, "executing");
      try {
        const receipt = actionReceiptSchema.parse(await this.options.actionExecutor.execute({ cell: record.cell, workingDirectory: record.worktreePath, contract, lease }));
        if (receipt.cellId !== cellId || receipt.contractId !== contract.id) throw new Error("Action receipt identity does not match the portable cell execution.");
        await this.updateState(record, receipt.status === "succeeded" ? "verifying" : "failed");
        return receipt;
      } catch (error) {
        if (record.cell.state === "executing") await this.updateState(record, "failed");
        throw error;
      }
    });
  }

  async authorize(cellId: string, contract: ContractedAction, lease: CapabilityLease): Promise<void> {
    await this.initialize();
    await this.withCellLock(cellId, async () => {
      const record = await this.readRecord(cellId);
      if (record.cell.state !== "isolated" && record.cell.state !== "verifying") {
        throw new Error(`Cell ${cellId} cannot authorize execution from ${record.cell.state}.`);
      }
      if (contract.cellId !== cellId || lease.cellId !== cellId || contract.leaseId !== lease.id) {
        throw new Error("Contract, lease, and portable cell identities do not match.");
      }
      await this.options.actionExecutor.authorize?.({ cell: record.cell, workingDirectory: record.worktreePath, contract, lease });
    });
  }

  async transition(cellId: string, nextState: CellState) {
    await this.initialize();
    return this.withCellLock(cellId, async () => {
      const record = await this.readRecord(cellId);
      await this.updateState(record, nextState);
      return record.cell;
    });
  }

  async snapshot(cellId: string, reason: string): Promise<CellSnapshot> {
    await this.initialize();
    return this.withCellLock(cellId, async () => {
      const record = await this.readRecord(cellId);
      if (record.cell.state === "destroyed") throw new Error("Destroyed cells cannot be snapshotted.");
      const effects = await this.buildEffectSet(record);
      return cellSnapshotSchema.parse({
        schemaVersion: 1,
        id: this.id(),
        cellId,
        state: record.cell.state,
        reason,
        stateDigest: executionDigest({ cell: record.cell, effects }),
        createdAt: this.now().toISOString()
      });
    });
  }

  async diff(cellId: string): Promise<EffectSet> {
    await this.initialize();
    return this.withCellLock(cellId, async () => this.buildEffectSet(await this.readRecord(cellId)));
  }

  async commit(cellId: string, expectedBase: string, effectReceiptDigests: string[] = []): Promise<CommitReceipt> {
    await this.initialize();
    return this.withCellLock(cellId, async () => {
      const record = await this.readRecord(cellId);
      if (record.cell.state !== "ready_to_commit") throw new Error(`Cell ${cellId} cannot commit from ${record.cell.state}.`);
      const actualBase = await this.revision("HEAD", this.workspaceRoot);
      const resolvedExpected = await this.revision(expectedBase, this.workspaceRoot);
      if (!effectReceiptDigests.length) throw new Error("Commit requires at least one verified action-receipt digest.");
      const reject = (reason: string, currentBase = actualBase) => commitReceiptSchema.parse({
        schemaVersion: 1,
        id: this.id(),
        cellId,
        status: "rejected",
        expectedBase: resolvedExpected,
        actualBase: currentBase,
        effectReceiptDigests,
        committedAt: this.now().toISOString(),
        reason
      });
      if (resolvedExpected !== record.cell.baseRevision || actualBase !== resolvedExpected) return reject("Primary revision changed after the cell was prepared.");
      if (!(await this.primaryClean())) return reject("Primary workspace contains uncommitted or untracked changes.");
      if (!record.candidateRevision) {
        const effects = await this.buildEffectSet(record);
        if (!effects.effects.length) return reject("Cell contains no observable file effects to commit.");
        await this.runGit(record.worktreePath, ["add", "-A"]);
        const staged = await this.runGit(record.worktreePath, ["diff", "--cached", "--quiet"], [0, 1]);
        if (staged.code === 0) return reject("Cell contains no staged changes to commit.");
        await this.runGit(record.worktreePath, ["commit", "-m", `NexusHarness cell ${cellId}`]);
        record.candidateRevision = await this.revision("HEAD", record.worktreePath);
        await this.writeRecord(record);
      } else if ((await this.runGit(record.worktreePath, ["status", "--porcelain=v1", "--untracked-files=all"])).stdout) {
        return reject("Cell changed after its candidate revision was created.");
      }

      const beforeMerge = await this.revision("HEAD", this.workspaceRoot);
      if (beforeMerge !== resolvedExpected || !(await this.primaryClean())) return reject("Primary workspace changed before atomic promotion.", beforeMerge);
      const merge = await this.runGit(this.workspaceRoot, ["merge", "--ff-only", "--no-edit", record.candidateRevision], [0, 1, 128]);
      if (merge.code !== 0) return reject("Fast-forward promotion was rejected; the primary workspace was not modified by NexusHarness.", await this.revision("HEAD", this.workspaceRoot));
      const resultingRevision = await this.revision("HEAD", this.workspaceRoot);
      if (resultingRevision !== record.candidateRevision) throw new Error("Git reported a successful promotion but the primary revision does not match the candidate.");
      await this.updateState(record, "committed");
      return commitReceiptSchema.parse({
        schemaVersion: 1,
        id: this.id(),
        cellId,
        status: "committed",
        expectedBase: resolvedExpected,
        actualBase: resolvedExpected,
        resultingRevision,
        effectReceiptDigests,
        committedAt: this.now().toISOString(),
        reason: "Verified cell promoted by fast-forward from the expected primary revision."
      });
    });
  }

  async destroy(cellId: string): Promise<void> {
    await this.initialize();
    await this.withCellLock(cellId, async () => {
      const record = await this.readRecord(cellId);
      this.assertOwnedWorktree(record.worktreePath, cellId);
      if (await exists(record.worktreePath)) await this.removeOwnedWorktree(record.worktreePath, cellId);
      if (record.cell.state !== "destroyed") {
        if (!canTransitionCell(record.cell.state, "destroyed")) {
          if (canTransitionCell(record.cell.state, "rolled_back")) await this.updateState(record, "rolled_back");
          else if (canTransitionCell(record.cell.state, "failed")) await this.updateState(record, "failed");
        }
        await this.updateState(record, "destroyed");
      }
    });
  }

  async recover() {
    await this.initialize();
    const recovered: ExecutionCell[] = [];
    for (const name of (await readdir(this.recordsRoot)).filter((item) => item.endsWith(".json")).sort()) {
      const cellId = name.slice(0, -5);
      await this.withCellLock(cellId, async () => {
        const record = await this.readRecord(cellId);
        if (["destroyed", "committed", "rolled_back", "failed"].includes(record.cell.state)) {
          recovered.push(record.cell);
          return;
        }
        const worktreeAvailable = await exists(record.worktreePath) && (await this.runGit(record.worktreePath, ["rev-parse", "--is-inside-work-tree"], [0, 128])).code === 0;
        if (!worktreeAvailable || ["preparing", "executing", "verifying"].includes(record.cell.state)) await this.updateState(record, "failed");
        recovered.push(record.cell);
      });
    }
    return recovered;
  }

  private async initialize() {
    if (this.initialized) return;
    if (pathsOverlap(this.workspaceRoot, this.dataRoot)) throw new Error("Portable cell data must be outside the primary repository.");
    const [workspaceReal, prospectiveDataReal] = await Promise.all([realpath(this.workspaceRoot), prospectiveRealPath(this.dataRoot)]);
    if (pathsOverlap(workspaceReal, prospectiveDataReal)) throw new Error("Portable cell data resolves inside the primary repository.");
    await mkdir(this.dataRoot, { recursive: true });
    const dataReal = await realpath(this.dataRoot);
    if (pathsOverlap(workspaceReal, dataReal)) throw new Error("Portable cell data resolves inside the primary repository.");
    await Promise.all([this.worktreesRoot, this.recordsRoot, this.locksRoot, this.hooksRoot].map((directory) => mkdir(directory, { recursive: true })));
    const topLevel = path.resolve((await this.runGit(this.workspaceRoot, ["rev-parse", "--show-toplevel"])).stdout.trim());
    if (!samePath(topLevel, workspaceReal)) throw new Error("Portable provider workspaceRoot must be the Git repository root.");
    this.initialized = true;
  }

  private async buildEffectSet(record: StoredCell) {
    if (record.cell.state === "destroyed") throw new Error("Destroyed cells have no live effect set.");
    this.assertOwnedWorktree(record.worktreePath, record.cell.id);
    const output = (await this.runGit(record.worktreePath, ["status", "--porcelain=v1", "-z", "--untracked-files=all"])).stdout;
    const entries = parsePorcelain(output);
    const effects: ObservedEffect[] = [];
    const observedAt = this.now().toISOString();
    for (const entry of entries) {
      if (entry.kind === "rename") {
        effects.push(await this.fileEffect(record, "file.delete", entry.source!, observedAt));
        effects.push(await this.fileEffect(record, "file.create", entry.target, observedAt));
      } else {
        effects.push(await this.fileEffect(record, entry.kind, entry.target, observedAt));
      }
    }
    effects.sort((left, right) => `${left.target}:${left.kind}`.localeCompare(`${right.target}:${right.kind}`));
    return effectSetSchema.parse({
      schemaVersion: 1,
      cellId: record.cell.id,
      baseRevision: record.cell.baseRevision,
      capturedAt: observedAt,
      effects,
      effectsDigest: executionDigest(effects)
    });
  }

  private async fileEffect(record: StoredCell, kind: "file.create" | "file.update" | "file.delete", target: string, observedAt: string) {
    const before = kind === "file.create" ? undefined : await this.gitBlob(record.cell.baseRevision, target);
    const after = kind === "file.delete" ? undefined : await this.worktreeBlob(record, target);
    const actualKind = before === undefined ? "file.create" : after === undefined ? "file.delete" : "file.update";
    return observedEffectSchema.parse({
      kind: actualKind,
      target,
      status: actualKind === "file.create" ? "created" : actualKind === "file.delete" ? "deleted" : "changed",
      observedAt,
      ...(before ? { beforeDigest: hash(before) } : {}),
      ...(after ? { afterDigest: hash(after) } : {}),
      bytesChanged: Math.abs((after?.byteLength ?? 0) - (before?.byteLength ?? 0))
    });
  }

  private async gitBlob(revision: string, target: string) {
    const result = await this.runGit(this.workspaceRoot, ["cat-file", "blob", `${revision}:${target}`], [0, 128]);
    return result.code === 0 ? result.buffer : undefined;
  }

  private async worktreeBlob(record: StoredCell, target: string) {
    const filePath = path.resolve(record.worktreePath, target);
    if (!isInside(record.worktreePath, filePath)) throw new Error(`Effect target escapes the cell worktree: ${target}`);
    try {
      const details = await lstat(filePath);
      if (details.isSymbolicLink()) return Buffer.from(await readlink(filePath), "utf8");
      if (!details.isFile()) return undefined;
      if (details.size > 20 * 1024 * 1024) throw new Error(`Effect file exceeds the 20 MB portable-provider inspection limit: ${target}`);
      return readFile(filePath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
  }

  private async updateState(record: StoredCell, state: CellState) {
    assertCellTransition(record.cell.state, state);
    record.cell = executionCellSchema.parse({ ...record.cell, state, updatedAt: this.now().toISOString() });
    await this.writeRecord(record);
  }

  private async readRecord(cellId: string): Promise<StoredCell> {
    const raw = JSON.parse(await readFile(this.recordPath(cellId), "utf8"));
    const spec = cellSpecSchema.parse(raw.spec);
    const cell = executionCellSchema.parse(raw.cell);
    if (cell.id !== cellId || spec.id !== cellId) throw new Error(`Cell record identity mismatch: ${cellId}`);
    if (spec.provider !== cell.provider || spec.baseRevision !== cell.baseRevision || cell.specDigest !== executionDigest(spec)) throw new Error(`Cell record contract is inconsistent: ${cellId}`);
    const worktreePath = this.safeWorktreePath(cellId);
    if (!samePath(raw.worktreePath, worktreePath)) throw new Error(`Cell record path is outside provider ownership: ${cellId}`);
    const candidateRevision = raw.candidateRevision ? String(raw.candidateRevision) : undefined;
    if (candidateRevision && !/^[a-f0-9]{40,64}$/i.test(candidateRevision)) throw new Error(`Cell candidate revision is invalid: ${cellId}`);
    return { schemaVersion: 1, spec, cell, worktreePath, ...(candidateRevision ? { candidateRevision } : {}) };
  }

  private async writeRecord(record: StoredCell) {
    const destination = this.recordPath(record.cell.id);
    const temporary = `${destination}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(temporary, JSON.stringify(record, null, 2) + "\n", "utf8");
    await rename(temporary, destination);
  }

  private recordPath(cellId: string) {
    const validated = portableCellId(cellId);
    const destination = path.join(this.recordsRoot, `${validated}.json`);
    if (!isInside(this.recordsRoot, destination)) throw new Error(`Invalid cell record path: ${cellId}`);
    return destination;
  }

  private safeWorktreePath(cellId: string) {
    const destination = path.join(this.worktreesRoot, portableCellId(cellId));
    if (!isInside(this.worktreesRoot, destination)) throw new Error(`Invalid cell worktree path: ${cellId}`);
    return destination;
  }

  private assertOwnedWorktree(worktreePath: string, cellId: string) {
    if (!samePath(worktreePath, this.safeWorktreePath(cellId))) throw new Error(`Refusing to operate on an unowned worktree: ${worktreePath}`);
  }

  private async removeOwnedWorktree(worktreePath: string, cellId: string) {
    this.assertOwnedWorktree(worktreePath, cellId);
    await this.runGit(this.workspaceRoot, ["worktree", "unlock", worktreePath], [0, 128]);
    await this.runGit(this.workspaceRoot, ["worktree", "remove", "--force", worktreePath]);
    if (await exists(worktreePath)) throw new Error(`Git did not remove owned worktree: ${cellId}`);
  }

  private async assertPrimaryClean() {
    if (!(await this.primaryClean())) throw new Error("Primary workspace must be clean before preparing a portable cell.");
  }

  private async primaryClean() {
    return !(await this.runGit(this.workspaceRoot, ["status", "--porcelain=v1", "--untracked-files=all"])).stdout;
  }

  private async revision(value: string, cwd: string) {
    return (await this.runGit(cwd, ["rev-parse", "--verify", `${value}^{commit}`])).stdout.trim().toLowerCase();
  }

  private async withCellLock<T>(cellId: string, operation: () => Promise<T>) {
    await mkdir(this.locksRoot, { recursive: true });
    const lockPath = path.join(this.locksRoot, `${portableCellId(cellId)}.lock`);
    if (!isInside(this.locksRoot, lockPath)) throw new Error(`Invalid cell lock path: ${cellId}`);
    let acquired = false;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      try {
        await mkdir(lockPath);
        acquired = true;
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        const details = await stat(lockPath);
        if (Date.now() - details.mtimeMs > 5 * 60 * 1000) throw new Error(`Cell lock is stale and requires explicit recovery: ${cellId}`);
        await new Promise((resolveWait) => setTimeout(resolveWait, 50));
      }
    }
    if (!acquired) throw new Error(`Timed out waiting for cell lock: ${cellId}`);
    try {
      return await operation();
    } finally {
      await rm(lockPath, { recursive: true, force: true });
    }
  }

  private runGit(cwd: string, args: string[], allowedCodes = [0]) {
    const gitArgs = ["-c", `core.hooksPath=${this.hooksRoot}`, "-c", "commit.gpgSign=false", ...args];
    return new Promise<{ code: number; stdout: string; stderr: string; buffer: Buffer }>((resolveRun, reject) => {
      const child = spawn("git", gitArgs, {
        cwd,
        windowsHide: true,
        env: {
          ...process.env,
          GIT_CONFIG_NOSYSTEM: "1",
          GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null",
          GIT_TERMINAL_PROMPT: "0",
          GIT_LFS_SKIP_SMUDGE: "1",
          GIT_EDITOR: "true",
          GIT_MERGE_AUTOEDIT: "no",
          GIT_AUTHOR_NAME: "NexusHarness",
          GIT_AUTHOR_EMAIL: "nexusharness@local.invalid",
          GIT_COMMITTER_NAME: "NexusHarness",
          GIT_COMMITTER_EMAIL: "nexusharness@local.invalid"
        }
      });
      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      let bytes = 0;
      const collect = (target: Buffer[]) => (chunk: Buffer) => {
        bytes += chunk.length;
        if (bytes > 20 * 1024 * 1024) child.kill();
        else target.push(chunk);
      };
      child.stdout.on("data", collect(stdout));
      child.stderr.on("data", collect(stderr));
      child.on("error", reject);
      child.on("close", (code) => {
        const output = Buffer.concat(stdout);
        const error = Buffer.concat(stderr).toString("utf8");
        const exitCode = code ?? -1;
        if (bytes > 20 * 1024 * 1024) reject(new Error("Git output exceeded the 20 MB provider limit."));
        else if (!allowedCodes.includes(exitCode)) reject(new Error(`git ${args[0]} failed (${exitCode}): ${error || output.toString("utf8")}`));
        else resolveRun({ code: exitCode, stdout: output.toString("utf8"), stderr: error, buffer: output });
      });
    });
  }
}

export function portableWorkspaceDigest(workspaceRoot: string) {
  let normalized = path.resolve(workspaceRoot).replaceAll("\\", "/");
  if (process.platform === "win32") normalized = normalized.toLowerCase();
  return executionDigest({ workspaceRoot: normalized });
}

function parsePorcelain(output: string) {
  const tokens = output.split("\0").filter(Boolean);
  const entries: Array<{ kind: "file.create" | "file.update" | "file.delete" | "rename"; target: string; source?: string }> = [];
  for (let index = 0; index < tokens.length; index += 1) {
    const record = tokens[index];
    if (record.length < 4 || record[2] !== " ") throw new Error("Unexpected Git porcelain record.");
    const status = record.slice(0, 2);
    const target = record.slice(3).replaceAll("\\", "/");
    if (status.includes("R")) {
      const source = tokens[++index]?.replaceAll("\\", "/");
      if (!source) throw new Error("Git rename record is missing its source path.");
      entries.push({ kind: "rename", target, source });
    } else if (status.includes("C") || status === "??") {
      if (status.includes("C")) index += 1;
      entries.push({ kind: "file.create", target });
    } else if (status.includes("D")) {
      entries.push({ kind: "file.delete", target });
    } else {
      entries.push({ kind: "file.update", target });
    }
  }
  return entries;
}

function portableCellId(value: string) {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/.test(value)) throw new Error(`Invalid portable execution cell identifier: ${value}`);
  return value;
}

function pathsOverlap(left: string, right: string) {
  return samePath(left, right) || isInside(left, right) || isInside(right, left);
}

function isInside(parent: string, child: string) {
  const relative = path.relative(path.resolve(parent), path.resolve(child));
  return Boolean(relative) && !relative.startsWith("..") && !path.isAbsolute(relative);
}

function samePath(left: string, right: string) {
  const a = path.resolve(left);
  const b = path.resolve(right);
  return process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
}

async function exists(target: string) {
  try {
    await stat(target);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

async function prospectiveRealPath(target: string) {
  let cursor = path.resolve(target);
  const missing: string[] = [];
  while (!(await exists(cursor))) {
    const parent = path.dirname(cursor);
    if (parent === cursor) throw new Error(`Cannot resolve a parent for portable data path: ${target}`);
    missing.unshift(path.basename(cursor));
    cursor = parent;
  }
  return path.resolve(await realpath(cursor), ...missing);
}

function hash(value: Buffer) {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

import { afterEach, describe, expect, it } from "vitest";
import { access, mkdir, mkdtemp, readFile, rm, symlink, unlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import {
  actionReceiptSchema,
  capabilityLeaseSchema,
  cellSpecSchema,
  contractedActionSchema,
  executionDigest,
  type ActionReceipt
} from "../server/execution/contracts";
import {
  PortableWorktreeProvider,
  portableWorkspaceDigest,
  type PortableActionExecutor
} from "../server/execution/portableWorktreeProvider";

const digest = `sha256:${"a".repeat(64)}`;
const sandboxes: string[] = [];

afterEach(async () => {
  await Promise.all(sandboxes.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("portable transactional worktree provider", () => {
  it("prepares one locked detached worktree without changing the primary workspace", async () => {
    const fixture = await repository();
    const provider = fixture.provider();
    const cell = await provider.prepare(fixture.spec());

    expect(provider.securityBoundary).toBe(false);
    expect(provider.boundaryDescription).toContain("not a hostile-code security sandbox");
    expect(cell).toMatchObject({ id: "cell-1", state: "isolated", provider: "portable-worktree", baseRevision: fixture.base });
    expect(await readFile(join(fixture.data, "worktrees", "cell-1", "tracked.txt"), "utf8")).toBe("base\n");
    expect(await git(fixture.root, ["status", "--porcelain"])).toBe("");
    const worktrees = await git(fixture.root, ["worktree", "list", "--porcelain"]);
    expect(worktrees).toContain("detached");
    expect(worktrees).toContain("locked NexusHarness cell cell-1");
  });

  it("admits exactly one of two concurrent preparations for one cell", async () => {
    const fixture = await repository();
    const provider = fixture.provider();
    const attempts = await Promise.allSettled([provider.prepare(fixture.spec()), provider.prepare(fixture.spec())]);
    expect(attempts.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(attempts.filter((result) => result.status === "rejected")).toHaveLength(1);
  });

  it("refuses dirty primary state and cell data inside the repository", async () => {
    const fixture = await repository();
    await writeFile(join(fixture.root, "untracked.txt"), "operator work", "utf8");
    await expect(fixture.provider().prepare(fixture.spec())).rejects.toThrow("must be clean");
    await unlink(join(fixture.root, "untracked.txt"));

    const nestedData = join(fixture.root, ".nexusharness", "cells");
    const nested = fixture.provider({ dataRoot: nestedData });
    await expect(nested.prepare(fixture.spec())).rejects.toThrow("outside the primary repository");
    await expect(access(nestedData)).rejects.toThrow();
  });

  it("resolves data-directory links before creating provider subdirectories", async () => {
    const fixture = await repository();
    const linkedRoot = join(fixture.sandbox, "linked-repository");
    await symlink(fixture.root, linkedRoot, process.platform === "win32" ? "junction" : "dir");
    const linkedData = join(linkedRoot, "portable-cells");
    await expect(fixture.provider({ dataRoot: linkedData }).prepare(fixture.spec())).rejects.toThrow("resolves inside");
    await expect(access(join(fixture.root, "portable-cells"))).rejects.toThrow();
  });

  it("inventories create, update, delete, and rename effects while the primary remains unchanged", async () => {
    const fixture = await repository();
    const provider = fixture.provider();
    await provider.prepare(fixture.spec());
    const worktree = join(fixture.data, "worktrees", "cell-1");
    await writeFile(join(worktree, "tracked.txt"), "changed\n", "utf8");
    await unlink(join(worktree, "delete-me.txt"));
    await writeFile(join(worktree, "new file.txt"), "new\n", "utf8");
    await git(worktree, ["mv", "rename-me.txt", "renamed.txt"]);

    const effects = await provider.diff("cell-1");
    expect(effects.effects).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "file.update", target: "tracked.txt", status: "changed" }),
      expect.objectContaining({ kind: "file.delete", target: "delete-me.txt", status: "deleted" }),
      expect.objectContaining({ kind: "file.create", target: "new file.txt", status: "created" }),
      expect.objectContaining({ kind: "file.delete", target: "rename-me.txt" }),
      expect.objectContaining({ kind: "file.create", target: "renamed.txt" })
    ]));
    expect(effects.effectsDigest).toBe(executionDigest(effects.effects));
    expect(await readFile(join(fixture.root, "tracked.txt"), "utf8")).toBe("base\n");
    expect(await readFile(join(fixture.root, "delete-me.txt"), "utf8")).toBe("delete\n");
    await expect(access(join(fixture.root, "new file.txt"))).rejects.toThrow();
  });

  it("executes only matching contract identities and advances from isolated through verifying", async () => {
    const receipts: ActionReceipt[] = [];
    const fixture = await repository({ executor: executor(async ({ workingDirectory, contract }) => {
      await writeFile(join(workingDirectory, "generated.txt"), "generated\n", "utf8");
      const receipt = actionReceipt(contract.id, contract.cellId, "succeeded");
      receipts.push(receipt);
      return receipt;
    }) });
    const provider = fixture.provider();
    await provider.prepare(fixture.spec());
    const receipt = await provider.execute("cell-1", contract(), lease());
    expect(receipt.status).toBe("succeeded");
    expect(receipts).toHaveLength(1);
    expect((await provider.snapshot("cell-1", "Inspect execution state")).state).toBe("verifying");
    expect(await readFile(join(fixture.root, "tracked.txt"), "utf8")).toBe("base\n");
    await expect(provider.execute("cell-1", contract({ cellId: "cell-2" }), lease())).rejects.toThrow("cannot execute from verifying");
  });

  it("runs action admission inside the cell context without changing isolated state on rejection", async () => {
    let executeCalls = 0;
    let admittedWorkspace = "";
    const fixture = await repository({ executor: {
      async authorize({ workingDirectory }) {
        admittedWorkspace = workingDirectory;
        throw new Error("Approval required for file.write.");
      },
      async execute({ contract: input }) {
        executeCalls += 1;
        return actionReceipt(input.id, input.cellId, "succeeded");
      }
    } });
    const provider = fixture.provider();
    await provider.prepare(fixture.spec());
    await expect(provider.authorize("cell-1", contract(), lease())).rejects.toThrow("Approval required");
    expect(admittedWorkspace).toBe(join(fixture.data, "worktrees", "cell-1"));
    expect((await provider.snapshot("cell-1", "After rejected admission")).state).toBe("isolated");
    expect(executeCalls).toBe(0);
  });

  it("creates an observation snapshot without claiming restorable VM state", async () => {
    const fixture = await repository();
    const provider = fixture.provider();
    await provider.prepare(fixture.spec());
    await writeFile(join(fixture.data, "worktrees", "cell-1", "tracked.txt"), "changed\n", "utf8");
    const snapshot = await provider.snapshot("cell-1", "Before verification");
    expect(snapshot).toMatchObject({ cellId: "cell-1", state: "isolated", reason: "Before verification" });
    expect(snapshot.stateDigest).toMatch(/^sha256:/);
    expect(snapshot.providerSnapshotRef).toBeUndefined();
  });

  it("returns mutation-safe provider records for composed provider identity mapping", async () => {
    const fixture = await repository();
    const provider = fixture.provider();
    await provider.prepare(fixture.spec());
    const inspection = await provider.inspect("cell-1");
    inspection.cell.state = "destroyed";
    inspection.spec.capabilities.write.push("tampered/**");
    const persisted = await provider.inspect("cell-1");
    expect(persisted.cell.state).toBe("isolated");
    expect(persisted.spec.capabilities.write).not.toContain("tampered/**");
  });

  it("promotes a verified cell by fast-forward and then tears down only the owned worktree", async () => {
    const fixture = await repository();
    const provider = fixture.provider();
    await provider.prepare(fixture.spec());
    const worktree = join(fixture.data, "worktrees", "cell-1");
    await writeFile(join(worktree, "tracked.txt"), "promoted\n", "utf8");
    await ready(provider);
    const receipt = await provider.commit("cell-1", fixture.base, [digest]);

    expect(receipt.status).toBe("committed");
    expect(receipt.expectedBase).toBe(fixture.base);
    expect(receipt.resultingRevision).toBe(await git(fixture.root, ["rev-parse", "HEAD"]));
    expect(await readFile(join(fixture.root, "tracked.txt"), "utf8")).toBe("promoted\n");
    await provider.destroy("cell-1");
    await expect(access(worktree)).rejects.toThrow();
    expect(await readFile(join(fixture.root, "tracked.txt"), "utf8")).toBe("promoted\n");
  });

  it("rejects stale-base and dirty-primary promotion without changing primary content", async () => {
    const stale = await repository();
    const staleProvider = stale.provider();
    await staleProvider.prepare(stale.spec());
    await writeFile(join(stale.data, "worktrees", "cell-1", "tracked.txt"), "cell change\n", "utf8");
    await writeFile(join(stale.root, "primary-only.txt"), "primary\n", "utf8");
    await git(stale.root, ["add", "."]);
    await git(stale.root, ["commit", "-m", "advance primary"]);
    await ready(staleProvider);
    const staleReceipt = await staleProvider.commit("cell-1", stale.base, [digest]);
    expect(staleReceipt.status).toBe("rejected");
    expect(staleReceipt.reason).toContain("changed after");
    expect(await readFile(join(stale.root, "tracked.txt"), "utf8")).toBe("base\n");

    const dirty = await repository();
    const dirtyProvider = dirty.provider();
    await dirtyProvider.prepare(dirty.spec());
    await writeFile(join(dirty.data, "worktrees", "cell-1", "tracked.txt"), "cell change\n", "utf8");
    await writeFile(join(dirty.root, "operator.txt"), "unsaved\n", "utf8");
    await ready(dirtyProvider);
    const dirtyReceipt = await dirtyProvider.commit("cell-1", dirty.base, [digest]);
    expect(dirtyReceipt.status).toBe("rejected");
    expect(dirtyReceipt.reason).toContain("uncommitted or untracked");
    expect(await readFile(join(dirty.root, "tracked.txt"), "utf8")).toBe("base\n");
  });

  it("requires receipt evidence and observable effects before promotion", async () => {
    const fixture = await repository();
    const provider = fixture.provider();
    await provider.prepare(fixture.spec());
    await ready(provider);
    await expect(provider.commit("cell-1", fixture.base)).rejects.toThrow("at least one verified");
    const receipt = await provider.commit("cell-1", fixture.base, [digest]);
    expect(receipt.status).toBe("rejected");
    expect(receipt.reason).toContain("no observable file effects");
  });

  it("marks interrupted execution failed during recovery and can safely remove it", async () => {
    const fixture = await repository();
    const provider = fixture.provider();
    await provider.prepare(fixture.spec());
    await provider.transition("cell-1", "executing");

    const restarted = fixture.provider();
    await expect(restarted.recoverCell("cell-1", "different-objective")).rejects.toThrow("different objective");
    const recoveredCell = await restarted.recoverCell("cell-1");
    expect(recoveredCell.state).toBe("failed");
    const recovered = await restarted.recover();
    expect(recovered.find((cell) => cell.id === "cell-1")?.state).toBe("failed");
    await restarted.destroy("cell-1");
    await expect(access(join(fixture.data, "worktrees", "cell-1"))).rejects.toThrow();
    expect(await git(fixture.root, ["status", "--porcelain"])).toBe("");
  });

  it("rejects tampered records and reports stale locks without deleting them", async () => {
    const tampered = await repository();
    const tamperedProvider = tampered.provider();
    await tamperedProvider.prepare(tampered.spec());
    const recordPath = join(tampered.data, "records", "cell-1.json");
    const record = JSON.parse(await readFile(recordPath, "utf8"));
    record.candidateRevision = "--upload-pack=malicious";
    await writeFile(recordPath, JSON.stringify(record), "utf8");
    await expect(tamperedProvider.diff("cell-1")).rejects.toThrow("candidate revision is invalid");

    const locked = await repository();
    const lockedProvider = locked.provider();
    await lockedProvider.prepare(locked.spec());
    const lockPath = join(locked.data, "locks", "cell-1.lock");
    await mkdir(lockPath);
    const old = new Date(Date.now() - 10 * 60 * 1000);
    await utimes(lockPath, old, old);
    await expect(lockedProvider.diff("cell-1")).rejects.toThrow("lock is stale");
    await expect(access(lockPath)).resolves.toBeUndefined();
  });

  it("rejects portable identifiers that are not safe cross-platform path components", async () => {
    const fixture = await repository();
    await expect(fixture.provider().prepare(fixture.spec({ id: "cell:unsafe" }))).rejects.toThrow("Invalid portable execution cell identifier");
  });
});

async function repository(options: { executor?: PortableActionExecutor } = {}) {
  const sandbox = await mkdtemp(join(tmpdir(), "nexusharness-portable-"));
  sandboxes.push(sandbox);
  const root = join(sandbox, "repo");
  const data = join(sandbox, "cells");
  await mkdir(root);
  await git(root, ["init", "-b", "main"]);
  await git(root, ["config", "user.name", "Test Operator"]);
  await git(root, ["config", "user.email", "operator@example.invalid"]);
  await writeFile(join(root, "tracked.txt"), "base\n", "utf8");
  await writeFile(join(root, "delete-me.txt"), "delete\n", "utf8");
  await writeFile(join(root, "rename-me.txt"), "rename\n", "utf8");
  await git(root, ["add", "."]);
  await git(root, ["commit", "-m", "base"]);
  const base = await git(root, ["rev-parse", "HEAD"]);
  let counter = 0;
  const now = () => new Date(`2026-07-11T10:00:${String(counter++).padStart(2, "0")}.000Z`);
  const actionExecutor = options.executor ?? executor(async ({ contract }) => actionReceipt(contract.id, contract.cellId, "succeeded"));
  const provider = (overrides: { dataRoot?: string } = {}) => new PortableWorktreeProvider({ workspaceRoot: root, dataRoot: overrides.dataRoot ?? data, actionExecutor, now, id: () => `provider-record-${counter++}` });
  const spec = (overrides: Record<string, unknown> = {}) => cellSpecSchema.parse({
    schemaVersion: 1,
    id: "cell-1",
    objectiveId: "objective-1",
    provider: "portable-worktree",
    baseRevision: base,
    workspaceRootDigest: portableWorkspaceDigest(root),
    capabilities: capabilities(),
    budget: { wallTimeMs: 60_000, cpuTimeMs: 30_000, memoryBytes: 512 * 1024 * 1024, diskBytes: 1024 * 1024 * 1024, processCount: 20, outputBytes: 1024 * 1024 },
    networkDefault: "deny",
    retention: { keepFailedMs: 60_000, keepCommittedMs: 0 },
    createdAt: "2026-07-11T10:00:00.000Z",
    ...overrides
  });
  return { sandbox, root, data, base, provider, spec };
}

async function ready(provider: PortableWorktreeProvider) {
  await provider.transition("cell-1", "executing");
  await provider.transition("cell-1", "verifying");
  await provider.transition("cell-1", "ready_to_commit");
}

function executor(handler: PortableActionExecutor["execute"]): PortableActionExecutor {
  return { execute: handler };
}

function capabilities() {
  return { read: ["**"], write: ["**"], delete: ["**"], execute: ["npm"], network: [], secrets: [] };
}

function contract(overrides: Record<string, unknown> = {}) {
  return contractedActionSchema.parse({
    schemaVersion: 1,
    id: "action-1",
    objectiveId: "objective-1",
    cellId: "cell-1",
    leaseId: "lease-1",
    issuedAt: "2026-07-11T10:00:00.000Z",
    expiresAt: "2026-07-11T11:00:00.000Z",
    purpose: "Create a generated file.",
    action: { kind: "file.write", risk: "write", payloadDigest: digest },
    capabilities: capabilities(),
    requires: [{ kind: "write", value: "**" }],
    preconditions: [],
    expectedEffects: [],
    forbiddenEffects: [],
    invariants: ["Primary workspace remains unchanged until commit."],
    successEvidence: ["Receipt is valid."],
    rollback: { kind: "discard_cell", description: "Remove the worktree." },
    ...overrides
  });
}

function lease() {
  return capabilityLeaseSchema.parse({
    schemaVersion: 1,
    id: "lease-1",
    objectiveId: "objective-1",
    cellId: "cell-1",
    issuedAt: "2026-07-11T10:00:00.000Z",
    expiresAt: "2026-07-11T11:00:00.000Z",
    singleUse: true,
    status: "active",
    capabilities: capabilities(),
    policyVersion: "policy-v1"
  });
}

function actionReceipt(contractId: string, cellId: string, status: "succeeded" | "blocked") {
  return actionReceiptSchema.parse({
    schemaVersion: 1,
    id: `receipt-${contractId}`,
    contractId,
    cellId,
    status,
    startedAt: "2026-07-11T10:00:00.000Z",
    completedAt: "2026-07-11T10:00:01.000Z",
    policyVersion: "policy-v1",
    contractDigest: digest,
    leaseDigest: digest,
    predictedEffectsDigest: digest,
    observedEffects: [],
    variances: status === "blocked" ? [{ kind: "forbidden", severity: "blocking", effectTarget: "policy", detail: "Blocked" }] : [],
    evidence: []
  });
}

function git(cwd: string, args: string[]) {
  return new Promise<string>((resolveRun, reject) => {
    const child = spawn("git", args, { cwd, windowsHide: true });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code) => code === 0 ? resolveRun(stdout.trim()) : reject(new Error(`git ${args[0]} failed: ${stderr || stdout}`)));
  });
}

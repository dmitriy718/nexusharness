import { afterEach, describe, expect, it, vi } from "vitest";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { CompositePortableActionExecutor } from "../server/execution/compositeActionExecutor";
import { PortableFileActionExecutor } from "../server/execution/fileActionExecutor";
import { capabilityLeaseSchema, cellSpecSchema, contractedActionSchema, executionCellSchema, executionDigest, type ActionReceipt, type CapabilityLease, type ContractedAction } from "../server/execution/contracts";
import { PortableWorktreeProvider, portableWorkspaceDigest, type PortableActionExecutor } from "../server/execution/portableWorktreeProvider";
import { TransactionService } from "../server/execution/transactionService";
import type { Settings } from "../server/types";

const execFileAsync = promisify(execFile);
const sandboxes: string[] = [];

afterEach(async () => {
  await Promise.all(sandboxes.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("composite portable action executor", () => {
  it("binds admission and execution to the executor registered for the contracted kind", async () => {
    const file = fixtureExecutor();
    const shell = fixtureExecutor();
    const composite = new CompositePortableActionExecutor([
      { kinds: ["file.write", "file.delete"], executor: file },
      { kinds: ["shell.exec"], executor: shell }
    ]);
    const input = actionInput("file.write");

    await composite.authorize(input);
    await expect(composite.execute(input)).resolves.toMatchObject({ contractId: input.contract.id, status: "succeeded" });

    expect(file.authorize).toHaveBeenCalledOnce();
    expect(file.execute).toHaveBeenCalledOnce();
    expect(shell.authorize).not.toHaveBeenCalled();
    expect(composite.registeredKinds()).toEqual(["file.write", "file.delete", "shell.exec"]);
  });

  it("fails closed for missing and duplicate routes", async () => {
    const executor = fixtureExecutor();
    expect(() => new CompositePortableActionExecutor([])).toThrow("at least one route");
    expect(() => new CompositePortableActionExecutor([{ kinds: [], executor }])).toThrow("declare at least one");
    expect(() => new CompositePortableActionExecutor([
      { kinds: ["file.write"], executor },
      { kinds: ["file.write"], executor: fixtureExecutor() }
    ])).toThrow("registered more than once");

    const composite = new CompositePortableActionExecutor([{ kinds: ["file.write"], executor }]);
    await expect(composite.authorize(actionInput("shell.exec"))).rejects.toThrow("No portable action executor");
    expect(executor.authorize).not.toHaveBeenCalled();
  });

  it("rejects execution without admission and one-use admission replay", async () => {
    const executor = fixtureExecutor();
    const composite = new CompositePortableActionExecutor([{ kinds: ["file.write"], executor }]);
    const input = actionInput("file.write");

    await expect(composite.execute(input)).rejects.toThrow("not admitted");
    await composite.authorize(input);
    await composite.execute(input);
    await expect(composite.execute(input)).rejects.toThrow("not admitted");
    await composite.authorize(input);
    await composite.authorize(input);
    expect(executor.authorize).toHaveBeenCalledTimes(2);
    const changed = structuredClone(input);
    changed.contract.action.payloadDigest = digest("d");
    await expect(composite.authorize(changed)).rejects.toThrow("already admitted with different input");
  });

  it.each(["contract", "lease", "kind", "cell", "workingDirectory"] as const)("rejects %s changes after admission", async (mutation) => {
    const file = fixtureExecutor();
    const shell = fixtureExecutor();
    const composite = new CompositePortableActionExecutor([
      { kinds: ["file.write"], executor: file },
      { kinds: ["shell.exec"], executor: shell }
    ]);
    const input = actionInput("file.write");
    await composite.authorize(input);

    const changed = structuredClone(input);
    if (mutation === "contract") changed.contract.action.payloadDigest = digest("b");
    if (mutation === "lease") changed.lease.policyVersion = "policy-v2";
    if (mutation === "kind") changed.contract.action.kind = "shell.exec";
    if (mutation === "cell") changed.cell.providerRef = "fixture:different-cell";
    if (mutation === "workingDirectory") changed.workingDirectory = "/different-cell";

    await expect(composite.execute(changed)).rejects.toThrow("changed after admission");
    expect(file.execute).not.toHaveBeenCalled();
    expect(shell.execute).not.toHaveBeenCalled();
    await expect(composite.execute(input)).rejects.toThrow("not admitted");
  });

  it("rejects a delegate that mutates admission input", async () => {
    const executor = fixtureExecutor();
    executor.authorize.mockImplementationOnce(async (input) => { input.contract.action.payloadDigest = digest("e"); });
    const composite = new CompositePortableActionExecutor([{ kinds: ["file.write"], executor }]);

    await expect(composite.authorize(actionInput("file.write"))).rejects.toThrow("changed during admission");
    expect(executor.execute).not.toHaveBeenCalled();
  });

  it("composes with the real file executor, portable provider, and transaction lifecycle", async () => {
    const sandbox = await mkdtemp(join(tmpdir(), "nexus-composite-"));
    sandboxes.push(sandbox);
    const root = join(sandbox, "repo");
    await mkdir(root);
    await git(root, ["init", "-b", "main"]);
    await git(root, ["config", "user.name", "Composite Test"]);
    await git(root, ["config", "user.email", "composite@example.invalid"]);
    await writeFile(join(root, "base.txt"), "base\n", "utf8");
    await git(root, ["add", "."]);
    await git(root, ["commit", "-m", "base"]);
    const base = await git(root, ["rev-parse", "HEAD"]);
    const now = () => new Date("2026-07-11T15:10:00.000Z");
    const file = new PortableFileActionExecutor({
      authorize: async () => undefined,
      brokerAudit: { append: async () => undefined },
      toolAudit: async () => undefined,
      now,
      id: () => "receipt-1"
    });
    const composite = new CompositePortableActionExecutor([{ kinds: ["file.write"], executor: file }]);
    const provider = new PortableWorktreeProvider({
      workspaceRoot: root,
      dataRoot: join(sandbox, "cells"),
      actionExecutor: composite,
      now,
      id: () => "provider-record-1"
    });
    const service = new TransactionService({ provider, now });
    const target = "generated.txt";
    await service.prepare(cellSpecSchema.parse({
      schemaVersion: 1, id: "cell-1", objectiveId: "objective-1", provider: "portable-worktree", baseRevision: base,
      workspaceRootDigest: portableWorkspaceDigest(root), capabilities: capabilities(target),
      budget: { wallTimeMs: 60_000, cpuTimeMs: 30_000, memoryBytes: 512 * 1024 * 1024, diskBytes: 1024 * 1024 * 1024, processCount: 20, outputBytes: 1024 * 1024 },
      networkDefault: "deny", retention: { keepFailedMs: 60_000, keepCommittedMs: 0 }, createdAt: "2026-07-11T15:00:00.000Z"
    }));
    const registered = file.registerFileWrite("contract-1", { settings: settings(root), relativePath: target, content: "generated\n" });
    const lease = capabilityLeaseSchema.parse({
      schemaVersion: 1, id: "lease-1", objectiveId: "objective-1", cellId: "cell-1", issuedAt: "2026-07-11T15:00:00.000Z",
      expiresAt: "2026-07-11T16:00:00.000Z", singleUse: true, status: "active", capabilities: capabilities(target), policyVersion: "portable-file-write-v1"
    });
    const contract = contractedActionSchema.parse({
      schemaVersion: 1, id: "contract-1", objectiveId: "objective-1", cellId: "cell-1", leaseId: lease.id,
      issuedAt: lease.issuedAt, expiresAt: lease.expiresAt, purpose: "Create one generated file through composite dispatch.",
      action: { kind: "file.write", risk: "write", payloadDigest: registered.payloadDigest }, capabilities: capabilities(target),
      requires: [{ kind: "write", value: target }], preconditions: [],
      expectedEffects: [
        { kind: "file.create", target, required: false, expectedDigest: registered.afterDigest, description: "Create the generated file." },
        { kind: "file.update", target, required: false, expectedDigest: registered.afterDigest, description: "Update the generated file." }
      ],
      forbiddenEffects: [], invariants: ["The primary checkout remains unchanged before commit."],
      successEvidence: ["The broker observes the expected content digest."], rollback: { kind: "discard_cell", description: "Discard the cell." }
    });

    await expect(service.execute("cell-1", contract, lease)).resolves.toMatchObject({ receipt: { status: "succeeded" } });
    await expect(readFile(join(root, target), "utf8")).rejects.toThrow();
    await expect(service.verify("cell-1")).resolves.toMatchObject({ ready: true });
    await expect(service.commit("cell-1")).resolves.toMatchObject({ receipt: { status: "committed" } });
    expect(await readFile(join(root, target), "utf8")).toBe("generated\n");
    await service.destroy("cell-1");
  });
});

function fixtureExecutor(): PortableActionExecutor & { authorize: ReturnType<typeof vi.fn>; execute: ReturnType<typeof vi.fn> } {
  return {
    authorize: vi.fn(async () => undefined),
    execute: vi.fn(async ({ contract, lease }) => receipt(contract, lease))
  };
}

function actionInput(kind: ContractedAction["action"]["kind"]) {
  const lease: CapabilityLease = {
    schemaVersion: 1, id: "lease-1", objectiveId: "objective-1", cellId: "cell-1", policyVersion: "policy-v1",
    capabilities: { read: [], write: ["src/app.ts"], delete: [], execute: ["powershell.exe"], network: [], secrets: [] },
    issuedAt: "2026-07-11T15:00:00.000Z", expiresAt: "2026-07-11T16:00:00.000Z", singleUse: true, status: "active"
  };
  const contract: ContractedAction = {
    schemaVersion: 1, id: "contract-1", objectiveId: lease.objectiveId, cellId: lease.cellId, leaseId: lease.id,
    action: { kind, risk: kind === "shell.exec" ? "execute" : "write", payloadDigest: digest("a") },
    capabilities: lease.capabilities,
    requires: [{ kind: kind === "shell.exec" ? "execute" : "write", value: kind === "shell.exec" ? "powershell.exe" : "src/app.ts" }],
    purpose: "Exercise composite action routing.", preconditions: [], expectedEffects: [], forbiddenEffects: [],
    invariants: ["Dispatch remains bound to admission."], successEvidence: ["The registered executor returns a receipt."],
    rollback: { kind: "discard_cell", description: "Discard the test cell." }, issuedAt: lease.issuedAt, expiresAt: lease.expiresAt
  };
  const cell = executionCellSchema.parse({
    schemaVersion: 1, id: "cell-1", specDigest: digest("f"), provider: "portable-worktree", providerRef: "fixture:cell-1",
    baseRevision: "a".repeat(40), state: "isolated", preparedAt: lease.issuedAt, updatedAt: lease.issuedAt
  });
  return { cell, workingDirectory: "/cell", contract, lease };
}

function receipt(contract: ContractedAction, lease: CapabilityLease): ActionReceipt {
  return {
    schemaVersion: 1, id: "receipt-1", contractId: contract.id, cellId: contract.cellId, status: "succeeded",
    startedAt: contract.issuedAt, completedAt: contract.issuedAt, policyVersion: lease.policyVersion,
    contractDigest: executionDigest(contract), leaseDigest: executionDigest(lease), predictedEffectsDigest: executionDigest([]),
    observedEffects: [], variances: [], evidence: [{ kind: "policy", name: "fixture", status: "passed", digest: digest("c") }]
  };
}

function digest(character: string) { return `sha256:${character.repeat(64)}`; }

function capabilities(target: string) {
  return { read: ["**"], write: [target], delete: [], execute: [], network: [], secrets: [] };
}

function settings(workspaceRoot: string): Settings {
  return {
    workspaceRoot, layout: "chat", maxIterations: 1, maxParallelExecutors: 1, criticThreshold: 7, approvalMode: true,
    shellPath: "shell", testCommand: "", lintCommand: "", mcpAutoDiscovery: false, mcpPortStart: 3000, mcpPortEnd: 3001,
    memoryTokenBudget: 100, agentModels: {}
  };
}

async function git(cwd: string, args: string[]) {
  const result = await execFileAsync("git", args, { cwd, windowsHide: true });
  return result.stdout.trim();
}

import { afterEach, describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { access, mkdir, mkdtemp, open, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { CompositePortableActionExecutor } from "../server/execution/compositeActionExecutor";
import { PortableFileDeleteExecutor } from "../server/execution/fileDeleteExecutor";
import { capabilityLeaseSchema, cellSpecSchema, contractedActionSchema, executionCellSchema, type CapabilityLease, type ContractedAction } from "../server/execution/contracts";
import { PortableWorktreeProvider, portableWorkspaceDigest } from "../server/execution/portableWorktreeProvider";
import { TransactionService } from "../server/execution/transactionService";
import type { BrokerAuditRecord } from "../server/execution/broker";
import type { Settings } from "../server/types";

const at = "2026-07-11T15:00:00.000Z";
const digest = `sha256:${"a".repeat(64)}`;
const sandboxes: string[] = [];
const execFileAsync = promisify(execFile);

afterEach(async () => {
  await Promise.all(sandboxes.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("portable deterministic file-delete executor", () => {
  it("deletes one approved regular file through the broker and reports its pre-image", async () => {
    const fixture = await deleteFixture();
    const registered = await fixture.executor.registerFileDelete("action-1", {
      settings: fixture.settings,
      relativePath: "delete-me.txt",
      context: { runId: "run-1", subtask: "Remove obsolete file" }
    });
    const action = contract(registered);
    await fixture.executor.authorize!({ cell: cell("isolated"), workingDirectory: fixture.root, contract: action, lease: lease() });
    const receipt = await fixture.executor.execute({ cell: cell("executing"), workingDirectory: fixture.root, contract: action, lease: lease() });

    expect(receipt).toMatchObject({
      status: "succeeded",
      observedEffects: [{ kind: "file.delete", target: "delete-me.txt", status: "deleted", beforeDigest: registered.beforeDigest }]
    });
    await expect(access(join(fixture.root, "delete-me.txt"))).rejects.toThrow();
    expect(fixture.approvals).toEqual([expect.objectContaining({
      action: "file.delete",
      payload: expect.objectContaining({ relativePath: "delete-me.txt", recursive: false, previousSha256: registered.beforeDigest.slice(7) })
    })]);
    expect(fixture.brokerAudit).toEqual([expect.objectContaining({ mode: "enforced", action: "file.delete", status: "succeeded" })]);
  });

  it("rejects target drift before approval and time-of-check/time-of-use drift after approval", async () => {
    const beforeApproval = await deleteFixture();
    const registeredBefore = await beforeApproval.executor.registerFileDelete("action-1", { settings: beforeApproval.settings, relativePath: "delete-me.txt" });
    await writeFile(join(beforeApproval.root, "delete-me.txt"), "changed before approval\n", "utf8");
    await expect(beforeApproval.executor.authorize!({
      cell: cell("isolated"), workingDirectory: beforeApproval.root, contract: contract(registeredBefore), lease: lease()
    })).rejects.toThrow("changed before approval");
    expect(beforeApproval.approvals).toEqual([]);

    const afterApproval = await deleteFixture();
    const registeredAfter = await afterApproval.executor.registerFileDelete("action-1", { settings: afterApproval.settings, relativePath: "delete-me.txt" });
    const action = contract(registeredAfter);
    await afterApproval.executor.authorize!({ cell: cell("isolated"), workingDirectory: afterApproval.root, contract: action, lease: lease() });
    await writeFile(join(afterApproval.root, "delete-me.txt"), "changed after approval\n", "utf8");
    const receipt = await afterApproval.executor.execute({ cell: cell("executing"), workingDirectory: afterApproval.root, contract: action, lease: lease() });

    expect(receipt).toMatchObject({ status: "failed", observedEffects: [] });
    expect(await readFile(join(afterApproval.root, "delete-me.txt"), "utf8")).toBe("changed after approval\n");
  });

  it("does not delete or consume broker authority when approval stops admission", async () => {
    const fixture = await deleteFixture({ rejectApproval: true });
    const registered = await fixture.executor.registerFileDelete("action-1", { settings: fixture.settings, relativePath: "delete-me.txt" });
    const action = contract(registered);
    await expect(fixture.executor.authorize!({ cell: cell("isolated"), workingDirectory: fixture.root, contract: action, lease: lease() })).rejects.toThrow("Approval required");
    await expect(fixture.executor.execute({ cell: cell("executing"), workingDirectory: fixture.root, contract: action, lease: lease() })).rejects.toThrow("not admitted");
    expect(await readFile(join(fixture.root, "delete-me.txt"), "utf8")).toBe("remove me\n");
    expect(fixture.brokerAudit).toEqual([]);
  });

  it("reports a completed deletion even if the later local audit write fails", async () => {
    const fixture = await deleteFixture({ rejectToolAudit: true });
    const registered = await fixture.executor.registerFileDelete("action-1", { settings: fixture.settings, relativePath: "delete-me.txt" });
    const action = contract(registered);
    await fixture.executor.authorize!({ cell: cell("isolated"), workingDirectory: fixture.root, contract: action, lease: lease() });
    const receipt = await fixture.executor.execute({ cell: cell("executing"), workingDirectory: fixture.root, contract: action, lease: lease() });

    expect(receipt).toMatchObject({ status: "failed", observedEffects: [{ kind: "file.delete", target: "delete-me.txt", status: "deleted" }] });
    await expect(access(join(fixture.root, "delete-me.txt"))).rejects.toThrow();
  });

  it("rejects directories, unsafe paths, duplicate registration, and contract mismatch before approval", async () => {
    const fixture = await deleteFixture();
    await expect(fixture.executor.registerFileDelete("directory", { settings: fixture.settings, relativePath: "folder" })).rejects.toThrow("regular files only");
    await expect(fixture.executor.registerFileDelete("escape", { settings: fixture.settings, relativePath: "../escape.txt" })).rejects.toThrow("repository-relative");
    const pending = fixture.executor.registerFileDelete("duplicate", { settings: fixture.settings, relativePath: "delete-me.txt" });
    await expect(fixture.executor.registerFileDelete("duplicate", { settings: fixture.settings, relativePath: "delete-me.txt" })).rejects.toThrow("already registered");
    await pending;

    const registered = await fixture.executor.registerFileDelete("action-1", { settings: fixture.settings, relativePath: "delete-me.txt" });
    await expect(fixture.executor.authorize!({
      cell: cell("isolated"), workingDirectory: fixture.root,
      contract: contract(registered, { action: { kind: "file.delete", risk: "write", payloadDigest: digest } }), lease: lease()
    })).rejects.toThrow("payload");
    await expect(fixture.executor.authorize!({
      cell: cell("isolated"), workingDirectory: fixture.root,
      contract: contract(registered, { expectedEffects: [] }), lease: lease()
    })).rejects.toThrow("required deletion effect");
    await expect(fixture.executor.authorize!({
      cell: cell("isolated"), workingDirectory: fixture.root,
      contract: contract(registered, { expectedEffects: [{ kind: "file.delete", target: "delete-me.txt", required: true, expectedDigest: registered.beforeDigest, description: "Invalid after-state digest." }] }),
      lease: lease()
    })).rejects.toThrow("without an after-state digest");
    expect(fixture.approvals).toEqual([]);
  });

  it("rejects delete targets beyond the bounded inspection ceiling", async () => {
    const fixture = await deleteFixture();
    const handle = await open(join(fixture.root, "large.bin"), "w");
    await handle.truncate(20 * 1024 * 1024 + 1);
    await handle.close();

    await expect(fixture.executor.registerFileDelete("large", { settings: fixture.settings, relativePath: "large.bin" })).rejects.toThrow("20 MiB limit");
  });

  it("composes with portable transactions and keeps the primary file until receipt-gated commit", async () => {
    const sandbox = await mkdtemp(join(tmpdir(), "nexus-delete-provider-"));
    sandboxes.push(sandbox);
    const root = join(sandbox, "repo");
    await mkdir(root);
    await git(root, ["init", "-b", "main"]);
    await git(root, ["config", "user.name", "Delete Test"]);
    await git(root, ["config", "user.email", "delete@example.invalid"]);
    await writeFile(join(root, "delete-me.txt"), "remove me\n", "utf8");
    await git(root, ["add", "."]);
    await git(root, ["commit", "-m", "base"]);
    const base = await git(root, ["rev-parse", "HEAD"]);
    const now = () => new Date("2026-07-11T15:10:00.000Z");
    const executor = new PortableFileDeleteExecutor({
      authorize: async () => undefined, toolAudit: async () => undefined,
      brokerAudit: { append: async () => undefined }, now, id: () => "receipt-1"
    });
    const provider = new PortableWorktreeProvider({
      workspaceRoot: root, dataRoot: join(sandbox, "cells"),
      actionExecutor: new CompositePortableActionExecutor([{ kinds: ["file.delete"], executor }]),
      now, id: () => "provider-record-1"
    });
    const service = new TransactionService({ provider, now });
    await service.prepare(cellSpecSchema.parse({
      schemaVersion: 1, id: "cell-1", objectiveId: "objective-1", provider: "portable-worktree", baseRevision: base,
      workspaceRootDigest: portableWorkspaceDigest(root), capabilities: capabilities("delete-me.txt"),
      budget: { wallTimeMs: 60_000, cpuTimeMs: 30_000, memoryBytes: 512 * 1024 * 1024, diskBytes: 1024 * 1024 * 1024, processCount: 20, outputBytes: 1024 * 1024 },
      networkDefault: "deny", retention: { keepFailedMs: 60_000, keepCommittedMs: 0 }, createdAt: at
    }));
    const registered = await executor.registerFileDelete("action-1", { settings: settingsFixture(root), relativePath: "delete-me.txt" });

    await expect(service.execute("cell-1", contract(registered), lease())).resolves.toMatchObject({ receipt: { status: "succeeded" } });
    expect(await readFile(join(root, "delete-me.txt"), "utf8")).toBe("remove me\n");
    await expect(service.verify("cell-1")).resolves.toMatchObject({ ready: true });
    await expect(service.commit("cell-1")).resolves.toMatchObject({ receipt: { status: "committed" } });
    await expect(access(join(root, "delete-me.txt"))).rejects.toThrow();
    await service.destroy("cell-1");
  });
});

async function deleteFixture(options: { rejectApproval?: boolean; rejectToolAudit?: boolean } = {}) {
  const root = await mkdtemp(join(tmpdir(), "nexus-file-delete-"));
  sandboxes.push(root);
  await writeFile(join(root, "delete-me.txt"), "remove me\n", "utf8");
  await mkdir(join(root, "folder"));
  await writeFile(join(root, "folder", "nested.txt"), "keep\n", "utf8");
  const approvals: Array<{ action: string; payload: unknown }> = [];
  const brokerAudit: BrokerAuditRecord[] = [];
  let record = 0;
  const executor = new PortableFileDeleteExecutor({
    authorize: async (_settings, action, _risk, payload) => {
      approvals.push({ action, payload });
      if (options.rejectApproval) throw new Error("Approval required for file.delete.");
    },
    toolAudit: async () => {
      if (options.rejectToolAudit) throw new Error("Audit store unavailable.");
    },
    brokerAudit: { async append(entry) { brokerAudit.push(entry); } },
    now: () => new Date(record++ ? "2026-07-11T15:00:01.000Z" : at),
    id: () => `receipt-${record}`
  });
  return { root, settings: settingsFixture(root), approvals, brokerAudit, executor };
}

function contract(
  registered: { payloadDigest: string; relativePath: string },
  overrides: Record<string, unknown> = {}
): ContractedAction {
  return contractedActionSchema.parse({
    schemaVersion: 1, id: "action-1", objectiveId: "objective-1", cellId: "cell-1", leaseId: "lease-1",
    issuedAt: at, expiresAt: "2026-07-11T16:00:00.000Z", purpose: "Delete one approved regular file in the isolated workspace.",
    action: { kind: "file.delete", risk: "write", payloadDigest: registered.payloadDigest }, capabilities: capabilities(registered.relativePath),
    requires: [{ kind: "delete", value: registered.relativePath }], preconditions: ["The file still matches its approved pre-image."],
    expectedEffects: [{ kind: "file.delete", target: registered.relativePath, required: true, description: "Delete the approved file." }],
    forbiddenEffects: [], invariants: ["No other path changes."], successEvidence: ["The broker observes the deletion."],
    rollback: { kind: "discard_cell", description: "Discard the portable cell." }, ...overrides
  });
}

function lease(): CapabilityLease {
  return capabilityLeaseSchema.parse({
    schemaVersion: 1, id: "lease-1", objectiveId: "objective-1", cellId: "cell-1", issuedAt: at,
    expiresAt: "2026-07-11T16:00:00.000Z", singleUse: true, status: "active",
    capabilities: capabilities("delete-me.txt"), policyVersion: "portable-file-delete-v1"
  });
}

function capabilities(...targets: string[]) {
  return { read: [], write: [], delete: targets, execute: [], network: [], secrets: [] };
}

function cell(state: "isolated" | "executing") {
  return executionCellSchema.parse({
    schemaVersion: 1, id: "cell-1", specDigest: digest, provider: "portable-worktree", providerRef: "fixture:cell-1",
    baseRevision: "a".repeat(40), state, preparedAt: at, updatedAt: at
  });
}

function settingsFixture(workspaceRoot: string): Settings {
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

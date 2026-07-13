import { afterEach, describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { PortableValidationCommandExecutor } from "../server/execution/portableShellExecutor";
import { PortableFileActionExecutor } from "../server/execution/fileActionExecutor";
import { CompositePortableActionExecutor } from "../server/execution/compositeActionExecutor";
import { capabilityLeaseSchema, cellSpecSchema, contractedActionSchema, executionCellSchema, executionDigest, type CapabilityLease, type ContractedAction } from "../server/execution/contracts";
import { InMemoryLeaseUseStore, InMemoryReceiptChainStore, type BrokerAuditRecord } from "../server/execution/broker";
import { PortableWorktreeProvider, portableWorkspaceDigest } from "../server/execution/portableWorktreeProvider";
import { TransactionService } from "../server/execution/transactionService";
import type { Settings } from "../server/types";

const execFileAsync = promisify(execFile);
const at = "2026-07-11T16:00:00.000Z";
const digest = `sha256:${"a".repeat(64)}`;
const sandboxes: string[] = [];

afterEach(async () => {
  await Promise.all(sandboxes.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("portable validation command executor", () => {
  it("runs one allowlisted approved command through the broker without repository effects", async () => {
    const fixture = await commandFixture();
    const registration = fixture.executor.register("action-1", { command: commands().pass, settings: fixture.settings, context: { runId: "run-1" } });
    const action = contract(registration);
    await fixture.executor.authorize!({ cell: cell("isolated"), workingDirectory: fixture.root, contract: action, lease: lease(fixture.settings.shellPath) });
    const receipt = await fixture.executor.execute({ cell: cell("executing"), workingDirectory: fixture.root, contract: action, lease: lease(fixture.settings.shellPath) });

    expect(receipt).toMatchObject({ status: "succeeded", observedEffects: [], variances: [], evidence: [{ kind: "policy", status: "passed" }] });
    expect(fixture.executor.takeResult("action-1")).toMatchObject({ code: 0 });
    expect(fixture.executor.takeResult("action-1")).toBeUndefined();
    expect(fixture.approvals).toEqual([expect.objectContaining({ action: "shell.exec", payload: expect.objectContaining({ command: commands().pass, transactionBoundary: "portable-worktree" }) })]);
    expect(fixture.brokerAudit).toEqual([expect.objectContaining({ mode: "enforced", action: "shell.exec", status: "succeeded" })]);
    expect(JSON.stringify(receipt)).not.toContain("validation-output-marker");
    expect(fixture.executor).toMatchObject({ securityBoundary: false });
    expect(fixture.executor.boundaryDescription).toContain("no hostile-process or network isolation");
  });

  it("blocks an allowlisted command that creates an undeclared repository effect", async () => {
    const fixture = await commandFixture();
    const registration = fixture.executor.register("action-1", { command: commands().mutate, settings: fixture.settings });
    const action = contract(registration);
    await fixture.executor.authorize!({ cell: cell("isolated"), workingDirectory: fixture.root, contract: action, lease: lease(fixture.settings.shellPath) });
    const receipt = await fixture.executor.execute({ cell: cell("executing"), workingDirectory: fixture.root, contract: action, lease: lease(fixture.settings.shellPath) });

    expect(receipt).toMatchObject({
      status: "failed",
      observedEffects: [{ kind: "file.create", target: "unexpected.txt", status: "created" }],
      variances: [{ kind: "unexpected", severity: "blocking", effectTarget: "unexpected.txt" }]
    });
    expect(await readFile(join(fixture.root, "unexpected.txt"), "utf8")).toContain("unexpected");
    expect(fixture.executor.takeResult("action-1")).toBeUndefined();
  });

  it("returns a nonzero validation result without poisoning the transaction receipt", async () => {
    const fixture = await commandFixture();
    const registration = fixture.executor.register("action-1", { command: commands().fail, settings: fixture.settings });
    const action = contract(registration);
    await fixture.executor.authorize!({ cell: cell("isolated"), workingDirectory: fixture.root, contract: action, lease: lease(fixture.settings.shellPath) });
    const receipt = await fixture.executor.execute({ cell: cell("executing"), workingDirectory: fixture.root, contract: action, lease: lease(fixture.settings.shellPath) });

    expect(receipt).toMatchObject({ status: "succeeded", observedEffects: [], variances: [] });
    expect(JSON.stringify(receipt)).not.toContain("raw-validation-secret");
    expect(fixture.executor.takeResult("action-1")).toMatchObject({ code: 7, stderr: expect.stringContaining("raw-validation-secret") });
  });

  it("rejects unlisted commands and contract authority mismatch before approval", async () => {
    const fixture = await commandFixture();
    expect(() => fixture.executor.register("unlisted", { command: commands().unlisted, settings: fixture.settings })).toThrow("trusted allowlist");
    expect(() => new PortableValidationCommandExecutor({ allowedCommands: [], brokerAudit: { append: async () => undefined } })).toThrow("non-empty unique allowlist");
    expect(() => new PortableValidationCommandExecutor({ allowedCommands: [commands().pass, ` ${commands().pass} `], brokerAudit: { append: async () => undefined } })).toThrow("unique allowlist");
    expect(() => new PortableValidationCommandExecutor({ allowedCommands: Array.from({ length: 101 }, (_, index) => `command-${index}`), brokerAudit: { append: async () => undefined } })).toThrow("bounded commands");

    const registration = fixture.executor.register("action-1", { command: commands().pass, settings: fixture.settings });
    await expect(fixture.executor.authorize!({
      cell: cell("isolated"), workingDirectory: fixture.root,
      contract: contract(registration, { action: { kind: "shell.exec", risk: "execute", payloadDigest: digest } }),
      lease: lease(fixture.settings.shellPath)
    })).rejects.toThrow("payload");
    await expect(fixture.executor.authorize!({
      cell: cell("isolated"), workingDirectory: fixture.root,
      contract: contract(registration, { expectedEffects: [{ kind: "file.create", target: "claimed.txt", description: "Not allowed." }] }),
      lease: lease(fixture.settings.shellPath)
    })).rejects.toThrow("must not predict");
    expect(fixture.approvals).toEqual([]);
  });

  it("does not execute when approval interrupts admission", async () => {
    const fixture = await commandFixture({ rejectApproval: true });
    const registration = fixture.executor.register("action-1", { command: commands().mutate, settings: fixture.settings });
    const action = contract(registration);
    await expect(fixture.executor.authorize!({ cell: cell("isolated"), workingDirectory: fixture.root, contract: action, lease: lease(fixture.settings.shellPath) })).rejects.toThrow("Approval required");
    await expect(fixture.executor.execute({ cell: cell("executing"), workingDirectory: fixture.root, contract: action, lease: lease(fixture.settings.shellPath) })).rejects.toThrow("not admitted");
    await expect(access(join(fixture.root, "unexpected.txt"))).rejects.toThrow();
    expect(fixture.brokerAudit).toEqual([]);
  });

  it("chains validation after an intended write without reporting the existing cell effect again", async () => {
    const fixture = await commandFixture();
    const leases = new InMemoryLeaseUseStore();
    const receipts = new InMemoryReceiptChainStore();
    let id = 0;
    const common = { authorize: async () => undefined, toolAudit: async () => undefined, brokerAudit: { append: async () => undefined }, leases, receipts, now: () => new Date("2026-07-11T16:00:01.000Z"), id: () => `chain-receipt-${++id}` };
    const writer = new PortableFileActionExecutor(common);
    const validator = new PortableValidationCommandExecutor({ ...common, allowedCommands: [commands().pass] });
    const composite = new CompositePortableActionExecutor([
      { kinds: ["file.write"], executor: writer },
      { kinds: ["shell.exec"], executor: validator }
    ]);
    const writeRegistration = writer.registerFileWrite("write-action", { settings: fixture.settings, relativePath: "generated.txt", content: "generated\n" });
    const writeAuthority = fileLease("write-lease", fixture.settings.shellPath);
    const writeInput = actionInput(fixture.root, fileContract(writeRegistration, writeAuthority), writeAuthority);
    await composite.authorize(writeInput);
    const writeReceipt = await composite.execute(writeInput);
    const validationRegistration = validator.register("validation-action", { command: commands().pass, settings: fixture.settings });
    const validationAuthority = lease(fixture.settings.shellPath, "validation-lease");
    const validationInput = actionInput(fixture.root, contract(validationRegistration, { id: "validation-action", leaseId: validationAuthority.id }), validationAuthority);
    await composite.authorize(validationInput);
    const validationReceipt = await composite.execute(validationInput);

    expect(writeReceipt.status).toBe("succeeded");
    expect(validationReceipt).toMatchObject({ status: "succeeded", observedEffects: [], variances: [] });
    expect(validationReceipt.previousReceiptDigest).toBe(executionDigest(writeReceipt));
    expect(await readFile(join(fixture.root, "generated.txt"), "utf8")).toBe("generated\n");
  });

  it("validates inside a real portable cell and promotes only after both receipts pass", async () => {
    const fixture = await commandFixture();
    const base = await git(fixture.root, ["rev-parse", "HEAD"]);
    const dataRoot = await mkdtemp(join(tmpdir(), "nexus-validation-cells-"));
    sandboxes.push(dataRoot);
    const leases = new InMemoryLeaseUseStore();
    const receipts = new InMemoryReceiptChainStore();
    let id = 0;
    const now = () => new Date("2026-07-11T16:00:01.000Z");
    const common = { authorize: async () => undefined, toolAudit: async () => undefined, brokerAudit: { append: async () => undefined }, leases, receipts, now, id: () => `provider-receipt-${++id}` };
    const writer = new PortableFileActionExecutor(common);
    const validator = new PortableValidationCommandExecutor({ ...common, allowedCommands: [commands().pass] });
    const provider = new PortableWorktreeProvider({
      workspaceRoot: fixture.root,
      dataRoot,
      actionExecutor: new CompositePortableActionExecutor([
        { kinds: ["file.write"], executor: writer },
        { kinds: ["shell.exec"], executor: validator }
      ]),
      now,
      id: () => `provider-record-${++id}`
    });
    const service = new TransactionService({ provider, now });
    await service.prepare(cellSpecSchema.parse({
      schemaVersion: 1, id: "cell-1", objectiveId: "objective-1", provider: "portable-worktree", baseRevision: base,
      workspaceRootDigest: portableWorkspaceDigest(fixture.root),
      capabilities: { read: ["**"], write: ["generated.txt"], delete: [], execute: [fixture.settings.shellPath], network: [], secrets: [] },
      budget: { wallTimeMs: 60_000, cpuTimeMs: 30_000, memoryBytes: 512 * 1024 * 1024, diskBytes: 1024 * 1024 * 1024, processCount: 20, outputBytes: 1024 * 1024 },
      networkDefault: "deny", retention: { keepFailedMs: 60_000, keepCommittedMs: 0 }, createdAt: at
    }));
    const writeRegistration = writer.registerFileWrite("write-action", { settings: fixture.settings, relativePath: "generated.txt", content: "generated\n" });
    const writeAuthority = fileLease("write-lease", fixture.settings.shellPath);
    await service.execute("cell-1", fileContract(writeRegistration, writeAuthority), writeAuthority);
    await expect(access(join(fixture.root, "generated.txt"))).rejects.toThrow();
    const validationRegistration = validator.register("validation-action", { command: commands().pass, settings: fixture.settings });
    const validationAuthority = lease(fixture.settings.shellPath, "validation-lease");
    await service.execute("cell-1", contract(validationRegistration, { id: "validation-action", leaseId: validationAuthority.id }), validationAuthority);
    await expect(service.verify("cell-1")).resolves.toMatchObject({ ready: true });
    await expect(service.commit("cell-1")).resolves.toMatchObject({ receipt: { status: "committed" } });
    expect(await readFile(join(fixture.root, "generated.txt"), "utf8")).toBe("generated\n");
    await service.destroy("cell-1");
  });
});

async function commandFixture(options: { rejectApproval?: boolean } = {}) {
  const root = await mkdtemp(join(tmpdir(), "nexus-validation-command-"));
  sandboxes.push(root);
  await mkdir(join(root, "src"));
  await writeFile(join(root, "src", "base.txt"), "base\n", "utf8");
  await git(root, ["init", "-b", "main"]);
  await git(root, ["config", "user.name", "Validation Test"]);
  await git(root, ["config", "user.email", "validation@example.invalid"]);
  await git(root, ["add", "."]);
  await git(root, ["commit", "-m", "base"]);
  const approvals: Array<{ action: string; payload: unknown }> = [];
  const brokerAudit: BrokerAuditRecord[] = [];
  let id = 0;
  const settings = settingsFixture(root);
  const executor = new PortableValidationCommandExecutor({
    allowedCommands: [commands().pass, commands().mutate, commands().fail],
    authorize: async (_settings, action, _risk, payload) => {
      approvals.push({ action, payload });
      if (options.rejectApproval) throw new Error("Approval required for shell.exec.");
    },
    toolAudit: async () => undefined,
    brokerAudit: { append: async (record) => { brokerAudit.push(record); } },
    now: () => new Date("2026-07-11T16:00:01.000Z"),
    id: () => `receipt-${++id}`
  });
  return { root, settings, executor, approvals, brokerAudit };
}

function contract(registration: { payloadDigest: string; shell: string }, overrides: Record<string, unknown> = {}): ContractedAction {
  return contractedActionSchema.parse({
    schemaVersion: 1, id: "action-1", objectiveId: "objective-1", cellId: "cell-1", leaseId: "lease-1",
    issuedAt: at, expiresAt: "2026-07-11T17:00:00.000Z", purpose: "Run one trusted validation command in the disposable worktree.",
    action: { kind: "shell.exec", risk: "execute", payloadDigest: registration.payloadDigest }, capabilities: capabilities(registration.shell),
    requires: [{ kind: "execute", value: registration.shell }], preconditions: ["The command is configured by the operator."],
    expectedEffects: [], forbiddenEffects: [], invariants: ["No Git-visible repository path changes."],
    successEvidence: ["The command exits zero and the broker observes no repository effects."], rollback: { kind: "discard_cell", description: "Discard the cell." },
    ...overrides
  });
}

function lease(shell: string, id = "lease-1"): CapabilityLease {
  return capabilityLeaseSchema.parse({
    schemaVersion: 1, id, objectiveId: "objective-1", cellId: "cell-1", issuedAt: at,
    expiresAt: "2026-07-11T17:00:00.000Z", singleUse: true, status: "active", capabilities: capabilities(shell), policyVersion: "portable-validation-command-v1"
  });
}

function fileLease(id: string, shell: string): CapabilityLease {
  return capabilityLeaseSchema.parse({
    schemaVersion: 1, id, objectiveId: "objective-1", cellId: "cell-1", issuedAt: at,
    expiresAt: "2026-07-11T17:00:00.000Z", singleUse: true, status: "active",
    capabilities: { read: ["**"], write: ["generated.txt"], delete: [], execute: [shell], network: [], secrets: [] }, policyVersion: "portable-routed-v1"
  });
}

function fileContract(registration: { payloadDigest: string; afterDigest: string; relativePath: string }, authority: CapabilityLease) {
  return contractedActionSchema.parse({
    schemaVersion: 1, id: "write-action", objectiveId: authority.objectiveId, cellId: authority.cellId, leaseId: authority.id,
    issuedAt: authority.issuedAt, expiresAt: authority.expiresAt, purpose: "Create one file before validation.",
    action: { kind: "file.write", risk: "write", payloadDigest: registration.payloadDigest }, capabilities: authority.capabilities,
    requires: [{ kind: "write", value: registration.relativePath }], preconditions: [],
    expectedEffects: [
      { kind: "file.create", target: registration.relativePath, required: false, expectedDigest: registration.afterDigest, description: "Create the file." },
      { kind: "file.update", target: registration.relativePath, required: false, expectedDigest: registration.afterDigest, description: "Update the file." }
    ],
    forbiddenEffects: [], invariants: ["No other path changes."], successEvidence: ["Broker observes the expected digest."],
    rollback: { kind: "discard_cell", description: "Discard the cell." }
  });
}

function actionInput(root: string, action: ContractedAction, authority: CapabilityLease) {
  return { cell: cell("executing"), workingDirectory: root, contract: action, lease: authority };
}

function capabilities(shell: string) { return { read: ["**"], write: [], delete: [], execute: [shell], network: [], secrets: [] }; }
function cell(state: "isolated" | "executing") { return executionCellSchema.parse({ schemaVersion: 1, id: "cell-1", specDigest: digest, provider: "portable-worktree", providerRef: "portable:cell-1", baseRevision: "a".repeat(40), state, preparedAt: at, updatedAt: at }); }

function commands() {
  return process.platform === "win32"
    ? {
        pass: "Write-Output 'validation-output-marker'",
        mutate: "Set-Content -LiteralPath 'unexpected.txt' -Value 'unexpected' -Encoding UTF8",
        fail: "Write-Error 'raw-validation-secret'; exit 7",
        unlisted: "Write-Output 'unlisted'"
      }
    : {
        pass: "printf 'validation-output-marker\\n'",
        mutate: "printf 'unexpected\\n' > unexpected.txt",
        fail: "printf 'raw-validation-secret\\n' >&2; exit 7",
        unlisted: "printf 'unlisted\\n'"
      };
}

function settingsFixture(workspaceRoot: string): Settings {
  return {
    workspaceRoot, layout: "chat", maxIterations: 1, maxParallelExecutors: 1, criticThreshold: 7, approvalMode: true,
    shellPath: process.platform === "win32" ? "powershell.exe" : "/bin/sh", testCommand: "", lintCommand: "", mcpAutoDiscovery: false,
    mcpPortStart: 3000, mcpPortEnd: 3001, memoryTokenBudget: 100, agentModels: {}
  };
}

async function git(cwd: string, args: string[]) {
  const result = await execFileAsync("git", args, { cwd, windowsHide: true });
  return result.stdout.trim();
}

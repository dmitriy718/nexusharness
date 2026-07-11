import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { WindowsSandboxCommandExecutor, type SandboxCommandLauncher } from "../server/execution/windowsSandboxCommandExecutor";
import { capabilityLeaseSchema, contractedActionSchema, executionCellSchema, type CapabilityLease, type ContractedAction } from "../server/execution/contracts";
import type { BrokerAuditRecord } from "../server/execution/broker";
import type { Settings } from "../server/types";

const at = "2026-07-11T10:00:00.000Z";
const digest = `sha256:${"a".repeat(64)}`;
const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

describe("Windows Sandbox command executor", () => {
  it("binds approval to a digest, transports an encoded command, and receipts host-observed effects", async () => {
    const fixture = await commandFixture();
    const registration = fixture.executor.register("action-1", { command: "Set-Content generated.txt 'safe-secret-command'", settings: fixture.settings, context: { runId: "run-1" } });
    const action = contract(registration.payloadDigest);
    await fixture.executor.authorize!({ cell: cell("isolated"), workingDirectory: fixture.root, contract: action, lease: lease() });
    const receipt = await fixture.executor.execute({ cell: cell("executing"), workingDirectory: fixture.root, contract: action, lease: lease() });
    expect(receipt).toMatchObject({ status: "succeeded", observedEffects: [{ kind: "file.create", target: "generated.txt", status: "created" }] });
    expect(fixture.bootstrap).toContain("-EncodedCommand");
    expect(fixture.bootstrap).not.toContain("safe-secret-command");
    expect(fixture.executor.takeResult("action-1")).toEqual({ exitCode: 0, stdout: "ok", stderr: "" });
    expect(fixture.executor.takeResult("action-1")).toBeUndefined();
    expect(fixture.approvals).toEqual([expect.objectContaining({ action: "shell.exec", payload: expect.objectContaining({ shell: "windows-sandbox:powershell.exe" }) })]);
    expect(JSON.stringify(fixture.audit)).not.toContain("safe-secret-command");
  });

  it("rejects command tampering before approval", async () => {
    const fixture = await commandFixture();
    fixture.executor.register("action-1", { command: "Write-Output safe", settings: fixture.settings });
    await expect(fixture.executor.authorize!({ cell: cell("isolated"), workingDirectory: fixture.root, contract: contract(digest), lease: lease() })).rejects.toThrow("payload");
    expect(fixture.approvals).toEqual([]);
  });

  it("returns a failed receipt without raw guest errors when the command exits nonzero", async () => {
    const fixture = await commandFixture({ exitCode: 7 });
    const registration = fixture.executor.register("action-1", { command: "throw 'raw-secret-error'", settings: fixture.settings });
    const action = contract(registration.payloadDigest, { expectedEffects: [] });
    await fixture.executor.authorize!({ cell: cell("isolated"), workingDirectory: fixture.root, contract: action, lease: lease() });
    const receipt = await fixture.executor.execute({ cell: cell("executing"), workingDirectory: fixture.root, contract: action, lease: lease() });
    expect(receipt.status).toBe("failed");
    expect(JSON.stringify(receipt)).not.toContain("raw-secret-error");
  });
});

async function commandFixture(options: { exitCode?: number } = {}) {
  const root = await mkdtemp(join(tmpdir(), "nexus-sandbox-command-")); roots.push(root);
  await git(root, ["init", "-b", "main"]); await git(root, ["config", "user.name", "Test"]); await git(root, ["config", "user.email", "test@example.invalid"]);
  await writeFile(join(root, "tracked.txt"), "base\n"); await git(root, ["add", "."]); await git(root, ["commit", "-m", "base"]);
  const audit: BrokerAuditRecord[] = []; const approvals: Array<{ action: string; payload: unknown }> = []; let bootstrap = "";
  const launcher: SandboxCommandLauncher = { async launch(input) {
    bootstrap = await readFile(join(input.hostFolder, input.bootstrapScript), "utf8");
    if (!options.exitCode) await writeFile(join(input.hostFolder, "generated.txt"), "generated\n");
    await writeFile(join(input.hostFolder, input.completionFile), JSON.stringify({ exitCode: options.exitCode ?? 0, stdout: "ok", stderr: options.exitCode ? "guest failure" : "" }));
  } };
  const settings = settingsFixture(root);
  const executor = new WindowsSandboxCommandExecutor({ configurationDirectory: join(root, "..", "config"), launcher, brokerAudit: { async append(record) { audit.push(record); } }, authorize: async (_settings, action, _risk, payload) => { approvals.push({ action, payload }); }, now: () => new Date(at), id: () => "receipt-1" });
  return { root, settings, executor, audit, approvals, get bootstrap() { return bootstrap; } };
}

function contract(payloadDigest: string, overrides: Record<string, unknown> = {}): ContractedAction { return contractedActionSchema.parse({ schemaVersion: 1, id: "action-1", objectiveId: "objective-1", cellId: "cell-1", leaseId: "lease-1", issuedAt: at, expiresAt: "2026-07-11T11:00:00.000Z", purpose: "Run validation in Windows Sandbox.", action: { kind: "shell.exec", risk: "execute", payloadDigest }, capabilities: capabilities(), requires: [{ kind: "execute", value: "powershell.exe" }], preconditions: [], expectedEffects: [{ kind: "file.create", target: "generated.txt", description: "Generated output" }], forbiddenEffects: [], invariants: ["Host remains isolated."], successEvidence: ["Broker receipt passes."], rollback: { kind: "discard_cell", description: "Discard cell." }, ...overrides }); }
function lease(): CapabilityLease { return capabilityLeaseSchema.parse({ schemaVersion: 1, id: "lease-1", objectiveId: "objective-1", cellId: "cell-1", issuedAt: at, expiresAt: "2026-07-11T11:00:00.000Z", singleUse: true, status: "active", capabilities: capabilities(), policyVersion: "windows-command-v1" }); }
function capabilities() { return { read: ["**"], write: ["**"], delete: ["**"], execute: ["powershell.exe"], network: [], secrets: [] }; }
function cell(state: "isolated" | "executing") { return executionCellSchema.parse({ schemaVersion: 1, id: "cell-1", specDigest: digest, provider: "windows-sandbox", providerRef: "windows:cell-1", baseRevision: "a".repeat(40), state, preparedAt: at, updatedAt: at }); }
function settingsFixture(workspaceRoot: string): Settings { return { workspaceRoot, layout: "chat", maxIterations: 1, maxParallelExecutors: 1, criticThreshold: 7, approvalMode: true, shellPath: "powershell.exe", testCommand: "", lintCommand: "", mcpAutoDiscovery: false, mcpPortStart: 3000, mcpPortEnd: 3001, memoryTokenBudget: 100, agentModels: {} }; }
function git(cwd: string, args: string[]) { return new Promise<string>((resolve, reject) => { const child = spawn("git", args, { cwd, windowsHide: true }); let stdout = ""; let stderr = ""; child.stdout.on("data", (chunk) => { stdout += chunk; }); child.stderr.on("data", (chunk) => { stderr += chunk; }); child.on("error", reject); child.on("close", (code) => code === 0 ? resolve(stdout.trim()) : reject(new Error(stderr))); }); }

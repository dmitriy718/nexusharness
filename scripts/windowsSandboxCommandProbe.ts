import { spawn } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WindowsSandboxCommandExecutor } from "../server/execution/windowsSandboxCommandExecutor.js";
import { WindowsSandboxProvider } from "../server/execution/windowsSandboxProvider.js";
import { capabilityLeaseSchema, cellSpecSchema, contractedActionSchema, executionDigest } from "../server/execution/contracts.js";
import { portableWorkspaceDigest } from "../server/execution/portableWorktreeProvider.js";
import type { BrokerAuditRecord } from "../server/execution/broker.js";
import type { Settings } from "../server/types.js";

if (process.platform !== "win32") throw new Error("The Windows Sandbox command probe requires Windows.");
const sandbox = await mkdtemp(join(tmpdir(), "nexus-windows-command-probe-"));
const root = join(sandbox, "repository");
const cells = join(sandbox, "cells");
const configurations = join(sandbox, "configurations");
const outputName = "sandbox-command-output.txt";
let provider: WindowsSandboxProvider | undefined;
try {
  await mkdir(root);
  await git(root, ["init", "-b", "main"]);
  await git(root, ["config", "user.name", "Nexus Sandbox Probe"]);
  await git(root, ["config", "user.email", "sandbox-probe@local.invalid"]);
  await writeFile(join(root, "seed.txt"), "base\n", "utf8");
  await git(root, ["add", "."]); await git(root, ["commit", "-m", "base"]);
  const base = await git(root, ["rev-parse", "HEAD"]);
  const audit: BrokerAuditRecord[] = [];
  const settings = settingsFor(root);
  const executor = new WindowsSandboxCommandExecutor({
    configurationDirectory: configurations,
    brokerAudit: { async append(record) { audit.push(record); } },
    authorize: async () => undefined
  });
  provider = new WindowsSandboxProvider({ workspaceRoot: root, dataRoot: cells, actionExecutor: executor });
  const specification = cellSpecSchema.parse({
    schemaVersion: 1, id: "command-probe", objectiveId: "command-probe-objective", provider: "windows-sandbox",
    baseRevision: base, workspaceRootDigest: portableWorkspaceDigest(root),
    capabilities: capabilities(),
    budget: { wallTimeMs: 10 * 60_000, cpuTimeMs: 5 * 60_000, memoryBytes: 1024 * 1024 * 1024, diskBytes: 1024 * 1024 * 1024, processCount: 50, outputBytes: 10 * 1024 * 1024 },
    networkDefault: "deny", retention: { keepFailedMs: 60_000, keepCommittedMs: 0 }, createdAt: new Date().toISOString()
  });
  await provider.prepare(specification);
  const command = `Set-Content -LiteralPath 'C:\\NexusCell\\${outputName}' -Value 'sandbox-command-passed' -Encoding UTF8`;
  const registration = executor.register("command-action", { command, settings, context: { runId: "command-probe", subtask: "Real Sandbox command smoke" } });
  const issuedAt = new Date(); const expiresAt = new Date(issuedAt.getTime() + 10 * 60_000);
  const contract = contractedActionSchema.parse({
    schemaVersion: 1, id: "command-action", objectiveId: "command-probe-objective", cellId: "command-probe", leaseId: "command-lease",
    issuedAt: issuedAt.toISOString(), expiresAt: expiresAt.toISOString(), purpose: "Prove brokered command execution in the real Windows Sandbox guest.",
    action: { kind: "shell.exec", risk: "execute", payloadDigest: registration.payloadDigest }, capabilities: capabilities(),
    requires: [{ kind: "execute", value: "powershell.exe" }], preconditions: ["The primary Git checkout is clean."],
    expectedEffects: [{ kind: "file.create", target: outputName, description: "Sandbox command output crosses the mapped transaction boundary." }],
    forbiddenEffects: [{ kind: "git.ref", target: "refs/**", description: "The guest cannot change primary Git refs." }],
    invariants: ["Primary checkout remains unchanged until receipt-gated promotion."], successEvidence: ["Broker receipt and host effect observation pass."],
    rollback: { kind: "discard_cell", description: "Discard the isolated worktree." }
  });
  const lease = capabilityLeaseSchema.parse({
    schemaVersion: 1, id: "command-lease", objectiveId: "command-probe-objective", cellId: "command-probe",
    issuedAt: issuedAt.toISOString(), expiresAt: expiresAt.toISOString(), singleUse: true, status: "active", capabilities: capabilities(), policyVersion: "windows-sandbox-command-v1"
  });
  console.log("Launching the real brokered Windows Sandbox command probe. The Sandbox window should close automatically.");
  await provider.authorize("command-probe", contract, lease);
  const receipt = await provider.execute("command-probe", contract, lease);
  const result = executor.takeResult("command-action");
  const effects = await provider.diff("command-probe");
  const primaryUnchanged = !(await exists(join(root, outputName)));
  if (receipt.status !== "succeeded" || !result || result.exitCode !== 0 || !primaryUnchanged || !effects.effects.some((effect) => effect.kind === "file.create" && effect.target === outputName)) {
    throw new Error("Real Sandbox command did not satisfy receipt, result, isolation, and effect assertions.");
  }
  await provider.transition("command-probe", "ready_to_commit");
  const commit = await provider.commit("command-probe", base, [executionDigest(receipt)]);
  const promoted = (await readFile(join(root, outputName), "utf8")).trim() === "sandbox-command-passed";
  const passed = commit.status === "committed" && promoted && audit.some((record) => record.status === "succeeded");
  console.log(JSON.stringify({ receipt: receipt.status, exitCode: result.exitCode, primaryUnchanged, effects: effects.effects.map(({ kind, target }) => ({ kind, target })), commit: commit.status, promoted, passed }, null, 2));
  if (!passed) throw new Error("Real Sandbox command promotion assertions failed.");
  console.log("Windows Sandbox command provider probe passed.");
} finally {
  if (provider) await provider.destroy("command-probe").catch(() => undefined);
  await rm(sandbox, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
}

function capabilities() { return { read: ["**"], write: ["**"], delete: ["**"], execute: ["powershell.exe"], network: [], secrets: [] }; }
function settingsFor(workspaceRoot: string): Settings { return { workspaceRoot, layout: "chat", maxIterations: 1, maxParallelExecutors: 1, criticThreshold: 7, approvalMode: false, shellPath: "powershell.exe", testCommand: "", lintCommand: "", mcpAutoDiscovery: false, mcpPortStart: 3000, mcpPortEnd: 3001, memoryTokenBudget: 100, agentModels: {} }; }
async function exists(target: string) { try { await access(target); return true; } catch { return false; } }
function git(cwd: string, args: string[]) { return new Promise<string>((resolve, reject) => { const child = spawn("git", args, { cwd, windowsHide: true }); let stdout = ""; let stderr = ""; child.stdout.on("data", (chunk) => { stdout += chunk; }); child.stderr.on("data", (chunk) => { stderr += chunk; }); child.on("error", reject); child.on("close", (code) => code === 0 ? resolve(stdout.trim()) : reject(new Error(`git ${args[0]} failed: ${stderr || stdout}`))); }); }

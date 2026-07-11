import { afterEach, describe, expect, it } from "vitest";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PortableFileActionExecutor } from "../server/execution/fileActionExecutor";
import {
  capabilityLeaseSchema,
  contractedActionSchema,
  executionCellSchema,
  type CapabilityLease,
  type ContractedAction
} from "../server/execution/contracts";
import type { BrokerAuditRecord } from "../server/execution/broker";
import type { Settings } from "../server/types";

const at = "2026-07-11T10:00:00.000Z";
const digest = `sha256:${"a".repeat(64)}`;
const sandboxes: string[] = [];

afterEach(async () => {
  await Promise.all(sandboxes.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("portable deterministic file action executor", () => {
  it("admits an approved write, executes it through the broker, and reports the observed effect", async () => {
    const fixture = await actionFixture();
    const registered = fixture.executor.registerFileWrite("action-1", {
      settings: fixture.settings,
      relativePath: "src/generated.ts",
      content: "export const generated = true;\n",
      context: { runId: "run-1", subtask: "Generate source" }
    });
    const action = contract(registered);
    await fixture.executor.authorize!({ cell: cell("isolated"), workingDirectory: fixture.root, contract: action, lease: lease() });
    const receipt = await fixture.executor.execute({ cell: cell("executing"), workingDirectory: fixture.root, contract: action, lease: lease() });

    expect(receipt).toMatchObject({ status: "succeeded", observedEffects: [{ kind: "file.create", target: "src/generated.ts", status: "created", afterDigest: registered.afterDigest }] });
    expect(await readFile(join(fixture.root, "src", "generated.ts"), "utf8")).toContain("generated = true");
    expect(fixture.approvals).toEqual([expect.objectContaining({ action: "file.write", payload: expect.objectContaining({ relativePath: "src/generated.ts", nextSha256: registered.afterDigest.slice(7) }) })]);
    expect(fixture.brokerAudit).toEqual([expect.objectContaining({ mode: "enforced", status: "succeeded", action: "file.write" })]);
    expect(JSON.stringify(fixture.brokerAudit)).not.toContain("generated = true");
  });

  it("fails closed when the file changes after approval and preserves the intervening content", async () => {
    const fixture = await actionFixture();
    await writeFile(join(fixture.root, "src", "target.ts"), "before\n", "utf8");
    const registered = fixture.executor.registerFileWrite("action-1", { settings: fixture.settings, relativePath: "src/target.ts", content: "approved\n" });
    const action = contract(registered);
    await fixture.executor.authorize!({ cell: cell("isolated"), workingDirectory: fixture.root, contract: action, lease: lease() });
    await writeFile(join(fixture.root, "src", "target.ts"), "intervening\n", "utf8");

    const receipt = await fixture.executor.execute({ cell: cell("executing"), workingDirectory: fixture.root, contract: action, lease: lease() });
    expect(receipt.status).toBe("failed");
    expect(receipt.evidence).toContainEqual(expect.objectContaining({ name: "Operation result", status: "failed" }));
    expect(receipt.observedEffects).toEqual([]);
    expect(await readFile(join(fixture.root, "src", "target.ts"), "utf8")).toBe("intervening\n");
  });

  it("does not create or execute a file when approval admission stops", async () => {
    const fixture = await actionFixture({ rejectApproval: true });
    const registered = fixture.executor.registerFileWrite("action-1", { settings: fixture.settings, relativePath: "src/rejected.ts", content: "rejected\n" });
    const action = contract(registered);
    await expect(fixture.executor.authorize!({ cell: cell("isolated"), workingDirectory: fixture.root, contract: action, lease: lease() })).rejects.toThrow("Approval required");
    await expect(access(join(fixture.root, "src", "rejected.ts"))).rejects.toThrow();
    await expect(fixture.executor.execute({ cell: cell("executing"), workingDirectory: fixture.root, contract: action, lease: lease() })).rejects.toThrow("not admitted");
    expect(fixture.brokerAudit).toEqual([]);
  });

  it("rejects payload and predicted-effect mismatch before requesting approval", async () => {
    const fixture = await actionFixture();
    const registered = fixture.executor.registerFileWrite("action-1", { settings: fixture.settings, relativePath: "src/guarded.ts", content: "guarded\n" });
    const mismatchedPayload = contract(registered, { action: { kind: "file.write", risk: "write", payloadDigest: digest } });
    await expect(fixture.executor.authorize!({ cell: cell("isolated"), workingDirectory: fixture.root, contract: mismatchedPayload, lease: lease() })).rejects.toThrow("payload");
    const mismatchedEffect = contract(registered, { expectedEffects: [] });
    await expect(fixture.executor.authorize!({ cell: cell("isolated"), workingDirectory: fixture.root, contract: mismatchedEffect, lease: lease() })).rejects.toThrow("does not predict");
    expect(fixture.approvals).toEqual([]);
  });
});

async function actionFixture(options: { rejectApproval?: boolean } = {}) {
  const root = await mkdtemp(join(tmpdir(), "nexus-file-action-"));
  sandboxes.push(root);
  await mkdir(join(root, "src"));
  const approvals: Array<{ action: string; payload: unknown }> = [];
  const brokerAudit: BrokerAuditRecord[] = [];
  const settings = settingsFixture(root);
  let record = 0;
  const executor = new PortableFileActionExecutor({
    authorize: async (_settings, action, _risk, payload) => {
      approvals.push({ action, payload });
      if (options.rejectApproval) throw new Error("Approval required for file.write.");
    },
    toolAudit: async () => undefined,
    brokerAudit: { async append(entry) { brokerAudit.push(entry); } },
    now: () => new Date(record++ ? "2026-07-11T10:00:01.000Z" : at),
    id: () => `receipt-${record}`
  });
  return { root, settings, approvals, brokerAudit, executor };
}

function contract(
  registered: { payloadDigest: string; afterDigest: string; relativePath: string },
  overrides: Record<string, unknown> = {}
): ContractedAction {
  return contractedActionSchema.parse({
    schemaVersion: 1,
    id: "action-1",
    objectiveId: "objective-1",
    cellId: "cell-1",
    leaseId: "lease-1",
    issuedAt: at,
    expiresAt: "2026-07-11T11:00:00.000Z",
    purpose: "Write one approved file in the isolated workspace.",
    action: { kind: "file.write", risk: "write", payloadDigest: registered.payloadDigest },
    capabilities: capabilities(registered.relativePath),
    requires: [{ kind: "write", value: registered.relativePath }],
    preconditions: ["The file still matches the operator-approved before digest."],
    expectedEffects: [
      { kind: "file.create", target: registered.relativePath, required: false, expectedDigest: registered.afterDigest, description: "Create the approved file." },
      { kind: "file.update", target: registered.relativePath, required: false, expectedDigest: registered.afterDigest, description: "Update the approved file." }
    ],
    forbiddenEffects: [],
    invariants: ["No other path changes."],
    successEvidence: ["The broker observes the approved content digest."],
    rollback: { kind: "discard_cell", description: "Discard the portable cell." },
    ...overrides
  });
}

function lease(): CapabilityLease {
  return capabilityLeaseSchema.parse({
    schemaVersion: 1,
    id: "lease-1",
    objectiveId: "objective-1",
    cellId: "cell-1",
    issuedAt: at,
    expiresAt: "2026-07-11T11:00:00.000Z",
    singleUse: true,
    status: "active",
    capabilities: capabilities("src/generated.ts", "src/target.ts", "src/rejected.ts", "src/guarded.ts"),
    policyVersion: "portable-file-write-v1"
  });
}

function capabilities(...write: string[]) {
  return { read: [], write, delete: [], execute: [], network: [], secrets: [] };
}

function cell(state: "isolated" | "executing") {
  return executionCellSchema.parse({ schemaVersion: 1, id: "cell-1", specDigest: digest, provider: "portable-worktree", providerRef: "fixture:cell-1", baseRevision: "a".repeat(40), state, preparedAt: at, updatedAt: at });
}

function settingsFixture(workspaceRoot: string): Settings {
  return {
    workspaceRoot,
    layout: "chat",
    maxIterations: 1,
    maxParallelExecutors: 1,
    criticThreshold: 7,
    approvalMode: true,
    shellPath: "shell",
    testCommand: "",
    lintCommand: "",
    mcpAutoDiscovery: false,
    mcpPortStart: 3000,
    mcpPortEnd: 3001,
    memoryTokenBudget: 100,
    agentModels: {}
  };
}

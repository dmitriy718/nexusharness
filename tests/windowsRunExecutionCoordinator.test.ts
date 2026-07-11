import { afterEach, describe, expect, it } from "vitest";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { WindowsRunExecutionCoordinator } from "../server/execution/windowsRunExecutionCoordinator";
import type { SandboxCommandLauncher } from "../server/execution/windowsSandboxCommandExecutor";
import { executionDigest } from "../server/execution/contracts";
import type { Settings } from "../server/types";

const execFileAsync = promisify(execFile);
const roots: string[] = [];

afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

describe("Windows run execution coordinator", () => {
  it("chains deterministic files and predicted Sandbox commands into one promotable transaction", async () => {
    const fixture = await coordinatorFixture();
    const prepared = await fixture.coordinator.prepare();
    expect(prepared).toMatchObject({ provider: "windows-sandbox", securityBoundary: true, state: "isolated" });
    expect(fixture.coordinator.boundaryDescription).toContain("deterministic file actions");

    const write = await fixture.coordinator.write("brokered.txt", "brokered\n");
    const command = await fixture.coordinator.shell("Set-Content sandbox-output.txt 'sandboxed'", [
      { kind: "file.create", target: "sandbox-output.txt", description: "Create the predicted Sandbox output." }
    ]);
    expect(command).toMatchObject({ receipt: { status: "succeeded", observedEffects: [expect.objectContaining({ target: "sandbox-output.txt" })] }, result: { exitCode: 0 }, diagnostic: { stage: "complete" } });
    expect(command.receipt.previousReceiptDigest).toBe(executionDigest(write.receipt));
    expect(await fixture.coordinator.read("sandbox-output.txt")).toBe("sandboxed\n");
    await expect(access(join(fixture.root, "brokered.txt"))).rejects.toThrow();
    await expect(access(join(fixture.root, "sandbox-output.txt"))).rejects.toThrow();

    const validation = await fixture.coordinator.validate(fixture.validation);
    expect(validation.receipt.previousReceiptDigest).toBe(executionDigest(command.receipt));
    await expect(fixture.coordinator.verify()).resolves.toMatchObject({ ready: true });
    await expect(fixture.coordinator.commit()).resolves.toMatchObject({ receipt: { status: "committed" } });
    await fixture.coordinator.destroy();
    expect(await readFile(join(fixture.root, "brokered.txt"), "utf8")).toBe("brokered\n");
    expect(await readFile(join(fixture.root, "sandbox-output.txt"), "utf8")).toBe("sandboxed\n");
    expect(fixture.audit.filter((record) => record.status === "succeeded")).toHaveLength(3);
  }, 30_000);

  it("blocks an unpredicted Sandbox file effect", async () => {
    const fixture = await coordinatorFixture({ mutateEveryCommand: true });
    await fixture.coordinator.prepare();
    const execution = await fixture.coordinator.shell("Write-Output unexpected", []);
    expect(execution).toMatchObject({ receipt: { status: "failed", variances: [expect.objectContaining({ kind: "unexpected", effectTarget: "sandbox-output.txt" })] } });
    await expect(fixture.coordinator.verify()).resolves.toMatchObject({ ready: false });
    await fixture.coordinator.rollback();
    await fixture.coordinator.destroy();
    await expect(access(join(fixture.root, "sandbox-output.txt"))).rejects.toThrow();
  }, 30_000);
});

async function coordinatorFixture(options: { mutateEveryCommand?: boolean } = {}) {
  const sandbox = await mkdtemp(join(tmpdir(), "nexus-windows-run-")); roots.push(sandbox);
  const root = join(sandbox, "repository");
  const dataRoot = join(sandbox, "cells");
  const configurationDirectory = join(sandbox, "configurations");
  await mkdir(root);
  await execFileAsync("git", ["init", "-b", "main"], { cwd: root, windowsHide: true });
  await execFileAsync("git", ["config", "user.name", "Windows Coordinator Test"], { cwd: root, windowsHide: true });
  await execFileAsync("git", ["config", "user.email", "windows-coordinator@example.invalid"], { cwd: root, windowsHide: true });
  await writeFile(join(root, "base.txt"), "base\n");
  await execFileAsync("git", ["add", "."], { cwd: root, windowsHide: true });
  await execFileAsync("git", ["commit", "-m", "base"], { cwd: root, windowsHide: true });
  let launches = 0;
  const launcher: SandboxCommandLauncher = { async launch(input) {
    launches += 1;
    if (options.mutateEveryCommand || launches === 1) await writeFile(join(input.hostFolder, "sandbox-output.txt"), "sandboxed\n");
    await writeFile(join(input.hostFolder, input.completionFile), JSON.stringify({ exitCode: 0, stdout: "ok", stderr: "", transportStatus: "completed", transportStage: "complete" }));
  } };
  const audit: Array<{ status: string }> = [];
  const validation = "Write-Output validation";
  let id = 0;
  const coordinator = new WindowsRunExecutionCoordinator({
    runId: "windows-run",
    settings: settings(root, validation),
    dataRoot,
    configurationDirectory,
    validationCommands: [validation],
    launcher,
    brokerAudit: { async append(record) { audit.push(record); } },
    authorize: async () => undefined,
    toolAudit: async () => undefined,
    persist: async () => undefined,
    id: () => `windows-run-record-${++id}`
  });
  return { root, coordinator, validation, audit };
}

function settings(workspaceRoot: string, validation: string): Settings {
  return {
    workspaceRoot, layout: "chat", maxIterations: 2, maxParallelExecutors: 1, criticThreshold: 7, approvalMode: false,
    shellPath: "powershell.exe", testCommand: validation, lintCommand: "", mcpAutoDiscovery: false,
    mcpPortStart: 3000, mcpPortEnd: 3001, memoryTokenBudget: 100, agentModels: {}
  };
}

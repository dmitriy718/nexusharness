import { afterEach, describe, expect, it } from "vitest";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  WINDOWS_SANDBOX_SESSION_QUERY,
  WindowsSandboxProvider,
  WindowsSandboxLauncher,
  createWindowsSandboxProfile,
  parseWindowsSandboxJson,
  parseWindowsSandboxSessionIds,
  type WindowsSandboxActionExecutor,
  type WindowsSandboxProcessRunner,
  type WindowsSandboxSessionController
} from "../server/execution/windowsSandboxProvider";
import {
  actionReceiptSchema,
  capabilityLeaseSchema,
  cellSpecSchema,
  contractedActionSchema,
  executionDigest
} from "../server/execution/contracts";
import { portableWorkspaceDigest } from "../server/execution/portableWorktreeProvider";

const sandboxes: string[] = [];

afterEach(async () => {
  await Promise.all(sandboxes.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("Windows Sandbox launcher foundation", () => {
  it("decodes plain and Windows PowerShell BOM-prefixed JSON results", () => {
    expect(parseWindowsSandboxJson<{ passed: boolean }>(`${String.fromCodePoint(0xfeff)}{"passed":true}`)).toEqual({ passed: true });
    expect(parseWindowsSandboxJson<{ passed: boolean }>('{"passed":true}')).toEqual({ passed: true });
  });

  it("treats no remote sessions as a successful empty set", () => {
    expect(WINDOWS_SANDBOX_SESSION_QUERY).toContain("@(");
    expect(WINDOWS_SANDBOX_SESSION_QUERY).toContain("exit 0");
    expect(parseWindowsSandboxSessionIds("")).toEqual(new Set());
    expect(parseWindowsSandboxSessionIds("120\r\nnot-a-pid\r\n240\r\n")).toEqual(new Set([120, 240]));
  });

  it("emits a hardened profile with one escaped writable cell mapping", () => {
    const profile = createWindowsSandboxProfile({ hostFolder: "C:\\Nexus & Cells\\cell-1", bootstrapScript: "bootstrap.ps1", memoryMb: 6144 });
    expect(profile).toContain("<Networking>Disable</Networking>");
    expect(profile).toContain("<ClipboardRedirection>Disable</ClipboardRedirection>");
    expect(profile).toContain("<PrinterRedirection>Disable</PrinterRedirection>");
    expect(profile).toContain("<ProtectedClient>Enable</ProtectedClient>");
    expect(profile).toContain("<vGPU>Disable</vGPU>");
    expect(profile).toContain("<HostFolder>C:\\Nexus &amp; Cells\\cell-1</HostFolder>");
    expect(profile).toContain("<SandboxFolder>C:\\NexusCell</SandboxFolder>");
    expect(profile).toContain("<MemoryInMB>6144</MemoryInMB>");
    expect(profile.match(/<MappedFolder>/g)).toHaveLength(1);
  });

  it.each(["../bootstrap.ps1", "nested/bootstrap.ps1", "bootstrap.cmd", "bad name.ps1", "bad\nname.ps1"])(
    "rejects unsafe bootstrap identity %s",
    (bootstrapScript) => {
      expect(() => createWindowsSandboxProfile({ hostFolder: "C:\\NexusCells\\cell-1", bootstrapScript })).toThrow("safe .ps1 filename");
    }
  );

  it("rejects root mappings and out-of-range resources", () => {
    expect(() => createWindowsSandboxProfile({ hostFolder: "C:\\", bootstrapScript: "bootstrap.ps1" })).toThrow("non-root");
    expect(() => createWindowsSandboxProfile({ hostFolder: "C:\\cells\\one", bootstrapScript: "bootstrap.ps1", memoryMb: 1024 })).toThrow("memoryMb");
  });

  it("probes platform and launcher presence without claiming real-host verification", async () => {
    const sandbox = await fixture();
    const executable = join(sandbox, "WindowsSandbox.exe");
    await writeFile(executable, "fixture", "utf8");
    const available = await new WindowsSandboxLauncher({ executable, platform: "win32" }).probe();
    expect(available).toMatchObject({ launcherPresent: true, platformSupported: true, available: true });
    expect(available.reason).toContain("verification is still required");
    const unsupported = await new WindowsSandboxLauncher({ executable, platform: "linux" }).probe();
    expect(unsupported).toMatchObject({ launcherPresent: true, platformSupported: false, available: false });
  });

  it("writes the profile outside the mapped cell, invokes the runner, and always removes it", async () => {
    const sandbox = await fixture();
    const executable = join(sandbox, "WindowsSandbox.exe");
    const cell = join(sandbox, "cell");
    const configurations = join(sandbox, "configurations");
    await writeFile(executable, "fixture", "utf8");
    await mkdir(cell);
    await writeFile(join(cell, "bootstrap.ps1"), "exit 0", "utf8");
    let configurationPath = "";
    let captured = "";
    const runner: WindowsSandboxProcessRunner = {
      async run(receivedExecutable, receivedConfiguration, timeoutMs) {
        expect(receivedExecutable).toBe(executable);
        expect(timeoutMs).toBe(20_000);
        configurationPath = receivedConfiguration;
        captured = await readFile(receivedConfiguration, "utf8");
        await writeFile(join(cell, "complete.json"), "{}", "utf8");
      }
    };
    const sessionSnapshots = [new Set([10]), new Set([10, 20])];
    const stopped: number[][] = [];
    const sessions: WindowsSandboxSessionController = {
      async list() { return sessionSnapshots.shift() ?? new Set([10]); },
      async stop(ids) { stopped.push(ids); }
    };
    const launcher = new WindowsSandboxLauncher({ executable, platform: "win32", runner, sessions, id: () => "profile-1" });
    expect(launcher.securityBoundary).toBe(true);
    expect(launcher.boundaryDescription).toContain("verified by HR-004");
    await launcher.launch({ hostFolder: cell, configurationDirectory: configurations, bootstrapScript: "bootstrap.ps1", completionFile: "complete.json", timeoutMs: 20_000 });
    expect(captured).toContain(`<HostFolder>${cell}</HostFolder>`);
    expect(stopped).toEqual([[20]]);
    await expect(access(configurationPath)).rejects.toThrow();
  });

  it("cleans the temporary profile when the native boundary runner fails", async () => {
    const sandbox = await fixture();
    const executable = join(sandbox, "WindowsSandbox.exe");
    const cell = join(sandbox, "cell");
    const configurations = join(sandbox, "configurations");
    await writeFile(executable, "fixture", "utf8");
    await mkdir(cell);
    await writeFile(join(cell, "bootstrap.ps1"), "exit 1", "utf8");
    let configurationPath = "";
    const launcher = new WindowsSandboxLauncher({
      executable,
      platform: "win32",
      sessions: emptySessions(),
      id: () => "failure-profile",
      runner: { async run(_executable, receivedConfiguration) { configurationPath = receivedConfiguration; throw new Error("Sandbox failed"); } }
    });
    await expect(launcher.launch({ hostFolder: cell, configurationDirectory: configurations, bootstrapScript: "bootstrap.ps1", completionFile: "complete.json" })).rejects.toThrow("Sandbox failed");
    await expect(access(configurationPath)).rejects.toThrow();
  });

  it("refuses to place launcher configuration inside the mapped cell", async () => {
    const sandbox = await fixture();
    const executable = join(sandbox, "WindowsSandbox.exe");
    const cell = join(sandbox, "cell");
    await writeFile(executable, "fixture", "utf8");
    await mkdir(cell);
    await writeFile(join(cell, "bootstrap.ps1"), "exit 0", "utf8");
    const launcher = new WindowsSandboxLauncher({ executable, platform: "win32", runner: { async run() {} }, sessions: emptySessions() });
    await expect(launcher.launch({ hostFolder: cell, configurationDirectory: join(cell, "config"), bootstrapScript: "bootstrap.ps1", completionFile: "complete.json" })).rejects.toThrow("outside the mapped cell");
  });

  it("keeps the profile alive until the guest completion file appears", async () => {
    const sandbox = await fixture();
    const executable = join(sandbox, "WindowsSandbox.exe");
    const cell = join(sandbox, "cell");
    const configurations = join(sandbox, "configurations");
    await writeFile(executable, "fixture", "utf8");
    await mkdir(cell);
    await writeFile(join(cell, "bootstrap.ps1"), "exit 0", "utf8");
    let configurationPath = "";
    const launcher = new WindowsSandboxLauncher({
      executable,
      platform: "win32",
      sessions: emptySessions(),
      id: () => "deferred-completion",
      runner: {
        async run(_executable, receivedConfiguration) {
          configurationPath = receivedConfiguration;
          setTimeout(() => { void writeFile(join(cell, "complete.json"), "{}", "utf8"); }, 25);
        }
      }
    });
    await launcher.launch({ hostFolder: cell, configurationDirectory: configurations, bootstrapScript: "bootstrap.ps1", completionFile: "complete.json", timeoutMs: 10_000 });
    await expect(access(join(cell, "complete.json"))).resolves.toBeUndefined();
    await expect(access(configurationPath)).rejects.toThrow();
  });

  it.each(["../complete.json", "nested/complete.json", "bad name.json"])("rejects unsafe completion identity %s", async (completionFile) => {
    const sandbox = await fixture();
    const executable = join(sandbox, "WindowsSandbox.exe");
    const cell = join(sandbox, "cell");
    await writeFile(executable, "fixture", "utf8");
    await mkdir(cell);
    await writeFile(join(cell, "bootstrap.ps1"), "exit 0", "utf8");
    const launcher = new WindowsSandboxLauncher({ executable, platform: "win32", runner: { async run() {} }, sessions: emptySessions() });
    await expect(launcher.launch({ hostFolder: cell, configurationDirectory: join(sandbox, "config"), bootstrapScript: "bootstrap.ps1", completionFile })).rejects.toThrow("completionFile");
  });
});

describe("Windows Sandbox execution-cell provider", () => {
  it("composes verified Sandbox execution with isolated effects and receipt-gated promotion", async () => {
    const fixture = await repositoryFixture();
    const provider = fixture.provider();
    const specification = fixture.spec();
    const prepared = await provider.prepare(specification);
    expect(provider.securityBoundary).toBe(true);
    expect(prepared).toMatchObject({ provider: "windows-sandbox", state: "isolated", specDigest: executionDigest(specification) });
    await provider.authorize("cell-1", fixture.contract(), fixture.lease());
    const receipt = await provider.execute("cell-1", fixture.contract(), fixture.lease());
    expect(receipt.status).toBe("succeeded");
    expect((await provider.snapshot("cell-1", "Inspect verified execution")).state).toBe("verifying");
    expect((await provider.diff("cell-1")).effects).toContainEqual(expect.objectContaining({ kind: "file.update", target: "tracked.txt" }));
    expect(await readFile(join(fixture.root, "tracked.txt"), "utf8")).toBe("base\n");

    await provider.transition("cell-1", "ready_to_commit");
    const committed = await provider.commit("cell-1", fixture.base, [executionDigest(receipt)]);
    expect(committed).toMatchObject({ status: "committed", expectedBase: fixture.base });
    expect(await readFile(join(fixture.root, "tracked.txt"), "utf8")).toBe("sandboxed\n");
    await provider.destroy("cell-1");
    await expect(access(join(fixture.data, "worktrees", "cell-1"))).rejects.toThrow();
  });

  it("recovers interrupted transaction state without losing the Windows provider identity", async () => {
    const fixture = await repositoryFixture();
    const provider = fixture.provider();
    await provider.prepare(fixture.spec());
    await provider.transition("cell-1", "executing");
    const recovered = await fixture.provider().recover();
    expect(recovered).toContainEqual(expect.objectContaining({ id: "cell-1", provider: "windows-sandbox", state: "failed" }));
  });

  it("rejects non-Windows specs and host-only action executors", async () => {
    const fixture = await repositoryFixture();
    await expect(fixture.provider().prepare(cellSpecSchema.parse({ ...fixture.spec(), provider: "portable-worktree" }))).rejects.toThrow("cannot prepare portable-worktree");
    expect(() => new WindowsSandboxProvider({
      workspaceRoot: fixture.root,
      dataRoot: fixture.data,
      actionExecutor: { async execute() { throw new Error("host execution"); } } as unknown as WindowsSandboxActionExecutor
    })).toThrow("Windows Sandbox-isolated action executor");
  });
});

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "nexus-windows-sandbox-"));
  sandboxes.push(directory);
  return directory;
}

async function repositoryFixture() {
  const sandbox = await fixture();
  const root = join(sandbox, "repository");
  const data = join(sandbox, "cells");
  await mkdir(root);
  await git(root, ["init", "-b", "main"]);
  await git(root, ["config", "user.name", "Sandbox Test"]);
  await git(root, ["config", "user.email", "sandbox@example.invalid"]);
  await writeFile(join(root, "tracked.txt"), "base\n", "utf8");
  await git(root, ["add", "."]);
  await git(root, ["commit", "-m", "base"]);
  const base = await git(root, ["rev-parse", "HEAD"]);
  let clock = 0;
  const now = () => new Date(`2026-07-11T10:00:${String(clock++).padStart(2, "0")}.000Z`);
  const actionExecutor: WindowsSandboxActionExecutor = {
    isolation: "windows-sandbox",
    async authorize({ workingDirectory }) {
      expect(workingDirectory).toBe(join(data, "worktrees", "cell-1"));
    },
    async execute({ workingDirectory, contract: input }) {
      await writeFile(join(workingDirectory, "tracked.txt"), "sandboxed\n", "utf8");
      return actionReceiptSchema.parse({
        schemaVersion: 1,
        id: "receipt-1",
        contractId: input.id,
        cellId: input.cellId,
        status: "succeeded",
        startedAt: "2026-07-11T10:00:01.000Z",
        completedAt: "2026-07-11T10:00:02.000Z",
        policyVersion: "windows-policy-v1",
        contractDigest: `sha256:${"a".repeat(64)}`,
        leaseDigest: `sha256:${"b".repeat(64)}`,
        predictedEffectsDigest: `sha256:${"c".repeat(64)}`,
        observedEffects: [{ kind: "file.update", target: "tracked.txt", status: "changed", observedAt: "2026-07-11T10:00:02.000Z" }],
        variances: [],
        evidence: [{ kind: "policy", name: "Windows Sandbox policy", status: "passed", digest: `sha256:${"d".repeat(64)}` }]
      });
    }
  };
  const provider = () => new WindowsSandboxProvider({ workspaceRoot: root, dataRoot: data, actionExecutor, now, id: () => `windows-record-${clock++}` });
  const spec = () => cellSpecSchema.parse({
    schemaVersion: 1,
    id: "cell-1",
    objectiveId: "objective-1",
    provider: "windows-sandbox",
    baseRevision: base,
    workspaceRootDigest: portableWorkspaceDigest(root),
    capabilities: { read: ["tracked.txt"], write: ["tracked.txt"], delete: [], execute: [], network: [], secrets: [] },
    budget: { wallTimeMs: 60_000, cpuTimeMs: 30_000, memoryBytes: 512 * 1024 * 1024, diskBytes: 1024 * 1024 * 1024, processCount: 20, outputBytes: 1024 * 1024 },
    networkDefault: "deny",
    retention: { keepFailedMs: 60_000, keepCommittedMs: 0 },
    createdAt: "2026-07-11T10:00:00.000Z"
  });
  const capabilities = { read: ["tracked.txt"], write: ["tracked.txt"], delete: [], execute: [], network: [], secrets: [] };
  const contract = () => contractedActionSchema.parse({
    schemaVersion: 1,
    id: "action-1",
    objectiveId: "objective-1",
    cellId: "cell-1",
    leaseId: "lease-1",
    issuedAt: "2026-07-11T10:00:00.000Z",
    expiresAt: "2026-07-11T11:00:00.000Z",
    purpose: "Update one file inside Windows Sandbox.",
    action: { kind: "file.write", risk: "write", payloadDigest: `sha256:${"a".repeat(64)}` },
    capabilities,
    requires: [{ kind: "write", value: "tracked.txt" }],
    preconditions: [],
    expectedEffects: [{ kind: "file.update", target: "tracked.txt", description: "Update tracked file." }],
    forbiddenEffects: [],
    invariants: ["Primary workspace remains unchanged before promotion."],
    successEvidence: ["Sandbox policy passes."],
    rollback: { kind: "discard_cell", description: "Discard staged effects." }
  });
  const lease = () => capabilityLeaseSchema.parse({
    schemaVersion: 1,
    id: "lease-1",
    objectiveId: "objective-1",
    cellId: "cell-1",
    issuedAt: "2026-07-11T10:00:00.000Z",
    expiresAt: "2026-07-11T11:00:00.000Z",
    singleUse: true,
    status: "active",
    capabilities,
    policyVersion: "windows-policy-v1"
  });
  return { root, data, base, provider, spec, contract, lease };
}

function git(cwd: string, args: string[]) {
  return new Promise<string>((resolve, reject) => {
    const child = spawn("git", args, { cwd, windowsHide: true });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code) => code === 0 ? resolve(stdout.trim()) : reject(new Error(`git ${args[0]} failed: ${stderr || stdout}`)));
  });
}

function emptySessions(): WindowsSandboxSessionController {
  return { async list() { return new Set<number>(); }, async stop() {} };
}

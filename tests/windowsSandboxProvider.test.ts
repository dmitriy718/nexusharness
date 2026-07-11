import { afterEach, describe, expect, it } from "vitest";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  WINDOWS_SANDBOX_SESSION_QUERY,
  WindowsSandboxLauncher,
  createWindowsSandboxProfile,
  parseWindowsSandboxJson,
  parseWindowsSandboxSessionIds,
  type WindowsSandboxProcessRunner
} from "../server/execution/windowsSandboxProvider";

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
    const launcher = new WindowsSandboxLauncher({ executable, platform: "win32", runner, id: () => "profile-1" });
    expect(launcher.securityBoundary).toBe(false);
    await launcher.launch({ hostFolder: cell, configurationDirectory: configurations, bootstrapScript: "bootstrap.ps1", completionFile: "complete.json", timeoutMs: 20_000 });
    expect(captured).toContain(`<HostFolder>${cell}</HostFolder>`);
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
    const launcher = new WindowsSandboxLauncher({ executable, platform: "win32", runner: { async run() {} } });
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
    const launcher = new WindowsSandboxLauncher({ executable, platform: "win32", runner: { async run() {} } });
    await expect(launcher.launch({ hostFolder: cell, configurationDirectory: join(sandbox, "config"), bootstrapScript: "bootstrap.ps1", completionFile })).rejects.toThrow("completionFile");
  });
});

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "nexus-windows-sandbox-"));
  sandboxes.push(directory);
  return directory;
}

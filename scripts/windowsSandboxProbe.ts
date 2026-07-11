import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { WindowsSandboxLauncher, parseWindowsSandboxJson } from "../server/execution/windowsSandboxProvider.js";

if (process.platform !== "win32") throw new Error("The Windows Sandbox probe requires a Windows host.");

const root = await mkdtemp(join(tmpdir(), "nexus-windows-sandbox-probe-"));
const cell = join(root, "cell");
const configurations = join(root, "configurations");
const resultPath = join(cell, "result.json");
const execFileAsync = promisify(execFile);
const existingSessions = await windowsSandboxSessionIds();
await mkdir(cell);
await writeFile(join(cell, "seed.txt"), "nexus-sandbox-seed\n", "utf8");
await writeFile(join(cell, "bootstrap.ps1"), bootstrap(), "utf8");

try {
  const launcher = new WindowsSandboxLauncher();
  const probe = await launcher.probe();
  if (!probe.available) throw new Error(probe.reason);
  console.log("Launching the interactive Windows Sandbox isolation probe. The Sandbox window should close automatically.");
  await launcher.launch({
    hostFolder: cell,
    configurationDirectory: configurations,
    bootstrapScript: "bootstrap.ps1",
    completionFile: "result.json",
    memoryMb: 4096,
    timeoutMs: 5 * 60_000
  });
  const result = parseWindowsSandboxJson<{
    seedRead: boolean;
    mappedWrite: boolean;
    networkBlocked: boolean;
    sandboxIdentity: boolean;
    user: string;
    error?: string;
  }>(await readFile(resultPath, "utf8"));
  const hostWriteback = (await readFile(join(cell, "writeback.txt"), "utf8")).trim() === "sandbox-writeback";
  const passed = result.seedRead && result.mappedWrite && hostWriteback && result.networkBlocked && result.sandboxIdentity && !result.error;
  console.log(JSON.stringify({ ...result, hostWriteback, passed }, null, 2));
  if (!passed) throw new Error("Windows Sandbox isolation probe did not satisfy every boundary assertion.");
  console.log("Windows Sandbox isolation probe passed.");
} finally {
  await stopNewWindowsSandboxSessions(existingSessions);
  await removeProbeDirectory(root);
}

function bootstrap() {
  return String.raw`$ErrorActionPreference = 'Stop'
$result = [ordered]@{
  seedRead = $false
  mappedWrite = $false
  networkBlocked = $false
  sandboxIdentity = $false
  user = [Environment]::UserName
}
try {
  $result.seedRead = ((Get-Content -LiteralPath 'C:\NexusCell\seed.txt' -Raw).Trim() -eq 'nexus-sandbox-seed')
  Set-Content -LiteralPath 'C:\NexusCell\writeback.txt' -Value 'sandbox-writeback' -Encoding UTF8
  $result.mappedWrite = Test-Path -LiteralPath 'C:\NexusCell\writeback.txt'
  $result.sandboxIdentity = ([Environment]::UserName -eq 'WDAGUtilityAccount') -or (Test-Path -LiteralPath 'C:\Users\WDAGUtilityAccount')
  $connected = Test-NetConnection -ComputerName '1.1.1.1' -Port 443 -InformationLevel Quiet -WarningAction SilentlyContinue
  $result.networkBlocked = -not $connected
} catch {
  $result.error = $_.Exception.GetType().FullName
} finally {
  $json = $result | ConvertTo-Json -Compress
  [System.IO.File]::WriteAllText('C:\NexusCell\result.json', $json, [System.Text.UTF8Encoding]::new($false))
}
`;
}

async function windowsSandboxSessionIds() {
  const command = "Get-Process -Name WindowsSandboxRemoteSession -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Id";
  const { stdout } = await execFileAsync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", command], { windowsHide: true });
  return new Set(stdout.split(/\r?\n/).map((value) => Number(value.trim())).filter(Number.isSafeInteger));
}

async function stopNewWindowsSandboxSessions(existing: Set<number>) {
  const current = await windowsSandboxSessionIds().catch(() => new Set<number>());
  const created = [...current].filter((id) => !existing.has(id));
  if (!created.length) return;
  const command = `Stop-Process -Id ${created.join(",")} -Force -ErrorAction SilentlyContinue`;
  await execFileAsync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", command], { windowsHide: true }).catch(() => undefined);
}

async function removeProbeDirectory(directory: string) {
  const deadline = Date.now() + 15_000;
  while (true) {
    try {
      await rm(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (!code || !["EBUSY", "EPERM", "ENOTEMPTY"].includes(code) || Date.now() >= deadline) throw error;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
}

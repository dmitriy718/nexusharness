import { execFile } from "node:child_process";
import { homedir } from "node:os";
import { mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import path from "node:path";

const markerName = ".nexusharness-run.json";

function runId(taskId: string): string {
  const normalized = taskId.trim();
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(normalized)) throw new Error("Run export workspace requires a safe task identifier.");
  return normalized;
}

export function defaultRunExportBase(home = homedir(), environment: Record<string, string | undefined> = process.env): string {
  const override = environment.NEXUSHARNESS_RUN_EXPORT_DIR?.trim();
  if (override) return path.resolve(override);
  return path.join(path.resolve(home), ".nexusharness");
}

export function runExportPath(taskId: string, base = defaultRunExportBase()): string {
  return path.join(path.resolve(base), runId(taskId));
}

export async function prepareRunExportWorkspace(taskId: string, base = defaultRunExportBase()): Promise<string> {
  const id = runId(taskId);
  const exportBase = path.resolve(base);
  const workspaceRoot = runExportPath(id, exportBase);
  await mkdir(exportBase, { recursive: true });
  try {
    await mkdir(workspaceRoot);
  } catch (error: any) {
    if (error.code !== "EEXIST") throw error;
    await verifyMarker(workspaceRoot, id);
    return realpath(workspaceRoot);
  }

  const marker = { schemaVersion: 1, taskId: id, purpose: "NexusHarness isolated run export workspace" };
  try {
    await writeFile(path.join(workspaceRoot, markerName), `${JSON.stringify(marker, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
    await git(workspaceRoot, ["init", "--quiet"]);
    await git(workspaceRoot, ["add", "--", markerName]);
    await git(workspaceRoot, [
      "-c", "user.name=NexusHarness",
      "-c", "user.email=noreply@nexusharness.local",
      "-c", "commit.gpgSign=false",
      "commit", "--quiet", "-m", "Initialize isolated NexusHarness run workspace"
    ]);
    return realpath(workspaceRoot);
  } catch (error) {
    throw new Error(`Could not initialize isolated run export workspace ${workspaceRoot}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function verifyMarker(workspaceRoot: string, taskId: string): Promise<void> {
  let marker: { schemaVersion?: unknown; taskId?: unknown };
  try { marker = JSON.parse(await readFile(path.join(workspaceRoot, markerName), "utf8")); }
  catch { throw new Error(`Refusing existing unowned run export workspace: ${workspaceRoot}`); }
  if (marker.schemaVersion !== 1 || marker.taskId !== taskId) {
    throw new Error(`Run export workspace ownership does not match task ${taskId}: ${workspaceRoot}`);
  }
}

async function git(cwd: string, args: string[]): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    execFile("git", args, { cwd, windowsHide: true, maxBuffer: 1024 * 1024 }, (error, _stdout, stderr) => {
      if (error) reject(new Error(String(stderr || error.message).trim()));
      else resolve();
    });
  });
}

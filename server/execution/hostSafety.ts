import { realpath } from "node:fs/promises";
import path from "node:path";
import { installationPaths } from "../paths.js";

function normalized(candidate: string): string {
  const resolved = path.resolve(candidate);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function contains(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

export function pathsOverlap(left: string, right: string): boolean {
  const normalizedLeft = normalized(left);
  const normalizedRight = normalized(right);
  return contains(normalizedLeft, normalizedRight) || contains(normalizedRight, normalizedLeft);
}

export async function assertWorkspaceSeparatedFromInstallation(
  workspaceRoot: string,
  installRoot = installationPaths.installRoot
): Promise<void> {
  const [workspaceReal, installReal] = await Promise.all([
    realpath(path.resolve(workspaceRoot)),
    realpath(path.resolve(installRoot))
  ]);
  if (!pathsOverlap(workspaceReal, installReal)) return;
  throw new Error(
    `Refusing unsafe workspace ${workspaceReal}: a run workspace cannot be the NexusHarness installation, contain it, or be contained by it (${installReal}). Select a separate project directory.`
  );
}

export async function assertRunHostSafety(
  settings: { workspaceRoot: string; approvalMode: boolean },
  mode: "compatibility" | "transactional" | "windows-sandbox",
  installRoot = installationPaths.installRoot
): Promise<void> {
  await assertWorkspaceSeparatedFromInstallation(settings.workspaceRoot, installRoot);
  if (mode === "compatibility" && !settings.approvalMode) {
    throw new Error("Compatibility mode requires Approval mode. Unreviewed model-originated host writes and shell commands are prohibited.");
  }
}

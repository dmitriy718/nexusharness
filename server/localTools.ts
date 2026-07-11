import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, mkdir, open, readFile, readdir, realpath, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { nanoid } from "nanoid";
import { createTwoFilesPatch } from "diff";
import type { ApprovalContext, ApprovalRequest, Settings } from "./types.js";
import { audit, loadStore, saveStore } from "./store.js";

export function resolveInside(root: string, target: string): string {
  if (path.isAbsolute(target)) {
    throw new Error(`Path escapes workspace root: ${target}. Use a path relative to the configured workspace root (${path.resolve(root)}).`);
  }
  const resolvedRoot = path.resolve(root);
  const resolvedTarget = path.resolve(resolvedRoot, target);
  if (resolvedTarget !== resolvedRoot && !resolvedTarget.startsWith(`${resolvedRoot}${path.sep}`)) {
    throw new Error(`Path escapes workspace root: ${target}`);
  }
  return resolvedTarget;
}

function isInside(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

async function resolveInsideRealWorkspace(root: string, target: string): Promise<string> {
  const resolvedTarget = resolveInside(root, target);
  const resolvedRoot = path.resolve(root);
  const realRoot = await realpath(resolvedRoot);
  let existing = resolvedTarget;
  while (true) {
    try {
      await lstat(existing);
      break;
    } catch (error: any) {
      if (error.code !== "ENOENT") throw error;
      const parent = path.dirname(existing);
      if (parent === existing || !isInside(resolvedRoot, parent)) {
        throw new Error(`Cannot resolve workspace path safely: ${target}`);
      }
      existing = parent;
    }
  }
  const realExisting = await realpath(existing);
  if (!isInside(realRoot, realExisting)) {
    throw new Error(`Path escapes workspace root through a symbolic link: ${target}`);
  }
  return resolvedTarget;
}

export type LocalApprovalAuthorizer = (settings: Settings, action: string, risk: ApprovalRequest["risk"], payload: unknown, context?: ApprovalContext) => Promise<void>;
export type LocalAuditWriter = (event: Parameters<typeof audit>[0]) => Promise<unknown>;

export async function requireApproval(settings: Settings, action: string, risk: ApprovalRequest["risk"], payload: unknown, context: ApprovalContext = {}): Promise<void> {
  if (!settings.approvalMode || risk === "read") return;
  const store = await loadStore();
  const payloadJson = JSON.stringify(payload);
  const matches = store.approvals.filter((item) =>
    item.action === action &&
    item.risk === risk &&
    item.runId === context.runId &&
    JSON.stringify(item.payload) === payloadJson
  );
  const pending = matches.find((item) => item.decision === "pending");
  if (pending) throw new Error(`Approval required for ${action}. approvalId=${pending.id}`);
  const approved = matches.find((item) => item.decision === "approved" && !item.usedAt);
  if (approved) {
    approved.usedAt = new Date().toISOString();
    await saveStore(store);
    await audit({ actor: "system", action: "approval.consume", risk, status: "ok", message: action, details: { approvalId: approved.id, ...context } });
    return;
  }
  const latest = matches[0];
  if (latest?.decision === "rejected") throw new Error(`Approval rejected for ${action}. approvalId=${latest.id}`);
  const request: ApprovalRequest = {
    id: nanoid(),
    createdAt: new Date().toISOString(),
    actor: "executor",
    action,
    risk,
    payload,
    ...context,
    decision: "pending"
  };
  store.approvals.unshift(request);
  await saveStore(store);
  await audit({ actor: "executor", action, risk, status: "pending", message: "Approval required.", details: { approvalId: request.id, ...context } });
  throw new Error(`Approval required for ${action}. approvalId=${request.id}`);
}

export function contentSha256(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

export interface WorkspaceFileWritePlan {
  relativePath: string;
  content: string;
  previousSha256: string | null;
  nextSha256: string;
  previousBytes: number | null;
  nextBytes: number;
  diff: string | null;
}

export interface WorkspaceFileDeletePlan {
  relativePath: string;
  previousSha256: string;
  previousBytes: number;
}

export async function workspaceFileDigest(settings: Settings, relativePath: string) {
  const filePath = await resolveInsideRealWorkspace(settings.workspaceRoot, relativePath);
  try {
    const content = await readFile(filePath);
    return { sha256: createHash("sha256").update(content).digest("hex"), bytes: content.byteLength };
  } catch (error: any) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

export async function inspectWorkspaceFileDelete(settings: Settings, relativePath: string): Promise<WorkspaceFileDeletePlan> {
  const filePath = await resolveInsideRealWorkspace(settings.workspaceRoot, relativePath);
  if (filePath === path.resolve(settings.workspaceRoot)) throw new Error("Refusing to delete the configured workspace root.");
  const details = await lstat(filePath);
  if (!details.isFile()) throw new Error(`Transactional file deletion supports regular files only: ${relativePath}`);
  if (details.size > 20 * 1024 * 1024) throw new Error(`Transactional file deletion inspection exceeds the 20 MiB limit: ${relativePath}`);
  const content = await readFile(filePath);
  return { relativePath, previousSha256: createHash("sha256").update(content).digest("hex"), previousBytes: content.byteLength };
}

export async function authorizeWorkspaceFileDelete(
  settings: Settings,
  plan: WorkspaceFileDeletePlan,
  context: ApprovalContext = {},
  authorize: LocalApprovalAuthorizer = requireApproval
) {
  await authorize(settings, "file.delete", "write", {
    relativePath: plan.relativePath,
    targetType: "file",
    recursive: false,
    previousSha256: plan.previousSha256,
    previousBytes: plan.previousBytes
  }, context);
}

export async function executePreparedWorkspaceFileDelete(
  settings: Settings,
  plan: WorkspaceFileDeletePlan,
  recordAudit: LocalAuditWriter = audit
) {
  const current = await inspectWorkspaceFileDelete(settings, plan.relativePath);
  if (current.previousSha256 !== plan.previousSha256 || current.previousBytes !== plan.previousBytes) {
    throw new Error(`Workspace file changed after approval and before deletion: ${plan.relativePath}`);
  }
  const filePath = await resolveInsideRealWorkspace(settings.workspaceRoot, plan.relativePath);
  await rm(filePath, { recursive: false, force: false });
  await recordAudit({
    actor: "executor",
    action: "file.delete",
    risk: "write",
    status: "ok",
    message: plan.relativePath,
    details: { previousSha256: plan.previousSha256, previousBytes: plan.previousBytes, recursive: false }
  });
  return { path: plan.relativePath, previousSha256: plan.previousSha256, previousBytes: plan.previousBytes, recursive: false };
}

function safePatch(relativePath: string, before: string | null, after: string): string | null {
  const beforeText = before ?? "";
  if (Buffer.byteLength(beforeText) + Buffer.byteLength(after) > 250_000) return null;
  return createTwoFilesPatch(`${relativePath}:before`, `${relativePath}:after`, beforeText, after, "", "", { context: 3 });
}

export async function listFiles(settings: Settings, relativePath = ".") {
  const root = await resolveInsideRealWorkspace(settings.workspaceRoot, relativePath);
  const entries = (await readdir(root, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name)).slice(0, 2000);
  await audit({ actor: "executor", action: "file.list", risk: "read", status: "ok", message: relativePath });
  return entries.map((entry) => ({ name: entry.name, type: entry.isDirectory() ? "directory" : "file" }));
}

export async function readWorkspaceFile(settings: Settings, relativePath: string, options: { offset?: number; limit?: number } = {}) {
  const filePath = await resolveInsideRealWorkspace(settings.workspaceRoot, relativePath);
  const fileStat = await stat(filePath);
  if (!fileStat.isFile()) throw new Error(`Path is not a regular file: ${relativePath}`);
  if (fileStat.size > 2 * 1024 * 1024) {
    throw new Error(`File is too large for model context (${fileStat.size} bytes; limit is 2097152): ${relativePath}`);
  }
  const content = await readFile(filePath, "utf8");
  const requestedOffset = Number(options.offset ?? 0);
  const requestedLimit = Number(options.limit ?? 40_000);
  const offset = Number.isFinite(requestedOffset) ? Math.max(0, Math.trunc(requestedOffset)) : 0;
  const limit = Number.isFinite(requestedLimit) ? Math.min(100_000, Math.max(1, Math.trunc(requestedLimit))) : 40_000;
  const selected = content.slice(offset, offset + limit);
  await audit({ actor: "executor", action: "file.read", risk: "read", status: "ok", message: relativePath, details: { offset, returnedCharacters: selected.length, totalCharacters: content.length, truncated: offset + selected.length < content.length } });
  return selected;
}

export async function prepareWorkspaceFileWrite(
  settings: Settings,
  relativePath: string,
  content: string,
  context: ApprovalContext = {},
  authorize: LocalApprovalAuthorizer = requireApproval
): Promise<WorkspaceFileWritePlan> {
  if (Buffer.byteLength(content) > 5 * 1024 * 1024) throw new Error("File write exceeds the 5 MiB safety limit.");
  const filePath = await resolveInsideRealWorkspace(settings.workspaceRoot, relativePath);
  let previousContent: string | null = null;
  try {
    previousContent = await readFile(filePath, "utf8");
  } catch (error: any) {
    if (error.code !== "ENOENT") throw error;
  }
  const plan: WorkspaceFileWritePlan = {
    relativePath,
    previousSha256: previousContent === null ? null : contentSha256(previousContent),
    nextSha256: contentSha256(content),
    previousBytes: previousContent === null ? null : Buffer.byteLength(previousContent),
    nextBytes: Buffer.byteLength(content),
    content,
    diff: safePatch(relativePath, previousContent, content)
  };
  await authorize(settings, "file.write", "write", {
    relativePath: plan.relativePath,
    bytes: plan.nextBytes,
    previousBytes: plan.previousBytes,
    previousSha256: plan.previousSha256,
    nextSha256: plan.nextSha256,
    diff: plan.diff
  }, context);
  return plan;
}

export async function executePreparedWorkspaceFileWrite(
  settings: Settings,
  plan: WorkspaceFileWritePlan,
  recordAudit: LocalAuditWriter = audit
) {
  if (contentSha256(plan.content) !== plan.nextSha256 || Buffer.byteLength(plan.content) !== plan.nextBytes) {
    throw new Error(`Approved file-write content changed before execution: ${plan.relativePath}`);
  }
  const filePath = await resolveInsideRealWorkspace(settings.workspaceRoot, plan.relativePath);
  let currentContent: string | null = null;
  try {
    currentContent = await readFile(filePath, "utf8");
  } catch (error: any) {
    if (error.code !== "ENOENT") throw error;
  }
  const currentSha256 = currentContent === null ? null : contentSha256(currentContent);
  const currentBytes = currentContent === null ? null : Buffer.byteLength(currentContent);
  if (currentSha256 !== plan.previousSha256 || currentBytes !== plan.previousBytes) {
    throw new Error(`Workspace file changed after approval and before execution: ${plan.relativePath}`);
  }
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, plan.content, "utf8");
  const details = {
    previousSha256: plan.previousSha256,
    nextSha256: plan.nextSha256,
    previousBytes: plan.previousBytes,
    nextBytes: plan.nextBytes,
    diff: plan.diff
  };
  await recordAudit({ actor: "executor", action: "file.write", risk: "write", status: "ok", message: plan.relativePath, details });
  return { path: plan.relativePath, ...details };
}

export async function writeWorkspaceFile(settings: Settings, relativePath: string, content: string, context: ApprovalContext = {}) {
  const plan = await prepareWorkspaceFileWrite(settings, relativePath, content, context);
  return executePreparedWorkspaceFileWrite(settings, plan);
}

export async function deleteWorkspacePath(settings: Settings, relativePath: string, context: ApprovalContext = {}) {
  const filePath = await resolveInsideRealWorkspace(settings.workspaceRoot, relativePath);
  if (filePath === path.resolve(settings.workspaceRoot)) {
    throw new Error("Refusing to delete the configured workspace root.");
  }
  const targetStat = await lstat(filePath);
  await requireApproval(settings, "file.delete", "write", { relativePath, targetType: targetStat.isDirectory() ? "directory" : "file", recursive: targetStat.isDirectory() }, context);
  await rm(filePath, { recursive: true, force: false });
  await audit({ actor: "executor", action: "file.delete", risk: "write", status: "ok", message: relativePath });
  return { path: relativePath };
}

export async function runShell(settings: Settings, command: string, signal?: AbortSignal, context: ApprovalContext = {}) {
  if (!command.trim()) throw new Error("Shell command cannot be empty.");
  if (command.length > 100_000) throw new Error("Shell command exceeds the 100,000 character safety limit.");
  const cwd = await realpath(path.resolve(settings.workspaceRoot));
  const shell = settings.shellPath;
  await requireApproval(settings, "shell.exec", "execute", { command, cwd, shell }, context);
  const shellName = path.basename(shell).toLowerCase();
  const args = shellName.includes("powershell") || shellName.includes("pwsh")
    ? ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", command]
    : shellName === "cmd.exe" || shellName === "cmd"
      ? ["/d", "/s", "/c", command]
      : shellName.includes("bash") || shellName.includes("zsh")
        ? ["-lc", command]
        : ["-c", command];
  const result = await new Promise<{ stdout: string; stderr: string; code: number | null }>((resolve) => {
    const child = execFile(shell, args, { cwd, timeout: 120000, maxBuffer: 1024 * 1024 * 10, signal }, (error, stdout, stderr) => {
      const code = error
        ? (typeof (error as any).code === "number" ? (error as any).code : 1)
        : 0;
      resolve({ stdout, stderr, code });
    });
    child.on("error", (error) => resolve({ stdout: "", stderr: error.message, code: 1 }));
  });
  await audit({
    actor: "executor",
    action: "shell.exec",
    risk: "execute",
    status: result.code === 0 ? "ok" : "error",
    message: command,
    details: result
  });
  if (result.code !== 0) {
    throw new Error(`Command failed with exit code ${result.code}: ${command}\n${result.stderr || result.stdout}`);
  }
  return result;
}

export async function workspaceTree(settings: Settings, relativePath = ".", depth = 2, budget = { remaining: 1000 }): Promise<any[]> {
  if (budget.remaining <= 0) return [];
  const current = resolveInside(settings.workspaceRoot, relativePath);
  const s = await stat(current);
  if (!s.isDirectory()) return [];
  const entries = (await readdir(current, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name)).slice(0, Math.min(200, budget.remaining));
  budget.remaining -= entries.length;
  return Promise.all(entries.map(async (entry) => {
    const childRel = path.join(relativePath, entry.name);
    return {
      name: entry.name,
      path: childRel,
      type: entry.isDirectory() ? "directory" : "file",
      children: entry.isDirectory() && depth > 0 ? await workspaceTree(settings, childRel, depth - 1, budget) : []
    };
  }));
}

function workspaceRelative(value: string): string {
  return value.replaceAll("\\", "/").replace(/^\.\//, "");
}

export async function workspaceEntries(settings: Settings, relativePath = ".") {
  const directory = await resolveInsideRealWorkspace(settings.workspaceRoot, relativePath);
  const directoryStat = await stat(directory);
  if (!directoryStat.isDirectory()) throw new Error(`Path is not a directory: ${relativePath}`);
  const entries = (await readdir(directory, { withFileTypes: true })).sort((left, right) => {
    if (left.isDirectory() !== right.isDirectory()) return left.isDirectory() ? -1 : 1;
    return left.name.localeCompare(right.name);
  }).slice(0, 2000);
  return Promise.all(entries.map(async (entry) => {
    const childPath = workspaceRelative(path.join(relativePath, entry.name));
    const childStat = await lstat(path.join(directory, entry.name));
    return {
      name: entry.name,
      path: childPath,
      type: entry.isSymbolicLink() ? "symlink" : entry.isDirectory() ? "directory" : "file",
      size: childStat.size,
      modifiedAt: childStat.mtime.toISOString(),
      blocked: entry.isSymbolicLink()
    };
  }));
}

export async function searchWorkspace(settings: Settings, query: string, limit = 100) {
  const normalized = query.trim().toLowerCase();
  if (!normalized) return [];
  const root = await realpath(path.resolve(settings.workspaceRoot));
  const pending = ["."];
  const results: Awaited<ReturnType<typeof workspaceEntries>> = [];
  let visited = 0;
  while (pending.length && results.length < limit && visited < 5000) {
    const relativePath = pending.shift()!;
    const directory = resolveInside(root, relativePath);
    const entries = await readdir(directory, { withFileTypes: true }).catch(() => []);
    visited += entries.length;
    for (const entry of entries) {
      if (results.length >= limit) break;
      const childPath = workspaceRelative(path.join(relativePath, entry.name));
      if (entry.isDirectory() && !entry.isSymbolicLink()) pending.push(childPath);
      if (!entry.name.toLowerCase().includes(normalized) && !childPath.toLowerCase().includes(normalized)) continue;
      const childStat = await lstat(path.join(directory, entry.name));
      results.push({ name: entry.name, path: childPath, type: entry.isSymbolicLink() ? "symlink" : entry.isDirectory() ? "directory" : "file", size: childStat.size, modifiedAt: childStat.mtime.toISOString(), blocked: entry.isSymbolicLink() });
    }
  }
  return results;
}

export async function previewWorkspaceFile(settings: Settings, relativePath: string) {
  const lexicalPath = resolveInside(settings.workspaceRoot, relativePath);
  const lexicalStat = await lstat(lexicalPath);
  if (lexicalStat.isSymbolicLink()) throw new Error("Symbolic links are not previewed because their target can change outside the visible tree.");
  const filePath = await resolveInsideRealWorkspace(settings.workspaceRoot, relativePath);
  const fileStat = await stat(filePath);
  if (!fileStat.isFile()) throw new Error(`Path is not a regular file: ${relativePath}`);
  const limit = 200_000;
  const length = Math.min(fileStat.size, limit);
  const buffer = Buffer.alloc(length);
  const handle = await open(filePath, "r");
  try {
    await handle.read(buffer, 0, length, 0);
  } finally {
    await handle.close();
  }
  const binary = buffer.includes(0);
  const extension = path.extname(relativePath).slice(1).toLowerCase();
  return {
    name: path.basename(relativePath),
    path: workspaceRelative(relativePath),
    size: fileStat.size,
    modifiedAt: fileStat.mtime.toISOString(),
    binary,
    truncated: fileStat.size > limit,
    content: binary ? "" : buffer.toString("utf8"),
    language: extension || "text"
  };
}

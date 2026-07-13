import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { nanoid } from "nanoid";
import type { AuditEvent, RunExecutionSummary, StoreShape, TaskRun } from "./types.js";
import { defaultMemoryEmbeddingSettings, defaultMemoryRetrievalSettings, resolveMemoryConfiguration } from "./memory/config.js";
import { countPromptTokens, memoryContentHash, workspaceNamespace } from "./memory/preprocessing.js";
import { userPaths } from "./paths.js";

export const dataDir = userPaths.dataRoot;
export const storePath = path.join(dataDir, "store.json");
const defaultWorkspaceRoot = process.env.NEXUSHARNESS_WORKSPACE_ROOT
  ? path.resolve(process.env.NEXUSHARNESS_WORKSPACE_ROOT)
  : path.join(dataDir, "workspace");

const defaultStore: StoreShape = {
  settings: {
    workspaceRoot: defaultWorkspaceRoot,
    layout: null,
    maxIterations: 5,
    maxParallelExecutors: 3,
    criticThreshold: 7,
    approvalMode: true,
    shellPath: process.platform === "win32" ? "powershell.exe" : "/bin/sh",
    testCommand: "",
    lintCommand: "",
    mcpAutoDiscovery: true,
    mcpPortStart: 3000,
    mcpPortEnd: 9999,
    memoryTokenBudget: 2000,
    memoryRetrieval: defaultMemoryRetrievalSettings,
    memoryEmbeddings: defaultMemoryEmbeddingSettings,
    agentModels: {}
  },
  runtimes: [],
  mcpServers: [],
  memory: [],
  audit: [],
  approvals: [],
  runs: []
};

let cache: StoreShape | null = null;
let writeQueue = Promise.resolve();

export function mergeStore(raw: Partial<StoreShape>): StoreShape {
  const rawSettings = { ...defaultStore.settings, ...(raw.settings ?? {}) };
  const memoryConfiguration = resolveMemoryConfiguration(rawSettings);
  const merged: StoreShape = {
    ...defaultStore,
    ...raw,
    settings: {
      ...defaultStore.settings,
      ...(raw.settings ?? {}),
      memoryRetrieval: memoryConfiguration.retrieval,
      memoryEmbeddings: memoryConfiguration.embeddings,
      agentModels: {
        ...defaultStore.settings.agentModels,
        ...(raw.settings?.agentModels ?? {})
      }
    },
    runtimes: raw.runtimes ?? defaultStore.runtimes,
    mcpServers: raw.mcpServers ?? defaultStore.mcpServers,
    memory: raw.memory ?? defaultStore.memory,
    audit: raw.audit ?? defaultStore.audit,
    approvals: raw.approvals ?? defaultStore.approvals,
    runs: raw.runs ?? defaultStore.runs
  };
  const namespace = workspaceNamespace(merged.settings.workspaceRoot);
  for (const entry of merged.memory) {
    entry.namespace ??= namespace;
    entry.importance = Number.isFinite(entry.importance) ? Math.min(1, Math.max(0, entry.importance!)) : 0.5;
    entry.contentHash = memoryContentHash(entry, memoryConfiguration.embeddings.preprocessingVersion);
    entry.tokenCount = countPromptTokens(entry.content);
    entry.indexing ??= { status: "pending", updatedAt: entry.updatedAt ?? entry.createdAt ?? new Date().toISOString() };
  }
  // A process cannot still own a run loaded from disk. Mark stale work
  // explicitly so operators can resume it instead of seeing "running" forever.
  for (const run of merged.runs) {
    run.log ??= [];
    if (run.status === "running") {
      run.status = "failed";
      run.error = "Run was interrupted by a previous NexusHarness shutdown. Resume it to continue from its saved checkpoint.";
      run.updatedAt = new Date().toISOString();
    }
  }
  return merged;
}

export async function loadStore(): Promise<StoreShape> {
  if (cache) return cache;
  await Promise.all([mkdir(dataDir, { recursive: true }), mkdir(defaultWorkspaceRoot, { recursive: true })]);
  try {
    const raw = await readFile(storePath, "utf8");
    cache = mergeStore(JSON.parse(raw) as Partial<StoreShape>);
  } catch (error: any) {
    if (error.code !== "ENOENT") throw error;
    cache = structuredClone(defaultStore);
    await saveStore(cache);
  }
  return cache;
}

export async function saveStore(store = cache): Promise<void> {
  if (!store) return;
  const payload = `${JSON.stringify(store, null, 2)}\n`;
  cache = store;
  const operation = writeQueue.catch(() => undefined).then(async () => {
    await mkdir(dataDir, { recursive: true });
    const tempPath = `${storePath}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(tempPath, payload, "utf8");
    await rename(tempPath, storePath);
  });
  writeQueue = operation;
  await operation;
}

export function attachRunExecutionSummary(store: StoreShape, runId: string, summary: RunExecutionSummary, now = new Date()): TaskRun {
  const run = store.runs.find((item) => item.id === runId);
  if (!run) throw new Error(`Cannot attach execution summary to unknown run: ${runId}.`);
  if (summary.schemaVersion !== 1 || !summary.cellId.trim() || !Number.isFinite(Date.parse(summary.updatedAt))) {
    throw new Error("Execution summary identity or timestamp is invalid.");
  }
  if (run.execution && run.execution.cellId !== summary.cellId && run.execution.state !== "destroyed") {
    throw new Error(`Run ${runId} is already bound to execution cell ${run.execution.cellId}.`);
  }
  if (run.execution && Date.parse(summary.updatedAt) < Date.parse(run.execution.updatedAt)) {
    throw new Error(`Execution summary for run ${runId} is older than the persisted cell state.`);
  }
  run.execution = structuredClone(summary);
  const updatedAt = now.toISOString();
  if (Date.parse(updatedAt) > Date.parse(run.updatedAt)) run.updatedAt = updatedAt;
  return run;
}

export async function persistRunExecutionSummary(runId: string, summary: RunExecutionSummary): Promise<TaskRun> {
  const store = await loadStore();
  const run = attachRunExecutionSummary(store, runId, summary);
  await saveStore(store);
  return structuredClone(run);
}

export async function audit(event: Omit<AuditEvent, "id" | "at">): Promise<AuditEvent> {
  const store = await loadStore();
  const full: AuditEvent = { id: nanoid(), at: new Date().toISOString(), ...event };
  store.audit.unshift(full);
  store.audit = store.audit.slice(0, 5000);
  await saveStore(store);
  return full;
}

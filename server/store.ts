import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { nanoid } from "nanoid";
import type { AuditEvent, StoreShape } from "./types.js";

const dataDir = process.env.NEXUSHARNESS_DATA_DIR
  ? path.resolve(process.env.NEXUSHARNESS_DATA_DIR)
  : path.join(process.cwd(), ".nexusharness");
const storePath = path.join(dataDir, "store.json");

const defaultStore: StoreShape = {
  settings: {
    workspaceRoot: process.cwd(),
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

function mergeStore(raw: Partial<StoreShape>): StoreShape {
  const merged: StoreShape = {
    ...defaultStore,
    ...raw,
    settings: {
      ...defaultStore.settings,
      ...(raw.settings ?? {}),
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
  // A process cannot still own a run loaded from disk. Mark stale work
  // explicitly so operators can resume it instead of seeing "running" forever.
  for (const run of merged.runs) {
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
  await mkdir(dataDir, { recursive: true });
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

export async function audit(event: Omit<AuditEvent, "id" | "at">): Promise<AuditEvent> {
  const store = await loadStore();
  const full: AuditEvent = { id: nanoid(), at: new Date().toISOString(), ...event };
  store.audit.unshift(full);
  store.audit = store.audit.slice(0, 5000);
  await saveStore(store);
  return full;
}

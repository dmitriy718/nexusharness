import { readFile, rm, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { defaultMemoryEmbeddingSettings, defaultMemoryRetrievalSettings } from "../server/memory/config.js";
import { MemoryIndexer } from "../server/memory/indexer.js";
import { memoryContentHash, normalizeMemoryContent, workspaceNamespace } from "../server/memory/preprocessing.js";
import { MemoryRetriever } from "../server/memory/retriever.js";
import { SqliteVectorStore } from "../server/memory/vectorStore.js";
import type { MemoryEntry, Settings } from "../server/types.js";

interface Dataset {
  schemaVersion: number;
  memories: Array<{ id: string; namespace: string; kind: MemoryEntry["kind"]; taskType: string; title: string; content: string; pinned?: boolean }>;
  queries: Array<{ id: string; namespace: string; query: string; relevant: string[]; hardNegatives: string[] }>;
}

const root = process.cwd();
const dataset = JSON.parse(await readFile(path.join(root, "evaluation", "memory-retrieval.json"), "utf8")) as Dataset;
if (dataset.schemaVersion !== 1) throw new Error("Unsupported memory evaluation dataset schema.");
const temporary = await mkdtemp(path.join(tmpdir(), "nexus-memory-eval-"));
const vectorStore = new SqliteVectorStore(path.join(temporary, "vectors.sqlite"));
await vectorStore.initialize();
try {
  const workspaceByNamespace = new Map([...new Set(dataset.memories.map((memory) => memory.namespace))].map((namespace) => [namespace, path.join(temporary, "workspaces", namespace)]));
  const entries = dataset.memories.map((item) => {
    const workspace = workspaceByNamespace.get(item.namespace)!;
    const now = "2026-07-11T00:00:00.000Z";
    const entry: MemoryEntry = { ...item, namespace: workspaceNamespace(workspace), pinned: item.pinned ?? false, source: "evaluation", importance: 0.5, createdAt: now, updatedAt: now };
    entry.contentHash = memoryContentHash(entry);
    return entry;
  });
  const options = { modelCacheDirectory: path.resolve(root, ".nexusharness", "embedding-models") };
  const indexer = new MemoryIndexer(vectorStore, options);
  const retriever = new MemoryRetriever(vectorStore, options);
  const settingsByNamespace = new Map<string, Settings>();
  const backfillStarted = performance.now();
  for (const [name, workspace] of workspaceByNamespace) {
    const settings = settingsFixture(workspace, "hybrid");
    settingsByNamespace.set(name, settings);
    const report = await indexer.backfill(entries, settings, { rateLimitPerSecond: 100 });
    if (report.failed) throw new Error(`Evaluation backfill failed for ${name}: ${JSON.stringify(report.failures)}`);
  }
  const backfillMs = performance.now() - backfillStarted;
  const lexical = await evaluate("lexical_only", dataset, entries, settingsByNamespace, retriever);
  const hybrid = await evaluate("hybrid", dataset, entries, settingsByNamespace, retriever);
  console.log(JSON.stringify({
    dataset: { memories: dataset.memories.length, queries: dataset.queries.length },
    model: defaultMemoryEmbeddingSettings.model,
    dimension: vectorStore.listGenerations()[0]?.dimension,
    backfillMs: round(backfillMs),
    lexical,
    hybrid
  }, null, 2));
} finally {
  vectorStore.close();
  await rm(temporary, { recursive: true, force: true, maxRetries: 5, retryDelay: 30 });
}

async function evaluate(mode: "lexical_only" | "hybrid", data: Dataset, entries: MemoryEntry[], settingsByNamespace: Map<string, Settings>, retriever: MemoryRetriever) {
  const k = 5;
  let recall = 0;
  let precision = 0;
  let reciprocalRank = 0;
  let ndcg = 0;
  let utilization = 0;
  let duplicates = 0;
  let returned = 0;
  let unauthorized = 0;
  const latencies: number[] = [];
  for (const query of data.queries) {
    const base = settingsByNamespace.get(query.namespace)!;
    const settings = { ...base, memoryRetrieval: { ...base.memoryRetrieval!, mode } };
    const started = performance.now();
    const result = await retriever.retrieve(query.query, entries, settings);
    latencies.push(performance.now() - started);
    const ids = result.memories.slice(0, k).map((memory) => memory.id);
    const relevant = new Set(query.relevant);
    const hits = ids.filter((id) => relevant.has(id));
    recall += hits.length / relevant.size;
    precision += hits.length / k;
    const first = ids.findIndex((id) => relevant.has(id));
    reciprocalRank += first >= 0 ? 1 / (first + 1) : 0;
    ndcg += normalizedDiscountedGain(ids, relevant, k);
    utilization += result.diagnostics.selectedTokenCount / settings.memoryTokenBudget;
    returned += ids.length;
    const bodies = ids.map((id) => normalizeMemoryContent(entries.find((entry) => entry.id === id)!.content));
    duplicates += bodies.length - new Set(bodies).size;
    const allowedNamespace = workspaceNamespace(settings.workspaceRoot);
    unauthorized += ids.filter((id) => entries.find((entry) => entry.id === id)!.namespace !== allowedNamespace).length;
  }
  const count = data.queries.length;
  return {
    recallAt5: round(recall / count),
    precisionAt5: round(precision / count),
    meanReciprocalRank: round(reciprocalRank / count),
    nDCGAt5: round(ndcg / count),
    averageTokenBudgetUtilization: round(utilization / count),
    duplicateResultRate: returned ? round(duplicates / returned) : 0,
    unauthorizedRetrievalCount: unauthorized,
    p50LatencyMs: round(percentile(latencies, 0.5)),
    p95LatencyMs: round(percentile(latencies, 0.95))
  };
}

function settingsFixture(workspaceRoot: string, mode: "lexical_only" | "hybrid"): Settings {
  return {
    workspaceRoot, layout: "chat", maxIterations: 1, maxParallelExecutors: 1, criticThreshold: 7, approvalMode: false,
    shellPath: "shell", testCommand: "", lintCommand: "", mcpAutoDiscovery: false, mcpPortStart: 3000, mcpPortEnd: 3001,
    memoryTokenBudget: 500, memoryRetrieval: { ...defaultMemoryRetrievalSettings, mode, minimumSemanticScore: 0.12 },
    memoryEmbeddings: { ...defaultMemoryEmbeddingSettings, allowModelDownload: true, timeoutMs: 120000 }, agentModels: {}
  };
}

function normalizedDiscountedGain(ids: string[], relevant: Set<string>, k: number): number {
  const dcg = ids.slice(0, k).reduce((sum, id, index) => sum + (relevant.has(id) ? 1 / Math.log2(index + 2) : 0), 0);
  const ideal = Array.from({ length: Math.min(k, relevant.size) }, (_, index) => 1 / Math.log2(index + 2)).reduce((sum, value) => sum + value, 0);
  return ideal ? dcg / ideal : 0;
}

function percentile(values: number[], quantile: number): number {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * quantile))] ?? 0;
}

function round(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}

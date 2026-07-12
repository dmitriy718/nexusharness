import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { defaultMemoryEmbeddingSettings, defaultMemoryRetrievalSettings } from "../server/memory/config.js";
import { EmbeddingService } from "../server/memory/embeddingService.js";
import { MemoryIndexer } from "../server/memory/indexer.js";
import { memoryContentHash, workspaceNamespace } from "../server/memory/preprocessing.js";
import { createEmbeddingProvider } from "../server/memory/providers.js";
import { MemoryRetriever } from "../server/memory/retriever.js";
import { SqliteVectorStore } from "../server/memory/vectorStore.js";
import type { MemoryEntry, Settings } from "../server/types.js";

const topics = ["database", "keyboard accessibility", "sandbox verification", "rate limit recovery", "vector model migration", "credential isolation"];
const root = process.cwd();
const temporary = await mkdtemp(path.join(tmpdir(), "nexus-memory-benchmark-"));
const vectorStore = new SqliteVectorStore(path.join(temporary, "vectors.sqlite"));
await vectorStore.initialize();
try {
  const settings = settingsFixture(path.join(temporary, "workspace"));
  const providerOptions = { modelCacheDirectory: path.resolve(root, ".nexusharness", "embedding-models") };
  const provider = createEmbeddingProvider(settings.memoryEmbeddings!, providerOptions);
  await provider.embed("benchmark warmup");
  const throughputTexts = Array.from({ length: 32 }, (_, index) => `Benchmark document ${index}: ${topics[index % topics.length]} with unique sample ${index}.`);
  const singleStarted = performance.now();
  for (const text of throughputTexts) await provider.embed(text);
  const singleMs = performance.now() - singleStarted;
  const batchStarted = performance.now();
  await provider.embedBatch(throughputTexts);
  const batchMs = performance.now() - batchStarted;

  const namespace = workspaceNamespace(settings.workspaceRoot);
  const memories = Array.from({ length: 120 }, (_, index) => memory(index, namespace));
  const indexer = new MemoryIndexer(vectorStore, providerOptions);
  const backfillStarted = performance.now();
  const backfill = await indexer.backfill(memories, settings, { batchSize: 32, rateLimitPerSecond: 1000 });
  const backfillMs = performance.now() - backfillStarted;
  if (backfill.failed || !backfill.activated) throw new Error(`Benchmark backfill failed: ${JSON.stringify(backfill)}`);

  const retriever = new MemoryRetriever(vectorStore, providerOptions);
  const retrievalLatencies: number[] = [];
  const vectorLatencies: number[] = [];
  for (let index = 0; index < 40; index += 1) {
    const started = performance.now();
    const result = await retriever.retrieve(`Find guidance about ${topics[index % topics.length]} without using the exact stored wording.`, memories, settings);
    retrievalLatencies.push(performance.now() - started);
    vectorLatencies.push(result.diagnostics.vectorQueryDurationMs);
  }

  const active = vectorStore.getActiveGeneration(namespace)!;
  const queryVector = await provider.embed("database restore and recovery");
  const filteredStarted = performance.now();
  const filtered = vectorStore.search(active.id, namespace, queryVector.vectors[0], 20, { kind: "context", taskType: "database" });
  const filteredVectorMs = performance.now() - filteredStarted;

  const cacheProvider = createEmbeddingProvider(settings.memoryEmbeddings!, providerOptions);
  const cacheService = new EmbeddingService(cacheProvider, vectorStore, settings.memoryEmbeddings!);
  const cacheTexts = Array.from({ length: 8 }, (_, index) => `Cache effectiveness probe ${index}`);
  await cacheService.embedBatch(cacheTexts);
  const beforeSecond = { ...cacheService.metrics };
  await cacheService.embedBatch(cacheTexts);
  const secondPassHits = cacheService.metrics.cacheHits - beforeSecond.cacheHits;

  const diagnostics = vectorStore.diagnostics(namespace);
  console.log(JSON.stringify({
    fixture: { memories: memories.length, queries: retrievalLatencies.length, namespaces: 1, metadataFilter: { kind: "context", taskType: "database", matches: filtered.length } },
    model: { provider: provider.descriptor.provider, model: provider.descriptor.model, dimension: provider.descriptor.dimension },
    embedding: {
      singleItemsPerSecond: round(throughputTexts.length / (singleMs / 1000)),
      batchItemsPerSecond: round(throughputTexts.length / (batchMs / 1000)),
      singleDurationMs: round(singleMs), batchDurationMs: round(batchMs)
    },
    retrieval: {
      p50Ms: round(percentile(retrievalLatencies, 0.5)), p95Ms: round(percentile(retrievalLatencies, 0.95)),
      vectorP50Ms: round(percentile(vectorLatencies, 0.5)), vectorP95Ms: round(percentile(vectorLatencies, 0.95)),
      filteredVectorMs: round(filteredVectorMs)
    },
    backfill: { durationMs: round(backfillMs), memoriesPerSecond: round(memories.length / (backfillMs / 1000)), succeeded: backfill.succeeded },
    storage: { databaseBytes: diagnostics.databaseBytes, indexedMemories: diagnostics.indexedMemories },
    cache: { secondPassHits, secondPassRequests: cacheTexts.length, hitRate: round(secondPassHits / cacheTexts.length) }
  }, null, 2));
} finally {
  vectorStore.close();
  await rm(temporary, { recursive: true, force: true, maxRetries: 5, retryDelay: 30 });
}

function memory(index: number, namespace: string): MemoryEntry {
  const topic = topics[index % topics.length];
  const taskType = topic === "database" ? "database" : topic.includes("keyboard") ? "frontend" : topic.includes("credential") || topic.includes("sandbox") ? "security" : "infrastructure";
  const now = new Date(Date.UTC(2026, 0, 1 + index % 180)).toISOString();
  const entry: MemoryEntry = {
    id: `benchmark-${String(index).padStart(3, "0")}`, namespace, kind: "context", taskType, title: `Operational lesson ${index}`,
    content: `This record explains ${topic} using bounded production procedure number ${index}, verification evidence, rollback conditions, and an independently checked outcome.`,
    pinned: index === 0, source: "benchmark", importance: (index % 10) / 10, createdAt: now, updatedAt: now
  };
  entry.contentHash = memoryContentHash(entry);
  return entry;
}

function settingsFixture(workspaceRoot: string): Settings {
  return {
    workspaceRoot, layout: "chat", maxIterations: 1, maxParallelExecutors: 1, criticThreshold: 7, approvalMode: false,
    shellPath: "shell", testCommand: "", lintCommand: "", mcpAutoDiscovery: false, mcpPortStart: 3000, mcpPortEnd: 3001,
    memoryTokenBudget: 800, memoryRetrieval: { ...defaultMemoryRetrievalSettings, mode: "hybrid", minimumSemanticScore: 0.1 },
    memoryEmbeddings: { ...defaultMemoryEmbeddingSettings, allowModelDownload: true, timeoutMs: 120000 }, agentModels: {}
  };
}

function percentile(values: number[], quantile: number): number {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * quantile))] ?? 0;
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

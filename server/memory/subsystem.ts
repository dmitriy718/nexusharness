import path from "node:path";
import type { MemoryEntry, Settings, StoreShape } from "../types.js";
import { audit, dataDir, loadStore, saveStore } from "../store.js";
import { resolveMemoryConfiguration } from "./config.js";
import { MemoryIndexer, ReembeddingService, type BackfillOptions, type BackfillReport } from "./indexer.js";
import { memoryContentHash, workspaceNamespace } from "./preprocessing.js";
import { MemoryRetriever } from "./retriever.js";
import type { MemoryRetrievalResult } from "./types.js";
import { SqliteVectorStore } from "./vectorStore.js";

export interface MemorySubsystemDiagnostics {
  retrievalMode: string;
  provider: string;
  model: string;
  sendsContentOffDevice: boolean;
  activeGeneration: string | null;
  vectorStore: ReturnType<SqliteVectorStore["health"]>;
  totalMemories: number;
  indexedMemories: number;
  staleOrUnindexedMemories: number;
  failedMemories: number;
  cachedEmbeddings: number;
  databaseBytes: number;
  lastEmbeddingError: string | null;
}

export class MemorySubsystem {
  readonly retriever: MemoryRetriever;
  readonly indexer: MemoryIndexer | null;
  readonly reembedding: ReembeddingService | null;
  private lastEmbeddingError: string | null = null;

  constructor(readonly vectorStore: SqliteVectorStore | null, readonly initializationError?: string) {
    const options = { modelCacheDirectory: path.join(dataDir, "embedding-models") };
    this.retriever = new MemoryRetriever(vectorStore, options);
    this.indexer = vectorStore ? new MemoryIndexer(vectorStore, options) : null;
    this.reembedding = vectorStore && this.indexer ? new ReembeddingService(this.indexer, vectorStore) : null;
    this.lastEmbeddingError = initializationError ?? null;
  }

  async retrieve(query: string, store: StoreShape, signal?: AbortSignal, context: { runId?: string } = {}): Promise<MemoryRetrievalResult> {
    const result = await this.retriever.retrieve(query, store.memory, store.settings, signal);
    const selected = new Set(result.memories.map((memory) => memory.id));
    if (selected.size) {
      const accessedAt = new Date().toISOString();
      for (const memory of store.memory) if (selected.has(memory.id)) memory.lastAccessedAt = accessedAt;
      await saveStore(store);
    }
    await audit({
      actor: "system",
      action: "memory.retrieve",
      risk: "read",
      status: result.diagnostics.status === "degraded" ? "error" : "ok",
      message: `${result.diagnostics.mode}:${result.diagnostics.status}`,
      details: {
        mode: result.diagnostics.mode,
        status: result.diagnostics.status,
        fallback: result.diagnostics.fallbackActivated,
        fallbackReason: result.diagnostics.fallbackReason,
        activeGenerationId: result.diagnostics.activeGenerationId,
        semanticCandidates: result.diagnostics.semanticCandidateCount,
        lexicalCandidates: result.diagnostics.lexicalCandidateCount,
        mergedCandidates: result.diagnostics.mergedCandidateCount,
        selectedMemories: result.diagnostics.selectedMemoryCount,
        selectedTokens: result.diagnostics.selectedTokenCount,
        durationMs: Math.round(result.diagnostics.queryDurationMs),
        runId: context.runId
      }
    });
    return result;
  }

  async indexPersistedMemory(entry: MemoryEntry, store: StoreShape, signal?: AbortSignal): Promise<void> {
    const configuration = resolveMemoryConfiguration(store.settings);
    entry.namespace ??= workspaceNamespace(store.settings.workspaceRoot);
    entry.contentHash = memoryContentHash(entry, configuration.embeddings.preprocessingVersion);
    if (!configuration.embeddings.embedOnWrite || configuration.retrieval.mode === "lexical_only") {
      entry.indexing = { status: configuration.retrieval.mode === "lexical_only" ? "disabled" : "pending", updatedAt: new Date().toISOString() };
      await saveStore(store);
      return;
    }
    if (!this.indexer) {
      entry.indexing = { status: "failed", errorCode: "vector_store_unavailable", updatedAt: new Date().toISOString() };
      this.lastEmbeddingError = "vector_store_unavailable";
      await saveStore(store);
      return;
    }
    entry.indexing = { status: "indexing", updatedAt: new Date().toISOString() };
    await saveStore(store);
    try {
      const result = await this.indexer.indexMemory(entry, store.settings, signal);
      entry.indexing = result.metadata;
      entry.contentHash = memoryContentHash(entry, configuration.embeddings.preprocessingVersion);
      this.indexer.activateWhenComplete(store.memory, store.settings, result.generation.id);
      this.lastEmbeddingError = null;
      await saveStore(store);
      await audit({
        actor: "system", action: "memory.index", risk: result.generation.provider === "transformers-local" ? "read" : "network", status: "ok", message: entry.id,
        details: { generationId: result.generation.id, provider: result.generation.provider, model: result.generation.model, dimension: result.generation.dimension, chunks: result.metadata.chunkCount, cacheHits: result.cacheHits, cacheMisses: result.cacheMisses, retries: result.retries, vectorUpsertDurationMs: Math.round(result.vectorUpsertDurationMs * 100) / 100 }
      });
    } catch (error) {
      const code = safeErrorCode(error);
      entry.indexing = { status: "failed", errorCode: code, updatedAt: new Date().toISOString() };
      this.lastEmbeddingError = code;
      await saveStore(store);
      await audit({ actor: "system", action: "memory.index", risk: "network", status: "error", message: entry.id, details: { errorCode: code } });
    }
  }

  prepareMemoryUpdate(entry: MemoryEntry, settings: Settings, indexedTextChanged: boolean): void {
    if (!indexedTextChanged) return;
    if (!this.vectorStore) {
      if (entry.indexing?.status === "indexed") throw Object.assign(new Error("Vector store is unavailable; refusing to update an indexed memory until its old vectors can be invalidated."), { status: 503 });
      return;
    }
    this.vectorStore.markMemoryStale(entry.id, entry.namespace ?? workspaceNamespace(settings.workspaceRoot));
  }

  prepareMemoryDelete(entry: MemoryEntry, settings: Settings): void {
    if (!this.vectorStore) {
      if (entry.indexing?.status === "indexed") throw Object.assign(new Error("Vector store is unavailable; refusing to delete an indexed memory until its vectors can be removed."), { status: 503 });
      return;
    }
    this.vectorStore.deleteMemory(entry.id, entry.namespace ?? workspaceNamespace(settings.workspaceRoot));
  }

  updateMemoryMetadata(entry: MemoryEntry): void {
    this.vectorStore?.updateMemoryMetadata(entry.id, { pinned: entry.pinned, kind: entry.kind, taskType: entry.taskType });
  }

  async backfill(store: StoreShape, options: BackfillOptions = {}): Promise<BackfillReport> {
    if (!this.indexer) throw Object.assign(new Error("Vector store is unavailable."), { status: 503 });
    const report = await this.indexer.backfill(store.memory, store.settings, { ...options, persist: async () => saveStore(store) });
    await saveStore(store);
    await audit({ actor: "system", action: "memory.backfill", risk: "network", status: report.failed ? "error" : "ok", message: report.jobId, details: { ...report, failures: report.failures.map((failure) => ({ memoryId: failure.memoryId, errorCode: failure.errorCode })) } });
    return report;
  }

  diagnostics(store: StoreShape): MemorySubsystemDiagnostics {
    const configuration = resolveMemoryConfiguration(store.settings);
    const namespace = workspaceNamespace(store.settings.workspaceRoot);
    const health = this.vectorStore?.health() ?? { ok: false, databasePath: path.join(dataDir, "memory-vectors.sqlite"), schemaVersion: 0, errorCode: "vector_store_unavailable" };
    const vector = this.vectorStore?.diagnostics(namespace) ?? { indexedMemories: 0, staleMemories: 0, failedMemories: 0, cachedEmbeddings: 0, activeGeneration: null, databaseBytes: 0 };
    const scoped = store.memory.filter((memory) => memory.namespace === namespace);
    const indexed = scoped.filter((memory) => memory.indexing?.status === "indexed").length;
    return {
      retrievalMode: configuration.retrieval.mode,
      provider: configuration.embeddings.provider,
      model: configuration.embeddings.model,
      sendsContentOffDevice: configuration.embeddings.provider !== "transformers-local" && !isLocalEndpoint(configuration.embeddings.endpoint),
      activeGeneration: vector.activeGeneration?.id ?? null,
      vectorStore: health,
      totalMemories: scoped.length,
      indexedMemories: indexed,
      staleOrUnindexedMemories: scoped.length - indexed - scoped.filter((memory) => memory.indexing?.status === "failed").length,
      failedMemories: scoped.filter((memory) => memory.indexing?.status === "failed").length,
      cachedEmbeddings: vector.cachedEmbeddings,
      databaseBytes: vector.databaseBytes,
      lastEmbeddingError: this.lastEmbeddingError
    };
  }
}

let subsystemPromise: Promise<MemorySubsystem> | undefined;

export function initializeMemorySubsystem(): Promise<MemorySubsystem> {
  subsystemPromise ??= (async () => {
    const vectorStore = new SqliteVectorStore(path.join(dataDir, "memory-vectors.sqlite"));
    try {
      await vectorStore.initialize();
      return new MemorySubsystem(vectorStore);
    } catch (error) {
      vectorStore.close();
      return new MemorySubsystem(null, safeErrorCode(error));
    }
  })();
  return subsystemPromise;
}

export function getMemorySubsystem(): Promise<MemorySubsystem> {
  return initializeMemorySubsystem();
}

export async function scheduleMemoryBackfill(): Promise<void> {
  const subsystem = await getMemorySubsystem();
  const store = await loadStore();
  const configuration = resolveMemoryConfiguration(store.settings);
  if (configuration.retrieval.mode === "lexical_only" || !configuration.embeddings.allowAsyncBackfill || !subsystem.indexer) return;
  setTimeout(() => {
    void subsystem.backfill(store).catch((error) => {
      console.error(JSON.stringify({ event: "memory.backfill.failed", errorCode: safeErrorCode(error) }));
    });
  }, 0);
}

function safeErrorCode(error: unknown): string {
  if (typeof error === "object" && error && "code" in error) return String((error as { code: unknown }).code).slice(0, 100);
  return "memory_subsystem_error";
}

function isLocalEndpoint(endpoint: string): boolean {
  if (!endpoint) return true;
  try { return ["localhost", "127.0.0.1", "::1", "[::1]"].includes(new URL(endpoint).hostname.toLowerCase()); }
  catch { return false; }
}

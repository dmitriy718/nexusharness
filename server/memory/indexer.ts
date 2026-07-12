import type { MemoryEntry, Settings } from "../types.js";
import { resolveMemoryConfiguration } from "./config.js";
import { chunkMemory, memoryContentHash, sha256, workspaceNamespace } from "./preprocessing.js";
import { createEmbeddingProvider } from "./providers.js";
import { EmbeddingService } from "./embeddingService.js";
import type { EmbeddingError, MemoryEmbeddingSettings, MemoryIndexingMetadata, VectorGenerationDescriptor, VectorRecord } from "./types.js";
import type { BackfillCheckpoint, SqliteVectorStore } from "./vectorStore.js";

export interface MemoryIndexerOptions {
  modelCacheDirectory: string;
  environment?: NodeJS.ProcessEnv;
}

export interface IndexMemoryResult {
  metadata: MemoryIndexingMetadata;
  generation: VectorGenerationDescriptor;
  cacheHits: number;
  cacheMisses: number;
  retries: number;
  vectorUpsertDurationMs: number;
}

export interface BackfillOptions {
  jobId?: string;
  dryRun?: boolean;
  batchSize?: number;
  rateLimitPerSecond?: number;
  namespace?: string;
  kind?: MemoryEntry["kind"];
  updatedAfter?: string;
  staleOnly?: boolean;
  force?: boolean;
  activateOnComplete?: boolean;
  signal?: AbortSignal;
  persist?: () => Promise<void>;
}

export interface BackfillReport {
  jobId: string;
  namespace: string;
  generationId?: string;
  dryRun: boolean;
  processed: number;
  succeeded: number;
  skipped: number;
  failed: number;
  remaining: number;
  activated: boolean;
  failures: Array<{ memoryId: string; errorCode: string }>;
}

export class MemoryIndexer {
  constructor(private readonly vectorStore: SqliteVectorStore, private readonly options: MemoryIndexerOptions) {}

  async indexMemory(entry: MemoryEntry, settings: Settings, signal?: AbortSignal): Promise<IndexMemoryResult> {
    const configuration = resolveMemoryConfiguration(settings);
    const namespace = entry.namespace ?? workspaceNamespace(settings.workspaceRoot);
    if (namespace !== workspaceNamespace(settings.workspaceRoot)) throw new Error("Memory namespace does not match the active workspace.");
    const contentHash = memoryContentHash(entry, configuration.embeddings.preprocessingVersion);
    const provider = createEmbeddingProvider(configuration.embeddings, this.options);
    let chunkSize = configuration.embeddings.chunkSizeTokens;
    let chunks = chunkMemory(entry, namespace, configuration.embeddings.preprocessingVersion, chunkSize, configuration.embeddings.chunkOverlapTokens);
    while (true) {
      const counts = await Promise.all(chunks.map((chunk) => provider.countTokens(chunk.text)));
      const largest = Math.max(...counts, 0);
      if (largest <= configuration.embeddings.maxInputTokens) break;
      const next = Math.floor(chunkSize * configuration.embeddings.maxInputTokens / largest * 0.9);
      if (next < 16 || next >= chunkSize) throw new Error("Memory cannot be chunked within the embedding model input limit.");
      chunkSize = next;
      chunks = chunkMemory(entry, namespace, configuration.embeddings.preprocessingVersion, chunkSize, Math.min(configuration.embeddings.chunkOverlapTokens, Math.floor(chunkSize / 4)));
    }
    if (!chunks.length) throw new Error("Memory produced no indexable chunks.");

    const service = new EmbeddingService(provider, this.vectorStore, configuration.embeddings);
    const embedded = await service.embedBatch(chunks.map((chunk) => chunk.text), signal);
    const dimension = embedded.descriptor.dimension;
    if (!dimension) throw new Error("Embedding provider did not report a vector dimension.");
    const generation = generationDescriptor(configuration.embeddings, configuration.retrieval.similarityMetric, dimension);
    this.vectorStore.ensureGeneration(generation);
    const now = new Date().toISOString();
    const records: VectorRecord[] = chunks.map((chunk, index) => ({
      memoryId: entry.id,
      namespace,
      kind: entry.kind,
      taskType: entry.taskType,
      pinned: entry.pinned,
      importance: entry.importance ?? 0.5,
      createdAt: entry.createdAt,
      updatedAt: entry.updatedAt,
      contentHash,
      chunkIndex: chunk.chunkIndex,
      chunkCount: chunk.chunkCount,
      tokenCount: chunk.tokenCount,
      vector: embedded.vectors[index]
    }));
    const upsertStarted = performance.now();
    this.vectorStore.upsertMemory(generation.id, records);
    const vectorUpsertDurationMs = performance.now() - upsertStarted;
    return {
      metadata: { status: "indexed", generationId: generation.id, embeddedAt: now, chunkCount: chunks.length, updatedAt: now },
      generation,
      cacheHits: service.metrics.cacheHits,
      cacheMisses: service.metrics.cacheMisses,
      retries: service.metrics.retries,
      vectorUpsertDurationMs
    };
  }

  async backfill(memories: MemoryEntry[], settings: Settings, options: BackfillOptions = {}): Promise<BackfillReport> {
    const configuration = resolveMemoryConfiguration(settings);
    const namespace = options.namespace ?? workspaceNamespace(settings.workspaceRoot);
    const candidates = memories
      .filter((entry) => entry.namespace === namespace)
      .filter((entry) => !options.kind || entry.kind === options.kind)
      .filter((entry) => !options.updatedAfter || Date.parse(entry.updatedAt) >= Date.parse(options.updatedAfter))
      .sort((left, right) => left.id.localeCompare(right.id));
    const provisionalJobId = options.jobId ?? sha256(JSON.stringify({ namespace, provider: configuration.embeddings.provider, model: configuration.embeddings.model, revision: configuration.embeddings.modelRevision, preprocessing: configuration.embeddings.preprocessingVersion })).slice(0, 24);
    if (options.dryRun) {
      const remaining = candidates.filter((entry) => options.force || !entry.indexing || entry.indexing.status !== "indexed" || entry.contentHash !== memoryContentHash(entry, configuration.embeddings.preprocessingVersion)).length;
      return { jobId: provisionalJobId, namespace, dryRun: true, processed: 0, succeeded: 0, skipped: candidates.length - remaining, failed: 0, remaining, activated: false, failures: [] };
    }

    const batchSize = Math.min(100, Math.max(1, options.batchSize ?? configuration.embeddings.batchSize));
    const checkpoint: BackfillCheckpoint | null = this.vectorStore.getBackfillCheckpoint(provisionalJobId);
    let generationId = checkpoint?.generationId;
    let processed = checkpoint?.processed ?? 0;
    let succeeded = checkpoint?.succeeded ?? 0;
    let skipped = checkpoint?.skipped ?? 0;
    let failed = checkpoint?.failed ?? 0;
    let cursor = checkpoint?.cursor ?? "";
    const failures: BackfillReport["failures"] = [];
    const pending = candidates.filter((entry) => entry.id > cursor);
    for (let offset = 0; offset < pending.length; offset += batchSize) {
      const batch = pending.slice(offset, offset + batchSize);
      for (const entry of batch) {
        if (options.signal?.aborted) throw new Error("Memory backfill was canceled.");
        const hash = memoryContentHash(entry, configuration.embeddings.preprocessingVersion);
        if (!options.force && generationId) {
          const existing = this.vectorStore.getMemoryIndex(generationId, entry.id);
          if (existing?.status === "indexed" && existing.contentHash === hash) {
            skipped += 1; processed += 1; cursor = entry.id; continue;
          }
        }
        entry.indexing = { status: "indexing", updatedAt: new Date().toISOString() };
        try {
          const result = await this.indexMemory(entry, settings, options.signal);
          generationId = result.generation.id;
          entry.contentHash = hash;
          entry.indexing = result.metadata;
          succeeded += 1;
        } catch (error) {
          const code = embeddingFailureCode(error);
          entry.indexing = { status: "failed", errorCode: code, updatedAt: new Date().toISOString() };
          failures.push({ memoryId: entry.id, errorCode: code });
          failed += 1;
        }
        processed += 1;
        cursor = entry.id;
        if (generationId) this.saveCheckpoint(provisionalJobId, namespace, generationId, cursor, processed, succeeded, skipped, failed, "running");
        if (options.rateLimitPerSecond && options.rateLimitPerSecond > 0) await delay(1000 / options.rateLimitPerSecond, options.signal);
      }
      await options.persist?.();
    }

    let activated = false;
    if (generationId) {
      const current = new Map(memories.filter((entry) => entry.namespace === namespace).map((entry) => [entry.id, memoryContentHash(entry, configuration.embeddings.preprocessingVersion)]));
      const coverage = this.vectorStore.coverage(namespace, generationId, current);
      const active = this.vectorStore.getActiveGeneration(namespace);
      if (coverage.complete && (!active || active.id === generationId || options.activateOnComplete)) {
        this.vectorStore.activateGeneration(namespace, generationId);
        activated = true;
      }
      this.saveCheckpoint(provisionalJobId, namespace, generationId, cursor, processed, succeeded, skipped, failed, failed ? "failed" : "completed");
    }
    return { jobId: provisionalJobId, namespace, generationId, dryRun: false, processed, succeeded, skipped, failed, remaining: Math.max(0, candidates.length - succeeded - skipped), activated, failures };
  }

  activateWhenComplete(memories: readonly MemoryEntry[], settings: Settings, generationId: string): boolean {
    const configuration = resolveMemoryConfiguration(settings);
    const namespace = workspaceNamespace(settings.workspaceRoot);
    const current = new Map(memories.filter((entry) => entry.namespace === namespace).map((entry) => [entry.id, memoryContentHash(entry, configuration.embeddings.preprocessingVersion)]));
    const coverage = this.vectorStore.coverage(namespace, generationId, current);
    if (!coverage.complete) return false;
    const active = this.vectorStore.getActiveGeneration(namespace);
    if (active && active.id !== generationId) return false;
    this.vectorStore.activateGeneration(namespace, generationId);
    return true;
  }

  private saveCheckpoint(jobId: string, namespace: string, generationId: string, cursor: string, processed: number, succeeded: number, skipped: number, failed: number, status: BackfillCheckpoint["status"]): void {
    this.vectorStore.saveBackfillCheckpoint({ jobId, namespace, generationId, cursor, processed, succeeded, skipped, failed, status, updatedAt: new Date().toISOString() });
  }
}

export class ReembeddingService {
  constructor(private readonly indexer: MemoryIndexer, private readonly vectorStore: SqliteVectorStore) {}

  build(memories: MemoryEntry[], settings: Settings, options: BackfillOptions = {}): Promise<BackfillReport> {
    return this.indexer.backfill(memories, settings, { ...options, force: true, activateOnComplete: false });
  }

  validateCoverage(memories: readonly MemoryEntry[], settings: Settings, generationId: string) {
    const configuration = resolveMemoryConfiguration(settings);
    const namespace = workspaceNamespace(settings.workspaceRoot);
    const current = new Map(memories.filter((entry) => entry.namespace === namespace).map((entry) => [entry.id, memoryContentHash(entry, configuration.embeddings.preprocessingVersion)]));
    return this.vectorStore.coverage(namespace, generationId, current);
  }

  cutover(memories: readonly MemoryEntry[], settings: Settings, generationId: string): void {
    const coverage = this.validateCoverage(memories, settings, generationId);
    if (!coverage.complete) throw new Error(`Cannot activate incomplete embedding generation: ${coverage.indexed}/${coverage.total} indexed, ${coverage.stale} stale, ${coverage.missing} missing.`);
    this.vectorStore.activateGeneration(workspaceNamespace(settings.workspaceRoot), generationId);
  }

  rollback(settings: Settings) {
    return this.vectorStore.rollbackGeneration(workspaceNamespace(settings.workspaceRoot));
  }
}

export function generationDescriptor(settings: MemoryEmbeddingSettings, similarityMetric: "cosine" | "l2", dimension: number): VectorGenerationDescriptor {
  const configuration = {
    ...settings,
    dimensions: dimension,
    apiKeyEnvironmentVariable: settings.apiKeyEnvironmentVariable
  };
  const identity = {
    provider: settings.provider,
    model: settings.model,
    modelRevision: settings.modelRevision,
    dimension,
    similarityMetric,
    preprocessingVersion: settings.preprocessingVersion,
    endpoint: settings.endpoint,
    maxInputTokens: settings.maxInputTokens
  };
  return {
    id: sha256(JSON.stringify(identity)),
    provider: settings.provider,
    model: settings.model,
    modelRevision: settings.modelRevision,
    dimension,
    similarityMetric,
    preprocessingVersion: settings.preprocessingVersion,
    configurationJson: JSON.stringify(configuration)
  };
}

function embeddingFailureCode(error: unknown): string {
  return typeof error === "object" && error && "code" in error ? String((error as EmbeddingError).code) : "indexing_failed";
}

function delay(milliseconds: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, milliseconds);
    signal?.addEventListener("abort", () => { clearTimeout(timer); reject(new Error("Memory backfill was canceled.")); }, { once: true });
  });
}

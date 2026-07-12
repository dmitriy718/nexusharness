import type { MemoryEmbeddingSettings } from "./types.js";
import type { EmbeddingBatchResult, EmbeddingProvider } from "./types.js";
import { EmbeddingError } from "./types.js";
import { sha256 } from "./preprocessing.js";
import type { SqliteVectorStore } from "./vectorStore.js";

export interface EmbeddingServiceMetrics {
  requests: number;
  batches: number;
  embeddedTexts: number;
  providerFailures: number;
  cacheHits: number;
  cacheMisses: number;
  totalProviderDurationMs: number;
  retries: number;
}

export class EmbeddingService {
  readonly metrics: EmbeddingServiceMetrics = {
    requests: 0,
    batches: 0,
    embeddedTexts: 0,
    providerFailures: 0,
    cacheHits: 0,
    cacheMisses: 0,
    totalProviderDurationMs: 0,
    retries: 0
  };

  constructor(
    readonly provider: EmbeddingProvider,
    private readonly vectorStore: SqliteVectorStore,
    private readonly settings: MemoryEmbeddingSettings
  ) {}

  async embed(text: string, signal?: AbortSignal): Promise<Float32Array> {
    return (await this.embedBatch([text], signal)).vectors[0];
  }

  async embedBatch(texts: readonly string[], signal?: AbortSignal): Promise<EmbeddingBatchResult> {
    if (!texts.length) throw new EmbeddingError("configuration", "Embedding service requires at least one input.", false);
    this.metrics.requests += 1;
    const vectors: Array<Float32Array | undefined> = new Array(texts.length);
    const misses: Array<{ text: string; index: number; cacheKey: string; contentHash: string }> = [];
    for (let index = 0; index < texts.length; index += 1) {
      const text = texts[index];
      const contentHash = sha256(text);
      const cacheKey = this.cacheKey(contentHash);
      const cached = this.settings.cacheEnabled ? this.vectorStore.getCachedEmbedding(cacheKey, this.provider.descriptor.dimension ?? undefined) : null;
      if (cached) {
        vectors[index] = cached;
        this.metrics.cacheHits += 1;
      } else {
        misses.push({ text, index, cacheKey, contentHash });
        this.metrics.cacheMisses += 1;
      }
    }

    let usage: EmbeddingBatchResult["usage"];
    let providerDuration = 0;
    for (let offset = 0; offset < misses.length; offset += this.settings.batchSize) {
      const batch = misses.slice(offset, offset + this.settings.batchSize);
      try {
        const result = await this.provider.embedBatch(batch.map((item) => item.text), signal);
        this.metrics.batches += 1;
        this.metrics.embeddedTexts += batch.length;
        this.metrics.totalProviderDurationMs += result.durationMs;
        this.metrics.retries += result.retries ?? 0;
        providerDuration += result.durationMs;
        usage = mergeUsage(usage, result.usage);
        batch.forEach((item, batchIndex) => {
          const vector = result.vectors[batchIndex];
          vectors[item.index] = vector;
          if (this.settings.cacheEnabled) {
            this.vectorStore.putCachedEmbedding(
              item.cacheKey,
              this.provider.descriptor.provider,
              this.provider.descriptor.model,
              this.provider.descriptor.revision,
              this.settings.preprocessingVersion,
              item.contentHash,
              vector,
              this.settings.cacheTtlMs,
              this.settings.cacheMaxEntries
            );
          }
        });
      } catch (error) {
        this.metrics.providerFailures += 1;
        throw error;
      }
    }

    const complete = vectors as Float32Array[];
    if (complete.some((vector) => !(vector instanceof Float32Array))) throw new EmbeddingError("invalid_response", "Embedding service did not produce every requested vector.", false);
    const dimension = complete[0].length;
    if (complete.some((vector) => vector.length !== dimension)) throw new EmbeddingError("dimension_mismatch", "Embedding batch contains mixed vector dimensions.", false);
    if (this.provider.descriptor.dimension && dimension !== this.provider.descriptor.dimension) throw new EmbeddingError("dimension_mismatch", "Cached and provider vectors use different dimensions.", false);
    this.provider.descriptor.dimension = dimension;
    return { vectors: complete, descriptor: { ...this.provider.descriptor }, usage, durationMs: providerDuration, retries: this.metrics.retries };
  }

  private cacheKey(contentHash: string): string {
    return sha256(JSON.stringify({
      provider: this.provider.descriptor.provider,
      model: this.provider.descriptor.model,
      revision: this.provider.descriptor.revision,
      preprocessingVersion: this.settings.preprocessingVersion,
      contentHash
    }));
  }
}

function mergeUsage(left: EmbeddingBatchResult["usage"], right: EmbeddingBatchResult["usage"]): EmbeddingBatchResult["usage"] {
  if (!left) return right;
  if (!right) return left;
  return {
    inputTokens: (left.inputTokens ?? 0) + (right.inputTokens ?? 0),
    totalTokens: (left.totalTokens ?? 0) + (right.totalTokens ?? 0),
    costUsd: (left.costUsd ?? 0) + (right.costUsd ?? 0)
  };
}

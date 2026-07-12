export type MemoryRetrievalMode = "lexical_only" | "shadow_semantic" | "hybrid" | "semantic_only";
export type SimilarityMetric = "cosine" | "l2";
export type PinnedMemoryPolicy = "always_include" | "ranked";
export type EmbeddingProviderKind = "transformers-local" | "ollama" | "openai-compatible";
export type EmbeddingFailurePolicy = "lexical_fallback" | "fail_closed";
export type MemoryIndexStatus = "pending" | "indexing" | "indexed" | "stale" | "failed" | "disabled";

export interface MemoryRetrievalSettings {
  mode: MemoryRetrievalMode;
  topKCandidates: number;
  finalMemoryLimit: number;
  similarityMetric: SimilarityMetric;
  minimumSemanticScore: number;
  semanticWeight: number;
  lexicalWeight: number;
  recencyWeight: number;
  taskTypeWeight: number;
  importanceWeight: number;
  pinnedPolicy: PinnedMemoryPolicy;
  deduplicate: boolean;
  diversityReranking: boolean;
  diversityLambda: number;
}

export interface MemoryEmbeddingSettings {
  provider: EmbeddingProviderKind;
  model: string;
  modelRevision: string;
  endpoint: string;
  dimensions: number | null;
  batchSize: number;
  timeoutMs: number;
  maxRetries: number;
  maxInputTokens: number;
  chunkSizeTokens: number;
  chunkOverlapTokens: number;
  cacheEnabled: boolean;
  cacheMaxEntries: number;
  cacheTtlMs: number;
  embedOnWrite: boolean;
  allowAsyncBackfill: boolean;
  failurePolicy: EmbeddingFailurePolicy;
  allowRemoteContent: boolean;
  allowModelDownload: boolean;
  apiKeyEnvironmentVariable: string;
  preprocessingVersion: string;
}

export interface MemoryIndexingMetadata {
  status: MemoryIndexStatus;
  generationId?: string;
  embeddedAt?: string;
  chunkCount?: number;
  errorCode?: string;
  updatedAt: string;
}

export interface EmbeddingModelDescriptor {
  provider: EmbeddingProviderKind;
  model: string;
  revision: string;
  dimension: number | null;
  maximumInputTokens: number;
  maximumBatchSize: number;
  similarityMetric: SimilarityMetric;
  sendsContentOffDevice: boolean;
}

export interface EmbeddingUsage {
  inputTokens?: number;
  totalTokens?: number;
  costUsd?: number;
}

export interface EmbeddingBatchResult {
  vectors: Float32Array[];
  descriptor: EmbeddingModelDescriptor;
  usage?: EmbeddingUsage;
  durationMs: number;
  retries?: number;
}

export interface EmbeddingProviderHealth {
  ok: boolean;
  checkedAt: string;
  latencyMs: number;
  descriptor: EmbeddingModelDescriptor;
  errorCode?: string;
}

export interface EmbeddingProvider {
  readonly descriptor: EmbeddingModelDescriptor;
  embed(text: string, signal?: AbortSignal): Promise<EmbeddingBatchResult>;
  embedBatch(texts: readonly string[], signal?: AbortSignal): Promise<EmbeddingBatchResult>;
  countTokens(text: string): Promise<number>;
  health(signal?: AbortSignal): Promise<EmbeddingProviderHealth>;
}

export type EmbeddingErrorCode =
  | "aborted"
  | "authentication"
  | "configuration"
  | "dimension_mismatch"
  | "input_too_large"
  | "invalid_response"
  | "model_unavailable"
  | "network"
  | "rate_limited"
  | "timeout"
  | "provider_unavailable";

export class EmbeddingError extends Error {
  constructor(
    readonly code: EmbeddingErrorCode,
    message: string,
    readonly retryable: boolean,
    readonly status?: number,
    options?: ErrorOptions
  ) {
    super(message, options);
    this.name = "EmbeddingError";
  }
}

export interface MemoryChunk {
  memoryId: string;
  namespace: string;
  chunkIndex: number;
  chunkCount: number;
  text: string;
  tokenCount: number;
  contentHash: string;
  chunkHash: string;
}

export interface VectorGenerationDescriptor {
  id: string;
  provider: EmbeddingProviderKind;
  model: string;
  modelRevision: string;
  dimension: number;
  similarityMetric: SimilarityMetric;
  preprocessingVersion: string;
  configurationJson: string;
}

export interface VectorRecord {
  memoryId: string;
  namespace: string;
  kind: string;
  taskType: string;
  pinned: boolean;
  importance: number;
  createdAt: string;
  updatedAt: string;
  contentHash: string;
  chunkIndex: number;
  chunkCount: number;
  tokenCount: number;
  vector: Float32Array;
}

export interface VectorSearchResult {
  memoryId: string;
  chunkIndex: number;
  chunkCount: number;
  distance: number;
  semanticScore: number;
}

export interface RetrievalDiagnostics {
  mode: MemoryRetrievalMode;
  status: "ok" | "degraded" | "disabled";
  fallbackActivated: boolean;
  fallbackReason?: string;
  activeGenerationId?: string;
  semanticCandidateCount: number;
  lexicalCandidateCount: number;
  mergedCandidateCount: number;
  selectedMemoryCount: number;
  selectedTokenCount: number;
  queryDurationMs: number;
  vectorQueryDurationMs: number;
  scoreDistribution: { minimum: number; maximum: number; average: number } | null;
  shadowComparison?: {
    lexicalRanking: string[];
    semanticRanking: string[];
    overlapAtK: number;
  };
}

export interface RetrievedMemory {
  id: string;
  title: string;
  content: string;
  source: string;
  taskType: string;
  pinned: boolean;
  score: number;
  semanticScore: number;
  lexicalScore: number;
  taskTypeScore: number;
  recencyScore: number;
  importanceScore: number;
  reasons: Array<"pinned" | "semantic" | "lexical" | "task_type">;
}

export interface MemoryRetrievalResult {
  promptContext: string;
  memories: RetrievedMemory[];
  diagnostics: RetrievalDiagnostics;
}

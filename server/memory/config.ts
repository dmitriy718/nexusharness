import { z } from "zod";
import type { Settings } from "../types.js";
import type { MemoryEmbeddingSettings, MemoryRetrievalSettings } from "./types.js";

export const defaultMemoryRetrievalSettings: MemoryRetrievalSettings = {
  mode: "lexical_only",
  topKCandidates: 50,
  finalMemoryLimit: 12,
  similarityMetric: "cosine",
  minimumSemanticScore: 0.25,
  semanticWeight: 0.55,
  lexicalWeight: 0.2,
  recencyWeight: 0.1,
  taskTypeWeight: 0.1,
  importanceWeight: 0.05,
  pinnedPolicy: "always_include",
  deduplicate: true,
  diversityReranking: true,
  diversityLambda: 0.7
};

export const defaultMemoryEmbeddingSettings: MemoryEmbeddingSettings = {
  provider: "transformers-local",
  model: "Xenova/all-MiniLM-L6-v2",
  modelRevision: "main",
  endpoint: "",
  dimensions: null,
  batchSize: 32,
  timeoutMs: 30_000,
  maxRetries: 3,
  maxInputTokens: 256,
  chunkSizeTokens: 220,
  chunkOverlapTokens: 32,
  cacheEnabled: true,
  cacheMaxEntries: 10_000,
  cacheTtlMs: 30 * 24 * 60 * 60 * 1000,
  embedOnWrite: true,
  allowAsyncBackfill: true,
  failurePolicy: "lexical_fallback",
  allowRemoteContent: false,
  allowModelDownload: false,
  apiKeyEnvironmentVariable: "NEXUSHARNESS_EMBEDDING_API_KEY",
  preprocessingVersion: "memory-text-v1"
};

const unitInterval = z.number().finite().min(0).max(1);

export const memoryRetrievalSettingsSchema = z.object({
  mode: z.enum(["lexical_only", "shadow_semantic", "hybrid", "semantic_only"]).default(defaultMemoryRetrievalSettings.mode),
  topKCandidates: z.number().int().min(1).max(500).default(defaultMemoryRetrievalSettings.topKCandidates),
  finalMemoryLimit: z.number().int().min(1).max(100).default(defaultMemoryRetrievalSettings.finalMemoryLimit),
  similarityMetric: z.enum(["cosine", "l2"]).default(defaultMemoryRetrievalSettings.similarityMetric),
  minimumSemanticScore: unitInterval.default(defaultMemoryRetrievalSettings.minimumSemanticScore),
  semanticWeight: unitInterval.default(defaultMemoryRetrievalSettings.semanticWeight),
  lexicalWeight: unitInterval.default(defaultMemoryRetrievalSettings.lexicalWeight),
  recencyWeight: unitInterval.default(defaultMemoryRetrievalSettings.recencyWeight),
  taskTypeWeight: unitInterval.default(defaultMemoryRetrievalSettings.taskTypeWeight),
  importanceWeight: unitInterval.default(defaultMemoryRetrievalSettings.importanceWeight),
  pinnedPolicy: z.enum(["always_include", "ranked"]).default(defaultMemoryRetrievalSettings.pinnedPolicy),
  deduplicate: z.boolean().default(defaultMemoryRetrievalSettings.deduplicate),
  diversityReranking: z.boolean().default(defaultMemoryRetrievalSettings.diversityReranking),
  diversityLambda: unitInterval.default(defaultMemoryRetrievalSettings.diversityLambda)
}).superRefine((value, ctx) => {
  if (value.finalMemoryLimit > value.topKCandidates) {
    ctx.addIssue({ code: "custom", path: ["finalMemoryLimit"], message: "finalMemoryLimit cannot exceed topKCandidates." });
  }
  const total = value.semanticWeight + value.lexicalWeight + value.recencyWeight + value.taskTypeWeight + value.importanceWeight;
  if (Math.abs(total - 1) > 0.0001) {
    ctx.addIssue({ code: "custom", path: ["semanticWeight"], message: "Memory retrieval weights must sum to 1." });
  }
});

export const memoryEmbeddingSettingsSchema = z.object({
  provider: z.enum(["transformers-local", "ollama", "openai-compatible"]).default(defaultMemoryEmbeddingSettings.provider),
  model: z.string().trim().min(1).max(2000).default(defaultMemoryEmbeddingSettings.model),
  modelRevision: z.string().trim().min(1).max(200).default(defaultMemoryEmbeddingSettings.modelRevision),
  endpoint: z.string().trim().max(8192).default(defaultMemoryEmbeddingSettings.endpoint),
  dimensions: z.number().int().min(1).max(65_536).nullable().default(defaultMemoryEmbeddingSettings.dimensions),
  batchSize: z.number().int().min(1).max(256).default(defaultMemoryEmbeddingSettings.batchSize),
  timeoutMs: z.number().int().min(1000).max(300_000).default(defaultMemoryEmbeddingSettings.timeoutMs),
  maxRetries: z.number().int().min(0).max(10).default(defaultMemoryEmbeddingSettings.maxRetries),
  maxInputTokens: z.number().int().min(32).max(1_000_000).default(defaultMemoryEmbeddingSettings.maxInputTokens),
  chunkSizeTokens: z.number().int().min(16).max(100_000).default(defaultMemoryEmbeddingSettings.chunkSizeTokens),
  chunkOverlapTokens: z.number().int().min(0).max(50_000).default(defaultMemoryEmbeddingSettings.chunkOverlapTokens),
  cacheEnabled: z.boolean().default(defaultMemoryEmbeddingSettings.cacheEnabled),
  cacheMaxEntries: z.number().int().min(0).max(1_000_000).default(defaultMemoryEmbeddingSettings.cacheMaxEntries),
  cacheTtlMs: z.number().int().min(1000).max(365 * 24 * 60 * 60 * 1000).default(defaultMemoryEmbeddingSettings.cacheTtlMs),
  embedOnWrite: z.boolean().default(defaultMemoryEmbeddingSettings.embedOnWrite),
  allowAsyncBackfill: z.boolean().default(defaultMemoryEmbeddingSettings.allowAsyncBackfill),
  failurePolicy: z.enum(["lexical_fallback", "fail_closed"]).default(defaultMemoryEmbeddingSettings.failurePolicy),
  allowRemoteContent: z.boolean().default(defaultMemoryEmbeddingSettings.allowRemoteContent),
  allowModelDownload: z.boolean().default(defaultMemoryEmbeddingSettings.allowModelDownload),
  apiKeyEnvironmentVariable: z.string().regex(/^[A-Z][A-Z0-9_]{0,127}$/).default(defaultMemoryEmbeddingSettings.apiKeyEnvironmentVariable),
  preprocessingVersion: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/).default(defaultMemoryEmbeddingSettings.preprocessingVersion)
}).superRefine((value, ctx) => {
  if (value.chunkOverlapTokens >= value.chunkSizeTokens) {
    ctx.addIssue({ code: "custom", path: ["chunkOverlapTokens"], message: "chunkOverlapTokens must be smaller than chunkSizeTokens." });
  }
  if (value.chunkSizeTokens > value.maxInputTokens) {
    ctx.addIssue({ code: "custom", path: ["chunkSizeTokens"], message: "chunkSizeTokens cannot exceed maxInputTokens." });
  }
  if (value.provider !== "transformers-local") {
    const parsed = z.string().url().safeParse(value.endpoint);
    if (!parsed.success || !/^https?:\/\//i.test(value.endpoint)) {
      ctx.addIssue({ code: "custom", path: ["endpoint"], message: "HTTP embedding providers require an HTTP or HTTPS endpoint." });
    }
  }
  if (value.provider === "transformers-local" && value.endpoint) {
    ctx.addIssue({ code: "custom", path: ["endpoint"], message: "The local Transformers provider does not accept an HTTP endpoint." });
  }
});

export function resolveMemoryConfiguration(settings: Pick<Settings, "memoryRetrieval" | "memoryEmbeddings">) {
  return {
    retrieval: memoryRetrievalSettingsSchema.parse(settings.memoryRetrieval ?? {}),
    embeddings: memoryEmbeddingSettingsSchema.parse(settings.memoryEmbeddings ?? {})
  };
}

export function isLoopbackEndpoint(endpoint: string): boolean {
  if (!endpoint) return true;
  const hostname = new URL(endpoint).hostname.replace(/^\[|\]$/g, "").toLowerCase();
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1";
}

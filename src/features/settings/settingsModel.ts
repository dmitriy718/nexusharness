import type { SettingsShape } from "../../api/types";

export type SettingsSectionId = "workspace" | "execution" | "safety" | "integrations" | "memory" | "appearance" | "help" | "about";

const sectionKeys: Record<SettingsSectionId, Array<keyof SettingsShape>> = {
  workspace: ["workspaceRoot", "testCommand", "lintCommand", "shellPath"],
  execution: ["maxIterations", "maxParallelExecutors", "criticThreshold"],
  safety: ["approvalMode"],
  integrations: ["mcpAutoDiscovery", "mcpPortStart", "mcpPortEnd"],
  memory: ["memoryTokenBudget", "memoryRetrieval", "memoryEmbeddings"],
  appearance: ["layout"],
  help: [],
  about: []
};

export function validateSettings(settings: SettingsShape): Record<string, string> {
  const errors: Record<string, string> = {};
  if (!settings.workspaceRoot.trim()) errors.workspaceRoot = "Workspace root is required.";
  if (!settings.shellPath.trim()) errors.shellPath = "Shell executable is required.";
  if (!Number.isInteger(settings.maxIterations) || settings.maxIterations < 1 || settings.maxIterations > 25) errors.maxIterations = "Use 1–25 cycles.";
  if (!Number.isInteger(settings.maxParallelExecutors) || settings.maxParallelExecutors < 1 || settings.maxParallelExecutors > 12) errors.maxParallelExecutors = "Use 1–12 agents.";
  if (!Number.isInteger(settings.criticThreshold) || settings.criticThreshold < 1 || settings.criticThreshold > 10) errors.criticThreshold = "Use a score from 1–10.";
  if (!Number.isInteger(settings.mcpPortStart) || settings.mcpPortStart < 1 || settings.mcpPortStart > 65535) errors.mcpPortStart = "Use a port from 1–65,535.";
  if (!Number.isInteger(settings.mcpPortEnd) || settings.mcpPortEnd < 1 || settings.mcpPortEnd > 65535) errors.mcpPortEnd = "Use a port from 1–65,535.";
  if (!errors.mcpPortStart && !errors.mcpPortEnd && settings.mcpPortStart > settings.mcpPortEnd) errors.mcpPortStart = "Start must be less than or equal to end.";
  if (!Number.isInteger(settings.memoryTokenBudget) || settings.memoryTokenBudget < 0 || settings.memoryTokenBudget > 50000) errors.memoryTokenBudget = "Use 0–50,000 tokens.";
  const retrieval = { ...defaultClientMemoryRetrieval, ...(settings.memoryRetrieval ?? {}) };
  const embeddings = { ...defaultClientMemoryEmbeddings, ...(settings.memoryEmbeddings ?? {}) };
  if (!Number.isInteger(retrieval.topKCandidates) || retrieval.topKCandidates < 1 || retrieval.topKCandidates > 500) errors.memoryTopK = "Use 1–500 candidates.";
  if (!Number.isInteger(retrieval.finalMemoryLimit) || retrieval.finalMemoryLimit < 1 || retrieval.finalMemoryLimit > retrieval.topKCandidates) errors.memoryFinalLimit = "Use at least 1 and no more than candidate count.";
  const weights = retrieval.semanticWeight + retrieval.lexicalWeight + retrieval.recencyWeight + retrieval.taskTypeWeight + retrieval.importanceWeight;
  if (Math.abs(weights - 1) > 0.0001) errors.memoryWeights = "Retrieval weights must sum to 1.";
  if (retrieval.minimumSemanticScore < 0 || retrieval.minimumSemanticScore > 1) errors.memoryMinimumScore = "Use a score from 0–1.";
  if (!embeddings.model.trim()) errors.memoryEmbeddingModel = "An embedding model is required.";
  if (embeddings.provider !== "transformers-local") {
    try {
      const endpoint = new URL(embeddings.endpoint);
      if (!/^https?:$/.test(endpoint.protocol)) throw new Error();
      const local = ["localhost", "127.0.0.1", "::1", "[::1]"].includes(endpoint.hostname.toLowerCase());
      if (!local && !embeddings.allowRemoteContent) errors.memoryEmbeddingEndpoint = "Remote endpoints require explicit content-transmission consent.";
    } catch { errors.memoryEmbeddingEndpoint = "Use a valid HTTP or HTTPS embedding endpoint."; }
  }
  if (embeddings.chunkOverlapTokens >= embeddings.chunkSizeTokens) errors.memoryChunkOverlap = "Overlap must be smaller than chunk size.";
  if (embeddings.chunkSizeTokens > embeddings.maxInputTokens) errors.memoryChunkSize = "Chunk size cannot exceed model input limit.";
  return errors;
}

export function dirtySettingSections(saved: SettingsShape, draft: SettingsShape): SettingsSectionId[] {
  return (Object.keys(sectionKeys) as SettingsSectionId[]).filter((section) => sectionKeys[section].some((key) => JSON.stringify(saved[key]) !== JSON.stringify(draft[key])));
}

export function restoreSettingsSection(draft: SettingsShape, section: SettingsSectionId): SettingsShape {
  if (section === "workspace") return { ...draft, testCommand: "", lintCommand: "" };
  if (section === "execution") return { ...draft, maxIterations: 5, maxParallelExecutors: 3, criticThreshold: 7 };
  if (section === "safety") return { ...draft, approvalMode: true };
  if (section === "integrations") return { ...draft, mcpAutoDiscovery: true, mcpPortStart: 3000, mcpPortEnd: 9999 };
  if (section === "memory") return { ...draft, memoryTokenBudget: 2000, memoryRetrieval: { ...defaultClientMemoryRetrieval }, memoryEmbeddings: { ...defaultClientMemoryEmbeddings } };
  if (section === "appearance") return { ...draft, layout: "chat" };
  return draft;
}

export const defaultClientMemoryRetrieval: NonNullable<SettingsShape["memoryRetrieval"]> = {
  mode: "lexical_only", topKCandidates: 50, finalMemoryLimit: 12, similarityMetric: "cosine", minimumSemanticScore: 0.25,
  semanticWeight: 0.55, lexicalWeight: 0.2, recencyWeight: 0.1, taskTypeWeight: 0.1, importanceWeight: 0.05,
  pinnedPolicy: "always_include", deduplicate: true, diversityReranking: true, diversityLambda: 0.7
};

export const defaultClientMemoryEmbeddings: NonNullable<SettingsShape["memoryEmbeddings"]> = {
  provider: "transformers-local", model: "Xenova/all-MiniLM-L6-v2", modelRevision: "main", endpoint: "", dimensions: null,
  batchSize: 32, timeoutMs: 30000, maxRetries: 3, maxInputTokens: 256, chunkSizeTokens: 220, chunkOverlapTokens: 32,
  cacheEnabled: true, cacheMaxEntries: 10000, cacheTtlMs: 2592000000, embedOnWrite: true, allowAsyncBackfill: true,
  failurePolicy: "lexical_fallback", allowRemoteContent: false, allowModelDownload: false,
  apiKeyEnvironmentVariable: "NEXUSHARNESS_EMBEDDING_API_KEY", preprocessingVersion: "memory-text-v1"
};

export function sectionHasChanges(saved: SettingsShape, draft: SettingsShape, section: SettingsSectionId): boolean {
  return sectionKeys[section].some((key) => JSON.stringify(saved[key]) !== JSON.stringify(draft[key]));
}

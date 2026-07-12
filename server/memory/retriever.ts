import type { MemoryEntry, Settings } from "../types.js";
import { memoryEmbeddingSettingsSchema, resolveMemoryConfiguration } from "./config.js";
import { EmbeddingService } from "./embeddingService.js";
import { memoryContentHash, workspaceNamespace } from "./preprocessing.js";
import { createEmbeddingProvider } from "./providers.js";
import { HybridRanker, TokenBudgetAllocator, type RankCandidate } from "./ranking.js";
import type { MemoryRetrievalMode, MemoryRetrievalResult, RetrievalDiagnostics } from "./types.js";
import type { SqliteVectorStore } from "./vectorStore.js";
import type { MemoryIndexerOptions } from "./indexer.js";

export class MemoryRetriever {
  private readonly allocator = new TokenBudgetAllocator();

  constructor(private readonly vectorStore: SqliteVectorStore | null, private readonly providerOptions: MemoryIndexerOptions) {}

  async retrieve(query: string, memories: readonly MemoryEntry[], settings: Settings, signal?: AbortSignal): Promise<MemoryRetrievalResult> {
    const started = performance.now();
    const configuration = resolveMemoryConfiguration(settings);
    const namespace = workspaceNamespace(settings.workspaceRoot);
    const eligible = memories.filter((entry) => entry.namespace === namespace);
    const ranker = new HybridRanker(configuration.retrieval);
    const lexical = eligible.map((entry) => ranker.lexicalCandidate(entry, query));
    const lexicalCandidates = lexical.filter((candidate) => candidate.entry.pinned || candidate.lexicalScore > 0 || candidate.taskTypeScore > 0);
    let semanticCandidates: RankCandidate[] = [];
    let vectorDuration = 0;
    let activeGenerationId: string | undefined;
    let fallbackActivated = false;
    let fallbackReason: string | undefined;

    if (configuration.retrieval.mode !== "lexical_only" && query.trim() && eligible.length) {
      try {
        const vectorStore = this.vectorStore;
        if (!vectorStore) throw Object.assign(new Error("vector_store_unavailable"), { code: "vector_store_unavailable" });
        const active = vectorStore.getActiveGeneration(namespace);
        if (!active) throw new Error("no_active_generation");
        activeGenerationId = active.id;
        const activeSettings = memoryEmbeddingSettingsSchema.parse(JSON.parse(active.configurationJson));
        const provider = createEmbeddingProvider(activeSettings, this.providerOptions);
        const service = new EmbeddingService(provider, vectorStore, activeSettings);
        const queryVector = await service.embed(`Task query (untrusted user text):\n${query.normalize("NFKC").trim()}`, signal);
        const vectorStarted = performance.now();
        const results = vectorStore.search(active.id, namespace, queryVector, configuration.retrieval.topKCandidates);
        vectorDuration = performance.now() - vectorStarted;
        const strongest = new Map<string, number>();
        for (const result of results) strongest.set(result.memoryId, Math.max(strongest.get(result.memoryId) ?? 0, result.semanticScore));
        semanticCandidates = lexical
          .filter((candidate) => (strongest.get(candidate.entry.id) ?? 0) >= configuration.retrieval.minimumSemanticScore)
          .filter((candidate) => {
            const index = vectorStore.getMemoryIndex(active.id, candidate.entry.id);
            return index?.status === "indexed" && index.contentHash === memoryContentHash(candidate.entry, active.preprocessingVersion) && index.namespace === namespace;
          })
          .map((candidate) => ranker.withSemantic(candidate, strongest.get(candidate.entry.id) ?? 0, vectorStore.getMemoryVector(active.id, candidate.entry.id) ?? undefined));
      } catch (error) {
        fallbackActivated = true;
        fallbackReason = safeFallbackReason(error);
        if (configuration.embeddings.failurePolicy === "fail_closed") throw error;
      }
    }

    const shadowComparison = configuration.retrieval.mode === "shadow_semantic" && !fallbackActivated
      ? compareShadowRankings(ranker, lexicalCandidates, semanticCandidates, configuration.retrieval.finalMemoryLimit)
      : undefined;
    const selectedPool = selectionPool(configuration.retrieval.mode, lexicalCandidates, semanticCandidates, fallbackActivated);
    const ranked = ranker.mergeAndRank(selectedPool);
    const packed = this.allocator.allocate(ranked, settings.memoryTokenBudget, configuration.retrieval.finalMemoryLimit, configuration.retrieval.pinnedPolicy);
    const scores = packed.memories.map((memory) => memory.score);
    const diagnostics: RetrievalDiagnostics = {
      mode: configuration.retrieval.mode,
      status: settings.memoryTokenBudget === 0 ? "disabled" : fallbackActivated ? "degraded" : "ok",
      fallbackActivated,
      fallbackReason,
      activeGenerationId,
      semanticCandidateCount: semanticCandidates.length,
      lexicalCandidateCount: lexicalCandidates.length,
      mergedCandidateCount: ranked.length,
      selectedMemoryCount: packed.memories.length,
      selectedTokenCount: packed.tokenCount,
      queryDurationMs: performance.now() - started,
      vectorQueryDurationMs: vectorDuration,
      scoreDistribution: scores.length ? { minimum: Math.min(...scores), maximum: Math.max(...scores), average: scores.reduce((sum, score) => sum + score, 0) / scores.length } : null,
      shadowComparison
    };
    this.vectorStore?.recordRetrieval(namespace, diagnostics);
    console.info(JSON.stringify({
      event: "memory.retrieval",
      mode: diagnostics.mode,
      status: diagnostics.status,
      fallback: diagnostics.fallbackActivated,
      semanticCandidates: diagnostics.semanticCandidateCount,
      lexicalCandidates: diagnostics.lexicalCandidateCount,
      selected: diagnostics.selectedMemoryCount,
      selectedTokens: diagnostics.selectedTokenCount,
      durationMs: Math.round(diagnostics.queryDurationMs)
    }));
    return { promptContext: packed.promptContext, memories: packed.memories, diagnostics };
  }
}

function compareShadowRankings(ranker: HybridRanker, lexical: RankCandidate[], semantic: RankCandidate[], limit: number): NonNullable<RetrievalDiagnostics["shadowComparison"]> {
  const lexicalRanking = ranker.mergeAndRank(lexical).slice(0, limit).map((candidate) => candidate.entry.id);
  const semanticRanking = ranker.mergeAndRank([...semantic, ...lexical.filter((candidate) => candidate.entry.pinned)]).slice(0, limit).map((candidate) => candidate.entry.id);
  const lexicalIds = new Set(lexicalRanking);
  const overlap = semanticRanking.filter((id) => lexicalIds.has(id)).length;
  return { lexicalRanking, semanticRanking, overlapAtK: limit ? overlap / limit : 0 };
}

function selectionPool(mode: MemoryRetrievalMode, lexical: RankCandidate[], semantic: RankCandidate[], fallback: boolean): RankCandidate[] {
  if (mode === "lexical_only" || mode === "shadow_semantic" || fallback) return lexical;
  if (mode === "semantic_only") return [...semantic, ...lexical.filter((candidate) => candidate.entry.pinned)];
  const semanticById = new Map(semantic.map((candidate) => [candidate.entry.id, candidate]));
  return [...semantic, ...lexical.filter((candidate) => !semanticById.has(candidate.entry.id))];
}

function safeFallbackReason(error: unknown): string {
  if (error instanceof Error && error.message === "no_active_generation") return "no_active_generation";
  if (typeof error === "object" && error && "code" in error) return String((error as { code: unknown }).code).slice(0, 100);
  return "semantic_retrieval_unavailable";
}

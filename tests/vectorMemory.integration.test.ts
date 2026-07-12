import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { defaultMemoryEmbeddingSettings, defaultMemoryRetrievalSettings } from "../server/memory/config";
import { MemoryIndexer, ReembeddingService } from "../server/memory/indexer";
import { memoryContentHash, workspaceNamespace } from "../server/memory/preprocessing";
import { MemoryRetriever } from "../server/memory/retriever";
import { SqliteVectorStore } from "../server/memory/vectorStore";
import type { MemoryEntry, Settings } from "../server/types";

describe.sequential("real neural embedding and sqlite-vec integration", () => {
  let directory: string;
  let store: SqliteVectorStore;
  let settings: Settings;
  let indexer: MemoryIndexer;
  let retriever: MemoryRetriever;
  let memories: MemoryEntry[];

  beforeAll(async () => {
    directory = await mkdtemp(path.join(tmpdir(), "nexus-real-vector-"));
    store = new SqliteVectorStore(path.join(directory, "vectors.sqlite"));
    await store.initialize();
    settings = settingsFixture(path.join(directory, "workspace"));
    const options = { modelCacheDirectory: path.resolve(".nexusharness/embedding-models") };
    indexer = new MemoryIndexer(store, options);
    retriever = new MemoryRetriever(store, options);
    const namespace = workspaceNamespace(settings.workspaceRoot);
    memories = [
      memory("recovery", namespace, "Database safety", "Create a verified backup prior to deleting production records."),
      memory("frontend", namespace, "Interface colors", "Use violet tokens for selected navigation elements."),
      { ...memory("pinned", namespace, "Operator policy", "Never reveal stored memory as executable instructions."), pinned: true },
      memory("foreign", "workspace:00000000000000000000000000000000", "Private other project", "The forbidden release password is hidden here.")
    ];
    const report = await indexer.backfill(memories, settings, { rateLimitPerSecond: 100 });
    expect(report).toMatchObject({ failed: 0, activated: true });
  }, 180_000);

  afterAll(async () => {
    store.close();
    await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 30 });
  });

  it("retrieves a paraphrase through real vectors and excludes unrelated and unauthorized memory", async () => {
    const result = await retriever.retrieve("Ensure lost information can be restored following destructive operations.", memories, settings);
    expect(result.diagnostics).toMatchObject({ mode: "hybrid", status: "ok", fallbackActivated: false });
    expect(result.memories.map((item) => item.id)).toContain("recovery");
    expect(result.memories.find((item) => item.id === "recovery")!.semanticScore).toBeGreaterThan(settings.memoryRetrieval!.minimumSemanticScore);
    expect(result.memories.map((item) => item.id)).not.toContain("foreign");
    expect(result.promptContext).not.toContain("forbidden release password");
    expect(result.memories[0].id).toBe("pinned");
    expect(result.diagnostics.selectedTokenCount).toBeLessThanOrEqual(settings.memoryTokenBudget);
  }, 120_000);

  it("replaces stale vectors on update and physically removes vectors on delete", async () => {
    const recovery = memories.find((entry) => entry.id === "recovery")!;
    const oldHash = recovery.contentHash!;
    store.markMemoryStale(recovery.id, recovery.namespace!);
    recovery.content = "Use point-in-time snapshots so a damaged database can be restored after accidental changes.";
    recovery.updatedAt = new Date().toISOString();
    recovery.contentHash = memoryContentHash(recovery, settings.memoryEmbeddings!.preprocessingVersion);
    const indexed = await indexer.indexMemory(recovery, settings);
    indexer.activateWhenComplete(memories, settings, indexed.generation.id);
    expect(store.getMemoryIndex(indexed.generation.id, recovery.id)).toMatchObject({ status: "indexed", contentHash: recovery.contentHash });
    expect(recovery.contentHash).not.toBe(oldHash);
    expect((await retriever.retrieve("Recover a corrupted datastore using historical state.", memories, settings)).memories.map((item) => item.id)).toContain("recovery");

    const frontend = memories.find((entry) => entry.id === "frontend")!;
    expect(store.deleteMemory(frontend.id, frontend.namespace)).toBeGreaterThan(0);
    memories = memories.filter((entry) => entry.id !== frontend.id);
    expect((await retriever.retrieve("violet navigation appearance", memories, settings)).memories.map((item) => item.id)).not.toContain("frontend");
  }, 120_000);

  it("builds a separate generation, validates coverage, cuts over, and rolls back", async () => {
    const previous = store.getActiveGeneration(workspaceNamespace(settings.workspaceRoot))!;
    const nextSettings: Settings = { ...settings, memoryEmbeddings: { ...settings.memoryEmbeddings!, preprocessingVersion: "memory-text-v2" } };
    const service = new ReembeddingService(indexer, store);
    const report = await service.build(memories, nextSettings, { rateLimitPerSecond: 100 });
    expect(report).toMatchObject({ failed: 0, activated: false });
    expect(report.generationId).not.toBe(previous.id);
    expect(service.validateCoverage(memories, nextSettings, report.generationId!).complete).toBe(true);
    service.cutover(memories, nextSettings, report.generationId!);
    expect(store.getActiveGeneration(workspaceNamespace(settings.workspaceRoot))!.id).toBe(report.generationId);
    const rolledBack = service.rollback(nextSettings);
    expect(rolledBack.activeGenerationId).toBe(previous.id);
    expect(() => store.deleteGeneration(report.generationId!)).toThrow(/rollback target/);
    store.deleteGeneration(report.generationId!, true);
    expect(store.getGeneration(report.generationId!)).toBeNull();
  }, 120_000);

  it("runs semantic retrieval in shadow without changing lexical selection and supports semantic-only diagnostics", async () => {
    const shadow: Settings = { ...settings, memoryRetrieval: { ...settings.memoryRetrieval!, mode: "shadow_semantic" } };
    const shadowQuery = "Guarantee restoration capability following irreversible actions.";
    const shadowResult = await retriever.retrieve(shadowQuery, memories, shadow);
    expect(shadowResult.diagnostics.semanticCandidateCount).toBeGreaterThan(0);
    expect(shadowResult.diagnostics.shadowComparison?.lexicalRanking).toEqual(shadowResult.memories.map((item) => item.id));
    expect(shadowResult.diagnostics.shadowComparison?.semanticRanking).toContain("recovery");
    expect(shadowResult.diagnostics.shadowComparison?.overlapAtK).toBeGreaterThanOrEqual(0);
    expect(shadowResult.memories.map((item) => item.id)).not.toContain("recovery");
    expect(shadowResult.memories.map((item) => item.id)).toContain("pinned");
    const observer = new Database(store.databasePath, { readonly: true });
    const observation = observer.prepare("SELECT shadow_lexical_ranking, shadow_semantic_ranking, shadow_overlap_at_k FROM retrieval_events WHERE mode = 'shadow_semantic' ORDER BY id DESC LIMIT 1").get() as { shadow_lexical_ranking: string; shadow_semantic_ranking: string; shadow_overlap_at_k: number };
    observer.close();
    expect(JSON.parse(observation.shadow_lexical_ranking)).toEqual(shadowResult.diagnostics.shadowComparison?.lexicalRanking);
    expect(JSON.parse(observation.shadow_semantic_ranking)).toEqual(shadowResult.diagnostics.shadowComparison?.semanticRanking);
    expect(observation.shadow_overlap_at_k).toBe(shadowResult.diagnostics.shadowComparison?.overlapAtK);

    const semanticOnly: Settings = { ...settings, memoryRetrieval: { ...settings.memoryRetrieval!, mode: "semantic_only" } };
    const semanticResult = await retriever.retrieve(shadowQuery, memories, semanticOnly);
    expect(semanticResult.memories.map((item) => item.id)).toContain("recovery");
  }, 120_000);

  it("resumes an idempotent backfill from a durable checkpoint", async () => {
    const resumeSettings = settingsFixture(path.join(directory, "resume-workspace"));
    const namespace = workspaceNamespace(resumeSettings.workspaceRoot);
    const resumeMemories = [
      memory("resume-a", namespace, "First resumable memory", "Preserve the first completed batch before a restart."),
      memory("resume-b", namespace, "Second resumable memory", "Continue from the durable cursor without duplicating vectors.")
    ];
    const first = await indexer.indexMemory(resumeMemories[0], resumeSettings);
    store.saveBackfillCheckpoint({ jobId: "resume-job", namespace, generationId: first.generation.id, cursor: "resume-a", processed: 1, succeeded: 1, skipped: 0, failed: 0, status: "running", updatedAt: new Date().toISOString() });
    const report = await indexer.backfill(resumeMemories, resumeSettings, { jobId: "resume-job" });
    expect(report).toMatchObject({ processed: 2, succeeded: 2, failed: 0, remaining: 0, activated: true });
    expect(store.search(first.generation.id, namespace, (await createQueryVector(resumeSettings, "durable restart cursor")), 10).map((item) => item.memoryId).sort()).toEqual(["resume-a", "resume-b"]);
  }, 120_000);

  it("does not activate a filtered partial generation as complete", async () => {
    const filteredSettings = settingsFixture(path.join(directory, "filtered-workspace"));
    const namespace = workspaceNamespace(filteredSettings.workspaceRoot);
    const filteredMemories = [
      memory("filtered-context", namespace, "Context memory", "This context entry is indexed."),
      { ...memory("filtered-retro", namespace, "Retrospective memory", "This retrospective remains unindexed."), kind: "retrospective" as const }
    ];
    const report = await indexer.backfill(filteredMemories, filteredSettings, { kind: "context" });
    expect(report).toMatchObject({ succeeded: 1, failed: 0, activated: false });
    expect(store.getActiveGeneration(namespace)).toBeNull();
  }, 120_000);
});

function settingsFixture(workspaceRoot: string): Settings {
  return {
    workspaceRoot, layout: "chat", maxIterations: 1, maxParallelExecutors: 1, criticThreshold: 7, approvalMode: false,
    shellPath: "shell", testCommand: "", lintCommand: "", mcpAutoDiscovery: false, mcpPortStart: 3000, mcpPortEnd: 3001,
    memoryTokenBudget: 700,
    memoryRetrieval: { ...defaultMemoryRetrievalSettings, mode: "hybrid", minimumSemanticScore: 0.12 },
    memoryEmbeddings: { ...defaultMemoryEmbeddingSettings, allowModelDownload: true, timeoutMs: 120_000 },
    agentModels: {}
  };
}

function memory(id: string, namespace: string, title: string, content: string): MemoryEntry {
  const now = "2026-07-11T00:00:00.000Z";
  const entry: MemoryEntry = { id, namespace, kind: "context", taskType: "operations", title, content, pinned: false, source: "operator", importance: 0.5, createdAt: now, updatedAt: now };
  entry.contentHash = memoryContentHash(entry);
  return entry;
}

async function createQueryVector(settings: Settings, text: string): Promise<Float32Array> {
  const { createEmbeddingProvider } = await import("../server/memory/providers");
  const provider = createEmbeddingProvider(settings.memoryEmbeddings!, { modelCacheDirectory: path.resolve(".nexusharness/embedding-models") });
  return (await provider.embed(text)).vectors[0];
}

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { defaultMemoryEmbeddingSettings, defaultMemoryRetrievalSettings } from "../server/memory/config";
import { chunkMemory, countPromptTokens, memoryContentHash, normalizeMemoryContent, truncateToPromptTokens, workspaceNamespace } from "../server/memory/preprocessing";
import { validateProviderConfiguration, semanticScoreFromDistance } from "../server/memory/providers";
import { HybridRanker, TokenBudgetAllocator } from "../server/memory/ranking";
import { MemoryRetriever } from "../server/memory/retriever";
import { SqliteVectorStore } from "../server/memory/vectorStore";
import type { MemoryEntry, Settings } from "../server/types";
import { mergeStore } from "../server/store";

const temporaryDirectories: string[] = [];
afterEach(async () => { await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 }))); });

describe("memory preprocessing", () => {
  it("migrates a legacy JSON memory without deleting old fields", () => {
    const legacy = memory("legacy", "Legacy lesson", "Preserve this existing memory.");
    const merged = mergeStore({
      settings: settingsFixture("D:/legacy-workspace", "lexical_only"),
      memory: [{ id: legacy.id, kind: legacy.kind, taskType: legacy.taskType, title: legacy.title, content: legacy.content, pinned: legacy.pinned, source: legacy.source, createdAt: legacy.createdAt, updatedAt: legacy.updatedAt }],
      runtimes: [], mcpServers: [], audit: [], approvals: [], runs: []
    });
    expect(merged.memory[0]).toMatchObject({ id: "legacy", content: legacy.content, namespace: workspaceNamespace("D:/legacy-workspace"), importance: 0.5, indexing: { status: "pending" } });
    expect(merged.memory[0].contentHash).toMatch(/^[a-f0-9]{64}$/);
    expect(merged.settings.memoryRetrieval?.mode).toBe("lexical_only");
  });

  it("normalizes Unicode/newlines, hashes stable indexed text, and produces overlapping unique chunks", () => {
    const entry = memory("m1", "Ａ title", "First line\r\n\r\n\r\n\r\nSecond line with code() and recovery guidance.");
    expect(normalizeMemoryContent(entry.content)).toBe("First line\n\n\nSecond line with code() and recovery guidance.");
    expect(memoryContentHash(entry)).toBe(memoryContentHash({ ...entry }));
    expect(memoryContentHash(entry)).not.toBe(memoryContentHash({ ...entry, content: `${entry.content}!` }));
    const chunks = chunkMemory(entry, "workspace:test", "v1", 20, 4);
    expect(chunks.length).toBeGreaterThan(1);
    expect(new Set(chunks.map((chunk) => chunk.chunkHash)).size).toBe(chunks.length);
    expect(chunks.every((chunk) => chunk.tokenCount <= 20 && chunk.chunkCount === chunks.length)).toBe(true);
  });

  it("uses a tokenizer for deterministic truncation and stays inside the exact prompt budget", () => {
    const result = truncateToPromptTokens("database recovery ".repeat(100), 40);
    expect(result.truncated).toBe(true);
    expect(countPromptTokens(result.text)).toBeLessThanOrEqual(40);
  });

  it("derives stable non-reversible workspace namespaces", () => {
    expect(workspaceNamespace("D:/project")).toMatch(/^workspace:[a-f0-9]{32}$/);
    expect(workspaceNamespace("D:/project")).toBe(workspaceNamespace("D:/project"));
    expect(workspaceNamespace("D:/project")).not.toBe(workspaceNamespace("D:/other"));
  });
});

describe("embedding configuration and similarity", () => {
  it("blocks unapproved remote transmission and missing remote credentials", () => {
    expect(() => validateProviderConfiguration({ ...defaultMemoryEmbeddingSettings, provider: "ollama", endpoint: "https://embeddings.example.test" })).toThrow(/transmission is disabled/);
    expect(() => validateProviderConfiguration({ ...defaultMemoryEmbeddingSettings, provider: "openai-compatible", endpoint: "https://embeddings.example.test", allowRemoteContent: true }, {})).toThrow(/require NEXUSHARNESS_EMBEDDING_API_KEY/);
    expect(() => validateProviderConfiguration({ ...defaultMemoryEmbeddingSettings, provider: "ollama", endpoint: "http://127.0.0.1:11434" })).not.toThrow();
  });

  it("interprets cosine distance in the correct similarity direction", () => {
    expect(semanticScoreFromDistance(0, "cosine")).toBe(1);
    expect(semanticScoreFromDistance(0.25, "cosine")).toBe(0.75);
    expect(semanticScoreFromDistance(1.5, "cosine")).toBe(0);
    expect(semanticScoreFromDistance(0, "l2")).toBe(1);
    expect(semanticScoreFromDistance(3, "l2")).toBe(0.25);
  });
});

describe("hybrid ranking and token allocation", () => {
  it("bounds component scores, keeps pins mandatory, deduplicates content, and reranks redundant results", () => {
    const settings = { ...defaultMemoryRetrievalSettings, diversityReranking: true, diversityLambda: 0.5 };
    const ranker = new HybridRanker(settings);
    const pinned = ranker.lexicalCandidate({ ...memory("pin", "Rules", "Always run validation."), pinned: true }, "database recovery");
    const first = ranker.withSemantic(ranker.lexicalCandidate(memory("a", "Database backup", "Create a snapshot before deletion."), "restore information after destructive changes"), 0.92, new Float32Array([1, 0]));
    const duplicate = ranker.withSemantic(ranker.lexicalCandidate(memory("b", "Database backup duplicate", "Create a snapshot before deletion."), "restore information after destructive changes"), 0.91, new Float32Array([0.99, 0.01]));
    const distinct = ranker.withSemantic(ranker.lexicalCandidate(memory("c", "Access policy", "Use least privilege for deployment credentials."), "restore information after destructive changes"), 0.7, new Float32Array([0, 1]));
    const ranked = ranker.mergeAndRank([first, duplicate, distinct, pinned]);
    expect(ranked[0].entry.id).toBe("pin");
    expect(ranked.filter((candidate) => candidate.entry.content === first.entry.content)).toHaveLength(1);
    expect(ranked.every((candidate) => candidate.score >= 0 && candidate.score <= 1)).toBe(true);
  });

  it("packs provenance deterministically without exceeding the configured token budget", () => {
    const ranker = new HybridRanker(defaultMemoryRetrievalSettings);
    const candidates = [
      ranker.lexicalCandidate({ ...memory("pin", "Pinned", "critical ".repeat(300)), pinned: true }, "unrelated"),
      ranker.lexicalCandidate(memory("other", "Related", "database recovery backup snapshot"), "database recovery")
    ];
    const allocated = new TokenBudgetAllocator().allocate(ranker.mergeAndRank(candidates), 80, 12, "always_include");
    expect(allocated.memories[0].id).toBe("pin");
    expect(allocated.truncatedMemoryIds).toContain("pin");
    expect(countPromptTokens(allocated.promptContext)).toBeLessThanOrEqual(80);
    expect(allocated.promptContext).toContain("untrusted reference data");
  });

  it("keeps mandatory pins within the configured final result limit", () => {
    const ranker = new HybridRanker(defaultMemoryRetrievalSettings);
    const pins = Array.from({ length: 5 }, (_, index) => ranker.lexicalCandidate({ ...memory(`pin-${index}`, `Pinned ${index}`, `Pinned policy ${index}`), pinned: true }, "unrelated"));
    const allocated = new TokenBudgetAllocator().allocate(ranker.mergeAndRank(pins), 1000, 3, "always_include");
    expect(allocated.memories).toHaveLength(3);
    expect(allocated.memories.every((entry) => entry.pinned)).toBe(true);
  });
});

describe("durable vector store safety", () => {
  it("migrates, persists, namespace-filters, validates dimensions, removes vectors, and rolls back schema", async () => {
    const directory = await temporaryDirectory();
    const store = new SqliteVectorStore(path.join(directory, "vectors.sqlite"));
    await store.initialize();
    const generation = { id: "a".repeat(64), provider: "transformers-local" as const, model: "unit", modelRevision: "1", dimension: 3, similarityMetric: "cosine" as const, preprocessingVersion: "v1", configurationJson: "{}" };
    store.ensureGeneration(generation);
    const now = new Date().toISOString();
    store.upsertMemory(generation.id, [record("m1", "workspace:a", new Float32Array([1, 0, 0]), now)]);
    store.upsertMemory(generation.id, [record("m2", "workspace:b", new Float32Array([1, 0, 0]), now)]);
    store.activateGeneration("workspace:a", generation.id);
    expect(store.search(generation.id, "workspace:a", new Float32Array([1, 0, 0]), 10).map((item) => item.memoryId)).toEqual(["m1"]);
    expect(() => store.search(generation.id, "workspace:a", new Float32Array([1, 0]), 10)).toThrow(/dimension/);
    expect(store.deleteMemory("m1", "workspace:a")).toBe(1);
    expect(store.search(generation.id, "workspace:a", new Float32Array([1, 0, 0]), 10)).toEqual([]);
    expect(store.health()).toMatchObject({ ok: true, schemaVersion: 3, extensionVersion: "v0.1.9" });
    store.rollbackMigrations(0);
    expect(store.schemaVersion()).toBe(0);
    store.close();
  });

  it("atomically batch-upserts more than one memory", async () => {
    const directory = await temporaryDirectory();
    const store = new SqliteVectorStore(path.join(directory, "vectors.sqlite"));
    await store.initialize();
    const generation = { id: "b".repeat(64), provider: "transformers-local" as const, model: "unit", modelRevision: "1", dimension: 3, similarityMetric: "cosine" as const, preprocessingVersion: "v1", configurationJson: "{}" };
    store.ensureGeneration(generation);
    const now = new Date().toISOString();
    store.upsertMemories(generation.id, [
      [record("batch-a", "workspace:a", new Float32Array([1, 0, 0]), now)],
      [record("batch-b", "workspace:a", new Float32Array([0, 1, 0]), now)]
    ]);
    expect(store.search(generation.id, "workspace:a", new Float32Array([1, 0, 0]), 2).map((item) => item.memoryId)).toEqual(["batch-a", "batch-b"]);
    expect(() => store.upsertMemories(generation.id, [
      [record("rollback-a", "workspace:a", new Float32Array([1, 0, 0]), now)],
      [record("rollback-b", "workspace:a", new Float32Array([1, 0]), now)]
    ])).toThrow(/dimension/);
    expect(store.getMemoryIndex(generation.id, "rollback-a")).toBeNull();
    store.close();
  });

  it("labels vector-store outage fallback without pretending semantic retrieval ran", async () => {
    const settings = settingsFixture("D:/project", "hybrid");
    const entry = { ...memory("m1", "Database recovery", "Create a backup before deletion."), namespace: workspaceNamespace(settings.workspaceRoot), pinned: true };
    const result = await new MemoryRetriever(null, { modelCacheDirectory: "." }).retrieve("restore deleted information", [entry], settings);
    expect(result.diagnostics).toMatchObject({ mode: "hybrid", status: "degraded", fallbackActivated: true, fallbackReason: "vector_store_unavailable", semanticCandidateCount: 0 });
    expect(result.memories.map((item) => item.id)).toContain("m1");
  });
});

function memory(id: string, title: string, content: string): MemoryEntry {
  const at = "2026-07-11T00:00:00.000Z";
  return { id, kind: "context", taskType: "infrastructure", title, content, pinned: false, source: "operator", importance: 0.5, createdAt: at, updatedAt: at };
}

function record(memoryId: string, namespace: string, vector: Float32Array, at: string) {
  return { memoryId, namespace, kind: "context", taskType: "test", pinned: false, importance: 0.5, createdAt: at, updatedAt: at, contentHash: `hash-${memoryId}`, chunkIndex: 0, chunkCount: 1, tokenCount: 5, vector };
}

function settingsFixture(workspaceRoot: string, mode: NonNullable<Settings["memoryRetrieval"]>["mode"]): Settings {
  return {
    workspaceRoot, layout: "chat", maxIterations: 1, maxParallelExecutors: 1, criticThreshold: 7, approvalMode: true,
    shellPath: "shell", testCommand: "", lintCommand: "", mcpAutoDiscovery: false, mcpPortStart: 3000, mcpPortEnd: 3001,
    memoryTokenBudget: 500, memoryRetrieval: { ...defaultMemoryRetrievalSettings, mode }, memoryEmbeddings: { ...defaultMemoryEmbeddingSettings }, agentModels: {}
  };
}

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), "nexus-memory-unit-"));
  temporaryDirectories.push(directory);
  return directory;
}

import { mkdir } from "node:fs/promises";
import path from "node:path";
import Database from "better-sqlite3";
import * as sqliteVec from "sqlite-vec";
import type { RetrievalDiagnostics, VectorGenerationDescriptor, VectorRecord, VectorSearchResult } from "./types.js";
import { semanticScoreFromDistance } from "./providers.js";

const CURRENT_SCHEMA_VERSION = 3;

export interface VectorSearchFilters {
  kind?: string;
  taskType?: string;
  pinned?: boolean;
}

export interface GenerationRecord extends VectorGenerationDescriptor {
  status: "building" | "active" | "retired" | "failed";
  createdAt: string;
  activatedAt: string | null;
}

export interface VectorStoreHealth {
  ok: boolean;
  databasePath: string;
  schemaVersion: number;
  extensionVersion?: string;
  integrity?: string;
  errorCode?: string;
}

export interface MemoryIndexRecord {
  generationId: string;
  memoryId: string;
  namespace: string;
  contentHash: string;
  chunkCount: number;
  status: "pending" | "indexing" | "indexed" | "stale" | "failed";
  errorCode: string | null;
  embeddedAt: string | null;
  updatedAt: string;
}

export interface BackfillCheckpoint {
  jobId: string;
  namespace: string;
  generationId: string;
  cursor: string;
  processed: number;
  succeeded: number;
  skipped: number;
  failed: number;
  status: "running" | "completed" | "failed";
  updatedAt: string;
}

export class SqliteVectorStore {
  private database?: Database.Database;

  constructor(readonly databasePath: string) {}

  async initialize(): Promise<void> {
    await mkdir(path.dirname(this.databasePath), { recursive: true });
    if (this.database) return;
    const database = new Database(this.databasePath);
    database.pragma("journal_mode = WAL");
    database.pragma("synchronous = FULL");
    database.pragma("foreign_keys = ON");
    database.pragma("busy_timeout = 5000");
    database.defaultSafeIntegers(true);
    sqliteVec.load(database);
    this.database = database;
    this.migrate();
  }

  close(): void {
    this.database?.close();
    this.database = undefined;
  }

  schemaVersion(): number {
    return Number(this.db().pragma("user_version", { simple: true }));
  }

  migrate(targetVersion = CURRENT_SCHEMA_VERSION): void {
    const database = this.db();
    let version = this.schemaVersion();
    if (version > CURRENT_SCHEMA_VERSION) throw new Error(`Memory vector database schema ${version} is newer than supported schema ${CURRENT_SCHEMA_VERSION}.`);
    if (targetVersion < version || targetVersion > CURRENT_SCHEMA_VERSION) throw new Error(`Invalid vector migration target ${targetVersion} from ${version}.`);
    while (version < targetVersion) {
      const next = version + 1;
      database.transaction(() => {
        if (next === 1) migrationOne(database);
        if (next === 2) migrationTwo(database);
        if (next === 3) migrationThree(database);
        database.pragma(`user_version = ${next}`);
        database.prepare("INSERT INTO schema_migrations(version, applied_at) VALUES(?, ?)").run(BigInt(next), new Date().toISOString());
      })();
      version = next;
    }
  }

  rollbackMigrations(targetVersion: number): void {
    const database = this.db();
    let version = this.schemaVersion();
    if (targetVersion < 0 || targetVersion > version) throw new Error(`Invalid vector rollback target ${targetVersion} from ${version}.`);
    while (version > targetVersion) {
      database.transaction(() => {
        if (version === 2) rollbackTwo(database);
        if (version === 3) rollbackThree(database);
        if (version === 1) rollbackOne(database);
        database.pragma(`user_version = ${version - 1}`);
      })();
      version -= 1;
    }
  }

  ensureGeneration(descriptor: VectorGenerationDescriptor): GenerationRecord {
    validateGenerationDescriptor(descriptor);
    const database = this.db();
    const existing = this.getGeneration(descriptor.id);
    if (existing) {
      assertGenerationCompatible(existing, descriptor);
      return existing;
    }
    const now = new Date().toISOString();
    database.transaction(() => {
      database.prepare(`
        INSERT INTO embedding_generations(
          id, provider, model, model_revision, dimension, similarity_metric,
          preprocessing_version, configuration_json, status, created_at
        ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, 'building', ?)
      `).run(
        descriptor.id, descriptor.provider, descriptor.model, descriptor.modelRevision,
        BigInt(descriptor.dimension), descriptor.similarityMetric, descriptor.preprocessingVersion,
        descriptor.configurationJson, now
      );
      database.exec(createVectorTableSql(descriptor));
    })();
    return this.getGeneration(descriptor.id)!;
  }

  getGeneration(id: string): GenerationRecord | null {
    const row = this.db().prepare("SELECT * FROM embedding_generations WHERE id = ?").get(id) as GenerationRow | undefined;
    return row ? generationFromRow(row) : null;
  }

  listGenerations(): GenerationRecord[] {
    return (this.db().prepare("SELECT * FROM embedding_generations ORDER BY created_at DESC").all() as GenerationRow[]).map(generationFromRow);
  }

  getActiveGeneration(namespace: string): GenerationRecord | null {
    const row = this.db().prepare(`
      SELECT g.* FROM namespace_generations n
      JOIN embedding_generations g ON g.id = n.active_generation_id
      WHERE n.namespace = ?
    `).get(namespace) as GenerationRow | undefined;
    return row ? generationFromRow(row) : null;
  }

  activateGeneration(namespace: string, generationId: string): { activeGenerationId: string; previousGenerationId: string | null } {
    const generation = this.getGeneration(generationId);
    if (!generation) throw new Error(`Unknown embedding generation: ${generationId}.`);
    const now = new Date().toISOString();
    return this.db().transaction(() => {
      const current = this.db().prepare("SELECT active_generation_id FROM namespace_generations WHERE namespace = ?").get(namespace) as { active_generation_id: string } | undefined;
      const previous = current?.active_generation_id ?? null;
      this.db().prepare(`
        INSERT INTO namespace_generations(namespace, active_generation_id, previous_generation_id, updated_at)
        VALUES(?, ?, ?, ?)
        ON CONFLICT(namespace) DO UPDATE SET
          previous_generation_id = namespace_generations.active_generation_id,
          active_generation_id = excluded.active_generation_id,
          updated_at = excluded.updated_at
      `).run(namespace, generationId, previous, now);
      this.db().prepare("UPDATE embedding_generations SET status = 'active', activated_at = ? WHERE id = ?").run(now, generationId);
      if (previous && previous !== generationId) this.db().prepare("UPDATE embedding_generations SET status = 'retired' WHERE id = ? AND status = 'active'").run(previous);
      return { activeGenerationId: generationId, previousGenerationId: previous };
    })();
  }

  rollbackGeneration(namespace: string): { activeGenerationId: string; previousGenerationId: string | null } {
    return this.db().transaction(() => {
      const state = this.db().prepare("SELECT active_generation_id, previous_generation_id FROM namespace_generations WHERE namespace = ?").get(namespace) as { active_generation_id: string; previous_generation_id: string | null } | undefined;
      if (!state?.previous_generation_id) throw new Error(`Namespace ${namespace} has no previous embedding generation to restore.`);
      const now = new Date().toISOString();
      this.db().prepare("UPDATE namespace_generations SET active_generation_id = ?, previous_generation_id = ?, updated_at = ? WHERE namespace = ?")
        .run(state.previous_generation_id, state.active_generation_id, now, namespace);
      this.db().prepare("UPDATE embedding_generations SET status = 'active', activated_at = ? WHERE id = ?").run(now, state.previous_generation_id);
      this.db().prepare("UPDATE embedding_generations SET status = 'retired' WHERE id = ?").run(state.active_generation_id);
      return { activeGenerationId: state.previous_generation_id, previousGenerationId: state.active_generation_id };
    })();
  }

  deleteGeneration(generationId: string, removeRollbackReference = false): void {
    const generation = this.getGeneration(generationId);
    if (!generation) throw new Error(`Unknown embedding generation: ${generationId}.`);
    const active = this.db().prepare("SELECT namespace FROM namespace_generations WHERE active_generation_id = ? LIMIT 1").get(generationId) as { namespace: string } | undefined;
    if (active) throw new Error(`Cannot remove active embedding generation ${generationId} for ${active.namespace}.`);
    const previous = this.db().prepare("SELECT namespace FROM namespace_generations WHERE previous_generation_id = ? LIMIT 1").get(generationId) as { namespace: string } | undefined;
    if (previous && !removeRollbackReference) throw new Error(`Generation ${generationId} is the rollback target for ${previous.namespace}; pass explicit rollback-reference removal only after acceptance.`);
    this.db().transaction(() => {
      if (previous) this.db().prepare("UPDATE namespace_generations SET previous_generation_id = NULL, updated_at = ? WHERE previous_generation_id = ?").run(new Date().toISOString(), generationId);
      this.db().exec(`DROP TABLE ${generationTable(generationId)}`);
      this.db().prepare("DELETE FROM backfill_checkpoints WHERE generation_id = ?").run(generationId);
      this.db().prepare("DELETE FROM embedding_generations WHERE id = ?").run(generationId);
    })();
  }

  markMemoryIndex(record: MemoryIndexRecord): void {
    this.db().prepare(`
      INSERT INTO memory_index(generation_id, memory_id, namespace, content_hash, chunk_count, status, error_code, embedded_at, updated_at)
      VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(generation_id, memory_id) DO UPDATE SET
        namespace = excluded.namespace,
        content_hash = excluded.content_hash,
        chunk_count = excluded.chunk_count,
        status = excluded.status,
        error_code = excluded.error_code,
        embedded_at = excluded.embedded_at,
        updated_at = excluded.updated_at
    `).run(record.generationId, record.memoryId, record.namespace, record.contentHash, BigInt(record.chunkCount), record.status, record.errorCode, record.embeddedAt, record.updatedAt);
  }

  getMemoryIndex(generationId: string, memoryId: string): MemoryIndexRecord | null {
    const row = this.db().prepare("SELECT * FROM memory_index WHERE generation_id = ? AND memory_id = ?").get(generationId, memoryId) as MemoryIndexRow | undefined;
    return row ? memoryIndexFromRow(row) : null;
  }

  listMemoryIndex(namespace: string, generationId: string, afterMemoryId = "", limit = 100): MemoryIndexRecord[] {
    return (this.db().prepare(`
      SELECT * FROM memory_index
      WHERE namespace = ? AND generation_id = ? AND memory_id > ?
      ORDER BY memory_id LIMIT ?
    `).all(namespace, generationId, afterMemoryId, BigInt(limit)) as MemoryIndexRow[]).map(memoryIndexFromRow);
  }

  upsertMemory(generationId: string, records: readonly VectorRecord[]): void {
    this.upsertMemories(generationId, [records]);
  }

  upsertMemories(generationId: string, batches: readonly (readonly VectorRecord[])[]): void {
    if (!batches.length) throw new Error("Vector batch upsert requires at least one memory batch.");
    const generation = this.getGeneration(generationId);
    if (!generation) throw new Error(`Unknown embedding generation: ${generationId}.`);
    this.db().transaction(() => {
      for (const records of batches) this.upsertMemoryRows(generation, records);
    })();
  }

  private upsertMemoryRows(generation: GenerationRecord, records: readonly VectorRecord[]): void {
    if (!records.length) throw new Error("Vector upsert requires at least one chunk.");
    const generationId = generation.id;
    const first = records[0];
    if (records.some((record) => record.memoryId !== first.memoryId || record.namespace !== first.namespace || record.contentHash !== first.contentHash)) {
      throw new Error("A vector upsert batch must contain one memory, namespace, and content hash.");
    }
    for (const record of records) validateVector(record.vector, generation.dimension);
    const table = generationTable(generationId);
    this.deleteMemoryFromGeneration(generationId, first.memoryId);
    const mapInsert = this.db().prepare("INSERT INTO vector_rows(generation_id, memory_id, chunk_index) VALUES(?, ?, ?)");
    const vectorInsert = this.db().prepare(`
        INSERT INTO ${table}(row_id, embedding, namespace, memory_kind, task_type, pinned, memory_id, chunk_index, chunk_count)
        VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
    for (const record of records) {
      const result = mapInsert.run(generationId, record.memoryId, BigInt(record.chunkIndex));
      vectorInsert.run(
          result.lastInsertRowid,
          record.vector,
          record.namespace,
          record.kind,
          record.taskType || "__none__",
          BigInt(record.pinned ? 1 : 0),
          record.memoryId,
          BigInt(record.chunkIndex),
          BigInt(record.chunkCount)
      );
    }
    const now = new Date().toISOString();
    this.markMemoryIndex({
        generationId,
        memoryId: first.memoryId,
        namespace: first.namespace,
        contentHash: first.contentHash,
        chunkCount: records.length,
        status: "indexed",
        errorCode: null,
        embeddedAt: now,
        updatedAt: now
    });
  }

  deleteMemory(memoryId: string, namespace?: string): number {
    const generations = this.listGenerations();
    return this.db().transaction(() => {
      let removed = 0;
      for (const generation of generations) {
        const state = this.getMemoryIndex(generation.id, memoryId);
        if (!state || namespace && state.namespace !== namespace) continue;
        removed += this.deleteMemoryFromGeneration(generation.id, memoryId);
        this.db().prepare("DELETE FROM memory_index WHERE generation_id = ? AND memory_id = ?").run(generation.id, memoryId);
      }
      return removed;
    })();
  }

  markMemoryStale(memoryId: string, namespace: string): void {
    this.db().transaction(() => {
      this.db().prepare("UPDATE memory_index SET status = 'stale', updated_at = ? WHERE memory_id = ? AND namespace = ?")
        .run(new Date().toISOString(), memoryId, namespace);
      for (const generation of this.listGenerations()) this.deleteMemoryFromGeneration(generation.id, memoryId);
    })();
  }

  updateMemoryMetadata(memoryId: string, metadata: { pinned: boolean; kind: string; taskType: string }): number {
    return this.db().transaction(() => {
      let updated = 0;
      for (const generation of this.listGenerations()) {
        const rows = this.db().prepare("SELECT row_id FROM vector_rows WHERE generation_id = ? AND memory_id = ?").all(generation.id, memoryId) as Array<{ row_id: bigint }>;
        const statement = this.db().prepare(`UPDATE ${generationTable(generation.id)} SET pinned = ?, memory_kind = ?, task_type = ? WHERE row_id = ?`);
        for (const row of rows) updated += Number(statement.run(BigInt(metadata.pinned ? 1 : 0), metadata.kind, metadata.taskType || "__none__", row.row_id).changes);
      }
      return updated;
    })();
  }

  search(generationId: string, namespace: string, query: Float32Array, topK: number, filters: VectorSearchFilters = {}): VectorSearchResult[] {
    const generation = this.getGeneration(generationId);
    if (!generation) throw new Error(`Unknown embedding generation: ${generationId}.`);
    validateVector(query, generation.dimension);
    if (topK < 1 || topK > 500) throw new Error("Vector topK must be from 1 through 500.");
    const clauses = ["embedding MATCH ?", "k = ?", "namespace = ?"];
    const values: Array<string | bigint | Float32Array> = [query, BigInt(topK), namespace];
    if (filters.kind) { clauses.push("memory_kind = ?"); values.push(filters.kind); }
    if (filters.taskType) { clauses.push("task_type = ?"); values.push(filters.taskType); }
    if (filters.pinned !== undefined) { clauses.push("pinned = ?"); values.push(BigInt(filters.pinned ? 1 : 0)); }
    const table = generationTable(generationId);
    const rows = this.db().prepare(`
      SELECT memory_id, chunk_index, chunk_count, distance
      FROM ${table}
      WHERE ${clauses.join(" AND ")}
      ORDER BY distance ASC
    `).all(...values) as Array<{ memory_id: string; chunk_index: bigint; chunk_count: bigint; distance: number }>;
    return rows.map((row) => ({
      memoryId: row.memory_id,
      chunkIndex: Number(row.chunk_index),
      chunkCount: Number(row.chunk_count),
      distance: row.distance,
      semanticScore: semanticScoreFromDistance(row.distance, generation.similarityMetric)
    })).sort((left, right) => left.distance - right.distance || left.memoryId.localeCompare(right.memoryId) || left.chunkIndex - right.chunkIndex);
  }

  getMemoryVector(generationId: string, memoryId: string): Float32Array | null {
    const generation = this.getGeneration(generationId);
    if (!generation) return null;
    const mapping = this.db().prepare("SELECT row_id FROM vector_rows WHERE generation_id = ? AND memory_id = ? ORDER BY chunk_index LIMIT 1").get(generationId, memoryId) as { row_id: bigint } | undefined;
    if (!mapping) return null;
    const row = this.db().prepare(`SELECT embedding FROM ${generationTable(generationId)} WHERE row_id = ?`).get(mapping.row_id) as { embedding: Buffer } | undefined;
    if (!row) return null;
    const vector = bufferToFloat32(row.embedding);
    validateVector(vector, generation.dimension);
    return vector;
  }

  coverage(namespace: string, generationId: string, current: ReadonlyMap<string, string>): { total: number; indexed: number; stale: number; missing: number; complete: boolean } {
    let indexed = 0;
    let stale = 0;
    let missing = 0;
    for (const [memoryId, contentHash] of current) {
      const record = this.getMemoryIndex(generationId, memoryId);
      if (!record) { missing += 1; continue; }
      if (record.namespace !== namespace || record.status !== "indexed" || record.contentHash !== contentHash) stale += 1;
      else indexed += 1;
    }
    return { total: current.size, indexed, stale, missing, complete: indexed === current.size };
  }

  getCachedEmbedding(cacheKey: string, expectedDimension?: number): Float32Array | null {
    const row = this.db().prepare("SELECT vector, dimension, expires_at FROM embedding_cache WHERE cache_key = ?").get(cacheKey) as { vector: Buffer; dimension: bigint; expires_at: string } | undefined;
    if (!row) return null;
    if (Date.parse(row.expires_at) <= Date.now() || expectedDimension && Number(row.dimension) !== expectedDimension) {
      this.db().prepare("DELETE FROM embedding_cache WHERE cache_key = ?").run(cacheKey);
      return null;
    }
    const vector = bufferToFloat32(row.vector);
    try { validateVector(vector, Number(row.dimension)); }
    catch { this.db().prepare("DELETE FROM embedding_cache WHERE cache_key = ?").run(cacheKey); return null; }
    this.db().prepare("UPDATE embedding_cache SET last_accessed_at = ? WHERE cache_key = ?").run(new Date().toISOString(), cacheKey);
    return vector;
  }

  putCachedEmbedding(cacheKey: string, provider: string, model: string, revision: string, preprocessingVersion: string, contentHash: string, vector: Float32Array, ttlMs: number, maximumEntries: number): void {
    validateVector(vector, vector.length);
    const now = new Date();
    this.db().prepare(`
      INSERT INTO embedding_cache(cache_key, provider, model, model_revision, preprocessing_version, content_hash, dimension, vector, created_at, last_accessed_at, expires_at)
      VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(cache_key) DO UPDATE SET
        dimension = excluded.dimension, vector = excluded.vector,
        last_accessed_at = excluded.last_accessed_at, expires_at = excluded.expires_at
    `).run(cacheKey, provider, model, revision, preprocessingVersion, contentHash, BigInt(vector.length), Buffer.from(vector.buffer, vector.byteOffset, vector.byteLength), now.toISOString(), now.toISOString(), new Date(now.getTime() + ttlMs).toISOString());
    this.pruneCache(maximumEntries);
  }

  pruneCache(maximumEntries: number): number {
    const expired = this.db().prepare("DELETE FROM embedding_cache WHERE expires_at <= ?").run(new Date().toISOString()).changes;
    const count = Number((this.db().prepare("SELECT COUNT(*) count FROM embedding_cache").get() as { count: bigint }).count);
    if (count <= maximumEntries) return Number(expired);
    const extra = count - maximumEntries;
    const removed = this.db().prepare("DELETE FROM embedding_cache WHERE cache_key IN (SELECT cache_key FROM embedding_cache ORDER BY last_accessed_at ASC LIMIT ?)").run(BigInt(extra)).changes;
    return Number(expired + removed);
  }

  saveBackfillCheckpoint(checkpoint: BackfillCheckpoint): void {
    this.db().prepare(`
      INSERT INTO backfill_checkpoints(job_id, namespace, generation_id, cursor, processed, succeeded, skipped, failed, status, updated_at)
      VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(job_id) DO UPDATE SET cursor=excluded.cursor, processed=excluded.processed, succeeded=excluded.succeeded,
        skipped=excluded.skipped, failed=excluded.failed, status=excluded.status, updated_at=excluded.updated_at
    `).run(checkpoint.jobId, checkpoint.namespace, checkpoint.generationId, checkpoint.cursor, BigInt(checkpoint.processed), BigInt(checkpoint.succeeded), BigInt(checkpoint.skipped), BigInt(checkpoint.failed), checkpoint.status, checkpoint.updatedAt);
  }

  getBackfillCheckpoint(jobId: string): BackfillCheckpoint | null {
    const row = this.db().prepare("SELECT * FROM backfill_checkpoints WHERE job_id = ?").get(jobId) as BackfillRow | undefined;
    return row ? {
      jobId: row.job_id, namespace: row.namespace, generationId: row.generation_id, cursor: row.cursor,
      processed: Number(row.processed), succeeded: Number(row.succeeded), skipped: Number(row.skipped), failed: Number(row.failed),
      status: row.status, updatedAt: row.updated_at
    } : null;
  }

  recordRetrieval(namespace: string, diagnostics: RetrievalDiagnostics): void {
    this.db().prepare(`
      INSERT INTO retrieval_events(at, namespace, mode, status, fallback, active_generation_id, semantic_candidates,
        lexical_candidates, merged_candidates, selected_memories, selected_tokens, duration_ms, vector_duration_ms,
        score_min, score_max, score_average, shadow_lexical_ranking, shadow_semantic_ranking, shadow_overlap_at_k)
      VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      new Date().toISOString(), namespace, diagnostics.mode, diagnostics.status, BigInt(diagnostics.fallbackActivated ? 1 : 0),
      diagnostics.activeGenerationId ?? null, BigInt(diagnostics.semanticCandidateCount), BigInt(diagnostics.lexicalCandidateCount),
      BigInt(diagnostics.mergedCandidateCount), BigInt(diagnostics.selectedMemoryCount), BigInt(diagnostics.selectedTokenCount),
      diagnostics.queryDurationMs, diagnostics.vectorQueryDurationMs, diagnostics.scoreDistribution?.minimum ?? null,
      diagnostics.scoreDistribution?.maximum ?? null, diagnostics.scoreDistribution?.average ?? null,
      diagnostics.shadowComparison ? JSON.stringify(diagnostics.shadowComparison.lexicalRanking) : null,
      diagnostics.shadowComparison ? JSON.stringify(diagnostics.shadowComparison.semanticRanking) : null,
      diagnostics.shadowComparison?.overlapAtK ?? null
    );
    this.db().prepare("DELETE FROM retrieval_events WHERE id NOT IN (SELECT id FROM retrieval_events ORDER BY id DESC LIMIT 10000)").run();
  }

  diagnostics(namespace: string): { indexedMemories: number; staleMemories: number; failedMemories: number; cachedEmbeddings: number; activeGeneration: GenerationRecord | null; databaseBytes: number } {
    const counts = this.db().prepare(`
      SELECT
        SUM(CASE WHEN status='indexed' THEN 1 ELSE 0 END) indexed_count,
        SUM(CASE WHEN status IN ('stale','pending','indexing') THEN 1 ELSE 0 END) stale_count,
        SUM(CASE WHEN status='failed' THEN 1 ELSE 0 END) failed_count
      FROM memory_index WHERE namespace = ?
    `).get(namespace) as { indexed_count: bigint | null; stale_count: bigint | null; failed_count: bigint | null };
    const cached = this.db().prepare("SELECT COUNT(*) count FROM embedding_cache").get() as { count: bigint };
    const pageCount = Number(this.db().pragma("page_count", { simple: true }));
    const pageSize = Number(this.db().pragma("page_size", { simple: true }));
    return {
      indexedMemories: Number(counts.indexed_count ?? 0),
      staleMemories: Number(counts.stale_count ?? 0),
      failedMemories: Number(counts.failed_count ?? 0),
      cachedEmbeddings: Number(cached.count),
      activeGeneration: this.getActiveGeneration(namespace),
      databaseBytes: pageCount * pageSize
    };
  }

  health(): VectorStoreHealth {
    try {
      const extension = this.db().prepare("SELECT vec_version() version").get() as { version: string };
      const integrity = String(this.db().pragma("quick_check", { simple: true }));
      return { ok: integrity === "ok", databasePath: this.databasePath, schemaVersion: this.schemaVersion(), extensionVersion: extension.version, integrity };
    } catch {
      return { ok: false, databasePath: this.databasePath, schemaVersion: 0, errorCode: "vector_store_unavailable" };
    }
  }

  private deleteMemoryFromGeneration(generationId: string, memoryId: string): number {
    const table = generationTable(generationId);
    const rows = this.db().prepare("SELECT row_id FROM vector_rows WHERE generation_id = ? AND memory_id = ?").all(generationId, memoryId) as Array<{ row_id: bigint }>;
    const removeVector = this.db().prepare(`DELETE FROM ${table} WHERE row_id = ?`);
    for (const row of rows) removeVector.run(row.row_id);
    this.db().prepare("DELETE FROM vector_rows WHERE generation_id = ? AND memory_id = ?").run(generationId, memoryId);
    return rows.length;
  }

  private db(): Database.Database {
    if (!this.database) throw new Error("Vector store has not been initialized.");
    return this.database;
  }
}

function migrationOne(database: Database.Database): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations(
      version INTEGER PRIMARY KEY,
      applied_at TEXT NOT NULL
    );
    CREATE TABLE embedding_generations(
      id TEXT PRIMARY KEY,
      provider TEXT NOT NULL,
      model TEXT NOT NULL,
      model_revision TEXT NOT NULL,
      dimension INTEGER NOT NULL CHECK(dimension > 0),
      similarity_metric TEXT NOT NULL CHECK(similarity_metric IN ('cosine','l2')),
      preprocessing_version TEXT NOT NULL,
      configuration_json TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('building','active','retired','failed')),
      created_at TEXT NOT NULL,
      activated_at TEXT
    );
    CREATE TABLE namespace_generations(
      namespace TEXT PRIMARY KEY,
      active_generation_id TEXT NOT NULL REFERENCES embedding_generations(id),
      previous_generation_id TEXT REFERENCES embedding_generations(id),
      updated_at TEXT NOT NULL
    );
    CREATE TABLE memory_index(
      generation_id TEXT NOT NULL REFERENCES embedding_generations(id) ON DELETE CASCADE,
      memory_id TEXT NOT NULL,
      namespace TEXT NOT NULL,
      content_hash TEXT NOT NULL,
      chunk_count INTEGER NOT NULL CHECK(chunk_count >= 0),
      status TEXT NOT NULL CHECK(status IN ('pending','indexing','indexed','stale','failed')),
      error_code TEXT,
      embedded_at TEXT,
      updated_at TEXT NOT NULL,
      PRIMARY KEY(generation_id, memory_id)
    );
    CREATE INDEX memory_index_namespace_status ON memory_index(namespace, status, generation_id);
    CREATE TABLE vector_rows(
      row_id INTEGER PRIMARY KEY AUTOINCREMENT,
      generation_id TEXT NOT NULL REFERENCES embedding_generations(id) ON DELETE CASCADE,
      memory_id TEXT NOT NULL,
      chunk_index INTEGER NOT NULL,
      UNIQUE(generation_id, memory_id, chunk_index)
    );
    CREATE TABLE embedding_cache(
      cache_key TEXT PRIMARY KEY,
      provider TEXT NOT NULL,
      model TEXT NOT NULL,
      model_revision TEXT NOT NULL,
      preprocessing_version TEXT NOT NULL,
      content_hash TEXT NOT NULL,
      dimension INTEGER NOT NULL CHECK(dimension > 0),
      vector BLOB NOT NULL,
      created_at TEXT NOT NULL,
      last_accessed_at TEXT NOT NULL,
      expires_at TEXT NOT NULL
    );
    CREATE INDEX embedding_cache_expiry ON embedding_cache(expires_at, last_accessed_at);
    CREATE TABLE backfill_checkpoints(
      job_id TEXT PRIMARY KEY,
      namespace TEXT NOT NULL,
      generation_id TEXT NOT NULL REFERENCES embedding_generations(id),
      cursor TEXT NOT NULL,
      processed INTEGER NOT NULL,
      succeeded INTEGER NOT NULL,
      skipped INTEGER NOT NULL,
      failed INTEGER NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('running','completed','failed')),
      updated_at TEXT NOT NULL
    );
  `);
}

function migrationTwo(database: Database.Database): void {
  database.exec(`
    CREATE TABLE retrieval_events(
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      at TEXT NOT NULL,
      namespace TEXT NOT NULL,
      mode TEXT NOT NULL,
      status TEXT NOT NULL,
      fallback INTEGER NOT NULL,
      active_generation_id TEXT,
      semantic_candidates INTEGER NOT NULL,
      lexical_candidates INTEGER NOT NULL,
      merged_candidates INTEGER NOT NULL,
      selected_memories INTEGER NOT NULL,
      selected_tokens INTEGER NOT NULL,
      duration_ms REAL NOT NULL,
      vector_duration_ms REAL NOT NULL,
      score_min REAL,
      score_max REAL,
      score_average REAL
    );
    CREATE INDEX retrieval_events_namespace_at ON retrieval_events(namespace, at DESC);
  `);
}

function rollbackTwo(database: Database.Database): void {
  database.exec("DROP TABLE IF EXISTS retrieval_events;");
  database.prepare("DELETE FROM schema_migrations WHERE version = 2").run();
}

function migrationThree(database: Database.Database): void {
  database.exec(`
    ALTER TABLE retrieval_events ADD COLUMN shadow_lexical_ranking TEXT;
    ALTER TABLE retrieval_events ADD COLUMN shadow_semantic_ranking TEXT;
    ALTER TABLE retrieval_events ADD COLUMN shadow_overlap_at_k REAL;
  `);
}

function rollbackThree(database: Database.Database): void {
  database.exec(`
    ALTER TABLE retrieval_events DROP COLUMN shadow_overlap_at_k;
    ALTER TABLE retrieval_events DROP COLUMN shadow_semantic_ranking;
    ALTER TABLE retrieval_events DROP COLUMN shadow_lexical_ranking;
  `);
  database.prepare("DELETE FROM schema_migrations WHERE version = 3").run();
}

function rollbackOne(database: Database.Database): void {
  const generations = database.prepare("SELECT id FROM embedding_generations").all() as Array<{ id: string }>;
  for (const generation of generations) database.exec(`DROP TABLE IF EXISTS ${generationTable(generation.id)};`);
  database.exec(`
    DROP TABLE IF EXISTS backfill_checkpoints;
    DROP TABLE IF EXISTS embedding_cache;
    DROP TABLE IF EXISTS vector_rows;
    DROP TABLE IF EXISTS memory_index;
    DROP TABLE IF EXISTS namespace_generations;
    DROP TABLE IF EXISTS embedding_generations;
    DROP TABLE IF EXISTS schema_migrations;
  `);
}

function createVectorTableSql(descriptor: VectorGenerationDescriptor): string {
  const metric = descriptor.similarityMetric === "cosine" ? "cosine" : "L2";
  return `CREATE VIRTUAL TABLE ${generationTable(descriptor.id)} USING vec0(
    row_id INTEGER PRIMARY KEY,
    embedding FLOAT[${descriptor.dimension}] distance_metric=${metric},
    namespace TEXT PARTITION KEY,
    memory_kind TEXT,
    task_type TEXT,
    pinned INTEGER,
    +memory_id TEXT,
    +chunk_index INTEGER,
    +chunk_count INTEGER
  );`;
}

function generationTable(generationId: string): string {
  if (!/^[a-f0-9]{64}$/.test(generationId)) throw new Error("Embedding generation ID must be a lowercase SHA-256 digest.");
  return `memory_vec_${generationId.slice(0, 24)}`;
}

function validateGenerationDescriptor(descriptor: VectorGenerationDescriptor): void {
  generationTable(descriptor.id);
  if (!Number.isSafeInteger(descriptor.dimension) || descriptor.dimension < 1 || descriptor.dimension > 65_536) throw new Error("Embedding generation dimension is invalid.");
  if (!descriptor.provider || !descriptor.model || !descriptor.modelRevision || !descriptor.preprocessingVersion) throw new Error("Embedding generation identity is incomplete.");
  JSON.parse(descriptor.configurationJson);
}

function validateVector(vector: Float32Array, dimension: number): void {
  if (!(vector instanceof Float32Array) || vector.length !== dimension) throw new Error(`Vector dimension ${vector?.length ?? "invalid"} does not match generation dimension ${dimension}.`);
  let magnitude = 0;
  for (const value of vector) {
    if (!Number.isFinite(value)) throw new Error("Vector contains a non-finite component.");
    magnitude += value * value;
  }
  if (magnitude <= 0) throw new Error("Vector magnitude must be positive.");
}

function bufferToFloat32(buffer: Buffer): Float32Array {
  if (buffer.byteLength % Float32Array.BYTES_PER_ELEMENT !== 0) throw new Error("Cached vector byte length is corrupt.");
  const copy = Uint8Array.from(buffer);
  return new Float32Array(copy.buffer);
}

function assertGenerationCompatible(existing: GenerationRecord, descriptor: VectorGenerationDescriptor): void {
  for (const key of ["provider", "model", "modelRevision", "dimension", "similarityMetric", "preprocessingVersion"] as const) {
    if (existing[key] !== descriptor[key]) throw new Error(`Embedding generation ${descriptor.id} conflicts on ${key}.`);
  }
}

interface GenerationRow {
  id: string; provider: VectorGenerationDescriptor["provider"]; model: string; model_revision: string; dimension: bigint;
  similarity_metric: VectorGenerationDescriptor["similarityMetric"]; preprocessing_version: string; configuration_json: string;
  status: GenerationRecord["status"]; created_at: string; activated_at: string | null;
}

function generationFromRow(row: GenerationRow): GenerationRecord {
  return {
    id: row.id, provider: row.provider, model: row.model, modelRevision: row.model_revision, dimension: Number(row.dimension),
    similarityMetric: row.similarity_metric, preprocessingVersion: row.preprocessing_version, configurationJson: row.configuration_json,
    status: row.status, createdAt: row.created_at, activatedAt: row.activated_at
  };
}

interface MemoryIndexRow {
  generation_id: string; memory_id: string; namespace: string; content_hash: string; chunk_count: bigint;
  status: MemoryIndexRecord["status"]; error_code: string | null; embedded_at: string | null; updated_at: string;
}

function memoryIndexFromRow(row: MemoryIndexRow): MemoryIndexRecord {
  return {
    generationId: row.generation_id, memoryId: row.memory_id, namespace: row.namespace, contentHash: row.content_hash,
    chunkCount: Number(row.chunk_count), status: row.status, errorCode: row.error_code, embeddedAt: row.embedded_at, updatedAt: row.updated_at
  };
}

interface BackfillRow {
  job_id: string; namespace: string; generation_id: string; cursor: string; processed: bigint; succeeded: bigint;
  skipped: bigint; failed: bigint; status: BackfillCheckpoint["status"]; updated_at: string;
}

# Embedding and vector memory implementation

Date: 2026-07-11
Target release: v2.1.0
Control issue: NH-0014

## Repository findings

NexusHarness is a strict TypeScript application running on Node.js with Express, React, Vite, npm, Vitest, and Playwright. It is a local, single-process application. `server/store.ts` atomically replaces `.nexusharness/store.json`; before this implementation there was no relational database, migration runner, vector extension, background queue, dependency-injection container, external metrics backend, authentication layer, or embedding implementation.

The original `MemoryEntry` contained an ID, kind, task type, title, content, pinned flag, optional source, and timestamps. Operator routes created, updated, pinned, and deleted entries; successful runs added retrospectives; the Memory page filtered the client copy. Only the Planner received retrieved memory.

Original runtime retrieval was synchronous. It included pinned entries or entries whose title/task-type words overlapped the task, boosted a literal task-type substring, sorted pins first, and truncated formatted text using `ceil(characters / 4)` against `memoryTokenBudget`. It did not search memory bodies semantically, generate or persist vectors, isolate workspaces, expose selection reasons, safely migrate models, or measure retrieval quality.

NexusHarness has no user/tenant identities. Its enforceable memory boundary is the configured workspace. Legacy entries are assigned to the active workspace during JSON migration. Public state, memory mutation, lexical retrieval, and vector KNN all enforce the derived workspace namespace.

## Architecture implemented

The subsystem is split into replaceable production components under `server/memory/`:

- `EmbeddingProvider` and `EmbeddingModelDescriptor`: provider/model/dimension/input/batch/privacy capabilities.
- `EmbeddingService`: batching, dimension consistency, durable model-scoped cache, usage aggregation, and metrics.
- `SqliteVectorStore`: migrations, generation tables, KNN, metadata/namespace filters, cache, checkpoints, diagnostics, and cutover state.
- `MemoryIndexer`: normalization, chunking, embedding, upsert, stale handling, resumable backfill, and first-generation activation.
- `ReembeddingService`: replacement-generation build, coverage validation, explicit cutover, and rollback.
- `MemoryRetriever`: authorization, query embedding, vector/lexical candidates, fallback, diagnostics, and production prompt integration.
- `HybridRanker`: bounded normalized scoring, deduplication, deterministic ties, and maximal marginal relevance.
- `TokenBudgetAllocator`: pinned-first policy, provenance formatting, tokenizer counting, explicit truncation, and exact budget enforcement.
- `MemorySubsystem`: lifecycle coordination, audit linkage, health, startup backfill, and failure containment.

### Runtime data flow

1. Resolve the active workspace namespace and filter source memories before any candidate calculation.
2. Load pinned and lexical/task-type candidates.
3. In semantic modes, resolve the active generation and create its exact provider/model configuration.
4. Normalize and embed the task query with the real provider.
5. Execute namespace-partitioned KNN inside SQLite; collapse chunks to the strongest current parent memory.
6. Recompute the active generation's content hash and reject stale/incompatible records.
7. Merge candidates and normalize semantic, lexical, task-type, recency, and importance scores.
8. Deduplicate normalized bodies and apply bounded MMR diversity.
9. Pack pins then discretionary memories with source/ID/retrieval provenance under an exact `cl100k_base` token budget.
10. Inject the result into the actual Planner user message. The Planner system message and each memory wrapper state that stored content is untrusted reference data, not instructions.
11. Record counts, scores, mode, fallback, token use, latency, generation, and run linkage without raw query or memory text.

The scoring formula is:

```text
final_score =
    semantic_weight   * semantic_score
  + lexical_weight    * lexical_score
  + task_type_weight  * task_type_score
  + recency_weight    * recency_score
  + importance_weight * importance_score
```

Every component is clamped to `[0, 1]`; configuration validation requires weights to sum to `1`. Cosine distance is converted to similarity with `clamp(1 - distance, 0, 1)`. L2 uses `1 / (1 + distance)`. Ties resolve by pin, final score, semantic score, update time, then stable memory ID.

## Embedding providers

### Transformers.js local

`transformers-local` runs the feature-extraction pipeline in the NexusHarness Node process with mean pooling and normalized vectors. The default model is `Xenova/all-MiniLM-L6-v2` (384 dimensions once discovered). The model cache is under `NEXUSHARNESS_DATA_DIR/embedding-models`.

Model download is disabled by default. Enable `allowModelDownload` once, run health/backfill, then disable it for offline operation. A readiness marker is written only after the tokenizer and model load successfully. Complete cached files are loaded by absolute local path, so a partial or offline cache is never presented as healthy.

Local inference checks cancellation before/after inference and enforces a caller timeout. ONNX execution itself cannot be preempted once inside the native runtime; a timed-out call is ignored when it eventually returns. This is a remaining provider limitation, not a claimed hard cancellation boundary.

### Ollama

`ollama` uses the real `/api/embed` contract with array input and `truncate: false`. Configure an embedding-capable model such as the operator's installed `nomic-embed-text`; the implementation does not hardcode model availability or dimension.

### OpenAI-compatible

`openai-compatible` uses `/embeddings`, preserves response index ordering, supports optional requested dimensions, and reads the bearer credential from `apiKeyEnvironmentVariable`. The default variable name is `NEXUSHARNESS_EMBEDDING_API_KEY`. The secret value is never written to JSON, SQLite, diagnostics, audit, or API responses.

HTTP providers classify authentication, model/endpoint absence, rate limiting, timeout, invalid JSON/vector data, dimension mismatch, network failure, and provider failure. Retryable 408/429/5xx/network failures use bounded exponential backoff with jitter. Non-retryable authentication, configuration, corrupt response, and dimension errors fail immediately.

Non-loopback endpoints are rejected unless `allowRemoteContent` is explicitly true. This is the switch acknowledging that normalized memory/query text leaves the machine.

## Text normalization and chunking

- Unicode is normalized with NFKC; CRLF/CR becomes LF; trailing whitespace and excessive blank lines are normalized without flattening code indentation.
- Indexed input contains labeled title, kind, task type, source, and a body explicitly labeled as untrusted data.
- SHA-256 hashes include the preprocessing version and exact normalized embedding input.
- Empty normalized content fails indexing without deleting the source memory.
- `cl100k_base` provides deterministic chunk boundaries and prompt accounting. The local provider additionally checks chunks with its model tokenizer and reduces chunk size until every chunk fits.
- Defaults are 220 tokens with 32-token overlap under a 256-token model-input ceiling.
- Exact duplicate chunks inside one memory are removed. Chunk index/count/hash/token count map every hit back to its parent memory.
- Retrieval reconstructs the current parent memory from JSON; vectors and chunk text are never returned through the public API.

## Database and migrations

The source memory remains in `store.json` for backward compatibility and immediate lexical rollback. Durable vectors and operational metadata live in `.nexusharness/memory-vectors.sqlite` using `better-sqlite3` and the packaged `sqlite-vec` extension.

SQLite uses WAL, full synchronous writes, foreign keys, a five-second busy timeout, atomic transactions, and `quick_check` health validation.

Schema v1 creates:

- `embedding_generations`
- `namespace_generations`
- `memory_index`
- `vector_rows`
- `embedding_cache`
- `backfill_checkpoints`
- one `vec0` virtual table per generation/dimension

Schema v2 adds bounded `retrieval_events` observations and its namespace/time index. Schema v3 records bounded shadow-mode lexical and semantic memory-ID rankings plus overlap-at-K, without storing query or memory content.

Each vector table stores a fixed dimension and similarity metric. The workspace is a `vec0` partition key and is constrained inside KNN. Kind, task type, and pinned state are filterable metadata; memory/chunk identity is auxiliary data. Different provider/model/revision/dimension/preprocessing spaces therefore never share a KNN query.

Migrations are versioned with `PRAGMA user_version` and `schema_migrations`, run automatically on startup, and are operationally idempotent. Clean-database and legacy-JSON fixtures are tested. Schema rollback is available only as an explicit operator command; source memories are not removed.

```powershell
npm run memory:migrate
npm run memory:migrate -- --rollback-to 0
```

Before schema rollback, select `lexical_only`, stop NexusHarness, and back up both `store.json` and `memory-vectors.sqlite` (including `-wal`/`-shm` files if the process was not cleanly stopped).

## Memory lifecycle consistency

### Create

The JSON memory is written first with `pending`; semantic modes move it through `indexing` to `indexed` or typed `failed`. A failure preserves the source memory for explicit lexical fallback. A fresh namespace activates its first generation only after every current memory is covered.

### Update

Indexed-text changes invalidate and remove old generation rows before the JSON content changes, so a stale vector cannot be returned. The replacement is embedded and atomically upserted. Pin/importance-only updates change vector metadata without a provider request.

### Delete

Vector/chunk rows are removed before JSON deletion. If an indexed memory's vector store is unavailable, deletion fails with 503 rather than leaving an undiscoverable orphan. Retrieval also post-filters every vector hit against the current JSON parent and active-generation hash.

### Retrospectives

Run retrospectives pass through the same persisted-memory indexer after the run is safely completed. Index failure is audited but does not retroactively fail completed project work.

## Backfill and re-embedding

Backfill is bounded, idempotent, sorted by memory ID, checkpointed after each memory, and resumable by stable job ID. It supports dry-run, batch size, rate limiting, namespace, kind, update date, stale-only/all, and force controls.

```powershell
npm run memory:backfill -- --dry-run true
npm run memory:backfill -- --batch-size 32 --rate-limit 20
npm run memory:backfill -- --kind retrospective --updated-after 2026-01-01T00:00:00.000Z
```

A new model/revision/dimension/preprocessing configuration builds a separate generation. When another generation is active, re-embedding does not auto-cut over.

```powershell
npm run memory:reembed -- --job model-migration-2026
npm run memory:evaluate
npx tsx scripts/memory.ts activate --generation <64-character-generation-id>
```

Activation recomputes complete current coverage and fails if any memory is missing or stale. The prior generation remains the rollback target:

```powershell
npx tsx scripts/memory.ts rollback
```

Old generations cannot be deleted while active or referenced for rollback. After explicit acceptance:

```powershell
npx tsx scripts/memory.ts prune --generation <id> --confirm true --remove-rollback-reference true
```

## Configuration reference

Configuration is stored with the existing settings API/UI. Omitted fields receive backward-compatible defaults.

### `memoryRetrieval`

| Setting | Default | Valid range / meaning |
| --- | ---: | --- |
| `mode` | `lexical_only` | `lexical_only`, `shadow_semantic`, `hybrid`, `semantic_only` |
| `topKCandidates` | 50 | 1–500 |
| `finalMemoryLimit` | 12 | 1–100 and not above candidate count |
| `similarityMetric` | `cosine` | `cosine` or `l2`; fixed per generation |
| `minimumSemanticScore` | 0.25 | 0–1 |
| `semanticWeight` | 0.55 | 0–1 |
| `lexicalWeight` | 0.20 | 0–1 |
| `recencyWeight` | 0.10 | 0–1 |
| `taskTypeWeight` | 0.10 | 0–1 |
| `importanceWeight` | 0.05 | 0–1; all five weights must sum to 1 |
| `pinnedPolicy` | `always_include` | Pins are selected first within final/token limits, or `ranked` normally |
| `deduplicate` | `true` | Deduplicate normalized memory bodies |
| `diversityReranking` | `true` | Enable bounded MMR |
| `diversityLambda` | 0.70 | 0 = diversity, 1 = relevance |

`memoryTokenBudget` remains the 0–50,000 token prompt budget; zero disables injection without deleting/indexing data.

### `memoryEmbeddings`

| Setting | Default | Meaning |
| --- | --- | --- |
| `provider` | `transformers-local` | Local, Ollama, or OpenAI-compatible adapter |
| `model` | `Xenova/all-MiniLM-L6-v2` | Provider model/path identity |
| `modelRevision` | `main` | Generation and cache identity |
| `endpoint` | empty | Required for HTTP providers |
| `dimensions` | `null` | Auto-discover, or require 1–65,536 |
| `batchSize` | 32 | 1–256 |
| `timeoutMs` | 30,000 | 1,000–300,000 |
| `maxRetries` | 3 | 0–10 |
| `maxInputTokens` | 256 | Provider input ceiling |
| `chunkSizeTokens` | 220 | Must not exceed input ceiling |
| `chunkOverlapTokens` | 32 | Must be smaller than chunk size |
| `cacheEnabled` | `true` | Durable vector cache |
| `cacheMaxEntries` | 10,000 | 0–1,000,000 LRU entries |
| `cacheTtlMs` | 2,592,000,000 | 30 days by default |
| `embedOnWrite` | `true` | Immediate indexing in semantic modes |
| `allowAsyncBackfill` | `true` | Resume legacy backfill after startup/configuration |
| `failurePolicy` | `lexical_fallback` | Visible fallback or `fail_closed` |
| `allowRemoteContent` | `false` | Required for non-loopback HTTP endpoints |
| `allowModelDownload` | `false` | Permit local model-weight acquisition |
| `apiKeyEnvironmentVariable` | `NEXUSHARNESS_EMBEDDING_API_KEY` | Secret lookup name, not value |
| `preprocessingVersion` | `memory-text-v1` | Generation/cache identity |

Example hybrid local configuration:

```json
{
  "memoryTokenBudget": 4000,
  "memoryRetrieval": {
    "mode": "hybrid",
    "topKCandidates": 50,
    "finalMemoryLimit": 12,
    "similarityMetric": "cosine",
    "minimumSemanticScore": 0.25,
    "semanticWeight": 0.55,
    "lexicalWeight": 0.2,
    "recencyWeight": 0.1,
    "taskTypeWeight": 0.1,
    "importanceWeight": 0.05,
    "pinnedPolicy": "always_include",
    "deduplicate": true,
    "diversityReranking": true,
    "diversityLambda": 0.7
  },
  "memoryEmbeddings": {
    "provider": "transformers-local",
    "model": "Xenova/all-MiniLM-L6-v2",
    "modelRevision": "main",
    "endpoint": "",
    "dimensions": null,
    "batchSize": 32,
    "timeoutMs": 30000,
    "maxRetries": 3,
    "maxInputTokens": 256,
    "chunkSizeTokens": 220,
    "chunkOverlapTokens": 32,
    "cacheEnabled": true,
    "cacheMaxEntries": 10000,
    "cacheTtlMs": 2592000000,
    "embedOnWrite": true,
    "allowAsyncBackfill": true,
    "failurePolicy": "lexical_fallback",
    "allowRemoteContent": false,
    "allowModelDownload": false,
    "apiKeyEnvironmentVariable": "NEXUSHARNESS_EMBEDDING_API_KEY",
    "preprocessingVersion": "memory-text-v1"
  }
}
```

## Rollout and rollback

1. Back up `.nexusharness` while NexusHarness is stopped.
2. Deploy dependencies and start in default `lexical_only`; migrations run automatically.
3. Configure provider/model/privacy. For local Transformers, temporarily allow model download or pre-provision the cache.
4. Run `npm run memory:diagnostics` and `npm run memory:backfill -- --dry-run true`.
5. Select `shadow_semantic`, run real backfill, and monitor `memory.retrieve` audit events and `/api/memory/diagnostics`.
6. Run `npm run memory:evaluate` on the deployment hardware and inspect hard negatives/unauthorized count.
7. Select `hybrid`; keep `failurePolicy=lexical_fallback` initially.
8. For immediate rollback, select `lexical_only`. No source-memory or vector deletion is required.
9. For a model-generation rollback, run `npx tsx scripts/memory.ts rollback`.

## APIs and observability

- `GET /api/health` reports retrieval mode, vector-store health, and active generation only.
- `GET /api/memory/diagnostics` reports provider/model, off-device status, active generation, schema/extension health, indexed/stale/failed counts, cache count, database size, and last typed error.
- `POST /api/memory/backfill`
- `POST /api/memory/reembed`
- `POST /api/memory/generations/:id/activate`
- `POST /api/memory/generations/rollback`

Audit and SQLite observations track embedding requests/batches/latency/failure, cache hits/misses, candidate counts, selected count/tokens, retrieval mode/status/fallback, active generation, vector/end-to-end latency, score distribution, shadow lexical/semantic rankings and overlap-at-K, and backfill checkpoints. Shadow rankings contain only bounded memory IDs; routine output never includes raw memory, query, vector, credential, or provider error body.

## Security model

- Workspace namespace is SHA-256-derived and enforced before lexical ranking, inside `vec0` KNN, in vector freshness checks, in public state, in mutations, and in API jobs.
- Automated cross-workspace and public-state tests require zero unauthorized results.
- Provider secrets are environment-only. Endpoint/model/revision are non-secret generation metadata.
- Non-loopback transmission is denied without explicit consent; local mode never submits memory to a remote provider.
- Input, batch, response, vector dimension, retry, timeout, cache, candidate, chunk, event-history, and token limits bound denial-of-service exposure.
- Vectors are not exposed through public APIs. Memory remains operator-visible only in the active workspace.
- Stored prompt-injection text is labeled and delimited as untrusted data in both embedding and Planner contexts.
- Deletion is vector-first and fails closed for an indexed memory when vector invalidation cannot be proven.

NexusHarness remains a loopback, single-operator application rather than a multi-user authorization service. Workspace isolation is not a substitute for OS account separation when mutually untrusted users share one machine.

## Retrieval evaluation

Command:

```powershell
npm run memory:evaluate
```

Dataset: `evaluation/memory-retrieval.json`, 11 memories, 11 queries, paraphrases, exact keywords, ambiguity, pins, hard negatives, and cross-workspace cases. Model: real `Xenova/all-MiniLM-L6-v2`, 384 dimensions. Latest measured results:

| Metric | Lexical-only | Hybrid |
| --- | ---: | ---: |
| Recall@5 | 0.4697 | 0.9697 |
| Precision@5 | 0.1273 | 0.2545 |
| Mean reciprocal rank | 0.4848 | 0.8182 |
| nDCG@5 | 0.4379 | 0.8475 |
| Average token-budget utilization | 0.3585 | 0.8691 |
| Duplicate-result rate | 0 | 0 |
| Unauthorized retrieval count | 0 | 0 |
| P50 latency | 1.0786 ms | 6.3199 ms |
| P95 latency | 1.9367 ms | 6.6442 ms |

The evaluation does not claim universal relevance quality; it is a small, versioned regression set for this product's memory patterns.

## Performance benchmark

Command:

```powershell
npm run memory:benchmark
```

Measured on Windows 11 Pro 10.0.26200, Node 24.18.0, Intel Core Ultra 9 275HX (24 cores/logical processors), local q8 MiniLM, 120 memories, 40 hybrid queries, 50 semantic candidates, and a real kind/task metadata filter:

| Measurement | Result |
| --- | ---: |
| Single embedding throughput | 584.95 items/s |
| Batch embedding throughput | 1,863.66 items/s |
| Backfill throughput | 69.25 memories/s |
| Retrieval P50 / P95 | 7.61 / 14.38 ms |
| Vector query P50 / P95 | 1.12 / 1.30 ms |
| Filtered vector query | 1.05 ms |
| SQLite size for 120 memories | 2,174,976 bytes |
| Second-pass embedding cache hit rate | 100% (8/8) |

These figures describe this fixture and hardware, not a cross-platform production SLA. Run the benchmark on deployment hardware.

## Verification commands

```powershell
npm run test:memory
npx vitest run tests/embeddingProviders.test.ts
npm run memory:evaluate
npm run memory:benchmark
npm run lint
npm test
npm run build
npm run release:verify
```

Coverage includes normalization, hashing, chunking, provider/privacy validation, HTTP retries and failures, dimensions, score direction, hybrid weights, deduplication, MMR, exact token budgets, clean/legacy migrations, real neural batching, durable KNN, metadata and workspace filters, create/update/delete, stale replacement, backfill resume, model generation/cutover/rollback/prune guards, lexical/shadow/hybrid/semantic modes, vector-store fallback, and the public API through actual Planner context assembly.

The final repository gate on 2026-07-11 passed 271 tests with 21 intentional platform/fixture skips, both TypeScript projects, the Vite production build, six accessibility checks, five workflow checks, six visual comparisons, four browser performance checks, production smoke, and the 301-file package dry run. `npm audit --audit-level=moderate` reported zero vulnerabilities. SQLite schema 3 was applied, rolled back to schema 2, reapplied, and returned sqlite-vec `v0.1.9` with `quick_check: ok`.

## Final implementation report

All twenty requested deliverables are connected to production paths: real local and remote providers, durable generation-separated vectors, lifecycle indexing, explicit hybrid ranking, exact token packing, rollout/fallback controls, resumable operations, diagnostics, security boundaries, unit/integration/E2E coverage, evaluation, benchmarks, migrations, and deployment documentation. The default remains deliberately `lexical_only` for backward-compatible staged rollout; semantic operation is never reported unless a healthy active generation and real query embedding were used. The genuine limitations below remain deployment considerations rather than hidden placeholders.

## Adding another provider

1. Implement `EmbeddingProvider` in `server/memory/providers.ts` or a dedicated module.
2. Provide an accurate descriptor, real batch embedding, token count, health, cancellation behavior, and typed failures.
3. Normalize or explicitly document the model's required similarity behavior.
4. Add its configuration enum/schema/UI, privacy boundary, generation fingerprint fields, and credential source without storing secrets.
5. Add unit adapter tests plus real-provider/real-SQLite integration evidence. Do not add the provider if tests mock both embedding and storage.

Retrieval, ranking, indexing, and vector storage must not branch on provider-specific business logic.

## Troubleshooting

- `no_active_generation`: run diagnostics and backfill; an incomplete replacement never auto-activates over an existing generation.
- `model_unavailable`: provision the local cache or temporarily enable model download; verify the model supports feature extraction/embeddings.
- `authentication`: set the configured environment variable and restart; do not place keys in JSON.
- `dimension_mismatch`: do not change dimensions in place; build a new generation.
- `vector_store_unavailable`: inspect filesystem permissions/native extension support. With lexical fallback the run degrades visibly; indexed deletion/update fails closed where invalidation is required.
- `rate_limited` or `timeout`: reduce batch/rate, increase bounded timeout, or use local inference. Retry count remains capped.
- high retrieval latency: run the benchmark, lower candidate count, confirm provider-session/cache hits, and inspect semantic versus vector duration.
- stale/unindexed count: run dry-run backfill, then resume the reported job. Raw provider error bodies are intentionally not persisted.

## Remaining limitations

- `sqlite-vec` v0.1.9 performs exact brute-force KNN rather than ANN. The adapter is appropriate for local harness memory; multi-million-vector deployments should implement another `VectorStore`.
- The packaged native SQLite/ONNX dependencies currently target supported mainstream Node/platform combinations; unsupported architectures must remain explicitly lexical until compatible binaries are provided.
- Local ONNX inference cannot be forcibly interrupted once inside the native session.
- Prompt token accounting uses `cl100k_base` because NexusHarness can target heterogeneous planner models without exposed tokenizers. Local embedding input additionally uses the embedding model tokenizer. A future runtime adapter may provide the exact Planner tokenizer.
- The evaluation set is deliberately small and English-heavy.
- Workspace isolation protects retrieval in this single-operator service; it is not multi-user authentication or encryption at rest.

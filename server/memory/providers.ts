import path from "node:path";
import { existsSync } from "node:fs";
import { mkdir, rename, writeFile } from "node:fs/promises";
import type { MemoryEmbeddingSettings, SimilarityMetric, EmbeddingBatchResult, EmbeddingModelDescriptor, EmbeddingProvider, EmbeddingProviderHealth } from "./types.js";
import { EmbeddingError } from "./types.js";
import { isLoopbackEndpoint } from "./config.js";
import { countPromptTokens } from "./preprocessing.js";

interface ProviderFactoryOptions {
  modelCacheDirectory: string;
  environment?: NodeJS.ProcessEnv;
  random?: () => number;
  sleep?: (milliseconds: number, signal?: AbortSignal) => Promise<void>;
}

interface HttpEmbeddingPayload {
  vectors: unknown;
  usage?: { prompt_tokens?: number; total_tokens?: number };
}

const providerCache = new Map<string, EmbeddingProvider>();
const MAX_CACHED_PROVIDERS = 16;

export function createEmbeddingProvider(settings: MemoryEmbeddingSettings, options: ProviderFactoryOptions): EmbeddingProvider {
  validateProviderConfiguration(settings, options.environment ?? process.env);
  const cacheKey = JSON.stringify({ settings, modelCacheDirectory: path.resolve(options.modelCacheDirectory) });
  const cached = providerCache.get(cacheKey);
  if (cached) {
    providerCache.delete(cacheKey);
    providerCache.set(cacheKey, cached);
    return cached;
  }
  const provider = settings.provider === "transformers-local"
    ? new TransformersLocalEmbeddingProvider(settings, options.modelCacheDirectory)
    : settings.provider === "ollama"
      ? new OllamaEmbeddingProvider(settings, options)
      : new OpenAiCompatibleEmbeddingProvider(settings, options);
  providerCache.set(cacheKey, provider);
  while (providerCache.size > MAX_CACHED_PROVIDERS) providerCache.delete(providerCache.keys().next().value!);
  return provider;
}

export function validateProviderConfiguration(settings: MemoryEmbeddingSettings, environment: NodeJS.ProcessEnv = process.env): void {
  if (settings.provider === "transformers-local") {
    if (!settings.model.trim()) throw new EmbeddingError("configuration", "A local embedding model identifier or path is required.", false);
    return;
  }
  let endpoint: URL;
  try { endpoint = new URL(settings.endpoint); }
  catch (cause) { throw new EmbeddingError("configuration", "Embedding endpoint is not a valid URL.", false, undefined, { cause }); }
  if (!/^https?:$/.test(endpoint.protocol)) throw new EmbeddingError("configuration", "Embedding endpoint must use HTTP or HTTPS.", false);
  if (!isLoopbackEndpoint(endpoint.toString()) && !settings.allowRemoteContent) {
    throw new EmbeddingError("configuration", "Remote embedding content transmission is disabled. Enable allowRemoteContent only after reviewing the provider privacy boundary.", false);
  }
  if (settings.provider === "openai-compatible" && !isLoopbackEndpoint(endpoint.toString()) && !environment[settings.apiKeyEnvironmentVariable]) {
    throw new EmbeddingError("authentication", `Remote OpenAI-compatible embeddings require ${settings.apiKeyEnvironmentVariable}.`, false);
  }
}

abstract class BaseEmbeddingProvider implements EmbeddingProvider {
  readonly descriptor: EmbeddingModelDescriptor;

  protected constructor(protected readonly settings: MemoryEmbeddingSettings, sendsContentOffDevice: boolean) {
    this.descriptor = {
      provider: settings.provider,
      model: settings.model,
      revision: settings.modelRevision,
      dimension: settings.dimensions,
      maximumInputTokens: settings.maxInputTokens,
      maximumBatchSize: settings.batchSize,
      similarityMetric: "cosine",
      sendsContentOffDevice
    };
  }

  async embed(text: string, signal?: AbortSignal): Promise<EmbeddingBatchResult> {
    return this.embedBatch([text], signal);
  }

  abstract embedBatch(texts: readonly string[], signal?: AbortSignal): Promise<EmbeddingBatchResult>;

  async countTokens(text: string): Promise<number> {
    return countPromptTokens(text);
  }

  async health(signal?: AbortSignal): Promise<EmbeddingProviderHealth> {
    const started = performance.now();
    try {
      await this.embed("NexusHarness embedding provider health check.", signal);
      return { ok: true, checkedAt: new Date().toISOString(), latencyMs: performance.now() - started, descriptor: { ...this.descriptor } };
    } catch (error) {
      const classified = classifyEmbeddingError(error);
      return { ok: false, checkedAt: new Date().toISOString(), latencyMs: performance.now() - started, descriptor: { ...this.descriptor }, errorCode: classified.code };
    }
  }

  protected validateInputs(texts: readonly string[]): void {
    if (!texts.length) throw new EmbeddingError("configuration", "Embedding batches cannot be empty.", false);
    if (texts.length > this.settings.batchSize) throw new EmbeddingError("configuration", `Embedding batch exceeds configured limit ${this.settings.batchSize}.`, false);
    for (const text of texts) {
      if (!text.trim()) throw new EmbeddingError("configuration", "Embedding input cannot be empty.", false);
      if (Buffer.byteLength(text, "utf8") > 8 * 1024 * 1024) throw new EmbeddingError("input_too_large", "Embedding input exceeds the 8 MiB transport limit.", false);
    }
  }

  protected validateVectors(raw: unknown, expectedCount: number): Float32Array[] {
    if (!Array.isArray(raw) || raw.length !== expectedCount) throw new EmbeddingError("invalid_response", `Embedding provider returned ${Array.isArray(raw) ? raw.length : "invalid"} vectors for ${expectedCount} inputs.`, false);
    const vectors = raw.map((value) => {
      const values = value instanceof Float32Array ? Array.from(value) : Array.isArray(value) ? value : [];
      if (!values.length || values.some((item) => typeof item !== "number" || !Number.isFinite(item))) {
        throw new EmbeddingError("invalid_response", "Embedding provider returned an empty, corrupt, or non-finite vector.", false);
      }
      const vector = normalizeVector(new Float32Array(values));
      const configured = this.settings.dimensions;
      if (configured && vector.length !== configured) throw new EmbeddingError("dimension_mismatch", `Embedding dimension ${vector.length} does not match configured dimension ${configured}.`, false);
      if (this.descriptor.dimension && vector.length !== this.descriptor.dimension) throw new EmbeddingError("dimension_mismatch", `Embedding dimension changed from ${this.descriptor.dimension} to ${vector.length}.`, false);
      this.descriptor.dimension = vector.length;
      return vector;
    });
    return vectors;
  }
}

export class TransformersLocalEmbeddingProvider extends BaseEmbeddingProvider {
  private extractorPromise?: Promise<any>;
  private loadRetries = 0;

  constructor(settings: MemoryEmbeddingSettings, private readonly modelCacheDirectory: string) {
    super(settings, false);
  }

  private async extractor(): Promise<any> {
    if (!this.extractorPromise) {
      this.extractorPromise = (async () => {
        const { pipeline } = await import("@huggingface/transformers");
        const cachedDirectory = path.resolve(this.modelCacheDirectory, this.settings.model);
        const cacheRelative = path.relative(path.resolve(this.modelCacheDirectory), cachedDirectory);
        const safeCachedDirectory = cacheRelative && !cacheRelative.startsWith("..") && !path.isAbsolute(cacheRelative) ? cachedDirectory : null;
        const readyMarker = safeCachedDirectory ? path.join(safeCachedDirectory, ".nexusharness-ready") : null;
        const completeCache = Boolean(safeCachedDirectory && ["config.json", "tokenizer_config.json", "tokenizer.json", path.join("onnx", "model_quantized.onnx")].every((file) => existsSync(path.join(safeCachedDirectory, file))));
        let lastError: unknown;
        const allowDownload = this.settings.allowModelDownload && !existsSync(readyMarker ?? "") && !completeCache;
        const modelReference = completeCache || existsSync(readyMarker ?? "") ? cachedDirectory : this.settings.model;
        const attempts = allowDownload ? this.settings.maxRetries + 1 : 1;
        for (let attempt = 0; attempt < attempts; attempt += 1) {
          try {
            const extractor = await pipeline("feature-extraction", modelReference, {
              revision: this.settings.modelRevision,
              dtype: "q8",
              cache_dir: path.resolve(this.modelCacheDirectory),
              local_files_only: !allowDownload
            });
            if (typeof (extractor as any).tokenizer !== "function") throw new Error("Loaded embedding model does not contain a callable tokenizer.");
            if (readyMarker) {
              await mkdir(path.dirname(readyMarker), { recursive: true });
              const temporary = `${readyMarker}.${process.pid}.tmp`;
              await writeFile(temporary, JSON.stringify({ model: this.settings.model, revision: this.settings.modelRevision, verifiedAt: new Date().toISOString() }), "utf8");
              await rename(temporary, readyMarker);
            }
            this.loadRetries = attempt;
            return extractor;
          } catch (error) {
            lastError = error;
            if (attempt + 1 < attempts) await abortableSleep(Math.min(10_000, 500 * 2 ** attempt));
          }
        }
        throw lastError;
      })().catch((error) => {
        this.extractorPromise = undefined;
        throw classifyEmbeddingError(error, "model_unavailable");
      });
    }
    return this.extractorPromise;
  }

  override async countTokens(text: string): Promise<number> {
    const extractor = await this.extractor();
    try {
      const encoded = await extractor.tokenizer(text, { add_special_tokens: true, truncation: false });
      const inputIds = encoded?.input_ids?.data ?? encoded?.input_ids;
      return typeof inputIds?.length === "number" ? inputIds.length : countPromptTokens(text);
    } catch {
      return countPromptTokens(text);
    }
  }

  async embedBatch(texts: readonly string[], signal?: AbortSignal): Promise<EmbeddingBatchResult> {
    this.validateInputs(texts);
    throwIfAborted(signal);
    const extractor = await this.extractor();
    for (const text of texts) {
      const count = await this.countTokens(text);
      if (count > this.settings.maxInputTokens) throw new EmbeddingError("input_too_large", `Embedding input contains ${count} model tokens; limit is ${this.settings.maxInputTokens}.`, false);
    }
    const started = performance.now();
    try {
      const output = await withTimeout(
        Promise.resolve(extractor([...texts], { pooling: "mean", normalize: true })),
        this.settings.timeoutMs,
        signal
      );
      throwIfAborted(signal);
      let values = output?.tolist?.() ?? output?.data;
      if (texts.length === 1 && Array.isArray(values) && typeof values[0] === "number") values = [values];
      const retries = this.loadRetries;
      this.loadRetries = 0;
      return { vectors: this.validateVectors(values, texts.length), descriptor: { ...this.descriptor }, durationMs: performance.now() - started, retries };
    } catch (error) {
      throw classifyEmbeddingError(error, "provider_unavailable");
    }
  }
}

class OllamaEmbeddingProvider extends BaseEmbeddingProvider {
  constructor(settings: MemoryEmbeddingSettings, private readonly options: ProviderFactoryOptions) {
    super(settings, !isLoopbackEndpoint(settings.endpoint));
  }

  async embedBatch(texts: readonly string[], signal?: AbortSignal): Promise<EmbeddingBatchResult> {
    this.validateInputs(texts);
    const started = performance.now();
    const request = await requestWithRetry(
      new URL("/api/embed", this.settings.endpoint).toString(),
      { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model: this.settings.model, input: [...texts], truncate: false }) },
      this.settings,
      this.options,
      signal
    );
    const payload = request.payload as { embeddings?: unknown; prompt_eval_count?: number };
    return {
      vectors: this.validateVectors(payload.embeddings, texts.length),
      descriptor: { ...this.descriptor },
      usage: { inputTokens: payload.prompt_eval_count },
      durationMs: performance.now() - started,
      retries: request.retries
    };
  }
}

class OpenAiCompatibleEmbeddingProvider extends BaseEmbeddingProvider {
  constructor(settings: MemoryEmbeddingSettings, private readonly options: ProviderFactoryOptions) {
    super(settings, !isLoopbackEndpoint(settings.endpoint));
  }

  async embedBatch(texts: readonly string[], signal?: AbortSignal): Promise<EmbeddingBatchResult> {
    this.validateInputs(texts);
    const environment = this.options.environment ?? process.env;
    const apiKey = environment[this.settings.apiKeyEnvironmentVariable];
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (apiKey) headers.authorization = `Bearer ${apiKey}`;
    const started = performance.now();
    const request = await requestWithRetry(
      appendEndpointPath(this.settings.endpoint, "embeddings"),
      { method: "POST", headers, body: JSON.stringify({ model: this.settings.model, input: [...texts], ...(this.settings.dimensions ? { dimensions: this.settings.dimensions } : {}) }) },
      this.settings,
      this.options,
      signal
    );
    const data = request.payload as { data?: Array<{ index?: number; embedding?: number[] }>; usage?: HttpEmbeddingPayload["usage"] };
    const ordered = [...(data.data ?? [])].sort((left, right) => (left.index ?? 0) - (right.index ?? 0)).map((item) => item.embedding);
    return {
      vectors: this.validateVectors(ordered, texts.length),
      descriptor: { ...this.descriptor },
      usage: { inputTokens: data.usage?.prompt_tokens, totalTokens: data.usage?.total_tokens },
      durationMs: performance.now() - started,
      retries: request.retries
    };
  }
}

async function requestWithRetry(
  url: string,
  init: RequestInit,
  settings: MemoryEmbeddingSettings,
  options: ProviderFactoryOptions,
  signal?: AbortSignal
): Promise<{ payload: unknown; retries: number }> {
  const random = options.random ?? Math.random;
  const sleep = options.sleep ?? abortableSleep;
  let lastError: EmbeddingError | undefined;
  for (let attempt = 0; attempt <= settings.maxRetries; attempt += 1) {
    throwIfAborted(signal);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error("timeout")), settings.timeoutMs);
    try {
      const combined = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
      const response = await fetch(url, { ...init, signal: combined });
      const text = await response.text();
      if (Buffer.byteLength(text, "utf8") > 20 * 1024 * 1024) throw new EmbeddingError("invalid_response", "Embedding response exceeded 20 MiB.", false);
      if (!response.ok) throw httpEmbeddingError(response.status, response.statusText);
      try { return { payload: text ? JSON.parse(text) : {}, retries: attempt }; }
      catch (cause) { throw new EmbeddingError("invalid_response", "Embedding provider returned invalid JSON.", false, response.status, { cause }); }
    } catch (error) {
      const classified = controller.signal.aborted && !signal?.aborted
        ? new EmbeddingError("timeout", `Embedding request timed out after ${settings.timeoutMs}ms.`, true, undefined, { cause: error })
        : classifyEmbeddingError(error);
      lastError = classified;
      if (!classified.retryable || attempt === settings.maxRetries) throw classified;
      const base = Math.min(10_000, 250 * 2 ** attempt);
      await sleep(Math.round(base * (0.75 + random() * 0.5)), signal);
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastError ?? new EmbeddingError("provider_unavailable", "Embedding request failed.", false);
}

function httpEmbeddingError(status: number, statusText: string): EmbeddingError {
  if (status === 401 || status === 403) return new EmbeddingError("authentication", `Embedding provider rejected authentication (${status}).`, false, status);
  if (status === 404) return new EmbeddingError("model_unavailable", `Embedding endpoint or model was not found (${status}).`, false, status);
  if (status === 408) return new EmbeddingError("timeout", `Embedding request timed out (${status}).`, true, status);
  if (status === 429) return new EmbeddingError("rate_limited", `Embedding provider rate limited the request (${status}).`, true, status);
  if (status >= 500) return new EmbeddingError("provider_unavailable", `Embedding provider failed (${status} ${statusText}).`, true, status);
  return new EmbeddingError("invalid_response", `Embedding provider rejected the request (${status} ${statusText}).`, false, status);
}

export function classifyEmbeddingError(error: unknown, fallback: "model_unavailable" | "provider_unavailable" = "provider_unavailable"): EmbeddingError {
  if (error instanceof EmbeddingError) return error;
  if (error instanceof DOMException && error.name === "AbortError") return new EmbeddingError("aborted", "Embedding operation was canceled.", false, undefined, { cause: error });
  const message = error instanceof Error ? error.message : String(error);
  if (/abort/i.test(message)) return new EmbeddingError("aborted", "Embedding operation was canceled.", false, undefined, { cause: error });
  if (/timed?\s*out|timeout/i.test(message)) return new EmbeddingError("timeout", "Embedding operation timed out.", true, undefined, { cause: error });
  if (/unauthori[sz]ed|forbidden|api.?key|credential/i.test(message)) return new EmbeddingError("authentication", "Embedding provider authentication failed.", false, undefined, { cause: error });
  if (/not found|no such file|local_files_only|model/i.test(message) && fallback === "model_unavailable") return new EmbeddingError("model_unavailable", "Configured local embedding model is unavailable.", false, undefined, { cause: error });
  return new EmbeddingError(fallback, "Embedding provider operation failed.", fallback === "provider_unavailable", undefined, { cause: error });
}

function normalizeVector(vector: Float32Array): Float32Array {
  let magnitudeSquared = 0;
  for (const value of vector) magnitudeSquared += value * value;
  if (!Number.isFinite(magnitudeSquared) || magnitudeSquared <= 0) throw new EmbeddingError("invalid_response", "Embedding vector has zero or invalid magnitude.", false);
  const magnitude = Math.sqrt(magnitudeSquared);
  return Float32Array.from(vector, (value) => value / magnitude);
}

function appendEndpointPath(endpoint: string, suffix: string): string {
  const url = new URL(endpoint);
  url.pathname = `${url.pathname.replace(/\/$/, "")}/${suffix}`.replace(/\/+/g, "/");
  return url.toString();
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new EmbeddingError("aborted", "Embedding operation was canceled.", false);
}

async function withTimeout<T>(operation: Promise<T>, timeoutMs: number, signal?: AbortSignal): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new EmbeddingError("timeout", `Local embedding operation exceeded ${timeoutMs}ms.`, true)), timeoutMs);
  });
  const aborted = new Promise<never>((_resolve, reject) => {
    if (signal?.aborted) reject(new EmbeddingError("aborted", "Embedding operation was canceled.", false));
    else signal?.addEventListener("abort", () => reject(new EmbeddingError("aborted", "Embedding operation was canceled.", false)), { once: true });
  });
  try { return await Promise.race([operation, timeout, aborted]); }
  finally { if (timer) clearTimeout(timer); }
}

function abortableSleep(milliseconds: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, milliseconds);
    signal?.addEventListener("abort", () => { clearTimeout(timer); reject(new EmbeddingError("aborted", "Embedding retry was canceled.", false)); }, { once: true });
  });
}

export function semanticScoreFromDistance(distance: number, metric: SimilarityMetric): number {
  if (!Number.isFinite(distance) || distance < 0) return 0;
  return metric === "cosine" ? Math.max(0, Math.min(1, 1 - distance)) : 1 / (1 + distance);
}

import { spawn } from "node:child_process";
import { access } from "node:fs/promises";
import type { ChatMessage, ModelChatRequest, ModelChatResponse, ModelInfo, RuntimeConfig } from "./types.js";

const MODEL_CACHE_TTL_MS = 60_000;
const MAX_RUNTIME_RESPONSE_BYTES = 10 * 1024 * 1024;
const modelCache = new Map<string, { expiresAt: number; models: ModelInfo[] }>();

export type RuntimeRequestErrorCode = "runtime_timeout" | "runtime_unavailable" | "runtime_http_error" | "runtime_invalid_response";

export class RuntimeRequestError extends Error {
  constructor(
    readonly code: RuntimeRequestErrorCode,
    message: string,
    readonly url: string,
    readonly timeoutMs: number,
    readonly retryable: boolean,
    readonly status?: number,
    options?: ErrorOptions
  ) {
    super(message, options);
    this.name = "RuntimeRequestError";
  }
}

function runtimeCacheKey(runtime: RuntimeConfig): string {
  return JSON.stringify([runtime.id, runtime.kind, runtime.endpoint, runtime.binaryPath, runtime.modelPath]);
}

async function fetchJson(url: string, init: RequestInit, timeoutMs: number): Promise<any> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const signal = init.signal ? AbortSignal.any([init.signal, controller.signal]) : controller.signal;
    const response = await fetch(url, { ...init, signal });
    const text = await response.text();
    if (!response.ok) throw new RuntimeRequestError("runtime_http_error", `Runtime rejected ${url} with HTTP ${response.status} ${response.statusText}.`, url, timeoutMs, response.status >= 500 || response.status === 408 || response.status === 429, response.status);
    if (Buffer.byteLength(text) > MAX_RUNTIME_RESPONSE_BYTES) throw new RuntimeRequestError("runtime_invalid_response", `Runtime response exceeded the 10 MiB safety limit: ${url}`, url, timeoutMs, false);
    try {
      return text ? JSON.parse(text) : {};
    } catch (error: any) {
      throw new RuntimeRequestError("runtime_invalid_response", `Runtime returned invalid JSON from ${url}.`, url, timeoutMs, false, undefined, { cause: error });
    }
  } catch (error) {
    if (error instanceof RuntimeRequestError) throw error;
    if (init.signal?.aborted && !controller.signal.aborted) throw error;
    if (controller.signal.aborted) {
      throw new RuntimeRequestError(
        "runtime_timeout",
        `Runtime request timed out after ${formatDuration(timeoutMs)} while waiting for ${url}. The runtime may be busy, queued, or generating too slowly.`,
        url,
        timeoutMs,
        true,
        undefined,
        { cause: error }
      );
    }
    throw new RuntimeRequestError("runtime_unavailable", `Could not connect to runtime endpoint ${url}.`, url, timeoutMs, true, undefined, { cause: error });
  } finally {
    clearTimeout(timer);
  }
}

async function fetchJsonWithLoopbackFallback(url: string, init: RequestInit, timeoutMs: number): Promise<any> {
  const attempts = [url];
  const parsed = new URL(url);
  if (["localhost", "::1", "[::1]"].includes(parsed.hostname)) {
    parsed.hostname = "127.0.0.1";
    attempts.push(parsed.toString());
  }
  let lastError: unknown;
  for (const attempt of Array.from(new Set(attempts))) {
    try {
      return await fetchJson(attempt, init, timeoutMs);
    } catch (error) {
      if (init.signal?.aborted) throw error;
      if (error instanceof RuntimeRequestError && error.code !== "runtime_unavailable") throw error;
      lastError = error;
    }
  }
  const detail = lastError instanceof Error ? lastError.message : String(lastError);
  if (lastError instanceof RuntimeRequestError && lastError.code !== "runtime_unavailable") throw lastError;
  throw new RuntimeRequestError("runtime_unavailable", `Could not connect to runtime endpoint ${url}. Last error: ${detail}`, url, timeoutMs, true, undefined, { cause: lastError });
}

function formatDuration(milliseconds: number): string {
  return milliseconds >= 1000 && milliseconds % 1000 === 0 ? `${milliseconds / 1000} seconds` : `${milliseconds} ms`;
}

function parseContext(raw: any): number | undefined {
  return raw?.details?.context_length ?? raw?.context_length ?? raw?.n_ctx ?? raw?.model_info?.["general.context_length"];
}

export async function listRuntimeModels(runtime: RuntimeConfig, options: { fresh?: boolean } = {}): Promise<ModelInfo[]> {
  const cacheKey = runtimeCacheKey(runtime);
  const cached = modelCache.get(cacheKey);
  if (!options.fresh && cached && cached.expiresAt > Date.now()) return cached.models;
  let models: ModelInfo[];
  if (runtime.kind === "ollama") {
    const data = await fetchJsonWithLoopbackFallback(new URL("/api/tags", runtime.endpoint).toString(), {}, runtime.timeoutMs);
    models = (data.models ?? []).map((model: any) => ({
      id: `${runtime.id}:${model.name}`,
      runtimeId: runtime.id,
      name: model.name,
      contextWindow: parseContext(model),
      supportsTools: true,
      quantization: model.details?.quantization_level,
      raw: model
    }));
  } else if (runtime.kind === "lmstudio" || runtime.kind === "llamacpp-server") {
    const data = await fetchJsonWithLoopbackFallback(new URL("/v1/models", runtime.endpoint).toString(), {}, runtime.timeoutMs);
    models = (data.data ?? []).map((model: any) => ({
      id: `${runtime.id}:${model.id}`,
      runtimeId: runtime.id,
      name: model.id,
      contextWindow: parseContext(model),
      supportsTools: runtime.kind === "lmstudio",
      raw: model
    }));
  } else {
    if (!runtime.binaryPath || !runtime.modelPath) {
      throw new Error("llama.cpp CLI runtime is missing binaryPath or modelPath.");
    }
    await Promise.all([access(runtime.binaryPath), access(runtime.modelPath)]);
    models = [{
      id: `${runtime.id}:${runtime.modelPath}`,
      runtimeId: runtime.id,
      name: runtime.modelPath,
      supportsTools: false,
      raw: { binaryPath: runtime.binaryPath, modelPath: runtime.modelPath }
    }];
  }
  modelCache.set(cacheKey, { expiresAt: Date.now() + MODEL_CACHE_TTL_MS, models });
  return models;
}

export async function validateRuntimeConnection(runtime: RuntimeConfig): Promise<ModelInfo[]> {
  const models = await listRuntimeModels(runtime, { fresh: true });
  if (models.length === 0) {
    throw new Error(`Runtime "${runtime.name}" responded but did not report any available models.`);
  }
  return models;
}

function openAiMessages(messages: ChatMessage[]) {
  return messages.map((message) => {
    if (message.role === "tool") {
      return {
        role: "tool",
        tool_call_id: message.toolCallId,
        content: message.content
      };
    }
    if (message.role === "assistant" && message.toolCalls?.length) {
      return {
        role: "assistant",
        content: message.content || null,
        tool_calls: message.toolCalls.map((call) => ({
          id: call.id,
          type: "function",
          function: {
            name: call.name,
            arguments: JSON.stringify(call.arguments)
          }
        }))
      };
    }
    return { role: message.role, content: message.content };
  });
}

function ollamaMessages(messages: ChatMessage[]) {
  return messages.map((message) => ({
    role: message.role,
    content: message.content,
    ...(message.role === "tool" && message.toolName ? { tool_name: message.toolName } : {}),
    ...(message.role === "assistant" && message.toolCalls?.length
      ? { tool_calls: message.toolCalls.map((call) => ({ function: { name: call.name, arguments: call.arguments } })) }
      : {})
  }));
}

function parseToolArguments(value: unknown): Record<string, unknown> {
  if (!value) return {};
  if (typeof value === "string") {
    try {
      const parsed = parseJsonWithRepair(value);
      return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
    } catch (error: any) {
      throw new Error(`Model returned invalid tool arguments JSON: ${error.message}`);
    }
  }
  return typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function repairInvalidJsonEscapes(text: string): string {
  return text.replace(/\\(?!["\\/bfnrtu])/g, "\\\\");
}

function parseJsonWithRepair(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return JSON.parse(repairInvalidJsonEscapes(text));
  }
}

export function parseTextToolCalls(content: string): ModelChatResponse["toolCalls"] {
  const trimmed = content.trim();
  if (!trimmed) return [];
  const candidates = [
    trimmed,
    ...Array.from(trimmed.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)).map((match) => match[1]?.trim() ?? "")
  ].filter(Boolean);
  for (const candidate of candidates) {
    try {
      const parsed = parseJsonWithRepair(candidate) as any;
      const rawCalls = Array.isArray(parsed?.tool_calls)
        ? parsed.tool_calls
        : Array.isArray(parsed?.toolCalls)
          ? parsed.toolCalls
          : [];
      const calls = rawCalls
        .map((call: any, index: number) => ({
          id: call.id ?? `text_call_${index}`,
          name: call.name ?? call.function?.name,
          arguments: parseToolArguments(call.arguments ?? call.function?.arguments)
        }))
        .filter((call: any) => typeof call.name === "string" && call.name.length > 0);
      if (calls.length) return calls;
    } catch {
      continue;
    }
  }
  return [];
}

async function fetchOllamaChatStream(url: string, init: RequestInit, inactivityTimeoutMs: number): Promise<any[]> {
  const inactivityController = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const resetInactivityTimer = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => inactivityController.abort(), inactivityTimeoutMs);
  };
  resetInactivityTimer();
  try {
    const signal = init.signal ? AbortSignal.any([init.signal, inactivityController.signal]) : inactivityController.signal;
    const response = await fetch(url, { ...init, signal });
    if (!response.ok) {
      throw new RuntimeRequestError("runtime_http_error", `Runtime rejected ${url} with HTTP ${response.status} ${response.statusText}.`, url, inactivityTimeoutMs, response.status >= 500 || response.status === 408 || response.status === 429, response.status);
    }
    if (!response.body) throw new RuntimeRequestError("runtime_invalid_response", `Runtime returned an empty streaming body from ${url}.`, url, inactivityTimeoutMs, false);
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    const events: any[] = [];
    let buffered = "";
    let receivedBytes = 0;
    const consumeLine = (line: string) => {
      const trimmed = line.trim();
      if (!trimmed) return;
      let event: any;
      try {
        event = JSON.parse(trimmed);
      } catch (error) {
        throw new RuntimeRequestError("runtime_invalid_response", `Runtime returned invalid streaming JSON from ${url}.`, url, inactivityTimeoutMs, false, undefined, { cause: error as Error });
      }
      if (event?.error) throw new RuntimeRequestError("runtime_http_error", `Runtime reported an error while streaming from ${url}.`, url, inactivityTimeoutMs, false);
      events.push(event);
    };
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        resetInactivityTimer();
        receivedBytes += value.byteLength;
        if (receivedBytes > MAX_RUNTIME_RESPONSE_BYTES) throw new RuntimeRequestError("runtime_invalid_response", `Runtime response exceeded the 10 MiB safety limit: ${url}`, url, inactivityTimeoutMs, false);
        buffered += decoder.decode(value, { stream: true });
        let newline = buffered.indexOf("\n");
        while (newline !== -1) {
          consumeLine(buffered.slice(0, newline));
          buffered = buffered.slice(newline + 1);
          newline = buffered.indexOf("\n");
        }
      }
      buffered += decoder.decode();
      consumeLine(buffered);
    } finally {
      await reader.cancel().catch(() => undefined);
    }
    if (!events.length || events.at(-1)?.done !== true) {
      throw new RuntimeRequestError("runtime_invalid_response", `Runtime streaming response ended before a completion marker from ${url}.`, url, inactivityTimeoutMs, false);
    }
    return events;
  } catch (error) {
    if (error instanceof RuntimeRequestError) throw error;
    if (init.signal?.aborted && !inactivityController.signal.aborted) throw error;
    if (inactivityController.signal.aborted) {
      throw new RuntimeRequestError(
        "runtime_timeout",
        `Runtime produced no response activity for ${formatDuration(inactivityTimeoutMs)} while waiting for ${url}. The runtime may be loading, queued, or stalled.`,
        url,
        inactivityTimeoutMs,
        true,
        undefined,
        { cause: error as Error }
      );
    }
    throw new RuntimeRequestError("runtime_unavailable", `Could not connect to runtime endpoint ${url}.`, url, inactivityTimeoutMs, true, undefined, { cause: error as Error });
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function fetchOllamaChatStreamWithLoopbackFallback(url: string, init: RequestInit, inactivityTimeoutMs: number): Promise<any[]> {
  const attempts = [url];
  const parsed = new URL(url);
  if (["localhost", "::1", "[::1]"].includes(parsed.hostname)) {
    parsed.hostname = "127.0.0.1";
    attempts.push(parsed.toString());
  }
  let lastError: unknown;
  for (const attempt of Array.from(new Set(attempts))) {
    try {
      return await fetchOllamaChatStream(attempt, init, inactivityTimeoutMs);
    } catch (error) {
      if (init.signal?.aborted) throw error;
      if (error instanceof RuntimeRequestError && error.code !== "runtime_unavailable") throw error;
      lastError = error;
    }
  }
  const detail = lastError instanceof Error ? lastError.message : String(lastError);
  throw new RuntimeRequestError("runtime_unavailable", `Could not connect to runtime endpoint ${url}. Last error: ${detail}`, url, inactivityTimeoutMs, true, undefined, { cause: lastError as Error });
}

export async function chatWithRuntime(runtime: RuntimeConfig, request: ModelChatRequest): Promise<ModelChatResponse> {
  if (runtime.kind === "ollama") {
    const events = await fetchOllamaChatStreamWithLoopbackFallback(new URL("/api/chat", runtime.endpoint).toString(), {
      method: "POST",
      headers: { "content-type": "application/json" },
      signal: request.signal,
      body: JSON.stringify({
        model: request.model,
        messages: ollamaMessages(request.messages),
        tools: request.tools,
        stream: true,
        options: {
          temperature: request.temperature ?? 0.2,
          ...(request.maxOutputTokens ? { num_predict: request.maxOutputTokens } : {})
        }
      })
    }, runtime.timeoutMs);
    const content = events.map((event) => event.message?.content ?? "").join("");
    const thinking = events.map((event) => event.message?.thinking ?? "").join("");
    const streamedToolCalls = events.flatMap((event) => event.message?.tool_calls ?? []);
    const toolCalls = streamedToolCalls.map((call: any, index: number) => ({
      id: call.id ?? `call_${index}`,
      name: call.function?.name ?? call.name,
      arguments: parseToolArguments(call.function?.arguments ?? call.arguments)
    }));
    const final = events.at(-1) ?? {};
    const raw = { ...final, message: { ...(final.message ?? {}), content, thinking, tool_calls: streamedToolCalls } };
    return { content, toolCalls: toolCalls.length ? toolCalls : parseTextToolCalls(content), raw };
  }
  if (runtime.kind === "lmstudio" || runtime.kind === "llamacpp-server") {
    const data = await fetchJsonWithLoopbackFallback(new URL("/v1/chat/completions", runtime.endpoint).toString(), {
      method: "POST",
      headers: { "content-type": "application/json" },
      signal: request.signal,
      body: JSON.stringify({
        model: request.model,
        messages: openAiMessages(request.messages),
        tools: request.tools,
        temperature: request.temperature ?? 0.2,
        ...(request.maxOutputTokens ? { max_tokens: request.maxOutputTokens } : {})
      })
    }, runtime.timeoutMs);
    const message = data.choices?.[0]?.message ?? {};
    const toolCalls = (message.tool_calls ?? []).map((call: any, index: number) => ({
      id: call.id ?? `call_${index}`,
      name: call.function?.name,
      arguments: parseToolArguments(call.function?.arguments)
    }));
    const content = message.content ?? "";
    return { content, toolCalls: toolCalls.length ? toolCalls : parseTextToolCalls(content), raw: data };
  }
  return chatWithLlamaCli(runtime, request);
}

async function chatWithLlamaCli(runtime: RuntimeConfig, request: ModelChatRequest): Promise<ModelChatResponse> {
  if (!runtime.binaryPath || !runtime.modelPath) throw new Error("llama.cpp CLI runtime is missing binaryPath or modelPath.");
  const prompt = request.messages.map((message) => `${message.role.toUpperCase()}: ${message.content}`).join("\n\n");
  const args = ["-m", runtime.modelPath, "-p", prompt, "-n", String(request.maxOutputTokens ?? 2048), "--temp", String(request.temperature ?? 0.2)];
  const child = spawn(runtime.binaryPath, args, { stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";
  const appendBounded = (current: string, chunk: unknown) => `${current}${String(chunk)}`.slice(-10 * 1024 * 1024);
  child.stdout.on("data", (chunk) => { stdout = appendBounded(stdout, chunk); });
  child.stderr.on("data", (chunk) => { stderr = appendBounded(stderr, chunk); });
  const exitCode = await new Promise<number | null>((resolve) => {
    let settled = false;
    const finish = (code: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      request.signal?.removeEventListener("abort", abort);
      resolve(code);
    };
    const abort = () => {
      child.kill("SIGTERM");
      finish(-2);
    };
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      finish(-1);
    }, runtime.timeoutMs);
    request.signal?.addEventListener("abort", abort, { once: true });
    child.once("error", (error) => {
      stderr = appendBounded(stderr, error.message);
      finish(-3);
    });
    child.once("exit", finish);
  });
  if (exitCode !== 0) throw new Error(`llama.cpp exited with ${exitCode}: ${stderr}`);
  const content = stdout.trim();
  return { content, toolCalls: parseTextToolCalls(content), raw: { stderr } };
}

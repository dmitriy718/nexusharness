import { createServer, type Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { defaultMemoryEmbeddingSettings } from "../server/memory/config";
import { createEmbeddingProvider } from "../server/memory/providers";

const servers: Server[] = [];
afterEach(async () => { await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve())))); });

describe("HTTP embedding providers", () => {
  it("retries rate limits with bounded exponential backoff and preserves batch order", async () => {
    let requests = 0;
    const server = await embeddingServer((_body, response) => {
      requests += 1;
      if (requests < 3) return json(response, 429, { error: "rate limited" });
      return json(response, 200, { data: [{ index: 1, embedding: [0, 1, 0] }, { index: 0, embedding: [1, 0, 0] }], usage: { prompt_tokens: 4, total_tokens: 4 } });
    });
    const delays: number[] = [];
    const provider = createEmbeddingProvider({
      ...defaultMemoryEmbeddingSettings,
      provider: "openai-compatible",
      endpoint: endpoint(server, "/v1"),
      model: "embedding-test",
      dimensions: 3,
      batchSize: 2,
      maxRetries: 3
    }, {
      modelCacheDirectory: ".",
      random: () => 0.5,
      sleep: async (milliseconds) => { delays.push(milliseconds); }
    });
    const result = await provider.embedBatch(["first", "second"]);
    expect(requests).toBe(3);
    expect(delays).toEqual([250, 500]);
    expect(Array.from(result.vectors[0])).toEqual([1, 0, 0]);
    expect(Array.from(result.vectors[1])).toEqual([0, 1, 0]);
    expect(result.usage).toEqual({ inputTokens: 4, totalTokens: 4 });
    expect(result.retries).toBe(2);
  });

  it("classifies authentication, timeout, corrupt output, and dimension mismatch explicitly", async () => {
    const authentication = await embeddingServer((_body, response) => json(response, 401, { error: "no" }));
    const corrupt = await embeddingServer((_body, response) => json(response, 200, { data: [{ index: 0, embedding: [1, null, 0] }] }));
    const dimension = await embeddingServer((_body, response) => json(response, 200, { data: [{ index: 0, embedding: [1, 0] }] }));
    const timeout = await embeddingServer(() => undefined);
    const provider = (server: Server, dimensions: number | null) => createEmbeddingProvider({ ...defaultMemoryEmbeddingSettings, provider: "openai-compatible", endpoint: endpoint(server, "/v1"), model: "test", dimensions, maxRetries: 0 }, { modelCacheDirectory: "." });
    await expect(provider(authentication, 3).embed("hello")).rejects.toMatchObject({ code: "authentication", retryable: false });
    await expect(provider(corrupt, 3).embed("hello")).rejects.toMatchObject({ code: "invalid_response", retryable: false });
    await expect(provider(dimension, 3).embed("hello")).rejects.toMatchObject({ code: "dimension_mismatch", retryable: false });
    await expect(createEmbeddingProvider({ ...defaultMemoryEmbeddingSettings, provider: "openai-compatible", endpoint: endpoint(timeout, "/v1"), model: "test", dimensions: 3, maxRetries: 0, timeoutMs: 1000 }, { modelCacheDirectory: "." }).embed("hello")).rejects.toMatchObject({ code: "timeout", retryable: true });
  });

  it("uses Ollama's real embed contract without assuming a fixed dimension", async () => {
    const server = await embeddingServer((body, response) => {
      expect(body).toMatchObject({ model: "nomic-embed-text", input: ["one", "two"], truncate: false });
      json(response, 200, { embeddings: [[3, 4], [0, 5]], prompt_eval_count: 2 });
    });
    const provider = createEmbeddingProvider({ ...defaultMemoryEmbeddingSettings, provider: "ollama", endpoint: endpoint(server), model: "nomic-embed-text", dimensions: null, batchSize: 2 }, { modelCacheDirectory: "." });
    const result = await provider.embedBatch(["one", "two"]);
    expect(result.descriptor.dimension).toBe(2);
    expect(Array.from(result.vectors[0])).toEqual([0.6000000238418579, 0.800000011920929]);
  });
});

async function embeddingServer(handler: (body: any, response: import("node:http").ServerResponse) => void | Promise<void>): Promise<Server> {
  const server = createServer(async (request, response) => {
    let raw = "";
    for await (const chunk of request) raw += chunk;
    await handler(raw ? JSON.parse(raw) : {}, response);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  servers.push(server);
  return server;
}

function endpoint(server: Server, path = ""): string {
  return `http://127.0.0.1:${(server.address() as { port: number }).port}${path}`;
}

function json(response: import("node:http").ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
}

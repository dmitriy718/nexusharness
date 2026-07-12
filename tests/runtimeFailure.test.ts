import { createServer, type RequestListener, type Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { classifyRunFailure } from "../server/agentLoop";
import { chatWithRuntime, RuntimeRequestError } from "../server/runtimeAdapters";
import type { RuntimeConfig, Settings, TaskRun } from "../server/types";

const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map(async (server) => {
    server.closeAllConnections?.();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }));
});

describe("runtime request failure classification", () => {
  it("distinguishes a model deadline from endpoint unavailability", async () => {
    const endpoint = await runtimeServer(() => undefined);
    const runtime = runtimeConfig(endpoint, 40);
    await expect(chatWithRuntime(runtime, { model: "slow-model", messages: [{ role: "user", content: "work" }] })).rejects.toMatchObject({
      name: "RuntimeRequestError",
      code: "runtime_timeout",
      timeoutMs: 40,
      retryable: true
    });
  });

  it("preserves operator cancellation instead of mislabeling it as a runtime outage", async () => {
    const endpoint = await runtimeServer(() => undefined);
    const controller = new AbortController();
    const request = chatWithRuntime(runtimeConfig(endpoint, 5000), { model: "model", messages: [{ role: "user", content: "work" }], signal: controller.signal });
    controller.abort();
    await expect(request).rejects.toMatchObject({ name: "AbortError" });
  });

  it("classifies HTTP rejection without retaining the provider response body", async () => {
    const endpoint = await runtimeServer((_request, response) => {
      response.writeHead(503, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: "private provider detail" }));
    });
    const runtime = runtimeConfig(endpoint, 1000);
    try {
      await chatWithRuntime(runtime, { model: "model", messages: [{ role: "user", content: "work" }] });
      throw new Error("Expected runtime request to fail.");
    } catch (error) {
      expect(error).toMatchObject({ code: "runtime_http_error", status: 503, retryable: true });
      expect((error as Error).message).not.toContain("private provider detail");
    }
  });

  it("turns timeout context into specific operator corrections", () => {
    const error = Object.assign(new RuntimeRequestError("runtime_timeout", "Runtime request timed out after 60 seconds.", "http://127.0.0.1:11434/api/chat", 60_000, true), {
      agentRole: "executor",
      subtask: "Develop Home Page",
      runtimeId: "runtime-1",
      runtimeName: "Local Ollama",
      runtimeKind: "ollama",
      runtimeEndpoint: "http://127.0.0.1:11434",
      runtimeTimeoutMs: 60_000,
      model: "qwen2.5-coder:14b"
    });
    const failure = classifyRunFailure(error, run(), settings());
    expect(failure).toMatchObject({ code: "runtime_timeout", agentRole: "executor", subtask: "Develop Home Page", timeoutMs: 60_000, retryable: true });
    expect(failure.summary).toContain("qwen2.5-coder:14b");
    expect(failure.corrections.join(" ")).toContain("Reduce Max parallel executors from 3 to 1");
  });
});

async function runtimeServer(handler: RequestListener): Promise<string> {
  const server = createServer(handler);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Runtime fixture did not bind a TCP port.");
  return `http://127.0.0.1:${address.port}`;
}

function runtimeConfig(endpoint: string, timeoutMs: number): RuntimeConfig {
  return { id: "runtime-1", name: "Test runtime", kind: "ollama", endpoint, timeoutMs };
}

function run(): TaskRun {
  return { id: "run-1", task: "Build site", status: "failed", phase: "execute", iteration: 1, maxIterations: 5, log: [], createdAt: "2026-07-12T00:00:00.000Z", updatedAt: "2026-07-12T00:01:00.000Z" };
}

function settings(): Settings {
  return {
    workspaceRoot: ".", layout: "chat", maxIterations: 5, maxParallelExecutors: 3, criticThreshold: 7, approvalMode: false,
    shellPath: "powershell.exe", testCommand: "", lintCommand: "", mcpAutoDiscovery: false, mcpPortStart: 3000, mcpPortEnd: 9999,
    memoryTokenBudget: 2000, agentModels: { executor: "runtime-1:qwen2.5-coder:14b" }
  };
}

import { spawn, type ChildProcess } from "node:child_process";
import { createServer, type Server } from "node:http";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { defaultMemoryEmbeddingSettings, defaultMemoryRetrievalSettings } from "../server/memory/config";
import { createEmbeddingProvider } from "../server/memory/providers";
import type { Settings, StoreShape } from "../server/types";

describe.sequential("memory retrieval through the normal API and Planner context", () => {
  let modelServer: Server;
  let apiProcess: ChildProcess;
  let dataDirectory: string;
  let apiBase: string;
  let plannerPrompt = "";
  let apiOutput = "";

  beforeAll(async () => {
    const localProvider = createEmbeddingProvider(
      { ...defaultMemoryEmbeddingSettings, allowModelDownload: true, timeoutMs: 120_000 },
      { modelCacheDirectory: path.resolve(".nexusharness/embedding-models") }
    );
    await localProvider.embed("E2E neural embedding warmup.");
    modelServer = createServer(async (request, response) => {
      try {
        const body = await requestBody(request);
        if (request.url === "/v1/embeddings") {
          const input = Array.isArray(body.input) ? body.input.map(String) : [String(body.input ?? "")];
          const embedded = await localProvider.embedBatch(input);
          json(response, 200, { data: embedded.vectors.map((vector, index) => ({ index, embedding: Array.from(vector) })), model: localProvider.descriptor.model });
          return;
        }
        if (request.url === "/api/tags") {
          json(response, 200, { models: [{ name: "chat-model", details: { family: "test" } }] });
          return;
        }
        if (request.url === "/api/chat") {
          const messages = Array.isArray(body.messages) ? body.messages as Array<{ role: string; content: string }> : [];
          const system = messages.find((message) => message.role === "system")?.content ?? "";
          const user = messages.find((message) => message.role === "user")?.content ?? "";
          if (system.includes("Planner agent")) {
            plannerPrompt = user;
            json(response, 200, { message: { content: '["Implement and verify the requested recovery workflow"]' }, done: true });
          } else if (system.includes("Critic agent")) {
            json(response, 200, { message: { content: '{"score":9,"issues":[],"recommendation":"accept"}' }, done: true });
          } else if (system.includes("structured retrospective")) {
            json(response, 200, { message: { content: "The retrieval-backed plan preserved recovery guidance and validation." }, done: true });
          } else {
            json(response, 200, { message: { content: "Implemented the bounded recovery workflow with verification evidence." }, done: true });
          }
          return;
        }
        json(response, 404, { error: "not found" });
      } catch (error) {
        json(response, 500, { error: error instanceof Error ? error.message : String(error) });
      }
    });
    await listen(modelServer);
    const modelPort = (modelServer.address() as { port: number }).port;
    dataDirectory = await mkdtemp(path.join(tmpdir(), "nexus-memory-e2e-"));
    const apiPort = await availablePort();
    const settings = settingsFixture(path.join(dataDirectory, "workspace"), modelPort);
    const store: StoreShape = {
      settings,
      runtimes: [{ id: "runtime-e2e", name: "E2E runtime", kind: "ollama", endpoint: `http://127.0.0.1:${modelPort}`, timeoutMs: 30_000 }],
      mcpServers: [],
      memory: [{
        id: "unauthorized", namespace: "workspace:00000000000000000000000000000000", kind: "context", taskType: "database",
        title: "Other workspace secret", content: "Never expose the confidential glacier restore password.", pinned: true, source: "other-workspace",
        createdAt: "2026-07-11T00:00:00.000Z", updatedAt: "2026-07-11T00:00:00.000Z"
      }],
      audit: [], approvals: [], runs: []
    };
    await writeFile(path.join(dataDirectory, "store.json"), JSON.stringify(store, null, 2), "utf8");
    apiProcess = spawn(process.execPath, [path.resolve("node_modules/tsx/dist/cli.mjs"), "server/index.ts"], {
      cwd: process.cwd(), windowsHide: true,
      env: { ...process.env, NEXUSHARNESS_PORT: String(apiPort), NEXUSHARNESS_DATA_DIR: dataDirectory },
      stdio: ["ignore", "pipe", "pipe"]
    });
    apiProcess.stdout?.on("data", (chunk) => { apiOutput = `${apiOutput}${String(chunk)}`.slice(-20_000); });
    apiProcess.stderr?.on("data", (chunk) => { apiOutput = `${apiOutput}${String(chunk)}`.slice(-20_000); });
    apiBase = `http://127.0.0.1:${apiPort}`;
    try { await waitFor(`${apiBase}/api/health`, 30_000); }
    catch (error) { throw new Error(`${error instanceof Error ? error.message : String(error)}\nAPI output:\n${apiOutput}`); }
  }, 180_000);

  afterAll(async () => {
    apiProcess?.kill();
    await new Promise<void>((resolve) => modelServer?.close(() => resolve()) ?? resolve());
    if (dataDirectory) await rm(dataDirectory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });

  it("embeds a public API memory and injects a paraphrase match into the actual Planner prompt", async () => {
    const created = await requestJson(`${apiBase}/api/memory`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ kind: "context", taskType: "database", title: "Data protection", content: "Create a verified backup prior to deleting production records.", pinned: false, source: "operator", importance: 0.8 })
    });
    expect(created.indexing).toMatchObject({ status: "indexed", chunkCount: 1 });
    const diagnostics = await requestJson(`${apiBase}/api/memory/diagnostics`);
    expect(diagnostics).toMatchObject({ retrievalMode: "hybrid", indexedMemories: 1, failedMemories: 0 });
    expect(diagnostics.activeGeneration).toMatch(/^[a-f0-9]{64}$/);
    const publicState = await requestJson(`${apiBase}/api/state?compact=1`);
    expect(publicState.memory.map((memory: { id: string }) => memory.id)).not.toContain("unauthorized");

    const run = await requestJson(`${apiBase}/api/tasks`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ task: "Ensure lost information can be restored following destructive operations." })
    });
    const completed = await waitForRun(run.id, 60_000);
    expect(completed.run).toMatchObject({ status: "passed", phase: "done" });
    expect(plannerPrompt).toContain("Create a verified backup prior to deleting production records.");
    expect(plannerPrompt).toContain("untrusted reference data");
    expect(plannerPrompt).not.toContain("confidential glacier restore password");
    expect(completed.audit.some((event: { action: string; details?: { mode?: string; status?: string } }) => event.action === "memory.retrieve" && event.details?.mode === "hybrid" && event.details?.status === "ok")).toBe(true);
  }, 120_000);

  async function waitForRun(id: string, timeoutMs: number): Promise<any> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const detail = await requestJson(`${apiBase}/api/runs/${id}`);
      if (["passed", "failed", "canceled"].includes(detail.run.status)) return detail;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error(`Timed out waiting for run ${id}.`);
  }
});

function settingsFixture(workspaceRoot: string, modelPort: number): Settings {
  return {
    workspaceRoot, layout: "chat", maxIterations: 1, maxParallelExecutors: 1, criticThreshold: 7, approvalMode: false,
    shellPath: "powershell.exe", testCommand: "", lintCommand: "", mcpAutoDiscovery: false, mcpPortStart: 3000, mcpPortEnd: 3001,
    memoryTokenBudget: 600, memoryRetrieval: { ...defaultMemoryRetrievalSettings, mode: "hybrid", minimumSemanticScore: 0.1 },
    memoryEmbeddings: { ...defaultMemoryEmbeddingSettings, provider: "openai-compatible", model: "Xenova/all-MiniLM-L6-v2", endpoint: `http://127.0.0.1:${modelPort}/v1`, allowRemoteContent: false, dimensions: 384 },
    agentModels: { planner: "runtime-e2e:chat-model", executor: "runtime-e2e:chat-model", critic: "runtime-e2e:chat-model" }
  };
}

function requestBody(request: import("node:http").IncomingMessage): Promise<any> {
  return new Promise((resolve, reject) => {
    let body = "";
    request.on("data", (chunk) => { body += chunk; });
    request.on("end", () => { try { resolve(body ? JSON.parse(body) : {}); } catch (error) { reject(error); } });
    request.on("error", reject);
  });
}

function json(response: import("node:http").ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
}

function listen(server: Server): Promise<void> {
  return new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
}

async function availablePort(): Promise<number> {
  const server = createServer();
  await listen(server);
  const port = (server.address() as { port: number }).port;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

async function waitFor(url: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let last = "no response";
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
      last = `${response.status}: ${await response.text()}`;
    } catch (error) { last = error instanceof Error ? error.message : String(error); }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out waiting for ${url}. Last response: ${last}`);
}

async function requestJson(url: string, init?: RequestInit): Promise<any> {
  const response = await fetch(url, init);
  const body = await response.json();
  if (!response.ok) throw new Error(`${response.status}: ${JSON.stringify(body)}`);
  return body;
}

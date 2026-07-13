import { spawn, type ChildProcess } from "node:child_process";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Settings, StoreShape } from "../server/types";

describe.sequential("JSON-fallback executor completion", () => {
  let modelServer: Server;
  let apiProcess: ChildProcess;
  let dataDirectory = "";
  let workspace = "";
  let apiBase = "";
  let apiOutput = "";

  beforeAll(async () => {
    modelServer = createServer(async (request, response) => {
      const body = await requestBody(request);
      if (request.url === "/api/tags") return json(response, 200, { models: [{ name: "fallback-model" }] });
      if (request.url !== "/api/chat") return json(response, 404, { error: "not found" });
      const messages = Array.isArray(body.messages) ? body.messages as Array<{ role: string; content: string }> : [];
      const system = messages.find((message) => message.role === "system")?.content ?? "";
      if (system.includes("Planner agent")) return ollama(response, '["Create and verify status.txt"]');
      if (system.includes("structured retrospective")) return ollama(response, "The harness preserved objective evidence at its action boundary.");
      if (system.includes("Critic agent")) return ollama(response, '{"score":8,"issues":[],"recommendation":"accept"}');
      const toolResults = messages.filter((message) => message.role === "tool").length;
      if (toolResults === 0) return ollama(response, '{"name":"file_write","arguments":{"path":"status.txt","content":"BOUNDARY_READY\\n"}}');
      return ollama(response, JSON.stringify({ name: "file_read", arguments: { path: "status.txt", offset: toolResults, limit: 100 } }));
    });
    await listen(modelServer);
    const modelPort = (modelServer.address() as { port: number }).port;
    dataDirectory = await mkdtemp(path.join(tmpdir(), "nexus-fallback-e2e-"));
    workspace = path.join(dataDirectory, "workspace");
    await mkdir(workspace, { recursive: true });
    const apiPort = await availablePort();
    const store: StoreShape = {
      settings: settingsFixture(workspace),
      runtimes: [{ id: "runtime-fallback", name: "Fallback runtime", kind: "ollama", endpoint: `http://127.0.0.1:${modelPort}`, timeoutMs: 30_000 }],
      mcpServers: [], memory: [], audit: [], approvals: [], runs: []
    };
    await writeFile(path.join(dataDirectory, "store.json"), JSON.stringify(store, null, 2), "utf8");
    apiProcess = spawn(process.execPath, [path.resolve("node_modules/tsx/dist/cli.mjs"), "server/index.ts"], {
      cwd: process.cwd(), windowsHide: true,
      env: {
        ...process.env,
        NEXUSHARNESS_PORT: String(apiPort),
        NEXUSHARNESS_DATA_DIR: dataDirectory,
        NEXUSHARNESS_EXECUTION_MODE: "transactional",
        NEXUSHARNESS_EXECUTION_DIR: path.join(dataDirectory, "transactions"),
        NEXUSHARNESS_RUN_EXPORT_DIR: path.join(dataDirectory, "exports")
      },
      stdio: ["ignore", "pipe", "pipe"]
    });
    apiProcess.stdout?.on("data", (chunk) => { apiOutput = `${apiOutput}${String(chunk)}`.slice(-20_000); });
    apiProcess.stderr?.on("data", (chunk) => { apiOutput = `${apiOutput}${String(chunk)}`.slice(-20_000); });
    apiBase = `http://127.0.0.1:${apiPort}`;
    try { await waitFor(`${apiBase}/api/health`, 20_000); }
    catch (error) { throw new Error(`${error instanceof Error ? error.message : String(error)}\n${apiOutput}`); }
  }, 30_000);

  afterAll(async () => {
    apiProcess?.kill();
    await new Promise<void>((resolve) => modelServer?.close(() => resolve()) ?? resolve());
    if (dataDirectory) await rm(dataDirectory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });

  it("executes direct calls and forwards bounded tool evidence to validation instead of failing", async () => {
    const started = await requestJson(`${apiBase}/api/tasks`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ task: "Create a verified boundary status file." })
    });
    const completed = await waitForRun(apiBase, started.id, 30_000);
    expect(completed.run).toMatchObject({ status: "passed", phase: "done", criticScore: 8 });
    expect(completed.run.executorOutput).toContain("NexusHarness reached the 16-turn action boundary");
    expect(completed.run.executorOutput).toContain("NexusHarness observed tool evidence");
    expect(completed.run.validationOutput).toContain("Tests (");
    expect(started.workspaceRoot).toBe(path.join(dataDirectory, "exports", started.id));
    expect(await readFile(path.join(started.workspaceRoot, "status.txt"), "utf8")).toBe("BOUNDARY_READY\n");
  }, 30_000);
});

function settingsFixture(workspaceRoot: string): Settings {
  return {
    workspaceRoot, layout: "chat", maxIterations: 1, maxParallelExecutors: 1, criticThreshold: 7, approvalMode: false,
    shellPath: process.platform === "win32" ? "powershell.exe" : "/bin/sh",
    testCommand: process.platform === "win32"
      ? "$value = (Get-Content -Raw -LiteralPath '.\\status.txt').Trim(); if ($value -ne 'BOUNDARY_READY') { exit 1 }"
      : "test \"$(cat status.txt)\" = \"BOUNDARY_READY\"",
    lintCommand: "", mcpAutoDiscovery: false, mcpPortStart: 3000, mcpPortEnd: 3001, memoryTokenBudget: 100,
    agentModels: { planner: "runtime-fallback:fallback-model", executor: "runtime-fallback:fallback-model", critic: "runtime-fallback:fallback-model" }
  };
}

function ollama(response: ServerResponse, content: string): void {
  response.writeHead(200, { "content-type": "application/x-ndjson" });
  response.end(`${JSON.stringify({ message: { content }, done: true })}\n`);
}

function requestBody(request: IncomingMessage): Promise<any> {
  return new Promise((resolve, reject) => {
    let body = "";
    request.on("data", (chunk) => { body += chunk; });
    request.on("end", () => { try { resolve(body ? JSON.parse(body) : {}); } catch (error) { reject(error); } });
    request.on("error", reject);
  });
}

function json(response: ServerResponse, status: number, body: unknown): void {
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
  while (Date.now() < deadline) {
    try { if ((await fetch(url)).ok) return; } catch { /* startup retry */ }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out waiting for ${url}.`);
}

async function requestJson(url: string, init?: RequestInit): Promise<any> {
  const response = await fetch(url, init);
  const body = await response.json();
  if (!response.ok) throw new Error(`${response.status}: ${JSON.stringify(body)}`);
  return body;
}

async function waitForRun(apiBase: string, id: string, timeoutMs: number): Promise<any> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const detail = await requestJson(`${apiBase}/api/runs/${id}`);
    if (["passed", "failed", "canceled"].includes(detail.run.status)) return detail;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out waiting for run ${id}.`);
}

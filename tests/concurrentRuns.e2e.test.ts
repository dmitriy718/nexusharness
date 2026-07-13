import { spawn, type ChildProcess } from "node:child_process";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Settings, StoreShape } from "../server/types";

describe.sequential("concurrent isolated runs", () => {
  let modelServer: Server;
  let apiProcess: ChildProcess;
  let dataDirectory = "";
  let apiBase = "";
  let apiOutput = "";

  beforeAll(async () => {
    modelServer = createServer(async (request, response) => {
      const body = await requestBody(request);
      if (request.url === "/api/tags") return json(response, 200, { models: [{ name: "concurrent-model" }] });
      if (request.url !== "/api/chat") return json(response, 404, { error: "not found" });
      const messages = Array.isArray(body.messages) ? body.messages as Array<{ role: string; content: string }> : [];
      const system = messages.find((message) => message.role === "system")?.content ?? "";
      const context = messages.map((message) => message.content).join("\n");
      const label = context.includes("ALPHA") ? "ALPHA" : "BETA";
      if (system.includes("Planner agent")) return ollama(response, '["Create and verify result.txt"]');
      if (system.includes("structured retrospective")) return ollama(response, `Concurrent ${label} export remained isolated.`);
      if (system.includes("Critic agent")) return ollama(response, '{"score":9,"issues":[],"recommendation":"accept"}');
      const toolResults = messages.filter((message) => message.role === "tool").length;
      return ollama(response, toolResults
        ? `Created and verified the isolated ${label} result.`
        : JSON.stringify({ name: "file_write", arguments: { path: "result.txt", content: `${label}\n` } }));
    });
    await listen(modelServer);
    const modelPort = (modelServer.address() as { port: number }).port;
    dataDirectory = await mkdtemp(path.join(tmpdir(), "nexus-concurrent-runs-"));
    const sourceWorkspace = path.join(dataDirectory, "source");
    await mkdir(sourceWorkspace);
    const apiPort = await availablePort();
    const store: StoreShape = {
      settings: settingsFixture(sourceWorkspace),
      runtimes: [{ id: "runtime-concurrent", name: "Concurrent runtime", kind: "ollama", endpoint: `http://127.0.0.1:${modelPort}`, timeoutMs: 30_000 }],
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

  it("executes different run IDs concurrently in independent exports and transaction cells", async () => {
    const [alpha, beta] = await Promise.all([
      start("Create result.txt containing ALPHA."),
      start("Create result.txt containing BETA.")
    ]);
    expect(alpha.id).not.toBe(beta.id);
    expect(alpha.workspaceRoot).not.toBe(beta.workspaceRoot);
    const [alphaDetail, betaDetail] = await Promise.all([waitForRun(alpha.id), waitForRun(beta.id)]);
    expect(alphaDetail.run).toMatchObject({ status: "passed", phase: "done", criticScore: 9 });
    expect(betaDetail.run).toMatchObject({ status: "passed", phase: "done", criticScore: 9 });
    expect(alphaDetail.run.execution.cellId).not.toBe(betaDetail.run.execution.cellId);
    await expect(readFile(path.join(alpha.workspaceRoot, "result.txt"), "utf8")).resolves.toBe("ALPHA\n");
    await expect(readFile(path.join(beta.workspaceRoot, "result.txt"), "utf8")).resolves.toBe("BETA\n");
  }, 30_000);

  function start(task: string): Promise<any> {
    return requestJson(`${apiBase}/api/tasks`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ task }) });
  }

  async function waitForRun(id: string): Promise<any> {
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      const detail = await requestJson(`${apiBase}/api/runs/${id}`);
      if (["passed", "failed", "canceled"].includes(detail.run.status)) return detail;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error(`Timed out waiting for run ${id}.`);
  }
});

function settingsFixture(workspaceRoot: string): Settings {
  return {
    workspaceRoot, layout: "chat", maxIterations: 1, maxParallelExecutors: 1, criticThreshold: 7, approvalMode: false,
    shellPath: process.platform === "win32" ? "powershell.exe" : "/bin/sh", testCommand: "", lintCommand: "",
    mcpAutoDiscovery: false, mcpPortStart: 3000, mcpPortEnd: 3001, memoryTokenBudget: 100,
    agentModels: { planner: "runtime-concurrent:concurrent-model", executor: "runtime-concurrent:concurrent-model", critic: "runtime-concurrent:concurrent-model" }
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

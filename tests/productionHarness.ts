import { chromium, type Browser, type BrowserContext, type BrowserContextOptions } from "playwright-core";
import { createServer, request as proxyRequest, type Server } from "node:http";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import type { Store } from "../src/api/types";

export const root = resolve(import.meta.dirname, "..");
const dist = join(root, "dist");
const now = "2026-07-11T08:00:00.000Z";
const fixtureDisplayWorkspace = "C:\\Workspaces\\Nexus";

export class ProductionHarness {
  browser!: Browser;
  private dataDir = "";
  private apiProcess?: ChildProcess;
  private appServer?: Server;
  private appPort = 0;

  constructor(private readonly store?: Store) {}

  async start() {
    this.dataDir = mkdtempSync(join(tmpdir(), "nexusharness-browser-"));
    const workspaceRoot = createWorkspaceFixture(this.dataDir);
    const store = structuredClone(this.store ?? fixture(workspaceRoot));
    store.settings.workspaceRoot = workspaceRoot;
    writeFileSync(join(this.dataDir, "store.json"), JSON.stringify(store, null, 2));
    const apiPort = await availablePort();
    this.apiProcess = spawn(process.execPath, ["dist-server/server/index.js"], {
      cwd: root,
      env: { ...process.env, NEXUSHARNESS_PORT: String(apiPort), NEXUSHARNESS_DATA_DIR: this.dataDir },
      stdio: "ignore",
      windowsHide: true
    });
    await waitFor(`http://127.0.0.1:${apiPort}/api/health`);
    this.appServer = createAppServer(apiPort);
    await new Promise<void>((resolveListen) => this.appServer!.listen(0, "127.0.0.1", resolveListen));
    this.appPort = (this.appServer.address() as { port: number }).port;
    this.browser = await chromium.launch({ channel: "chrome", headless: true });
  }

  async stop() {
    await this.browser?.close();
    await new Promise<void>((resolveClose) => this.appServer?.close(() => resolveClose()) ?? resolveClose());
    if (this.apiProcess && this.apiProcess.exitCode === null) {
      const exited = new Promise<void>((resolveExit) => this.apiProcess!.once("exit", () => resolveExit()));
      this.apiProcess.kill();
      await Promise.race([exited, new Promise<void>((resolveTimeout) => setTimeout(resolveTimeout, 5_000))]);
    }
    if (this.dataDir) rmSync(this.dataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }

  newContext(options: BrowserContextOptions = {}): Promise<BrowserContext> {
    return this.browser.newContext(options);
  }

  url(route: string) {
    return `http://127.0.0.1:${this.appPort}${route}`;
  }
}

async function availablePort() {
  const server = createServer();
  await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
  const port = (server.address() as { port: number }).port;
  await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
  return port;
}

async function waitFor(url: string) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    try { if ((await fetch(url)).ok) return; } catch { /* startup retry */ }
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  }
  throw new Error(`Timed out waiting for ${url}`);
}

function createAppServer(targetPort: number) {
  return createServer((request, response) => {
    if (request.url?.startsWith("/api")) {
      const outgoing = proxyRequest({ hostname: "127.0.0.1", port: targetPort, path: request.url, method: request.method, headers: request.headers }, (incoming) => {
        response.writeHead(incoming.statusCode ?? 500, incoming.headers);
        incoming.pipe(response);
      });
      outgoing.on("error", (error) => { response.statusCode = 502; response.end(error.message); });
      request.pipe(outgoing);
      return;
    }
    const pathname = decodeURIComponent(new URL(request.url ?? "/", "http://local").pathname);
    let file = join(dist, pathname === "/" ? "index.html" : pathname.slice(1));
    if (!file.startsWith(dist) || !existsSync(file) || statSync(file).isDirectory()) file = join(dist, "index.html");
    const extension = file.split(".").at(-1);
    response.setHeader("content-type", extension === "js" ? "text/javascript" : extension === "css" ? "text/css" : extension === "svg" ? "image/svg+xml" : "text/html");
    response.end(readFileSync(file));
  });
}

export function fixture(workspaceRoot = root): Store {
  return {
    settings: { workspaceRoot, layout: "chat", maxIterations: 5, maxParallelExecutors: 3, criticThreshold: 7, approvalMode: true, shellPath: "powershell.exe", testCommand: "npm test", lintCommand: "npm run lint", mcpAutoDiscovery: true, mcpPortStart: 3000, mcpPortEnd: 3499, memoryTokenBudget: 2000, agentModels: { planner: "Local Coder", executor: "Local Coder", critic: "Local Coder" } },
    runtimes: [{ id: "runtime-a11y", name: "Local runtime", kind: "ollama", endpoint: "http://127.0.0.1:1", timeoutMs: 1000 }],
    mcpServers: [{ id: "mcp-a11y", name: "Workspace tools", endpoint: "http://127.0.0.1:1/mcp", transport: "http", enabled: true, status: "online", tools: [{ name: "read_file", description: "Read a bounded file.", inputSchema: { type: "object", properties: { path: { type: "string" } } }, enabled: true }] }],
    memory: [{ id: "memory-a11y", kind: "context", taskType: "frontend", title: "Accessible interfaces", content: "Preserve keyboard operation and programmatic labels.", source: "operator", pinned: true, createdAt: now, updatedAt: now }],
    audit: [{ id: "audit-a11y", at: now, actor: "executor", action: "shell_request", risk: "execute", status: "pending", message: "Approval requested for validation.", details: { runId: "run-a11y", command: "npm test", cwd: fixtureDisplayWorkspace } }],
    approvals: [{ id: "approval-a11y", createdAt: now, actor: "executor", action: "shell_execute", risk: "execute", payload: { command: "npm test", shell: "powershell.exe", cwd: fixtureDisplayWorkspace }, runId: "run-a11y", subtask: "Validate accessibility", decision: "pending" }],
    runs: [{ id: "run-a11y", task: "Verify the accessible v2 workspace", status: "passed", phase: "done", iteration: 1, maxIterations: 5, plan: ["Inspect routes", "Verify keyboard", "Record results"], subtaskResults: [{ subtask: "Inspect routes", output: "No automated violations." }, { subtask: "Verify keyboard", output: "Keyboard paths passed." }, { subtask: "Record results", output: "Evidence saved." }], executorOutput: "Accessibility routes inspected.", criticFeedback: "Keyboard and focus behavior verified.", criticScore: 9, validationOutput: "All checks passed.", result: "Ready for manual assistive-technology review.", createdAt: now, updatedAt: now }]
  };
}

function createWorkspaceFixture(dataDir: string): string {
  const workspace = join(dataDir, "nexus");
  for (const directory of ["docs", "src", "tests"]) mkdirSync(join(workspace, directory), { recursive: true });
  writeFileSync(join(workspace, "README.md"), "# Fixture workspace\n", "utf8");
  writeFileSync(join(workspace, "package.json"), '{"name":"fixture-workspace"}\n', "utf8");
  writeFileSync(join(workspace, "docs", "guide.md"), "# Guide\n", "utf8");
  writeFileSync(join(workspace, "src", "main.ts"), "export const ready = true;\n", "utf8");
  writeFileSync(join(workspace, "tests", "main.test.ts"), "// deterministic fixture\n", "utf8");
  return workspace;
}

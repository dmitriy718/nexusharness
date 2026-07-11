import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright-core";
import AxeBuilder from "@axe-core/playwright";
import { createServer, request as proxyRequest, type Server } from "node:http";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

const enabled = process.env.npm_lifecycle_event === "test:a11y";
const suite = enabled ? describe : describe.skip;
const root = resolve(import.meta.dirname, "..");
const dist = join(root, "dist");
let dataDir = "";
const now = "2026-07-11T08:00:00.000Z";
let apiPort = 0;
let appPort = 0;
let apiProcess: ChildProcess | undefined;
let appServer: Server | undefined;
let browser: Browser | undefined;
let context: BrowserContext | undefined;
let page: Page | undefined;

suite("production accessibility contract", () => {
  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), "nexusharness-a11y-"));
    writeFileSync(join(dataDir, "store.json"), JSON.stringify(fixture(), null, 2));
    apiPort = await availablePort();
    apiProcess = spawn(process.execPath, ["dist-server/server/index.js"], {
      cwd: root,
      env: { ...process.env, NEXUSHARNESS_PORT: String(apiPort), NEXUSHARNESS_DATA_DIR: dataDir },
      stdio: "ignore",
      windowsHide: true
    });
    await waitFor(`http://127.0.0.1:${apiPort}/api/health`);
    appServer = createAppServer(apiPort);
    await new Promise<void>((resolveListen) => appServer!.listen(0, "127.0.0.1", resolveListen));
    appPort = (appServer.address() as { port: number }).port;
    browser = await chromium.launch({ channel: "chrome", headless: true });
    context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    page = await context.newPage();
  }, 30_000);

  afterAll(async () => {
    await browser?.close();
    await new Promise<void>((resolveClose) => appServer?.close(() => resolveClose()) ?? resolveClose());
    apiProcess?.kill();
    if (dataDir) rmSync(dataDir, { recursive: true, force: true });
  });

  it("has no detectable WCAG A/AA violations on every major route and state", async () => {
    const routes = [
      "/onboarding", "/dashboard", "/runs", "/runs/run-a11y", "/agents", "/models", "/tools",
      "/workspace", "/memory", "/approvals", "/audit", "/settings/workspace", "/settings/execution",
      "/settings/safety", "/settings/integrations", "/settings/memory", "/settings/appearance", "/settings/advanced"
    ];
    for (const route of routes) {
      await open(route);
      await assertAxe(route);
    }
    await open("/runs/run-a11y");
    for (const mode of ["studio", "orchestrate"]) {
      await page!.getByRole("button", { name: mode, exact: true }).click();
      await assertAxe(`run ${mode}`);
    }
    await open("/models");
    await page!.getByRole("button", { name: "Add runtime" }).click();
    await assertAxe("runtime setup");
    await open("/tools");
    await page!.getByRole("button", { name: "Add server" }).click();
    await assertAxe("MCP setup");
    await open("/memory");
    await page!.getByRole("button", { name: "Add memory" }).click();
    await assertAxe("memory editor");
    await open("/audit");
    await page!.locator(".audit-review-button").first().click();
    await assertAxe("audit event dialog");
  }, 60_000);

  it("moves focus on routes and traps then returns it for drawers", async () => {
    await open("/dashboard");
    await page!.getByRole("link", { name: "Runs", exact: true }).click();
    await expect.poll(() => page!.evaluate(() => document.activeElement?.id)).toBe("main-content");
    expect(await page!.title()).toBe("Runs · NexusHarness");

    await open("/audit");
    const review = page!.locator(".audit-review-button").first();
    await review.focus();
    await review.click();
    await expect.poll(() => page!.evaluate(() => document.activeElement?.getAttribute("aria-label"))).toBe("Close event detail");
    await page!.keyboard.press("Escape");
    await expect.poll(() => page!.locator(".audit-inspector").count()).toBe(0);
    expect(await review.evaluate((element) => element === document.activeElement)).toBe(true);
  });

  it("supports arrow-key tabs and disclosure-list workspace navigation", async () => {
    await open("/tools");
    const firstTab = page!.getByRole("tab", { name: /MCP servers/ });
    await firstTab.focus();
    await page!.keyboard.press("ArrowRight");
    expect(await page!.getByRole("tab", { name: /Local tools/ }).getAttribute("aria-selected")).toBe("true");

    await open("/workspace");
    const nodes = page!.locator(".workspace-node-button");
    await nodes.first().focus();
    await page!.keyboard.press("ArrowDown");
    expect(await nodes.nth(1).evaluate((element) => element === document.activeElement)).toBe(true);
  });

  it("reflows at 320 CSS pixels and at a 200 percent content zoom", async () => {
    const narrow = await browser!.newContext({ viewport: { width: 320, height: 800 } });
    const narrowPage = await narrow.newPage();
    for (const route of ["/dashboard", "/runs", "/runs/run-a11y", "/tools", "/workspace", "/approvals", "/audit", "/settings/workspace"]) {
      await narrowPage.goto(base(route), { waitUntil: "networkidle" });
      const overflow = await narrowPage.evaluate(() => document.body.scrollWidth > window.innerWidth);
      expect(overflow, `${route} overflows at 320px`).toBe(false);
    }
    await narrow.close();

    const zoomed = await browser!.newContext({ viewport: { width: 640, height: 900 } });
    const zoomedPage = await zoomed.newPage();
    await zoomedPage.goto(base("/dashboard"), { waitUntil: "networkidle" });
    await zoomedPage.evaluate(() => { document.documentElement.style.zoom = "2"; });
    expect(await zoomedPage.evaluate(() => document.body.scrollWidth > window.innerWidth)).toBe(false);
    await zoomed.close();
  }, 30_000);

  it("honors reduced motion, visible focus, and 44px touch targets", async () => {
    await context!.close();
    context = await browser!.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, reducedMotion: "reduce" });
    page = await context.newPage();
    await open("/dashboard");
    const focusTarget = page!.getByRole("link", { name: "Runs", exact: true });
    await focusTarget.focus();
    const focus = await focusTarget.evaluate((element) => {
      const style = getComputedStyle(element);
      return { outline: style.outlineStyle, width: Number.parseFloat(style.outlineWidth), animation: style.animationDuration, transition: style.transitionDuration };
    });
    expect(focus.outline).not.toBe("none");
    expect(focus.width).toBeGreaterThanOrEqual(2);
    expect(Number.parseFloat(focus.animation)).toBeLessThanOrEqual(0.01);
    expect(Number.parseFloat(focus.transition)).toBeLessThanOrEqual(0.01);
    const undersized = await page!.evaluate(() => [...document.querySelectorAll<HTMLElement>("button, nav a, summary")]
      .filter((element) => element.getClientRects().length > 0)
      .map((element) => ({ name: element.getAttribute("aria-label") || element.textContent?.trim(), rect: element.getBoundingClientRect() }))
      .filter(({ rect }) => rect.width < 44 || rect.height < 44)
      .map(({ name, rect }) => ({ name, width: rect.width, height: rect.height })));
    expect(undersized).toEqual([]);

    const opener = page!.getByRole("button", { name: "Open navigation" });
    await opener.click();
    await expect.poll(() => page!.getByRole("dialog", { name: "Primary navigation" }).count()).toBe(1);
    await page!.keyboard.press("Escape");
    expect(await opener.evaluate((element) => element === document.activeElement)).toBe(true);
  });
});

async function open(route: string) {
  await page!.goto(base(route), { waitUntil: "networkidle" });
}

async function assertAxe(label: string) {
  const result = await new AxeBuilder({ page: page! })
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22a", "wcag22aa"])
    .analyze();
  if (result.violations.length) {
    throw new Error(`${label}: ${result.violations.map((violation) => `${violation.id} (${violation.nodes.length})`).join(", ")}`);
  }
}

function base(route: string) {
  return `http://127.0.0.1:${appPort}${route}`;
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

function fixture() {
  return {
    settings: { workspaceRoot: root, layout: "chat", maxIterations: 5, maxParallelExecutors: 3, criticThreshold: 7, approvalMode: true, shellPath: "powershell.exe", testCommand: "npm test", lintCommand: "npm run lint", mcpAutoDiscovery: true, mcpPortStart: 3000, mcpPortEnd: 3499, memoryTokenBudget: 2000, agentModels: { planner: "Local Coder", executor: "Local Coder", critic: "Local Coder" } },
    runtimes: [{ id: "runtime-a11y", name: "Local runtime", kind: "ollama", endpoint: "http://127.0.0.1:1", timeoutMs: 1000 }],
    mcpServers: [{ id: "mcp-a11y", name: "Workspace tools", endpoint: "http://127.0.0.1:1/mcp", transport: "http", enabled: true, status: "online", tools: [{ name: "read_file", description: "Read a bounded file.", inputSchema: { type: "object", properties: { path: { type: "string" } } }, enabled: true }] }],
    memory: [{ id: "memory-a11y", kind: "context", taskType: "frontend", title: "Accessible interfaces", content: "Preserve keyboard operation and programmatic labels.", source: "operator", pinned: true, createdAt: now, updatedAt: now }],
    audit: [{ id: "audit-a11y", at: now, actor: "executor", action: "shell_request", risk: "execute", status: "pending", message: "Approval requested for validation.", details: { runId: "run-a11y", command: "npm test", cwd: root } }],
    approvals: [{ id: "approval-a11y", createdAt: now, actor: "executor", action: "shell_execute", risk: "execute", payload: { command: "npm test", shell: "powershell.exe", cwd: root }, runId: "run-a11y", subtask: "Validate accessibility", decision: "pending" }],
    runs: [{ id: "run-a11y", task: "Verify the accessible v2 workspace", status: "passed", phase: "done", iteration: 1, maxIterations: 5, plan: ["Inspect routes", "Verify keyboard", "Record results"], subtaskResults: [{ subtask: "Inspect routes", output: "No automated violations." }], executorOutput: "Accessibility routes inspected.", criticFeedback: "Keyboard and focus behavior verified.", criticScore: 9, validationOutput: "All checks passed.", result: "Ready for manual assistive-technology review.", createdAt: now, updatedAt: now }]
  };
}

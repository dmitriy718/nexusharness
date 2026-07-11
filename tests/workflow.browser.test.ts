import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { BrowserContext, Page } from "playwright-core";
import AxeBuilder from "@axe-core/playwright";
import { fixture, ProductionHarness } from "./productionHarness";
import type { RunExecutionSummary } from "../src/api/types";

const enabled = process.env.npm_lifecycle_event === "test:workflows";
const suite = enabled ? describe : describe.skip;
let harness: ProductionHarness;
let context: BrowserContext;
let page: Page;

suite("consequential production workflows", () => {
  beforeAll(async () => {
    const store = fixture();
    store.runs[0] = { ...store.runs[0], status: "waiting_approval", phase: "execute", error: undefined };
    store.runs[0].execution = executionSummary();
    store.settings.agentModels = { planner: "runtime-a11y:local-coder", executor: "runtime-a11y:local-coder", critic: "runtime-a11y:local-coder" };
    harness = new ProductionHarness(store);
    await harness.start();
    context = await harness.newContext({ viewport: { width: 1440, height: 900 } });
    page = await context.newPage();
  }, 30_000);

  afterAll(async () => {
    await harness?.stop();
  });

  it("turns an explicit approval rejection into an auditable failed run", async () => {
    await open("/approvals");
    await expect.poll(() => page.locator(".approval-review").isVisible()).toBe(true);
    await page.getByRole("button", { name: "Reject", exact: true }).click();
    await expect.poll(() => page.getByText("Action rejected.", { exact: true }).isVisible()).toBe(true);
    await expect.poll(() => page.getByRole("heading", { name: "The approval queue is clear" }).isVisible()).toBe(true);

    const detail = await page.request.get(harness.url("/api/runs/run-a11y"));
    expect(detail.ok()).toBe(true);
    const payload = await detail.json() as { run: { status: string; error?: string }; approvals: Array<{ decision: string }> };
    expect(payload.run.status).toBe("failed");
    expect(payload.run.error).toContain("Operator rejected shell_execute");
    expect(payload.approvals[0]?.decision).toBe("rejected");
  }, 15_000);

  it("surfaces a failed runtime test without persisting the draft", async () => {
    await open("/models");
    await page.getByRole("button", { name: "Add runtime" }).click();
    await page.getByLabel("Connection name").fill("Unavailable runtime");
    await page.getByLabel("Endpoint URL").fill("http://127.0.0.1:1");
    await page.getByLabel("Connection timeout").fill("1000");
    await page.getByRole("button", { name: "Test connection" }).click();
    await expect.poll(() => page.getByRole("alert").filter({ hasText: "Connection test failed" }).isVisible(), { timeout: 10_000 }).toBe(true);

    const state = await page.request.get(harness.url("/api/state"));
    const payload = await state.json() as { runtimes: Array<{ name: string }> };
    expect(payload.runtimes.map((runtime) => runtime.name)).not.toContain("Unavailable runtime");
    expect(await page.getByRole("button", { name: "Test connection" }).isEnabled()).toBe(true);
  }, 15_000);

  it("shows truthful transaction boundaries and keeps disconnected promotion actions guarded", async () => {
    await open("/runs/run-a11y");
    await expect.poll(() => page.getByRole("heading", { name: "Execution cell" }).isVisible()).toBe(true);
    expect(await page.getByText("Transaction isolation only").isVisible()).toBe(true);
    expect(await page.getByText("Portable Git worktree").isVisible()).toBe(true);
    expect(await page.getByRole("region", { name: "File effects" }).getByText("src/main.ts").isVisible()).toBe(true);
    expect(await page.getByText("Protected workflow checks").isVisible()).toBe(true);
    expect(await page.getByRole("button", { name: "Commit result" }).isDisabled()).toBe(true);
    expect(await page.getByRole("button", { name: "Commit result" }).getAttribute("title")).toBe("Verification is still running.");
    const accessibility = await new AxeBuilder({ page }).include(".execution-inspector").withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22a", "wcag22aa"]).analyze();
    expect(accessibility.violations.map((violation) => violation.id)).toEqual([]);
  }, 15_000);

  it("reflows the execution inspector at 320 CSS pixels", async () => {
    const narrowContext = await harness.newContext({ viewport: { width: 320, height: 800 }, reducedMotion: "reduce" });
    const narrowPage = await narrowContext.newPage();
    try {
      await narrowPage.goto(harness.url("/runs/run-a11y"), { waitUntil: "networkidle" });
      expect(await narrowPage.getByRole("heading", { name: "Execution cell" }).isVisible()).toBe(true);
      expect(await narrowPage.evaluate(() => document.body.scrollWidth > window.innerWidth)).toBe(false);
      expect(await narrowPage.getByRole("region", { name: "Capability envelope" }).isVisible()).toBe(true);
    } finally {
      await narrowContext.close();
    }
  }, 15_000);

  it("protects settings drafts with discard and persists only an explicit save", async () => {
    await open("/settings/execution");
    const iterations = page.getByLabel("Max iterations");
    await iterations.fill("8");
    await expect.poll(() => page.getByText("1 section changed").isVisible()).toBe(true);
    await page.getByRole("button", { name: "Discard all" }).click();
    expect(await iterations.inputValue()).toBe("5");

    await iterations.fill("8");
    await page.getByRole("button", { name: "Save changes" }).click();
    await expect.poll(() => page.getByRole("button", { name: "Save changes" }).count()).toBe(0);
    const state = await page.request.get(harness.url("/api/state"));
    const payload = await state.json() as { settings: { maxIterations: number } };
    expect(payload.settings.maxIterations).toBe(8);
  }, 15_000);
});

async function open(route: string) {
  await page.goto(harness.url(route), { waitUntil: "networkidle" });
}

function executionSummary(): RunExecutionSummary {
  return {
    schemaVersion: 1,
    cellId: "cell-a11y",
    provider: "portable-worktree",
    securityBoundary: false,
    boundaryDescription: "Disposable Git worktree transaction isolation; not a hostile-code security sandbox.",
    state: "verifying",
    baseRevision: "a".repeat(40),
    networkDefault: "deny",
    capabilities: { read: ["src/**"], write: ["src/main.ts"], delete: [], execute: ["npm"], network: [], secrets: [] },
    budget: { wallTimeMs: 60_000, cpuTimeMs: 30_000, memoryBytes: 512 * 1024 * 1024, diskBytes: 1024 * 1024 * 1024, processCount: 20, outputBytes: 1024 * 1024 },
    effects: [{ kind: "file.update", target: "src/main.ts", status: "changed" }],
    variances: [],
    evidence: [{ kind: "test", name: "Protected workflow checks", status: "passed", detail: "Evidence saved" }],
    commit: { available: false, reason: "Verification is still running." },
    rollback: { available: true, reason: "Discard the portable cell." },
    updatedAt: "2026-07-11T10:00:00.000Z"
  };
}

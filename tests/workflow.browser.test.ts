import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { BrowserContext, Page } from "playwright-core";
import { fixture, ProductionHarness } from "./productionHarness";

const enabled = process.env.npm_lifecycle_event === "test:workflows";
const suite = enabled ? describe : describe.skip;
let harness: ProductionHarness;
let context: BrowserContext;
let page: Page;

suite("consequential production workflows", () => {
  beforeAll(async () => {
    const store = fixture();
    store.runs[0] = { ...store.runs[0], status: "waiting_approval", phase: "execute", error: undefined };
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

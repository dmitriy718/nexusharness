import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { BrowserContext, Page } from "playwright-core";
import { ProductionHarness, fixture } from "./productionHarness";

const enabled = process.env.npm_lifecycle_event === "test:performance";
const suite = enabled ? describe : describe.skip;
const store = fixture();
store.audit = Array.from({ length: 1_500 }, (_, index) => ({
  id: `audit-perf-${index}`,
  at: new Date(Date.parse("2026-07-11T08:00:00.000Z") - index * 1_000).toISOString(),
  actor: index % 2 ? "executor" : "system",
  action: index % 3 ? "file_read" : "shell_request",
  risk: index % 3 ? "read" : "execute",
  status: index % 3 ? "ok" : "pending",
  message: `Bounded performance event ${index}`,
  details: { runId: "run-a11y", target: `src/example-${index}.ts` }
}));
let harness: ProductionHarness;
let context: BrowserContext;
let page: Page;

suite("production performance budget", () => {
  beforeAll(async () => {
    harness = new ProductionHarness(store);
    await harness.start();
    context = await harness.newContext({ viewport: { width: 1440, height: 900 }, reducedMotion: "reduce" });
    await context.addInitScript(() => {
      (window as Window & { __nexusCls?: number }).__nexusCls = 0;
      new PerformanceObserver((list) => {
        for (const entry of list.getEntries() as Array<PerformanceEntry & { value: number; hadRecentInput: boolean }>) {
          if (!entry.hadRecentInput) (window as Window & { __nexusCls?: number }).__nexusCls! += entry.value;
        }
      }).observe({ type: "layout-shift", buffered: true });
    });
    page = await context.newPage();
  }, 30_000);

  afterAll(async () => {
    await harness?.stop();
  });

  it("makes the shell interactive within the local production budget without layout shift", async () => {
    const started = performance.now();
    await page.goto(harness.url("/dashboard"), { waitUntil: "domcontentloaded" });
    await page.getByRole("heading", { name: /Good .*operator/ }).waitFor();
    const shellReadyMs = performance.now() - started;
    const metrics = await page.evaluate(() => {
      const navigation = performance.getEntriesByType("navigation")[0] as PerformanceNavigationTiming;
      const paint = performance.getEntriesByName("first-contentful-paint")[0];
      return { domContentLoadedMs: navigation.domContentLoadedEventEnd, loadMs: navigation.loadEventEnd, firstContentfulPaintMs: paint?.startTime ?? 0, cls: (window as Window & { __nexusCls?: number }).__nexusCls ?? 0 };
    });
    console.log("performance:shell", JSON.stringify({ shellReadyMs: Math.round(shellReadyMs), ...metrics }));
    expect(shellReadyMs).toBeLessThan(2_500);
    expect(metrics.domContentLoadedMs).toBeLessThan(2_000);
    expect(metrics.loadMs).toBeLessThan(2_500);
    expect(metrics.firstContentfulPaintMs).toBeLessThan(2_000);
    expect(metrics.cls).toBeLessThanOrEqual(0.1);
  });

  it("windows a 1,500-event audit ledger and expands it in bounded pages", async () => {
    const started = performance.now();
    await page.goto(harness.url("/audit"), { waitUntil: "domcontentloaded" });
    await expect.poll(() => page.locator(".audit-data-table tbody tr").count()).toBe(100);
    await expect.poll(() => page.locator(".audit-load-more p").textContent()).toContain("Showing 100 of 1500 events");
    const readyMs = performance.now() - started;
    await page.getByRole("button", { name: "Load 100 more" }).click();
    expect(await page.locator(".audit-data-table tbody tr").count()).toBe(200);
    console.log("performance:audit", JSON.stringify({ records: 1_500, initialRows: 100, readyMs: Math.round(readyMs) }));
    expect(readyMs).toBeLessThan(2_500);
  });

  it("keeps settings drafts stable through compact polling and immediate section navigation", async () => {
    let stateRequests = 0;
    page.on("request", (request) => { if (request.url().includes("/api/state?compact=1")) stateRequests += 1; });
    await page.goto(harness.url("/settings/workspace"), { waitUntil: "networkidle" });
    const input = page.getByRole("textbox", { name: "Test command" });
    await input.fill("npm run accessibility-check");
    const navigationStarted = performance.now();
    await page.getByRole("link", { name: /Execution/ }).click();
    await page.getByRole("heading", { name: "Execution" }).waitFor();
    const navigationMs = performance.now() - navigationStarted;
    await page.locator(".settings-nav a[href='/settings/workspace']").click();
    expect(await input.inputValue()).toBe("npm run accessibility-check");
    await page.waitForTimeout(10_500);
    expect(await input.inputValue()).toBe("npm run accessibility-check");
    console.log("performance:updates", JSON.stringify({ navigationMs: Math.round(navigationMs), compactStateRequests: stateRequests }));
    expect(navigationMs).toBeLessThan(500);
    expect(stateRequests).toBeLessThanOrEqual(2);
  }, 20_000);
});

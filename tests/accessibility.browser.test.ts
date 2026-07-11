import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { BrowserContext, Page } from "playwright-core";
import AxeBuilder from "@axe-core/playwright";
import { ProductionHarness } from "./productionHarness";

const enabled = process.env.npm_lifecycle_event === "test:a11y";
const suite = enabled ? describe : describe.skip;
let harness: ProductionHarness;
let context: BrowserContext | undefined;
let page: Page | undefined;

suite("production accessibility contract", () => {
  beforeAll(async () => {
    harness = new ProductionHarness();
    await harness.start();
    context = await harness.newContext({ viewport: { width: 1440, height: 900 } });
    page = await context.newPage();
  }, 30_000);

  afterAll(async () => {
    await harness?.stop();
  });

  it("has no detectable WCAG A/AA violations on every major route and state", async () => {
    const routes = [
      "/onboarding", "/dashboard", "/runs", "/runs/run-a11y", "/agents", "/models", "/tools",
      "/workspace", "/memory", "/approvals", "/audit", "/settings/workspace", "/settings/execution",
      "/settings/safety", "/settings/integrations", "/settings/memory", "/settings/appearance", "/settings/help", "/settings/about"
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
    await page!.goBack({ waitUntil: "networkidle" });
    expect(new URL(page!.url()).pathname).toBe("/dashboard");
    await page!.goForward({ waitUntil: "networkidle" });
    expect(new URL(page!.url()).pathname).toBe("/runs");
    await page!.reload({ waitUntil: "networkidle" });
    expect(new URL(page!.url()).pathname).toBe("/runs");

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
    const narrow = await harness.newContext({ viewport: { width: 320, height: 800 } });
    const narrowPage = await narrow.newPage();
    for (const route of ["/dashboard", "/runs", "/runs/run-a11y", "/tools", "/workspace", "/approvals", "/audit", "/settings/workspace"]) {
      await narrowPage.goto(base(route), { waitUntil: "networkidle" });
      const overflow = await narrowPage.evaluate(() => document.body.scrollWidth > window.innerWidth);
      expect(overflow, `${route} overflows at 320px`).toBe(false);
    }
    await narrow.close();

    const zoomed = await harness.newContext({ viewport: { width: 640, height: 900 } });
    const zoomedPage = await zoomed.newPage();
    await zoomedPage.goto(base("/dashboard"), { waitUntil: "networkidle" });
    await zoomedPage.evaluate(() => { document.documentElement.style.zoom = "2"; });
    expect(await zoomedPage.evaluate(() => document.body.scrollWidth > window.innerWidth)).toBe(false);
    await zoomed.close();
  }, 30_000);

  it("honors reduced motion, visible focus, and 44px touch targets", async () => {
    await context!.close();
    context = await harness.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, reducedMotion: "reduce" });
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
    const approvals = page!.getByRole("link", { name: "1 pending approvals" });
    expect(await approvals.getAttribute("href")).toBe("/approvals");
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
  return harness.url(route);
}

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import pixelmatch from "pixelmatch";
import { PNG } from "pngjs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ProductionHarness, root } from "./productionHarness";

const lifecycle = process.env.npm_lifecycle_event ?? "";
const enabled = lifecycle === "test:visual" || lifecycle === "test:visual:update";
const update = lifecycle === "test:visual:update";
const suite = enabled ? describe : describe.skip;
const baselineDirectory = join(root, "tests", "visual-baselines");
const diffDirectory = join(root, "dist", "visual-diffs");
const viewports = [
  { width: 1440, height: 900 },
  { width: 1280, height: 800 },
  { width: 1024, height: 768 },
  { width: 768, height: 1024 },
  { width: 390, height: 844 },
  { width: 360, height: 800 }
];
const scenes = [
  { id: "onboarding", route: "/onboarding" },
  { id: "dashboard", route: "/dashboard" },
  { id: "glassbox", route: "/dashboard", glassbox: true },
  { id: "run-focus", route: "/runs/run-a11y", mode: "focus" },
  { id: "run-studio", route: "/runs/run-a11y", mode: "studio" },
  { id: "run-orchestrate", route: "/runs/run-a11y", mode: "orchestrate" },
  { id: "approvals", route: "/approvals" }
];
let harness: ProductionHarness;

suite("Midnight Prism visual regression", () => {
  beforeAll(async () => {
    harness = new ProductionHarness();
    await harness.start();
    if (update) mkdirSync(baselineDirectory, { recursive: true });
  }, 30_000);

  afterAll(async () => {
    await harness?.stop();
  });

  for (const viewport of viewports) {
    it(`${viewport.width}x${viewport.height} matches all representative scenes`, async () => {
      const context = await harness.newContext({
        viewport,
        deviceScaleFactor: 1,
        hasTouch: viewport.width <= 768,
        isMobile: viewport.width <= 470,
        reducedMotion: "reduce"
      });
      const page = await context.newPage();
      for (const scene of scenes) {
        await page.goto(harness.url(scene.route), { waitUntil: "domcontentloaded" });
        await page.locator("h1").first().waitFor();
        if (scene.mode) {
          await page.getByRole("button", { name: scene.mode, exact: true }).click();
          await page.locator(`.${scene.mode === "focus" ? "mode-focus" : `${scene.mode}-mode`}`).waitFor();
        }
        if (scene.glassbox) {
          const trigger = viewport.width <= 470 ? page.locator(".mobile-bar").getByRole("button", { name: "Open Glassbox Live" }) : page.locator(".glassbox-button");
          await trigger.click();
          await page.getByRole("dialog", { name: "Glassbox Live" }).waitFor();
        }
        await page.evaluate(() => document.fonts.ready);
        await page.addStyleTag({ content: "*,*::before,*::after{animation:none!important;transition:none!important;caret-color:transparent!important}" });
        await page.waitForTimeout(80);
        const actual = Buffer.from(await page.screenshot({ type: "png", animations: "disabled", fullPage: false }));
        const filename = `${viewport.width}x${viewport.height}-${scene.id}.png`;
        const baseline = join(baselineDirectory, filename);
        if (update) {
          writeFileSync(baseline, actual);
          continue;
        }
        if (!existsSync(baseline)) throw new Error(`Missing visual baseline ${filename}. Run npm run test:visual:update after intentional visual review.`);
        const expected = PNG.sync.read(readFileSync(baseline));
        const rendered = PNG.sync.read(actual);
        expect({ width: rendered.width, height: rendered.height }, `${filename} dimensions changed.`).toEqual({ width: expected.width, height: expected.height });
        const diff = new PNG({ width: expected.width, height: expected.height });
        const changedPixels = pixelmatch(expected.data, rendered.data, diff.data, expected.width, expected.height, { threshold: 0.05, includeAA: false });
        if (changedPixels) {
          mkdirSync(diffDirectory, { recursive: true });
          writeFileSync(join(diffDirectory, filename.replace(".png", ".actual.png")), actual);
          writeFileSync(join(diffDirectory, filename.replace(".png", ".diff.png")), PNG.sync.write(diff));
        }
        expect(changedPixels, `${filename} changed by ${changedPixels.toLocaleString()} rendered pixels. Review dist/visual-diffs.`).toBe(0);
      }
      await context.close();
    }, 30_000);
  }
});

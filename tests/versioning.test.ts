import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";

const root = resolve(import.meta.dirname, "..");
const versionScript = join(root, "scripts", "version.mjs");
const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("release version identity", () => {
  it("keeps package, lockfile, marketplace, and changelog v2 identity aligned", async () => {
    const [packageJson, lockJson, marketplace, changelog] = await Promise.all([
      json(join(root, "package.json")),
      json(join(root, "package-lock.json")),
      json(join(root, "marketplace.json")),
      readFile(join(root, "CHANGELOG.md"), "utf8")
    ]);
    expect(packageJson.version).toMatch(/^2\.0\.0(?:-(?:alpha|beta|rc)\.\d+)?$/);
    expect(lockJson.version).toBe(packageJson.version);
    expect(lockJson.packages[""].version).toBe(packageJson.version);
    expect(marketplace.version).toBe(packageJson.version);
    expect(changelog).toContain(`## [${packageJson.version}]`);
  });

  it("detects drift and repairs derived metadata from package.json", async () => {
    const sandbox = await mkdtemp(join(tmpdir(), "nexusharness-version-"));
    temporaryRoots.push(sandbox);
    await Promise.all([
      writeFile(join(sandbox, "package.json"), JSON.stringify({ version: "2.1.0-rc.1" }), "utf8"),
      writeFile(join(sandbox, "package-lock.json"), JSON.stringify({ version: "1.0.0", packages: { "": { version: "1.0.0" } } }), "utf8"),
      writeFile(join(sandbox, "marketplace.json"), JSON.stringify({ version: "0.9.0" }), "utf8")
    ]);

    const drift = await run(sandbox, "check");
    expect(drift.code).not.toBe(0);
    expect(drift.stderr).toContain("Version mismatch; expected 2.1.0-rc.1");
    expect((await run(sandbox, "sync")).code).toBe(0);
    expect((await run(sandbox, "check")).code).toBe(0);
    expect((await json(join(sandbox, "package-lock.json"))).version).toBe("2.1.0-rc.1");
    expect((await json(join(sandbox, "marketplace.json"))).version).toBe("2.1.0-rc.1");
  });
});

async function json(file: string) {
  return JSON.parse(await readFile(file, "utf8"));
}

function run(cwd: string, command: string) {
  return new Promise<{ code: number; stdout: string; stderr: string }>((resolveRun, reject) => {
    const child = spawn(process.execPath, [versionScript, command], { cwd, windowsHide: true });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code) => resolveRun({ code: code ?? -1, stdout, stderr }));
  });
}

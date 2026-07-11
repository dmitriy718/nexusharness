import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";

const root = resolve(import.meta.dirname, "..");
const controlScript = join(root, "control", "scripts", "control.mjs");
const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("control-plane claim mutex", () => {
  it("allows exactly one of two simultaneous overlapping claims", async () => {
    const sandbox = await controlSandbox();
    const claims = await Promise.all([
      claim(sandbox, "agent-a", "src/features/**", "ui-shell"),
      claim(sandbox, "agent-b", "src/features/runs/**", "run-ui")
    ]);

    expect(claims.filter((result) => result.code === 0)).toHaveLength(1);
    const rejected = claims.find((result) => result.code !== 0);
    expect(rejected?.stderr).toContain("Claim overlaps active work");
    expect(await activeClaimFiles(sandbox)).toHaveLength(1);
  });

  it("allows simultaneous claims whose areas and resources do not overlap", async () => {
    const sandbox = await controlSandbox();
    const claims = await Promise.all([
      claim(sandbox, "agent-a", "src/features/runs/**", "run-ui"),
      claim(sandbox, "agent-b", "server/**", "api")
    ]);

    expect(claims.map((result) => result.code).sort()).toEqual([0, 0]);
    expect(await activeClaimFiles(sandbox)).toHaveLength(2);
  });
});

async function controlSandbox() {
  const sandbox = await mkdtemp(join(tmpdir(), "nexusharness-control-"));
  temporaryRoots.push(sandbox);
  await mkdir(join(sandbox, "control"), { recursive: true });
  await writeFile(join(sandbox, "package.json"), JSON.stringify({ name: "control-plane-fixture", version: "0.0.0" }), "utf8");
  const config = await readFile(join(root, "control", "config.json"), "utf8");
  await writeFile(join(sandbox, "control", "config.json"), config, "utf8");
  return sandbox;
}

async function activeClaimFiles(sandbox: string) {
  return readdir(join(sandbox, "control", "claims", "active"));
}

function claim(cwd: string, agent: string, area: string, resource: string) {
  return run(cwd, [controlScript, "claim", "--agent", agent, "--task", "Concurrency test", "--area", area, "--resource", resource, "--impact", "patch"]);
}

function run(cwd: string, args: string[]) {
  return new Promise<{ code: number; stdout: string; stderr: string }>((resolveRun, reject) => {
    const child = spawn(process.execPath, args, { cwd, windowsHide: true });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code) => resolveRun({ code: code ?? -1, stdout, stderr }));
  });
}

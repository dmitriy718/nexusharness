import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const root = process.cwd();
const metadata = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
const index = await readFile(path.join(root, "dist", "index.html"), "utf8");
if (!index.includes(`name="nexusharness-version" content="${metadata.version}"`)) throw new Error("Built client metadata does not match package version.");

const port = await availablePort();
const dataDir = await mkdtemp(path.join(tmpdir(), "nexusharness-smoke-"));
const launchDir = await mkdtemp(path.join(tmpdir(), "nexusharness-launch-"));
const cliEntry = path.join(root, "dist-server", "cli", "index.js");
const cliEnvironment = { ...process.env, NEXUSHARNESS_DATA_DIR: dataDir };
const versionResult = JSON.parse((await runCommand(process.execPath, [cliEntry, "--version", "--json"], launchDir, cliEnvironment)).stdout);
if (versionResult.version !== metadata.version) throw new Error(`Compiled CLI version mismatch: ${JSON.stringify(versionResult)}`);
const doctorResult = JSON.parse((await runCommand(process.execPath, [cliEntry, "doctor", "--non-interactive", "--json"], launchDir, cliEnvironment)).stdout);
if (!doctorResult.ok) throw new Error(`Compiled CLI doctor failed: ${JSON.stringify(doctorResult)}`);
const seededRun = {
  id: "run-smoke-cell", task: "Verify bounded execution payloads", status: "passed", phase: "done", iteration: 1, maxIterations: 5, log: [],
  createdAt: "2026-07-11T08:00:00.000Z", updatedAt: "2026-07-11T08:01:00.000Z",
  execution: {
    schemaVersion: 1, cellId: "cell-smoke", provider: "portable-worktree", securityBoundary: false, boundaryDescription: "Transaction isolation only.", state: "verifying", baseRevision: "a".repeat(40), networkDefault: "deny",
    capabilities: { read: ["**"], write: [], delete: [], execute: [], network: [], secrets: [] },
    budget: { wallTimeMs: 1000, cpuTimeMs: 1000, memoryBytes: 16777216, diskBytes: 1048576, processCount: 1, outputBytes: 1024 },
    effects: [{ kind: "file.update", target: "src/main.ts", status: "changed" }], variances: [], evidence: [],
    commit: { available: false, reason: "Verifying." }, rollback: { available: true, reason: "Discard cell." }, updatedAt: "2026-07-11T08:01:00.000Z"
  }
};
await writeFile(path.join(dataDir, "store.json"), JSON.stringify({ runs: [seededRun] }), "utf8");
const child = spawn(process.execPath, [path.join(root, "dist-server", "server", "index.js")], {
  cwd: launchDir,
  env: { ...process.env, NODE_ENV: "production", NEXUSHARNESS_PORT: String(port), NEXUSHARNESS_DATA_DIR: dataDir, NEXUSHARNESS_COMMIT: "smoke-test" },
  stdio: "ignore",
  windowsHide: true
});

try {
  const healthResponse = await waitFor(`http://127.0.0.1:${port}/api/health`);
  const health = await healthResponse.json();
  if (health.status !== "ok" || health.version !== metadata.version || health.commit !== "smoke-test" || health.mode !== "production") throw new Error(`Unexpected health identity: ${JSON.stringify(health)}`);
  if (healthResponse.headers.get("x-content-type-options") !== "nosniff" || !healthResponse.headers.get("content-security-policy")) throw new Error("Production security headers are missing.");
  const state = await fetch(`http://127.0.0.1:${port}/api/state?compact=1`).then(assertOk).then((response) => response.json());
  if (!state.settings || !Array.isArray(state.runs) || !Array.isArray(state.audit)) throw new Error("Compact state smoke response is malformed.");
  if (state.runs.length !== 1 || state.runs[0].execution !== undefined) throw new Error("Compact state leaked full execution evidence.");
  const runs = await fetch(`http://127.0.0.1:${port}/api/runs?limit=1`).then(assertOk).then((response) => response.json());
  if (!Array.isArray(runs.items) || typeof runs.total !== "number" || runs.limit !== 1) throw new Error("Bounded run history smoke response is malformed.");
  if (runs.items[0]?.execution !== undefined) throw new Error("Paged run history leaked full execution evidence.");
  const detail = await fetch(`http://127.0.0.1:${port}/api/runs/${seededRun.id}`).then(assertOk).then((response) => response.json());
  if (detail.run?.execution?.cellId !== "cell-smoke" || detail.run.execution.effects.length !== 1) throw new Error("Run detail omitted execution evidence.");
  const statusResult = JSON.parse((await runCommand(process.execPath, [cliEntry, "status", "--json"], launchDir, cliEnvironment)).stdout);
  if (!statusResult.running || statusResult.port !== port || statusResult.version !== metadata.version) throw new Error(`Compiled CLI did not reconnect to the service: ${JSON.stringify(statusResult)}`);
  const stopResult = JSON.parse((await runCommand(process.execPath, [cliEntry, "stop", "--json"], launchDir, cliEnvironment)).stdout);
  if (!stopResult.stopped) throw new Error(`Compiled CLI did not stop the service: ${JSON.stringify(stopResult)}`);
  console.log(`Production smoke passed: v${health.version}, commit ${health.commit}, API port ${port}.`);
} finally {
  if (child.exitCode === null) {
    const exited = new Promise((resolve) => child.once("exit", resolve));
    child.kill();
    await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 5_000))]);
  }
  await Promise.all([
    rm(dataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }),
    rm(launchDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  ]);
}

async function availablePort() {
  const server = createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function waitFor(url) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) return response;
    } catch { /* process startup */ }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out waiting for ${url}`);
}

function assertOk(response) {
  if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
  return response;
}

function runCommand(command, args, cwd, env) {
  return new Promise((resolveRun, reject) => {
    const child = spawn(command, args, { cwd, env, windowsHide: true });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("close", (code) => {
      if (code === 0) resolveRun({ stdout, stderr });
      else reject(new Error(`Command failed (${code}): ${stderr || stdout}`));
    });
  });
}

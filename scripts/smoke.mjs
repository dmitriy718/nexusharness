import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const root = process.cwd();
const metadata = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
const index = await readFile(path.join(root, "dist", "index.html"), "utf8");
if (!index.includes(`name="nexusharness-version" content="${metadata.version}"`)) throw new Error("Built client metadata does not match package version.");

const port = await availablePort();
const dataDir = await mkdtemp(path.join(tmpdir(), "nexusharness-smoke-"));
const child = spawn(process.execPath, ["dist-server/server/index.js"], {
  cwd: root,
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
  const runs = await fetch(`http://127.0.0.1:${port}/api/runs?limit=1`).then(assertOk).then((response) => response.json());
  if (!Array.isArray(runs.items) || typeof runs.total !== "number" || runs.limit !== 1) throw new Error("Bounded run history smoke response is malformed.");
  console.log(`Production smoke passed: v${health.version}, commit ${health.commit}, API port ${port}.`);
} finally {
  child.kill();
  await rm(dataDir, { recursive: true, force: true });
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

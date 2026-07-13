import { mkdtemp, mkdir, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { npmCli, readJson, repositoryRoot, run } from "./lib.mjs";

const input = path.resolve(repositoryRoot, process.argv[2] ?? "release-artifacts");
const inputStat = await import("node:fs/promises").then(({ stat }) => stat(input));
let tarballPath = input;
if (inputStat.isDirectory()) {
  const tarballs = (await readdir(input)).filter((name) => name.endsWith(".tgz"));
  if (tarballs.length !== 1) throw new Error(`Expected exactly one tarball in ${input}; found ${tarballs.length}.`);
  tarballPath = path.join(input, tarballs[0]);
}

const temporary = await mkdtemp(path.join(os.tmpdir(), "nexusharness package smoke "));
const prefix = path.join(temporary, "global prefix");
const launchDirectory = path.join(temporary, "unrelated launch café");
const dataDirectory = path.join(temporary, "NexusHarness data");
await Promise.all([mkdir(prefix, { recursive: true }), mkdir(launchDirectory, { recursive: true }), mkdir(dataDirectory, { recursive: true })]);
const packageJson = await readJson(path.join(repositoryRoot, "package.json"));
const reviewedInstallScripts = Object.entries(packageJson.allowScripts ?? {})
  .filter(([, allowed]) => allowed === true)
  .map(([specifier]) => {
    const versionSeparator = specifier.lastIndexOf("@");
    return versionSeparator > 0 ? specifier.slice(0, versionSeparator) : specifier;
  })
  .sort();
if (reviewedInstallScripts.length === 0) {
  throw new Error("package.json must declare the reviewed install scripts used by the global package smoke.");
}
const cliEntry = path.join(prefix, "node_modules", ...packageJson.name.split("/"), packageJson.bin.nexus);
const environment = { ...process.env, NEXUSHARNESS_DATA_DIR: dataDirectory, NEXUSHARNESS_DISABLE_BROWSER: "1" };

async function cli(args) {
  const output = await run(process.execPath, [cliEntry, ...args], { cwd: launchDirectory, env: environment });
  return JSON.parse(String(output));
}

try {
  await npmCli([
    "install",
    "--global",
    "--prefix",
    prefix,
    "--no-audit",
    "--no-fund",
    `--allow-scripts=${reviewedInstallScripts.join(",")}`,
    tarballPath,
  ], { cwd: launchDirectory, env: environment, inherit: true });
  const version = await cli(["--version", "--json"]);
  if (!version.ok || version.version !== packageJson.version) throw new Error(`Installed CLI reported unexpected version ${version.version}.`);
  const doctor = await cli(["doctor", "--non-interactive", "--json"]);
  if (!doctor.ok) throw new Error(`Installed CLI doctor failed: ${JSON.stringify(doctor)}`);
  const opened = await cli(["open", "--no-open", "--json"]);
  if (!opened.ok || !opened.url) throw new Error(`Installed CLI failed to start: ${JSON.stringify(opened)}`);
  const health = await fetch(`${opened.url}/api/health`, { signal: AbortSignal.timeout(10_000) });
  if (!health.ok) throw new Error(`Installed service health returned HTTP ${health.status}.`);
  const stopped = await cli(["stop", "--json"]);
  if (!stopped.ok || !stopped.stopped) throw new Error(`Installed CLI did not stop its service: ${JSON.stringify(stopped)}`);
  console.log(`Clean-prefix smoke passed for ${packageJson.name}@${packageJson.version} from a path containing spaces and Unicode.`);
} finally {
  try { await cli(["stop", "--json"]); } catch { /* Service may never have started or may already be stopped. */ }
  await rm(temporary, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}

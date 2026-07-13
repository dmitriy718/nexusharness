#!/usr/bin/env node

import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { access, mkdir, open, readFile, rm, stat, unlink, writeFile, type FileHandle } from "node:fs/promises";
import { createServer } from "node:net";
import path from "node:path";
import { createInterface } from "node:readline/promises";
import { installationPaths, type ServiceState, userPaths } from "../server/paths.js";
import { buildCleanPlan, buildPurgePlan, discoverLegacyDirectories, executeLegacyMigration, executeRemovalPlan, planLegacyMigration, type RemovalPlan } from "./lifecycle.js";

interface CliOptions {
  json: boolean;
  noOpen: boolean;
  verbose: boolean;
  nonInteractive: boolean;
  dryRun: boolean;
  repair: boolean;
  purge: boolean;
  keepData: boolean;
  keepCredentials: boolean;
  confirmPurge: boolean;
  confirmMigration: boolean;
  from?: string;
  positionals: string[];
}

interface Health {
  status: string;
  version: string;
  pid: number;
  port: number;
  uptimeSeconds: number;
}

interface Check {
  name: string;
  ok: boolean;
  detail: string;
}

class CliFailure extends Error {
  constructor(public readonly exitCode: number, public readonly code: string, message: string) {
    super(message);
  }
}

const packageMetadata = JSON.parse(await readFile(installationPaths.packageJson, "utf8")) as { version: string };

try {
  await main(parseArguments(process.argv.slice(2)));
} catch (error) {
  const failure = error instanceof CliFailure ? error : new CliFailure(1, "NEXUS_INTERNAL_ERROR", error instanceof Error ? error.message : String(error));
  const jsonRequested = process.argv.includes("--json");
  if (jsonRequested) process.stdout.write(`${JSON.stringify({ ok: false, error: { code: failure.code, message: failure.message } })}\n`);
  else process.stderr.write(`NexusHarness: ${failure.message}\n`);
  process.exitCode = failure.exitCode;
}

async function main(options: CliOptions): Promise<void> {
  const [command, ...rest] = options.positionals;
  if (command === "--version" || command === "-v" || command === "version") {
    output(options, { ok: true, version: packageMetadata.version }, `NexusHarness ${packageMetadata.version}`);
    return;
  }
  if (command === "--help" || command === "-h" || command === "help") {
    output(options, { ok: true, help: helpText() }, helpText());
    return;
  }
  if (command === "doctor") {
    const result = await doctor(options);
    output(options, result, doctorText(result.checks));
    if (!result.ok) process.exitCode = 3;
    return;
  }
  if (command === "status") {
    const result = await serviceStatus();
    output(options, { ok: true, ...result }, result.running
      ? `NexusHarness ${result.version} is running at ${result.url} (PID ${result.pid}).`
      : "NexusHarness is not running.");
    return;
  }
  if (command === "stop") {
    const result = await stopService(options);
    output(options, { ok: true, ...result }, result.stopped ? "NexusHarness stopped." : "NexusHarness was not running.");
    return;
  }
  if (command === "clean") {
    await cleanData(options);
    return;
  }
  if (command === "migrate") {
    await migrateLegacyData(options);
    return;
  }
  if (command === "uninstall") {
    await uninstallData(options);
    return;
  }
  if (command === "open") {
    const service = await ensureService(options);
    const url = `http://127.0.0.1:${service.port}`;
    if (!options.noOpen) launchBrowser(url, options);
    output(options, { ok: true, url, pid: service.pid, version: service.version, browserOpened: !options.noOpen },
      options.noOpen ? `NexusHarness is ready at ${url}.` : `Opening NexusHarness at ${url}.`);
    return;
  }
  if (command === "run") {
    if (!rest.length) throw new CliFailure(2, "TASK_REQUIRED", "Usage: nexus run \"<task>\"");
    await submitTask(rest.join(" "), options);
    return;
  }
  if (command && !command.startsWith("-")) {
    await submitTask([command, ...rest].join(" "), options);
    return;
  }
  if (command) throw new CliFailure(2, "UNKNOWN_ARGUMENT", `Unknown argument: ${command}. Run nexus --help.`);

  const service = await ensureService(options);
  const url = `http://127.0.0.1:${service.port}`;
  if (!options.noOpen) launchBrowser(url, options);
  output(options, { ok: true, url, pid: service.pid, version: service.version, browserOpened: !options.noOpen },
    options.noOpen ? `NexusHarness is ready at ${url}.` : `Opening NexusHarness at ${url}.`);
}

function parseArguments(args: string[]): CliOptions {
  const options: CliOptions = {
    json: false, noOpen: false, verbose: false, nonInteractive: false, dryRun: false, repair: false, purge: false,
    keepData: false, keepCredentials: false, confirmPurge: false, confirmMigration: false, positionals: []
  };
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--json") options.json = true;
    else if (argument === "--no-open") options.noOpen = true;
    else if (argument === "--verbose") options.verbose = true;
    else if (argument === "--non-interactive") options.nonInteractive = true;
    else if (argument === "--dry-run") options.dryRun = true;
    else if (argument === "--repair") options.repair = true;
    else if (argument === "--purge") options.purge = true;
    else if (argument === "--keep-data") options.keepData = true;
    else if (argument === "--keep-credentials") options.keepCredentials = true;
    else if (argument === "--confirm-purge") options.confirmPurge = true;
    else if (argument === "--confirm-migration") options.confirmMigration = true;
    else if (argument === "--from") {
      const value = args[index + 1];
      if (!value || value.startsWith("--")) throw new CliFailure(2, "MIGRATION_SOURCE_REQUIRED", "--from requires a legacy data directory.");
      options.from = value;
      index += 1;
    } else if (argument.startsWith("--from=")) {
      options.from = argument.slice("--from=".length);
      if (!options.from) throw new CliFailure(2, "MIGRATION_SOURCE_REQUIRED", "--from requires a legacy data directory.");
    }
    else options.positionals.push(argument);
  }
  return options;
}

async function doctor(options: CliOptions): Promise<{ ok: boolean; checks: Check[]; paths: typeof userPaths; plannedRepairs: string[]; appliedRepairs: string[] }> {
  const checks: Check[] = [];
  const plannedRepairs: string[] = [];
  const appliedRepairs: string[] = [];
  await checkReadable(checks, "package_metadata", installationPaths.packageJson);
  await checkReadable(checks, "server_entry", installationPaths.serverEntry);
  await checkReadable(checks, "browser_assets", path.join(installationPaths.webRoot, "index.html"));
  await checkWritableDirectory(checks, "data_directory", userPaths.dataRoot);
  await checkWritableDirectory(checks, "state_directory", userPaths.stateRoot);
  await checkWritableDirectory(checks, "cache_directory", userPaths.cacheRoot);
  const stateInspection = await inspectServiceState();
  const state = stateInspection.state;
  if (state) {
    const health = await fetchHealth(state.port);
    const healthy = Boolean(health && health.pid === state.pid && health.version === state.version);
    if (!healthy && !processIsAlive(state.pid)) {
      plannedRepairs.push(`Remove stale service state ${userPaths.serviceState}.`);
      if (options.repair && !options.dryRun) {
        await unlink(userPaths.serviceState).catch(() => undefined);
        appliedRepairs.push(`Removed stale service state ${userPaths.serviceState}.`);
      }
    }
    checks.push({ name: "service_state", ok: healthy || appliedRepairs.length > 0, detail: healthy
      ? `Running version ${health!.version} on port ${state.port}.`
      : appliedRepairs.length ? "Removed stale service state." : `Stale service state references PID ${state.pid} on port ${state.port}. Run nexus doctor --repair.` });
  } else if (stateInspection.exists) {
    plannedRepairs.push(`Remove malformed service state ${userPaths.serviceState}.`);
    if (options.repair && !options.dryRun) {
      await unlink(userPaths.serviceState).catch(() => undefined);
      appliedRepairs.push(`Removed malformed service state ${userPaths.serviceState}.`);
    }
    checks.push({ name: "service_state", ok: appliedRepairs.length > 0, detail: appliedRepairs.length ? "Removed malformed service state." : `Malformed service state: ${stateInspection.error}. Run nexus doctor --repair.` });
  } else {
    checks.push({ name: "service_state", ok: true, detail: "Service is not running; no stale state was found." });
  }
  try {
    if (await startLockIsStale()) {
      plannedRepairs.push(`Remove stale startup lock ${userPaths.serviceLock}.`);
      if (options.repair && !options.dryRun) {
        await unlink(userPaths.serviceLock).catch(() => undefined);
        appliedRepairs.push(`Removed stale startup lock ${userPaths.serviceLock}.`);
      }
      checks.push({ name: "startup_lock", ok: options.repair && !options.dryRun, detail: options.repair && !options.dryRun ? "Removed stale startup lock." : "A stale startup lock requires nexus doctor --repair." });
    } else {
      checks.push({ name: "startup_lock", ok: true, detail: "No stale startup lock was found." });
    }
  } catch (error) {
    checks.push({ name: "startup_lock", ok: false, detail: error instanceof Error ? error.message : String(error) });
  }
  const workspaceRoot = await configuredWorkspaceRoot();
  const legacy = await discoverLegacyDirectories(installationPaths.installRoot, process.cwd(), userPaths.dataRoot, workspaceRoot);
  checks.push({ name: "legacy_data", ok: true, detail: legacy.length ? `Legacy data is available for verified copy: ${legacy.join(", ")}. Run nexus migrate --dry-run.` : "No bounded legacy directory was found." });
  return { ok: checks.every((check) => check.ok), checks, paths: userPaths, plannedRepairs, appliedRepairs };
}

async function cleanData(options: CliOptions): Promise<void> {
  const planOptions = { paths: userPaths, installRoot: installationPaths.installRoot, workspaceRoot: await configuredWorkspaceRoot() };
  const plan = await buildCleanPlan(planOptions);
  if (options.dryRun) {
    output(options, { ok: true, dryRun: true, plan }, removalPlanText(plan));
    return;
  }
  await stopService(options);
  const finalPlan = await buildCleanPlan({ ...planOptions, workspaceRoot: await configuredWorkspaceRoot() });
  const result = await executeRemovalPlan(finalPlan);
  output(options, { ok: result.failed.length === 0, dryRun: false, plan: finalPlan, result }, removalResultText("Cache cleanup", result.removed.length, result.failed.length, finalPlan.totalBytes));
  if (result.failed.length) process.exitCode = 1;
}

async function uninstallData(options: CliOptions): Promise<void> {
  if (!options.purge) {
    const service = await stopService(options);
    output(options, {
      ok: true,
      purged: false,
      serviceStopped: service.stopped,
      dataPreserved: true,
      next: "Remove the program with npm uninstall -g @nexusharness/cli or brew uninstall nexusharness."
    }, "NexusHarness stopped. Persistent data was preserved. Remove the program with your package manager.");
    return;
  }
  const plan = await buildPurgePlan({
    paths: userPaths,
    installRoot: installationPaths.installRoot,
    workspaceRoot: await configuredWorkspaceRoot(),
    keepData: options.keepData,
    keepCredentials: options.keepCredentials,
    explicitDataOverride: Boolean(process.env.NEXUSHARNESS_DATA_DIR)
  });
  if (options.dryRun) {
    output(options, { ok: true, dryRun: true, plan }, removalPlanText(plan));
    return;
  }
  if (!options.json) process.stdout.write(`${removalPlanText(plan)}\n`);
  await requireConfirmation(options, options.confirmPurge, "PURGE", "Type PURGE to remove the listed NexusHarness-owned state: ");
  await stopService(options);
  const finalPlan = await buildPurgePlan({
    paths: userPaths,
    installRoot: installationPaths.installRoot,
    workspaceRoot: await configuredWorkspaceRoot(),
    keepData: options.keepData,
    keepCredentials: options.keepCredentials,
    explicitDataOverride: Boolean(process.env.NEXUSHARNESS_DATA_DIR)
  });
  if (removalPlanSignature(finalPlan) !== removalPlanSignature(plan)) {
    throw new CliFailure(10, "PURGE_PLAN_CHANGED", "NexusHarness data changed after confirmation. No data was removed; review a new --dry-run preview.");
  }
  const result = await executeRemovalPlan(finalPlan);
  output(options, { ok: result.failed.length === 0, dryRun: false, purged: result.failed.length === 0, plan: finalPlan, result }, removalResultText("NexusHarness purge", result.removed.length, result.failed.length, finalPlan.totalBytes));
  if (result.failed.length) process.exitCode = 1;
}

async function migrateLegacyData(options: CliOptions): Promise<void> {
  const workspaceRoot = await configuredWorkspaceRoot();
  const discovered = options.from
    ? [path.resolve(options.from)]
    : await discoverLegacyDirectories(installationPaths.installRoot, process.cwd(), userPaths.dataRoot, workspaceRoot);
  if (!discovered.length) {
    output(options, { ok: true, migrationAvailable: false }, "No bounded legacy NexusHarness data directory was found.");
    return;
  }
  if (discovered.length > 1 && !options.from) {
    throw new CliFailure(10, "MIGRATION_SOURCE_AMBIGUOUS", `Multiple legacy directories were found. Choose one with --from: ${discovered.join(", ")}`);
  }
  const plan = await planLegacyMigration(discovered[0], userPaths.dataRoot);
  if (options.dryRun) {
    output(options, { ok: true, dryRun: true, plan, sourcePreserved: true }, `Migration preview: copy ${plan.files.length} files (${formatBytes(plan.totalBytes)}) from ${plan.source} to ${plan.destination}. The source will be preserved.`);
    return;
  }
  await requireConfirmation(options, options.confirmMigration, "MIGRATE", `Type MIGRATE to copy verified data from ${plan.source}: `);
  await stopService(options);
  const result = await executeLegacyMigration(plan);
  output(options, { ok: true, dryRun: false, plan, result }, result.alreadyMigrated
    ? `Legacy data was already migrated and verified. Source preserved at ${plan.source}.`
    : `Migrated ${result.filesCopied} files (${formatBytes(result.bytesCopied)}). Source preserved at ${plan.source}.`);
}

async function serviceStatus(): Promise<{ running: boolean; url?: string; pid?: number; port?: number; version?: string }> {
  const state = await readServiceState();
  if (!state) return { running: false };
  const health = await fetchHealth(state.port);
  if (!health || health.pid !== state.pid || health.version !== state.version) return { running: false };
  return { running: true, url: `http://127.0.0.1:${state.port}`, pid: state.pid, port: state.port, version: state.version };
}

async function ensureService(options: CliOptions): Promise<ServiceState> {
  const startLock = await acquireStartLock(options);
  if ("state" in startLock) return startLock.state;

  try {
    const existing = await readServiceState();
    if (existing) {
      const health = await waitForStateHealth(existing, 3_000);
      if (health && health.pid === existing.pid && health.version === existing.version) return existing;
      if (processIsAlive(existing.pid)) {
        throw new CliFailure(3, "SERVICE_UNRESPONSIVE", `NexusHarness PID ${existing.pid} is running but did not answer health checks on port ${existing.port}. Run nexus doctor --verbose.`);
      }
      verbose(options, `Removing stale service state for PID ${existing.pid}.`);
      await unlink(userPaths.serviceState).catch((error: any) => {
        if (error?.code !== "ENOENT") throw error;
      });
    }

    const port = await availablePort();
    const token = randomBytes(32).toString("hex");
    const { command, args } = serverCommand();
    verbose(options, `Starting ${command} ${args.join(" ")} on port ${port}.`);
    const child = spawn(command, args, {
      cwd: installationPaths.installRoot,
      detached: true,
      windowsHide: true,
      stdio: "ignore",
      env: {
        ...process.env,
        NODE_ENV: "production",
        NEXUSHARNESS_INSTALL_ROOT: installationPaths.installRoot,
        NEXUSHARNESS_PACKAGE_JSON: installationPaths.packageJson,
        NEXUSHARNESS_SERVER_ENTRY: installationPaths.serverEntry,
        NEXUSHARNESS_WEB_ROOT: installationPaths.webRoot,
        NEXUSHARNESS_PORT: String(port),
        NEXUSHARNESS_SERVICE_TOKEN: token
      }
    });
    child.unref();

    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      const [state, health] = await Promise.all([readServiceState(), fetchHealth(port)]);
      if (state && health && state.token === token && state.pid === health.pid && state.version === health.version) return state;
      await delay(100);
    }
    try { process.kill(child.pid!); } catch { /* already exited */ }
    throw new CliFailure(3, "SERVICE_START_TIMEOUT", `NexusHarness did not become healthy on port ${port}. Run nexus doctor --verbose.`);
  } finally {
    await releaseStartLock(startLock);
  }
}

async function acquireStartLock(options: CliOptions): Promise<{ handle: FileHandle; token: string } | { state: ServiceState }> {
  await mkdir(userPaths.stateRoot, { recursive: true });
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    const current = await readServiceState();
    if (current) {
      const health = await fetchHealth(current.port);
      if (health && health.pid === current.pid && health.version === current.version) return { state: current };
    }
    try {
      const handle = await open(userPaths.serviceLock, "wx", 0o600);
      const token = randomBytes(16).toString("hex");
      await handle.writeFile(`${JSON.stringify({ pid: process.pid, token, createdAt: new Date().toISOString() })}\n`, "utf8");
      return { handle, token };
    } catch (error: any) {
      if (error?.code !== "EEXIST") throw error;
      if (await startLockIsStale()) {
        verbose(options, "Removing a stale service startup lock.");
        await unlink(userPaths.serviceLock).catch(() => undefined);
        continue;
      }
      await delay(100);
    }
  }
  throw new CliFailure(3, "SERVICE_START_LOCK_TIMEOUT", "Another NexusHarness launcher did not finish starting the service within 20 seconds.");
}

async function startLockIsStale(): Promise<boolean> {
  try {
    const lock = JSON.parse(await readFile(userPaths.serviceLock, "utf8")) as { pid?: number; createdAt?: string };
    const age = Date.now() - Date.parse(lock.createdAt ?? "");
    return !lock.pid || !processIsAlive(lock.pid) || !Number.isFinite(age) || age > 30_000;
  } catch (error: any) {
    if (error?.code === "ENOENT") return false;
    try {
      const metadata = await stat(userPaths.serviceLock);
      return Date.now() - metadata.mtimeMs > 30_000;
    } catch {
      return false;
    }
  }
}

async function releaseStartLock(lock: { handle: FileHandle; token: string }): Promise<void> {
  await lock.handle.close();
  try {
    const current = JSON.parse(await readFile(userPaths.serviceLock, "utf8")) as { token?: string };
    if (current.token === lock.token) await unlink(userPaths.serviceLock);
  } catch (error: any) {
    if (error?.code !== "ENOENT") throw error;
  }
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function stopService(options: CliOptions): Promise<{ stopped: boolean; pid?: number }> {
  const state = await readServiceState();
  if (!state) return { stopped: false };
  const health = await fetchHealth(state.port);
  if (!health || health.pid !== state.pid) {
    verbose(options, `Removing stale service state for PID ${state.pid}.`);
    await unlink(userPaths.serviceState).catch(() => undefined);
    return { stopped: false };
  }
  const response = await fetch(`http://127.0.0.1:${state.port}/api/service/stop`, {
    method: "POST",
    headers: { authorization: `Bearer ${state.token}` },
    signal: AbortSignal.timeout(3_000)
  });
  if (!response.ok) throw new CliFailure(1, "SERVICE_STOP_REJECTED", `Service stop failed with HTTP ${response.status}.`);
  const deadline = Date.now() + 7_000;
  while (Date.now() < deadline) {
    if (!await fetchHealth(state.port)) return { stopped: true, pid: state.pid };
    await delay(100);
  }
  throw new CliFailure(1, "SERVICE_STOP_TIMEOUT", `Service PID ${state.pid} did not stop within 7 seconds.`);
}

async function submitTask(task: string, options: CliOptions): Promise<void> {
  const service = await ensureService(options);
  const response = await fetch(`http://127.0.0.1:${service.port}/api/tasks`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ task })
  });
  const created = await response.json() as { id?: string; status?: string; phase?: string; error?: string };
  if (!response.ok || !created.id) throw new CliFailure(2, "TASK_SUBMISSION_FAILED", created.error || `Task submission failed with HTTP ${response.status}.`);
  verbose(options, `Submitted task ${created.id}.`);

  let previousPhase = "";
  while (true) {
    const detailResponse = await fetch(`http://127.0.0.1:${service.port}/api/runs/${created.id}`);
    if (!detailResponse.ok) throw new CliFailure(1, "TASK_STATUS_FAILED", `Task status failed with HTTP ${detailResponse.status}.`);
    const detail = await detailResponse.json() as { run: { id: string; task: string; status: string; phase: string; error?: string } };
    const run = detail.run;
    if (!options.json && run.phase !== previousPhase) process.stderr.write(`NexusHarness: ${run.phase} (${run.status})\n`);
    previousPhase = run.phase;
    if (["passed", "failed", "canceled"].includes(run.status)) {
      output(options, { ok: run.status === "passed", run }, run.status === "passed" ? `Task ${run.id} completed.` : `Task ${run.id} ${run.status}: ${run.error ?? "No detail provided."}`);
      if (run.status === "failed") process.exitCode = 1;
      if (run.status === "canceled") process.exitCode = 8;
      return;
    }
    if (run.status === "waiting_approval") {
      output(options, { ok: false, run, action: "Open NexusHarness to review the pending approval." }, `Task ${run.id} is waiting for approval. Run nexus open.`);
      process.exitCode = options.nonInteractive ? 10 : 5;
      return;
    }
    await delay(500);
  }
}

function serverCommand(): { command: string; args: string[] } {
  if (!installationPaths.serverEntry.endsWith(".ts")) return { command: process.execPath, args: [installationPaths.serverEntry] };
  const tsxCli = path.join(installationPaths.installRoot, "node_modules", "tsx", "dist", "cli.mjs");
  return { command: process.execPath, args: [tsxCli, installationPaths.serverEntry] };
}

async function readServiceState(): Promise<ServiceState | null> {
  return (await inspectServiceState()).state;
}

async function inspectServiceState(): Promise<{ exists: boolean; state: ServiceState | null; error?: string }> {
  try {
    const state = JSON.parse(await readFile(userPaths.serviceState, "utf8")) as ServiceState;
    if (state.schemaVersion !== 1 || !Number.isInteger(state.pid) || !Number.isInteger(state.port) || !state.token || !state.version) {
      return { exists: true, state: null, error: "Required service identity fields are missing or invalid." };
    }
    return { exists: true, state };
  } catch (error: any) {
    if (error?.code === "ENOENT") return { exists: false, state: null };
    if (error instanceof SyntaxError) return { exists: true, state: null, error: error.message };
    throw error;
  }
}

async function configuredWorkspaceRoot(): Promise<string | null> {
  try {
    const store = JSON.parse(await readFile(path.join(userPaths.dataRoot, "store.json"), "utf8")) as { settings?: { workspaceRoot?: unknown } };
    return typeof store.settings?.workspaceRoot === "string" && store.settings.workspaceRoot.trim()
      ? path.resolve(store.settings.workspaceRoot)
      : path.join(userPaths.dataRoot, "workspace");
  } catch (error: any) {
    if (error?.code === "ENOENT") return path.join(userPaths.dataRoot, "workspace");
    if (error instanceof SyntaxError) throw new CliFailure(3, "STORE_INVALID", "NexusHarness store.json is malformed; refusing lifecycle cleanup because the configured workspace cannot be verified.");
    throw error;
  }
}

async function fetchHealth(port: number): Promise<Health | null> {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(750) });
    if (!response.ok) return null;
    const health = await response.json() as Health;
    return health.status === "ok" ? health : null;
  } catch {
    return null;
  }
}

async function waitForStateHealth(state: ServiceState, timeout: number): Promise<Health | null> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const health = await fetchHealth(state.port);
    if (health && health.pid === state.pid && health.version === state.version) return health;
    await delay(100);
  }
  return null;
}

async function availablePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Cannot allocate a loopback port.");
  const port = address.port;
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return port;
}

async function checkReadable(checks: Check[], name: string, target: string): Promise<void> {
  try {
    await access(target, constants.R_OK);
    checks.push({ name, ok: true, detail: target });
  } catch {
    checks.push({ name, ok: false, detail: `Missing or unreadable: ${target}` });
  }
}

async function checkWritableDirectory(checks: Check[], name: string, target: string): Promise<void> {
  const probe = path.join(target, `.nexusharness-doctor-${process.pid}-${randomBytes(4).toString("hex")}`);
  try {
    await mkdir(target, { recursive: true });
    await writeFile(probe, "doctor", { encoding: "utf8", mode: 0o600 });
    await rm(probe, { force: true });
    checks.push({ name, ok: true, detail: target });
  } catch (error) {
    await rm(probe, { force: true }).catch(() => undefined);
    checks.push({ name, ok: false, detail: `${target}: ${error instanceof Error ? error.message : String(error)}` });
  }
}

function launchBrowser(url: string, options: CliOptions): void {
  const command = process.platform === "win32" ? "cmd.exe" : process.platform === "darwin" ? "open" : "xdg-open";
  const args = process.platform === "win32" ? ["/d", "/s", "/c", "start", "", url] : [url];
  try {
    const child = spawn(command, args, { detached: true, windowsHide: true, stdio: "ignore" });
    child.once("error", (error) => verbose(options, `Browser launch failed: ${error.message}`));
    child.unref();
  } catch (error) {
    verbose(options, `Browser launch failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function output(options: CliOptions, value: unknown, human: string): void {
  process.stdout.write(`${options.json ? JSON.stringify(value) : human}\n`);
}

function verbose(options: CliOptions, message: string): void {
  if (options.verbose) process.stderr.write(`NexusHarness: ${message}\n`);
}

function doctorText(checks: Check[]): string {
  return checks.map((check) => `${check.ok ? "PASS" : "FAIL"} ${check.name}: ${check.detail}`).join("\n");
}

function removalPlanText(plan: RemovalPlan): string {
  const targets = plan.targets.length
    ? plan.targets.map((target) => `  remove ${target.path} (${formatBytes(target.bytes)}, ${target.category})`).join("\n")
    : "  no removable paths found";
  const preserved = plan.preserved.length
    ? `\nPreserved:\n${plan.preserved.map((entry) => `  ${entry.path} — ${entry.reason}`).join("\n")}`
    : "";
  return `${plan.kind === "purge" ? "Purge" : "Cleanup"} preview (${formatBytes(plan.totalBytes)}):\n${targets}${preserved}\nCredentials: no Nexus-managed credential-store entries are configured.`;
}

function removalResultText(label: string, removed: number, failed: number, bytes: number): string {
  return `${label}: removed ${removed} target${removed === 1 ? "" : "s"} (${formatBytes(bytes)}); ${failed} failed. Configured workspaces and credential-store entries were preserved.`;
}

function removalPlanSignature(plan: RemovalPlan): string {
  return JSON.stringify({
    targets: plan.targets.map((target) => [path.resolve(target.path), target.category]).sort(),
    preserved: plan.preserved.map((entry) => path.resolve(entry.path)).sort(),
    keepData: plan.keepData,
    keepCredentials: plan.keepCredentials
  });
}

async function requireConfirmation(options: CliOptions, confirmed: boolean, expected: string, prompt: string): Promise<void> {
  if (confirmed) return;
  if (options.nonInteractive || options.json || !process.stdin.isTTY || !process.stdout.isTTY) {
    const flag = expected === "PURGE" ? "--confirm-purge" : "--confirm-migration";
    throw new CliFailure(10, "CONFIRMATION_REQUIRED", `Confirmation is required. Review --dry-run output, then pass ${flag}.`);
  }
  const terminal = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await terminal.question(prompt);
    if (answer.trim() !== expected) throw new CliFailure(8, "CONFIRMATION_DECLINED", `${expected} was not entered; no data was changed.`);
  } finally {
    terminal.close();
  }
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GiB`;
}

function helpText(): string {
  return `NexusHarness ${packageMetadata.version}

Usage:
  nexus                         Start NexusHarness and open the browser
  nexus "<task>"                Submit and follow a task
  nexus run "<task>"            Explicitly submit and follow a task
  nexus open [--no-open]        Start NexusHarness and open/show its URL
  nexus status                  Show service status
  nexus doctor [--repair]       Check and safely repair installation state
  nexus migrate [--from PATH]   Copy and verify a legacy .nexusharness store
  nexus clean [--dry-run]       Preview or remove disposable caches
  nexus stop                    Stop the per-user service
  nexus uninstall [--purge]     Stop safely; optionally purge Nexus-owned state
  nexus --version               Show the installed version

Options:
  --json              Emit machine-readable output
  --no-open           Do not launch a browser
  --non-interactive   Never prompt for input
  --verbose           Emit sanitized diagnostics to stderr
  --dry-run           Preview migration, cleanup, repair, or purge actions
  --keep-data         Preserve durable config/data during purge
  --keep-credentials  Preserve credential entries during purge
  --confirm-purge     Explicit non-interactive purge confirmation`;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

import { afterEach, describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const cliEntry = path.join(root, "cli", "index.ts");
const tsxEntry = path.join(root, "node_modules", "tsx", "dist", "cli.mjs");
const packageVersion = (JSON.parse(await readFile(path.join(root, "package.json"), "utf8")) as { version: string }).version;
const fixtures: Array<{ cwd: string; data: string }> = [];

afterEach(async () => {
  for (const fixture of fixtures.splice(0)) {
    try { await runCli(fixture, ["stop", "--json"]); } catch { await killRecordedProcess(fixture.data); }
    await Promise.all([rm(fixture.cwd, { recursive: true, force: true }), rm(fixture.data, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })]);
  }
});

describe.sequential("nexus CLI", () => {
  it("reports version and installation health from an unrelated Unicode directory", async () => {
    const fixture = await createFixture("nexus cli ünicode ");
    const version = await runCli(fixture, ["--version", "--json"]);
    expect(version.code).toBe(0);
    expect(JSON.parse(version.stdout)).toMatchObject({ ok: true, version: packageVersion });

    const doctor = await runCli(fixture, ["doctor", "--non-interactive", "--json"]);
    expect(doctor.code).toBe(0);
    expect(JSON.parse(doctor.stdout)).toMatchObject({ ok: true, checks: expect.arrayContaining([expect.objectContaining({ name: "browser_assets", ok: true })]) });
  });

  it("starts, reconnects to, reports, and cleanly stops the per-user service", async () => {
    const fixture = await createFixture("nexus cli lifecycle ");
    const opened = await runCli(fixture, ["open", "--no-open", "--json"], 30_000);
    expect(opened.code).toBe(0);
    const openResult = JSON.parse(opened.stdout);
    expect(openResult).toMatchObject({ ok: true, browserOpened: false, version: packageVersion });
    expect(openResult).not.toHaveProperty("token");

    const status = await runCli(fixture, ["status", "--json"]);
    expect(status.code).toBe(0);
    expect(JSON.parse(status.stdout)).toMatchObject({ ok: true, running: true, pid: openResult.pid, url: openResult.url });

    const stopped = await runCli(fixture, ["stop", "--json"]);
    expect(stopped.code).toBe(0);
    expect(JSON.parse(stopped.stdout)).toMatchObject({ ok: true, stopped: true, pid: openResult.pid });

    const finalStatus = await runCli(fixture, ["status", "--json"]);
    expect(JSON.parse(finalStatus.stdout)).toMatchObject({ ok: true, running: false });
  }, 45_000);

  it("converges concurrent launchers on one service instance", async () => {
    const fixture = await createFixture("nexus cli concurrent ");
    const launches = await Promise.all([
      runCli(fixture, ["open", "--no-open", "--json"], 30_000),
      runCli(fixture, ["open", "--no-open", "--json"], 30_000)
    ]);
    expect(launches.map((result) => result.code), JSON.stringify(launches)).toEqual([0, 0]);
    const results = launches.map((result) => JSON.parse(result.stdout));
    expect(results[0].pid).toBe(results[1].pid);
    expect(results[0].url).toBe(results[1].url);
  }, 45_000);

  it("self-terminates when its installation lease disappears", async () => {
    const fixture = await createFixture("nexus cli install lease ");
    const packageCopy = path.join(fixture.data, "installed-package.json");
    await writeFile(packageCopy, await readFile(path.join(root, "package.json"), "utf8"), "utf8");
    const opened = await runCli(fixture, ["open", "--no-open", "--json"], 30_000, { NEXUSHARNESS_PACKAGE_JSON: packageCopy });
    expect(opened.code).toBe(0);
    const result = JSON.parse(opened.stdout);

    await rm(packageCopy, { force: true });
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline && await endpointResponds(`${result.url}/api/health`)) {
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    expect(await endpointResponds(`${result.url}/api/health`)).toBe(false);
  }, 45_000);

  it("previews cleanup without deleting cache data", async () => {
    const fixture = await createFixture("nexus cli clean preview ");
    const cacheFile = path.join(fixture.data, "cache", "download.bin");
    await mkdir(path.dirname(cacheFile), { recursive: true });
    await writeFile(cacheFile, "cached", "utf8");

    const preview = await runCli(fixture, ["clean", "--dry-run", "--json"]);
    expect(preview.code).toBe(0);
    expect(JSON.parse(preview.stdout)).toMatchObject({ ok: true, dryRun: true, plan: { kind: "clean", targets: expect.any(Array) } });
    expect(await readFile(cacheFile, "utf8")).toBe("cached");
  });

  it("requires explicit purge confirmation and preserves an external workspace", async () => {
    const fixture = await createFixture("nexus cli purge ");
    const workspaceFile = path.join(fixture.cwd, "project.txt");
    const storeFile = path.join(fixture.data, "store.json");
    await Promise.all([
      writeFile(workspaceFile, "user project", "utf8"),
      writeFile(storeFile, JSON.stringify({ settings: { workspaceRoot: fixture.cwd }, runtimes: [], mcpServers: [], memory: [], audit: [], approvals: [], runs: [] }), "utf8")
    ]);

    const preview = await runCli(fixture, ["uninstall", "--purge", "--dry-run", "--json"]);
    expect(preview.code).toBe(0);
    expect(JSON.parse(preview.stdout)).toMatchObject({ ok: true, dryRun: true, plan: { kind: "purge" } });
    expect(await readFile(storeFile, "utf8")).toContain("workspaceRoot");

    const unconfirmed = await runCli(fixture, ["uninstall", "--purge", "--non-interactive", "--json"]);
    expect(unconfirmed.code).toBe(10);
    expect(JSON.parse(unconfirmed.stdout)).toMatchObject({ ok: false, error: { code: "CONFIRMATION_REQUIRED" } });

    const purged = await runCli(fixture, ["uninstall", "--purge", "--non-interactive", "--confirm-purge", "--json"]);
    expect(purged.code).toBe(0);
    expect(JSON.parse(purged.stdout)).toMatchObject({ ok: true, purged: true });
    expect(await readFile(workspaceFile, "utf8")).toBe("user project");
    await expect(readFile(storeFile, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("previews and idempotently migrates an explicit legacy store", async () => {
    const fixture = await createFixture("nexus cli migration ");
    const legacy = path.join(fixture.cwd, ".nexusharness");
    await mkdir(legacy, { recursive: true });
    await writeFile(path.join(legacy, "store.json"), JSON.stringify({ settings: { workspaceRoot: fixture.cwd }, runtimes: [], mcpServers: [], memory: [], audit: [], approvals: [], runs: [] }), "utf8");

    const preview = await runCli(fixture, ["migrate", "--from", legacy, "--dry-run", "--json"]);
    expect(preview.code).toBe(0);
    expect(JSON.parse(preview.stdout)).toMatchObject({ ok: true, dryRun: true, sourcePreserved: true, plan: { source: legacy } });
    await expect(readFile(path.join(fixture.data, "store.json"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });

    const migrated = await runCli(fixture, ["migrate", "--from", legacy, "--non-interactive", "--confirm-migration", "--json"]);
    expect(migrated.code).toBe(0);
    expect(JSON.parse(migrated.stdout)).toMatchObject({ ok: true, result: { migrated: true, sourcePreserved: true } });
    expect(await readFile(path.join(legacy, "store.json"), "utf8")).toContain("workspaceRoot");
    expect(await readFile(path.join(fixture.data, "store.json"), "utf8")).toContain("workspaceRoot");

    const repeated = await runCli(fixture, ["migrate", "--from", legacy, "--non-interactive", "--confirm-migration", "--json"]);
    expect(JSON.parse(repeated.stdout)).toMatchObject({ ok: true, result: { migrated: false, alreadyMigrated: true } });
  });

  it("repairs malformed service state only when requested", async () => {
    const fixture = await createFixture("nexus cli doctor repair ");
    const stateFile = path.join(fixture.data, "state", "service.json");
    await mkdir(path.dirname(stateFile), { recursive: true });
    await writeFile(stateFile, "{malformed", "utf8");

    const diagnosed = await runCli(fixture, ["doctor", "--json"]);
    expect(diagnosed.code).toBe(3);
    expect(JSON.parse(diagnosed.stdout)).toMatchObject({ ok: false, plannedRepairs: expect.arrayContaining([expect.stringContaining("malformed service state")]) });
    expect(await readFile(stateFile, "utf8")).toBe("{malformed");

    const repaired = await runCli(fixture, ["doctor", "--repair", "--json"]);
    expect(repaired.code).toBe(0);
    expect(JSON.parse(repaired.stdout)).toMatchObject({ ok: true, appliedRepairs: expect.arrayContaining([expect.stringContaining("malformed service state")]) });
    await expect(readFile(stateFile, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("refuses purge when a malformed store prevents workspace verification", async () => {
    const fixture = await createFixture("nexus cli malformed purge ");
    const storeFile = path.join(fixture.data, "store.json");
    await writeFile(storeFile, "{broken", "utf8");
    const purge = await runCli(fixture, ["uninstall", "--purge", "--non-interactive", "--confirm-purge", "--json"]);
    expect(purge.code).toBe(3);
    expect(JSON.parse(purge.stdout)).toMatchObject({ ok: false, error: { code: "STORE_INVALID" } });
    expect(await readFile(storeFile, "utf8")).toBe("{broken");
  });
});

async function createFixture(prefix: string): Promise<{ cwd: string; data: string }> {
  const fixture = {
    cwd: await mkdtemp(path.join(tmpdir(), prefix)),
    data: await mkdtemp(path.join(tmpdir(), "nexusharness-cli-data-"))
  };
  fixtures.push(fixture);
  return fixture;
}

function runCli(fixture: { cwd: string; data: string }, args: string[], timeout = 15_000, extraEnvironment: Record<string, string> = {}): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [tsxEntry, cliEntry, ...args], {
      cwd: fixture.cwd,
      windowsHide: true,
      env: {
        ...process.env,
        NEXUSHARNESS_INSTALL_ROOT: root,
        NEXUSHARNESS_SERVER_ENTRY: path.join(root, "server", "index.ts"),
        NEXUSHARNESS_WEB_ROOT: path.join(root, "dist"),
        NEXUSHARNESS_DATA_DIR: fixture.data,
        ...extraEnvironment
      }
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`CLI timed out. stdout=${stdout} stderr=${stderr}`));
    }, timeout);
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? -1, stdout: stdout.trim(), stderr: stderr.trim() });
    });
  });
}

async function endpointResponds(url: string): Promise<boolean> {
  try {
    return (await fetch(url, { signal: AbortSignal.timeout(500) })).ok;
  } catch {
    return false;
  }
}

async function killRecordedProcess(data: string): Promise<void> {
  try {
    const state = JSON.parse(await readFile(path.join(data, "state", "service.json"), "utf8")) as { pid?: number };
    if (state.pid) process.kill(state.pid);
  } catch { /* service already stopped */ }
}

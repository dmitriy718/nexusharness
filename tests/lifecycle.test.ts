import { afterEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { buildCleanPlan, buildPurgePlan, executeLegacyMigration, executeRemovalPlan, planLegacyMigration } from "../cli/lifecycle";
import type { UserPaths } from "../server/paths";

const sandboxes: string[] = [];

afterEach(async () => {
  await Promise.all(sandboxes.splice(0).map((sandbox) => rm(sandbox, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })));
});

describe("safe NexusHarness data lifecycle", () => {
  it("purges Nexus-owned state while preserving a nested configured workspace", async () => {
    const fixture = await lifecycleFixture();
    await Promise.all([
      writeFile(path.join(fixture.paths.dataRoot, "store.json"), store(fixture.workspace), "utf8"),
      writeFile(path.join(fixture.workspace, "user-project.txt"), "preserve me", "utf8"),
      writeFile(path.join(fixture.paths.cacheRoot, "cache.bin"), "cache", "utf8"),
      writeFile(path.join(fixture.paths.stateRoot, "service.tmp"), "state", "utf8"),
      writeFile(path.join(fixture.paths.configRoot, "settings.tmp"), "config", "utf8")
    ]);

    const plan = await buildPurgePlan({ paths: fixture.paths, installRoot: fixture.install, workspaceRoot: fixture.workspace });
    expect(plan.targets.length).toBeGreaterThan(0);
    expect(plan.targets.some((target) => overlaps(target.path, fixture.workspace))).toBe(false);
    expect(plan.preserved.some((entry) => overlaps(entry.path, fixture.workspace))).toBe(true);

    const result = await executeRemovalPlan(plan);
    expect(result.failed).toEqual([]);
    expect(await readFile(path.join(fixture.workspace, "user-project.txt"), "utf8")).toBe("preserve me");
    await expect(readFile(path.join(fixture.paths.dataRoot, "store.json"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("preserves an installed application nested under an incorrectly broad data override", async () => {
    const fixture = await lifecycleFixture();
    const nestedInstall = path.join(fixture.paths.dataRoot, "installed-app");
    await mkdir(nestedInstall, { recursive: true });
    await writeFile(path.join(nestedInstall, "package.json"), "{}", "utf8");
    await writeFile(path.join(fixture.paths.dataRoot, "store.json"), store(fixture.workspace), "utf8");

    const plan = await buildPurgePlan({ paths: fixture.paths, installRoot: nestedInstall, workspaceRoot: fixture.workspace });
    expect(plan.targets.some((target) => overlaps(target.path, nestedInstall))).toBe(false);
    await executeRemovalPlan(plan);
    expect(await readFile(path.join(nestedInstall, "package.json"), "utf8")).toBe("{}");
  });

  it("refuses to treat a filesystem root as Nexus-owned", async () => {
    const fixture = await lifecycleFixture();
    const filesystemRoot = path.parse(fixture.sandbox).root;
    const paths = { ...fixture.paths, dataRoot: filesystemRoot, configRoot: filesystemRoot, stateRoot: filesystemRoot, cacheRoot: filesystemRoot };
    await expect(buildPurgePlan({ paths, installRoot: fixture.install, workspaceRoot: fixture.workspace })).rejects.toThrow(/filesystem root/i);
  });

  it("cleans caches without deleting the store or workspace", async () => {
    const fixture = await lifecycleFixture();
    const embeddingCache = path.join(fixture.paths.dataRoot, "embedding-models");
    await mkdir(embeddingCache, { recursive: true });
    await Promise.all([
      writeFile(path.join(fixture.paths.dataRoot, "store.json"), store(fixture.workspace), "utf8"),
      writeFile(path.join(fixture.workspace, "project.txt"), "project", "utf8"),
      writeFile(path.join(fixture.paths.cacheRoot, "http.cache"), "cache", "utf8"),
      writeFile(path.join(embeddingCache, "model.cache"), "model", "utf8")
    ]);

    const plan = await buildCleanPlan({ paths: fixture.paths, installRoot: fixture.install, workspaceRoot: fixture.workspace });
    const result = await executeRemovalPlan(plan);
    expect(result.failed).toEqual([]);
    expect(JSON.parse(await readFile(path.join(fixture.paths.dataRoot, "store.json"), "utf8"))).toHaveProperty("settings.workspaceRoot", fixture.workspace);
    expect(await readFile(path.join(fixture.workspace, "project.txt"), "utf8")).toBe("project");
    await expect(readFile(path.join(embeddingCache, "model.cache"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("reports durable roots as preserved when --keep-data is selected", async () => {
    const fixture = await lifecycleFixture();
    await writeFile(path.join(fixture.paths.dataRoot, "store.json"), store(fixture.workspace), "utf8");
    const plan = await buildPurgePlan({ paths: fixture.paths, installRoot: fixture.install, workspaceRoot: fixture.workspace, keepData: true, keepCredentials: true });
    expect(plan).toMatchObject({ keepData: true, keepCredentials: true, credentialsManaged: false });
    expect(plan.preserved).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: fixture.paths.configRoot, reason: expect.stringContaining("--keep-data") }),
      expect.objectContaining({ path: fixture.paths.dataRoot, reason: expect.stringContaining("--keep-data") })
    ]));
    expect(plan.targets.some((target) => target.path === fixture.paths.dataRoot || target.path === fixture.paths.configRoot)).toBe(false);
  });

  it("removes a Nexus-owned junction without following it outside the data root", async () => {
    const fixture = await lifecycleFixture();
    const outside = path.join(fixture.sandbox, "outside-purge");
    const junction = path.join(fixture.paths.dataRoot, "linked-outside");
    await mkdir(outside, { recursive: true });
    await writeFile(path.join(outside, "user.txt"), "outside data", "utf8");
    await symlink(outside, junction, "junction");

    const plan = await buildPurgePlan({ paths: fixture.paths, installRoot: fixture.install, workspaceRoot: fixture.workspace });
    expect(plan.targets).toEqual(expect.arrayContaining([expect.objectContaining({ path: junction })]));
    const result = await executeRemovalPlan(plan);
    expect(result.failed).toEqual([]);
    expect(await readFile(path.join(outside, "user.txt"), "utf8")).toBe("outside data");
  });

  it("preserves unknown siblings in an explicit data override", async () => {
    const fixture = await lifecycleFixture();
    const unknown = path.join(fixture.paths.dataRoot, "family-photos");
    await mkdir(unknown, { recursive: true });
    await Promise.all([
      writeFile(path.join(fixture.paths.dataRoot, "store.json"), store(fixture.workspace), "utf8"),
      writeFile(path.join(unknown, "photo.txt"), "not Nexus-owned", "utf8")
    ]);

    const plan = await buildPurgePlan({ paths: fixture.paths, installRoot: fixture.install, workspaceRoot: fixture.workspace, explicitDataOverride: true });
    expect(plan.preserved).toEqual(expect.arrayContaining([expect.objectContaining({ path: unknown, reason: expect.stringContaining("ownership was not inferred") })]));
    const result = await executeRemovalPlan(plan);
    expect(result.failed).toEqual([]);
    expect(await readFile(path.join(unknown, "photo.txt"), "utf8")).toBe("not Nexus-owned");
    await expect(readFile(path.join(fixture.paths.dataRoot, "store.json"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("copies and verifies legacy data, preserves the source, and is idempotent", async () => {
    const fixture = await lifecycleFixture();
    const source = path.join(fixture.sandbox, ".nexusharness");
    const destination = path.join(fixture.sandbox, "migrated-data");
    await mkdir(path.join(source, "memory"), { recursive: true });
    await mkdir(path.join(source, "cache"), { recursive: true });
    await Promise.all([
      writeFile(path.join(source, "store.json"), store(fixture.workspace), "utf8"),
      writeFile(path.join(source, "memory", "notes.txt"), "durable memory", "utf8"),
      writeFile(path.join(source, "memory-vectors.sqlite"), sqliteHeader()),
      writeFile(path.join(source, "cache", "skip.bin"), "disposable", "utf8")
    ]);

    const plan = await planLegacyMigration(source, destination);
    expect(plan.files.map((file) => file.relativePath)).not.toContain("cache/skip.bin");
    const first = await executeLegacyMigration(plan);
    expect(first).toMatchObject({ migrated: true, alreadyMigrated: false, sourcePreserved: true, filesCopied: 3 });
    expect(JSON.parse(await readFile(path.join(source, "store.json"), "utf8"))).toHaveProperty("settings.workspaceRoot", fixture.workspace);
    expect(await readFile(path.join(destination, "memory", "notes.txt"), "utf8")).toBe("durable memory");

    const second = await executeLegacyMigration(plan);
    expect(second).toMatchObject({ migrated: false, alreadyMigrated: true, sourcePreserved: true, filesCopied: 0 });
  });

  it("rejects conflicting destination files before copying anything", async () => {
    const fixture = await lifecycleFixture();
    const source = path.join(fixture.sandbox, "legacy-conflict");
    const destination = path.join(fixture.sandbox, "destination-conflict");
    await Promise.all([mkdir(source, { recursive: true }), mkdir(destination, { recursive: true })]);
    await Promise.all([
      writeFile(path.join(source, "store.json"), store(fixture.workspace), "utf8"),
      writeFile(path.join(source, "memory.txt"), "source", "utf8"),
      writeFile(path.join(destination, "memory.txt"), "different", "utf8")
    ]);
    await expect(planLegacyMigration(source, destination)).rejects.toThrow(/destination conflict/i);
    await expect(readFile(path.join(destination, "store.json"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects symbolic links in legacy data", async () => {
    const fixture = await lifecycleFixture();
    const source = path.join(fixture.sandbox, "legacy-symlink");
    const outside = path.join(fixture.sandbox, "outside");
    await Promise.all([mkdir(source, { recursive: true }), mkdir(outside, { recursive: true })]);
    await writeFile(path.join(source, "store.json"), store(fixture.workspace), "utf8");
    await writeFile(path.join(outside, "secret.txt"), "outside", "utf8");
    await symlink(outside, path.join(source, "linked-outside"), "junction");
    await expect(planLegacyMigration(source, path.join(fixture.sandbox, "destination"))).rejects.toThrow(/refuses symbolic links/i);
  });
});

async function lifecycleFixture(): Promise<{ sandbox: string; paths: UserPaths; workspace: string; install: string }> {
  const sandbox = await mkdtemp(path.join(tmpdir(), "nexusharness-lifecycle-"));
  sandboxes.push(sandbox);
  const dataRoot = path.join(sandbox, "owned");
  const workspace = path.join(dataRoot, "workspace");
  const install = path.join(sandbox, "install");
  const stateRoot = path.join(dataRoot, "state");
  const paths: UserPaths = {
    configRoot: path.join(dataRoot, "config"),
    dataRoot,
    stateRoot,
    cacheRoot: path.join(dataRoot, "cache"),
    serviceState: path.join(stateRoot, "service.json"),
    serviceLock: path.join(stateRoot, "service-start.lock")
  };
  await Promise.all([mkdir(workspace, { recursive: true }), mkdir(install, { recursive: true }), mkdir(paths.configRoot, { recursive: true }), mkdir(paths.stateRoot, { recursive: true }), mkdir(paths.cacheRoot, { recursive: true })]);
  return { sandbox, paths, workspace, install };
}

function store(workspaceRoot: string): string {
  return `${JSON.stringify({ settings: { workspaceRoot }, runtimes: [], mcpServers: [], memory: [], audit: [], approvals: [], runs: [] }, null, 2)}\n`;
}

function sqliteHeader(): Buffer {
  return Buffer.from("SQLite format 3\u0000", "binary");
}

function overlaps(left: string, right: string): boolean {
  const contains = (root: string, candidate: string) => {
    const relative = path.relative(path.resolve(root), path.resolve(candidate));
    return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
  };
  return contains(left, right) || contains(right, left);
}

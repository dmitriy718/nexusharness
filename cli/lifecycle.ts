import { createHash, randomBytes } from "node:crypto";
import { createReadStream } from "node:fs";
import { copyFile, lstat, mkdir, open, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { UserPaths } from "../server/paths.js";

export interface RemovalTarget {
  path: string;
  category: "config" | "data" | "state" | "cache";
  bytes: number;
}

export interface RemovalPlan {
  kind: "clean" | "purge";
  targets: RemovalTarget[];
  preserved: Array<{ path: string; reason: string }>;
  ownedRoots: string[];
  protectedPaths: string[];
  totalBytes: number;
  keepData: boolean;
  keepCredentials: boolean;
  credentialsManaged: false;
}

export interface RemovalResult {
  removed: RemovalTarget[];
  failed: Array<{ path: string; error: string }>;
  preserved: RemovalPlan["preserved"];
  credentials: { managed: false; removed: string[]; preserved: boolean };
}

export interface LegacyMigrationPlan {
  source: string;
  destination: string;
  files: Array<{ relativePath: string; bytes: number; sha256: string }>;
  totalBytes: number;
  manifestDigest: string;
}

export interface LegacyMigrationResult {
  migrated: boolean;
  alreadyMigrated: boolean;
  sourcePreserved: true;
  filesCopied: number;
  bytesCopied: number;
  marker: string;
}

interface RemovalPlanOptions {
  paths: UserPaths;
  installRoot: string;
  workspaceRoot?: string | null;
  keepData?: boolean;
  keepCredentials?: boolean;
  explicitDataOverride?: boolean;
}

const MIGRATION_MARKER = "legacy-migration-v1.json";
const MAX_INSPECTED_ENTRIES = 100_000;

export async function buildPurgePlan(options: RemovalPlanOptions): Promise<RemovalPlan> {
  const roots = options.keepData
    ? [root("state", options.paths.stateRoot), root("cache", options.paths.cacheRoot)]
    : [
        root("config", options.paths.configRoot),
        root("data", options.paths.dataRoot, Boolean(options.explicitDataOverride)),
        root("state", options.paths.stateRoot),
        root("cache", options.paths.cacheRoot)
      ];
  const plan = await buildRemovalPlan("purge", roots, options);
  if (options.keepData) {
    plan.preserved.push(
      { path: path.resolve(options.paths.configRoot), reason: "Preserved by --keep-data." },
      { path: path.resolve(options.paths.dataRoot), reason: "Preserved by --keep-data." }
    );
  }
  return plan;
}

export async function buildCleanPlan(options: RemovalPlanOptions): Promise<RemovalPlan> {
  const roots = [
    root("cache", options.paths.cacheRoot),
    root("cache", path.join(options.paths.dataRoot, "embedding-models"))
  ];
  return buildRemovalPlan("clean", roots, { ...options, keepData: true, keepCredentials: true });
}

export async function executeRemovalPlan(plan: RemovalPlan): Promise<RemovalResult> {
  const removed: RemovalTarget[] = [];
  const failed: Array<{ path: string; error: string }> = [];
  for (const target of plan.targets) {
    try {
      assertRemovalTarget(target.path, plan.ownedRoots, plan.protectedPaths);
      await rm(target.path, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
      removed.push(target);
    } catch (error) {
      failed.push({ path: target.path, error: error instanceof Error ? error.message : String(error) });
    }
  }
  return {
    removed,
    failed,
    preserved: plan.preserved,
    credentials: { managed: false, removed: [], preserved: true }
  };
}

export async function discoverLegacyDirectories(installRoot: string, launchDirectory: string, destination: string, workspaceRoot?: string | null): Promise<string[]> {
  const candidates = [
    path.join(installRoot, ".nexusharness"),
    path.join(launchDirectory, ".nexusharness"),
    ...(workspaceRoot ? [path.join(workspaceRoot, ".nexusharness")] : [])
  ];
  const unique = new Map<string, string>();
  for (const candidate of candidates) {
    const resolved = path.resolve(candidate);
    if (samePath(resolved, destination) || pathsOverlap(resolved, destination) || unique.has(pathKey(resolved))) continue;
    try {
      if ((await lstat(resolved)).isDirectory()) unique.set(pathKey(resolved), resolved);
    } catch (error: any) {
      if (error?.code !== "ENOENT") throw error;
    }
  }
  return [...unique.values()];
}

export async function planLegacyMigration(source: string, destination: string): Promise<LegacyMigrationPlan> {
  const resolvedSource = path.resolve(source);
  const resolvedDestination = path.resolve(destination);
  if (pathsOverlap(resolvedSource, resolvedDestination)) throw new Error("Legacy source and destination must not overlap.");
  const sourceMetadata = await lstat(resolvedSource);
  if (!sourceMetadata.isDirectory() || sourceMetadata.isSymbolicLink()) throw new Error("Legacy migration source must be a real directory.");
  const files = await fileManifest(resolvedSource, true);
  if (!files.some((file) => file.relativePath === "store.json" || file.relativePath === "memory-vectors.sqlite")) {
    throw new Error("Legacy migration source does not contain a NexusHarness store or vector database.");
  }
  await validateStoreAndDatabases(resolvedSource, files.map((file) => file.relativePath));
  const manifestDigest = createHash("sha256").update(JSON.stringify(files)).digest("hex");
  const plan = { source: resolvedSource, destination: resolvedDestination, files, totalBytes: files.reduce((sum, file) => sum + file.bytes, 0), manifestDigest };
  await preflightDestination(plan);
  return plan;
}

export async function executeLegacyMigration(plan: LegacyMigrationPlan): Promise<LegacyMigrationResult> {
  const marker = path.join(plan.destination, MIGRATION_MARKER);
  try {
    const existing = JSON.parse(await readFile(marker, "utf8")) as { source?: string; manifestDigest?: string };
    if (samePath(existing.source ?? "", plan.source) && existing.manifestDigest === plan.manifestDigest) {
      return { migrated: false, alreadyMigrated: true, sourcePreserved: true, filesCopied: 0, bytesCopied: 0, marker };
    }
  } catch (error: any) {
    if (error?.code !== "ENOENT" && !(error instanceof SyntaxError)) throw error;
  }

  await preflightDestination(plan);
  const staging = path.join(path.dirname(plan.destination), `.nexusharness-migration-${process.pid}-${randomBytes(6).toString("hex")}`);
  await rm(staging, { recursive: true, force: true });
  await mkdir(staging, { recursive: true });
  try {
    for (const file of plan.files) {
      const staged = path.join(staging, file.relativePath);
      await mkdir(path.dirname(staged), { recursive: true });
      await copyFile(path.join(plan.source, file.relativePath), staged);
    }
    const stagedFiles = await fileManifest(staging, false);
    if (JSON.stringify(stagedFiles) !== JSON.stringify(plan.files)) throw new Error("Staged legacy data failed manifest verification.");
    await validateStoreAndDatabases(staging, stagedFiles.map((file) => file.relativePath));

    let filesCopied = 0;
    let bytesCopied = 0;
    for (const file of plan.files) {
      const destinationFile = path.join(plan.destination, file.relativePath);
      if (await fileMatches(destinationFile, file)) continue;
      await mkdir(path.dirname(destinationFile), { recursive: true });
      await rename(path.join(staging, file.relativePath), destinationFile);
      filesCopied += 1;
      bytesCopied += file.bytes;
    }
    await mkdir(plan.destination, { recursive: true });
    await writeFile(marker, `${JSON.stringify({
      schemaVersion: 1,
      source: plan.source,
      destination: plan.destination,
      manifestDigest: plan.manifestDigest,
      fileCount: plan.files.length,
      totalBytes: plan.totalBytes,
      completedAt: new Date().toISOString(),
      sourcePreserved: true
    }, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    return { migrated: true, alreadyMigrated: false, sourcePreserved: true, filesCopied, bytesCopied, marker };
  } finally {
    await rm(staging, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
}

async function buildRemovalPlan(kind: RemovalPlan["kind"], candidateRoots: Array<{ category: RemovalTarget["category"]; path: string; enumerateOnly?: boolean }>, options: RemovalPlanOptions): Promise<RemovalPlan> {
  const collapsedRoots = collapseRoots(candidateRoots.map((item) => ({ ...item, path: path.resolve(item.path) })));
  const protectedPaths = [options.workspaceRoot, options.installRoot].filter((item): item is string => Boolean(item)).map((item) => path.resolve(item));
  const targets: RemovalTarget[] = [];
  const preserved: RemovalPlan["preserved"] = [];
  for (const candidate of collapsedRoots) {
    if (isFilesystemRoot(candidate.path)) throw new Error(`Refusing to treat a filesystem root as Nexus-owned: ${candidate.path}`);
    let metadata;
    try { metadata = await lstat(candidate.path); }
    catch (error: any) {
      if (error?.code === "ENOENT") continue;
      throw error;
    }
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
      if (protectedPaths.some((protectedPath) => pathsOverlap(candidate.path, protectedPath))) {
        preserved.push({ path: candidate.path, reason: "Protected workspace or installation path." });
      } else {
        targets.push({ path: candidate.path, category: candidate.category, bytes: metadata.size });
      }
      continue;
    }
    const intersecting = protectedPaths.filter((protectedPath) => pathsOverlap(candidate.path, protectedPath));
    if (!intersecting.length && !candidate.enumerateOnly) {
      targets.push({ path: candidate.path, category: candidate.category, bytes: await pathSize(candidate.path) });
      continue;
    }
    if (intersecting.some((protectedPath) => samePath(candidate.path, protectedPath) || pathContains(protectedPath, candidate.path))) {
      preserved.push({ path: candidate.path, reason: "The Nexus-owned root overlaps a protected workspace or installation." });
      continue;
    }
    for (const entry of await readdir(candidate.path, { withFileTypes: true })) {
      const child = path.join(candidate.path, entry.name);
      if (candidate.enumerateOnly && !isRecognizedOverrideEntry(entry.name)) {
        preserved.push({ path: child, reason: "Unknown entry in an explicit data override; ownership was not inferred." });
        continue;
      }
      if (protectedPaths.some((protectedPath) => pathsOverlap(child, protectedPath))) {
        preserved.push({ path: child, reason: "Contains a configured workspace or installed application." });
        continue;
      }
      targets.push({ path: child, category: candidate.category, bytes: await pathSize(child) });
    }
  }
  const ownedRoots = collapsedRoots.map((item) => item.path);
  for (const target of targets) assertRemovalTarget(target.path, ownedRoots, protectedPaths);
  return {
    kind,
    targets,
    preserved,
    ownedRoots,
    protectedPaths,
    totalBytes: targets.reduce((sum, target) => sum + target.bytes, 0),
    keepData: Boolean(options.keepData),
    keepCredentials: Boolean(options.keepCredentials),
    credentialsManaged: false
  };
}

async function preflightDestination(plan: LegacyMigrationPlan): Promise<void> {
  for (const file of plan.files) {
    const destinationFile = path.join(plan.destination, file.relativePath);
    try {
      const metadata = await lstat(destinationFile);
      if (!metadata.isFile() || metadata.isSymbolicLink() || !await fileMatches(destinationFile, file)) {
        throw new Error(`Migration destination conflict: ${destinationFile}`);
      }
    } catch (error: any) {
      if (error?.code !== "ENOENT") throw error;
    }
  }
}

async function fileManifest(rootPath: string, excludeVolatile: boolean): Promise<Array<{ relativePath: string; bytes: number; sha256: string }>> {
  const files: Array<{ relativePath: string; bytes: number; sha256: string }> = [];
  let inspected = 0;
  async function visit(relativeDirectory: string): Promise<void> {
    const directory = path.join(rootPath, relativeDirectory);
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      inspected += 1;
      if (inspected > MAX_INSPECTED_ENTRIES) throw new Error(`Lifecycle inspection exceeded ${MAX_INSPECTED_ENTRIES.toLocaleString()} entries.`);
      const relativePath = path.join(relativeDirectory, entry.name);
      const normalized = relativePath.replaceAll("\\", "/");
      if (excludeVolatile && isVolatileLegacyPath(normalized)) continue;
      const fullPath = path.join(rootPath, relativePath);
      const metadata = await lstat(fullPath);
      if (metadata.isSymbolicLink()) throw new Error(`Legacy migration refuses symbolic links: ${fullPath}`);
      if (metadata.isDirectory()) await visit(relativePath);
      else if (metadata.isFile()) files.push({ relativePath: normalized, bytes: metadata.size, sha256: await sha256(fullPath) });
      else throw new Error(`Legacy migration refuses special filesystem entries: ${fullPath}`);
    }
  }
  await visit("");
  return files.sort((left, right) => left.relativePath.localeCompare(right.relativePath));
}

async function validateStoreAndDatabases(rootPath: string, relativePaths: string[]): Promise<void> {
  if (relativePaths.includes("store.json")) JSON.parse(await readFile(path.join(rootPath, "store.json"), "utf8"));
  for (const relativePath of relativePaths.filter((file) => file.endsWith(".sqlite") || file.endsWith(".sqlite3") || file.endsWith(".db"))) {
    const database = await open(path.join(rootPath, relativePath), "r");
    const header = Buffer.alloc(16);
    let bytesRead = 0;
    try { ({ bytesRead } = await database.read(header, 0, header.length, 0)); }
    finally { await database.close(); }
    if (bytesRead > 0 && header.subarray(0, bytesRead).toString("binary") !== "SQLite format 3\u0000".slice(0, bytesRead)) {
      throw new Error(`Legacy database has an invalid SQLite header: ${relativePath}`);
    }
  }
}

async function fileMatches(target: string, expected: { bytes: number; sha256: string }): Promise<boolean> {
  try {
    const metadata = await lstat(target);
    return metadata.isFile() && !metadata.isSymbolicLink() && metadata.size === expected.bytes && await sha256(target) === expected.sha256;
  } catch (error: any) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

async function sha256(file: string): Promise<string> {
  const hash = createHash("sha256");
  await new Promise<void>((resolve, reject) => {
    const stream = createReadStream(file);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.once("error", reject);
    stream.once("end", resolve);
  });
  return hash.digest("hex");
}

async function pathSize(target: string): Promise<number> {
  let inspected = 0;
  async function measure(candidate: string): Promise<number> {
    inspected += 1;
    if (inspected > MAX_INSPECTED_ENTRIES) throw new Error(`Lifecycle inspection exceeded ${MAX_INSPECTED_ENTRIES.toLocaleString()} entries.`);
    const metadata = await lstat(candidate);
    if (metadata.isSymbolicLink() || !metadata.isDirectory()) return metadata.size;
    let total = 0;
    for (const entry of await readdir(candidate)) total += await measure(path.join(candidate, entry));
    return total;
  }
  return measure(target);
}

function assertRemovalTarget(target: string, ownedRoots: string[], protectedPaths: string[]): void {
  const resolved = path.resolve(target);
  if (isFilesystemRoot(resolved)) throw new Error(`Refusing to remove filesystem root: ${resolved}`);
  if (!ownedRoots.some((ownedRoot) => pathContains(ownedRoot, resolved))) throw new Error(`Removal target is outside Nexus-owned roots: ${resolved}`);
  if (protectedPaths.some((protectedPath) => pathsOverlap(resolved, protectedPath))) throw new Error(`Removal target overlaps a protected workspace or installation: ${resolved}`);
}

function collapseRoots(roots: Array<{ category: RemovalTarget["category"]; path: string; enumerateOnly?: boolean }>): Array<{ category: RemovalTarget["category"]; path: string; enumerateOnly?: boolean }> {
  const unique = roots.filter((candidate, index) => roots.findIndex((other) => samePath(candidate.path, other.path)) === index);
  return unique.filter((candidate) => !unique.some((other) => !samePath(candidate.path, other.path) && pathContains(other.path, candidate.path)));
}

function root(category: RemovalTarget["category"], target: string, enumerateOnly = false): { category: RemovalTarget["category"]; path: string; enumerateOnly: boolean } {
  return { category, path: target, enumerateOnly };
}

function isVolatileLegacyPath(relativePath: string): boolean {
  const first = relativePath.split("/", 1)[0];
  return first === "state" || first === "cache" || first === "service.json" || first === "service-start.lock" || /^\.quickstart-write-test-/.test(first) || /\.tmp$/.test(first);
}

function isRecognizedOverrideEntry(name: string): boolean {
  return [
    "store.json", "memory-vectors.sqlite", "embedding-models", "execution", "transactions", "cells", "workspace",
    "config", "state", "cache", "bootstrap", MIGRATION_MARKER
  ].includes(name) || /^store\.json\..*\.tmp$/.test(name) || /^\.nexusharness-/.test(name);
}

function pathContains(rootPath: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(rootPath), path.resolve(candidate));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function pathsOverlap(left: string, right: string): boolean {
  return pathContains(left, right) || pathContains(right, left);
}

function samePath(left: string, right: string): boolean {
  return pathKey(path.resolve(left)) === pathKey(path.resolve(right));
}

function pathKey(candidate: string): string {
  return process.platform === "win32" ? candidate.toLowerCase() : candidate;
}

function isFilesystemRoot(candidate: string): boolean {
  const resolved = path.resolve(candidate);
  return resolved === path.parse(resolved).root;
}

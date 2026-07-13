import { existsSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export interface InstallationPaths {
  installRoot: string;
  packageJson: string;
  serverEntry: string;
  webRoot: string;
}

export interface UserPaths {
  configRoot: string;
  dataRoot: string;
  stateRoot: string;
  cacheRoot: string;
  serviceState: string;
  serviceLock: string;
}

export interface ServiceState {
  schemaVersion: 1;
  pid: number;
  port: number;
  token: string;
  version: string;
  installRoot: string;
  startedAt: string;
}

type Environment = Record<string, string | undefined>;

interface InstallationPathOptions {
  env?: Environment;
  exists?: (candidate: string) => boolean;
}

interface UserPathOptions {
  env?: Environment;
  platform?: NodeJS.Platform;
  home?: string;
}

export function resolveInstallationPaths(moduleUrl: string, options: InstallationPathOptions = {}): InstallationPaths {
  const env = options.env ?? process.env;
  const exists = options.exists ?? existsSync;
  const explicitRoot = env.NEXUSHARNESS_INSTALL_ROOT?.trim();
  const installRoot = explicitRoot ? path.resolve(explicitRoot) : discoverInstallRoot(moduleUrl, exists);
  const packageJson = resolveRequiredPath(env.NEXUSHARNESS_PACKAGE_JSON, [path.join(installRoot, "package.json")], "package metadata", exists);
  const serverEntry = resolveRequiredPath(env.NEXUSHARNESS_SERVER_ENTRY, [
    path.join(installRoot, "server", "index.js"),
    path.join(installRoot, "dist-server", "server", "index.js"),
    path.join(installRoot, "server", "index.ts")
  ], "server entry point", exists);
  const webRoot = resolveRequiredPath(env.NEXUSHARNESS_WEB_ROOT, [
    path.join(installRoot, "web"),
    path.join(installRoot, "dist")
  ], "browser assets", exists);
  return { installRoot, packageJson, serverEntry, webRoot };
}

export function resolveUserPaths(options: UserPathOptions = {}): UserPaths {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const pathApi = platform === "win32" ? path.win32 : path.posix;
  const home = pathApi.resolve(options.home ?? homedir());
  const override = env.NEXUSHARNESS_DATA_DIR?.trim();
  if (override) {
    const dataRoot = pathApi.resolve(override);
    const stateRoot = pathApi.join(dataRoot, "state");
    return {
      configRoot: pathApi.join(dataRoot, "config"),
      dataRoot,
      stateRoot,
      cacheRoot: pathApi.join(dataRoot, "cache"),
      serviceState: pathApi.join(stateRoot, "service.json"),
      serviceLock: pathApi.join(stateRoot, "service-start.lock")
    };
  }

  if (platform === "win32") {
    const appRoot = pathApi.join(pathApi.resolve(env.LOCALAPPDATA || pathApi.join(home, "AppData", "Local")), "NexusHarness");
    return applicationRootPaths(appRoot, pathApi);
  }
  if (platform === "darwin") {
    const supportRoot = pathApi.join(home, "Library", "Application Support", "NexusHarness");
    const paths = applicationRootPaths(supportRoot, pathApi);
    paths.cacheRoot = pathApi.join(home, "Library", "Caches", "NexusHarness");
    return paths;
  }

  const configRoot = pathApi.join(pathApi.resolve(env.XDG_CONFIG_HOME || pathApi.join(home, ".config")), "nexusharness");
  const dataRoot = pathApi.join(pathApi.resolve(env.XDG_DATA_HOME || pathApi.join(home, ".local", "share")), "nexusharness");
  const stateRoot = pathApi.join(pathApi.resolve(env.XDG_STATE_HOME || pathApi.join(home, ".local", "state")), "nexusharness");
  const cacheRoot = pathApi.join(pathApi.resolve(env.XDG_CACHE_HOME || pathApi.join(home, ".cache")), "nexusharness");
  return { configRoot, dataRoot, stateRoot, cacheRoot, serviceState: pathApi.join(stateRoot, "service.json"), serviceLock: pathApi.join(stateRoot, "service-start.lock") };
}

function discoverInstallRoot(moduleUrl: string, exists: (candidate: string) => boolean): string {
  let cursor = path.dirname(fileURLToPath(moduleUrl));
  for (let depth = 0; depth < 6; depth += 1) {
    if (exists(path.join(cursor, "package.json"))) return cursor;
    const parent = path.dirname(cursor);
    if (parent === cursor) break;
    cursor = parent;
  }
  throw new Error("Cannot locate the NexusHarness installation root. Set NEXUSHARNESS_INSTALL_ROOT to an absolute installation path.");
}

function resolveRequiredPath(explicit: string | undefined, candidates: string[], label: string, exists: (candidate: string) => boolean): string {
  const paths = explicit?.trim() ? [path.resolve(explicit)] : candidates;
  const resolved = paths.find(exists);
  if (resolved) return resolved;
  throw new Error(`Cannot locate NexusHarness ${label}. Checked: ${paths.join(", ")}`);
}

function applicationRootPaths(appRoot: string, pathApi: typeof path.posix | typeof path.win32): UserPaths {
  const stateRoot = pathApi.join(appRoot, "state");
  return {
    configRoot: pathApi.join(appRoot, "config"),
    dataRoot: pathApi.join(appRoot, "data"),
    stateRoot,
    cacheRoot: pathApi.join(appRoot, "cache"),
    serviceState: pathApi.join(stateRoot, "service.json"),
    serviceLock: pathApi.join(stateRoot, "service-start.lock")
  };
}

export const installationPaths = resolveInstallationPaths(import.meta.url);
export const userPaths = resolveUserPaths();

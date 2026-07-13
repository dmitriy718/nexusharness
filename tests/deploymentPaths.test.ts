import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { resolveInstallationPaths, resolveUserPaths } from "../server/paths";

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("deployment path resolution", () => {
  it("discovers installation resources relative to the executing module", async () => {
    const root = await temporaryRoot();
    await Promise.all([
      mkdir(path.join(root, "dist-server", "cli"), { recursive: true }),
      mkdir(path.join(root, "dist-server", "server"), { recursive: true }),
      mkdir(path.join(root, "dist"), { recursive: true }),
      writeFile(path.join(root, "package.json"), '{"version":"1.2.3"}', "utf8")
    ]);
    await Promise.all([
      writeFile(path.join(root, "dist-server", "server", "index.js"), "", "utf8"),
      writeFile(path.join(root, "dist", "index.html"), "", "utf8")
    ]);

    const paths = resolveInstallationPaths(pathToFileURL(path.join(root, "dist-server", "cli", "index.js")).href);

    expect(paths).toEqual({
      installRoot: root,
      packageJson: path.join(root, "package.json"),
      serverEntry: path.join(root, "dist-server", "server", "index.js"),
      webRoot: path.join(root, "dist")
    });
  });

  it("uses an explicit data override without depending on the current directory", () => {
    const paths = resolveUserPaths({ env: { NEXUSHARNESS_DATA_DIR: "D:/portable data" }, platform: "win32", home: "C:/Users/test" });
    expect(paths.dataRoot).toBe(path.resolve("D:/portable data"));
    expect(paths.serviceState).toBe(path.join(path.resolve("D:/portable data"), "state", "service.json"));
  });

  it("uses LocalAppData on Windows", () => {
    const paths = resolveUserPaths({ env: { LOCALAPPDATA: "C:/Users/test/AppData/Local" }, platform: "win32", home: "C:/Users/test" });
    expect(paths.dataRoot).toBe(path.resolve("C:/Users/test/AppData/Local/NexusHarness/data"));
    expect(paths.stateRoot).toBe(path.resolve("C:/Users/test/AppData/Local/NexusHarness/state"));
  });

  it("uses Application Support and the platform cache on macOS", () => {
    const paths = resolveUserPaths({ env: {}, platform: "darwin", home: "/Users/test" });
    expect(paths.dataRoot).toBe("/Users/test/Library/Application Support/NexusHarness/data");
    expect(paths.cacheRoot).toBe("/Users/test/Library/Caches/NexusHarness");
  });

  it("honors XDG locations on Linux", () => {
    const paths = resolveUserPaths({
      env: { XDG_CONFIG_HOME: "/xdg/config", XDG_DATA_HOME: "/xdg/data", XDG_STATE_HOME: "/xdg/state", XDG_CACHE_HOME: "/xdg/cache" },
      platform: "linux",
      home: "/home/test"
    });
    expect(paths).toMatchObject({
      configRoot: "/xdg/config/nexusharness",
      dataRoot: "/xdg/data/nexusharness",
      stateRoot: "/xdg/state/nexusharness",
      cacheRoot: "/xdg/cache/nexusharness"
    });
  });
});

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "nexusharness-paths-"));
  temporaryRoots.push(root);
  return root;
}

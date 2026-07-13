import { mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { assertRunHostSafety, assertWorkspaceSeparatedFromInstallation, pathsOverlap } from "../server/execution/hostSafety.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "nexusharness-host-safety-"));
  roots.push(root);
  const install = path.join(root, "install");
  const workspace = path.join(root, "workspace");
  await Promise.all([mkdir(install), mkdir(workspace)]);
  return { root, install, workspace };
}

describe("host execution safety", () => {
  it("recognizes equal, parent, and child path overlap", () => {
    expect(pathsOverlap("C:/Nexus", "C:/Nexus")).toBe(true);
    expect(pathsOverlap("C:/Nexus", "C:/Nexus/workspace")).toBe(true);
    expect(pathsOverlap("C:/Nexus/workspace", "C:/Nexus")).toBe(true);
    expect(pathsOverlap("C:/Nexus", "C:/Nexus-other")).toBe(false);
  });

  it("rejects the installation, its descendants, and its ancestors as run workspaces", async () => {
    const { root, install } = await fixture();
    const nested = path.join(install, "workspace");
    await mkdir(nested);
    await expect(assertWorkspaceSeparatedFromInstallation(install, install)).rejects.toThrow(/Refusing unsafe workspace/);
    await expect(assertWorkspaceSeparatedFromInstallation(nested, install)).rejects.toThrow(/cannot be the NexusHarness installation/);
    await expect(assertWorkspaceSeparatedFromInstallation(root, install)).rejects.toThrow(/cannot be the NexusHarness installation/);
  });

  it("resolves links before deciding whether a workspace overlaps the installation", async () => {
    const { root, install } = await fixture();
    const linked = path.join(root, "linked-workspace");
    await symlink(install, linked, process.platform === "win32" ? "junction" : "dir");
    await expect(assertWorkspaceSeparatedFromInstallation(linked, install)).rejects.toThrow(/Refusing unsafe workspace/);
  });

  it("accepts a separate workspace and requires approvals for deliberate compatibility mode", async () => {
    const { install, workspace } = await fixture();
    await expect(assertRunHostSafety({ workspaceRoot: workspace, approvalMode: true }, "transactional", install)).resolves.toBeUndefined();
    await expect(assertRunHostSafety({ workspaceRoot: workspace, approvalMode: false }, "compatibility", install)).rejects.toThrow(/requires Approval mode/);
    await expect(assertRunHostSafety({ workspaceRoot: workspace, approvalMode: true }, "compatibility", install)).resolves.toBeUndefined();
  });
});

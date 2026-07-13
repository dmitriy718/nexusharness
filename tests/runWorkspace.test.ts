import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { defaultRunExportBase, prepareRunExportWorkspace, runExportPath } from "../server/execution/runWorkspace.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("isolated run export workspace", () => {
  it("uses $HOME/.nexusharness/<task-id> by default", () => {
    const simulatedHome = path.join(path.parse(process.cwd()).root, "Users", "current-user");
    expect(defaultRunExportBase(simulatedHome, {})).toBe(path.resolve(simulatedHome, ".nexusharness"));
    expect(runExportPath("task_123", path.join(simulatedHome, ".nexusharness"))).toBe(path.resolve(simulatedHome, ".nexusharness", "task_123"));
    expect(defaultRunExportBase(simulatedHome, { NEXUSHARNESS_RUN_EXPORT_DIR: "D:/isolated-runs" })).toBe(path.resolve("D:/isolated-runs"));
    expect(() => runExportPath("../escape", "C:/safe")).toThrow(/safe task identifier/);
  });

  it("creates an owned clean Git repository and safely reopens it", async () => {
    const base = await mkdtemp(path.join(tmpdir(), "nexusharness-run-exports-"));
    roots.push(base);
    const workspace = await prepareRunExportWorkspace("task-safe", base);
    const marker = JSON.parse(await readFile(path.join(workspace, ".nexusharness-run.json"), "utf8"));
    expect(marker).toMatchObject({ schemaVersion: 1, taskId: "task-safe" });
    await expect(prepareRunExportWorkspace("task-safe", base)).resolves.toBe(workspace);
  });

  it("refuses to adopt an existing directory without matching ownership metadata", async () => {
    const base = await mkdtemp(path.join(tmpdir(), "nexusharness-run-exports-"));
    roots.push(base);
    await mkdir(path.join(base, "task-collision"));
    await expect(prepareRunExportWorkspace("task-collision", base)).rejects.toThrow(/unowned run export workspace/);
  });
});

import { describe, expect, it } from "vitest";
import type { SettingsShape } from "../src/api/types";
import { dirtySettingSections, restoreSettingsSection, sectionHasChanges, validateSettings } from "../src/features/settings/settingsModel";

const settings: SettingsShape = { workspaceRoot: "D:/project", layout: "chat", maxIterations: 5, maxParallelExecutors: 3, criticThreshold: 7, approvalMode: true, shellPath: "powershell.exe", testCommand: "npm test", lintCommand: "npm run lint", mcpAutoDiscovery: true, mcpPortStart: 3000, mcpPortEnd: 9999, memoryTokenBudget: 2000, agentModels: {} };

describe("settings workflow model", () => {
  it("validates required fields, units, bounds, and port order", () => {
    expect(validateSettings(settings)).toEqual({});
    expect(validateSettings({ ...settings, workspaceRoot: "", maxIterations: 0, mcpPortStart: 10000, mcpPortEnd: 9999, memoryTokenBudget: 50001 })).toMatchObject({ workspaceRoot: expect.any(String), maxIterations: expect.any(String), mcpPortStart: expect.any(String), memoryTokenBudget: expect.any(String) });
  });

  it("reports dirty routed sections without treating agent assignments as page edits", () => {
    const draft = { ...settings, approvalMode: false, memoryTokenBudget: 3000, agentModels: { planner: "runtime:model" } };
    expect(dirtySettingSections(settings, draft)).toEqual(["safety", "memory"]);
    expect(sectionHasChanges(settings, draft, "safety")).toBe(true);
    expect(sectionHasChanges(settings, draft, "workspace")).toBe(false);
  });

  it("restores only the requested section defaults", () => {
    const draft = { ...settings, maxIterations: 12, criticThreshold: 4, approvalMode: false };
    expect(restoreSettingsSection(draft, "execution")).toMatchObject({ maxIterations: 5, maxParallelExecutors: 3, criticThreshold: 7, approvalMode: false });
    expect(restoreSettingsSection(draft, "safety")).toMatchObject({ maxIterations: 12, approvalMode: true });
  });
});

import type { SettingsShape } from "../../api/types";

export type SettingsSectionId = "workspace" | "execution" | "safety" | "integrations" | "memory" | "appearance" | "advanced";

const sectionKeys: Record<SettingsSectionId, Array<keyof SettingsShape>> = {
  workspace: ["workspaceRoot", "testCommand", "lintCommand", "shellPath"],
  execution: ["maxIterations", "maxParallelExecutors", "criticThreshold"],
  safety: ["approvalMode"],
  integrations: ["mcpAutoDiscovery", "mcpPortStart", "mcpPortEnd"],
  memory: ["memoryTokenBudget"],
  appearance: ["layout"],
  advanced: []
};

export function validateSettings(settings: SettingsShape): Record<string, string> {
  const errors: Record<string, string> = {};
  if (!settings.workspaceRoot.trim()) errors.workspaceRoot = "Workspace root is required.";
  if (!settings.shellPath.trim()) errors.shellPath = "Shell executable is required.";
  if (!Number.isInteger(settings.maxIterations) || settings.maxIterations < 1 || settings.maxIterations > 25) errors.maxIterations = "Use 1–25 cycles.";
  if (!Number.isInteger(settings.maxParallelExecutors) || settings.maxParallelExecutors < 1 || settings.maxParallelExecutors > 12) errors.maxParallelExecutors = "Use 1–12 agents.";
  if (!Number.isInteger(settings.criticThreshold) || settings.criticThreshold < 1 || settings.criticThreshold > 10) errors.criticThreshold = "Use a score from 1–10.";
  if (!Number.isInteger(settings.mcpPortStart) || settings.mcpPortStart < 1 || settings.mcpPortStart > 65535) errors.mcpPortStart = "Use a port from 1–65,535.";
  if (!Number.isInteger(settings.mcpPortEnd) || settings.mcpPortEnd < 1 || settings.mcpPortEnd > 65535) errors.mcpPortEnd = "Use a port from 1–65,535.";
  if (!errors.mcpPortStart && !errors.mcpPortEnd && settings.mcpPortStart > settings.mcpPortEnd) errors.mcpPortStart = "Start must be less than or equal to end.";
  if (!Number.isInteger(settings.memoryTokenBudget) || settings.memoryTokenBudget < 0 || settings.memoryTokenBudget > 50000) errors.memoryTokenBudget = "Use 0–50,000 tokens.";
  return errors;
}

export function dirtySettingSections(saved: SettingsShape, draft: SettingsShape): SettingsSectionId[] {
  return (Object.keys(sectionKeys) as SettingsSectionId[]).filter((section) => sectionKeys[section].some((key) => JSON.stringify(saved[key]) !== JSON.stringify(draft[key])));
}

export function restoreSettingsSection(draft: SettingsShape, section: SettingsSectionId): SettingsShape {
  if (section === "workspace") return { ...draft, testCommand: "", lintCommand: "" };
  if (section === "execution") return { ...draft, maxIterations: 5, maxParallelExecutors: 3, criticThreshold: 7 };
  if (section === "safety") return { ...draft, approvalMode: true };
  if (section === "integrations") return { ...draft, mcpAutoDiscovery: true, mcpPortStart: 3000, mcpPortEnd: 9999 };
  if (section === "memory") return { ...draft, memoryTokenBudget: 2000 };
  if (section === "appearance") return { ...draft, layout: "chat" };
  return draft;
}

export function sectionHasChanges(saved: SettingsShape, draft: SettingsShape, section: SettingsSectionId): boolean {
  return sectionKeys[section].some((key) => JSON.stringify(saved[key]) !== JSON.stringify(draft[key]));
}

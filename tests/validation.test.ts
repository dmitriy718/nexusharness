import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { mcpServerSchema, runtimeSchema, settingsSchema, taskSchema } from "../server/validation.js";
import { contentSha256, deleteWorkspacePath, readWorkspaceFile, resolveInside, runShell } from "../server/localTools.js";
import { parseTextToolCalls } from "../server/runtimeAdapters.js";
import { parseCriticScore, parsePlannerSubtasks } from "../server/agentLoop.js";

function testSettings(workspaceRoot = process.cwd()) {
  return {
    workspaceRoot,
    layout: "ide" as const,
    maxIterations: 5,
    maxParallelExecutors: 3,
    criticThreshold: 7,
    approvalMode: false,
    shellPath: process.platform === "win32" ? "powershell.exe" : "/bin/sh",
    testCommand: "",
    lintCommand: "",
    mcpAutoDiscovery: true,
    mcpPortStart: 3000,
    mcpPortEnd: 9999,
    memoryTokenBudget: 2000,
    agentModels: {}
  };
}

describe("runtime validation", () => {
  it("requires endpoints for HTTP runtimes", () => {
    expect(() => runtimeSchema.parse({ name: "Ollama", kind: "ollama", timeoutMs: 60000 })).toThrow();
  });

  it("accepts a valid Ollama endpoint", () => {
    const parsed = runtimeSchema.parse({ name: "Ollama", kind: "ollama", endpoint: "http://127.0.0.1:11434", timeoutMs: 60000 });
    expect(parsed.endpoint).toBe("http://127.0.0.1:11434");
  });

  it("rejects non-HTTP runtime endpoints", () => {
    expect(() => runtimeSchema.parse({ name: "Bad", kind: "ollama", endpoint: "ftp://127.0.0.1/model", timeoutMs: 60000 })).toThrow(/HTTP or HTTPS/);
  });
});

describe("MCP validation", () => {
  it("requires URL endpoints for HTTP MCP servers", () => {
    expect(() => mcpServerSchema.parse({ name: "Bad", transport: "http", endpoint: "stdio" })).toThrow(/HTTP MCP/);
  });

  it("requires commands for stdio MCP servers", () => {
    expect(() => mcpServerSchema.parse({ name: "Bad", transport: "stdio", endpoint: "stdio" })).toThrow(/stdio MCP/);
  });
});

describe("settings validation", () => {
  it("bounds critic threshold", () => {
    expect(() => settingsSchema.parse({
      workspaceRoot: process.cwd(),
      layout: "ide",
      maxIterations: 5,
      maxParallelExecutors: 3,
      criticThreshold: 11,
      approvalMode: true,
      shellPath: "powershell.exe",
      testCommand: "",
      lintCommand: "",
      mcpAutoDiscovery: true,
      mcpPortStart: 3000,
      mcpPortEnd: 9999,
      memoryTokenBudget: 2000,
      agentModels: {}
    })).toThrow();
  });

  it("requires a valid MCP port range", () => {
    expect(() => settingsSchema.parse({
      workspaceRoot: process.cwd(),
      layout: "ide",
      maxIterations: 5,
      maxParallelExecutors: 3,
      criticThreshold: 7,
      approvalMode: true,
      shellPath: "powershell.exe",
      testCommand: "",
      lintCommand: "",
      mcpAutoDiscovery: true,
      mcpPortStart: 9999,
      mcpPortEnd: 3000,
      memoryTokenBudget: 2000,
      agentModels: {}
    })).toThrow(/MCP port start/);
  });
});

describe("workspace containment", () => {
  it("rejects path traversal outside the workspace", () => {
    expect(() => resolveInside("C:/workspace/project", "../secret.txt")).toThrow(/escapes workspace/);
  });

  it("rejects absolute paths outside the workspace contract", () => {
    expect(() => resolveInside("C:/workspace/project", "/Users")).toThrow(/relative to the configured workspace root/);
  });

  it("refuses to delete the workspace root", async () => {
    await expect(deleteWorkspacePath(testSettings(), ".")).rejects.toThrow(/workspace root/);
  });

  it("rejects reads that escape through a directory link", async () => {
    const base = await mkdtemp(path.join(tmpdir(), "nexusharness-containment-"));
    const workspace = path.join(base, "workspace");
    const outside = path.join(base, "outside");
    try {
      await Promise.all([mkdir(workspace), mkdir(outside)]);
      await writeFile(path.join(outside, "secret.txt"), "secret", "utf8");
      await symlink(outside, path.join(workspace, "escape"), process.platform === "win32" ? "junction" : "dir");
      await expect(readWorkspaceFile(testSettings(workspace), path.join("escape", "secret.txt"))).rejects.toThrow(/symbolic link/);
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });
});

describe("approval payload hashes", () => {
  it("hashes write content deterministically", () => {
    expect(contentSha256("nexus")).toBe(contentSha256("nexus"));
    expect(contentSha256("nexus")).not.toBe(contentSha256("Nexus"));
  });
});

describe("shell execution", () => {
  it("throws on nonzero exit codes", async () => {
    await expect(runShell(testSettings(), "exit 7")).rejects.toThrow(/exit code/);
  });
});

describe("text tool-call fallback", () => {
  it("parses tool calls from JSON content for text-only models", () => {
    expect(parseTextToolCalls(JSON.stringify({
      tool_calls: [
        { name: "file_read", arguments: { path: "package.json" } }
      ]
    }))).toEqual([
      { id: "text_call_0", name: "file_read", arguments: { path: "package.json" } }
    ]);
  });

  it("ignores ordinary JSON without tool calls", () => {
    expect(parseTextToolCalls(JSON.stringify(["plan item"]))).toEqual([]);
  });

  it("repairs common invalid Windows path escapes in tool-call JSON", () => {
    const calls = parseTextToolCalls('{"tool_calls":[{"name":"file_read","arguments":{"path":"C:\\Users\\dmitr\\Desktop"}}]}');
    expect(calls[0].arguments.path).toBe("C:\\Users\\dmitr\\Desktop");
  });
});

describe("planner parsing", () => {
  it("repairs common invalid Windows path escapes in planner JSON", () => {
    expect(parsePlannerSubtasks('["Create C:\\Users\\dmitr\\Desktop\\gilstrap"]')).toEqual([
      "Create C:\\Users\\dmitr\\Desktop\\gilstrap"
    ]);
  });

  it("normalizes structured planner subtasks instead of stringifying objects", () => {
    expect(parsePlannerSubtasks(JSON.stringify([
      { title: "Create the application", description: "Initialize the production project." },
      { task: "Implement the landing page" },
      { action: "Run the build" }
    ]))).toEqual([
      "Create the application: Initialize the production project.",
      "Implement the landing page",
      "Run the build"
    ]);
  });

  it("rejects structured planner subtasks without usable text", () => {
    expect(() => parsePlannerSubtasks('[{"id":1}]')).toThrow(/no usable task text/);
  });

  it("deduplicates and groups oversized plans into at most eight coherent work units", () => {
    const plan = parsePlannerSubtasks(JSON.stringify(Array.from({ length: 18 }, (_, index) => `Task ${index + 1}`)));
    expect(plan).toHaveLength(6);
    expect(plan[0]).toBe("Task 1; Task 2; Task 3");
  });
});

describe("critic parsing", () => {
  it("accepts only finite scores in the documented 1-10 range", () => {
    expect(parseCriticScore('{"score":8,"issues":[],"recommendation":"ship"}')).toBe(8);
    expect(parseCriticScore('{"score":42}')).toBe(0);
    expect(parseCriticScore('{"score":7.5}')).toBe(0);
    expect(parseCriticScore("score: 0")).toBe(0);
  });
});

describe("task validation", () => {
  it("trims tasks and rejects blank or oversized requests", () => {
    expect(taskSchema.parse({ task: "  Build it  " }).task).toBe("Build it");
    expect(() => taskSchema.parse({ task: "   " })).toThrow(/required/);
    expect(() => taskSchema.parse({ task: "x".repeat(20_001) })).toThrow(/20,000/);
  });
});

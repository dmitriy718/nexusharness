import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  invokeTool,
  localToolSchemas,
  resolveAgentExecutionConfig,
  type TransactionalToolCoordinator
} from "../server/agentLoop.js";

function toolNames(mode: "compatibility" | "transactional") {
  return localToolSchemas(mode).map((tool) => tool.function.name);
}

function successfulReceipt() {
  return {
    receipt: {
      status: "succeeded",
      observedEffects: [{ kind: "file.update", target: "src/app.ts", status: "updated" }],
      variances: []
    }
  };
}

function fakeCoordinator(): TransactionalToolCoordinator {
  return {
    list: vi.fn(async (relativePath?: string) => ({ root: relativePath, entries: [] })),
    read: vi.fn(async (relativePath: string, options?: { offset?: number; limit?: number }) => ({ path: relativePath, ...options, content: "hello" })),
    write: vi.fn(async () => successfulReceipt()),
    delete: vi.fn(async () => successfulReceipt())
  };
}

describe("agent execution mode", () => {
  it("defaults to explicit compatibility mode", () => {
    expect(resolveAgentExecutionConfig({})).toEqual({ mode: "compatibility" });
    expect(resolveAgentExecutionConfig({ NEXUSHARNESS_EXECUTION_MODE: " compatibility " })).toEqual({ mode: "compatibility" });
  });

  it("requires an absolute transaction data root", () => {
    expect(() => resolveAgentExecutionConfig({ NEXUSHARNESS_EXECUTION_MODE: "transactional" })).toThrow(/requires NEXUSHARNESS_EXECUTION_DIR/);
    expect(() => resolveAgentExecutionConfig({ NEXUSHARNESS_EXECUTION_MODE: "transactional", NEXUSHARNESS_EXECUTION_DIR: "relative" })).toThrow(/absolute path/);
    expect(() => resolveAgentExecutionConfig({ NEXUSHARNESS_EXECUTION_MODE: "other" })).toThrow(/compatibility or transactional/);

    const dataRoot = path.resolve(process.cwd(), "..", "nexus-transaction-tests");
    expect(resolveAgentExecutionConfig({ NEXUSHARNESS_EXECUTION_MODE: " TRANSACTIONAL ", NEXUSHARNESS_EXECUTION_DIR: dataRoot })).toEqual({
      mode: "transactional",
      dataRoot
    });
  });

  it("removes arbitrary shell and MCP selection from transactional tools", () => {
    expect(toolNames("compatibility")).toEqual(["file_list", "file_read", "file_write", "file_delete", "shell_exec"]);
    expect(toolNames("transactional")).toEqual(["file_list", "file_read", "file_write", "file_delete"]);
  });

  it("routes every transactional file operation through the coordinator", async () => {
    const coordinator = fakeCoordinator();
    const signal = new AbortController().signal;
    const context = { runId: "run-1", subtask: "edit app" };

    await expect(invokeTool("file_list", { path: "src" }, signal, context, coordinator)).resolves.toEqual({ root: "src", entries: [] });
    await expect(invokeTool("file_read", { path: "src/app.ts", offset: 4, limit: 20 }, signal, context, coordinator)).resolves.toMatchObject({ path: "src/app.ts", offset: 4, limit: 20 });
    await expect(invokeTool("file_write", { path: "src/app.ts", content: "next" }, signal, context, coordinator)).resolves.toMatchObject({ status: "succeeded" });
    await expect(invokeTool("file_delete", { path: "old.ts" }, signal, context, coordinator)).resolves.toMatchObject({ status: "succeeded" });

    expect(coordinator.write).toHaveBeenCalledWith("src/app.ts", "next", context);
    expect(coordinator.delete).toHaveBeenCalledWith("old.ts", context);
  });

  it("fails closed for non-transactional tools and failed proof", async () => {
    const coordinator = fakeCoordinator();
    const signal = new AbortController().signal;
    const context = { runId: "run-1", subtask: "edit app" };

    await expect(invokeTool("shell_exec", { command: "npm test" }, signal, context, coordinator)).rejects.toThrow(/unavailable in portable transactional mode/);
    await expect(invokeTool("mcp_remote_0", {}, signal, context, coordinator)).rejects.toThrow(/compensation semantics/);
    await expect(invokeTool("unknown", {}, signal, context, coordinator)).rejects.toThrow(/Unknown transactional tool/);

    coordinator.write = vi.fn(async () => ({
      receipt: {
        status: "failed",
        observedEffects: [],
        variances: [{ effectTarget: "src/app.ts" }]
      }
    }));
    await expect(invokeTool("file_write", { path: "src/app.ts", content: "next" }, signal, context, coordinator)).rejects.toThrow(/failed proof for: src\/app.ts/);
  });
});

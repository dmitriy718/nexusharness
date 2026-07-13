import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  invokeEnabledMcpTool,
  invokeTool,
  localToolSchemas,
  mcpToolSchemas,
  parsePredictedSandboxEffects,
  releaseRunSlot,
  reserveRunSlot,
  resolveEnabledMcpTool,
  resolveAgentExecutionConfig,
  type TransactionalToolCoordinator
} from "../server/agentLoop.js";

function toolNames(mode: "compatibility" | "transactional" | "windows-sandbox") {
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
  it("fails closed unless execution mode and host exposure are explicit", () => {
    expect(() => resolveAgentExecutionConfig({})).toThrow(/Execution is disabled/);
    expect(() => resolveAgentExecutionConfig({ NEXUSHARNESS_EXECUTION_MODE: " compatibility " })).toThrow(/ALLOW_HOST_EXECUTION/);
    expect(resolveAgentExecutionConfig({
      NEXUSHARNESS_EXECUTION_MODE: " compatibility ",
      NEXUSHARNESS_ALLOW_HOST_EXECUTION: "true"
    })).toEqual({ mode: "compatibility" });
  });

  it("requires an absolute transaction data root", () => {
    expect(() => resolveAgentExecutionConfig({ NEXUSHARNESS_EXECUTION_MODE: "transactional" })).toThrow(/requires NEXUSHARNESS_EXECUTION_DIR/);
    expect(() => resolveAgentExecutionConfig({ NEXUSHARNESS_EXECUTION_MODE: "transactional", NEXUSHARNESS_EXECUTION_DIR: "relative" })).toThrow(/absolute path/);
    expect(() => resolveAgentExecutionConfig({ NEXUSHARNESS_EXECUTION_MODE: "other" })).toThrow(/compatibility, transactional, or windows-sandbox/);

    const dataRoot = path.resolve(process.cwd(), "..", "nexus-transaction-tests");
    expect(resolveAgentExecutionConfig({ NEXUSHARNESS_EXECUTION_MODE: " TRANSACTIONAL ", NEXUSHARNESS_EXECUTION_DIR: dataRoot })).toEqual({
      mode: "transactional",
      dataRoot
    });
    expect(resolveAgentExecutionConfig({ NEXUSHARNESS_EXECUTION_MODE: "windows-sandbox", NEXUSHARNESS_EXECUTION_DIR: dataRoot })).toEqual({ mode: "windows-sandbox", dataRoot });
  });

  it("keeps arbitrary host shell out of transactional local tools", () => {
    expect(toolNames("compatibility")).toEqual(["file_list", "file_read", "file_write", "file_delete", "shell_exec"]);
    expect(toolNames("transactional")).toEqual(["file_list", "file_read", "file_write", "file_delete"]);
    expect(toolNames("windows-sandbox")).toEqual(["file_list", "file_read", "file_write", "file_delete", "sandbox_exec"]);
  });

  it("exposes explicitly enabled MCP tools in every execution mode", async () => {
    const servers = [{
      id: "remote.one",
      name: "Remote tools",
      endpoint: "http://127.0.0.1:3001/mcp",
      transport: "http" as const,
      enabled: true,
      status: "online" as const,
      tools: [
        { name: "lookup", description: "Look up a record.", enabled: true },
        { name: "disabled", enabled: false }
      ]
    }];
    const transactional = mcpToolSchemas(servers, "transactional");
    expect(transactional.map((tool) => tool.function.name)).toEqual(["mcp_remote_one_0"]);
    expect(transactional[0].function.description).toContain("effects external to the file transaction");
    expect(mcpToolSchemas(servers, "windows-sandbox")).toHaveLength(1);
    expect(mcpToolSchemas(servers, "compatibility")[0].function.description).not.toContain("effects external");

    expect(resolveEnabledMcpTool(servers, "mcp_remote_one_0")).toMatchObject({ toolName: "lookup", server: { id: "remote.one" } });
    expect(() => resolveEnabledMcpTool(servers, "mcp_remote_one_1")).toThrow(/not available or not enabled/);

    const caller = vi.fn(async (_server, toolName: string, args: Record<string, unknown>) => ({ content: [{ type: "text" as const, text: JSON.stringify({ toolName, args }) }] }));
    await expect(invokeEnabledMcpTool(servers, "mcp_remote_one_0", { id: 7 }, caller)).resolves.toEqual({ content: [{ type: "text", text: '{"toolName":"lookup","args":{"id":7}}' }] });
    expect(caller).toHaveBeenCalledWith(servers[0], "lookup", { id: 7 });
  });

  it("admits concurrent run identities while rejecting duplicate activation", () => {
    expect(reserveRunSlot("run-slot-a")).toBe(true);
    expect(reserveRunSlot("run-slot-b")).toBe(true);
    expect(reserveRunSlot("run-slot-a")).toBe(false);
    expect(reserveRunSlot("run-slot-b")).toBe(false);
    releaseRunSlot("run-slot-a");
    expect(reserveRunSlot("run-slot-a")).toBe(true);
    releaseRunSlot("run-slot-a");
    releaseRunSlot("run-slot-b");
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

  it("fails closed for arbitrary host shell, unknown tools, and failed proof", async () => {
    const coordinator = fakeCoordinator();
    const signal = new AbortController().signal;
    const context = { runId: "run-1", subtask: "edit app" };

    await expect(invokeTool("shell_exec", { command: "npm test" }, signal, context, coordinator)).rejects.toThrow(/unavailable in transactional modes/);
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

  it("validates predicted Sandbox effects and routes sandbox_exec only to a Windows coordinator", async () => {
    const coordinator = { ...fakeCoordinator(), shell: vi.fn(async () => ({ ...successfulReceipt(), result: { exitCode: 0, stdout: "ok", stderr: "" }, diagnostic: { stage: "complete" } })) };
    const signal = new AbortController().signal;
    const context = { runId: "run-1", subtask: "sandboxed command" };
    const expectedEffects = [{ kind: "file.create", target: "generated.txt", description: "Create output." }];
    await expect(invokeTool("sandbox_exec", { command: "Set-Content generated.txt ok", expectedEffects }, signal, context, coordinator)).resolves.toMatchObject({ status: "succeeded", result: { exitCode: 0 }, diagnostic: { stage: "complete" } });
    expect(coordinator.shell).toHaveBeenCalledWith("Set-Content generated.txt ok", expectedEffects, context, signal);
    await expect(invokeTool("sandbox_exec", { command: "x", expectedEffects: [] }, signal, context, fakeCoordinator())).rejects.toThrow(/explicitly selected Windows Sandbox/);
    expect(() => parsePredictedSandboxEffects([{ kind: "process.spawn", target: "x", description: "bad" }])).toThrow(/unsupported kind/);
    expect(() => parsePredictedSandboxEffects([{ kind: "file.create", target: "", description: "bad" }])).toThrow(/requires target and description/);
  });
});

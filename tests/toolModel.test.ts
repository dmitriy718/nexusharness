import { describe, expect, it } from "vitest";
import type { McpServer, McpTool } from "../src/api/types";
import { discoveryChunks, filterMcpServers, meaningfulArguments, parseStdioArguments, schemaSummary, toolCategory, toolRisk } from "../src/features/tools/toolModel";

const tools: McpTool[] = [
  { name: "read_file", description: "Read a workspace file", enabled: true, inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } },
  { name: "run_shell", description: "Execute a terminal command", enabled: false, inputSchema: { type: "object", properties: { command: { type: "string" }, cwd: { type: "string" } }, required: ["command"] } },
  { name: "fetch_url", description: "Make an HTTP request", enabled: true }
];
const server: McpServer = { id: "server-1", name: "Developer tools", endpoint: "http://127.0.0.1:3001", transport: "http", enabled: true, status: "online", tools };

describe("tool configuration model", () => {
  it("classifies risk and category with write/execute precedence", () => {
    expect(toolRisk(tools[0])).toBe("read");
    expect(toolRisk(tools[1])).toBe("execute");
    expect(toolRisk(tools[2])).toBe("network");
    expect(toolRisk({ name: "delete_file", description: "Remove a path" })).toBe("write");
    expect(toolCategory(tools[0])).toBe("Filesystem");
  });

  it("summarizes JSON input schemas", () => {
    expect(schemaSummary(tools[1].inputSchema)).toEqual({ properties: 2, required: 1, label: "2 inputs · 1 required" });
    expect(schemaSummary(undefined).label).toBe("No input schema");
  });

  it("filters tools by server text, capability text, and risk", () => {
    expect(filterMcpServers([server], "terminal")[0].tools.map((tool) => tool.name)).toEqual(["run_shell"]);
    expect(filterMcpServers([server], "", "network")[0].tools.map((tool) => tool.name)).toEqual(["fetch_url"]);
    expect(filterMcpServers([server], "missing")).toEqual([]);
  });

  it("splits configured scan ranges into bounded real-progress chunks", () => {
    expect(discoveryChunks(3000, 4200)).toEqual([{ start: 3000, end: 3499 }, { start: 3500, end: 3999 }, { start: 4000, end: 4200 }]);
  });

  it("validates advanced stdio arguments and removes empty guided rows", () => {
    expect(parseStdioArguments('["-y", "server", "path with spaces"]')).toEqual(["-y", "server", "path with spaces"]);
    expect(() => parseStdioArguments('["ok", 2]')).toThrow("JSON array of strings");
    expect(meaningfulArguments([" -y ", "", " server "])).toEqual(["-y", "server"]);
  });
});

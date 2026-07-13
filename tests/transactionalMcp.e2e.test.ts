import { describe, expect, it } from "vitest";
import { invokeEnabledMcpTool } from "../server/agentLoop.js";
import { listMcpTools } from "../server/mcpClient.js";
import type { McpServerConfig } from "../server/types.js";

const serverProgram = `
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
const server = new McpServer({ name: "transactional-mcp-test", version: "1.0.0" });
server.registerTool("echo", {
  description: "Echo a value through a real MCP transport.",
  inputSchema: { value: z.string() }
}, async ({ value }) => {
  setTimeout(() => process.exit(0), 50).unref();
  return { content: [{ type: "text", text: "mcp:" + value }] };
});
await server.connect(new StdioServerTransport());
`;

describe("transactional MCP integration", () => {
  it("discovers and calls an enabled tool over a real stdio MCP transport", async () => {
    const server: McpServerConfig = {
      id: "transactional-mcp",
      name: "Transactional MCP fixture",
      endpoint: "stdio",
      transport: "stdio",
      command: process.execPath,
      args: ["--input-type=module", "--eval", serverProgram],
      enabled: true,
      status: "online",
      tools: []
    };

    server.tools = await listMcpTools(server);
    expect(server.tools.map((tool) => tool.name)).toEqual(["echo"]);

    const result = await invokeEnabledMcpTool(server.tools.length ? [server] : [], "mcp_transactional-mcp_0", { value: "ready" });
    expect(result.content).toEqual([{ type: "text", text: "mcp:ready" }]);
  }, 15_000);
});

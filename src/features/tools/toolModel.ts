import type { McpServer, McpTool } from "../../api/types";

export type ToolRisk = "read" | "write" | "execute" | "network";

export function toolRisk(tool: Pick<McpTool, "name" | "description">): ToolRisk {
  const text = `${tool.name} ${tool.description ?? ""}`.toLowerCase();
  if (/delete|remove|write|create|update|edit|move|rename|patch|insert/.test(text)) return "write";
  if (/shell|exec|command|process|spawn|terminal|run[_ -]/.test(text)) return "execute";
  if (/http|fetch|request|browser|network|url|download|upload/.test(text)) return "network";
  return "read";
}

export function toolCategory(tool: Pick<McpTool, "name" | "description">): string {
  const text = `${tool.name} ${tool.description ?? ""}`.toLowerCase();
  if (/file|directory|path|workspace/.test(text)) return "Filesystem";
  if (/git|commit|branch|repository/.test(text)) return "Source control";
  if (/browser|http|fetch|url|network/.test(text)) return "Network";
  if (/shell|exec|command|process|terminal/.test(text)) return "Execution";
  if (/database|sql|query/.test(text)) return "Data";
  return "General";
}

export function schemaSummary(schema: unknown): { properties: number; required: number; label: string } {
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) return { properties: 0, required: 0, label: "No input schema" };
  const value = schema as { properties?: unknown; required?: unknown };
  const properties = value.properties && typeof value.properties === "object" && !Array.isArray(value.properties) ? Object.keys(value.properties).length : 0;
  const required = Array.isArray(value.required) ? value.required.length : 0;
  return { properties, required, label: properties ? `${properties} input${properties === 1 ? "" : "s"} · ${required} required` : "No declared inputs" };
}

export function filterMcpServers(servers: McpServer[], query: string, risk = "all"): McpServer[] {
  const normalized = query.trim().toLowerCase();
  return servers.map((server) => ({
    ...server,
    tools: server.tools.filter((tool) => {
      const haystack = [server.name, server.endpoint, tool.name, tool.description, toolCategory(tool), toolRisk(tool)].join(" ").toLowerCase();
      return (!normalized || haystack.includes(normalized)) && (risk === "all" || toolRisk(tool) === risk);
    })
  })).filter((server) => !normalized && risk === "all" || server.tools.length > 0 || [server.name, server.endpoint].join(" ").toLowerCase().includes(normalized));
}

export function discoveryChunks(start: number, end: number, size = 500): Array<{ start: number; end: number }> {
  const chunks: Array<{ start: number; end: number }> = [];
  for (let current = start; current <= end; current += size) chunks.push({ start: current, end: Math.min(end, current + size - 1) });
  return chunks;
}

export function parseStdioArguments(raw: string): string[] {
  const trimmed = raw.trim();
  if (!trimmed) return [];
  const parsed = JSON.parse(trimmed);
  if (!Array.isArray(parsed) || parsed.some((item) => typeof item !== "string")) throw new Error("Raw arguments must be a JSON array of strings.");
  return parsed;
}

export function meaningfulArguments(args: string[]): string[] {
  return args.map((value) => value.trim()).filter(Boolean);
}

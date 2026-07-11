import net from "node:net";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { McpServerConfig } from "./types.js";

type PooledClient = { client: Client; transport: Transport; idleTimer?: NodeJS.Timeout };
const clientPool = new Map<string, Promise<PooledClient>>();
const MCP_IDLE_MS = 60_000;

async function withTimeout<T>(label: string, timeoutMs: number, operation: Promise<T>): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms.`)), timeoutMs);
  });
  try {
    return await Promise.race([operation, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function createTransport(server: McpServerConfig): Transport {
  if (server.transport === "stdio") {
    if (!server.command) throw new Error("stdio MCP server requires a command.");
    return new StdioClientTransport({
      command: server.command,
      args: server.args ?? [],
      stderr: "pipe"
    });
  }
  return new StreamableHTTPClientTransport(new URL(server.endpoint));
}

function poolKey(server: McpServerConfig): string {
  return JSON.stringify([server.transport, server.endpoint, server.command, server.args ?? []]);
}

function scheduleIdleClose(key: string, pooled: PooledClient) {
  if (pooled.idleTimer) clearTimeout(pooled.idleTimer);
  pooled.idleTimer = setTimeout(() => {
    if (clientPool.delete(key)) void pooled.transport.close().catch(() => undefined);
  }, MCP_IDLE_MS);
  pooled.idleTimer.unref();
}

async function createPooledClient(server: McpServerConfig): Promise<PooledClient> {
  const client = new Client({ name: "NexusHarness", version: "0.1.0" }, { capabilities: {} });
  const transport = createTransport(server);
  try {
    await withTimeout("MCP connect", 15000, client.connect(transport));
    return { client, transport };
  } catch (error) {
    await transport.close().catch(() => undefined);
    throw error;
  }
}

async function withMcpClient<T>(server: McpServerConfig, operation: (client: Client) => Promise<T>): Promise<T> {
  const key = poolKey(server);
  let pending = clientPool.get(key);
  if (!pending) {
    pending = createPooledClient(server);
    clientPool.set(key, pending);
  }
  let pooled: PooledClient;
  try {
    pooled = await pending;
  } catch (error) {
    clientPool.delete(key);
    throw error;
  }
  if (pooled.idleTimer) {
    clearTimeout(pooled.idleTimer);
    pooled.idleTimer = undefined;
  }
  try {
    const result = await withTimeout("MCP operation", 30000, operation(pooled.client));
    scheduleIdleClose(key, pooled);
    return result;
  } catch (error) {
    clientPool.delete(key);
    if (pooled.idleTimer) clearTimeout(pooled.idleTimer);
    await pooled.transport.close().catch(() => undefined);
    throw error;
  }
}

export async function listMcpTools(server: McpServerConfig) {
  const result = await withMcpClient(server, (client) => client.listTools());
  return (result.tools ?? []).map((tool) => ({
    name: tool.name,
    description: tool.description,
    inputSchema: tool.inputSchema,
    enabled: true
  }));
}

export async function callMcpTool(server: McpServerConfig, name: string, args: Record<string, unknown>) {
  return withMcpClient(server, (client) => client.callTool({ name, arguments: args }));
}

function canConnect(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host: "127.0.0.1", port, timeout: 250 });
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("timeout", () => {
      socket.destroy();
      resolve(false);
    });
    socket.once("error", () => resolve(false));
  });
}

export async function discoverMcpServers(start: number, end: number): Promise<McpServerConfig[]> {
  const ports = Array.from({ length: Math.max(0, end - start + 1) }, (_, index) => start + index);
  const openPorts: number[] = [];
  for (let index = 0; index < ports.length; index += 100) {
    const batch = ports.slice(index, index + 100);
    const checks = await Promise.all(batch.map(async (port) => ({ port, open: await canConnect(port) })));
    openPorts.push(...checks.filter((check) => check.open).map((check) => check.port));
  }
  const servers: McpServerConfig[] = [];
  for (const port of openPorts) {
    const endpoint = `http://127.0.0.1:${port}`;
    try {
      const tools = await listMcpTools({ id: "", name: `localhost:${port}`, endpoint, transport: "http", enabled: true, status: "unknown", tools: [] });
      servers.push({ id: crypto.randomUUID(), name: `localhost:${port}`, endpoint, transport: "http", enabled: false, status: "online", tools });
    } catch {
      continue;
    }
  }
  return servers;
}

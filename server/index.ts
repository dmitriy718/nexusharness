import express from "express";
import cors from "cors";
import { nanoid } from "nanoid";
import path from "node:path";
import { stat } from "node:fs/promises";
import { loadStore, saveStore, audit } from "./store.js";
import { memorySchema, mcpServerSchema, runtimeSchema, settingsSchema, taskSchema } from "./validation.js";
import { listRuntimeModels, validateRuntimeConnection } from "./runtimeAdapters.js";
import { discoverMcpServers, listMcpTools } from "./mcpClient.js";
import { cancelRun, executeRun, isRunActive, startTask } from "./agentLoop.js";
import { workspaceTree } from "./localTools.js";
import type { McpServerConfig } from "./types.js";

const app = express();
app.use(cors({ origin: ["http://127.0.0.1:5173", "http://localhost:5173"] }));
app.use((_req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("Content-Security-Policy", "default-src 'self'; connect-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; base-uri 'none'; frame-ancestors 'none'");
  next();
});
app.use(express.json({ limit: "10mb" }));

function asyncRoute(handler: express.RequestHandler): express.RequestHandler {
  return (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
}

app.get("/api/health", (_req, res) => {
  res.json({ status: "ok", version: "0.1.0", uptimeSeconds: Math.floor(process.uptime()) });
});

app.get("/api/state", asyncRoute(async (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  const store = await loadStore();
  if (req.query.compact !== "1") return res.json(store);
  res.json({
    ...store,
    audit: store.audit.slice(0, 200),
    runs: store.runs.slice(0, 100),
    approvals: store.approvals.filter((item) => item.decision === "pending").concat(store.approvals.filter((item) => item.decision !== "pending").slice(0, 100))
  });
}));

app.put("/api/settings", asyncRoute(async (req, res) => {
  const parsed = settingsSchema.parse(req.body);
  let workspaceStat;
  try { workspaceStat = await stat(parsed.workspaceRoot); }
  catch { return res.status(400).json({ error: "workspaceRoot must be an existing directory." }); }
  if (!workspaceStat.isDirectory()) return res.status(400).json({ error: "workspaceRoot must be an existing directory." });
  const store = await loadStore();
  const runtimeIds = new Set(store.runtimes.map((runtime) => runtime.id));
  for (const [role, modelId] of Object.entries(parsed.agentModels)) {
    if (modelId && !runtimeIds.has(modelId.split(":", 1)[0])) {
      return res.status(400).json({ error: `Agent assignment for ${role} references an unknown runtime.` });
    }
  }
  store.settings = parsed;
  await saveStore(store);
  await audit({ actor: "operator", action: "settings.update", risk: "write", status: "ok", message: "Settings updated." });
  res.json(store.settings);
}));

app.post("/api/runtimes", asyncRoute(async (req, res) => {
  const parsed = runtimeSchema.parse(req.body);
  const store = await loadStore();
  const runtime = { id: nanoid(), ...parsed };
  const models = await validateRuntimeConnection(runtime);
  store.runtimes.push(runtime);
  await saveStore(store);
  await audit({ actor: "operator", action: "runtime.add", risk: "network", status: "ok", message: runtime.name, details: { kind: runtime.kind, endpoint: runtime.endpoint, modelCount: models.length } });
  res.status(201).json({ runtime, models });
}));

app.delete("/api/runtimes/:id", asyncRoute(async (req, res) => {
  const id = String(req.params.id);
  const store = await loadStore();
  if (!store.runtimes.some((runtime) => runtime.id === id)) return res.status(404).json({ error: "Runtime not found." });
  store.runtimes = store.runtimes.filter((runtime) => runtime.id !== id);
  for (const role of ["planner", "executor", "critic"] as const) {
    if (store.settings.agentModels[role]?.startsWith(`${id}:`)) {
      store.settings.agentModels[role] = undefined;
    }
  }
  await saveStore(store);
  await audit({ actor: "operator", action: "runtime.remove", risk: "write", status: "ok", message: id });
  res.status(204).end();
}));

app.get("/api/runtimes/:id/models", asyncRoute(async (req, res) => {
  const id = String(req.params.id);
  const store = await loadStore();
  const runtime = store.runtimes.find((item) => item.id === id);
  if (!runtime) return res.status(404).json({ error: "Runtime not found." });
  res.json(await listRuntimeModels(runtime, { fresh: req.query.fresh === "1" }));
}));

app.post("/api/mcp", asyncRoute(async (req, res) => {
  const parsed = mcpServerSchema.parse(req.body);
  const store = await loadStore();
  const server: McpServerConfig = { id: nanoid(), status: "unknown", tools: [], ...parsed };
  try {
    server.tools = await listMcpTools(server);
    server.status = "online";
  } catch (error: any) {
    server.status = "error";
    server.lastError = error.message ?? String(error);
  }
  store.mcpServers.push(server);
  await saveStore(store);
  await audit({ actor: "operator", action: "mcp.add", risk: "network", status: server.status === "online" ? "ok" : "error", message: server.name, details: server.lastError });
  res.status(201).json(server);
}));

app.post("/api/mcp/discover", asyncRoute(async (_req, res) => {
  const store = await loadStore();
  if (!store.settings.mcpAutoDiscovery) {
    return res.status(409).json({ error: "MCP auto-discovery is disabled in settings." });
  }
  const found = await discoverMcpServers(store.settings.mcpPortStart, store.settings.mcpPortEnd);
  const existing = new Set(store.mcpServers.map((server) => server.endpoint));
  const fresh = found.filter((server) => !existing.has(server.endpoint));
  store.mcpServers.push(...fresh);
  await saveStore(store);
  await audit({ actor: "operator", action: "mcp.discover", risk: "network", status: "ok", message: `Discovered ${fresh.length} MCP servers.` });
  res.json(fresh);
}));

app.put("/api/mcp/:id", asyncRoute(async (req, res) => {
  const id = String(req.params.id);
  const store = await loadStore();
  const server = store.mcpServers.find((item) => item.id === id);
  if (!server) return res.status(404).json({ error: "MCP server not found." });
  if (typeof req.body.enabled === "boolean") server.enabled = req.body.enabled;
  if (Array.isArray(req.body.tools)) {
    const updates = new Map(req.body.tools.map((tool: any) => [tool?.name, tool]));
    server.tools = server.tools.map((tool) => {
      const update = updates.get(tool.name) as any;
      return typeof update?.enabled === "boolean" ? { ...tool, enabled: update.enabled } : tool;
    });
  }
  await saveStore(store);
  await audit({ actor: "operator", action: "mcp.update", risk: "write", status: "ok", message: server.name });
  res.json(server);
}));

app.post("/api/mcp/:id/refresh", asyncRoute(async (req, res) => {
  const id = String(req.params.id);
  const store = await loadStore();
  const server = store.mcpServers.find((item) => item.id === id);
  if (!server) return res.status(404).json({ error: "MCP server not found." });
  try {
    const enabledByName = new Map(server.tools.map((tool) => [tool.name, tool.enabled]));
    server.tools = (await listMcpTools(server)).map((tool) => ({ ...tool, enabled: enabledByName.get(tool.name) ?? tool.enabled }));
    server.status = "online";
    server.lastError = undefined;
  } catch (error: any) {
    server.status = "error";
    server.lastError = error.message ?? String(error);
  }
  await saveStore(store);
  await audit({ actor: "operator", action: "mcp.refresh", risk: "network", status: server.status === "online" ? "ok" : "error", message: server.name, details: server.lastError });
  res.json(server);
}));

app.delete("/api/mcp/:id", asyncRoute(async (req, res) => {
  const id = String(req.params.id);
  const store = await loadStore();
  if (!store.mcpServers.some((server) => server.id === id)) return res.status(404).json({ error: "MCP server not found." });
  store.mcpServers = store.mcpServers.filter((server) => server.id !== id);
  await saveStore(store);
  await audit({ actor: "operator", action: "mcp.delete", risk: "write", status: "ok", message: id });
  res.status(204).end();
}));

app.post("/api/memory", asyncRoute(async (req, res) => {
  const parsed = memorySchema.parse(req.body);
  const store = await loadStore();
  const now = new Date().toISOString();
  const entry = { id: nanoid(), createdAt: now, updatedAt: now, ...parsed };
  store.memory.unshift(entry);
  await saveStore(store);
  await audit({ actor: "operator", action: "memory.add", risk: "write", status: "ok", message: entry.title, details: { source: entry.source } });
  res.status(201).json(entry);
}));

app.put("/api/memory/:id", asyncRoute(async (req, res) => {
  const id = String(req.params.id);
  const parsed = memorySchema.parse(req.body);
  const store = await loadStore();
  const entry = store.memory.find((item) => item.id === id);
  if (!entry) return res.status(404).json({ error: "Memory entry not found." });
  Object.assign(entry, parsed, { updatedAt: new Date().toISOString() });
  await saveStore(store);
  await audit({ actor: "operator", action: "memory.update", risk: "write", status: "ok", message: entry.title, details: { source: entry.source } });
  res.json(entry);
}));

app.delete("/api/memory/:id", asyncRoute(async (req, res) => {
  const id = String(req.params.id);
  const store = await loadStore();
  if (!store.memory.some((entry) => entry.id === id)) return res.status(404).json({ error: "Memory entry not found." });
  store.memory = store.memory.filter((entry) => entry.id !== id);
  await saveStore(store);
  await audit({ actor: "operator", action: "memory.delete", risk: "write", status: "ok", message: id });
  res.status(204).end();
}));

app.post("/api/tasks", asyncRoute(async (req, res) => {
  const parsed = taskSchema.parse(req.body);
  res.status(201).json(await startTask(parsed.task));
}));

app.post("/api/tasks/:id/resume", asyncRoute(async (req, res) => {
  const id = String(req.params.id);
  const store = await loadStore();
  const run = store.runs.find((item) => item.id === id);
  if (!run) return res.status(404).json({ error: "Run not found." });
  if (isRunActive(id)) return res.status(409).json({ error: "Run is already active." });
  if (run.status !== "waiting_approval" && run.status !== "failed" && run.status !== "canceled") {
    return res.status(409).json({ error: `Run cannot be resumed from status ${run.status}.` });
  }
  run.status = "running";
  run.error = undefined;
  run.updatedAt = new Date().toISOString();
  await saveStore(store);
  void executeRun(run.id);
  res.json(run);
}));

app.post("/api/tasks/:id/cancel", asyncRoute(async (req, res) => {
  const id = String(req.params.id);
  const run = await cancelRun(id);
  if (!run) return res.status(404).json({ error: "Run not found." });
  if (run.status !== "canceled") return res.status(409).json({ error: `Run cannot be canceled from status ${run.status}.` });
  res.json(run);
}));

app.get("/api/workspace/tree", asyncRoute(async (_req, res) => {
  const store = await loadStore();
  res.json(await workspaceTree(store.settings));
}));

app.post("/api/approvals/:id/:decision", asyncRoute(async (req, res) => {
  const id = String(req.params.id);
  const decision = String(req.params.decision);
  if (!["approved", "rejected"].includes(decision)) return res.status(400).json({ error: "decision must be approved or rejected." });
  const store = await loadStore();
  const approval = store.approvals.find((item) => item.id === id);
  if (!approval) return res.status(404).json({ error: "Approval not found." });
  if (approval.decision !== "pending") return res.status(409).json({ error: "Approval has already been decided." });
  approval.decision = decision as "approved" | "rejected";
  approval.decidedAt = new Date().toISOString();
  if (approval.decision === "rejected") {
    for (const run of store.runs.filter((item) => item.status === "waiting_approval" && item.error?.includes(approval.id))) {
      run.status = "failed";
      run.error = `Operator rejected ${approval.action}. approvalId=${approval.id}`;
      run.updatedAt = new Date().toISOString();
    }
  }
  await saveStore(store);
  await audit({ actor: "operator", action: `approval.${approval.decision}`, risk: approval.risk, status: approval.decision, message: approval.action, details: approval.payload });
  res.json(approval);
}));

app.use(express.static(path.join(process.cwd(), "dist")));
app.use("/api", (_req, res) => res.status(404).json({ error: "API endpoint not found." }));
app.get("*", (_req, res) => {
  res.sendFile(path.join(process.cwd(), "dist", "index.html"));
});

app.use((error: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  void _next;
  const message = error?.issues ? error.issues : error?.message ?? String(error);
  const status = error?.issues || error instanceof SyntaxError ? 400 : Number(error?.status ?? 500);
  res.status(status >= 400 && status <= 599 ? status : 500).json({ error: message });
});

const port = Number(process.env.NEXUSHARNESS_PORT ?? 8787);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("NEXUSHARNESS_PORT must be an integer from 1 to 65535.");
app.listen(port, "127.0.0.1", () => {
  console.log(`NexusHarness API listening on http://127.0.0.1:${port}`);
});

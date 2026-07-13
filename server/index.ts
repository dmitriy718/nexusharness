import express from "express";
import cors from "cors";
import { nanoid } from "nanoid";
import { z } from "zod";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { access, mkdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { loadStore, saveStore, audit } from "./store.js";
import { memorySchema, mcpServerSchema, runtimeSchema, settingsSchema, taskSchema } from "./validation.js";
import { listRuntimeModels, validateRuntimeConnection } from "./runtimeAdapters.js";
import { discoverMcpServers, listMcpTools } from "./mcpClient.js";
import { abandonRunTransaction, cancelRun, executeRun, isRunActive, releaseRunSlot, reserveRunSlot, startTask } from "./agentLoop.js";
import { previewWorkspaceFile, searchWorkspace, workspaceEntries, workspaceTree } from "./localTools.js";
import type { McpServerConfig, MemoryEntry } from "./types.js";
import { buildInfo } from "./version.js";
import { parseRunHistoryQuery, runHistoryPage, runListItem } from "./runHistory.js";
import { initializeMemorySubsystem, scheduleMemoryBackfill } from "./memory/subsystem.js";
import { countPromptTokens, memoryContentHash, sameIndexedText, workspaceNamespace } from "./memory/preprocessing.js";
import { resolveMemoryConfiguration } from "./memory/config.js";
import { validateProviderConfiguration } from "./memory/providers.js";
import { installationPaths, type ServiceState, userPaths } from "./paths.js";
import { liveRunEventSnapshot, subscribeToLiveRunEvents, type LiveRunEvent } from "./liveRunEvents.js";
import { assertWorkspaceSeparatedFromInstallation } from "./execution/hostSafety.js";
import { prepareRunExportWorkspace } from "./execution/runWorkspace.js";

const port = Number(process.env.NEXUSHARNESS_PORT ?? 8787);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("NEXUSHARNESS_PORT must be an integer from 1 to 65535.");
const serviceToken = process.env.NEXUSHARNESS_SERVICE_TOKEN?.trim() || randomBytes(32).toString("hex");

const memorySubsystem = await initializeMemorySubsystem();
const startupMemoryConfiguration = resolveMemoryConfiguration((await loadStore()).settings);
if (startupMemoryConfiguration.retrieval.mode !== "lexical_only") validateProviderConfiguration(startupMemoryConfiguration.embeddings);

const backfillRequestSchema = z.object({
  jobId: z.string().regex(/^[A-Za-z0-9._-]{1,100}$/).optional(),
  dryRun: z.boolean().optional().default(false),
  batchSize: z.number().int().min(1).max(100).optional(),
  rateLimitPerSecond: z.number().positive().max(1000).optional(),
  namespace: z.string().regex(/^workspace:[a-f0-9]{32}$/).optional(),
  kind: z.enum(["retrospective", "snippet", "context"]).optional(),
  updatedAfter: z.string().datetime().optional(),
  staleOnly: z.boolean().optional().default(true),
  force: z.boolean().optional().default(false)
});

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

function requestAbortSignal(request: express.Request): AbortSignal {
  const controller = new AbortController();
  request.once("aborted", () => controller.abort());
  return controller.signal;
}

app.get("/api/health", asyncRoute(async (_req, res) => {
  const store = await loadStore();
  const memory = memorySubsystem.diagnostics(store);
  res.json({ status: "ok", ...buildInfo, pid: process.pid, port, uptimeSeconds: Math.floor(process.uptime()), memory: { retrievalMode: memory.retrievalMode, vectorStoreHealthy: memory.vectorStore.ok, activeGeneration: memory.activeGeneration } });
}));

app.get("/api/state", asyncRoute(async (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  const store = await loadStore();
  const namespace = workspaceNamespace(store.settings.workspaceRoot);
  const scopedMemory = store.memory.filter((entry) => entry.namespace === namespace);
  if (req.query.compact !== "1") return res.json({ ...store, memory: scopedMemory });
  res.json({
    ...store,
    memory: scopedMemory,
    audit: store.audit.slice(0, 200),
    runs: store.runs.slice(0, 100).map(runListItem),
    approvals: store.approvals.filter((item) => item.decision === "pending").concat(store.approvals.filter((item) => item.decision !== "pending").slice(0, 100))
  });
}));

app.get("/api/audit", asyncRoute(async (_req, res) => {
  res.setHeader("Cache-Control", "no-store");
  const store = await loadStore();
  res.json(store.audit);
}));

app.get("/api/runs", asyncRoute(async (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  const store = await loadStore();
  res.json(runHistoryPage(store.runs, parseRunHistoryQuery(req.query)));
}));

app.get("/api/runs/:id/events", asyncRoute(async (req, res) => {
  const runId = String(req.params.id);
  const store = await loadStore();
  const run = store.runs.find((item) => item.id === runId);
  if (!run) return res.status(404).json({ error: "Run not found." });

  res.status(200);
  res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  res.setHeader("Cache-Control", "no-store, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders();
  res.write("retry: 2000\n\n");

  const seenAuditIds = new Set<string>();
  const relatedAudit = [...(run.log ?? []), ...store.audit.filter((event) => {
    const details = event.details && typeof event.details === "object" ? event.details as Record<string, unknown> : {};
    return details.runId === runId || details.taskId === runId || event.message.includes(runId);
  })].filter((event) => {
    if (seenAuditIds.has(event.id)) return false;
    seenAuditIds.add(event.id);
    return true;
  }).sort((left, right) => Date.parse(left.at) - Date.parse(right.at));

  for (const event of relatedAudit) {
    const details = event.details === undefined ? undefined : JSON.stringify(event.details, null, 2).slice(0, 20_000);
    writeLiveEvent(res, {
      id: `audit-${event.id}`,
      sequence: 0,
      runId,
      at: event.at,
      kind: "audit",
      title: `${event.actor} · ${event.action}`,
      content: details || event.message,
      role: event.actor === "planner" || event.actor === "executor" || event.actor === "critic" ? event.actor : undefined,
      status: event.status === "error" || event.status === "rejected" ? "error" : event.status === "pending" ? "waiting" : "ok"
    });
  }
  for (const event of liveRunEventSnapshot(runId)) writeLiveEvent(res, event);

  const unsubscribe = subscribeToLiveRunEvents(runId, (event) => writeLiveEvent(res, event));
  const heartbeat = setInterval(() => res.write(`: heartbeat ${Date.now()}\n\n`), 15_000);
  heartbeat.unref();
  req.once("close", () => {
    clearInterval(heartbeat);
    unsubscribe();
  });
}));

app.get("/api/runs/:id", asyncRoute(async (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  const store = await loadStore();
  const run = store.runs.find((item) => item.id === String(req.params.id));
  if (!run) return res.status(404).json({ error: "Run not found." });
  const audit = store.audit.filter((event) => {
    const details = event.details && typeof event.details === "object" ? event.details as Record<string, unknown> : {};
    return details.runId === run.id || details.taskId === run.id || event.message.includes(run.id);
  });
  const approvals = store.approvals.filter((approval) => approval.runId === run.id);
  res.json({ run, audit, approvals });
}));

function writeLiveEvent(response: express.Response, event: LiveRunEvent): void {
  if (response.writableEnded || response.destroyed) return;
  response.write(`id: ${event.id.replace(/[\r\n]/g, "")}\ndata: ${JSON.stringify(event)}\n\n`);
}

app.put("/api/settings", asyncRoute(async (req, res) => {
  const parsed = settingsSchema.parse(req.body);
  const memoryConfiguration = resolveMemoryConfiguration(parsed);
  if (memoryConfiguration.retrieval.mode !== "lexical_only") validateProviderConfiguration(memoryConfiguration.embeddings);
  let workspaceStat;
  try { workspaceStat = await stat(parsed.workspaceRoot); }
  catch { return res.status(400).json({ error: "workspaceRoot must be an existing directory." }); }
  if (!workspaceStat.isDirectory()) return res.status(400).json({ error: "workspaceRoot must be an existing directory." });
  try { await assertWorkspaceSeparatedFromInstallation(parsed.workspaceRoot); }
  catch (error: any) { return res.status(400).json({ error: error.message ?? String(error) }); }
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
  if (memoryConfiguration.retrieval.mode !== "lexical_only" && memoryConfiguration.embeddings.allowAsyncBackfill) {
    setTimeout(() => void memorySubsystem.backfill(store).catch(() => undefined), 0);
  }
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

app.post("/api/runtimes/test", asyncRoute(async (req, res) => {
  const parsed = runtimeSchema.parse(req.body);
  const startedAt = performance.now();
  const models = await validateRuntimeConnection({ id: "connection-test", ...parsed });
  const result = { checkedAt: new Date().toISOString(), latencyMs: Math.max(1, Math.round(performance.now() - startedAt)), models };
  await audit({ actor: "operator", action: "runtime.test", risk: "network", status: "ok", message: parsed.name, details: { kind: parsed.kind, endpoint: parsed.endpoint, modelCount: models.length, latencyMs: result.latencyMs } });
  res.json(result);
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

app.post("/api/mcp/discover", asyncRoute(async (req, res) => {
  const store = await loadStore();
  if (!store.settings.mcpAutoDiscovery) {
    return res.status(409).json({ error: "MCP auto-discovery is disabled in settings." });
  }
  const start = req.body?.start ?? store.settings.mcpPortStart;
  const end = req.body?.end ?? Math.min(store.settings.mcpPortEnd, Number(start) + 499);
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < store.settings.mcpPortStart || end > store.settings.mcpPortEnd || start > end || end - start + 1 > 500) {
    return res.status(400).json({ error: `Discovery range must be an integer subset of ${store.settings.mcpPortStart}-${store.settings.mcpPortEnd} containing at most 500 ports.` });
  }
  const controller = new AbortController();
  req.once("aborted", () => controller.abort());
  const found = await discoverMcpServers(start, end, controller.signal);
  const existing = new Set(store.mcpServers.map((server) => server.endpoint));
  const fresh = found.filter((server) => !existing.has(server.endpoint));
  store.mcpServers.push(...fresh);
  await saveStore(store);
  await audit({ actor: "operator", action: "mcp.discover", risk: "network", status: "ok", message: `Scanned ports ${start}-${end}; discovered ${fresh.length} new MCP servers.` });
  res.json({ servers: fresh, range: { start, end }, scanned: end - start + 1 });
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
  const configuration = resolveMemoryConfiguration(store.settings);
  const entry: MemoryEntry = {
    id: nanoid(), createdAt: now, updatedAt: now, ...parsed,
    namespace: workspaceNamespace(store.settings.workspaceRoot),
    contentHash: "",
    tokenCount: countPromptTokens(parsed.content),
    indexing: { status: "pending", updatedAt: now }
  };
  entry.contentHash = memoryContentHash(entry, configuration.embeddings.preprocessingVersion);
  store.memory.unshift(entry);
  await saveStore(store);
  await audit({ actor: "operator", action: "memory.add", risk: "write", status: "ok", message: entry.title, details: { source: entry.source } });
  await memorySubsystem.indexPersistedMemory(entry, store, requestAbortSignal(req));
  res.status(201).json(entry);
}));

app.put("/api/memory/:id", asyncRoute(async (req, res) => {
  const id = String(req.params.id);
  const parsed = memorySchema.parse(req.body);
  const store = await loadStore();
  const entry = store.memory.find((item) => item.id === id);
  if (!entry || entry.namespace !== workspaceNamespace(store.settings.workspaceRoot)) return res.status(404).json({ error: "Memory entry not found." });
  const configuration = resolveMemoryConfiguration(store.settings);
  const next = { ...entry, ...parsed, updatedAt: new Date().toISOString() };
  const indexedTextChanged = !sameIndexedText(entry, next, configuration.embeddings.preprocessingVersion);
  memorySubsystem.prepareMemoryUpdate(entry, store.settings, indexedTextChanged);
  Object.assign(entry, parsed, { updatedAt: new Date().toISOString() });
  entry.tokenCount = countPromptTokens(entry.content);
  entry.contentHash = memoryContentHash(entry, configuration.embeddings.preprocessingVersion);
  if (indexedTextChanged) entry.indexing = { status: "stale", updatedAt: entry.updatedAt };
  await saveStore(store);
  await audit({ actor: "operator", action: "memory.update", risk: "write", status: "ok", message: entry.title, details: { source: entry.source } });
  if (indexedTextChanged) await memorySubsystem.indexPersistedMemory(entry, store, requestAbortSignal(req));
  else memorySubsystem.updateMemoryMetadata(entry);
  res.json(entry);
}));

app.delete("/api/memory/:id", asyncRoute(async (req, res) => {
  const id = String(req.params.id);
  const store = await loadStore();
  const entry = store.memory.find((candidate) => candidate.id === id);
  if (!entry || entry.namespace !== workspaceNamespace(store.settings.workspaceRoot)) return res.status(404).json({ error: "Memory entry not found." });
  memorySubsystem.prepareMemoryDelete(entry, store.settings);
  store.memory = store.memory.filter((entry) => entry.id !== id);
  await saveStore(store);
  await audit({ actor: "operator", action: "memory.delete", risk: "write", status: "ok", message: id });
  res.status(204).end();
}));

app.get("/api/memory/diagnostics", asyncRoute(async (_req, res) => {
  res.setHeader("Cache-Control", "no-store");
  res.json(memorySubsystem.diagnostics(await loadStore()));
}));

app.post("/api/memory/backfill", asyncRoute(async (req, res) => {
  const options = backfillRequestSchema.parse(req.body ?? {});
  const store = await loadStore();
  const activeNamespace = workspaceNamespace(store.settings.workspaceRoot);
  if (options.namespace && options.namespace !== activeNamespace) return res.status(403).json({ error: "API backfill is limited to the active workspace namespace." });
  res.json(await memorySubsystem.backfill(store, options));
}));

app.post("/api/memory/reembed", asyncRoute(async (req, res) => {
  const options = backfillRequestSchema.parse({ ...(req.body ?? {}), force: true });
  const store = await loadStore();
  const activeNamespace = workspaceNamespace(store.settings.workspaceRoot);
  if (options.namespace && options.namespace !== activeNamespace) return res.status(403).json({ error: "API re-embedding is limited to the active workspace namespace." });
  res.json(await memorySubsystem.backfill(store, { ...options, activateOnComplete: false }));
}));

app.post("/api/memory/generations/:id/activate", asyncRoute(async (req, res) => {
  const generationId = z.string().regex(/^[a-f0-9]{64}$/).parse(String(req.params.id));
  const store = await loadStore();
  if (!memorySubsystem.reembedding) return res.status(503).json({ error: "Vector store is unavailable." });
  memorySubsystem.reembedding.cutover(store.memory, store.settings, generationId);
  await audit({ actor: "operator", action: "memory.generation.activate", risk: "write", status: "ok", message: generationId });
  res.json(memorySubsystem.diagnostics(store));
}));

app.post("/api/memory/generations/rollback", asyncRoute(async (_req, res) => {
  const store = await loadStore();
  if (!memorySubsystem.reembedding) return res.status(503).json({ error: "Vector store is unavailable." });
  const result = memorySubsystem.reembedding.rollback(store.settings);
  await audit({ actor: "operator", action: "memory.generation.rollback", risk: "write", status: "ok", message: result.activeGenerationId });
  res.json(result);
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
  if (!reserveRunSlot(id)) return res.status(409).json({ error: "Another run is already active. NexusHarness permits one active run per service instance." });
  try {
    run.workspaceRoot ??= await prepareRunExportWorkspace(run.id);
    run.status = "running";
    run.error = undefined;
    run.updatedAt = new Date().toISOString();
    await saveStore(store);
    void executeRun(run.id);
    res.json(run);
  } finally {
    releaseRunSlot(id);
  }
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

app.get("/api/workspace/entries", asyncRoute(async (req, res) => {
  const store = await loadStore();
  const relativePath = String(req.query.path ?? ".");
  const entries = await workspaceEntries(store.settings, relativePath);
  await audit({ actor: "operator", action: "workspace.browse", risk: "read", status: "ok", message: relativePath, details: { entries: entries.length } });
  res.json(entries);
}));

app.get("/api/workspace/search", asyncRoute(async (req, res) => {
  const store = await loadStore();
  const query = String(req.query.q ?? "").trim();
  if (!query) return res.status(400).json({ error: "Workspace search requires a non-empty q parameter." });
  const results = await searchWorkspace(store.settings, query);
  res.json(results);
}));

app.get("/api/workspace/preview", asyncRoute(async (req, res) => {
  const store = await loadStore();
  const relativePath = String(req.query.path ?? "");
  if (!relativePath) return res.status(400).json({ error: "Workspace preview requires a path parameter." });
  const preview = await previewWorkspaceFile(store.settings, relativePath);
  await audit({ actor: "operator", action: "workspace.preview", risk: "read", status: "ok", message: relativePath, details: { bytes: preview.size, truncated: preview.truncated, binary: preview.binary } });
  res.json(preview);
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
  const rejectedRunIds: string[] = [];
  if (approval.decision === "rejected") {
    for (const run of store.runs.filter((item) => item.status === "waiting_approval" && (item.id === approval.runId || item.error?.includes(approval.id)))) {
      run.status = "failed";
      run.error = `Operator rejected ${approval.action}. approvalId=${approval.id}`;
      run.updatedAt = new Date().toISOString();
      rejectedRunIds.push(run.id);
    }
  }
  await saveStore(store);
  await Promise.all(rejectedRunIds.map((runId) => abandonRunTransaction(runId, `Operator rejected ${approval.action}.`)));
  const approvalDetails = approval.payload && typeof approval.payload === "object" && !Array.isArray(approval.payload)
    ? { ...approval.payload as Record<string, unknown>, approvalId: approval.id, runId: approval.runId, subtask: approval.subtask }
    : { payload: approval.payload, approvalId: approval.id, runId: approval.runId, subtask: approval.subtask };
  await audit({ actor: "operator", action: `approval.${approval.decision}`, risk: approval.risk, status: approval.decision, message: approval.action, details: approvalDetails });
  res.json(approval);
}));

app.post("/api/service/stop", (req, res) => {
  const authorization = req.header("authorization") ?? "";
  const supplied = authorization.startsWith("Bearer ") ? authorization.slice("Bearer ".length) : "";
  if (!safeTokenEqual(supplied, serviceToken)) return res.status(403).json({ error: "Service shutdown authorization failed." });
  res.status(202).json({ status: "stopping", pid: process.pid });
  setImmediate(() => shutdown("SIGTERM"));
});

app.use(express.static(installationPaths.webRoot));
app.use("/api", (_req, res) => res.status(404).json({ error: "API endpoint not found." }));
app.get("*", (_req, res) => {
  res.sendFile(path.join(installationPaths.webRoot, "index.html"));
});

app.use((error: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  void _next;
  const message = error?.issues ? error.issues : error?.message ?? String(error);
  const workspaceInputError = typeof message === "string" && /^(Path escapes workspace root|Cannot resolve workspace path safely|Path is not (?:a directory|a regular file)|Symbolic links are not previewed)/.test(message);
  const status = error?.issues || error instanceof SyntaxError || workspaceInputError ? 400 : Number(error?.status ?? 500);
  res.status(status >= 400 && status <= 599 ? status : 500).json({ error: message });
});

const httpServer = app.listen(port, "127.0.0.1", () => {
  void persistServiceState().then(() => {
    console.log(`NexusHarness API listening on http://127.0.0.1:${port}`);
    void scheduleMemoryBackfill();
  }).catch((error) => {
    console.error(`NexusHarness could not persist service state: ${error instanceof Error ? error.message : String(error)}`);
    shutdown("SIGTERM");
  });
});

let checkingInstallationLease = false;
const installationLease = setInterval(() => {
  if (checkingInstallationLease || shuttingDown) return;
  checkingInstallationLease = true;
  void Promise.all([access(installationPaths.packageJson), access(installationPaths.serverEntry)])
    .catch(() => shutdown("SIGTERM"))
    .finally(() => { checkingInstallationLease = false; });
}, 5_000);
installationLease.unref();

let shuttingDown = false;
function shutdown(signal: NodeJS.Signals): void {
  if (shuttingDown) return;
  shuttingDown = true;
  clearInterval(installationLease);
  const deadline = setTimeout(() => process.exit(1), 5_000);
  deadline.unref();
  httpServer.close(() => {
    clearTimeout(deadline);
    memorySubsystem.vectorStore?.close();
    void removeOwnedServiceState().finally(() => {
      console.log(`NexusHarness API stopped after ${signal}.`);
      process.exit(0);
    });
  });
}
process.once("SIGINT", () => shutdown("SIGINT"));
process.once("SIGTERM", () => shutdown("SIGTERM"));

async function persistServiceState(): Promise<void> {
  const state: ServiceState = {
    schemaVersion: 1,
    pid: process.pid,
    port,
    token: serviceToken,
    version: buildInfo.version,
    installRoot: installationPaths.installRoot,
    startedAt: new Date().toISOString()
  };
  await mkdir(userPaths.stateRoot, { recursive: true });
  const temporary = `${userPaths.serviceState}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await rename(temporary, userPaths.serviceState);
}

async function removeOwnedServiceState(): Promise<void> {
  try {
    const state = JSON.parse(await readFile(userPaths.serviceState, "utf8")) as Partial<ServiceState>;
    if (state.pid === process.pid && state.token === serviceToken) await unlink(userPaths.serviceState);
  } catch (error: any) {
    if (error?.code !== "ENOENT") console.error(`NexusHarness could not remove service state: ${error?.message ?? String(error)}`);
  }
}

function safeTokenEqual(supplied: string, expected: string): boolean {
  const suppliedBytes = Buffer.from(supplied);
  const expectedBytes = Buffer.from(expected);
  return suppliedBytes.length === expectedBytes.length && timingSafeEqual(suppliedBytes, expectedBytes);
}

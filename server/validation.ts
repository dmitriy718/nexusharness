import { z } from "zod";
import { memoryEmbeddingSettingsSchema, memoryRetrievalSettingsSchema } from "./memory/config.js";

export const runtimeSchema = z.object({
  name: z.string().trim().min(1).max(200),
  kind: z.enum(["ollama", "lmstudio", "llamacpp-server", "llamacpp-cli"]),
  endpoint: z.string().url().refine((value) => value.startsWith("http://") || value.startsWith("https://"), "Endpoint must use HTTP or HTTPS.").optional(),
  binaryPath: z.string().max(4096).optional(),
  modelPath: z.string().max(4096).optional(),
  timeoutMs: z.number().int().min(1000).max(300000).default(60000)
}).superRefine((value, ctx) => {
  if (["ollama", "lmstudio", "llamacpp-server"].includes(value.kind) && !value.endpoint) {
    ctx.addIssue({ code: "custom", path: ["endpoint"], message: "HTTP runtimes require an endpoint URL." });
  }
  if (value.kind === "llamacpp-cli" && (!value.binaryPath || !value.modelPath)) {
    ctx.addIssue({ code: "custom", path: ["binaryPath"], message: "llama.cpp CLI requires binaryPath and modelPath." });
  }
});

export const settingsSchema = z.object({
  workspaceRoot: z.string().trim().min(1).max(4096),
  layout: z.enum(["chat", "ide", "agents"]).nullable(),
  maxIterations: z.number().int().min(1).max(25),
  maxParallelExecutors: z.number().int().min(1).max(12),
  criticThreshold: z.number().int().min(1).max(10),
  approvalMode: z.boolean(),
  shellPath: z.string().trim().min(1).max(4096),
  testCommand: z.string().max(100_000),
  lintCommand: z.string().max(100_000),
  mcpAutoDiscovery: z.boolean(),
  mcpPortStart: z.number().int().min(1).max(65535),
  mcpPortEnd: z.number().int().min(1).max(65535),
  memoryTokenBudget: z.number().int().min(0).max(50000),
  memoryRetrieval: memoryRetrievalSettingsSchema.optional().default({}),
  memoryEmbeddings: memoryEmbeddingSettingsSchema.optional().default({}),
  agentModels: z.object({
    planner: z.string().max(8192).optional(),
    executor: z.string().max(8192).optional(),
    critic: z.string().max(8192).optional()
  })
}).superRefine((value, ctx) => {
  if (value.mcpPortStart > value.mcpPortEnd) {
    ctx.addIssue({ code: "custom", path: ["mcpPortStart"], message: "MCP port start must be less than or equal to port end." });
  }
});

export const mcpServerSchema = z.object({
  name: z.string().trim().min(1).max(200),
  endpoint: z.string().trim().min(1).max(8192),
  transport: z.enum(["http", "stdio"]).default("http"),
  command: z.string().max(4096).optional(),
  args: z.array(z.string().max(8192)).max(200).optional(),
  enabled: z.boolean().default(true)
}).superRefine((value, ctx) => {
  if (value.transport === "http") {
    const valid = z.string().url().safeParse(value.endpoint);
    if (!valid.success || (!value.endpoint.startsWith("http://") && !value.endpoint.startsWith("https://"))) {
      ctx.addIssue({ code: "custom", path: ["endpoint"], message: "HTTP MCP servers require an HTTP or HTTPS endpoint URL." });
    }
  }
  if (value.transport === "stdio" && !value.command) {
    ctx.addIssue({ code: "custom", path: ["command"], message: "stdio MCP servers require a command." });
  }
});

export const memorySchema = z.object({
  kind: z.enum(["retrospective", "snippet", "context"]),
  taskType: z.string().trim().min(1).max(500),
  title: z.string().trim().min(1).max(500),
  content: z.string().min(1).max(2_000_000),
  pinned: z.boolean().default(false),
  source: z.string().max(2000).optional(),
  importance: z.number().finite().min(0).max(1).optional().default(0.5)
});

export const taskSchema = z.object({
  task: z.string().trim().min(1, "task is required.").max(20_000, "task must be 20,000 characters or fewer.")
});

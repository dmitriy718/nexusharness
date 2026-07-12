import type { MemoryEmbeddingSettings, MemoryIndexingMetadata, MemoryRetrievalSettings } from "./memory/types.js";

export type RuntimeKind = "ollama" | "lmstudio" | "llamacpp-server" | "llamacpp-cli";
export type AgentRole = "planner" | "executor" | "critic";
export type RiskLevel = "read" | "write" | "execute" | "network";
export type ApprovalDecision = "pending" | "approved" | "rejected";

export interface RuntimeConfig {
  id: string;
  name: string;
  kind: RuntimeKind;
  endpoint?: string;
  binaryPath?: string;
  modelPath?: string;
  timeoutMs: number;
}

export interface ModelInfo {
  id: string;
  runtimeId: string;
  name: string;
  contextWindow?: number;
  supportsTools: boolean;
  quantization?: string;
  raw: unknown;
}

export interface AgentModelAssignments {
  planner?: string;
  executor?: string;
  critic?: string;
}

export interface Settings {
  workspaceRoot: string;
  layout: "chat" | "ide" | "agents" | null;
  maxIterations: number;
  maxParallelExecutors: number;
  criticThreshold: number;
  approvalMode: boolean;
  shellPath: string;
  testCommand: string;
  lintCommand: string;
  mcpAutoDiscovery: boolean;
  mcpPortStart: number;
  mcpPortEnd: number;
  memoryTokenBudget: number;
  memoryRetrieval?: MemoryRetrievalSettings;
  memoryEmbeddings?: MemoryEmbeddingSettings;
  agentModels: AgentModelAssignments;
}

export interface McpToolConfig {
  name: string;
  description?: string;
  inputSchema?: unknown;
  enabled: boolean;
}

export interface McpServerConfig {
  id: string;
  name: string;
  endpoint: string;
  transport: "http" | "stdio";
  command?: string;
  args?: string[];
  enabled: boolean;
  status: "unknown" | "online" | "offline" | "error";
  tools: McpToolConfig[];
  lastError?: string;
}

export interface MemoryEntry {
  id: string;
  kind: "retrospective" | "snippet" | "context";
  taskType: string;
  title: string;
  content: string;
  pinned: boolean;
  source?: string;
  namespace?: string;
  importance?: number;
  lastAccessedAt?: string;
  tokenCount?: number;
  contentHash?: string;
  indexing?: MemoryIndexingMetadata;
  createdAt: string;
  updatedAt: string;
}

export interface AuditEvent {
  id: string;
  at: string;
  actor: "operator" | "planner" | "executor" | "critic" | "system";
  action: string;
  risk: RiskLevel;
  status: "ok" | "error" | ApprovalDecision;
  message: string;
  details?: unknown;
}

export interface ApprovalRequest {
  id: string;
  createdAt: string;
  actor: "executor" | "system";
  action: string;
  risk: RiskLevel;
  payload: unknown;
  runId?: string;
  subtask?: string;
  decision: ApprovalDecision;
  decidedAt?: string;
  usedAt?: string;
}

export interface ApprovalContext {
  runId?: string;
  subtask?: string;
}

export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  toolName?: string;
  toolCallId?: string;
  toolCalls?: ToolCallRequest[];
}

export interface ToolCallRequest {
  id?: string;
  name: string;
  arguments: Record<string, unknown>;
}

export interface ModelChatRequest {
  model: string;
  messages: ChatMessage[];
  tools?: unknown[];
  temperature?: number;
  signal?: AbortSignal;
}

export interface ModelChatResponse {
  content: string;
  toolCalls: ToolCallRequest[];
  raw: unknown;
}

export type ExecutionCellState = "preparing" | "isolated" | "executing" | "verifying" | "ready_to_commit" | "committed" | "rolled_back" | "failed" | "destroyed";

export interface RunExecutionSummary {
  schemaVersion: 1;
  cellId: string;
  provider: "portable-worktree" | "windows-sandbox" | "firecracker" | "remote";
  securityBoundary: boolean;
  boundaryDescription: string;
  state: ExecutionCellState;
  baseRevision: string;
  networkDefault: "deny";
  capabilities: Record<"read" | "write" | "delete" | "execute" | "network" | "secrets", string[]>;
  budget: { wallTimeMs: number; cpuTimeMs: number; memoryBytes: number; diskBytes: number; processCount: number; outputBytes: number };
  effects: Array<{ kind: string; target: string; status: string }>;
  variances: Array<{ kind: "missing" | "unexpected" | "forbidden" | "mismatch"; severity: "warning" | "blocking"; effectTarget: string; detail: string }>;
  evidence: Array<{ kind: string; name: string; status: "passed" | "failed" | "warning"; detail?: string }>;
  commit: { available: boolean; reason: string };
  rollback: { available: boolean; reason: string };
  updatedAt: string;
}

export interface TaskRun {
  id: string;
  task: string;
  status: "running" | "waiting_approval" | "passed" | "failed" | "canceled";
  phase: "plan" | "execute" | "critic" | "test" | "retrospective" | "done";
  iteration: number;
  maxIterations: number;
  log: AuditEvent[];
  plan?: string[];
  subtaskResults?: Array<{ subtask: string; output: string }>;
  executorOutput?: string;
  criticFeedback?: string;
  criticScore?: number;
  validationOutput?: string;
  result?: string;
  error?: string;
  execution?: RunExecutionSummary;
  createdAt: string;
  updatedAt: string;
}

export interface StoreShape {
  settings: Settings;
  runtimes: RuntimeConfig[];
  mcpServers: McpServerConfig[];
  memory: MemoryEntry[];
  audit: AuditEvent[];
  approvals: ApprovalRequest[];
  runs: TaskRun[];
}

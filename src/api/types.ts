export type LayoutMode = "chat" | "ide" | "agents";
export type RunStatus = "running" | "waiting_approval" | "passed" | "failed" | "canceled";
export type RunPhase = "plan" | "execute" | "critic" | "test" | "retrospective" | "done";

export type Runtime = {
  id: string;
  name: string;
  kind: string;
  endpoint?: string;
  binaryPath?: string;
  modelPath?: string;
  timeoutMs: number;
};

export type RuntimeKind = "ollama" | "lmstudio" | "llamacpp-server" | "llamacpp-cli";

export type Model = {
  id: string;
  runtimeId: string;
  name: string;
  contextWindow?: number;
  supportsTools: boolean;
  quantization?: string;
};

export type RuntimeTestResult = {
  checkedAt: string;
  latencyMs: number;
  models: Model[];
};

export type McpTool = {
  name: string;
  enabled: boolean;
  description?: string;
  inputSchema?: unknown;
};

export type McpServer = {
  id: string;
  name: string;
  endpoint: string;
  transport: "http" | "stdio";
  enabled: boolean;
  status: string;
  tools: McpTool[];
  lastError?: string;
  command?: string;
  args?: string[];
};

export type MemoryEntry = {
  id: string;
  kind: "retrospective" | "snippet" | "context";
  taskType: string;
  title: string;
  content: string;
  pinned: boolean;
  source?: string;
  createdAt?: string;
  updatedAt?: string;
};

export type SettingsShape = {
  workspaceRoot: string;
  layout: LayoutMode | null;
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
  agentModels: Record<string, string | undefined>;
};

export type AuditEvent = {
  id: string;
  at: string;
  actor: string;
  action: string;
  risk: string;
  status: string;
  message: string;
  details?: unknown;
};

export type Approval = {
  id: string;
  createdAt: string;
  actor: string;
  action: string;
  risk: string;
  payload: unknown;
  runId?: string;
  subtask?: string;
  decision: "pending" | "approved" | "rejected";
  decidedAt?: string;
};

export type TaskRun = {
  id: string;
  task: string;
  status: RunStatus;
  phase: RunPhase;
  iteration: number;
  maxIterations: number;
  plan?: unknown[];
  subtaskResults?: Array<{ subtask: unknown; output: unknown }>;
  executorOutput?: string;
  criticFeedback?: string;
  criticScore?: number;
  validationOutput?: string;
  result?: string;
  error?: string;
  createdAt: string;
  updatedAt: string;
};

export type Store = {
  settings: SettingsShape;
  runtimes: Runtime[];
  mcpServers: McpServer[];
  memory: MemoryEntry[];
  audit: AuditEvent[];
  approvals: Approval[];
  runs: TaskRun[];
};

export type RunHistoryPage = {
  items: TaskRun[];
  total: number;
  offset: number;
  limit: number;
  hasMore: boolean;
};

export type RunDetailRecord = {
  run: TaskRun;
  audit: AuditEvent[];
  approvals: Approval[];
};

export type BuildHealth = {
  status: string;
  version: string;
  commit: string;
  builtAt: string | null;
  mode: string;
  uptimeSeconds: number;
};

export type WorkspaceNode = {
  name: string;
  path: string;
  type: "file" | "directory" | "symlink";
  size?: number;
  modifiedAt?: string;
  blocked?: boolean;
  children?: WorkspaceNode[];
};

export type WorkspacePreview = {
  name: string;
  path: string;
  size: number;
  modifiedAt: string;
  binary: boolean;
  truncated: boolean;
  content: string;
  language: string;
};

export type LayoutMode = "chat" | "ide" | "agents";
export type RunStatus = "running" | "waiting_approval" | "passed" | "failed" | "canceled";
export type RunPhase = "plan" | "execute" | "critic" | "test" | "retrospective" | "done";
export type ExecutionCellState = "preparing" | "isolated" | "executing" | "verifying" | "ready_to_commit" | "committed" | "rolled_back" | "failed" | "destroyed";

export type RunExecutionSummary = {
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
};

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
  namespace?: string;
  importance?: number;
  lastAccessedAt?: string;
  tokenCount?: number;
  contentHash?: string;
  indexing?: { status: "pending" | "indexing" | "indexed" | "stale" | "failed" | "disabled"; generationId?: string; embeddedAt?: string; chunkCount?: number; errorCode?: string; updatedAt: string };
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
  memoryRetrieval?: {
    mode: "lexical_only" | "shadow_semantic" | "hybrid" | "semantic_only";
    topKCandidates: number;
    finalMemoryLimit: number;
    similarityMetric: "cosine" | "l2";
    minimumSemanticScore: number;
    semanticWeight: number;
    lexicalWeight: number;
    recencyWeight: number;
    taskTypeWeight: number;
    importanceWeight: number;
    pinnedPolicy: "always_include" | "ranked";
    deduplicate: boolean;
    diversityReranking: boolean;
    diversityLambda: number;
  };
  memoryEmbeddings?: {
    provider: "transformers-local" | "ollama" | "openai-compatible";
    model: string;
    modelRevision: string;
    endpoint: string;
    dimensions: number | null;
    batchSize: number;
    timeoutMs: number;
    maxRetries: number;
    maxInputTokens: number;
    chunkSizeTokens: number;
    chunkOverlapTokens: number;
    cacheEnabled: boolean;
    cacheMaxEntries: number;
    cacheTtlMs: number;
    embedOnWrite: boolean;
    allowAsyncBackfill: boolean;
    failurePolicy: "lexical_fallback" | "fail_closed";
    allowRemoteContent: boolean;
    allowModelDownload: boolean;
    apiKeyEnvironmentVariable: string;
    preprocessingVersion: string;
  };
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
  failure?: RunFailureDetails;
  execution?: RunExecutionSummary;
  createdAt: string;
  updatedAt: string;
};

export type RunFailureDetails = {
  code: "runtime_timeout" | "runtime_unavailable" | "runtime_http_error" | "runtime_invalid_response" | "validation_failed" | "approval_failed" | "execution_failed" | "unknown";
  title: string;
  summary: string;
  technicalDetail: string;
  corrections: string[];
  retryable: boolean;
  occurredAt: string;
  phase: RunPhase;
  agentRole?: "planner" | "executor" | "critic";
  subtask?: string;
  runtimeId?: string;
  runtimeName?: string;
  runtimeKind?: Runtime["kind"];
  endpoint?: string;
  model?: string;
  timeoutMs?: number;
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

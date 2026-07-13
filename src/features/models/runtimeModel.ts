import type { Model, Runtime, RuntimeKind, SettingsShape } from "../../api/types";

export type RuntimeDraft = {
  name: string;
  kind: RuntimeKind;
  endpoint: string;
  binaryPath: string;
  modelPath: string;
  timeoutMs: number;
};

export type RuntimeFieldErrors = Partial<Record<keyof RuntimeDraft, string>>;

const endpoints: Record<Exclude<RuntimeKind, "llamacpp-cli">, string> = {
  ollama: "http://127.0.0.1:11434",
  lmstudio: "http://127.0.0.1:1234",
  "llamacpp-server": "http://127.0.0.1:8080"
};

export function runtimeDraft(kind: RuntimeKind = "ollama"): RuntimeDraft {
  return { name: "", kind, endpoint: kind === "llamacpp-cli" ? "" : endpoints[kind], binaryPath: "", modelPath: "", timeoutMs: 300000 };
}

export function changeRuntimeKind(draft: RuntimeDraft, kind: RuntimeKind): RuntimeDraft {
  return {
    ...draft,
    kind,
    endpoint: kind === "llamacpp-cli" ? "" : endpoints[kind],
    binaryPath: kind === "llamacpp-cli" ? draft.binaryPath : "",
    modelPath: kind === "llamacpp-cli" ? draft.modelPath : ""
  };
}

export function validateRuntimeDraft(draft: RuntimeDraft): RuntimeFieldErrors {
  const errors: RuntimeFieldErrors = {};
  if (!draft.name.trim()) errors.name = "Give this connection a recognizable name.";
  if (!Number.isInteger(draft.timeoutMs) || draft.timeoutMs < 1000 || draft.timeoutMs > 300000) errors.timeoutMs = "Use a timeout from 1,000 to 300,000 milliseconds.";
  if (draft.kind === "llamacpp-cli") {
    if (!draft.binaryPath.trim()) errors.binaryPath = "Select or enter the llama.cpp CLI executable path.";
    if (!draft.modelPath.trim()) errors.modelPath = "Select or enter the GGUF model path.";
  } else {
    try {
      const endpoint = new URL(draft.endpoint);
      if (!['http:', 'https:'].includes(endpoint.protocol)) errors.endpoint = "Use an HTTP or HTTPS endpoint.";
    } catch {
      errors.endpoint = "Enter a complete endpoint URL, including http:// or https://.";
    }
  }
  return errors;
}

export function runtimePayload(draft: RuntimeDraft) {
  return draft.kind === "llamacpp-cli"
    ? { name: draft.name.trim(), kind: draft.kind, binaryPath: draft.binaryPath.trim(), modelPath: draft.modelPath.trim(), timeoutMs: draft.timeoutMs }
    : { name: draft.name.trim(), kind: draft.kind, endpoint: draft.endpoint.trim(), timeoutMs: draft.timeoutMs };
}

export function assignmentImpact(runtime: Runtime, assignments: SettingsShape["agentModels"]): string[] {
  return Object.entries(assignments).filter(([, modelId]) => modelId?.startsWith(`${runtime.id}:`)).map(([role]) => role);
}

export function roleCapability(role: string, model: Model): { tone: "native" | "fallback" | "compatible"; label: string; detail: string } {
  if (role === "executor" && model.supportsTools) return { tone: "native", label: "Native tools", detail: "Best fit: this model reports native tool-call support." };
  if (role === "executor") return { tone: "fallback", label: "JSON fallback", detail: "Compatible through the harness JSON tool-call fallback; native tools are preferred." };
  return { tone: "compatible", label: "Compatible", detail: role === "planner" ? "Planning uses structured text output." : "Critique uses scored structured text output." };
}

export function assignedModel(modelId: string | undefined, models: Model[]): Model | undefined {
  return modelId ? models.find((model) => model.id === modelId) : undefined;
}

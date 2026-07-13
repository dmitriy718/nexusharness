import { describe, expect, it } from "vitest";
import type { Model, Runtime, SettingsShape } from "../src/api/types";
import { assignmentImpact, changeRuntimeKind, roleCapability, runtimeDraft, runtimePayload, validateRuntimeDraft } from "../src/features/models/runtimeModel";

const model: Model = { id: "runtime-1:model-a", runtimeId: "runtime-1", name: "model-a", supportsTools: false };

describe("runtime configuration model", () => {
  it("uses connector-specific defaults and clears irrelevant fields", () => {
    const ollama = runtimeDraft("ollama");
    expect(ollama.endpoint).toBe("http://127.0.0.1:11434");
    const cli = changeRuntimeKind({ ...ollama, binaryPath: "llama.exe", modelPath: "model.gguf" }, "llamacpp-cli");
    expect(cli).toMatchObject({ kind: "llamacpp-cli", endpoint: "", binaryPath: "llama.exe", modelPath: "model.gguf" });
    const studio = changeRuntimeKind(cli, "lmstudio");
    expect(studio).toMatchObject({ kind: "lmstudio", endpoint: "http://127.0.0.1:1234", binaryPath: "", modelPath: "" });
  });

  it("validates only fields relevant to the selected connector", () => {
    expect(validateRuntimeDraft(runtimeDraft())).toEqual({ name: "Give this connection a recognizable name." });
    expect(validateRuntimeDraft({ ...runtimeDraft("ollama"), name: "Broken", endpoint: "ftp://localhost", timeoutMs: 200 })).toEqual({ endpoint: "Use an HTTP or HTTPS endpoint.", timeoutMs: "Use a timeout from 1,000 to 300,000 milliseconds." });
    expect(validateRuntimeDraft({ ...runtimeDraft("llamacpp-cli"), name: "CLI" })).toMatchObject({ binaryPath: expect.any(String), modelPath: expect.any(String) });
  });

  it("sends a minimal connector-specific payload", () => {
    expect(runtimePayload({ ...runtimeDraft("ollama"), name: "  Local  " })).toEqual({ name: "Local", kind: "ollama", endpoint: "http://127.0.0.1:11434", timeoutMs: 300000 });
    expect(runtimePayload({ ...runtimeDraft("llamacpp-cli"), name: "CLI", binaryPath: " llama.exe ", modelPath: " model.gguf " })).toEqual({ name: "CLI", kind: "llamacpp-cli", binaryPath: "llama.exe", modelPath: "model.gguf", timeoutMs: 300000 });
  });

  it("reports exactly which roles are affected by runtime removal", () => {
    const runtime: Runtime = { id: "runtime-1", name: "Local", kind: "ollama", timeoutMs: 60000 };
    const assignments = { planner: "runtime-1:model-a", executor: "runtime-2:model-b", critic: "runtime-1:model-c" } as SettingsShape["agentModels"];
    expect(assignmentImpact(runtime, assignments)).toEqual(["planner", "critic"]);
  });

  it("distinguishes native executor tools from the compatible JSON fallback", () => {
    expect(roleCapability("executor", model)).toMatchObject({ tone: "fallback", label: "JSON fallback" });
    expect(roleCapability("executor", { ...model, supportsTools: true })).toMatchObject({ tone: "native", label: "Native tools" });
    expect(roleCapability("planner", model)).toMatchObject({ tone: "compatible" });
  });
});

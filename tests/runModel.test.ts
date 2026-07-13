import { describe, expect, it } from "vitest";
import type { TaskRun } from "../src/api/types";
import { displayRunValue, filterRuns, phaseState, runActions, runFailurePresentation, runSummary } from "../src/features/runs/runModel";

function run(overrides: Partial<TaskRun> = {}): TaskRun {
  return {
    id: "run-1",
    task: "Build the feature",
    status: "running",
    phase: "critic",
    iteration: 2,
    maxIterations: 5,
    createdAt: "2026-07-11T00:00:00.000Z",
    updatedAt: "2026-07-11T00:01:00.000Z",
    ...overrides
  };
}

describe("run phase presentation", () => {
  it("distinguishes completed, active, and pending phases", () => {
    const value = run();
    expect(phaseState(value, "plan")).toBe("complete");
    expect(phaseState(value, "test")).toBe("complete");
    expect(phaseState(value, "critic")).toBe("active");
    expect(phaseState(value, "retrospective")).toBe("pending");
  });

  it("maps terminal and approval states on the current phase", () => {
    expect(phaseState(run({ status: "failed" }), "critic")).toBe("failed");
    expect(phaseState(run({ status: "canceled" }), "critic")).toBe("canceled");
    expect(phaseState(run({ status: "waiting_approval" }), "critic")).toBe("waiting");
    expect(phaseState(run({ status: "passed", phase: "done" }), "done")).toBe("complete");
  });

  it("shows objective validation as skipped when no commands were configured", () => {
    expect(phaseState(run({ validationOutput: "No automated lint or test commands are configured." }), "test")).toBe("skipped");
  });
});

describe("run action eligibility", () => {
  it("allows cancellation only while running", () => {
    expect(runActions(run()).canCancel).toBe(true);
    expect(runActions(run({ status: "failed" })).canCancel).toBe(false);
  });

  it("allows resume from recoverable states and duplicate from every state", () => {
    expect(runActions(run({ status: "failed" })).canResume).toBe(true);
    expect(runActions(run({ status: "canceled" })).canResume).toBe(true);
    expect(runActions(run({ status: "waiting_approval" })).canResume).toBe(true);
    expect(runActions(run({ status: "passed" })).canResume).toBe(false);
    expect(runActions(run({ status: "passed" })).canDuplicate).toBe(true);
  });
});

describe("run history filtering", () => {
  const runs = [
    run({ id: "passed-run", task: "Build navigation", status: "passed" }),
    run({ id: "canceled-run", task: "Refactor storage", status: "canceled" })
  ];

  it("filters successful and canceled history by status", () => {
    expect(filterRuns(runs, "", "passed").map((item) => item.id)).toEqual(["passed-run"]);
    expect(filterRuns(runs, "", "canceled").map((item) => item.id)).toEqual(["canceled-run"]);
  });

  it("returns an empty result for a non-matching task or ID", () => {
    expect(filterRuns(runs, "no such workflow", "all")).toEqual([]);
  });
});

describe("legacy run output", () => {
  it("turns legacy aborted runtime errors into timeout guidance", () => {
    const failure = runFailurePresentation(run({
      status: "failed",
      phase: "execute",
      error: "Cannot reach runtime endpoint http://127.0.0.1:11434/api/chat. Last error: This operation was aborted"
    }), {
      workspaceRoot: ".", layout: "chat", maxIterations: 5, maxParallelExecutors: 3, criticThreshold: 7, approvalMode: false,
      shellPath: "powershell.exe", testCommand: "", lintCommand: "", mcpAutoDiscovery: false, mcpPortStart: 3000, mcpPortEnd: 9999,
      memoryTokenBudget: 2000, agentModels: { executor: "runtime:qwen2.5-coder:14b" }
    });
    expect(failure).toMatchObject({ code: "runtime_timeout", title: "Executor model request timed out", endpoint: "http://127.0.0.1:11434/api/chat" });
    expect(failure?.corrections.join(" ")).toContain("streamed inactivity timeouts");
    expect(failure?.corrections.join(" ")).toContain("Reduce Max parallel executors from 3 to 1");
  });

  it("prefers persisted structured failure evidence", () => {
    const failure = runFailurePresentation(run({ status: "failed", error: "raw", failure: {
      code: "runtime_timeout", title: "Saved title", summary: "Saved summary", technicalDetail: "detail", corrections: ["fix"], retryable: true,
      occurredAt: "2026-07-12T00:00:00.000Z", phase: "execute"
    } }));
    expect(failure?.title).toBe("Saved title");
  });

  it("extracts useful labels from persisted object values", () => {
    expect(displayRunValue({ title: "Inspect the API", detail: "ignored" })).toBe("Inspect the API");
    expect(displayRunValue({ task: "Run tests" })).toBe("Run tests");
  });

  it("falls back to formatted JSON instead of object coercion", () => {
    expect(displayRunValue({ unexpected: true })).toContain("\"unexpected\": true");
  });

  it("creates a portable run summary", () => {
    expect(runSummary(run({ status: "failed", error: "Critic rejected output" }))).toContain("Critic rejected output");
  });
});

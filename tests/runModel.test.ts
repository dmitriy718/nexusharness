import { describe, expect, it } from "vitest";
import type { TaskRun } from "../src/api/types";
import { displayRunValue, filterRuns, phaseState, runActions, runSummary } from "../src/features/runs/runModel";

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

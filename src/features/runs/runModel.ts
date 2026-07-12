import type { RunFailureDetails, RunPhase, SettingsShape, TaskRun } from "../../api/types";

export const runPhases: RunPhase[] = ["plan", "execute", "test", "critic", "retrospective", "done"];

export type PhaseState = "pending" | "active" | "complete" | "failed" | "canceled" | "waiting" | "skipped";

export function phaseState(run: TaskRun, phase: RunPhase): PhaseState {
  const currentIndex = runPhases.indexOf(run.phase);
  const phaseIndex = runPhases.indexOf(phase);
  if (phase === "test" && phaseIndex < currentIndex && run.validationOutput?.startsWith("No automated lint or test commands are configured.")) {
    return "skipped";
  }
  if (phaseIndex < currentIndex) return "complete";
  if (phaseIndex > currentIndex) return "pending";
  if (run.status === "passed") return "complete";
  if (run.status === "failed") return "failed";
  if (run.status === "canceled") return "canceled";
  if (run.status === "waiting_approval") return "waiting";
  return "active";
}

export function runActions(run: TaskRun) {
  return {
    canCancel: run.status === "running",
    canResume: ["failed", "canceled", "waiting_approval"].includes(run.status),
    canDuplicate: true
  };
}

export function runFailurePresentation(run: TaskRun, settings?: SettingsShape): RunFailureDetails | null {
  if (run.failure) return run.failure;
  if (run.status !== "failed" || !run.error) return null;
  const error = run.error;
  const timeout = /timed out|operation was aborted/i.test(error);
  const endpoint = error.match(/https?:\/\/[^\s]+/)?.[0]?.replace(/[.,]$/, "");
  if (timeout) {
    const role = run.phase === "plan" ? "planner" : run.phase === "critic" || run.phase === "retrospective" ? "critic" : "executor";
    const assignment = settings?.agentModels[role];
    const model = assignment?.includes(":") ? assignment.slice(assignment.indexOf(":") + 1) : assignment;
    const concurrency = settings?.maxParallelExecutors ?? 1;
    return {
      code: "runtime_timeout",
      title: `${capitalize(role)} model request timed out`,
      summary: `${capitalize(role)}${model ? ` using ${model}` : ""} did not finish before the configured runtime deadline. The run stopped during ${run.phase} before that response could be applied.`,
      technicalDetail: error,
      corrections: [
        "Open Models and increase the selected runtime timeout; for slower local models, start with 180,000 ms.",
        ...(role === "executor" && concurrency > 1 ? [`Reduce Max parallel executors from ${concurrency} to 1 in Settings to avoid queueing several requests on one local model.`] : []),
        "Retry with a smaller or faster model if responses still exceed the deadline."
      ],
      retryable: true,
      occurredAt: run.updatedAt,
      phase: run.phase,
      agentRole: role,
      endpoint,
      model
    };
  }
  if (/cannot reach runtime|could not connect|ECONNREFUSED|fetch failed/i.test(error)) {
    return {
      code: "runtime_unavailable",
      title: "Model runtime is unavailable",
      summary: `The selected model runtime could not complete the request during ${run.phase}.`,
      technicalDetail: error,
      corrections: ["Open Models and test the assigned runtime.", ...(endpoint ? [`Verify that ${endpoint} is running and reachable.`] : []), "Confirm the assigned model exists, then retry the run."],
      retryable: true,
      occurredAt: run.updatedAt,
      phase: run.phase,
      endpoint
    };
  }
  return {
    code: "unknown",
    title: `Run failed during ${run.phase}`,
    summary: error,
    technicalDetail: error,
    corrections: ["Open Outputs and Activity to inspect the last successful event and technical details.", "Correct the reported problem, then retry the run."],
    retryable: true,
    occurredAt: run.updatedAt,
    phase: run.phase
  };
}

function capitalize(value: string): string {
  return value ? value[0].toUpperCase() + value.slice(1) : value;
}

export function displayRunValue(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === null || value === undefined) return "";
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    for (const key of ["title", "task", "description", "name", "content", "output"]) {
      if (typeof record[key] === "string" && record[key]) return record[key];
    }
    try {
      return JSON.stringify(value, null, 2);
    } catch {
      return "Unrecognized legacy output";
    }
  }
  return String(value);
}

export function runSummary(run: TaskRun): string {
  const lines = [
    run.task,
    "Status: " + run.status,
    "Phase: " + run.phase,
    "Iteration: " + run.iteration + "/" + run.maxIterations
  ];
  if (run.criticScore !== undefined) lines.push("Critic score: " + run.criticScore + "/10");
  if (run.result) lines.push("", "Result:", run.result);
  if (run.error) lines.push("", "Error:", run.error);
  if (run.failure?.corrections.length) lines.push("", "Suggested corrections:", ...run.failure.corrections.map((item) => `- ${item}`));
  return lines.join("\n");
}

export function filterRuns(runs: TaskRun[], query: string, status: string): TaskRun[] {
  const normalizedQuery = query.trim().toLowerCase();
  return runs.filter((run) => {
    const matchesQuery = !normalizedQuery || run.task.toLowerCase().includes(normalizedQuery) || run.id.toLowerCase().includes(normalizedQuery);
    return matchesQuery && (status === "all" || run.status === status);
  });
}

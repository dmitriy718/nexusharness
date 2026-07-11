import type { RunPhase, TaskRun } from "../../api/types";

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
  return lines.join("\n");
}

export function filterRuns(runs: TaskRun[], query: string, status: string): TaskRun[] {
  const normalizedQuery = query.trim().toLowerCase();
  return runs.filter((run) => {
    const matchesQuery = !normalizedQuery || run.task.toLowerCase().includes(normalizedQuery) || run.id.toLowerCase().includes(normalizedQuery);
    return matchesQuery && (status === "all" || run.status === status);
  });
}

import type { LayoutMode, TaskRun } from "../../api/types";

export type RunMode = "focus" | "studio" | "orchestrate";

export function modeFromLayout(layout: LayoutMode | null): RunMode {
  return layout === "ide" ? "studio" : layout === "agents" ? "orchestrate" : "focus";
}

export function layoutFromMode(mode: RunMode): LayoutMode {
  return mode === "studio" ? "ide" : mode === "orchestrate" ? "agents" : "chat";
}

export function subtaskLanes(run: TaskRun) {
  const plan = run.plan ?? [];
  return plan.map((subtask, index) => {
    const result = run.subtaskResults?.[index];
    const complete = Boolean(result);
    const active = !complete && run.status === "running" && run.phase === "execute" && index === (run.subtaskResults?.length ?? 0);
    return { index, title: String(typeof subtask === "object" ? JSON.stringify(subtask) : subtask), output: result?.output, state: complete ? "complete" : active ? "active" : run.status === "failed" ? "blocked" : "queued" };
  });
}

import { describe, expect, it } from "vitest";
import type { TaskRun } from "../src/api/types";
import { layoutFromMode, modeFromLayout, subtaskLanes } from "../src/features/runs/runModeModel";

const run = { id: "run", task: "Task", status: "running", phase: "execute", iteration: 1, maxIterations: 3, plan: ["Inspect", "Build", "Verify"], subtaskResults: [{ subtask: "Inspect", output: "Done" }], createdAt: "", updatedAt: "" } as TaskRun;

describe("run workspace modes", () => {
  it("maps persisted layout identity to truthful run modes", () => {
    expect(modeFromLayout("chat")).toBe("focus");
    expect(modeFromLayout("ide")).toBe("studio");
    expect(modeFromLayout("agents")).toBe("orchestrate");
    expect(layoutFromMode("orchestrate")).toBe("agents");
  });

  it("builds completed, active, and queued subtask lanes from real run data", () => {
    expect(subtaskLanes(run).map((lane) => lane.state)).toEqual(["complete", "active", "queued"]);
    expect(subtaskLanes(run)[0].output).toBe("Done");
  });

  it("marks remaining failed-run work as blocked", () => {
    expect(subtaskLanes({ ...run, status: "failed", subtaskResults: [] }).map((lane) => lane.state)).toEqual(["blocked", "blocked", "blocked"]);
  });
});

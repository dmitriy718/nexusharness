import { beforeEach, describe, expect, it } from "vitest";
import { clearLiveRunEventsForTests, liveRunEventSnapshot, publishLiveRunEvent, subscribeToLiveRunEvents } from "../server/liveRunEvents";

describe("live run event stream", () => {
  beforeEach(() => clearLiveRunEventsForTests());

  it("publishes bounded snapshots and coalesces adjacent model deltas as upserts", () => {
    const delivered: string[] = [];
    const unsubscribe = subscribeToLiveRunEvents("run-1", (event) => delivered.push(`${event.id}:${event.content}`));
    const first = publishLiveRunEvent({ runId: "run-1", kind: "model_output", title: "Executor output", content: "Hel", role: "executor", phase: "execute", status: "active", at: "2026-07-13T00:00:00.000Z" });
    const second = publishLiveRunEvent({ runId: "run-1", kind: "model_output", title: "Executor output", content: "lo", role: "executor", phase: "execute", status: "active", at: "2026-07-13T00:00:00.100Z" });
    const complete = publishLiveRunEvent({ runId: "run-1", kind: "model_complete", title: "Executor complete", content: "Done", role: "executor", phase: "execute", status: "ok", at: "2026-07-13T00:00:00.200Z" });
    unsubscribe();

    expect(second.id).toBe(first.id);
    expect(liveRunEventSnapshot("run-1")).toMatchObject([{ id: first.id, content: "Hello" }, { id: complete.id, content: "Done" }]);
    expect(delivered).toEqual([`${first.id}:Hel`, `${first.id}:Hello`, `${complete.id}:Done`]);
  });

  it("keeps observer failures isolated from run execution", () => {
    subscribeToLiveRunEvents("run-2", () => { throw new Error("observer disconnected"); });
    expect(() => publishLiveRunEvent({ runId: "run-2", kind: "tool_call", title: "file_read", content: "{}" })).not.toThrow();
    expect(liveRunEventSnapshot("run-2")).toHaveLength(1);
  });
});

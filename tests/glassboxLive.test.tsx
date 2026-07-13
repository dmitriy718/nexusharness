// @vitest-environment jsdom

import React from "react";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GlassboxLiveModal } from "../src/features/runs/GlassboxLiveModal";
import type { LiveRunEvent, TaskRun } from "../src/api/types";

class FakeEventSource {
  static instances: FakeEventSource[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((message: MessageEvent<string>) => void) | null = null;
  onerror: (() => void) | null = null;
  closed = false;
  constructor(readonly url: string) { FakeEventSource.instances.push(this); }
  close() { this.closed = true; }
  emit(event: LiveRunEvent) { this.onmessage?.(new MessageEvent("message", { data: JSON.stringify(event) })); }
}

beforeEach(() => {
  FakeEventSource.instances = [];
  vi.stubGlobal("EventSource", FakeEventSource);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("Glassbox Live", () => {
  it("labels literal reasoning accurately and renders live action events", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(<GlassboxLiveModal open onClose={onClose} runs={[run()]} preferredRunId="run-1" />);

    expect(screen.getByRole("dialog", { name: "Glassbox Live" })).toBeTruthy();
    expect(screen.getByText("Literal, not inferred.")).toBeTruthy();
    await waitFor(() => expect(FakeEventSource.instances).toHaveLength(1));
    expect(FakeEventSource.instances[0].url).toBe("/api/runs/run-1/events");

    FakeEventSource.instances[0].onopen?.();
    FakeEventSource.instances[0].emit({ id: "event-1", sequence: 1, runId: "run-1", at: "2026-07-13T00:00:00.000Z", kind: "tool_call", title: "file_write", content: "{\"path\":\"status.txt\"}", role: "executor", phase: "execute", status: "active" });
    await waitFor(() => expect(screen.getByText("file_write")).toBeTruthy());
    expect(screen.getByRole("status").textContent).toContain("Live");

    await user.click(screen.getByRole("button", { name: "Close Glassbox Live" }));
    expect(onClose).toHaveBeenCalledOnce();
  });
});

function run(): TaskRun {
  return { id: "run-1", task: "Create a verified status file", status: "running", phase: "execute", iteration: 1, maxIterations: 3, createdAt: "2026-07-13T00:00:00.000Z", updatedAt: "2026-07-13T00:00:01.000Z" };
}

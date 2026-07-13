// @vitest-environment jsdom

import React from "react";
import { render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { LiveRunEvent, TaskRun } from "../src/api/types";
import { RunDetailPage, synchronizeRunProgress } from "../src/features/runs/RunDetailPage";

const mocks = vi.hoisted(() => ({ api: vi.fn(), refresh: vi.fn(), notify: vi.fn() }));

vi.mock("../src/api/client", () => ({ api: mocks.api, errorMessage: (error: unknown) => error instanceof Error ? error.message : String(error) }));
vi.mock("../src/app/StoreProvider", () => ({ useHarness: () => ({ store: storeFixture(), refresh: mocks.refresh, notify: mocks.notify }) }));

class FakeEventSource {
  static instances: FakeEventSource[] = [];
  onmessage: ((event: MessageEvent<string>) => void) | null = null;
  closed = false;

  constructor(readonly url: string) {
    FakeEventSource.instances.push(this);
  }

  emit(event: LiveRunEvent) {
    this.onmessage?.({ data: JSON.stringify(event) } as MessageEvent<string>);
  }

  close() {
    this.closed = true;
  }
}

describe("live run progress", () => {
  beforeEach(() => {
    FakeEventSource.instances = [];
    vi.stubGlobal("EventSource", FakeEventSource as unknown as typeof EventSource);
    mocks.api.mockReset();
    mocks.refresh.mockReset();
    mocks.notify.mockReset();
    mocks.api.mockResolvedValue({ run: run(), audit: [], approvals: [] });
  });

  it("advances the phase rail from SSE events without waiting for another detail fetch", async () => {
    render(<MemoryRouter initialEntries={["/runs/run-live"]}><Routes><Route path="/runs/:runId" element={<RunDetailPage />} /></Routes></MemoryRouter>);
    await screen.findByRole("list", { name: "Run phases" });
    await waitFor(() => expect(FakeEventSource.instances).toHaveLength(1));
    expect(FakeEventSource.instances[0].url).toBe("/api/runs/run-live/events");
    expect(phase("Plan").classList.contains("phase-active")).toBe(true);
    expect(phase("Execute").classList.contains("phase-pending")).toBe(true);

    FakeEventSource.instances[0].emit(liveEvent("execute"));

    await waitFor(() => expect(phase("Execute").classList.contains("phase-active")).toBe(true));
    expect(phase("Plan").classList.contains("phase-complete")).toBe(true);
    expect(phase("Execute").getAttribute("aria-current")).toBe("step");
  });

  it("prefers a fresh compact phase when an equal-timestamp detail snapshot is frozen", () => {
    expect(synchronizeRunProgress(run(), run({ phase: "critic" }))?.phase).toBe("critic");
  });
});

function phase(label: string): HTMLElement {
  return screen.getByText(label).closest("li") as HTMLElement;
}

function liveEvent(phase: TaskRun["phase"]): LiveRunEvent {
  return { id: "event-1", sequence: 1, runId: "run-live", at: "2026-07-13T00:00:01.000Z", kind: "phase", title: `${phase} phase`, phase, status: "active" };
}

function run(overrides: Partial<TaskRun> = {}): TaskRun {
  return { id: "run-live", task: "Build the feature", status: "running", phase: "plan", iteration: 1, maxIterations: 5, createdAt: "2026-07-13T00:00:00.000Z", updatedAt: "2026-07-13T00:00:00.000Z", ...overrides };
}

function storeFixture() {
  const current = run();
  return {
    settings: { workspaceRoot: ".", layout: "chat", maxIterations: 5, maxParallelExecutors: 1, criticThreshold: 7, approvalMode: false, shellPath: "powershell.exe", testCommand: "", lintCommand: "", mcpAutoDiscovery: false, mcpPortStart: 3000, mcpPortEnd: 9999, memoryTokenBudget: 2000, agentModels: {} },
    runtimes: [], mcpServers: [], memory: [], audit: [], approvals: [], runs: [current]
  };
}

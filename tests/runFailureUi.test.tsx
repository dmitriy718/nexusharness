// @vitest-environment jsdom

import React from "react";
import { render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { RunDetailPage } from "../src/features/runs/RunDetailPage";

const mocks = vi.hoisted(() => ({ api: vi.fn(), refresh: vi.fn(), notify: vi.fn() }));

vi.mock("../src/api/client", () => ({ api: mocks.api, errorMessage: (error: unknown) => error instanceof Error ? error.message : String(error) }));
vi.mock("../src/app/StoreProvider", () => ({ useHarness: () => ({ store: storeFixture(), refresh: mocks.refresh, notify: mocks.notify }) }));

describe("failed run guidance", () => {
  beforeEach(() => {
    mocks.api.mockReset();
    mocks.refresh.mockReset();
    mocks.notify.mockReset();
    mocks.api.mockResolvedValue({ run: failedRun(), audit: [], approvals: [] });
  });

  it("prominently explains what failed and how to correct a legacy runtime timeout", async () => {
    render(<MemoryRouter initialEntries={["/runs/run-failed"]}><Routes><Route path="/runs/:runId" element={<RunDetailPage />} /></Routes></MemoryRouter>);
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("Executor model request timed out");
    expect(alert.textContent).toContain("Stopped at:");
    expect(alert.textContent).toContain("How to correct it:");
    expect(alert.textContent).toContain("streamed inactivity timeouts");
    expect(alert.textContent).toContain("Reduce Max parallel executors from 3 to 1");
    expect(screen.getByRole("link", { name: "Open Models" }).getAttribute("href")).toBe("/models");
    expect(screen.getByRole("link", { name: "Open Settings" }).getAttribute("href")).toBe("/settings");
    expect(screen.getByRole("list", { name: "Run phases" }).getAttribute("tabindex")).toBe("0");
  });
});

function failedRun() {
  return {
    id: "run-failed",
    task: "Build a marketing website",
    status: "failed",
    phase: "execute",
    iteration: 1,
    maxIterations: 5,
    plan: ["Develop Home Page"],
    error: "Cannot reach runtime endpoint http://127.0.0.1:11434/api/chat. Last error: This operation was aborted",
    createdAt: "2026-07-12T23:17:48.239Z",
    updatedAt: "2026-07-12T23:19:33.971Z"
  };
}

function storeFixture() {
  const run = failedRun();
  return {
    settings: {
      workspaceRoot: ".", layout: "chat", maxIterations: 5, maxParallelExecutors: 3, criticThreshold: 7, approvalMode: false,
      shellPath: "powershell.exe", testCommand: "", lintCommand: "", mcpAutoDiscovery: false, mcpPortStart: 3000, mcpPortEnd: 9999,
      memoryTokenBudget: 2000, agentModels: { planner: "runtime:qwen2.5-coder:14b", executor: "runtime:qwen2.5-coder:14b", critic: "runtime:qwen2.5-coder:14b" }
    },
    runtimes: [], mcpServers: [], memory: [], audit: [], approvals: [], runs: [run]
  };
}

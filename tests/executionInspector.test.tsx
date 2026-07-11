// @vitest-environment jsdom

import React from "react";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RunExecutionSummary } from "../src/api/types";
import { ExecutionInspector } from "../src/features/runs/ExecutionInspector";

afterEach(cleanup);

describe("transaction execution inspector", () => {
  it("presents boundary, lifecycle, authority, effects, variance, and proof without enabling disconnected actions", () => {
    render(<ExecutionInspector summary={summary()} />);
    expect(screen.getByRole("heading", { name: "Execution cell" })).toBeTruthy();
    expect(screen.getByText("Transaction isolation only")).toBeTruthy();
    expect(screen.getByText("Disposable worktree; not a security sandbox.")).toBeTruthy();
    expect(screen.getByRole("list", { name: "Execution cell lifecycle" }).textContent).toContain("Readycurrent");
    expect(screen.getByTitle("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa").textContent).toBe("aaaaaaaaaaaa");
    expect(screen.getByText("src/**")).toBeTruthy();
    expect(within(screen.getByRole("region", { name: "File effects" })).getByText("src/main.ts")).toBeTruthy();
    expect(screen.getByRole("alert").textContent).toContain("Undeclared write");
    expect(screen.getByText("Protected tests")).toBeTruthy();
    const commit = screen.getByRole("button", { name: "Commit result" }) as HTMLButtonElement;
    const rollback = screen.getByRole("button", { name: "Roll back" }) as HTMLButtonElement;
    expect(commit.disabled).toBe(true);
    expect(commit.title).toContain("not connected");
    expect(rollback.disabled).toBe(true);
  });

  it("enables only backend-connected actions that the summary marks available", async () => {
    const user = userEvent.setup();
    const commit = vi.fn();
    const rollback = vi.fn();
    render(<ExecutionInspector summary={summary({ variances: [] })} onCommit={commit} onRollback={rollback} />);
    await user.click(screen.getByRole("button", { name: "Commit result" }));
    await user.click(screen.getByRole("button", { name: "Roll back" }));
    expect(commit).toHaveBeenCalledOnce();
    expect(rollback).toHaveBeenCalledOnce();
  });

  it("announces terminal failure without presenting it as a completed lifecycle step", () => {
    render(<ExecutionInspector summary={summary({ state: "failed", variances: [], commit: { available: false, reason: "Blocking variance must be resolved." } })} />);
    expect(screen.getByRole("alert").textContent).toContain("Execution cell failed");
    expect(screen.queryByText("Committedcurrent")).toBeNull();
    expect((screen.getByRole("button", { name: "Commit result" }) as HTMLButtonElement).disabled).toBe(true);
  });
});

function summary(overrides: Partial<RunExecutionSummary> = {}): RunExecutionSummary {
  return {
    schemaVersion: 1,
    cellId: "cell-transaction-1",
    provider: "portable-worktree",
    securityBoundary: false,
    boundaryDescription: "Disposable worktree; not a security sandbox.",
    state: "ready_to_commit",
    baseRevision: "a".repeat(40),
    networkDefault: "deny",
    capabilities: { read: ["src/**"], write: ["src/main.ts"], delete: [], execute: ["npm"], network: [], secrets: [] },
    budget: { wallTimeMs: 60_000, cpuTimeMs: 30_000, memoryBytes: 512 * 1024 * 1024, diskBytes: 1024 * 1024 * 1024, processCount: 20, outputBytes: 1024 * 1024 },
    effects: [{ kind: "file.update", target: "src/main.ts", status: "changed" }],
    variances: [{ kind: "unexpected", severity: "blocking", effectTarget: "src/main.ts", detail: "Undeclared write" }],
    evidence: [{ kind: "test", name: "Protected tests", status: "passed", detail: "127 checks" }],
    commit: { available: true, reason: "All required evidence passed." },
    rollback: { available: true, reason: "Discard the portable cell." },
    updatedAt: "2026-07-11T10:00:00.000Z",
    ...overrides
  };
}

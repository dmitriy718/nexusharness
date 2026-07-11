import { afterEach, describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { RunExecutionCoordinator } from "../server/execution/runExecutionCoordinator";
import type { RunExecutionSummary, Settings } from "../server/types";

const execFileAsync = promisify(execFile);
const sandboxes: string[] = [];

afterEach(async () => {
  await Promise.all(sandboxes.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("run execution coordinator", () => {
  it("owns write, validation, proof, promotion, persistence, and teardown for one run cell", async () => {
    const fixture = await coordinatorFixture();
    const prepared = await fixture.coordinator.prepare();
    expect(prepared).toMatchObject({ state: "isolated", securityBoundary: false });
    expect(fixture.coordinator.boundaryDescription).toContain("not hostile-process or network isolation");

    await fixture.coordinator.write("generated.txt", "generated\n", { subtask: "Generate output" });
    await expect(access(join(fixture.root, "generated.txt"))).rejects.toThrow();
    expect(await fixture.coordinator.read("generated.txt")).toBe("generated\n");
    expect((await fixture.coordinator.list(".")).some((entry) => entry.name === "generated.txt")).toBe(true);
    await expect(fixture.coordinator.verify()).resolves.toMatchObject({ ready: false, reason: expect.stringContaining("validation command") });

    const validation = await fixture.coordinator.validate(commands().pass, { subtask: "Validate output" });
    expect(validation).toMatchObject({ receipt: { status: "succeeded", observedEffects: [] }, result: { code: 0 } });
    await expect(fixture.coordinator.verify()).resolves.toMatchObject({ ready: true });
    await expect(fixture.coordinator.commit()).resolves.toMatchObject({ receipt: { status: "committed" } });
    expect(await readFile(join(fixture.root, "generated.txt"), "utf8")).toBe("generated\n");
    const destroyed = await fixture.coordinator.destroy();
    expect(destroyed.state).toBe("destroyed");
    await expect(fixture.coordinator.prepare()).rejects.toThrow("cannot be prepared again");
    expect(fixture.publications.map((summary) => summary.state)).toEqual(expect.arrayContaining(["isolated", "executing", "verifying", "ready_to_commit", "committed", "destroyed"]));
    expect(new Set(fixture.publications.map((summary) => summary.cellId))).toEqual(new Set([fixture.coordinator.cellId]));
  });

  it("invalidates earlier validation when a later mutation occurs", async () => {
    const fixture = await coordinatorFixture();
    await fixture.coordinator.prepare();
    await fixture.coordinator.write("first.txt", "first\n");
    await fixture.coordinator.validate(commands().pass);
    await fixture.coordinator.write("second.txt", "second\n");

    await expect(fixture.coordinator.verify()).resolves.toMatchObject({ ready: false, reason: expect.stringContaining("validation command") });
    await expect(fixture.coordinator.commit()).rejects.toThrow("not eligible for promotion");
    await fixture.coordinator.rollback();
    await fixture.coordinator.destroy();
    await expect(access(join(fixture.root, "first.txt"))).rejects.toThrow();
    await expect(access(join(fixture.root, "second.txt"))).rejects.toThrow();
  });

  it("blocks promotion when validation creates an undeclared effect", async () => {
    const fixture = await coordinatorFixture();
    await fixture.coordinator.prepare();
    await fixture.coordinator.write("generated.txt", "generated\n");
    const validation = await fixture.coordinator.validate(commands().mutate);

    expect(validation).toMatchObject({ receipt: { status: "failed", variances: [{ kind: "unexpected", severity: "blocking", effectTarget: "validation-side-effect.txt" }] } });
    await expect(fixture.coordinator.verify()).resolves.toMatchObject({ ready: false });
    await expect(fixture.coordinator.commit()).rejects.toThrow("not eligible for promotion");
    await fixture.coordinator.rollback();
    await fixture.coordinator.destroy();
    await expect(access(join(fixture.root, "generated.txt"))).rejects.toThrow();
    await expect(access(join(fixture.root, "validation-side-effect.txt"))).rejects.toThrow();
  });

  it("requires every configured validation command after the latest mutation", async () => {
    const fixture = await coordinatorFixture({ validationCommands: [commands().pass, commands().passTwo] });
    await fixture.coordinator.prepare();
    await fixture.coordinator.write("generated.txt", "generated\n");
    await fixture.coordinator.validate(commands().pass);
    await expect(fixture.coordinator.verify()).resolves.toMatchObject({ ready: false, reason: expect.stringContaining("1 remaining") });
    await fixture.coordinator.validate(commands().passTwo);
    await expect(fixture.coordinator.verify()).resolves.toMatchObject({ ready: true });
    await fixture.coordinator.rollback();
    await fixture.coordinator.destroy();
  });

  it("deletes an existing regular file only after validation and promotion", async () => {
    const fixture = await coordinatorFixture();
    await fixture.coordinator.prepare();
    await fixture.coordinator.delete("delete-me.txt");
    expect(await readFile(join(fixture.root, "delete-me.txt"), "utf8")).toBe("delete me\n");
    await expect(fixture.coordinator.read("delete-me.txt")).rejects.toThrow();
    await fixture.coordinator.validate(commands().pass);
    await fixture.coordinator.commit();
    await expect(access(join(fixture.root, "delete-me.txt"))).rejects.toThrow();
    await fixture.coordinator.destroy();
  });

  it("releases interrupted admission so a later approved retry can proceed", async () => {
    let attempt = 0;
    const fixture = await coordinatorFixture({
      authorize: async () => {
        attempt += 1;
        if (attempt === 1) throw new Error("Approval required for file.write.");
      }
    });
    await fixture.coordinator.prepare();
    await expect(fixture.coordinator.write("approved.txt", "approved\n")).rejects.toThrow("Approval required");
    await expect(fixture.coordinator.write("approved.txt", "approved\n")).resolves.toMatchObject({ receipt: { status: "succeeded" } });
    await fixture.coordinator.validate(commands().pass);
    await fixture.coordinator.commit();
    expect(await readFile(join(fixture.root, "approved.txt"), "utf8")).toBe("approved\n");
    await fixture.coordinator.destroy();
  }, 20_000);

  it("rejects missing validation configuration and use before preparation", async () => {
    const fixture = await repository();
    const baseOptions = {
      runId: "run-1", settings: settings(fixture.root), dataRoot: fixture.data,
      brokerAudit: { append: async () => undefined }, persist: async () => undefined
    };
    expect(() => new RunExecutionCoordinator({ ...baseOptions, validationCommands: [] })).toThrow("at least one configured validation");
    expect(() => new RunExecutionCoordinator({ ...baseOptions, runId: " " })).toThrow("run identifier");
    const coordinator = new RunExecutionCoordinator({ ...baseOptions, validationCommands: [commands().pass] });
    await expect(coordinator.write("before.txt", "before\n")).rejects.toThrow("not prepared");
    await expect(coordinator.read("base.txt")).rejects.toThrow("not prepared");
  });

  it("tears down a prepared provider cell when initial lifecycle persistence fails", async () => {
    const fixture = await repository();
    const coordinator = new RunExecutionCoordinator({
      runId: "persistence-failure", settings: settings(fixture.root), dataRoot: fixture.data,
      validationCommands: [commands().pass], brokerAudit: { append: async () => undefined },
      authorize: async () => undefined, toolAudit: async () => undefined,
      persist: async () => { throw new Error("Persistence unavailable."); },
      now: () => new Date("2026-07-11T16:00:00.000Z"), id: () => "persistence-record"
    });
    await expect(coordinator.prepare()).rejects.toThrow("Persistence unavailable");
    await expect(access(join(fixture.data, "worktrees", coordinator.cellId))).rejects.toThrow();
    await expect(coordinator.prepare()).rejects.toThrow("cannot be prepared again");
  }, 20_000);
});

async function coordinatorFixture(overrides: { authorize?: () => Promise<void>; validationCommands?: string[] } = {}) {
  const fixture = await repository();
  const publications: RunExecutionSummary[] = [];
  let id = 0;
  const coordinator = new RunExecutionCoordinator({
    runId: "run-1",
    settings: settings(fixture.root),
    dataRoot: fixture.data,
    validationCommands: overrides.validationCommands ?? [commands().pass],
    additionalValidationCommands: [commands().mutate],
    authorize: overrides.authorize ?? (async () => undefined),
    toolAudit: async () => undefined,
    brokerAudit: { append: async () => undefined },
    persist: async (runId, summary) => {
      expect(runId).toBe("run-1");
      publications.push(structuredClone(summary));
    },
    now: (() => { let tick = 0; return () => new Date(`2026-07-11T16:00:${String(tick++).padStart(2, "0")}.000Z`); })(),
    id: () => `coordinator-${++id}`
  });
  return { ...fixture, coordinator, publications };
}

async function repository() {
  const sandbox = await mkdtemp(join(tmpdir(), "nexus-run-coordinator-"));
  sandboxes.push(sandbox);
  const root = join(sandbox, "repository");
  const data = join(sandbox, "cells");
  await mkdir(root);
  await git(root, ["init", "-b", "main"]);
  await git(root, ["config", "user.name", "Coordinator Test"]);
  await git(root, ["config", "user.email", "coordinator@example.invalid"]);
  await writeFile(join(root, "base.txt"), "base\n", "utf8");
  await writeFile(join(root, "delete-me.txt"), "delete me\n", "utf8");
  await git(root, ["add", "."]);
  await git(root, ["commit", "-m", "base"]);
  return { sandbox, root, data };
}

function commands() {
  return process.platform === "win32"
    ? {
        pass: "Get-Content -LiteralPath 'base.txt' | Out-Null",
        passTwo: "Get-Item -LiteralPath 'delete-me.txt' | Out-Null",
        mutate: "Set-Content -LiteralPath 'validation-side-effect.txt' -Value 'unexpected' -Encoding UTF8"
      }
    : {
        pass: "test -f base.txt",
        passTwo: "test -f delete-me.txt",
        mutate: "printf 'unexpected\\n' > validation-side-effect.txt"
      };
}

function settings(workspaceRoot: string): Settings {
  return {
    workspaceRoot, layout: "chat", maxIterations: 2, maxParallelExecutors: 1, criticThreshold: 7, approvalMode: true,
    shellPath: process.platform === "win32" ? "powershell.exe" : "/bin/sh", testCommand: commands().pass, lintCommand: "",
    mcpAutoDiscovery: false, mcpPortStart: 3000, mcpPortEnd: 3001, memoryTokenBudget: 100, agentModels: {}
  };
}

async function git(cwd: string, args: string[]) {
  const result = await execFileAsync("git", args, { cwd, windowsHide: true });
  return result.stdout.trim();
}

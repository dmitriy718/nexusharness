import { describe, expect, it } from "vitest";
import type { Approval } from "../src/api/types";
import {
  approvalCommand,
  approvalDiff,
  approvalTarget,
  humanApprovalAction,
  parseDiff,
  redactPayload
} from "../src/features/approvals/approvalModel";

function approval(payload: unknown): Approval {
  return {
    id: "approval-1",
    createdAt: "2026-07-11T00:00:00.000Z",
    actor: "executor",
    action: "file.write",
    risk: "write",
    payload,
    runId: "run-1",
    subtask: "Update navigation",
    decision: "pending"
  };
}

describe("approval presentation", () => {
  it("extracts file and command targets from real payload shapes", () => {
    expect(approvalTarget(approval({ relativePath: "src/App.tsx" }))).toBe("src/App.tsx");
    expect(approvalTarget(approval({ cwd: "D:\\projects\\nexus" }))).toBe("D:\\projects\\nexus");
    expect(approvalCommand(approval({ command: "npm test" }))).toBe("npm test");
  });

  it("formats machine action names for operators", () => {
    expect(humanApprovalAction("tool.shell_exec")).toBe("Tool Shell Exec");
  });

  it("classifies unified diff lines", () => {
    const lines = parseDiff("--- a\n+++ b\n@@ -1 +1 @@\n-old\n+new\n same");
    expect(lines.map((line) => line.kind)).toEqual(["header", "header", "header", "deletion", "addition", "context"]);
    expect(approvalDiff(approval({ diff: "+new" }))).toBe("+new");
  });

  it("redacts nested credential-like fields from raw review", () => {
    expect(redactPayload({ command: "run", token: "sensitive", nested: { apiKey: "secret" } })).toEqual({
      command: "run",
      token: "[redacted]",
      nested: { apiKey: "[redacted]" }
    });
  });
});

import { describe, expect, it } from "vitest";
import { formatBytes, parentWorkspacePath, previewLines, runDraftForPath, workspaceBreadcrumbs } from "../src/features/workspace/workspaceModel";

describe("workspace presentation model", () => {
  it("formats file sizes without false precision", () => {
    expect(formatBytes(900)).toBe("900 B");
    expect(formatBytes(1536)).toBe("1.5 KB");
    expect(formatBytes(2 * 1024 * 1024)).toBe("2.0 MB");
  });

  it("builds normalized breadcrumb paths for both slash styles", () => {
    expect(workspaceBreadcrumbs("src\\features/workspace")).toEqual([
      { name: "Workspace", path: "." },
      { name: "src", path: "src" },
      { name: "features", path: "src/features" },
      { name: "workspace", path: "src/features/workspace" }
    ]);
  });

  it("reveals safe relative parents", () => {
    expect(parentWorkspacePath("src/features/App.tsx")).toBe("src/features");
    expect(parentWorkspacePath("README.md")).toBe(".");
  });

  it("creates an explicit contextual draft without pretending to attach content", () => {
    expect(runDraftForPath("src/App.tsx")).toContain("workspace file `src/App.tsx`");
    expect(runDraftForPath("src/App.tsx")).toContain("Objective:");
  });

  it("numbers and bounds preview rendering", () => {
    expect(previewLines("one\ntwo\nthree", 2)).toEqual([{ number: 1, text: "one" }, { number: 2, text: "two" }]);
  });
});

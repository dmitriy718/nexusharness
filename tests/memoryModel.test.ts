import { describe, expect, it } from "vitest";
import type { MemoryEntry } from "../src/api/types";
import { filterMemory, memoryExcerpt, memoryFacets, memoryPayload } from "../src/features/memory/memoryModel";

const entries: MemoryEntry[] = [
  { id: "1", kind: "context", taskType: "frontend", title: "Design tokens", content: "Use Midnight Prism", pinned: false, source: "operator", createdAt: "2026-07-10T00:00:00Z", updatedAt: "2026-07-10T01:00:00Z" },
  { id: "2", kind: "retrospective", taskType: "debugging", title: "Fix outcome", content: "Validation caught overflow", pinned: true, source: "run:2", createdAt: "2026-07-11T00:00:00Z", updatedAt: "2026-07-11T01:00:00Z" },
  { id: "3", kind: "snippet", taskType: "frontend", title: "Command", content: "npm run build", pinned: false, source: "operator", createdAt: "2026-07-09T00:00:00Z", updatedAt: "2026-07-12T00:00:00Z" }
];

describe("memory management model", () => {
  it("combines search/facets and keeps pinned entries first", () => {
    expect(filterMemory(entries, { query: "overflow", kind: "all", taskType: "all", source: "all", sort: "updated" }).map((item) => item.id)).toEqual(["2"]);
    expect(filterMemory(entries, { query: "", kind: "all", taskType: "frontend", source: "operator", sort: "updated" }).map((item) => item.id)).toEqual(["3", "1"]);
    expect(filterMemory(entries, { query: "", kind: "all", taskType: "all", source: "all", sort: "title" })[0].id).toBe("2");
  });

  it("derives stable task/source facets", () => {
    expect(memoryFacets(entries)).toEqual({ taskTypes: ["debugging", "frontend"], sources: ["operator", "run:2"] });
  });

  it("creates compact readable excerpts", () => {
    expect(memoryExcerpt("  many\n\n spaces here  ")).toBe("many spaces here");
    expect(memoryExcerpt("abcdefgh", 5)).toBe("abcde…");
  });

  it("removes server fields and trims form metadata for save/undo", () => {
    expect(memoryPayload({ ...entries[0], taskType: " frontend ", title: " Tokens ", source: " operator " })).toEqual({ kind: "context", taskType: "frontend", title: "Tokens", content: "Use Midnight Prism", pinned: false, source: "operator" });
  });
});

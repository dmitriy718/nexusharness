import type { MemoryEntry } from "../../api/types";

export type MemorySort = "updated" | "created" | "title";
export type MemoryFilters = { query: string; kind: string; taskType: string; source: string; sort: MemorySort };

export function filterMemory(entries: MemoryEntry[], filters: MemoryFilters): MemoryEntry[] {
  const query = filters.query.trim().toLowerCase();
  return [...entries].filter((item) => {
    const haystack = [item.title, item.taskType, item.content, item.source, item.kind].join(" ").toLowerCase();
    return (!query || haystack.includes(query))
      && (filters.kind === "all" || item.kind === filters.kind)
      && (filters.taskType === "all" || item.taskType === filters.taskType)
      && (filters.source === "all" || (item.source || "unknown") === filters.source);
  }).sort((left, right) => {
    if (left.pinned !== right.pinned) return Number(right.pinned) - Number(left.pinned);
    if (filters.sort === "title") return left.title.localeCompare(right.title);
    const leftDate = filters.sort === "created" ? left.createdAt : left.updatedAt ?? left.createdAt;
    const rightDate = filters.sort === "created" ? right.createdAt : right.updatedAt ?? right.createdAt;
    return String(rightDate ?? "").localeCompare(String(leftDate ?? ""));
  });
}

export function memoryFacets(entries: MemoryEntry[]) {
  return {
    taskTypes: [...new Set(entries.map((item) => item.taskType).filter(Boolean))].sort(),
    sources: [...new Set(entries.map((item) => item.source || "unknown"))].sort()
  };
}

export function memoryExcerpt(content: string, limit = 220): string {
  const normalized = content.replace(/\s+/g, " ").trim();
  return normalized.length > limit ? `${normalized.slice(0, limit).trimEnd()}…` : normalized;
}

export function memoryPayload(entry: MemoryEntry) {
  return { kind: entry.kind, taskType: entry.taskType.trim(), title: entry.title.trim(), content: entry.content, pinned: entry.pinned, source: entry.source?.trim() || undefined };
}

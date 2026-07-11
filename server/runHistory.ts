import { z } from "zod";
import type { TaskRun } from "./types.js";

const statuses = ["all", "running", "waiting_approval", "passed", "failed", "canceled"] as const;
const querySchema = z.object({
  offset: z.coerce.number().int().min(0).max(10_000_000).default(0),
  limit: z.coerce.number().int().min(1).max(100).default(100),
  query: z.string().trim().max(20_000).default(""),
  status: z.enum(statuses).default("all")
});

export type RunHistoryQuery = z.infer<typeof querySchema>;
export type RunHistoryPage = { items: TaskRun[]; total: number; offset: number; limit: number; hasMore: boolean };

export function parseRunHistoryQuery(input: Record<string, unknown>): RunHistoryQuery {
  const first = (value: unknown) => Array.isArray(value) ? value[0] : value;
  return querySchema.parse({
    offset: first(input.offset),
    limit: first(input.limit),
    query: first(input.query),
    status: first(input.status)
  });
}

export function runHistoryPage(runs: TaskRun[], query: RunHistoryQuery): RunHistoryPage {
  const needle = query.query.toLowerCase();
  const matching = runs.filter((run) => {
    const matchesText = !needle || run.task.toLowerCase().includes(needle) || run.id.toLowerCase().includes(needle);
    return matchesText && (query.status === "all" || run.status === query.status);
  });
  const items = matching.slice(query.offset, query.offset + query.limit);
  return { items, total: matching.length, offset: query.offset, limit: query.limit, hasMore: query.offset + items.length < matching.length };
}

import { describe, expect, it } from "vitest";
import { ApiError } from "../src/api/client";
import { failureDetails, freshnessLabel } from "../src/features/feedback/feedbackModel";
import { stabilizeStore } from "../src/features/feedback/feedbackModel";
import type { Store } from "../src/api/types";

describe("operational feedback model", () => {
  it("turns structured validation arrays into field-oriented prose", () => {
    const detail = failureDetails(new ApiError("raw", 400, { error: [{ path: ["mcpPortStart"], message: "Start must precede end" }] }));
    expect(detail).toMatchObject({ category: "validation", retryable: false, message: "mcpPortStart: Start must precede end" });
  });

  it("distinguishes conflicts, absence, and service failures", () => {
    expect(failureDetails(new ApiError("conflict", 409, { error: "Already decided" }))).toMatchObject({ category: "conflict", retryable: true });
    expect(failureDetails(new ApiError("missing", 404, { error: "Not found" }))).toMatchObject({ category: "not_found", retryable: false });
    expect(failureDetails(new ApiError("down", 503, { error: "Unavailable" }))).toMatchObject({ category: "connection", retryable: true });
  });

  it("recognizes browser fetch failures as connection errors", () => {
    expect(failureDetails(new TypeError("Failed to fetch"))).toMatchObject({ category: "connection", title: "Local API connection lost" });
  });

  it("labels live freshness without implying false precision", () => {
    const now = Date.parse("2026-07-11T08:00:30Z");
    expect(freshnessLabel("2026-07-11T08:00:28Z", now)).toBe("Updated now");
    expect(freshnessLabel("2026-07-11T08:00:10Z", now)).toBe("Updated 20s ago");
    expect(freshnessLabel("2026-07-11T07:58:00Z", now)).toBe("Updated 2m ago");
  });

  it("preserves unchanged store slice references across compact polls", () => {
    const previous = { settings: { approvalMode: true }, runtimes: [], mcpServers: [], memory: [], audit: [], approvals: [], runs: [] } as unknown as Store;
    const identical = structuredClone(previous);
    expect(stabilizeStore(previous, identical)).toBe(previous);
    const next = { ...structuredClone(previous), audit: [{ id: "event" }] } as unknown as Store;
    const stable = stabilizeStore(previous, next);
    expect(stable).not.toBe(previous);
    expect(stable.settings).toBe(previous.settings);
    expect(stable.runtimes).toBe(previous.runtimes);
    expect(stable.audit).not.toBe(previous.audit);
  });
});

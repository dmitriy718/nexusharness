import { describe, expect, it } from "vitest";
import {
  ContractCapabilityBroker,
  InMemoryLeaseUseStore,
  InMemoryReceiptChainStore,
  compareEffects,
  type BrokerAuditRecord,
  type BrokerMode,
  type EffectObservation,
  type PolicyDecision
} from "../server/execution/broker";
import { executionDigest, type ObservedEffect } from "../server/execution/contracts";

const issuedAt = "2026-07-11T10:00:00.000Z";
const expiresAt = "2026-07-11T11:00:00.000Z";
const digestA = `sha256:${"a".repeat(64)}`;
const digestB = `sha256:${"b".repeat(64)}`;

describe("contract capability broker", () => {
  it("executes an allowed contract once and records a redacted chained receipt", async () => {
    const fixture = broker();
    const receipt = await fixture.instance.execute(contract(), lease(), fixture.operation);

    expect(receipt.status).toBe("succeeded");
    expect(receipt.observedEffects).toEqual([effect()]);
    expect(receipt.outputDigest).toBe(executionDigest({ result: "passed" }));
    expect(receipt.evidence).toEqual([expect.objectContaining({ kind: "policy", status: "passed" })]);
    expect(fixture.operationCalls()).toBe(1);
    expect(fixture.audit).toEqual([expect.objectContaining({ mode: "enforced", action: "shell.exec", status: "succeeded", observedEffectCount: 1 })]);
    expect(JSON.stringify(fixture.audit)).not.toContain("npm test");
  });

  it("blocks a policy denial without executing or consuming the lease", async () => {
    const decisions = [policy(false), policy(true)];
    const fixture = broker({ policy: async () => decisions.shift()! });
    expect((await fixture.instance.execute(contract(), lease(), fixture.operation)).status).toBe("blocked");
    expect(fixture.operationCalls()).toBe(0);
    expect((await fixture.instance.execute(contract(), lease(), fixture.operation)).status).toBe("succeeded");
    expect(fixture.operationCalls()).toBe(1);
  });

  it("blocks a policy decision made under a different policy version", async () => {
    const fixture = broker({ policy: async () => ({ ...policy(true), policyVersion: "policy-v2" }) });
    const receipt = await fixture.instance.execute(contract(), lease(), fixture.operation);
    expect(receipt.status).toBe("blocked");
    expect(receipt.variances[0]?.detail).toContain("does not match lease policy");
    expect(fixture.operationCalls()).toBe(0);
  });

  it("fails a policy-evaluator outage closed without consuming authority", async () => {
    let available = false;
    const fixture = broker({ policy: async () => {
      if (!available) throw new Error("internal policy service details");
      return policy(true);
    } });
    const blocked = await fixture.instance.execute(contract(), lease(), fixture.operation);
    expect(blocked.status).toBe("blocked");
    expect(blocked.variances[0]?.detail).toBe("Policy evaluation failed closed.");
    expect(JSON.stringify(blocked)).not.toContain("internal policy service details");
    available = true;
    expect((await fixture.instance.execute(contract(), lease(), fixture.operation)).status).toBe("succeeded");
    expect(fixture.operationCalls()).toBe(1);
  });

  it("atomically blocks a second use of a single-use lease", async () => {
    const fixture = broker();
    expect((await fixture.instance.execute(contract(), lease(), fixture.operation)).status).toBe("succeeded");
    const repeated = await fixture.instance.execute(contract(), lease(), fixture.operation);
    expect(repeated.status).toBe("blocked");
    expect(repeated.variances[0]?.effectTarget).toBe("lease");
    expect(fixture.operationCalls()).toBe(1);
  });

  it("admits exactly one of two concurrent operations sharing one lease", async () => {
    const fixture = broker();
    const receipts = await Promise.all([
      fixture.instance.execute(contract({ id: "concurrent-a" }), lease(), fixture.operation),
      fixture.instance.execute(contract({ id: "concurrent-b" }), lease(), fixture.operation)
    ]);
    expect(receipts.map((receipt) => receipt.status).sort()).toEqual(["blocked", "succeeded"]);
    expect(fixture.operationCalls()).toBe(1);
  });

  it("chains successive receipts inside one cell", async () => {
    const fixture = broker();
    const first = await fixture.instance.execute(contract(), lease(), fixture.operation);
    const second = await fixture.instance.execute(contract({ id: "action-2", leaseId: "lease-2" }), lease({ id: "lease-2" }), fixture.operation);
    expect(first.previousReceiptDigest).toBeUndefined();
    expect(second.previousReceiptDigest).toBe(executionDigest(first));
  });

  it("fails on missing, forbidden, unexpected, and digest-mismatched effects", async () => {
    const variants: Array<{ effects: ObservedEffect[]; expectedKind: string }> = [
      { effects: [], expectedKind: "missing" },
      { effects: [effect({ kind: "git.ref", target: "refs/heads/main" })], expectedKind: "forbidden" },
      { effects: [effect(), effect({ kind: "file.update", target: "src/main.ts" })], expectedKind: "unexpected" },
      { effects: [effect({ afterDigest: digestB })], expectedKind: "mismatch" }
    ];
    for (const [index, variant] of variants.entries()) {
      const fixture = broker({ effects: variant.effects });
      const receipt = await fixture.instance.execute(contract({ id: `action-${index}`, leaseId: `lease-${index}` }), lease({ id: `lease-${index}` }), fixture.operation);
      expect(receipt.status).toBe("failed");
      expect(receipt.variances.map((item) => item.kind)).toContain(variant.expectedKind);
    }
  });

  it("treats blocked and unchanged observations as non-material", () => {
    const variances = compareEffects(
      [{ kind: "artifact.create", target: "coverage/**", required: true, description: "Coverage" }],
      [{ kind: "git.ref", target: "refs/**", required: true, description: "No refs" }],
      [effect({ status: "unchanged" }), effect({ kind: "git.ref", target: "refs/heads/main", status: "blocked" })]
    );
    expect(variances).toEqual([expect.objectContaining({ kind: "missing" })]);
  });

  it("uses path-aware wildcard matching", () => {
    expect(compareEffects(
      [{ kind: "file.update", target: "src/**", required: true, description: "Sources" }],
      [],
      [effect({ kind: "file.update", target: "src/features/run.ts" })]
    )).toEqual([]);
    expect(compareEffects(
      [{ kind: "file.update", target: "src/*.ts", required: true, description: "Top-level source" }],
      [],
      [effect({ kind: "file.update", target: "src/features/run.ts" })]
    ).map((item) => item.kind)).toEqual(["missing", "unexpected"]);
  });

  it("records an operation failure by digest without retaining raw error content", async () => {
    const rawError = "secret-token-123";
    const fixture = broker({ outcome: { status: "failed", errorDigest: executionDigest({ error: rawError }) } });
    const receipt = await fixture.instance.execute(contract(), lease(), fixture.operation);
    expect(receipt.status).toBe("failed");
    expect(receipt.evidence).toEqual(expect.arrayContaining([expect.objectContaining({ name: "Operation result", status: "failed" })]));
    expect(JSON.stringify(receipt)).not.toContain(rawError);
  });

  it("records an observer crash as a failed receipt without leaking its error", async () => {
    const fixture = broker({ observerError: new Error("observer secret-token-456") });
    const receipt = await fixture.instance.execute(contract(), lease(), fixture.operation);
    expect(receipt.status).toBe("failed");
    expect(receipt.variances.map((item) => item.kind)).toContain("missing");
    expect(JSON.stringify(receipt)).not.toContain("secret-token-456");
  });

  it("fails closed when successful operation output is not canonical JSON", async () => {
    const fixture = broker({ value: { invalid: undefined } });
    const receipt = await fixture.instance.execute(contract(), lease(), fixture.operation);
    expect(receipt.status).toBe("failed");
    expect(receipt.variances).toContainEqual(expect.objectContaining({ effectTarget: "operation.output" }));
  });

  it("rejects expired and over-broad authority before policy or operation", async () => {
    const fixture = broker({ now: new Date(expiresAt) });
    await expect(fixture.instance.execute(contract(), lease(), fixture.operation)).rejects.toThrow("expired");
    expect(fixture.operationCalls()).toBe(0);

    const fresh = broker();
    await expect(fresh.instance.execute(contract(), lease({ capabilities: { ...capabilities(), execute: [] } }), fresh.operation)).rejects.toThrow("outside its lease");
    expect(fresh.operationCalls()).toBe(0);
  });

  it("makes compatibility mode explicit in every audit record", async () => {
    const fixture = broker({ mode: "compatibility" });
    await fixture.instance.execute(contract(), lease(), fixture.operation);
    expect(fixture.audit[0]?.mode).toBe("compatibility");
  });

  it("does not accept model-reported effects through the operation result", async () => {
    const fixture = broker({ value: { effects: [effect({ kind: "git.ref", target: "refs/heads/main" })] }, effects: [effect()] });
    const receipt = await fixture.instance.execute(contract(), lease(), fixture.operation);
    expect(receipt.status).toBe("succeeded");
    expect(receipt.observedEffects).toEqual([effect()]);
    expect(receipt.observedEffects).not.toEqual((fixture.value() as { effects: ObservedEffect[] }).effects);
  });
});

function broker(options: {
  mode?: BrokerMode;
  effects?: ObservedEffect[];
  outcome?: EffectObservation<unknown>["outcome"];
  value?: unknown;
  now?: Date;
  policy?: () => Promise<PolicyDecision>;
  observerError?: Error;
} = {}) {
  let calls = 0;
  let id = 0;
  const audit: BrokerAuditRecord[] = [];
  const value = options.value ?? { result: "passed" };
  const operation = async () => { calls += 1; return value; };
  const observer = {
    async observe<T>(_cellId: string, execute: () => Promise<T>): Promise<EffectObservation<T>> {
      if (options.observerError) throw options.observerError;
      if (options.outcome?.status === "failed") {
        calls += 1;
        return { outcome: options.outcome, effects: options.effects ?? [effect()] };
      }
      return { outcome: { status: "succeeded", value: await execute() }, effects: options.effects ?? [effect()] };
    }
  };
  const instance = new ContractCapabilityBroker({
    mode: options.mode ?? "enforced",
    policy: { evaluate: options.policy ?? (async () => policy(true)) },
    observer,
    leases: new InMemoryLeaseUseStore(),
    receipts: new InMemoryReceiptChainStore(),
    audit: { async append(record) { audit.push(record); } },
    now: () => options.now ?? new Date(calls ? "2026-07-11T10:00:01.000Z" : issuedAt),
    id: () => `receipt-${++id}`
  });
  return { instance, audit, operation, operationCalls: () => calls, value: () => value };
}

function policy(allowed: boolean): PolicyDecision {
  return { allowed, policyVersion: "policy-v1", reason: allowed ? "Contract is within policy." : "Contract is denied by policy.", evidenceDigest: digestA };
}

function capabilities() {
  return { read: ["src/**"], write: [], delete: [], execute: ["npm"], network: [], secrets: [] };
}

function contract(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: 1,
    id: "action-1",
    objectiveId: "objective-1",
    cellId: "cell-1",
    leaseId: "lease-1",
    issuedAt,
    expiresAt,
    purpose: "Run tests without changing tracked source files.",
    action: { kind: "shell.exec", risk: "execute", payloadDigest: digestA },
    capabilities: capabilities(),
    requires: [{ kind: "execute", value: "npm" }],
    preconditions: ["Lockfile matches the base revision."],
    expectedEffects: [{ kind: "artifact.create", target: "coverage/**", required: true, expectedDigest: digestA, description: "Coverage output" }],
    forbiddenEffects: [{ kind: "git.ref", target: "refs/**", required: true, description: "Git refs remain unchanged" }],
    invariants: ["Tracked source files remain unchanged."],
    successEvidence: ["Tests pass."],
    rollback: { kind: "discard_cell", description: "Discard the cell." },
    ...overrides
  };
}

function lease(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: 1,
    id: "lease-1",
    objectiveId: "objective-1",
    cellId: "cell-1",
    issuedAt,
    expiresAt,
    singleUse: true,
    status: "active",
    capabilities: capabilities(),
    policyVersion: "policy-v1",
    ...overrides
  };
}

function effect(overrides: Partial<ObservedEffect> = {}): ObservedEffect {
  return {
    kind: "artifact.create",
    target: "coverage/report.json",
    status: "created",
    observedAt: "2026-07-11T10:00:00.500Z",
    afterDigest: digestA,
    ...overrides
  };
}

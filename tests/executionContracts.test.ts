import { describe, expect, it } from "vitest";
import {
  EXECUTION_SCHEMA_VERSION,
  actionReceiptSchema,
  assertCellTransition,
  authorizeContract,
  canTransitionCell,
  capabilityEnvelopeSchema,
  capabilityLeaseSchema,
  canonicalJson,
  cellSnapshotSchema,
  cellSpecSchema,
  commitReceiptSchema,
  contractedActionSchema,
  effectSetSchema,
  executionCellSchema,
  executionDigest,
  objectiveSchema,
  parseCapabilityLease,
  parseContractedAction,
  repositoryScopeSchema
} from "../server/execution/contracts";

const issuedAt = "2026-07-11T10:00:00.000Z";
const expiresAt = "2026-07-11T11:00:00.000Z";
const digest = `sha256:${"a".repeat(64)}`;

describe("execution contract foundation", () => {
  it("normalizes bounded capability sets into deterministic envelopes", () => {
    expect(capabilityEnvelopeSchema.parse({
      read: ["src\\**", "src/**"],
      write: ["dist/**"],
      delete: [],
      execute: ["npm", "node", "npm"],
      network: ["https://example.com/", "https://example.com"],
      secrets: ["registry/npm"]
    })).toEqual({
      read: ["src/**"],
      write: ["dist/**"],
      delete: [],
      execute: ["node", "npm"],
      network: ["https://example.com"],
      secrets: ["registry/npm"]
    });
  });

  it.each(["not-a-url", "file:///tmp/data", "https://user:secret@example.com", "https://example.com/path", "https://example.com/?query=1"])(
    "returns a validation failure for unsafe network origin %s",
    (origin) => {
      expect(() => capabilityEnvelopeSchema.safeParse({ network: [origin] })).not.toThrow();
      expect(capabilityEnvelopeSchema.safeParse({ network: [origin] }).success).toBe(false);
    }
  );

  it.each([
    "../secret", "src/../../secret", "/etc/passwd", "C:\\Users\\operator", "\\\\server\\share", "src/\0secret", "src/\nsecret"
  ])("rejects unsafe repository scope %s", (scope) => {
    expect(repositoryScopeSchema.safeParse(scope).success).toBe(false);
  });

  it("requires declared capabilities that match the action risk", () => {
    expect(contractedActionSchema.parse(contract())).toMatchObject({ schemaVersion: 1, action: { risk: "execute" } });
    expect(contractedActionSchema.safeParse(contract({
      requires: [{ kind: "execute", value: "powershell" }]
    })).success).toBe(false);
    expect(contractedActionSchema.safeParse(contract({
      action: { kind: "file.write", risk: "write", payloadDigest: digest },
      requires: [{ kind: "read", value: "src/**" }]
    })).success).toBe(false);
  });

  it("rejects unsupported schema versions and unknown contract fields", () => {
    expect(contractedActionSchema.safeParse({ ...contract(), schemaVersion: 2 }).success).toBe(false);
    expect(contractedActionSchema.safeParse({ ...contract(), ambientAuthority: true }).success).toBe(false);
  });

  it("rejects expired, used, revoked, and internally invalid leases", () => {
    expect(() => parseCapabilityLease(lease(), new Date("2026-07-11T10:30:00.000Z"))).not.toThrow();
    expect(() => parseCapabilityLease(lease(), new Date(expiresAt))).toThrow("expired");
    expect(() => parseCapabilityLease(lease({ status: "used" }), new Date("2026-07-11T10:30:00.000Z"))).toThrow("used");
    expect(() => parseCapabilityLease(lease({ status: "revoked" }), new Date("2026-07-11T10:30:00.000Z"))).toThrow("revoked");
    expect(capabilityLeaseSchema.safeParse(lease({ expiresAt: issuedAt })).success).toBe(false);
  });

  it("rejects expired action contracts at the execution boundary", () => {
    expect(() => parseContractedAction(contract(), new Date("2026-07-11T10:30:00.000Z"))).not.toThrow();
    expect(() => parseContractedAction(contract(), new Date(expiresAt))).toThrow("expired");
  });

  it("binds a contract to one active lease, objective, cell, expiry, and capability subset", () => {
    const authorization = authorizeContract(contract(), lease(), new Date("2026-07-11T10:30:00.000Z"));
    expect(authorization.contractDigest).toMatch(/^sha256:/);
    expect(authorization.leaseDigest).toMatch(/^sha256:/);
    expect(() => authorizeContract(contract({ leaseId: "lease-2" }), lease(), new Date("2026-07-11T10:30:00.000Z"))).toThrow("different capability lease");
    expect(() => authorizeContract(contract({ objectiveId: "objective-2" }), lease(), new Date("2026-07-11T10:30:00.000Z"))).toThrow("different objectives");
    expect(() => authorizeContract(contract({ cellId: "cell-2" }), lease(), new Date("2026-07-11T10:30:00.000Z"))).toThrow("different execution cells");
    expect(() => authorizeContract(contract(), lease({ expiresAt: "2026-07-11T10:45:00.000Z" }), new Date("2026-07-11T10:30:00.000Z"))).toThrow("outlives");
    expect(() => authorizeContract(contract(), lease({ capabilities: { ...capabilities(), execute: [] } }), new Date("2026-07-11T10:30:00.000Z"))).toThrow("outside its lease");
  });

  it("produces stable canonical digests independent of object key order", () => {
    const first = { zebra: [3, 2, 1], alpha: { two: true, one: "value" } };
    const second = { alpha: { one: "value", two: true }, zebra: [3, 2, 1] };
    expect(canonicalJson(first)).toBe('{"alpha":{"one":"value","two":true},"zebra":[3,2,1]}');
    expect(executionDigest(first)).toBe(executionDigest(second));
    expect(executionDigest(first)).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(executionDigest({ ...first, zebra: [1, 2, 3] })).not.toBe(executionDigest(first));
  });

  it("rejects ambiguous or non-JSON canonical values", () => {
    expect(() => canonicalJson({ value: undefined })).toThrow("undefined");
    expect(() => canonicalJson({ value: Number.NaN })).toThrow("non-finite");
    expect(() => canonicalJson(new Date())).toThrow("plain JSON objects");
    expect(canonicalJson({ value: -0 })).toBe('{"value":0}');
  });

  it("enforces finite cell lifecycle transitions", () => {
    expect(canTransitionCell("preparing", "isolated")).toBe(true);
    expect(canTransitionCell("executing", "verifying")).toBe(true);
    expect(canTransitionCell("verifying", "executing")).toBe(true);
    expect(canTransitionCell("ready_to_commit", "committed")).toBe(true);
    expect(canTransitionCell("destroyed", "preparing")).toBe(false);
    expect(() => assertCellTransition("isolated", "committed")).toThrow("isolated -> committed");
  });

  it("requires deny-by-default networking and bounded cell resources", () => {
    const spec = cellSpec();
    expect(cellSpecSchema.parse(spec).networkDefault).toBe("deny");
    expect(cellSpecSchema.safeParse({ ...spec, networkDefault: "allow" }).success).toBe(false);
    expect(cellSpecSchema.safeParse({ ...spec, budget: { ...spec.budget, processCount: 0 } }).success).toBe(false);
  });

  it("validates objective, live cell, snapshot, and effect-set records independently of a provider", () => {
    expect(objectiveSchema.parse({
      schemaVersion: 1,
      id: "objective-1",
      title: "Verify contracts",
      description: "Build a provider-neutral execution contract model.",
      constraints: ["Do not mutate a live workspace."],
      createdAt: issuedAt
    }).id).toBe("objective-1");
    expect(executionCellSchema.parse({
      schemaVersion: 1,
      id: "cell-1",
      specDigest: digest,
      provider: "portable-worktree",
      providerRef: "harness/cells/cell-1",
      baseRevision: "a".repeat(40),
      state: "isolated",
      preparedAt: issuedAt,
      updatedAt: issuedAt
    }).state).toBe("isolated");
    expect(cellSnapshotSchema.parse({
      schemaVersion: 1,
      id: "snapshot-1",
      cellId: "cell-1",
      state: "isolated",
      reason: "Before contracted execution.",
      stateDigest: digest,
      createdAt: issuedAt
    }).stateDigest).toBe(digest);
    expect(effectSetSchema.parse({
      schemaVersion: 1,
      cellId: "cell-1",
      baseRevision: "a".repeat(40),
      capturedAt: issuedAt,
      effects: [{ kind: "file.update", target: "src/main.ts", status: "changed", observedAt: issuedAt, beforeDigest: digest, afterDigest: `sha256:${"b".repeat(64)}` }],
      effectsDigest: digest
    }).effects).toHaveLength(1);
    expect(executionCellSchema.safeParse({
      schemaVersion: 1,
      id: "cell-1",
      specDigest: digest,
      provider: "portable-worktree",
      providerRef: "harness/cells/cell-1",
      baseRevision: "a".repeat(40),
      state: "isolated",
      preparedAt: issuedAt,
      updatedAt: "2026-07-11T09:59:59.000Z"
    }).success).toBe(false);
  });

  it("rejects unsafe file effect targets", () => {
    expect(contractedActionSchema.safeParse(contract({
      expectedEffects: [{ kind: "file.update", target: "../outside", description: "Unsafe write" }]
    })).success).toBe(false);
  });

  it("prevents successful receipts from hiding blocking effect variance", () => {
    const receipt = actionReceipt();
    expect(actionReceiptSchema.parse(receipt).status).toBe("succeeded");
    expect(actionReceiptSchema.safeParse({
      ...receipt,
      variances: [{ kind: "unexpected", severity: "blocking", effectTarget: "src/main.ts", detail: "Undeclared write" }]
    }).success).toBe(false);
    expect(actionReceiptSchema.safeParse({ ...receipt, completedAt: "2026-07-11T09:59:59.000Z" }).success).toBe(false);
  });

  it("rejects stale or internally contradictory commit receipts", () => {
    const base = "a".repeat(40);
    const valid = commitReceipt(base);
    expect(commitReceiptSchema.parse(valid).status).toBe("committed");
    expect(commitReceiptSchema.safeParse({ ...valid, actualBase: "b".repeat(40) }).success).toBe(false);
    expect(commitReceiptSchema.safeParse({ ...valid, resultingRevision: undefined }).success).toBe(false);
    expect(commitReceiptSchema.safeParse({ ...valid, status: "rejected" }).success).toBe(false);
    expect(commitReceiptSchema.parse({ ...valid, status: "rejected", actualBase: "b".repeat(40), resultingRevision: undefined }).status).toBe("rejected");
  });

  it("uses explicit schema v1 across leases, cells, actions, and receipts", () => {
    expect(EXECUTION_SCHEMA_VERSION).toBe(1);
    expect(lease().schemaVersion).toBe(1);
    expect(cellSpec().schemaVersion).toBe(1);
    expect(contract().schemaVersion).toBe(1);
    expect(actionReceipt().schemaVersion).toBe(1);
  });
});

function capabilities() {
  return {
    read: ["src/**"],
    write: ["coverage/**"],
    delete: [],
    execute: ["npm"],
    network: [],
    secrets: []
  };
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
    purpose: "Run the existing unit tests.",
    action: { kind: "shell.exec", risk: "execute", payloadDigest: digest },
    capabilities: capabilities(),
    requires: [{ kind: "execute", value: "npm" }],
    preconditions: ["The lockfile matches the base revision."],
    expectedEffects: [{ kind: "artifact.create", target: "coverage/**", description: "Coverage artifacts" }],
    forbiddenEffects: [{ kind: "git.ref", target: "refs/**", description: "Git references remain unchanged" }],
    invariants: ["Tracked source files remain unchanged."],
    successEvidence: ["The unit test report passes."],
    rollback: { kind: "discard_cell", description: "Destroy the disposable cell." },
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

function cellSpec() {
  return {
    schemaVersion: 1,
    id: "cell-1",
    objectiveId: "objective-1",
    provider: "portable-worktree",
    baseRevision: "a".repeat(40),
    workspaceRootDigest: digest,
    capabilities: capabilities(),
    budget: {
      wallTimeMs: 60_000,
      cpuTimeMs: 30_000,
      memoryBytes: 512 * 1024 * 1024,
      diskBytes: 1024 * 1024 * 1024,
      processCount: 20,
      outputBytes: 1024 * 1024
    },
    networkDefault: "deny",
    retention: { keepFailedMs: 60_000, keepCommittedMs: 0 },
    createdAt: issuedAt
  };
}

function actionReceipt() {
  return {
    schemaVersion: 1,
    id: "receipt-1",
    contractId: "action-1",
    cellId: "cell-1",
    status: "succeeded",
    startedAt: issuedAt,
    completedAt: "2026-07-11T10:00:01.000Z",
    policyVersion: "policy-v1",
    contractDigest: digest,
    leaseDigest: digest,
    predictedEffectsDigest: digest,
    observedEffects: [],
    variances: [],
    evidence: [{ kind: "test", name: "unit", status: "passed", digest }]
  };
}

function commitReceipt(base: string) {
  return {
    schemaVersion: 1,
    id: "commit-1",
    cellId: "cell-1",
    status: "committed",
    expectedBase: base,
    actualBase: base,
    resultingRevision: "c".repeat(40),
    effectReceiptDigests: [digest],
    committedAt: "2026-07-11T10:01:00.000Z",
    reason: "All required verification passed."
  };
}

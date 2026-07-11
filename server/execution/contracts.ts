import { createHash } from "node:crypto";
import { z } from "zod";

export const EXECUTION_SCHEMA_VERSION = 1 as const;
const digestSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/, "Expected a sha256 digest.");
const idSchema = z.string().trim().min(1).max(200).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/, "Use a stable identifier without whitespace.");
const dateTimeSchema = z.string().datetime({ offset: true });
const revisionSchema = z.string().regex(/^[a-f0-9]{7,64}$/i, "Expected a Git revision hash.");

export const repositoryScopeSchema = z.string().trim().min(1).max(4096).superRefine((value, context) => {
  const normalized = value.replaceAll("\\", "/");
  if ([...value].some((character) => {
    const code = character.codePointAt(0) ?? 0;
    return code <= 31 || code === 127;
  })) context.addIssue({ code: "custom", message: "Repository scopes cannot contain control characters." });
  if (normalized.startsWith("/") || normalized.startsWith("//") || /^[A-Za-z]:\//.test(normalized)) {
    context.addIssue({ code: "custom", message: "Repository scopes must be relative." });
  }
  if (normalized.split("/").includes("..")) context.addIssue({ code: "custom", message: "Repository scopes cannot traverse parent directories." });
}).transform((value) => {
  const normalized = value.replaceAll("\\", "/").replace(/^\.\/+/, "").replace(/\/{2,}/g, "/").replace(/\/$/, "");
  return normalized || ".";
});

const programSchema = z.string().trim().min(1).max(4096).refine((value) => !/[\r\n\0]/.test(value), "Executable identities cannot contain control characters.");
const secretHandleSchema = z.string().trim().min(1).max(500).regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/, "Use an opaque secret handle, not a secret value.");
const networkOriginSchema = z.string().trim().min(1).max(8192).superRefine((value, context) => {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    context.addIssue({ code: "custom", message: "Network capabilities require a valid origin URL." });
    return;
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) context.addIssue({ code: "custom", message: "Network capabilities support HTTP or HTTPS origins only." });
  if (parsed.username || parsed.password || parsed.pathname !== "/" || parsed.search || parsed.hash) {
    context.addIssue({ code: "custom", message: "Network capabilities must be origins without credentials, paths, queries, or fragments." });
  }
}).transform((value) => new URL(value).origin);

export const capabilityEnvelopeSchema = z.object({
  read: z.array(repositoryScopeSchema).max(500).default([]),
  write: z.array(repositoryScopeSchema).max(500).default([]),
  delete: z.array(repositoryScopeSchema).max(200).default([]),
  execute: z.array(programSchema).max(200).default([]),
  network: z.array(networkOriginSchema).max(200).default([]),
  secrets: z.array(secretHandleSchema).max(100).default([])
}).strict().transform((value) => ({
  read: uniqueSorted(value.read),
  write: uniqueSorted(value.write),
  delete: uniqueSorted(value.delete),
  execute: uniqueSorted(value.execute),
  network: uniqueSorted(value.network),
  secrets: uniqueSorted(value.secrets)
}));

const capabilityReferenceSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("read"), value: repositoryScopeSchema }).strict(),
  z.object({ kind: z.literal("write"), value: repositoryScopeSchema }).strict(),
  z.object({ kind: z.literal("delete"), value: repositoryScopeSchema }).strict(),
  z.object({ kind: z.literal("execute"), value: programSchema }).strict(),
  z.object({ kind: z.literal("network"), value: networkOriginSchema }).strict(),
  z.object({ kind: z.literal("secrets"), value: secretHandleSchema }).strict()
]);

export const objectiveSchema = z.object({
  schemaVersion: z.literal(EXECUTION_SCHEMA_VERSION),
  id: idSchema,
  title: z.string().trim().min(1).max(500),
  description: z.string().trim().min(1).max(20_000),
  constraints: z.array(z.string().trim().min(1).max(4000)).max(200).default([]),
  createdAt: dateTimeSchema
}).strict();

export const capabilityLeaseSchema = z.object({
  schemaVersion: z.literal(EXECUTION_SCHEMA_VERSION),
  id: idSchema,
  objectiveId: idSchema,
  cellId: idSchema,
  issuedAt: dateTimeSchema,
  expiresAt: dateTimeSchema,
  singleUse: z.boolean().default(true),
  status: z.enum(["active", "used", "revoked"]).default("active"),
  capabilities: capabilityEnvelopeSchema,
  policyVersion: z.string().trim().min(1).max(200)
}).strict().superRefine((lease, context) => {
  if (Date.parse(lease.expiresAt) <= Date.parse(lease.issuedAt)) {
    context.addIssue({ code: "custom", path: ["expiresAt"], message: "Capability lease expiry must follow issuance." });
  }
});

const effectKindSchema = z.enum([
  "file.create", "file.update", "file.delete", "process.spawn", "network.request",
  "git.ref", "artifact.create", "package.change"
]);

export const expectedEffectSchema = z.object({
  kind: effectKindSchema,
  target: z.string().trim().min(1).max(8192),
  required: z.boolean().default(true),
  expectedDigest: digestSchema.optional(),
  description: z.string().trim().min(1).max(4000)
}).strict().superRefine(validateFileEffectTarget);

export const observedEffectSchema = z.object({
  kind: effectKindSchema,
  target: z.string().trim().min(1).max(8192),
  status: z.enum(["created", "changed", "deleted", "attempted", "blocked", "unchanged"]),
  observedAt: dateTimeSchema,
  beforeDigest: digestSchema.optional(),
  afterDigest: digestSchema.optional(),
  bytesChanged: z.number().int().min(0).optional(),
  detail: z.string().max(20_000).optional()
}).strict().superRefine(validateFileEffectTarget);

const rollbackSchema = z.object({
  kind: z.enum(["discard_cell", "inverse_patch", "compensating_action", "none"]),
  description: z.string().trim().min(1).max(4000)
}).strict();

export const contractedActionSchema = z.object({
  schemaVersion: z.literal(EXECUTION_SCHEMA_VERSION),
  id: idSchema,
  objectiveId: idSchema,
  cellId: idSchema,
  leaseId: idSchema,
  issuedAt: dateTimeSchema,
  expiresAt: dateTimeSchema,
  purpose: z.string().trim().min(1).max(4000),
  action: z.object({
    kind: z.string().trim().min(1).max(200),
    risk: z.enum(["read", "write", "execute", "network"]),
    payloadDigest: digestSchema
  }).strict(),
  capabilities: capabilityEnvelopeSchema,
  requires: z.array(capabilityReferenceSchema).min(1).max(500),
  preconditions: z.array(z.string().trim().min(1).max(4000)).max(200).default([]),
  expectedEffects: z.array(expectedEffectSchema).max(500).default([]),
  forbiddenEffects: z.array(expectedEffectSchema).max(500).default([]),
  invariants: z.array(z.string().trim().min(1).max(4000)).min(1).max(200),
  successEvidence: z.array(z.string().trim().min(1).max(4000)).min(1).max(200),
  rollback: rollbackSchema
}).strict().superRefine((contract, context) => {
  if (Date.parse(contract.expiresAt) <= Date.parse(contract.issuedAt)) {
    context.addIssue({ code: "custom", path: ["expiresAt"], message: "Contract expiry must follow issuance." });
  }
  for (const [index, reference] of contract.requires.entries()) {
    if (!contract.capabilities[reference.kind].includes(reference.value)) {
      context.addIssue({ code: "custom", path: ["requires", index], message: `Required ${reference.kind} capability is not declared in the contract envelope.` });
    }
  }
  const riskKinds: Record<typeof contract.action.risk, Array<CapabilityKind>> = {
    read: ["read"],
    write: ["write", "delete"],
    execute: ["execute"],
    network: ["network"]
  };
  if (!contract.requires.some((reference) => riskKinds[contract.action.risk].includes(reference.kind))) {
    context.addIssue({ code: "custom", path: ["requires"], message: `A ${contract.action.risk} action must require a matching consequential capability.` });
  }
});

const resourceBudgetSchema = z.object({
  wallTimeMs: z.number().int().min(100).max(86_400_000),
  cpuTimeMs: z.number().int().min(100).max(86_400_000),
  memoryBytes: z.number().int().min(16 * 1024 * 1024).max(1024 ** 4),
  diskBytes: z.number().int().min(1024 * 1024).max(1024 ** 4),
  processCount: z.number().int().min(1).max(10_000),
  outputBytes: z.number().int().min(1024).max(1024 ** 3)
}).strict();

export const cellSpecSchema = z.object({
  schemaVersion: z.literal(EXECUTION_SCHEMA_VERSION),
  id: idSchema,
  objectiveId: idSchema,
  provider: z.enum(["portable-worktree", "windows-sandbox", "firecracker", "remote"]),
  baseRevision: revisionSchema,
  workspaceRootDigest: digestSchema,
  capabilities: capabilityEnvelopeSchema,
  budget: resourceBudgetSchema,
  networkDefault: z.literal("deny"),
  retention: z.object({
    keepFailedMs: z.number().int().min(0).max(30 * 24 * 60 * 60 * 1000),
    keepCommittedMs: z.number().int().min(0).max(30 * 24 * 60 * 60 * 1000)
  }).strict(),
  createdAt: dateTimeSchema
}).strict();

export const cellStateSchema = z.enum([
  "preparing", "isolated", "executing", "verifying", "ready_to_commit",
  "committed", "rolled_back", "failed", "destroyed"
]);

export const executionCellSchema = z.object({
  schemaVersion: z.literal(EXECUTION_SCHEMA_VERSION),
  id: idSchema,
  specDigest: digestSchema,
  provider: z.enum(["portable-worktree", "windows-sandbox", "firecracker", "remote"]),
  providerRef: z.string().trim().min(1).max(8192),
  baseRevision: revisionSchema,
  state: cellStateSchema,
  preparedAt: dateTimeSchema,
  updatedAt: dateTimeSchema
}).strict().superRefine((cell, context) => {
  if (Date.parse(cell.updatedAt) < Date.parse(cell.preparedAt)) {
    context.addIssue({ code: "custom", path: ["updatedAt"], message: "Cell update time cannot precede preparation." });
  }
});

export const cellSnapshotSchema = z.object({
  schemaVersion: z.literal(EXECUTION_SCHEMA_VERSION),
  id: idSchema,
  cellId: idSchema,
  state: cellStateSchema,
  reason: z.string().trim().min(1).max(4000),
  stateDigest: digestSchema,
  providerSnapshotRef: z.string().trim().min(1).max(8192).optional(),
  createdAt: dateTimeSchema
}).strict();

export const effectSetSchema = z.object({
  schemaVersion: z.literal(EXECUTION_SCHEMA_VERSION),
  cellId: idSchema,
  baseRevision: revisionSchema,
  capturedAt: dateTimeSchema,
  effects: z.array(observedEffectSchema).max(10_000),
  effectsDigest: digestSchema
}).strict();

const evidenceSchema = z.object({
  kind: z.enum(["test", "lint", "policy", "artifact", "operator", "custom"]),
  name: z.string().trim().min(1).max(500),
  status: z.enum(["passed", "failed", "warning"]),
  digest: digestSchema,
  detail: z.string().max(20_000).optional()
}).strict();

const effectVarianceSchema = z.object({
  kind: z.enum(["missing", "unexpected", "forbidden", "mismatch"]),
  severity: z.enum(["warning", "blocking"]),
  effectTarget: z.string().trim().min(1).max(8192),
  detail: z.string().trim().min(1).max(4000)
}).strict();

export const actionReceiptSchema = z.object({
  schemaVersion: z.literal(EXECUTION_SCHEMA_VERSION),
  id: idSchema,
  contractId: idSchema,
  cellId: idSchema,
  status: z.enum(["succeeded", "failed", "blocked", "canceled"]),
  startedAt: dateTimeSchema,
  completedAt: dateTimeSchema,
  policyVersion: z.string().trim().min(1).max(200),
  contractDigest: digestSchema,
  leaseDigest: digestSchema,
  predictedEffectsDigest: digestSchema,
  observedEffects: z.array(observedEffectSchema).max(10_000),
  variances: z.array(effectVarianceSchema).max(10_000),
  evidence: z.array(evidenceSchema).max(2000),
  outputDigest: digestSchema.optional(),
  previousReceiptDigest: digestSchema.optional()
}).strict().superRefine((receipt, context) => {
  if (Date.parse(receipt.completedAt) < Date.parse(receipt.startedAt)) {
    context.addIssue({ code: "custom", path: ["completedAt"], message: "Receipt completion cannot precede its start." });
  }
  if (receipt.status === "succeeded" && receipt.variances.some((variance) => variance.severity === "blocking")) {
    context.addIssue({ code: "custom", path: ["variances"], message: "A successful receipt cannot contain blocking effect variance." });
  }
});

export const commitReceiptSchema = z.object({
  schemaVersion: z.literal(EXECUTION_SCHEMA_VERSION),
  id: idSchema,
  cellId: idSchema,
  status: z.enum(["committed", "rejected"]),
  expectedBase: revisionSchema,
  actualBase: revisionSchema,
  resultingRevision: revisionSchema.optional(),
  effectReceiptDigests: z.array(digestSchema).min(1).max(10_000),
  committedAt: dateTimeSchema,
  reason: z.string().trim().min(1).max(4000)
}).strict().superRefine((receipt, context) => {
  if (receipt.status === "committed" && receipt.expectedBase !== receipt.actualBase) {
    context.addIssue({ code: "custom", path: ["actualBase"], message: "Committed cells must match the expected base revision." });
  }
  if (receipt.status === "committed" && !receipt.resultingRevision) {
    context.addIssue({ code: "custom", path: ["resultingRevision"], message: "Committed cells require a resulting revision." });
  }
  if (receipt.status === "rejected" && receipt.resultingRevision) {
    context.addIssue({ code: "custom", path: ["resultingRevision"], message: "Rejected commits cannot report a resulting revision." });
  }
});

export type Objective = z.infer<typeof objectiveSchema>;
export type CapabilityEnvelope = z.infer<typeof capabilityEnvelopeSchema>;
export type CapabilityReference = z.infer<typeof capabilityReferenceSchema>;
export type CapabilityLease = z.infer<typeof capabilityLeaseSchema>;
export type ContractedAction = z.infer<typeof contractedActionSchema>;
export type ExpectedEffect = z.infer<typeof expectedEffectSchema>;
export type ObservedEffect = z.infer<typeof observedEffectSchema>;
export type CellSpec = z.infer<typeof cellSpecSchema>;
export type CellState = z.infer<typeof cellStateSchema>;
export type ExecutionCell = z.infer<typeof executionCellSchema>;
export type CellSnapshot = z.infer<typeof cellSnapshotSchema>;
export type EffectSet = z.infer<typeof effectSetSchema>;
export type ActionReceipt = z.infer<typeof actionReceiptSchema>;
export type CommitReceipt = z.infer<typeof commitReceiptSchema>;
type CapabilityKind = keyof CapabilityEnvelope;

export interface ExecutionCellProvider {
  prepare(spec: CellSpec): Promise<ExecutionCell>;
  execute(cellId: string, contract: ContractedAction, lease: CapabilityLease): Promise<ActionReceipt>;
  snapshot(cellId: string, reason: string): Promise<CellSnapshot>;
  diff(cellId: string): Promise<EffectSet>;
  commit(cellId: string, expectedBase: string): Promise<CommitReceipt>;
  destroy(cellId: string): Promise<void>;
}

const cellTransitions: Record<CellState, ReadonlySet<CellState>> = {
  preparing: new Set(["isolated", "failed", "destroyed"]),
  isolated: new Set(["executing", "failed", "rolled_back", "destroyed"]),
  executing: new Set(["verifying", "failed", "rolled_back"]),
  verifying: new Set(["executing", "ready_to_commit", "failed", "rolled_back"]),
  ready_to_commit: new Set(["committed", "failed", "rolled_back"]),
  committed: new Set(["rolled_back", "destroyed"]),
  rolled_back: new Set(["destroyed"]),
  failed: new Set(["rolled_back", "destroyed"]),
  destroyed: new Set()
};

export function canTransitionCell(from: CellState, to: CellState) {
  return cellTransitions[from].has(to);
}

export function assertCellTransition(from: CellState, to: CellState) {
  if (!canTransitionCell(from, to)) throw new Error(`Invalid execution-cell transition: ${from} -> ${to}.`);
}

export function parseCapabilityLease(input: unknown, now = new Date()): CapabilityLease {
  const lease = capabilityLeaseSchema.parse(input);
  if (lease.status !== "active") throw new Error(`Capability lease is ${lease.status}.`);
  if (Date.parse(lease.expiresAt) <= now.getTime()) throw new Error("Capability lease has expired.");
  return lease;
}

export function parseContractedAction(input: unknown, now = new Date()): ContractedAction {
  const contract = contractedActionSchema.parse(input);
  if (Date.parse(contract.expiresAt) <= now.getTime()) throw new Error("Contracted action has expired.");
  return contract;
}

export function authorizeContract(input: unknown, leaseInput: unknown, now = new Date()) {
  const contract = parseContractedAction(input, now);
  const lease = parseCapabilityLease(leaseInput, now);
  if (contract.leaseId !== lease.id) throw new Error("Contract references a different capability lease.");
  if (contract.objectiveId !== lease.objectiveId) throw new Error("Contract and capability lease have different objectives.");
  if (contract.cellId !== lease.cellId) throw new Error("Contract and capability lease target different execution cells.");
  if (Date.parse(contract.expiresAt) > Date.parse(lease.expiresAt)) throw new Error("Contract outlives its capability lease.");
  for (const kind of capabilityKinds) {
    for (const value of contract.capabilities[kind]) {
      if (!lease.capabilities[kind].includes(value)) throw new Error(`Contract ${kind} capability is outside its lease: ${value}`);
    }
  }
  return {
    contract,
    lease,
    contractDigest: executionDigest(contract),
    leaseDigest: executionDigest(lease)
  };
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalValue(value));
}

export function executionDigest(value: unknown): string {
  return `sha256:${createHash("sha256").update(canonicalJson(value)).digest("hex")}`;
}

function canonicalValue(value: unknown): unknown {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("Canonical execution data cannot contain non-finite numbers.");
    return Object.is(value, -0) ? 0 : value;
  }
  if (Array.isArray(value)) return value.map((item) => canonicalValue(item));
  if (typeof value === "object") {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) throw new Error("Canonical execution data must contain plain JSON objects only.");
    return Object.fromEntries(Object.keys(value as Record<string, unknown>).sort().map((key) => {
      const item = (value as Record<string, unknown>)[key];
      if (item === undefined) throw new Error("Canonical execution data cannot contain undefined values.");
      return [key, canonicalValue(item)];
    }));
  }
  throw new Error(`Canonical execution data cannot contain ${typeof value} values.`);
}

function uniqueSorted(values: string[]) {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}

const capabilityKinds: CapabilityKind[] = ["read", "write", "delete", "execute", "network", "secrets"];

function validateFileEffectTarget(effect: { kind: z.infer<typeof effectKindSchema>; target: string }, context: z.RefinementCtx) {
  if (!effect.kind.startsWith("file.") && effect.kind !== "artifact.create") return;
  const result = repositoryScopeSchema.safeParse(effect.target);
  if (!result.success) context.addIssue({ code: "custom", path: ["target"], message: "File effect targets must be safe repository-relative scopes." });
}

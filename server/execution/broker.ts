import { randomUUID } from "node:crypto";
import {
  actionReceiptSchema,
  authorizeContract,
  executionDigest,
  type ActionReceipt,
  type CapabilityLease,
  type ContractedAction,
  type ExpectedEffect,
  type ObservedEffect
} from "./contracts.js";

export type BrokerMode = "enforced" | "compatibility";

export interface PolicyDecision {
  allowed: boolean;
  policyVersion: string;
  reason: string;
  evidenceDigest: string;
}

export interface ContractPolicyEvaluator {
  evaluate(input: { contract: ContractedAction; lease: CapabilityLease; contractDigest: string; leaseDigest: string }): Promise<PolicyDecision>;
}

export type OperationOutcome<T> =
  | { status: "succeeded"; value: T }
  | { status: "failed"; errorDigest: string };

export interface EffectObservation<T> {
  outcome: OperationOutcome<T>;
  effects: ObservedEffect[];
}

export interface EffectObserver {
  observe<T>(cellId: string, operation: () => Promise<T>): Promise<EffectObservation<T>>;
}

export interface LeaseUseStore {
  claim(lease: CapabilityLease): Promise<boolean>;
}

export interface ReceiptChainStore {
  link(cellId: string, factory: (previousReceiptDigest?: string) => ActionReceipt): Promise<ActionReceipt>;
}

export interface BrokerAuditRecord {
  at: string;
  mode: BrokerMode;
  contractId: string;
  leaseId: string;
  cellId: string;
  objectiveId: string;
  action: string;
  risk: ContractedAction["action"]["risk"];
  status: ActionReceipt["status"];
  policyVersion: string;
  contractDigest: string;
  receiptDigest: string;
  observedEffectCount: number;
  varianceCount: number;
}

export interface BrokerAuditSink {
  append(record: BrokerAuditRecord): Promise<void>;
}

export interface CapabilityBrokerOptions {
  mode: BrokerMode;
  policy: ContractPolicyEvaluator;
  observer: EffectObserver;
  leases: LeaseUseStore;
  receipts: ReceiptChainStore;
  audit: BrokerAuditSink;
  now?: () => Date;
  id?: () => string;
}

export class ContractCapabilityBroker {
  private readonly now: () => Date;
  private readonly id: () => string;

  constructor(private readonly options: CapabilityBrokerOptions) {
    this.now = options.now ?? (() => new Date());
    this.id = options.id ?? randomUUID;
  }

  async execute<T>(contractInput: unknown, leaseInput: unknown, operation: () => Promise<T>): Promise<ActionReceipt> {
    const started = this.now();
    const authorization = authorizeContract(contractInput, leaseInput, started);
    const { contract, lease, contractDigest, leaseDigest } = authorization;
    let evaluated: PolicyDecision;
    try {
      evaluated = await this.options.policy.evaluate(authorization);
    } catch {
      evaluated = {
        allowed: false,
        policyVersion: lease.policyVersion,
        reason: "Policy evaluation failed closed.",
        evidenceDigest: executionDigest({ kind: "policy-evaluation-failure", policyVersion: lease.policyVersion })
      };
    }
    const policy = evaluated.policyVersion === lease.policyVersion ? evaluated : {
      ...evaluated,
      allowed: false,
      reason: `Policy decision version ${evaluated.policyVersion} does not match lease policy ${lease.policyVersion}.`
    };
    if (!policy.allowed) {
      return this.finalize({
        contract,
        lease,
        contractDigest,
        leaseDigest,
        policy,
        started,
        status: "blocked",
        observedEffects: [],
        variances: [{ kind: "forbidden", severity: "blocking", effectTarget: "policy", detail: policy.reason }],
        evidence: [policyEvidence(policy)]
      });
    }

    if (!(await this.options.leases.claim(lease))) {
      return this.finalize({
        contract,
        lease,
        contractDigest,
        leaseDigest,
        policy,
        started,
        status: "blocked",
        observedEffects: [],
        variances: [{ kind: "forbidden", severity: "blocking", effectTarget: "lease", detail: "The single-use capability lease has already been claimed." }],
        evidence: [policyEvidence(policy)]
      });
    }

    let observation: EffectObservation<T>;
    try {
      observation = await this.options.observer.observe(contract.cellId, operation);
    } catch (caught) {
      observation = {
        outcome: { status: "failed", errorDigest: executionDigest({ kind: "effect-observation-failure", errorType: caught instanceof Error ? caught.name : typeof caught }) },
        effects: []
      };
    }
    const variances = compareEffects(contract.expectedEffects, contract.forbiddenEffects, observation.effects);
    let outputDigest: string | undefined;
    if (observation.outcome.status === "succeeded") {
      try {
        outputDigest = executionDigest(observation.outcome.value);
      } catch {
        variances.push({ kind: "unexpected", severity: "blocking", effectTarget: "operation.output", detail: "The operation returned non-canonical output." });
      }
    }
    const failed = observation.outcome.status === "failed" || variances.some((variance) => variance.severity === "blocking");
    const evidence: ActionReceipt["evidence"] = [policyEvidence(policy)];
    if (observation.outcome.status === "failed") {
      evidence.push({ kind: "custom" as const, name: "Operation result", status: "failed" as const, digest: observation.outcome.errorDigest, detail: "The contracted operation failed; raw error content is not stored in the receipt." });
    }
    return this.finalize({
      contract,
      lease,
      contractDigest,
      leaseDigest,
      policy,
      started,
      status: failed ? "failed" : "succeeded",
      observedEffects: observation.effects,
      variances,
      evidence,
      outputDigest
    });
  }

  private async finalize(input: ReceiptInput) {
    const completedAt = this.now().toISOString();
    const receipt = await this.options.receipts.link(input.contract.cellId, (previousReceiptDigest) => actionReceiptSchema.parse({
      schemaVersion: 1,
      id: this.id(),
      contractId: input.contract.id,
      cellId: input.contract.cellId,
      status: input.status,
      startedAt: input.started.toISOString(),
      completedAt,
      policyVersion: input.policy.policyVersion,
      contractDigest: input.contractDigest,
      leaseDigest: input.leaseDigest,
      predictedEffectsDigest: executionDigest(input.contract.expectedEffects),
      observedEffects: input.observedEffects,
      variances: input.variances,
      evidence: input.evidence,
      ...(input.outputDigest ? { outputDigest: input.outputDigest } : {}),
      ...(previousReceiptDigest ? { previousReceiptDigest } : {})
    }));
    const receiptDigest = executionDigest(receipt);
    await this.options.audit.append({
      at: completedAt,
      mode: this.options.mode,
      contractId: input.contract.id,
      leaseId: input.lease.id,
      cellId: input.contract.cellId,
      objectiveId: input.contract.objectiveId,
      action: input.contract.action.kind,
      risk: input.contract.action.risk,
      status: receipt.status,
      policyVersion: input.policy.policyVersion,
      contractDigest: input.contractDigest,
      receiptDigest,
      observedEffectCount: receipt.observedEffects.length,
      varianceCount: receipt.variances.length
    });
    return receipt;
  }
}

export class InMemoryLeaseUseStore implements LeaseUseStore {
  private readonly claimed = new Set<string>();

  async claim(lease: CapabilityLease) {
    if (!lease.singleUse) return true;
    if (this.claimed.has(lease.id)) return false;
    this.claimed.add(lease.id);
    return true;
  }
}

export class InMemoryReceiptChainStore implements ReceiptChainStore {
  private readonly latest = new Map<string, string>();

  async link(cellId: string, factory: (previousReceiptDigest?: string) => ActionReceipt) {
    const receipt = factory(this.latest.get(cellId));
    this.latest.set(cellId, executionDigest(receipt));
    return receipt;
  }
}

export function compareEffects(expected: ExpectedEffect[], forbidden: ExpectedEffect[], observed: ObservedEffect[]) {
  const variances: ActionReceipt["variances"] = [];
  const material = observed.filter((effect) => !["blocked", "unchanged"].includes(effect.status));
  for (const effect of expected.filter((item) => item.required)) {
    const matches = material.filter((item) => effectMatches(effect, item));
    if (!matches.length) {
      variances.push({ kind: "missing", severity: "blocking", effectTarget: effect.target, detail: `Required ${effect.kind} effect was not observed.` });
      continue;
    }
    if (effect.expectedDigest && matches.every((item) => item.afterDigest !== effect.expectedDigest)) {
      variances.push({ kind: "mismatch", severity: "blocking", effectTarget: effect.target, detail: `Observed ${effect.kind} digest did not match the contract.` });
    }
  }
  for (const effect of forbidden) {
    for (const match of material.filter((item) => effectMatches(effect, item))) {
      variances.push({ kind: "forbidden", severity: "blocking", effectTarget: match.target, detail: `Forbidden ${effect.kind} effect was observed.` });
    }
  }
  for (const effect of material) {
    if (!expected.some((item) => effectMatches(item, effect)) && !forbidden.some((item) => effectMatches(item, effect))) {
      variances.push({ kind: "unexpected", severity: "blocking", effectTarget: effect.target, detail: `Undeclared ${effect.kind} effect was observed.` });
    }
  }
  return variances;
}

function effectMatches(expected: ExpectedEffect, observed: ObservedEffect) {
  return expected.kind === observed.kind && targetMatches(expected.target, observed.target);
}

function targetMatches(pattern: string, target: string) {
  pattern = pattern.replaceAll("\\", "/");
  target = target.replaceAll("\\", "/");
  if (pattern === target) return true;
  if (!pattern.includes("*")) return false;
  let expression = "";
  for (let index = 0; index < pattern.length; index += 1) {
    const character = pattern[index];
    if (character === "*" && pattern[index + 1] === "*") {
      expression += ".*";
      index += 1;
    } else if (character === "*") {
      expression += "[^/]*";
    } else {
      expression += /[.+?^${}()|[\]\\]/.test(character) ? `\\${character}` : character;
    }
  }
  return new RegExp(`^${expression}$`).test(target);
}

function policyEvidence(policy: PolicyDecision) {
  return {
    kind: "policy" as const,
    name: "Contract policy",
    status: policy.allowed ? "passed" as const : "failed" as const,
    digest: policy.evidenceDigest,
    detail: policy.reason
  };
}

interface ReceiptInput {
  contract: ContractedAction;
  lease: CapabilityLease;
  contractDigest: string;
  leaseDigest: string;
  policy: PolicyDecision;
  started: Date;
  status: ActionReceipt["status"];
  observedEffects: ObservedEffect[];
  variances: ActionReceipt["variances"];
  evidence: ActionReceipt["evidence"];
  outputDigest?: string;
}

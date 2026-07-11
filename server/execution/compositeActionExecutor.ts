import { executionDigest, type ContractedAction } from "./contracts.js";
import type { PortableActionExecutor } from "./portableWorktreeProvider.js";

type ActionKind = ContractedAction["action"]["kind"];

export interface PortableActionRoute {
  kinds: readonly ActionKind[];
  executor: PortableActionExecutor;
}

interface AdmittedRoute {
  executor: PortableActionExecutor;
  contractDigest: string;
  leaseDigest: string;
  cellDigest: string;
  workingDirectory: string;
}

export class CompositePortableActionExecutor implements PortableActionExecutor {
  private readonly routes = new Map<ActionKind, PortableActionExecutor>();
  private readonly admitted = new Map<string, AdmittedRoute>();

  constructor(routes: readonly PortableActionRoute[]) {
    if (!routes.length) throw new Error("Composite portable action dispatch requires at least one route.");
    for (const route of routes) {
      if (!route.kinds.length) throw new Error("Composite portable action routes must declare at least one action kind.");
      for (const kind of route.kinds) {
        if (this.routes.has(kind)) throw new Error(`Composite portable action kind is registered more than once: ${kind}.`);
        this.routes.set(kind, route.executor);
      }
    }
  }

  registeredKinds() {
    return [...this.routes.keys()];
  }

  async authorize(input: Parameters<NonNullable<PortableActionExecutor["authorize"]>>[0]) {
    const executor = this.route(input.contract.action.kind);
    const binding = this.binding(input, executor);
    const existing = this.admitted.get(input.contract.id);
    if (existing) {
      if (sameBinding(existing, binding)) return;
      throw new Error(`Portable action contract is already admitted with different input: ${input.contract.id}.`);
    }
    await executor.authorize?.(input);
    if (!sameBinding(binding, this.binding(input, executor))) throw new Error("Portable action input changed during admission.");
    this.admitted.set(input.contract.id, binding);
  }

  async execute(input: Parameters<PortableActionExecutor["execute"]>[0]) {
    const admitted = this.admitted.get(input.contract.id);
    if (!admitted) throw new Error(`Portable action contract was not admitted before execution: ${input.contract.id}.`);
    this.admitted.delete(input.contract.id);
    if (!sameBinding(admitted, this.binding(input, this.route(input.contract.action.kind)))) {
      throw new Error("Portable action input changed after admission.");
    }
    return admitted.executor.execute(input);
  }

  private route(kind: ActionKind) {
    const executor = this.routes.get(kind);
    if (!executor) throw new Error(`No portable action executor is registered for ${kind}.`);
    return executor;
  }

  private binding(input: Parameters<PortableActionExecutor["execute"]>[0], executor: PortableActionExecutor): AdmittedRoute {
    return {
      executor,
      contractDigest: executionDigest(input.contract),
      leaseDigest: executionDigest(input.lease),
      cellDigest: executionDigest({
        id: input.cell.id,
        specDigest: input.cell.specDigest,
        provider: input.cell.provider,
        providerRef: input.cell.providerRef,
        baseRevision: input.cell.baseRevision,
        preparedAt: input.cell.preparedAt
      }),
      workingDirectory: input.workingDirectory
    };
  }
}

function sameBinding(left: AdmittedRoute, right: AdmittedRoute) {
  return left.executor === right.executor
    && left.contractDigest === right.contractDigest
    && left.leaseDigest === right.leaseDigest
    && left.cellDigest === right.cellDigest
    && left.workingDirectory === right.workingDirectory;
}

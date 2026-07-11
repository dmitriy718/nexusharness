# NexusHarness frontier roadmap: five post-v2 system upgrades

**Document status:** Proposal for owner review
**Prepared:** 2026-07-11
**Baseline:** NexusHarness v2.0.0-beta.1
**Scope:** Major harness capabilities after the v2.0.0 release gate
**Explicit exclusion:** Vector databases, embeddings, retrieval memory, and long-term memory upgrades are outside this proposal.

## Executive recommendation

NexusHarness should evolve from an application that *lets a model call tools* into an execution operating system that can safely search for, prove, and commit useful work. The important shift is not a larger model or a larger context window. It is a better environment around the model:

1. **Transactional execution cells** make every consequential attempt isolated, reversible, and inspectable.
2. **Branch-and-prove search** lets several bounded approaches compete without colliding, then promotes only evidence-backed work.
3. **An adaptive model router** assigns each step to the least expensive local model likely to succeed and escalates only when evidence says it should.
4. **Proof-carrying operations** turn approvals from raw permission prompts into machine-checkable contracts with explicit effects and invariants.
5. **A live semantic system twin** gives models one coherent, current view of files, processes, terminals, browsers, and desktop applications while detecting uncertainty and state drift.

These capabilities reinforce one another:

```text
Objective
   |
   v
Semantic system twin -> proof-carrying plan -> policy decision
                                              |
                                              v
                                  isolated execution cells
                                      /      |      \
                                  branch A branch B branch C
                                      \      |      /
                                  deterministic verification
                                              |
                                              v
                                  atomic commit or rollback

The adaptive router chooses the model and budget at every stage.
```

The recommended order is 1, 4, 3, 2, then 5. Isolation and policy must exist before NexusHarness increases autonomy or expands from repository work into general computer use.

## Why these five

Current agent systems lose efficiency and reliability in four predictable places: they operate directly on host state, follow one early plan too long, use the same model for unlike tasks, and infer current system state from incomplete observations. Research now supplies practical building blocks for addressing each problem:

- Firecracker supports serializing and restoring microVM state, while its jailer adds cgroup/namespace isolation and privilege dropping. Git separately supports disposable linked worktrees. These are suitable foundations for reversible execution, with platform-specific providers rather than a Linux-only assumption. [Firecracker snapshot support](https://github.com/firecracker-microvm/firecracker/blob/main/docs/snapshotting/snapshot-support.md), [Firecracker jailer](https://github.com/firecracker-microvm/firecracker/blob/main/docs/jailer.md), [Git worktree documentation](https://git-scm.com/docs/git-worktree.html)
- SWE-Search reports a 23% relative improvement from multi-agent search and iterative evaluation, while SWE-Replay reports lower test-time scaling cost by branching from useful intermediate trajectories instead of repeatedly starting from zero. This supports bounded solution search, but not unverified majority voting. [SWE-Search](https://arxiv.org/abs/2410.20285), [SWE-Replay](https://arxiv.org/abs/2601.22129)
- RouteLLM demonstrates that learned routing can reduce model cost by more than two times in some evaluations without reducing quality. NexusHarness can apply the same principle to local latency, VRAM pressure, tool reliability, and validation outcomes. [RouteLLM](https://arxiv.org/abs/2406.18665)
- Open Policy Agent provides declarative decisions over structured inputs, and in-toto defines metadata for recording and verifying software-supply-chain steps. Together they provide useful patterns for policy-backed operations and evidence chains. [OPA policy language](https://www.openpolicyagent.org/docs/policy-language), [in-toto documentation](https://in-toto.readthedocs.io/en/stable/)
- OSWorld 2.0 shows why general computer work is a different class of problem: its workflows average hundreds of tool calls and expose failures around dynamic state, incoming information, constraint tracking, uncertainty, and skipped verification. SWE-agent separately shows that a model-specific agent-computer interface can materially change agent performance. [OSWorld 2.0](https://arxiv.org/abs/2606.29537), [SWE-agent](https://arxiv.org/abs/2405.15793)

The designs below are NexusHarness proposals inferred from those sources; the sources do not establish that the complete combined architecture has already been built or validated.

---

## 1. Transactional execution cells

### Core idea

Never let an agent's exploratory work mutate the operator's live workspace directly. Every run or branch receives a disposable execution cell with an immutable base, a writable overlay, explicit capability leases, a resource budget, and a complete effect journal. Successful work is committed atomically after verification; unsuccessful work is destroyed or retained as a read-only artifact.

This is more than a sandbox. A sandbox limits where work can happen; a transaction also defines what changed, whether the result is valid, and how to roll it back.

### Operator experience

- A new **Execution** panel shows the cell provider, base revision, CPU/RAM/time budget, network policy, writable scopes, and current state.
- Every run has a visible lifecycle: `preparing -> isolated -> executing -> verifying -> ready to commit -> committed/rolled back`.
- The review screen compares the base and overlay as files, commands, processes, ports, dependencies, and produced artifacts—not only as a Git diff.
- **Commit result** is enabled only after required checks and policy assertions pass.
- **Rollback** remains available after commit for a defined retention window through an inverse patch or recorded restore point.
- The operator can promote a useful failed attempt into a new branch without giving that branch access to the live workspace.

### Technical design

Introduce an `ExecutionCellProvider` contract:

```ts
interface ExecutionCellProvider {
  prepare(spec: CellSpec): Promise<Cell>;
  execute(cellId: string, action: ContractedAction): Promise<ActionResult>;
  snapshot(cellId: string, reason: string): Promise<CellSnapshot>;
  diff(cellId: string): Promise<EffectSet>;
  commit(cellId: string, expectedBase: string): Promise<CommitReceipt>;
  destroy(cellId: string): Promise<void>;
}
```

Required provider behavior:

- Copy-on-write or detached-worktree workspace state.
- No ambient host filesystem access.
- Network disabled by default; allowlists are per action and expire.
- CPU, memory, process-count, disk, output, and wall-clock limits.
- Secret injection by named handle, never by placing secrets in the prompt or audit payload.
- Captured stdout/stderr with bounded retention and redaction.
- Base-revision compare-and-swap during commit so a stale branch cannot overwrite newer work.
- Cell artifacts and effect receipts signed or hashed before leaving the cell.

Provider sequence:

1. **Portable provider:** detached Git worktree plus process restrictions and a deny-by-default capability broker. This establishes the API and transaction semantics on all platforms.
2. **Windows provider:** Windows Sandbox or a managed Hyper-V/WSL2 environment with networking disabled by default and carefully controlled mapped folders. Microsoft explicitly warns that networking and writable mapped folders expand exposure. [Windows Sandbox configuration](https://learn.microsoft.com/en-us/windows/security/application-security/application-isolation/windows-sandbox/windows-sandbox-configure-using-wsb-file)
3. **Linux provider:** Firecracker microVMs with the jailer, read-only base images, overlay storage, and warm snapshots.
4. **Remote provider:** optional operator-owned workers using the same protocol and receipts; no cloud dependency is required.

### Implementation plan

**Phase 1 — transaction model**

- Add `CellSpec`, `CapabilityLease`, `EffectSet`, `CellSnapshot`, and `CommitReceipt` schemas.
- Move shell/file execution behind one cell-aware broker.
- Add base revision and affected-scope checks to every mutating action.
- Record action-to-effect causality in the audit ledger.

**Phase 2 — portable cells**

- Create locked, detached worktrees under harness-owned storage.
- Deny direct mutation of the primary workspace while a run is active.
- Produce normalized patches and artifact inventories.
- Add atomic commit, stale-base rejection, teardown, and crash recovery.

**Phase 3 — hardened providers**

- Add Windows and Linux isolation adapters.
- Create prewarmed images/snapshots by toolchain profile.
- Add network egress policy, secret handles, and resource enforcement.
- Run adversarial escape and data-exfiltration tests before making hardened cells the default.

### Success gates

- 100% of agent mutations occur through a cell and have an effect receipt.
- A failed or canceled run leaves the primary workspace byte-for-byte unchanged.
- A stale-base commit always fails safely.
- Median cell preparation is below 2 seconds for a warm provider and below 8 seconds cold.
- Crash recovery removes or quarantines every orphan cell without losing its audit record.
- No credential value appears in prompts, logs, receipts, or UI exports.

### Main risks

- Git worktrees isolate repository state but are not a security boundary; they must never be marketed as equivalent to a microVM.
- Firecracker is not a Windows-native provider, and snapshots have host/CPU compatibility limitations.
- Build caches can become covert shared state. Cache mounts need read-only or content-addressed rules.
- Atomic commit is easy for files and harder for databases, services, and external APIs; non-file effects need compensating actions or an explicit non-reversible warning.

---

## 2. Branch-and-prove solution search

### Core idea

Replace the single linear agent loop with an evidence-driven solution market. NexusHarness creates several isolated candidate branches, gives each a deliberately different strategy or model mix, spends more budget only on promising branches, and promotes a result only when deterministic checks establish that it improves the objective without breaking declared invariants.

The revolutionary part is not “more agents.” It is controlled diversity plus a trustworthy selection mechanism.

### Operator experience

- Orchestrate gains a **Solution graph** showing branches, common ancestors, strategy, budget, changed scopes, check results, and why a branch was stopped.
- The user selects a search posture: **Direct**, **Balanced**, or **Deep search**. Each posture displays its hard limits before work begins.
- Branch comparison groups meaningful differences: architecture, dependency impact, tests, performance, accessibility, security, and unresolved uncertainty.
- NexusHarness recommends one candidate, but the operator can inspect or combine candidates.
- A synthesis branch may merge complementary work only inside a new execution cell and must rerun the full verifier set.

### Search algorithm

1. Planner emits a typed objective, constraints, and two to five materially distinct strategies.
2. The scheduler creates one execution cell per selected strategy.
3. Each branch receives a fixed initial budget and cannot see sibling chain-of-thought or hidden model state.
4. A verifier computes evidence from tests, lint, static analysis, security policy, performance budgets, required UX states, and objective-specific checks.
5. The scheduler prunes branches that violate invariants, duplicate another branch, stop making progress, or exceed budget.
6. Promising branches may fork at high-information decision points rather than restart from zero.
7. The winner is selected by a transparent scorecard with hard gates. An LLM critic may explain evidence, but cannot override a failed hard gate.
8. Final synthesis and commit occur in a fresh cell against the current base revision.

### Implementation plan

**Phase 1 — deterministic verifier registry**

- Define typed verifier inputs, outputs, severity, confidence, runtime, and artifact links.
- Support repository commands, API assertions, browser workflows, policy queries, and custom project verifiers.
- Separate hard gates from weighted preferences.

**Phase 2 — branch scheduler**

- Add branch budgets for tokens, model calls, wall time, CPU/GPU, and cell count.
- Add diversity rules so branches do not merely restate the same plan.
- Add duplicate-work detection from affected files, commands, and structural patch fingerprints; this does not require vector memory.
- Add early stopping and operator cancellation.

**Phase 3 — replay and synthesis**

- Save typed branch checkpoints and tool results.
- Fork from promising intermediate states while excluding invalid later actions.
- Add conflict-aware synthesis with mandatory full verification.
- Calibrate the scorecard on real NexusHarness tasks before enabling automatic winner selection.

### Success gates

- Balanced search improves objective pass rate by at least 20% over the direct loop on a held-out local task suite.
- Median compute increase stays below 2.5x; branches that cannot beat the incumbent are stopped early.
- At least 90% of selected winners are also preferred by blinded human review.
- No branch can write outside its cell or commit independently.
- Every prune and winner decision links to inspectable evidence.
- Running the same recorded task and seed reproduces branch setup, budgets, and verifier inputs.

### Main risks

- Parallel weak attempts can multiply cost without adding useful diversity.
- LLM-as-judge scoring can reward polished explanations over correct changes; deterministic gates must dominate.
- Test suites can be incomplete or gamed. The verifier must detect modified/deleted checks and require protected baseline tests.
- Branch explosion needs strict global and per-level limits.

---

## 3. Adaptive model router and local compute scheduler

### Core idea

Stop assigning one static model to Planner, Executor, and Critic. Route every bounded step according to demonstrated capability, latency, context fit, tool reliability, current VRAM/RAM pressure, and the consequence of failure. Start with the smallest model likely to pass, then escalate based on uncertainty or failed evidence.

This turns a collection of local runtimes into a self-optimizing compute fabric.

### Operator experience

- Models gains a **Routing** view with available models, measured strengths, current resource pressure, confidence calibration, and recent routing outcomes.
- A run timeline explains each decision: “7B coder selected for schema edit; escalated to 32B after two verifier failures.”
- Operator policies include **Fastest**, **Balanced**, **Highest assurance**, and a custom maximum for VRAM, energy proxy, wall time, and parallelism.
- A **shadow mode** recommends routing without changing assignments until enough local evidence exists.
- Every automatic route has a one-click pin or exclusion control.

### Routing inputs

- Task type: planning, code search, patching, UI inspection, command interpretation, test diagnosis, critique, or synthesis.
- Complexity: affected scopes, dependency graph breadth, expected tool depth, and required output schema.
- Model profile: structured-output success, tool-call validity, context capacity, language/framework results, and historical verifier pass rate.
- Runtime state: queue depth, tokens per second, time-to-first-token, recent errors, memory pressure, and warm/cold status.
- Risk: read-only exploration can use a less-proven model; destructive or release work requires higher assurance and stricter verification.
- Uncertainty: conflicting candidates, repeated corrections, malformed actions, and verifier disagreement trigger escalation.

### Implementation plan

**Phase 1 — local evaluation ledger**

- Record only structured operational outcomes: task class, anonymous project features, selected model, latency, resources, tool validity, verifier result, and escalation reason.
- Keep this ledger local, bounded, exportable, and deletable.
- Build a reproducible capability probe pack for every connected model.

**Phase 2 — rule router and shadow mode**

- Begin with explicit thresholds rather than an opaque learned router.
- Recommend routes alongside current static assignments.
- Compare estimated and actual time/quality without affecting live work.
- Add operator constraints and deterministic fallback order.

**Phase 3 — contextual learning**

- Train or update a small local router from pairwise outcomes and verifier evidence.
- Use a contextual-bandit policy with an exploration ceiling, not uncontrolled online experimentation.
- Calibrate confidence and refuse automatic selection when evidence is sparse.
- Optimize for a configurable objective such as `quality - latency - resource cost`, with release-blocker gates never traded away.

**Phase 4 — phase-level scheduling**

- Route planning, execution, criticism, visual inspection, and synthesis independently.
- Batch compatible read-only steps.
- Prewarm probable next models while a current step runs, subject to memory pressure.
- Route independent branches across multiple local devices when available.

### Success gates

- Reduce median GPU-active time by at least 35% at equal held-out verifier pass rate.
- Reduce median end-to-end time by at least 25% on mixed workloads.
- Keep automatic-route quality within two percentage points of the best fixed high-assurance model.
- Escalation recovers at least 80% of initially failed low-cost attempts that are recoverable by the strongest connected model.
- Never route a task to a model that lacks its required context, structured-output, modality, or tool capability.
- Every routing choice is reproducible from its recorded inputs and policy version.

### Main risks

- Project-specific outcomes can overfit rapidly; use held-out tasks and minimum sample thresholds.
- Latency and quality change with quantization, runtime settings, and contention. Profiles must be keyed to the full runtime/model configuration.
- “Cheapest” cannot mean least safe. Consequential actions still use proof, isolation, and deterministic verification.
- Local outcome collection must not become hidden surveillance; make its contents visible and controllable.

---

## 4. Proof-carrying operations and executable policy

### Core idea

Require each consequential action to carry a machine-readable contract before it can run. The contract declares purpose, preconditions, exact capabilities, expected effects, forbidden effects, invariants, validation, and rollback. A policy engine evaluates the contract against project and operator rules. The execution result returns evidence showing what actually happened.

Approvals become decisions over intent and proof, not guesses made from a command string.

### Action contract

```json
{
  "objectiveId": "obj-123",
  "action": "shell.exec",
  "purpose": "Run the existing unit test suite",
  "preconditions": ["package-lock.json hash equals ..."],
  "capabilities": {
    "read": ["**"],
    "write": ["coverage/**"],
    "network": [],
    "execute": ["node", "npm"]
  },
  "forbiddenEffects": ["dependency mutation", "git ref mutation"],
  "invariants": ["tracked source files remain unchanged"],
  "successEvidence": ["exit code 0", "test report schema v1"],
  "rollback": "discard cell overlay",
  "expiresAt": "..."
}
```

The broker measures actual effects and returns a receipt containing the policy version, pre/post state hashes, command identity, redacted outputs, verifier results, and any variance from the prediction.

### Operator experience

- The approval screen leads with **why**, **what can change**, **what cannot change**, **how success is proven**, and **how it is undone**.
- A visual capability map highlights new or unusual access.
- Safe repeat operations can be approved through narrow, expiring policy rules such as “allow this test command to write only coverage output for this run.”
- Any predicted/actual effect mismatch pauses the run and displays the variance.
- Projects can ship reviewed policy packs; operator policy always takes precedence.
- Audit exports form a verifiable evidence chain across planning, approval, execution, verification, and commit.

### Policy layers

1. **Non-overridable harness invariants:** workspace boundary, control claims, secret redaction, receipt generation, and cell-only mutation.
2. **Operator policy:** network destinations, command allow/deny rules, writable areas, time/resource ceilings, approval thresholds, and model restrictions.
3. **Project policy:** required checks, protected paths, dependency rules, architecture boundaries, and release conditions.
4. **Run policy:** temporary leases approved for one objective and one cell.

Conflicts resolve toward the more restrictive rule. Undefined consequential actions deny by default.

### Implementation plan

**Phase 1 — schemas and effect measurement**

- Define versioned action-contract and receipt schemas.
- Normalize file, process, network, environment, package, and Git-ref effects.
- Compare predicted effects with observed effects in the current approval flow.
- Keep enforcement advisory until false positives are understood.

**Phase 2 — policy engine**

- Embed a local policy decision point, with Rego/OPA as the leading candidate or a smaller compatible evaluator if packaging demands it.
- Ship readable default policies and a policy simulator.
- Add unit tests for allow, deny, undefined, conflict, expiry, and malformed-input behavior.
- Make policy version and decision inputs part of every receipt.

**Phase 3 — enforcement and attestations**

- Enforce contracts at the capability broker, not inside model prompts.
- Issue short-lived, single-cell capability leases after approval.
- Chain receipts using signed or hashed attestations patterned after in-toto link metadata.
- Verify the chain before commit or release.

### Success gates

- 100% of write, delete, execute, network, credential, and commit actions have a validated contract and receipt.
- Undefined consequential actions are denied.
- Actual effects outside the declared envelope always stop the run.
- Common safe operations require fewer operator decisions without broadening their permissions.
- A receipt chain detects any removed, reordered, or modified action record.
- Policy simulation can explain every decision in plain language and identify the exact rule.

### Main risks

- Models can fabricate preconditions; the harness must evaluate them independently.
- Policies can become too complex to understand. Keep defaults small, visual, tested, and deny-by-default.
- Signed receipts prove what the harness observed, not that the underlying model reasoned correctly.
- External side effects may not support rollback; those operations must be clearly classified before execution.

---

## 5. Live semantic system twin and multimodal operating fabric

### Core idea

Give the model an ephemeral, continuously reconciled representation of the computer it is operating—not a long-term memory store. The system twin is a current-state graph of resources, applications, views, processes, files, terminals, services, and relationships. Actions target stable semantic entities first and screen coordinates only as a last resort.

This can move NexusHarness beyond coding into reliable cross-application work while reducing brittle “look at screenshot, click coordinate, hope” behavior.

### What the twin contains

- Workspace files, symbols, generated artifacts, Git state, and active execution cells.
- Processes, services, ports, resource pressure, and health.
- Terminal sessions with command, cwd, exit state, and produced effects.
- Browser tabs, URLs, document landmarks, forms, downloads, and authenticated-domain boundaries.
- Desktop windows and accessibility trees, with screenshot regions linked to semantic nodes.
- Pending approvals, control claims, active branches, policy leases, and operator interventions.
- Freshness, provenance, confidence, and last-observed time for every node.

It does **not** become semantic memory. Old state is compacted into audit receipts; the active twin is rebuilt and reconciled from live adapters.

### Action protocol

Each action follows an observe-decide-act-confirm loop:

1. **Observe:** request the smallest relevant semantic state slice.
2. **Decide:** choose an entity and operation using stable identifiers.
3. **Contract:** declare expected state transition and required capability.
4. **Act:** prefer a structured API/MCP operation; fall back to accessibility-tree interaction; use coordinate interaction only when neither exists.
5. **Confirm:** reconcile the live state and compare it with the expected transition.
6. **Recover:** retry through a different modality, ask the operator, or roll back when confidence or state diverges.

### Operator experience

- A new **System** workspace visualizes live resources and relationships without exposing hidden model reasoning.
- Operators can answer “what is the model looking at?”, “what does it believe is selected?”, “how fresh is that fact?”, and “what will change next?”
- Cross-application workflows appear as one timeline with semantic transitions, screenshots only where they add evidence, and explicit handoff points.
- When the twin sees conflicting or stale state, NexusHarness asks a focused question instead of guessing.
- A **Teach this control** action lets the operator map a brittle visual target to a stable semantic operation for future runs.

### Implementation plan

**Phase 1 — resource graph and adapters**

- Define versioned `Resource`, `Observation`, `Relationship`, `Action`, and `TransitionReceipt` schemas.
- Build adapters for the existing workspace, terminal, runtime, MCP, run, approval, and control-plane state.
- Add freshness and confidence; stale facts cannot authorize action.

**Phase 2 — browser operating plane**

- Add a browser adapter using DOM/accessibility semantics, network/download events, and bounded screenshots.
- Implement stable element identity across rerenders where possible.
- Require post-action state confirmation for navigation, submission, download, and destructive UI operations.

**Phase 3 — desktop operating plane**

- Add Windows UI Automation/accessibility-tree integration.
- Fuse semantic nodes with screenshot regions for controls that lack usable programmatic metadata.
- Add window/application boundaries, protected surfaces, and explicit credential-entry handoffs.
- Run all unfamiliar applications inside an execution cell or isolated desktop provider when possible.

**Phase 4 — cross-application workflow compiler**

- Compile objectives into a graph of typed transitions rather than a flat command list.
- Add mid-workflow event handling for dialogs, notifications, new files, authentication requests, and changing remote data.
- Add reusable, testable workflow components without hiding their effects or permissions.

### Success gates

- At least 90% of browser actions use semantic identifiers rather than coordinates.
- Every state-changing action has a confirmed postcondition or visibly stops as uncertain.
- Held-out cross-application workflows complete with at least 30% fewer steps than a screenshot-only baseline.
- The system detects injected dialogs, changed pages, missing files, and stale selections before the next consequential action.
- Credential entry, payment, account changes, and other protected transitions always require explicit operator policy/approval.
- A replay can reconstruct observations and state transitions without storing secret values.

### Main risks

- Accessibility trees and application APIs can be incomplete or inconsistent.
- A live graph can become too large; state slices need strict relevance, freshness, and size budgets.
- Screen content may contain untrusted prompt injection. Observed text is data, never policy or instruction authority.
- General computer use dramatically expands privacy and security exposure; the isolation and proof systems must ship first.

---

## Shared architecture required by all five

These upgrades should share primitives rather than creating five independent subsystems:

| Primitive | Used by |
| --- | --- |
| Versioned objective and action schemas | all five |
| Execution cells and capability broker | transactional cells, branch search, policy, system twin |
| Deterministic verifier registry | cells, branch search, router, policy |
| Effect and transition receipts | cells, search, policy, system twin |
| Local outcome metrics | branch search, router, system twin |
| Resource budgets and cancellation | cells, search, router, system twin |
| Control-plane claims | cells, branch search, policy |
| Human approval and uncertainty protocol | all five |

The control plane should become the coordination authority for both human/agent work claims and runtime execution-cell leases. A repository scope can have one commit owner while several read-only or isolated candidate branches explore it. Only the winner receives a short commit lease after current-base verification.

## Recommended delivery sequence

### Release A — observability and contracts

- Versioned objectives, action contracts, effect receipts, verifier registry, and local outcome measurements.
- Advisory-only effect comparison and policy simulation.
- No increase in autonomy.

### Release B — transactional execution

- Portable worktree cells, cell-only mutation, atomic file commit, rollback, resource budgets, and crash recovery.
- Hardened Windows/Linux providers remain opt-in until adversarial review passes.

### Release C — executable policy

- Deny-by-default consequential actions, expiring capability leases, receipt-chain verification, and redesigned approvals.
- Make hardened isolation the default where supported.

### Release D — adaptive compute

- Router shadow mode, capability probes, rules-based selection, confidence calibration, then opt-in local learning.
- Publish measured quality/latency/resource comparisons before enabling automatic routing.

### Release E — solution search

- Two-branch bounded search first, deterministic winner gates, early stopping, replay, then controlled synthesis.
- Never enable unbounded fan-out.

### Release F — semantic operating fabric

- Existing NexusHarness resources, then browser semantics, then isolated desktop applications.
- Treat unrestricted host desktop operation as a major security boundary and a likely major-version change.

## Program-level evaluation

Create a private, reproducible Frontier Evaluation Suite containing:

- Repository repair and feature tasks with hidden tests.
- Unsafe requests designed to test boundary enforcement.
- Conflicting concurrent tasks that exercise claims and stale-base protection.
- Tasks where a small model is sufficient and tasks that require escalation.
- Tasks with two valid but architecturally different solutions.
- Browser and desktop workflows with dynamic dialogs, changed state, and injected untrusted text.
- Crash, cancellation, timeout, low-disk, lost-runtime, and host-restart scenarios.

Track success rate, verified-regression rate, operator interventions, escaped/undeclared effects, wall time, model time, tokens, VRAM/RAM pressure, energy proxy, branch utilization, rollback success, and receipt completeness. Do not claim improvement from a benchmark score alone; require held-out task gains and blind operator review.

## Final recommendation

Start with **transactional execution cells** immediately after v2.0.0. It creates the safety and reversibility boundary needed by every more ambitious idea. Design **proof-carrying operations** at the same time so the cell broker has a principled authorization model. Run the **adaptive router** in shadow mode while those foundations mature. Only then introduce **branch-and-prove search**, because parallel autonomy without isolation and proof would multiply risk. Build the **semantic system twin** last and initially constrain it to the browser and isolated environments.

If implemented in this order, NexusHarness would no longer be merely another multi-agent dashboard. It would become a local-first, evidence-driven execution plane where models can explore aggressively inside bounded worlds, prove what they accomplished, and change the operator's real system only through a controlled, reversible commit.

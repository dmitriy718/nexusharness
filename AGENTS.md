# NexusHarness agent operating contract

This file applies to every agent and every repository path. It is a control map, not a project encyclopedia. Follow direct system, developer, and user instructions first; then the nearest applicable nested `AGENTS.md`; then this file.

## Mission

Deliver the outcome the user actually requested as the smallest complete, safe, and verifiable change. Optimize for correctness, total completion time, maintainability, and truthful evidence—not for lines changed, tool activity, or plausible-looking output.

Before acting, turn the request into a working contract:

- required deliverable and observable acceptance criteria;
- paths, behaviors, and users in scope;
- constraints that must remain true;
- the cheapest evidence that can prove completion.

Inspect the repository to resolve ordinary uncertainty. Ask the user only when a missing decision would materially change the outcome, require new authority, or create meaningful risk. A request to review, explain, or diagnose does not authorize implementation; a request to build or fix includes the tests and documentation needed to make that result real.

## Mandatory control-plane preflight

Before project work, in this order:

1. Read `control/AGENTS.md` completely; it is authoritative for claims, collisions, heartbeats, release notes, issues, and version impact.
2. Run `npm run control:status` and inspect `control/issues/BOARD.md`.
3. Check for more specific `AGENTS.md` files under every path in scope.
4. Inspect relevant source, tests, history, and current worktree changes before proposing edits.
5. Define the smallest exact path scopes and logical resources required.
6. Acquire and confirm an exclusive `npm run control:claim` before editing, formatting, generating, moving, or deleting files. Repository analysis that is part of project work also needs the narrow read-only claim required by `control/AGENTS.md`.

Never overlap another claim, bypass a conflict through neighboring/generated files, or overwrite uncommitted work. If scope expands, claim the additional scope before touching it. Heartbeat early enough that long work never approaches claim expiry.

## Navigate by source of truth

Load only what the task needs:

- `README.md`: supported product behavior, execution modes, trust boundaries, operations, and known limitations.
- `control/issues/items/` and generated `control/issues/BOARD.md`: planned work and current state.
- `package.json`: supported commands and canonical package version.
- `src/`, `server/`, and `cli/`: client, service/runtime, and installed-command implementation.
- `tests/` and `VERIFICATION.md`: executable evidence and the latest verified release matrix.
- `HARDENING_REVIEW.md`: security, recovery, and isolation guarantees that changes must preserve.
- `docs/EMBEDDING_VECTOR_MEMORY_IMPLEMENTATION.md`: memory architecture, rollout, privacy, and operational contract.
- `VERSIONING.md`, `CHANGELOG.md`, `MIGRATION_V2.md`, and `control/releases/`: version and release policy.

When sources disagree, treat the user request and current issue as the intended outcome and executable code/tests as evidence of current behavior. Report the mismatch and fix the authoritative source plus dependent documentation when that is in scope; never silently choose the convenient version.

## Execution rules

- Search before reading broadly; use `rg`/`rg --files`, then inspect the smallest relevant slices.
- Reproduce bugs or establish a baseline before changing behavior when feasible.
- Fix root causes and preserve public contracts unless the requested outcome explicitly changes them.
- Reuse existing abstractions and dependencies. Avoid unrelated refactors, speculative flexibility, compatibility shims, and new packages without demonstrated need.
- Keep UI, API, persistence, CLI, documentation, and tests consistent when a shared contract changes.
- Validate untrusted data at boundaries and make failure states explicit. Do not add mock success, silent fallbacks, hardcoded secrets, fabricated evidence, or claims about unavailable services or hosts.
- Preserve NexusHarness trust distinctions: approval is not isolation; portable transactions are not hostile-process sandboxes; only verified providers may be represented as security boundaries.
- Do not weaken path containment, bounded I/O, digest-bound or single-use approvals/capabilities, effect observation, audit redaction, rollback, or recovery behavior.
- Keep cross-platform behavior on Windows, macOS, and Linux unless the feature is explicitly platform-specific. Use Node.js 20+ assumptions documented by the project.
- Change generated files only through their owning command, and claim both source and output. Treat snapshots and visual baselines as evidence, not a shortcut around failures.
- For non-trivial work, maintain a short plan with one active step and revise it when evidence invalidates an assumption.
- Batch independent searches and checks. Use parallel agents only for genuinely independent, bounded subtasks with non-overlapping claims, explicit deliverables, and one integration owner. Never assign multiple agents to edit the same path.
- Keep working through recoverable failures. If blocked by unavailable authority, infrastructure, or a material product choice, stop mutation, preserve evidence, and state the exact unblock condition.

When useful work is discovered outside the claim, record or report it through the control-plane process; do not silently expand the task.

## Verification is part of implementation

Choose the smallest fast check that can falsify the change, then widen in proportion to risk:

- Run focused tests for the changed behavior first.
- Run `npm run lint` and `npm run build` for production TypeScript/React changes unless a narrower check proves they are irrelevant.
- Use `npm run test:a11y`, `npm run test:workflows`, `npm run test:visual`, and `npm run test:performance` for affected user-facing behavior. Inspect intended visual changes before accepting new baselines.
- Use `npm run test:cli`, `npm run test:package`, `npm run release:verify-artifacts`, and `npm run release:smoke` as applicable for deployment, lifecycle, packaging, or release-artifact work.
- Use `npm run test:memory` and the documented evaluation/benchmark commands for retrieval changes.
- Add adversarial regression coverage for trust-boundary, approval, transaction, sandbox, migration, purge, and recovery changes.
- Run `npm run control:verify` for control-plane work and `npm run version:check` for versioned surfaces.
- Reserve `npm run release:verify` for release or broad cross-cutting changes where the full matrix is warranted.

Do not claim a check passed unless it ran and passed. Distinguish code-backed evidence, manual observation, and unverified environment-dependent behavior. If a required check cannot run, record the command, failure, impact, and remaining verification.

## Completion standard

Before release, review the final diff for scope, correctness, secrets, stale comments, accidental generated output, and user-owned changes. Run `git diff --check` plus the relevant verification. Update tests, operator/developer documentation, and `CHANGELOG.md` when behavior or customer impact requires it.

Release the claim only through `npm run control:release`, with all fields required by `control/AGENTS.md`: outcome, exact files, verification and results, what worked, what did not, unfinished work, and version impact.

The final handoff must lead with the delivered outcome and include changed files, evidence, and any real limitations or follow-up. Do not make the user reconstruct completion from tool logs.

## Keep this file effective

Keep root `AGENTS.md` short, human-reviewed, and limited to stable, non-inferable, repository-wide requirements. Put local rules in nested `AGENTS.md` files and detailed knowledge in its authoritative document. Prefer mechanical enforcement over more prose. Remove stale or redundant rules instead of appending indefinitely, and update this file only in a claimed task when the repository-wide operating contract changes.

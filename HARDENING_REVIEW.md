# NexusHarness v2.0.0 hardening review

Date: 2026-07-11

## Outcome

NexusHarness v2 replaces the original dashboard and loosely coupled agent path with a responsive, accessible operator surface; durable workflow checkpoints; synchronized release identity; project-level coordination; and explicit execution modes whose guarantees are shown without conflating approval, transaction isolation, and operating-system isolation.

The final automated matrix passes 249 core tests (21 skipped), six accessibility suites, five consequential workflow suites, six visual suites, four performance suites, strict lint, both production builds, production smoke, package validation, version identity, and control-plane integrity.

## Product and UX hardening

- Rebuilt the interface around responsive Chat-first, Studio, and Agent Control workspaces with shared navigation and state.
- Added guided first-run setup, non-persisting runtime tests, discovered-model review, explicit saves, health/latency feedback, and assignment compatibility guidance.
- Made run phase, iteration, executor progress, validation, critique, approval, execution provider, effects, receipts, audit linkage, and recovery state inspectable.
- Added contextual approvals with commands, hashes, diffs, declared effects, and clear risk/policy language.
- Added searchable model and MCP capability inventories, safe tool enablement, memory management, issue visibility, settings impact, and version/build identity surfaces.
- Verified keyboard flow, focus visibility, landmarks, names, contrast, reduced motion, forced colors, touch targets, narrow reflow, high zoom, and representative screen-reader operation.
- Removed the external Google Fonts dependency and hardened loading, empty, error, destructive, and unavailable states.

## Agent and runtime hardening

- Corrected the lifecycle to validate objective results before critique and use validation failures as revision input.
- Normalized, deduplicated, scored, and bounded Planner output; empty or pathological plans fail safely.
- Added bounded parallel first-pass execution in compatibility mode and a single checkpoint-aware integration owner for revisions.
- Persisted plan, phase, iteration, executor, validation, critic, approval, cancellation, transaction, and retrospective checkpoints.
- Added duplicate-resume protection, cancellation, interrupted-run recovery, and bounded runtime/MCP client caching.
- Corrected OpenAI-compatible tool continuation, strict critic score parsing, connector-shape validation, text-only JSON tool fallback, and surfaced runtime inventory failures.

## Workspace, approval, and audit hardening

- Enforced real-path workspace containment, symbolic-link escape rejection, root deletion prevention, and existing-directory validation.
- Bounded task, file, command, response, tree, runtime, and tool-result sizes; added paged reads.
- Bound write approvals to exact before/after hashes and sizes, consumed risky approvals once, and recorded bounded diffs.
- Made store writes atomic, migrated older settings deeply, preserved operator MCP enablement across refresh, and corrected missing-resource/error HTTP behavior.
- Added explicit audit mode, security headers, compact state, health endpoints, correct API 404s, and production startup from compiled artifacts.

## Transaction and isolation hardening

Three modes now state materially different guarantees:

1. **Compatibility:** workspace/path/approval/audit controls, but host shell and MCP retain the NexusHarness process's authority.
2. **Portable transactional:** detached Git worktree effects, versioned objectives and contracts, single-use leases, policy decisions, observer-sourced effects, variance detection, chained receipts, validation gates, atomic promotion, rollback, teardown, and restart/orphan recovery. It is not hostile-process or network isolation; arbitrary model shell and MCP are excluded.
3. **Windows Sandbox:** the transactional proof path plus a real Windows virtualization boundary for brokered PowerShell. Commands declare predicted effects, execute only in the guest, fail closed on launcher/receipt/effect variance, keep the primary checkout unchanged until promotion, and never fall back to host execution.

The real-host Windows isolation and end-to-end brokered command probes passed under HR-004 and HR-005. The Firecracker+jailer code validates a hardened networkless launch profile, non-root identity, bounded resources, cgroups, jailed paths, and required host capabilities, but correctly reports `securityBoundary=false` until HR-006 supplies Linux/KVM evidence.

## Release and governance hardening

- Established `control/AGENTS.md`, scoped collision-checked claims, heartbeats, takeover rules, archived finishing notes, dated worklogs, stable issue records, and a generated board.
- Made `package.json` the SemVer source of truth and added drift detection/synchronization for lockfile, marketplace, API, UI, artifacts, changelog, package, and tag workflow.
- Added the full `release:verify` matrix, production smoke, package contents/size validation, migration guide, final changelog, manual checkpoints, and two-perspective verification.
- Preserved truthful gates: approvals are not called sandboxes, portable worktrees are not called hostile-process boundaries, and untested Linux or connector behavior is not reported as verified.

## Remaining hardening work

- Complete HR-006 on an appropriate Linux/KVM host before selecting Firecracker+jailer as a verified provider.
- Design explicit compensation/idempotency semantics before admitting MCP or other remote effects into transactional modes.
- Add hardened provider capability negotiation for guest toolchains beyond base Windows PowerShell.
- Continue transaction migration for additional connectors only where effects can be observed, bounded, and recovered truthfully.
- Treat operator-provided model runtimes, MCP servers, validation commands, and compatibility-mode shell as separate trust domains.

These remaining items do not invalidate the v2.0.0 release claims; they remain explicitly limited or unavailable in the released product.

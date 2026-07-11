# Changelog

All notable NexusHarness changes are documented here. The format follows Keep a Changelog and versions follow Semantic Versioning.

## [Unreleased]

### Added

- Began the v2.1 transactional execution foundation with versioned objectives, action contracts, capability leases, effect receipts, cell specifications, commit receipts, deterministic digests, and finite lifecycle validation.
- Added an explicit-mode capability broker with policy evaluation, atomic single-use leases, observer-sourced effect comparison, blocking variance detection, chained receipts, canonical output digests, and redacted audit linkage.
- Added the portable transaction provider for clean-repository disposable worktrees, bounded effect inventories, lifecycle persistence, interrupted-state recovery, receipt-gated stale-base-safe promotion, and owned-worktree teardown; it is explicitly not a hostile-code sandbox.
- Added an optional run-detail execution inspector for truthful provider boundaries, cell lifecycle, capability leases, resource budgets, observed effects, variance, verification evidence, and backend-guarded commit/rollback availability.
- Kept full execution-cell effects, variance, evidence, and capability detail in the dedicated run-detail response while compact polling and paged history return bounded run summaries.
- Added a provider-neutral transaction service that serializes cell operations, owns prepare/execute/verify/commit/rollback/destroy transitions, persists mutation-safe run summaries, requires passing receipt evidence before promotion, discloses bounded-detail truncation, and passes receipt digests into atomic commits.
- Added a run-scoped transaction adapter and durable execution-summary sink with cell-binding, monotonic-update, unknown-run, and mutation-isolation guards so lifecycle state can reach the owning run without entering compact history payloads.
- Added retry-safe provider action preflight before transaction state or receipt consumption, allowing approval-required file actions to remain isolated and resumable instead of poisoning their execution cell.
- Added an enforced portable file-write executor with digest-bound approval plans, time-of-check/time-of-use drift rejection, broker receipts, observed create/update effects, and redacted audit linkage.
- Added a Windows Sandbox launcher candidate with hardened single-folder profiles, network/clipboard/device redirection disabled, protected-client mode, bounded resources, abort/deadline handling, temporary-profile cleanup, availability probing, and an owner-run real-host isolation probe; it remains explicitly unverified as a security boundary pending HR-004.
- Repaired the Windows Sandbox probe lifecycle so host launcher exit no longer deletes its profile or mapped folder before the guest writes a validated completion file.
- Repaired real-host probe shutdown and cleanup by removing guest-forced shutdown, closing only probe-created Sandbox sessions, preserving pre-existing sessions, and retrying transient mapped-folder locks.
- Made Windows Sandbox probe result interchange BOM-safe by emitting BOM-free UTF-8 in the Windows PowerShell guest and accepting legacy BOM-prefixed JSON on the Node host.
- Made an empty Windows Sandbox session list a successful preflight result instead of treating PowerShell's no-process exit code as a probe failure.
- Accepted HR-004 real-host evidence and promoted the hardened Windows Sandbox launcher from an unverified candidate to a verified virtualization boundary; full execution-cell integration remains pending.
- Added the `windows-sandbox` execution-cell provider by composing the verified Sandbox action boundary with isolated Git staging, mutation-safe persisted records, snapshots, effects, receipt-gated promotion, teardown, and interrupted-state recovery; only explicitly Sandbox-isolated action executors are accepted.
- Moved Windows Sandbox remote-session ownership into the reusable launcher so every caller preserves pre-existing sessions, closes only sessions it created, and cleans temporary profiles even when session teardown fails.
- Added brokered Windows Sandbox PowerShell command transport with digest-bound registration, approval preflight, encoded guest scripts, bounded BOM-safe results, one-use output retrieval, host-observed Git effects, single-use leases, and redacted failure receipts.
- Accepted HR-002 owner evidence and closed the manual NVDA/Chrome assistive-technology gate with no reported findings.
- Added an owner-run real Windows Sandbox command-provider probe covering digest-bound execution, broker receipts, unchanged-primary isolation, host-observed effects, receipt-gated promotion, writeback, and teardown.
- Began the hardened Linux provider with a fail-closed Firecracker+jailer launch-profile foundation requiring dedicated UID/GID, normalized non-colliding jail paths, an explicit cgroup parent, a new PID namespace, file limits, bounded CPU/memory, read-only boot parameters, and no guest network interfaces; the built-in seccomp default and every real isolation property remain subject to HR-006 Linux/KVM verification.
- Added fail-closed composite portable-action dispatch that binds each admitted contract and lease digest to exactly one registered executor, rejects missing or duplicate action routes, and prevents admission replay or action-kind switching while file, shell, and remote-effect adapters are migrated independently.
- Added a broker-enforced regular-file deletion adapter with bounded pre-image registration, contextual approval, pre-approval and post-approval drift rejection, required observed deletion effects, and explicit refusal of recursive directory deletion.
- Added injectable lease-use and receipt-chain stores to routed file adapters so a composed cell can enforce single-use authority and one tamper-evident receipt chain across action kinds instead of accidentally isolating broker state per adapter.
- Made the HR-005 real Windows Sandbox command probe emit a bounded redacted assertion matrix before failure, exposing receipt/result/exit/isolation/effect conditions and safe variance/evidence metadata without command or output content.
- Hardened Windows Sandbox command bootstrap failures into structured stage/type diagnostics and replaced the nested `Start-Process` handoff with synchronous encoded PowerShell execution and explicit `$LASTEXITCODE` capture.
- Repaired the Windows Sandbox command executor's launcher contract by replacing rejected dot-prefixed bootstrap/completion names with alphanumeric-first safe transport filenames and enforcing the real naming rules in its controlled-launcher tests.
- Accepted HR-005 real-host evidence for brokered Windows Sandbox PowerShell execution, observed file effects, unchanged-primary isolation, redacted diagnostics, receipt-gated commit, promotion, and audit linkage.

## [2.0.0-beta.1] - 2026-07-11

### Added

- Midnight Prism design tokens, local brand mark, responsive routed shell, and accessible navigation foundation.
- Six-step onboarding, readiness dashboard, searchable run history, detailed run timeline, contextual approval review, and grouped operator settings.
- Responsive production-browser checks for route headings, accessible control names, and horizontal overflow at desktop and 390 px widths.
- Focus run workflow with resumable drafts, duplicate/prefill, eligibility-aware retry/cancel actions, functional output/activity inspector tabs, and portable summaries.
- Contextual approval review with originating run/subtask links, shell/cwd context, pre-execution file diffs and hashes, recursive-delete warnings, and redacted raw payloads.
- Full local audit ledger with actor/risk/status/action filters, chronological sorting, run and target linkage, a formatted event drawer, responsive windowing, and explicitly scoped redacted JSON export.
- Guided runtime setup that tests without persistence, reviews discovered models before save, reports session health/latency, exposes searchable capabilities, and provides explicit-save agent assignments with tool compatibility guidance.
- Bounded MCP discovery with real chunk progress and cancellation, HTTP/stdio guided setup, inspected server details, searchable risk-classified tools, JSON schemas, protected bulk/per-tool toggles, and a separate local-tool policy view.
- Safe lazy workspace explorer with bounded server search, keyboard expansion, breadcrumbs, file metadata, line-numbered/binary-aware previews, explicit symlink blocking, path copy, parent reveal, and run-draft context handoff.
- Searchable memory knowledge base with kind/task/source facets, pin-first sorting, complete source-aware editing, provenance timestamps, distinct retrospectives, explicit save state, and ten-second delete undo.
- Seven routed settings sections with persistent labels/units/bounds, section defaults, synchronized build facts, approval-off confirmation, sticky Save/Discard state, and navigation/unload protection for unsaved drafts.
- Categorized API failures, distinct boot/online/reconnecting/stale/offline states, freshness indicators, retry/copy/dismiss recovery, accessible toasts, reference-stable compact polling, and draft preservation across unrelated live updates.
- Three truthful run workspaces: Focus for narrative inspection, Studio for bounded real-workspace browsing and file context, and Orchestrate for saved subtask, agent, approval, and audit activity.
- A production accessibility gate that scans every major route and populated workflow state with axe, plus checks semantic contrast, keyboard behavior, focus containment and return, 320 px reflow, 200% zoom, reduced motion, and touch targets.
- Rendered shared-component interaction tests and 36 reviewed Midnight Prism visual baselines spanning six representative workflows at every required desktop, tablet, and mobile viewport.
- Measured production performance budgets for shell readiness, layout stability, bounded audit rendering, immediate settings navigation, and draft-safe compact polling.
- In-product Help and About sections, v1-to-v2 migration/rollback guidance, local install metadata, and isolated production build/API identity smoke verification.
- Consequential production-workflow checks for one-use approval rejection, failed runtime setup without persistence, and settings draft discard/save behavior.
- Permanent forced-colors and 400% device-scale accessibility checks, concurrent control-plane collision tests, version-drift repair tests, and an npm package dry-run integrity gate.

### Changed

- Replaced the single-file v1 dashboard with typed API contracts, app state provider, shared components, feature routes, and layered styles.
- Renamed the run perspectives to Focus, Studio, and Orchestrate, with persistent mode selection and distinct responsive interfaces for each workflow.
- Legacy planner and subtask objects are normalized for presentation instead of appearing as object-coercion text.
- The visible phase rail now matches the hardened backend order: objective validation completes before Critic scoring.
- Rejected approvals now fail their recorded originating waiting run directly instead of relying only on error-message matching.
- Approval decisions preserve their run and subtask context in the audit ledger, and the compact state poll no longer limits the dedicated audit view to 200 events.
- Runtime removal now identifies and clears affected agent roles, while unavailable saved assignments remain visible instead of silently appearing unassigned.
- MCP client identity now follows the synchronized application version instead of advertising the legacy v0.1.0 identifier.
- Workspace path-policy violations now return actionable HTTP 400 responses while preserving the resolved-root and symbolic-link boundary checks.
- Strengthened route announcements, visible focus, modal navigation and audit focus handling, arrow-key tabs, field-error associations, disclosure-list workspace semantics, secondary-text contrast, and coarse-pointer targets.
- Replaced compact-state-only run history with bounded server-side search/status paging and complete older-run detail, audit, approval, deep-link, and duplicate context.

## [2.0.0-alpha.1] - 2026-07-11

### Added

- Repository control plane with atomic work claims, collision prevention, heartbeats, stale takeover, archived completion notes, worklogs, issue board, and release checklist.
- Formal UX/UI audit and v2.0.0 renovation plan.
- Synchronized application, marketplace, API, and client build identity checks.

### Changed

- Began the NexusHarness v2 prerelease line under Semantic Versioning.

## [0.1.0] - 2026-07-10

### Added

- Initial local-first harness with task execution, local runtimes, MCP, workspace tools, memory, approvals, audit logs, and operator settings.

[Unreleased]: https://github.com/dmitriy718/mir/compare/v2.0.0-beta.1...HEAD
[2.0.0-beta.1]: https://github.com/dmitriy718/mir/compare/v2.0.0-alpha.1...v2.0.0-beta.1
[2.0.0-alpha.1]: https://github.com/dmitriy718/mir/compare/4c6c364...v2.0.0-alpha.1
[0.1.0]: https://github.com/dmitriy718/mir/releases/tag/v0.1.0

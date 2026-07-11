# Changelog

All notable NexusHarness changes are documented here. The format follows Keep a Changelog and versions follow Semantic Versioning.

## [Unreleased]

### Added

- Midnight Prism design tokens, local brand mark, responsive routed shell, and accessible navigation foundation.
- Six-step onboarding, readiness dashboard, searchable run history, detailed run timeline, contextual approval review, and grouped operator settings.
- Responsive production-browser checks for route headings, accessible control names, and horizontal overflow at desktop and 390 px widths.
- Focus run workflow with resumable drafts, duplicate/prefill, eligibility-aware retry/cancel actions, functional output/activity inspector tabs, and portable summaries.

### Changed

- Replaced the single-file v1 dashboard with typed API contracts, app state provider, shared components, feature routes, and layered styles.
- Renamed the run perspectives to Focus, Studio, and Orchestrate; unfinished modes are explicitly labeled Preview.
- Legacy planner and subtask objects are normalized for presentation instead of appearing as object-coercion text.
- The visible phase rail now matches the hardened backend order: objective validation completes before Critic scoring.

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

[Unreleased]: https://github.com/dmitriy718/mir/compare/v2.0.0-alpha.1...HEAD
[2.0.0-alpha.1]: https://github.com/dmitriy718/mir/compare/4c6c364...v2.0.0-alpha.1
[0.1.0]: https://github.com/dmitriy718/mir/releases/tag/v0.1.0

# NexusHarness control-plane rules

## Mandatory preflight

Every agent must:

1. Read the root AGENTS.md and this file.
2. Run npm run control:status.
3. Read control/issues/BOARD.md when it exists.
4. Define the smallest exact path scopes and logical resources needed.
5. Acquire a claim and verify that it appears as active before changing repository files.

Read-only inspection should still be announced with a narrow claim when it is part of project work. Exclusive claims are the default. If a task expands, release it or acquire additional non-conflicting scope before touching the new area.

## Scope collision rules

Claims conflict when they have the same file or directory, a parent/child path relationship, overlapping wildcard prefixes, the same logical resource, or a repository-wide scope.

Logical resources cover cross-cutting work that paths do not capture, including control-plane, release-metadata, dependencies, design-tokens, routing, api-contracts, and build-system.

## While working

- Preserve user changes and unrelated work.
- Do not bypass a conflict by editing generated output or a neighboring file.
- Heartbeat before the configured expiry.
- Add newly discovered work to the issue board rather than silently expanding scope.
- Keep customer-facing changes eligible for CHANGELOG.md.

## Claim release requirements

Release notes must state the summary, files changed, verification performed and its result, what worked, what did not work, unfinished work, and version impact.

Use the release command; it archives the claim and writes the worklog. Never manually remove active claim files. Stale claims require explicit takeover handling and may not be silently discarded.

## Version policy

Use Semantic Versioning. package.json is the version source of truth. Every claim declares none, patch, minor, or major impact. v2 work targets 2.0.0 and must satisfy control/releases/v2.0.0.md.

## Bootstrap status

The one-time bootstrap exception ends immediately after control-plane-bootstrap is acquired. All subsequent work, including further control-plane edits, must be claimed normally.

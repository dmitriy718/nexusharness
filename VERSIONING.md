# NexusHarness versioning and release policy

NexusHarness uses Semantic Versioning. package.json is the version source of truth.

## Version meaning

- Major: incompatible behavior, data migration, removed capability, or an intentionally breaking workflow.
- Minor: backward-compatible functionality or a substantial UX capability.
- Patch: backward-compatible fixes, accessibility corrections, and internal improvements.
- Prerelease: alpha.N, beta.N, and rc.N builds used before a stable release.

The active v2.1 prerelease progression is:

    2.1.0-beta.N -> 2.1.0-rc.N -> 2.1.0

Never reuse or move an existing release tag. Publish fixes as a new Semantic Version.

## Change tracking

CHANGELOG.md contains customer-facing changes under Added, Changed, Fixed, Deprecated, Removed, and Security. Every control-plane claim declares its version impact and records unfinished work.

Commit prefixes follow the Conventional Commits vocabulary: feat, fix, refactor, perf, docs, test, build, ci, and chore.

## Synchronizing identity

After changing package.json through npm version:

    npm run version:sync
    npm run version:check

The sync command updates `package-lock.json`, the published `npm-shrinkwrap.json`, and `marketplace.json` from `package.json`. The client build receives version, commit, build time, and mode through Vite. The API reads the package version at startup and returns the same identity from `/api/health`.

Production builds should set:

- NEXUSHARNESS_COMMIT to the release commit SHA.
- NEXUSHARNESS_BUILD_TIME to an ISO-8601 UTC timestamp.
- NODE_ENV to production.

## Release verification

    npm run release:verify

This validates the control plane and version identity, then runs lint, tests, and the production build. A release also requires the checklist in control/releases for its target version, a clean Git worktree, no unresolved release blockers, updated changelog notes, and an owner-approved release candidate.

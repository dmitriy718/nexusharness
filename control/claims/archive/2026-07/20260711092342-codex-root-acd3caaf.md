---
id: "20260711092342-codex-root-acd3caaf"
agent: "codex-root"
status: "released"
createdAt: "2026-07-11T09:23:42.302Z"
releasedAt: "2026-07-11T09:24:33.230Z"
versionImpact: "patch"
areas: "src/features/runs/RunsPage.tsx, src/styles/pages.css, src/styles/responsive.css, tests/performance.browser.test.ts, tests/productionHarness.ts, CHANGELOG.md, control/issues/items/NH-0007.md, control/issues/BOARD.md"
resources: "performance, run-history, release-metadata"
issues: "NH-0007"
---

# Bound and verify large run-history rendering

## Summary

Audited the run-history rendering path and identified the API boundary required for truthful paging.

## Files changed

None; read-only inspection only.

## Verification

RunsPage maps all received rows, while GET /api/state?compact=1 truncates runs to 100. Therefore a UI-only Load more control could not retrieve older history and would be misleading.

## What worked

The scoped audit located both relevant limits before implementation, preventing an incomplete client-only pagination patch.

## What did not work

The current claim did not include server/index.ts or API contracts, which are necessary for a dedicated bounded run-history endpoint.

## Unfinished work

Reclaim client, server, API contract, validation tests, and performance harness together; add server-side pagination/search/status and bounded client loading.

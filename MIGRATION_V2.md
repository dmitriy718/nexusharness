# Migrating NexusHarness v0.1 to v2

NexusHarness v2 preserves the local JSON store and core local-first capabilities, but replaces the v1 single-screen workflow with routed, safety-contextual workspaces. Read this before starting v2 against an existing project.

## Before upgrading

1. Stop every NexusHarness process that uses the project.
2. Copy `.nexusharness/store.json` to a dated backup outside `.nexusharness`.
3. Commit or separately back up the configured workspace. NexusHarness does not replace source-control or filesystem backups.
4. Record the v1 workspace root, runtime endpoints/binary paths, model assignments, shell, test command, lint command, and MCP endpoints.
5. Install dependencies and run `npm run release:verify` before using v2 with consequential work.

The v2 server merges missing settings with safe defaults. It does not intentionally rewrite runtime, memory, approval, audit, or run identifiers during startup. A run saved as `running` by an earlier stopped process is recovered as `failed` with an interruption message so it cannot appear falsely live.

## What changes in v2

- The application is deep-linkable. Overview, Runs, Agents, Models, Tools & MCP, Workspace, Memory, Approvals, Audit, and Settings have stable routes.
- Runs have Focus, Studio, and Orchestrate views. The views share one run record; switching views does not duplicate work.
- Run history is loaded in bounded pages. Older records open through a complete detail endpoint and can still be duplicated.
- Runtime setup tests connections and model inventory before saving. Agent assignments remain explicit.
- Approval records show originating run/subtask, command/shell/cwd, file target/diff/hash, delete scope, and redacted raw payload where available. Old records remain visible but cannot gain context that v1 never recorded.
- Workspace browsing is read-only in the UI, lazy, bounded, realpath-constrained, and does not follow symbolic links.
- Settings are routed drafts with inline bounds, Save/Discard state, and navigation protection.
- The repository control plane coordinates development agents. It does not grant runtime agents broader project permissions.
- `package.json` is the version source. `npm run version:sync` updates lockfile and marketplace identities; `npm run version:check` rejects drift.

## First v2 launch

1. Open Onboarding and review every step even if v1 data is already present.
2. In Models, use **Check all** and confirm every saved runtime is healthy.
3. In Agents, verify Planner, Executor, and Critic assignments; unavailable saved assignments are deliberately not hidden.
4. In Workspace, confirm the displayed root before previewing or starting work.
5. In Settings > Safety, keep approval mode on unless the workspace is trusted and restorable.
6. Review Tools & MCP capability names, risk labels, enabled state, and schemas.
7. Start a small read-only or easily reversible task, then inspect its phases, audit activity, and final result.

## Compatibility notes

- Legacy planner/subtask objects are normalized for display, but no fabricated title or output is written back to the store.
- Older approvals or audit events may lack run, subtask, target, or hash fields. The UI labels absent historical context rather than inventing it.
- Settings bounds are stricter in v2. Invalid ports, iteration counts, token budgets, paths, or empty shell values must be corrected before save.
- The MCP client identity now follows the synchronized application version.
- v2 requires Node.js versions compatible with the package dependencies and a current Chromium browser for the full automated UI gates.

## Rollback

1. Stop v2.
2. Preserve the v2 store separately if you need its new runs or audit records.
3. Restore the pre-upgrade `store.json` backup.
4. Check out the earlier application version and reinstall its dependencies.
5. Do not copy individual records between versions without validating their schema and identifiers.

Rollback cannot undo workspace writes or commands that were already approved and executed. Restore those through source control or the backup system used before the upgrade.

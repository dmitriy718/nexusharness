# NexusHarness

NexusHarness 2.0 is a local-first AI coding harness for operating real, inspectable model workflows. It connects Ollama, LM Studio, llama.cpp, and MCP tools to a responsive control surface with approval gates, durable run state, execution evidence, and a project control plane.

The v2 Midnight Prism interface is designed for three working styles—chat-first, IDE-style Studio, and Agent Control—while preserving the same underlying run, model, workspace, approval, memory, audit, and settings data. It supports keyboard operation, reduced motion, forced colors, narrow reflow, and high zoom.

This repository does not contain mock model responses, hardcoded secrets, or fabricated verification results. Missing runtimes, tools, services, or isolation capabilities fail visibly.

## Install and run

Requirements: Node.js 20 or newer and npm.

For a repeat-safe production bootstrap on Linux, macOS, WSL, or Git Bash with Node already installed:

```bash
./quickstart.sh
```

For native Windows PowerShell:

```powershell
.\quickstart.ps1
```

If local execution policy blocks scripts, use `powershell -ExecutionPolicy Bypass -File .\quickstart.ps1` for that launch. Both quickstarts validate or install Node where supported, repair dependencies from `package-lock.json`, build the application, apply memory migrations, run an isolated smoke test, and start the production UI/API at `http://127.0.0.1:8787`. If the implicit Windows default port is occupied, PowerShell identifies the owner and selects the next free loopback port; an explicit `-Port` is never silently changed. They never delete persistent NexusHarness data. Run `./quickstart.sh --help` or `Get-Help .\quickstart.ps1 -Detailed`; PowerShell switches include `-NoStart`, `-Repair`, `-Dev`, `-SkipSmoke`, `-Port`, and `-DataDir`.

```bash
npm install
npm run dev
```

Open `http://127.0.0.1:5173`. The API listens on `http://127.0.0.1:8787`.

For a production-style local build:

```bash
npm run build
npm start
```

The same build now includes the portable CLI foundation. From a source checkout, exercise it with:

```bash
npm run cli -- --version
npm run cli -- doctor
npm run cli -- open --no-open
npm run cli -- status
npm run cli -- migrate --dry-run
npm run cli -- clean --dry-run
npm run cli -- uninstall --purge --dry-run
npm run cli -- stop
```

The compiled launcher resolves its server, browser assets, and package metadata from the installation rather than the launch directory. It can be run from an unrelated directory as `node /absolute/path/to/nexus/dist-server/cli/index.js`. The production tarball uses the scoped `@nexusharness/cli` identity, installs the short `nexus` executable, and carries a reproducible production shrinkwrap. `npm run release:artifacts`, `npm run release:verify-artifacts`, and `npm run release:smoke` build, inventory, checksum, and clean-install the exact release payload. The package and Homebrew formula are not published yet; [easyDeploy.md](easyDeploy.md) records current implementation status and the remaining external ownership, hosted-CI, provenance, platform, and release gates.

Configuration examples and optional environment variables are in `.env.example`.

## First launch

1. Choose Chat-first, Studio, or Agent Control.
2. Add and test a model runtime. Saving is separate from testing so discovered models and capabilities can be reviewed first.
3. Assign models to Planner, Executor, and Critic.
4. Set the workspace root, validation commands, shell, approval mode, and concurrency in Settings.
5. Create a task and inspect its plan, live phase, evidence, approvals, output, audit history, and retrospective.

Supported model connectors include:

- Ollama
- LM Studio through its OpenAI-compatible local server
- llama.cpp server through a `/v1`-compatible endpoint
- llama.cpp CLI with an installed binary and GGUF model

Native tool calls and a strict JSON fallback are supported. Text-only models may request tools with:

```json
{
  "tool_calls": [
    {
      "name": "file_read",
      "arguments": { "path": "package.json" }
    }
  ]
}
```

## Run lifecycle

The durable workflow is:

`Plan -> Execute -> Validate -> Critique -> Revise (when needed) -> Retrospective -> Done`

Planner output is normalized, deduplicated, and bounded. Compatibility-mode first passes can use bounded parallel Executors; revisions use one integration owner so accepted work is not repeatedly overwritten. Configured lint and test commands produce objective evidence before critique. Runs persist plan, iteration, executor, validation, critic, approval, cancellation, execution, and recovery checkpoints.

Runtime inventories are cached and assigned runtimes are preflighted once per run. MCP clients are pooled with bounded idle lifetimes. Browser polling uses compact state and does not continuously query model servers during inference.

## Execution modes

NexusHarness selects its live execution behavior explicitly with `NEXUSHARNESS_EXECUTION_MODE`.

### Compatibility (default)

Compatibility mode preserves the broad v1 tool surface: workspace-scoped file tools, host `shell_exec`, and enabled MCP tools. Approval, path containment, resource bounds, hashes, diffs, and audit records still apply, but model commands execute with the NexusHarness process's operating-system authority. This is not an isolation boundary.

### Portable transactional

Portable mode stages file effects in a disposable Git worktree, routes supported mutations through action contracts and single-use capability leases, observes actual effects, and promotes only after receipt and validation gates pass. It provides transaction and worktree isolation, not hostile-process or network isolation. Arbitrary model shell and MCP are unavailable; only operator-configured validation commands may run on the host.

```powershell
$env:NEXUSHARNESS_EXECUTION_MODE = "transactional"
$env:NEXUSHARNESS_EXECUTION_DIR = "D:\nexus-execution"
npm start
```

`NEXUSHARNESS_EXECUTION_DIR` must be an absolute external data path, not the source checkout.

### Windows Sandbox

Windows Sandbox mode adds a verified Windows virtualization boundary for brokered PowerShell commands. Commands declare predicted repository file effects; the broker compares those predictions with host-observed changes, requires a successful receipt, and promotes the detached transaction only after validation and critic acceptance. It never falls back to host shell and does not expose MCP.

```powershell
$env:NEXUSHARNESS_EXECUTION_MODE = "windows-sandbox"
$env:NEXUSHARNESS_EXECUTION_DIR = "D:\nexus-execution"
npm start
```

This mode requires Windows Sandbox to be installed and enabled. The included real-host probes are interactive:

```bash
npm run test:windows-sandbox
npm run test:windows-sandbox-command
```

The Firecracker+jailer adapter is a hardened foundation only. It is not selectable as a verified security boundary until HR-006 is completed on a suitable Linux/KVM host.

## Tools and safety

The built-in file tools are constrained to `settings.workspaceRoot`:

- `file_list`
- `file_read`
- `file_write`
- `file_delete`

`shell_exec` is compatibility-only; `sandbox_exec` is Windows-Sandbox-only. Writes, deletes, and commands require operator approval when approval mode is enabled. Approvals bind writes to byte counts and before/after SHA-256 hashes, are consumed once, and are recorded in the audit log. Small text changes include a unified diff.

Real-path checks reject symbolic-link escapes, workspace-root deletion is prohibited, and files, commands, responses, trees, and tool results are bounded. File reads support `offset` and `limit` paging.

Treat model-generated requests as untrusted even when a stronger execution mode is selected. Review commands, predicted effects, diffs, validation evidence, and MCP schemas before approval.

## MCP

MCP servers can be configured over stdio or Streamable HTTP, or discovered over a bounded localhost port range. Discovered servers are disabled until reviewed. Enabled tool schemas are supplied to compatible Executors through the official `@modelcontextprotocol/sdk` client.

MCP is available only in compatibility mode in v2.0. Remote effects cannot be rolled back safely without connector-specific compensation semantics, so MCP is deliberately excluded from transactional modes.

## Embedding and vector memory

Memory retrieval supports four explicit rollout modes: `lexical_only` (default), `shadow_semantic`, `hybrid`, and diagnostic `semantic_only`. Hybrid mode generates real query embeddings, searches a durable workspace-partitioned `sqlite-vec` index, merges semantic and lexical/task/pinned candidates, applies normalized weighted ranking and diversity, and packs provenance-bearing memories with a tokenizer-enforced budget.

Available providers are local Transformers.js, Ollama `/api/embed`, and OpenAI-compatible `/embeddings`. Local model download and remote content transmission are both disabled until explicitly enabled. Remote credentials are read from `NEXUSHARNESS_EMBEDDING_API_KEY` (or the configured environment-variable name) and are never stored in project state.

The recommended rollout is:

1. Keep `lexical_only` while checking diagnostics and installing/caching the selected model.
2. Select `shadow_semantic` and run `npm run memory:backfill`.
3. Run `npm run memory:evaluate` and inspect retrieval/fallback diagnostics.
4. Select `hybrid`. Return to `lexical_only` for immediate rollback.

See `docs/EMBEDDING_VECTOR_MEMORY_IMPLEMENTATION.md` for configuration, privacy boundaries, migrations, model changes, operations, measured quality, and performance evidence.

## Local data and control plane

Application settings, runtime metadata, MCP configuration, source memories, approvals, run history, execution summaries, and audit logs use per-user platform locations by default:

```text
Windows: %LOCALAPPDATA%\NexusHarness\data
macOS:   ~/Library/Application Support/NexusHarness/data
Linux:   ${XDG_DATA_HOME:-~/.local/share}/nexusharness
```

Service state and disposable cache use the corresponding platform state/cache locations. Set `NEXUSHARNESS_DATA_DIR` to use an explicit absolute Nexus-managed root; the source quickstart scripts continue passing the checkout's `.nexusharness` directory for backward-compatible contributor workflows. New stores receive an empty Nexus-managed workspace unless `NEXUSHARNESS_WORKSPACE_ROOT` is explicitly set, and saved workspace settings continue to win afterward. NexusHarness does not require cloud authentication or send telemetry.

The service state file contains a per-launch shutdown secret and is never returned by CLI status output. `nexus stop` uses that secret to request a graceful loopback-only shutdown.

`nexus doctor` reports bounded legacy `.nexusharness` candidates. Use `nexus migrate --dry-run` to preview a verified copy into the per-user data location; migration stages and hashes every durable file, rejects links/conflicts or malformed stores/databases, records completion, and preserves the source. Use `--from PATH` when more than one candidate exists and `--non-interactive --confirm-migration` only after reviewing the preview.

`nexus clean --dry-run` previews disposable cache removal. `nexus uninstall --purge --dry-run` previews every Nexus-owned target and workspace exclusion. Actual non-interactive purge requires `--confirm-purge`; `--keep-data` preserves durable config/data, and credential entries are always reported as preserved until OS credential-store integration exists. Purge stops the service, rebuilds and compares the target plan after shutdown, refuses malformed store state or filesystem roots, never follows links, and preserves the configured workspace even when it is nested inside the Nexus data root. An explicit `NEXUSHARNESS_DATA_DIR` is treated conservatively: only recognized Nexus entries are removed and unknown siblings are reported and preserved. Run purge before removing the package executable.

Project work is coordinated through `control/`. Before changing the repository, an agent must read `control/AGENTS.md`, check for overlapping claims, acquire a scoped claim, keep it live, verify its work, and release it with finishing notes. `control/issues/BOARD.md` is the generated project board; archived claims and dated worklogs retain the evidence trail.

## Versioning and verification

NexusHarness follows SemVer. `package.json` is the version source of truth; the lockfile, marketplace manifest, UI, API, build artifacts, changelog, and Git tag are checked for drift.

```bash
npm run version:check
npm run release:verify
```

The release gate runs control-plane validation, version checks, strict lint, core tests, both builds, accessibility, consequential workflows, visual regression, performance, production smoke, and package dry-run validation. See `VERIFICATION.md`, `HARDENING_REVIEW.md`, `MIGRATION_V2.md`, and `CHANGELOG.md` for the v2.0 evidence and migration notes.

## Known limitations

- Compatibility-mode commands retain the current OS user's authority.
- Portable transactions are not a hostile-process or network boundary.
- Windows Sandbox supports the brokered PowerShell surface and available guest capabilities; it is not a promise that Node, Git, or project-specific toolchains exist in the guest.
- Transactional modes intentionally exclude MCP until explicit remote-effect compensation exists.
- Firecracker+jailer still requires real Linux/KVM verification under HR-006.
- Connector behavior depends on operator-provided local services and model capabilities.
- `sqlite-vec` provides exact KNN rather than an approximate-nearest-neighbor index; very large multi-million-vector deployments need a different `VectorStore` adapter.
- Local neural inference consumes CPU and memory; first use requires an explicitly permitted model download or a pre-provisioned model cache.
- Remote embedding providers receive normalized memory/query text only when `allowRemoteContent` is explicitly enabled; their external retention and billing policies remain operator responsibilities.

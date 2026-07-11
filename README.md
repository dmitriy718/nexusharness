# NexusHarness

NexusHarness 2.0 is a local-first AI coding harness for operating real, inspectable model workflows. It connects Ollama, LM Studio, llama.cpp, and MCP tools to a responsive control surface with approval gates, durable run state, execution evidence, and a project control plane.

The v2 Midnight Prism interface is designed for three working styles—chat-first, IDE-style Studio, and Agent Control—while preserving the same underlying run, model, workspace, approval, memory, audit, and settings data. It supports keyboard operation, reduced motion, forced colors, narrow reflow, and high zoom.

This repository does not contain mock model responses, hardcoded secrets, or fabricated verification results. Missing runtimes, tools, services, or isolation capabilities fail visibly.

## Install and run

Requirements: Node.js 20 or newer and npm.

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

## Local data and control plane

Application settings, runtime metadata, MCP configuration, memory, approvals, run history, execution summaries, and audit logs are stored locally in:

```text
.nexusharness/store.json
```

Set `NEXUSHARNESS_DATA_DIR` to move application state outside the source tree. NexusHarness does not require cloud authentication or send telemetry.

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
- Memory retrieval uses pinned, task-type, phrase, and keyword matching within a token budget; bundled embedding similarity is outside v2.0.

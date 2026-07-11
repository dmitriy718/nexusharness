# NexusHarness

NexusHarness is a local-first AI coding harness that connects local model runtimes to real agentic coding workflows. It supports Ollama, LM Studio OpenAI-compatible servers, llama.cpp server, llama.cpp CLI, MCP tools, auditable local filesystem and shell tools, approval gates, and persistent retrospectives.

This repository does not contain mock model responses, fake connectors, hardcoded secrets, or fabricated test results. If a runtime, MCP endpoint, shell, test command, or workspace path is not available, the app surfaces the real error.

## Install

```bash
npm install
npm run dev
```

Open `http://127.0.0.1:5173`. The API listens on `http://127.0.0.1:8787`.

For production-style local serving:

```bash
npm run build
npm start
```

Optional environment variables are documented in `.env.example`.

## First Launch

1. Choose a UI layout: Chat-first, IDE-style, or Agent Control.
2. Open Models and add at least one runtime. Runtime add validates the live connector and requires at least one detected model:
   - Ollama: `http://127.0.0.1:11434`
   - LM Studio: the local OpenAI-compatible server URL
   - llama.cpp server: the local `/v1` compatible endpoint
   - llama.cpp CLI: binary path and GGUF model path
3. Assign models to Planner, Executor, and Critic.
4. Set workspace root, test command, linter command, shell path, and approval mode in Settings.

## Real Workflow Behavior

The task loop is implemented as a state machine:

`Plan -> Execute -> Critic -> Revise -> Test -> Retrospective -> Done`

The Planner model must produce a JSON array of subtasks. The harness runs bounded parallel Executor sub-agents over the plan, each with its own message context and access to local/MCP tools. The Critic must return a structured score. If the score is below the configured threshold, the Executors revise until the max iteration limit is reached. Test and lint commands run through the same audited shell execution path; failures are fed back into the next Executor revision cycle until they pass or the iteration limit is reached.

For runtimes without native tool calling, including llama.cpp CLI, Executor agents can request tools through a strict JSON fallback:

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

The harness parses that structure and routes it through the same approval, audit, and tool execution path as native tool calls.

## Local Tools

Local tools are constrained to `settings.workspaceRoot`:

- `file_list`
- `file_read`
- `file_write`
- `file_delete`
- `shell_exec`

Writes, deletes, and shell execution require operator approval when approval mode is enabled. File write approvals include byte counts and old/new SHA-256 hashes, and successful write audit entries include a unified diff when the text content is small enough to display safely. Approval decisions are persisted in `.nexusharness/store.json`, are consumed on first use, and are recorded in the audit log.

## MCP

MCP servers can be added manually or discovered by scanning a localhost port range. The harness uses the official `@modelcontextprotocol/sdk` client with stdio and Streamable HTTP transports, then injects enabled tool schemas into Executor model context. Discovered servers are disabled by default so the operator can inspect them before use.

## Storage

All settings, runtimes, MCP server metadata, memory entries, approvals, run history, and audit logs are stored locally:

```text
.nexusharness/store.json
```

Set `NEXUSHARNESS_DATA_DIR` to store this state outside the source tree.

No telemetry, external authentication, or cloud service is used by this app.

## Security Notes

- Run NexusHarness only on machines and workspaces you control.
- Keep approval mode enabled for marketplace/customer installs.
- Model and MCP endpoints are operator-provided and may execute tool calls requested by model output.
- Shell commands run inside the configured workspace root, but they still execute with the current OS user permissions.
- Do not expose the API port to untrusted networks.
- Review MCP tool schemas before enabling servers or tools.
- Treat model-generated tool calls as untrusted requests; approval mode is the default safety boundary for writes and shell execution.

## Verification

Run:

```bash
npm test
npm run build
```

Live connector verification requires local services:

- Ollama running with at least one pulled model.
- LM Studio local server enabled if using LM Studio.
- llama.cpp server or CLI installed if using llama.cpp.
- MCP servers running locally if testing MCP discovery/tool calls.

If these services are absent, the relevant verification step must be reported as blocked by missing local runtime credentials/services rather than faked.

## Buyer-Facing Listing Copy

NexusHarness turns local models into a serious coding agent environment. Connect Ollama, LM Studio, or llama.cpp; assign Planner, Executor, and Critic agents; wire in MCP servers; and run auditable coding workflows against your local workspace. It includes approval gates for file writes and shell commands, persistent retrospectives for self-improvement, local memory, run logs, model management, and a dark operator dashboard. No cloud account, no telemetry, no model lock-in.

## Known Limitations

- Browser UI depends on the local Node API for filesystem and shell execution.
- MCP behavior depends on server compliance with the SDK-supported stdio or Streamable HTTP transports.
- Embedding similarity is not bundled; memory retrieval currently uses pinned entries and keyword/task-type matching within the configured memory token budget to avoid adding a fake embedding implementation.
- Native tool-calling support depends on the selected runtime and model; text-only runtimes can use the documented JSON tool-call fallback.
- Approval resume re-runs the agent loop; approved risky actions are consumed on first use.

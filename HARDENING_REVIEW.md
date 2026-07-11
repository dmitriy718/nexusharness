# NexusHarness Hardening Review

Date: 2026-07-10

## Review Loop Summary

The codebase was reviewed and hardened across runtime connectors, MCP integration, agent orchestration, approval safety, auditability, UI management flows, persistence, installability, and verification.

## Findings Fixed

- Production `npm start` pointed at the wrong compiled server path.
- Runtime add stored endpoints before proving a live model was available.
- `tsx watch` did not reliably bind the API in the default dev script.
- Shell/test failures were logged but did not fail or revise task runs.
- Test/lint failures were not fed back into the Executor revision loop.
- Executor orchestration was single-pass instead of bounded parallel sub-agents.
- OpenAI-compatible tool-call continuation omitted `tool_call_id` and assistant `tool_calls`.
- MCP handling was hand-rolled JSON-RPC instead of SDK-backed transport integration.
- MCP server/tool enablement was displayed but not actually editable.
- Memory entries could not be edited, pinned, or deleted from the UI.
- MCP servers could not be refreshed or removed.
- File delete was missing from the local agent tool surface.
- File-write approvals were path-based and did not bind approval to exact content.
- File write logs did not include diffs.
- Runtime model-list failures were silently collapsed to an empty model list.
- Workspace load and refresh errors could be swallowed in the UI.
- MCP auto-discovery ignored the operator setting.
- Memory token budget was stored but not enforced.
- Store writes were not atomic and old settings were not deeply migrated.
- HTTP/runtime/MCP validation allowed invalid connector shapes.
- Empty Planner output could produce a run with zero subtasks.
- Environment and deployment hygiene files were missing.
- Text-only local runtimes could not request tools without native function-calling support.
- Approval decisions were reusable indefinitely instead of consumed on first use.
- Shell execution could misclassify timeout or spawn failures without numeric exit codes as success.
- The browser UI loaded Google Fonts, creating an external network dependency.
- Workspace root settings were not verified as existing directories.
- Deleting runtimes could leave stale agent model assignments.

## Current Verification

- `npm run lint`: passed
- `npm test`: passed, 12 tests
- `npm run build`: passed
- `npm audit --audit-level=moderate`: passed, 0 vulnerabilities
- `npm start` smoke test on temporary ports: API `200`, UI `200`
- `npm run dev`: API and UI confirmed listening on `127.0.0.1:8787` and `127.0.0.1:5173`

## Remaining External Verification

The code is ready for real runtime validation, but live end-to-end model execution still requires operator-provided local services:

- Ollama, LM Studio, llama.cpp server, or llama.cpp CLI + GGUF.
- At least one model assigned to Planner, Executor, and Critic.
- Optional MCP server for live MCP tool verification.
- Project-specific test/lint commands.

No live connector success was fabricated.

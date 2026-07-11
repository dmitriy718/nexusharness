# NexusHarness Verification Report

Date: 2026-07-10

## Local Automated Checks

All commands below were run in `D:\projects\nexus`.

```bash
npm audit --audit-level=moderate
```

Result: passed. `found 0 vulnerabilities`.

```bash
npm test
```

Result: passed. `1` test file, `12` tests.

```bash
npm run build
```

Result: passed. TypeScript compilation and Vite production build completed.

```bash
npm run lint
```

Result: passed. ESLint completed with no findings.

## Runtime Smoke Check

```text
API: http://127.0.0.1:8787
UI:  http://127.0.0.1:5173
```

Both ports were confirmed listening after `npm run dev`.

After hardening, `npm run dev` uses `tsx server/index.ts` for the API because `tsx watch` did not reliably bind the API process in this environment.

## Production Start Smoke Check

```bash
npm run build
NEXUSHARNESS_PORT=8790 npm start
```

Result: passed. `GET /api/state` returned `200`; `GET /` returned `200` from the built UI. The temporary production process was stopped after the check. Later smokes used `NEXUSHARNESS_PORT=8793 npm start` and `NEXUSHARNESS_PORT=8795 npm start` with the same `200`/`200` result.

## Live Connector Verification

The code includes real connector paths for Ollama, LM Studio, llama.cpp server, llama.cpp CLI, and MCP through the official SDK stdio and Streamable HTTP transports. Live model/tool execution was not claimed because no local runtime endpoint, GGUF path, llama.cpp binary, or MCP server was provided in this workspace.

To complete live verification:

1. Start Ollama, LM Studio, llama.cpp server, or provide a llama.cpp CLI binary and GGUF path.
2. Add the runtime in NexusHarness Models.
3. Assign Planner, Executor, and Critic models.
4. Start an MCP server if MCP verification is required.
5. Configure workspace root, test command, linter command, and approval mode.
6. Submit a real coding task and inspect `.nexusharness/store.json` for run, audit, approval, and memory records.

## Security Verification Covered

- Workspace path traversal is rejected by automated tests.
- HTTP runtime config validation rejects missing endpoints.
- Non-HTTP runtime endpoints are rejected.
- HTTP MCP and stdio MCP configuration rules are validated.
- MCP port ranges are validated.
- Critic threshold settings are bounded.
- Write approval hashes are deterministic.
- Text-only model tool-call fallback parsing is covered.
- Shell execution nonzero exits are covered.
- npm dependency audit passes at moderate severity and above.

## Not Verified Without Operator Services

- A real model producing a valid planner JSON array.
- A real model issuing tool calls through Ollama or LM Studio.
- A real MCP server responding to `tools/list` and `tools/call`.
- A real project test or lint command inside an operator-selected workspace.

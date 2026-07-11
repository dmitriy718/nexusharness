# NexusHarness v2.0.0 UX/UI audit and renovation plan

**Document status:** Proposed for owner review  
**Audit date:** 2026-07-11  
**Target release:** v2.0.0  
**Current declared version:** 0.1.0  
**Scope of this phase:** Audit and planning only

## Approval gate

No application redesign, version bump, dependency change, control-plane installation, or release work is authorized by this document alone. The only repository change made during this phase is this plan. Implementation begins only after the owner confirms the plan, requests revisions, or explicitly approves a defined phase.

When implementation is approved, Phase 1 (control-plane bootstrap) must be completed before any other v2 work so that every later task is claimed, checked for overlap, logged, and released under the new rules.

## Executive assessment

NexusHarness has a useful functional core and a coherent dark operator-console concept, but the current interface reads as an early engineering dashboard rather than a release-ready product. The central problems are structural:

- The mobile experience is unusable because the fixed navigation consumes almost half of a 390 px viewport and the main content is clipped horizontally.
- “Chat-first,” “IDE-style,” and “Agent Control” are presented as three layouts, but they currently apply unused CSS class names and produce the same interface.
- The primary run experience does not expose the plan, subtask output, critic feedback, validation output, final result, timing, or reliable per-phase state even though much of that data exists.
- Approval decisions are displayed as raw JSON with weak context, no diff-oriented review, no risk hierarchy, and no protection against accidental destructive actions.
- Most forms depend on placeholders instead of persistent labels, errors are global rather than field-specific, and success/progress feedback is inconsistent.
- Navigation is local component state rather than routes, so screens cannot be deep-linked, refreshed, bookmarked, or traversed with browser history.
- Visual styling is consistent but flat and generic. It needs stronger brand expression, spacing and typography hierarchy, meaningful status visualization, refined motion, and better information density.
- Release identity is fragmented. Version 0.1.0 is repeated in package.json, package-lock.json, marketplace.json, and server/index.ts.
- The workspace contains an empty or invalid D:\projects\.git directory; Git commands report that this is not a repository. A reliable versioning and release system requires this to be repaired or initialized with owner approval.

The v2 renovation should preserve the local-first, trustworthy operator-console character while turning it into a polished “mission control” environment: calm at rest, information-rich during a run, explicit around risk, and visually distinctive without becoming decorative noise.

## Audit scope and method

The review covered:

- The full React UI in src/main.tsx.
- The visual system and responsive rules in src/styles.css.
- Application metadata in index.html, package.json, package-lock.json, marketplace.json, and README.md.
- Server-facing UI data types, validation, and endpoints in server/types.ts, server/validation.ts, server/store.ts, and server/index.ts.
- The current persisted UI state with realistic run and audit history.
- Live rendering at 1440 × 900, 1024 × 768, and 390 × 844.
- Keyboard/accessibility affordances visible from markup and styling.
- Color contrast of the declared core tokens.
- Current testing, linting, build, and release conventions.

This was not a user-research study and did not mutate runtimes, MCP servers, approvals, settings, or run data. External model workflows were not executed as part of the UX audit.

One environment inconsistency was observed: the source defines a JSON /api/health route, but the already-running process on port 8787 returned the built HTML application for that path. This may simply be a stale process/build, but it reinforces the need for a UI/API version handshake and reproducible release startup checks.

## Current product inventory

| Area | Current purpose | Current implementation |
| --- | --- | --- |
| First launch | Choose an operator layout | Three large buttons; no preview or guided setup |
| Tasks | Submit work and see run state | Textarea, Run button, six phase cards, eight recent runs |
| Models | Add runtimes, discover models, assign roles | Two-column form plus runtime cards |
| MCP | Discover/add servers and enable tools | Dense toolbar plus server cards |
| Workspace | Show files under configured root | Always-expanded, read-only nested text tree |
| Memory | Add/edit/pin/delete memory | Two-column form and scrolling article list |
| Settings | Configure workspace, execution, MCP, and memory | Flat two-column grid |
| Approval rail | Approve or reject risky work | Permanent right rail with raw JSON payloads |
| Run log | Inspect recent audit events | First 80 events in expandable cards |

## What is already working well

- The dark palette is internally consistent and most core text contrast is strong.
- The interface uses a small icon vocabulary consistently through Lucide.
- Major product capabilities are discoverable from the left navigation.
- The local-only and approval-oriented product stance is stated clearly.
- The task composer disables an empty submission and exposes a starting state.
- Runtime-specific errors and run errors are surfaced instead of fabricated.
- Audit details use expandable disclosure, which is an appropriate base pattern.
- The data model already contains enough information to support a much better run inspector.

These strengths should be retained rather than replacing the product’s operator identity with a generic chat application.

## Severity definitions

- **Release blocker:** Must be resolved before v2.0.0.
- **High:** Major workflow, safety, accessibility, or comprehension problem.
- **Medium:** Material friction or inconsistency that reduces quality.
- **Low:** Polish, clarity, or maintainability improvement.

## Detailed audit findings

### Global shell, navigation, and responsiveness

| ID | Severity | Finding | Evidence and impact | v2 response |
| --- | --- | --- | --- | --- |
| UX-001 | Release blocker | Mobile layout is clipped and cannot adapt | At 390 px the 180 px sidebar remains visible, leaving roughly 210 px for content; headers, composer, buttons, and phase cards overflow horizontally | Replace with a mobile top bar and drawer/bottom destinations; prohibit page-level horizontal scrolling |
| UX-002 | High | Tablet collapses information into an excessively long single column | At 1024 px every phase card stacks and the approval rail moves after the entire main area | Use an adaptive phase stepper and a drawer/inspector for approvals |
| UX-003 | High | The right rail permanently consumes 340 px on desktop | The primary task workspace receives less space than secondary logs; on smaller screens the rail becomes easy to miss | Make the inspector resizable/collapsible and surface pending approvals in the global header |
| UX-004 | High | Navigation is not URL-based | Active screen is React state; refresh, deep links, browser Back/Forward, and bookmarks do not work | Introduce stable routes and route-aware active states |
| UX-005 | Medium | Navigation semantics are incomplete | The left navigation is an aside, active buttons have no aria-current, and there is no skip link | Use nav landmarks, aria-current, skip-to-content, and reliable focus placement |
| UX-006 | Medium | The brand area provides no system state | No workspace, connection, version, update, or runtime health is visible globally | Add workspace context, health cluster, pending-approval count, and version access |
| UX-007 | Medium | There is no compact navigation mode | The sidebar cannot collapse even when the central workspace needs width | Provide expanded, icon-only, and drawer variants |

### Layout modes and onboarding

| ID | Severity | Finding | Evidence and impact | v2 response |
| --- | --- | --- | --- | --- |
| UX-008 | Release blocker | The three promised layouts are not implemented | layout-chat, layout-ide, and layout-agents are added to the root but have no matching CSS or component behavior | Implement three meaningful run workspace modes or remove the choice |
| UX-009 | High | First launch asks for a low-context aesthetic choice before setup | Users choose an unexplained layout before connecting a runtime, assigning roles, or validating a workspace | Replace with a resumable setup wizard ordered around readiness |
| UX-010 | High | Layout choices have no preview or tradeoff explanation | The labels imply substantial behavioral differences but show only icons | Add preview diagrams, descriptions, recommended defaults, and a “decide later” path |
| UX-011 | Medium | First-launch save errors have no local recovery UI | The async choice handler has no visible loading, disabled, retry, or caught error state | Use step-level progress, inline error recovery, and saved completion state |
| UX-012 | Medium | Readiness is not summarized after onboarding | The operator can arrive at Tasks with missing agent assignments or commands | Add a readiness checklist and block only actions that truly cannot run |

### Task creation, run monitoring, and results

| ID | Severity | Finding | Evidence and impact | v2 response |
| --- | --- | --- | --- | --- |
| UX-013 | High | “Chat-first” has no conversation | Tasks are submitted through a textarea, but there is no user/agent dialogue, message context, or follow-up path | Build a run timeline that supports task, agent output, tool activity, and operator follow-up |
| UX-014 | High | The phase graph reports misleading state | Every phase card displays the overall latest run status, so all six cards can say “failed” while only one phase is current | Derive per-phase states: pending, active, passed, failed, skipped, waiting |
| UX-015 | High | Important run data is not visible | Plan, subtasks, executor output, critic feedback, validation output, result, timestamps, and logs exist in the model but are absent from the main UI | Add a structured run detail and inspector |
| UX-016 | High | Failed and canceled runs cannot be resumed from the visible run list | The API permits resume for failed/canceled runs, but UI resume is limited to waiting approvals in the rail | Add Retry, Resume, Duplicate, and Create follow-up actions with eligibility explanations |
| UX-017 | High | Run history is difficult to scan | Entries lack timestamps, duration, ID, role/model, progress, filters, and a detail affordance | Create a searchable/filterable run list with stable status chips and metadata |
| UX-018 | Medium | The composer lacks productivity behavior | No submit shortcut, attach/context controls, templates, token/character feedback, or draft persistence | Add Ctrl/Cmd+Enter, draft restore, task templates, and explicit context selection |
| UX-019 | Medium | Cancellation has weak safety and feedback | Cancel is an unstyled inline action without a pending state or confirmation rule | Use a danger treatment, pending state, and confirmation when cancellation could discard work |
| UX-020 | Medium | Score rendering hides zero | criticScore is conditionally rendered by truthiness, so a score of 0 would disappear | Render all defined numeric values and explain thresholds |
| UX-021 | Medium | Long task text dominates history cards | Full task content is repeated with limited metadata hierarchy | Clamp summaries and reveal full text in run detail |
| UX-022 | Medium | Empty, first-run, running, and completed experiences are not designed | The graph and log simply render little or nothing | Provide purposeful empty states, skeletons, and terminal summaries |

### Approvals, audit, and safety UX

| ID | Severity | Finding | Evidence and impact | v2 response |
| --- | --- | --- | --- | --- |
| UX-023 | Release blocker | Approval review lacks adequate decision context | The rail shows action plus raw JSON but not origin run, agent, affected files, command explanation, diff, risk, or consequences | Create a dedicated approval review with normalized summaries and previews |
| UX-024 | High | Approve and Reject are visually equivalent and adjacent | This increases accidental decisions on high-risk operations | Establish primary/safe/danger hierarchy and keyboard-safe confirmation behavior |
| UX-025 | High | Approval actions lack local error handling and in-flight protection | Rapid clicks can repeat requests and failures are not caught in the component | Disable while deciding, handle conflicts inline, and show the final decision |
| UX-026 | High | Pending approvals can become invisible on smaller screens | At or below 1100 px the rail is placed after the main content | Show a persistent count/badge and open approvals in a reachable drawer/page |
| UX-027 | High | Destructive removes and deletes do not ask for confirmation | Runtime, MCP, and memory deletion occur immediately | Require scoped confirmations; prefer typed confirmation only for the highest-impact actions |
| UX-028 | Medium | The audit log cannot be searched or filtered | Only 80 entries are shown without time, status, risk, run, or export controls | Build a virtualized/filterable audit table and event detail drawer |
| UX-029 | Medium | Audit summaries omit timestamps and risk | Operators cannot quickly reconstruct chronology or severity | Add relative and absolute time, risk, status, actor, run, and target |
| UX-030 | Medium | Raw payloads can be hard to read and may expose excessive detail | JSON is stringified directly in narrow cards | Redact secrets, format commands/files/diffs by type, and provide raw view as a secondary tab |

### Models and agent configuration

| ID | Severity | Finding | Evidence and impact | v2 response |
| --- | --- | --- | --- | --- |
| UX-031 | High | Runtime form shows irrelevant fields for every runtime kind | Endpoint, binary path, and model path are simultaneously visible | Use runtime-specific forms with examples, validation, and connection testing |
| UX-032 | High | Most runtime fields have placeholders but no labels | Values lose meaning after entry and screen-reader naming is unreliable | Add persistent labels, descriptions, required markers, and inline errors |
| UX-033 | Medium | Runtime addition has no visible pending state | Live validation can take up to the configured timeout while the UI appears idle | Show staged progress and allow safe cancellation |
| UX-034 | Medium | Model assignment choices are ambiguous across runtimes | Options show model name only | Include runtime, capabilities, context window, and availability |
| UX-035 | Medium | Assignment changes save immediately without confirmation or success feedback | A single select change mutates settings and may fail only through the global error | Show save state or use an explicit review-and-save pattern |
| UX-036 | Medium | Runtime cards lack operational status hierarchy | Connector kind, endpoint, discovered models, and errors compete visually | Add health, latency, last checked, model count, and a consistent card anatomy |
| UX-037 | Low | Capability data is presented as terse implementation text | “ctx”, “tools”, and quantization are not explained | Use labeled capability badges and tooltips |

### MCP and tools

| ID | Severity | Finding | Evidence and impact | v2 response |
| --- | --- | --- | --- | --- |
| UX-038 | High | The add-server toolbar is too dense and changes shape | Six-column layout mixes discovery and creation; stdio introduces an extra field | Separate Discover from Add Server and use a guided connection dialog |
| UX-039 | High | Argument format is unclear | Args accept either JSON or whitespace-separated text with no explanation or preview | Provide repeatable argument rows and an optional advanced raw mode |
| UX-040 | Medium | Tool controls do not expose descriptions or schemas | Operators enable tools by name alone | Add search, descriptions, risk hints, schemas, and bulk actions |
| UX-041 | Medium | Server enabled/tool enabled changes save instantly without progress | Failures surface only globally and repeated toggles can race | Use optimistic state with rollback and per-control feedback |
| UX-042 | Medium | Discovery gives no progress, range, or result summary | A potentially broad localhost scan looks like a normal button click | Show scan range, progress, cancel, discovered/ignored counts, and errors |
| UX-043 | Low | Empty MCP state is blank | There is no guided explanation when no server exists | Add a clear empty state with manual and discovery paths |

### Workspace

| ID | Severity | Finding | Evidence and impact | v2 response |
| --- | --- | --- | --- | --- |
| UX-044 | High | The tree visually implies collapsible behavior but is static | Directory rows use a disclosure triangle while every child is rendered and no row is interactive | Use accessible tree semantics and real expansion |
| UX-045 | High | Large workspaces will be hard to use | The entire tree is requested/rendered recursively with no lazy loading, search, or virtualization | Load on demand, virtualize, and filter/search |
| UX-046 | Medium | Files cannot be inspected from Workspace | The page is a directory listing rather than a useful workspace view | Add a read-only preview, metadata, path copy, and open-in-run context action |
| UX-047 | Medium | Loading and empty states are absent | A blank tree is ambiguous | Add skeleton, empty workspace, permission, and retry states |

### Memory

| ID | Severity | Finding | Evidence and impact | v2 response |
| --- | --- | --- | --- | --- |
| UX-048 | High | Creation hides important fields | New entries are always “context,” unpinned, and operator-sourced; kind and pin are only exposed while editing | Expose kind, pin, source, and clear field guidance during creation |
| UX-049 | High | Form fields rely on placeholders | Task type, title, and content lose their names after typing | Use labels and validation messages |
| UX-050 | Medium | Successful creation does not clear or confirm | The same data remains and can be accidentally duplicated | Clear or preserve intentionally with a success toast and undo |
| UX-051 | Medium | Memory cannot be searched, filtered, sorted, or collapsed | Long content creates a difficult scrolling list | Add search, kind/task filters, pin-first sorting, excerpts, and detail editing |
| UX-052 | Medium | Delete has no confirmation or undo | Persistent context can be lost with one click | Add undo and confirmation based on impact |

### Settings

| ID | Severity | Finding | Evidence and impact | v2 response |
| --- | --- | --- | --- | --- |
| UX-053 | High | Several settings have no visible label | Workspace root, layout, shell path, test, and lint controls are ambiguous | Group settings into labeled sections with helper text |
| UX-054 | High | Validation appears only after a full save | Server-side bounds and cross-field rules are not reflected near controls | Share schemas or constraints with the client and validate inline |
| UX-055 | Medium | There is no dirty-state or save-state handling | Operators cannot tell whether current values are saved; navigation can discard edits | Add dirty indicator, sticky Save/Discard bar, success state, and leave confirmation |
| UX-056 | Medium | Risky approval-mode changes lack explanation | Turning off approvals is a high-impact safety choice presented as a normal checkbox | Add consequence copy and explicit confirmation |
| UX-057 | Medium | Paths must be typed manually | Workspace, shell, binary, and model paths are error-prone | Add local path picker support where technically appropriate plus paste/type fallback |
| UX-058 | Low | Numeric input affordances are undifferentiated | Thresholds, ports, counts, and token budgets all look the same | Use units, ranges, steppers/sliders only where helpful, and defaults/reset |

### Feedback, state, content, and performance

| ID | Severity | Finding | Evidence and impact | v2 response |
| --- | --- | --- | --- | --- |
| UX-059 | High | Errors are global, raw, and click-to-dismiss | A non-focusable div contains messages, including structured validation arrays | Normalize errors, use an alert region, associate field errors, and provide retry/copy details |
| UX-060 | High | Success feedback is largely absent | Adds, deletes, saves, refreshes, and decisions often provide no acknowledgement | Add restrained toasts and persistent local result states |
| UX-061 | Medium | The entire store refreshes every three seconds | The UI has no connection indicator and re-renders broad state even when nothing changed | Move to event-driven updates or scoped query polling with freshness indicators |
| UX-062 | Medium | The boot message conflates loading with API failure | Before the first request resolves, the screen already says the API is unreachable | Separate boot/loading, reconnecting, offline, and fatal states |
| UX-063 | Medium | Copy is implementation-centered | Phrases such as “real JSON-RPC calls” and raw phase arrows emphasize internals over operator goals | Use concise operator language with technical details available on demand |
| UX-064 | Medium | No command palette or keyboard shortcut system exists | Frequent operators must repeatedly traverse navigation | Add a discoverable command palette and shortcut reference |
| UX-065 | Low | Long strings are not consistently constrained | Paths, model names, task text, errors, and commands can overflow or dominate | Apply truncation, wrapping, copy buttons, and expandable details by content type |

### Accessibility

| ID | Severity | Finding | Evidence and impact | v2 response |
| --- | --- | --- | --- | --- |
| UX-066 | Release blocker | Many controls have no accessible name beyond placeholder text | Runtime, MCP, memory, and settings forms contain unlabeled inputs/selects | Require programmatic labels for every control |
| UX-067 | High | Dynamic state is not announced | Errors, refreshes, run phase changes, approvals, and success messages have no live-region plan | Add polite/assertive announcement rules and avoid noisy repeated polling announcements |
| UX-068 | High | Focus management is undefined | No skip link, dialog focus trap, post-navigation focus, or action-return behavior exists | Define focus behavior for routes, drawers, dialogs, toasts, and deleted items |
| UX-069 | High | Explicit focus styling is absent | Keyboard users depend on inconsistent browser defaults | Add a high-contrast focus-visible ring with non-color cues |
| UX-070 | High | Status is often conveyed primarily through color or a border glow | Active phase and statuses need text/icon/shape redundancy | Pair every color with label and icon |
| UX-071 | Medium | Small status text may narrowly fail contrast | #ef4444 on #1a1d26 measures about 4.47:1, below the 4.5:1 AA requirement for small text | Replace and validate semantic status tokens |
| UX-072 | Medium | Touch target sizing is inconsistent | Current controls use compact padding and small inline actions | Enforce a 44 × 44 px minimum on touch layouts |
| UX-073 | Medium | Reduced motion and zoom behavior are unspecified | v2 visual effects could create motion or clipping problems | Support prefers-reduced-motion, 200% zoom, text reflow, and no essential animation |
| UX-074 | Medium | The workspace tree lacks tree roles and keyboard navigation | Nested divs do not expose hierarchy or expansion | Follow the ARIA tree pattern or use a simpler accessible disclosure list |

### Visual design and brand

| ID | Severity | Finding | Evidence and impact | v2 response |
| --- | --- | --- | --- | --- |
| UX-075 | High | The interface lacks a distinctive visual identity | Nearly every surface uses the same dark rectangle, one-pixel border, and six-to-eight pixel radius | Introduce a deliberate brand system, elevation hierarchy, and signature run visualization |
| UX-076 | Medium | Information hierarchy is weak | Headers, cards, forms, logs, and status blocks have similar visual weight | Establish type scale, spacing rhythm, surface levels, and content density rules |
| UX-077 | Medium | The page becomes “card soup” | Most content is placed in bordered rectangles regardless of purpose | Use tables, split panes, timelines, lists, and sections where those patterns fit better |
| UX-078 | Medium | Typography depends on fonts that may not be installed | Inter and JetBrains Mono are named but not bundled | Bundle privacy-safe local font files or use intentional system stacks |
| UX-079 | Medium | Motion and transition language is absent | State changes occur abruptly despite a real-time product | Add restrained, functional motion for expansion, progress, success, and panel changes |
| UX-080 | Low | Browser/product metadata is minimal | Only the title is present; there is no favicon, theme color, description, or version surface | Add complete local product metadata and branded icons |

### Code and release maintainability affecting UX

| ID | Severity | Finding | Evidence and impact | v2 response |
| --- | --- | --- | --- | --- |
| UX-081 | High | The UI is concentrated in one 535-line file with broad any typing | Feature behavior, state, and markup are hard to test and renovate safely | Split by feature, introduce typed API contracts, and test components/states |
| UX-082 | High | No UI interaction or accessibility test suite exists | Current tests cover server validation/tools, not rendered behavior | Add component, accessibility, end-to-end, and visual regression tests |
| UX-083 | High | Version identity is duplicated | 0.1.0 appears in four authoritative-looking locations | Make package.json the single source and enforce synchronization |
| UX-084 | High | UI and API cannot prove they are the same build | The observed health-route mismatch could go unnoticed by an operator | Expose build/version metadata on both sides and warn on mismatch |
| UX-085 | High | Git release prerequisites are not currently available | D:\projects\.git exists but Git does not recognize a repository | Repair/initialize Git only after owner approval, then protect release flow with checks |

## v2 product experience proposal

### Experience statement

NexusHarness v2 should feel like a precise local AI mission-control system: visually compelling on first launch, quiet when idle, highly legible during complex runs, and exceptionally explicit when an agent asks permission to change the operator’s machine.

### Design principles

1. **Operator confidence first.** Always show what is running, what it is touching, what needs attention, and what happened.
2. **Progressive disclosure.** Present a clean summary first; preserve raw model, tool, and audit details one level deeper.
3. **One coherent shell.** Routes and global behaviors remain stable while run workspace modes meaningfully change the center canvas.
4. **Risk deserves visual weight.** Approvals and destructive actions receive more context and stronger safeguards than normal configuration.
5. **Local-first is visible.** Workspace, runtime health, data locality, and offline state are product features, not footer copy.
6. **Visual richness with restraint.** Use atmosphere, typography, data visualization, and motion to create appeal; avoid decorative clutter.
7. **Accessibility is part of the component contract.** WCAG 2.2 AA is a release gate.
8. **Every state is designed.** Loading, empty, partial, stale, waiting, failed, canceled, disconnected, and complete states all need intentional UI.

## Proposed visual direction: “Midnight Prism”

The recommended direction is a deep, near-black technical canvas with cool indigo/cyan brand energy and small warm highlights for attention. It should feel premium and contemporary without resembling a gaming HUD.

### Visual ingredients

- **Background:** layered ink/navy surfaces rather than flat black.
- **Signature accent:** an indigo-to-cyan prism used only for brand mark, active run progress, and selected primary actions.
- **Atmosphere:** one or two extremely subtle radial glows behind the main workspace; never behind dense logs or form text.
- **Surfaces:** low-contrast filled surfaces for normal grouping, clearer elevated surfaces for inspectors/dialogs, and borders only when they communicate separation.
- **Typography:** a locally bundled modern grotesk/sans for interface text and a locally bundled mono face for code, commands, paths, and event payloads.
- **Shape:** 10–14 px primary radii, smaller radii for controls, consistent pills only for statuses/tags.
- **Depth:** restrained shadows and translucent overlays; no excessive glass blur.
- **Motion:** 120–220 ms transitions, subtle phase-flow animation only while running, and complete reduced-motion alternatives.
- **Illustration:** abstract node/connection motifs on onboarding and empty states, created as lightweight local SVGs rather than stock art.

### Initial token direction

These are starting points, not implementation-ready values. Every combination must pass automated contrast validation.

| Role | Direction |
| --- | --- |
| Canvas | #070A12 |
| Navigation | #0B0F1A |
| Surface 1 | #111625 |
| Surface 2 | #171D2E |
| Elevated | #1D2438 |
| Primary text | #F4F7FF |
| Secondary text | #A7B0C4 |
| Brand indigo | #8B7CFF |
| Brand cyan | #49D7E8 |
| Success | #49D99A |
| Warning | #F6C76D |
| Danger | #FF6B7A |

### Density and spacing

- Base spacing system: 4, 8, 12, 16, 24, 32, 48.
- Comfortable density is the default; compact density is available for logs and large datasets.
- Normal content max width is constrained, while Runs and Workspace may use the full canvas.
- Dense data uses aligned columns and tabular numerals instead of nested cards.

## Proposed information architecture

| Route | Purpose |
| --- | --- |
| / | Readiness dashboard, active work, health, and quick actions |
| /runs | Searchable run history and new-task entry |
| /runs/:runId | Full run workspace and live timeline |
| /agents | Planner, executor, critic assignments and agent behavior |
| /models | Runtime connections, inventory, capabilities, and health |
| /tools | MCP servers and local tool policy |
| /workspace | Accessible tree, search, preview, and context selection |
| /memory | Searchable knowledge, retrospectives, and pinned context |
| /approvals | Pending and historical decisions |
| /audit | Filterable event ledger |
| /settings/:section | Workspace, execution, safety, integrations, appearance, advanced |
| /about | Version, build, local data location, licenses, and diagnostics |

An optional development-only Project Control view may summarize repository claims, board items, and release readiness. The filesystem control plane remains authoritative; the UI must never become a second independent source of truth.

## Global application shell

### Desktop

- Collapsible left navigation with grouped destinations.
- Top context bar with workspace name/path, API/runtime health, active run indicator, pending approval badge, command palette, and user-accessible version/about menu.
- Main route canvas.
- Optional right inspector that is closed by default, resizable, and context-sensitive.
- Persistent but unobtrusive local/offline indicator.

### Tablet

- Icon-first collapsible sidebar.
- Inspector becomes an overlay drawer.
- Dense tables switch to priority columns plus a detail drawer.
- Run phases use a horizontal scrollable stepper or compact progress rail rather than six stacked cards.

### Mobile

- Top app bar with workspace, active run, and attention badge.
- Navigation in an accessible drawer or a small set of bottom destinations plus “More.”
- One-column content with no fixed-width sidebars.
- Full-screen sheets for inspectors, filters, and approval review.
- Composer remains reachable above the virtual keyboard and respects safe-area insets.

## Meaningful workspace modes

The existing three names should be retained only if they become genuine views:

### Focus mode (replacement for Chat-first)

- Conversation/timeline is primary.
- Composer is persistent.
- Tool and phase details are collapsed into readable event summaries.
- Best default for new operators.

### Studio mode (replacement for IDE-style)

- Resizable workspace tree, file preview/diff canvas, and run timeline.
- Selected files can be attached as task context.
- Best for code inspection and approval review.

### Orchestrate mode (replacement for Agent Control)

- Phase map, subtask lanes, agent activity, model assignment, approvals, and resource use are primary.
- Best for multi-agent monitoring.

Modes change the run workspace, not the entire application navigation. The selected mode persists per operator and can be switched at any time. v2 must not ship the choice unless all three meet their acceptance criteria; otherwise ship Focus mode and label the others as unavailable previews rather than pretending they exist.

## Screen renovation specifications

### 1. First-launch setup

Use a resumable six-step wizard:

1. Welcome and local-first/privacy explanation.
2. Connect a runtime and test it live.
3. Discover models and assign Planner, Executor, and Critic.
4. Choose and validate the workspace plus test/lint commands.
5. Review safety/approval mode with a clear recommendation.
6. Select a workspace mode with previews, then show a readiness summary.

Requirements:

- Save after every completed step.
- Allow Back, Skip when safe, Exit setup, and Resume.
- Show exact validation errors beside fields.
- Never strand the user when a local runtime is offline; provide diagnostics and retry.
- Provide a safe demo/read-only orientation without fake model responses.

### 2. Dashboard

- Readiness score/checklist with actionable missing prerequisites.
- Active run hero with phase, elapsed time, current agent, and attention state.
- Pending approvals with risk counts.
- Runtime/MCP health strip.
- Recent runs summarized by outcome and duration.
- Quick actions: New run, Resume, Connect runtime, Open workspace.
- Small local-data statement and workspace path.

### 3. Runs and run detail

- Search/filter by status, date, model, phase, and task.
- Stable run IDs, timestamps, duration, iteration, score, and model metadata.
- Run-detail header with status, actions, and mode switcher.
- Phase progress with accurate state per phase.
- Timeline entries for task, plan, executor subtasks, tool calls, approvals, critic, tests, retrospective, and final result.
- Inspector tabs: Overview, Plan, Outputs, Files/Diffs, Validation, Raw log.
- Retry/resume/duplicate/cancel actions based on server state.
- Copy/export summary with sensitive-value redaction.
- Draft-preserving composer with Ctrl/Cmd+Enter and accessible shortcut help.

### 4. Agents

- One card/row per role with assigned model, readiness, capabilities, and last activity.
- Clear role descriptions and recommended requirements.
- Assignment compatibility warnings before save.
- Future advanced controls can live behind disclosure; v2 should avoid an overwhelming matrix.

### 5. Models and runtimes

- Connection list with health, latency, last checked, detected models, and error detail.
- “Add runtime” wizard that changes fields by connector type.
- Test connection before persistence and show each test stage.
- Searchable model inventory with context, tool support, quantization, and assignment state.
- Confirm removal with impact: which agent roles become unassigned.

### 6. Tools and MCP

- Separate tabs for MCP servers and local tools/policy.
- Discovery flow with range summary, progress, cancel, and results.
- Server detail with transport, status, tools, descriptions, schemas, and last refresh.
- Search, enable all/none, and risk/category filters.
- Stdio arguments represented as repeatable rows with advanced raw editing.

### 7. Workspace

- Lazy accessible tree with keyboard navigation.
- Search/filter and breadcrumbs.
- File metadata plus safe read-only preview.
- Diff viewer reused by approvals.
- Context actions: copy path, attach to new run, reveal parent.
- Respect server workspace constraints and clearly explain blocked paths.

### 8. Memory

- Search, kind/task/source filters, pin-first sort, and excerpts.
- Create/edit drawer with all fields visible and explained.
- Retrospectives styled distinctly from operator context.
- Undo delete, explicit save status, and timestamps.
- Show why a memory item was selected for a run when that data becomes available.

### 9. Approvals

- Dedicated attention queue plus a global badge.
- Each item shows originating run, requesting agent, risk, action, exact targets, time, and rationale.
- File writes show unified or side-by-side diff with byte/hash metadata.
- Shell commands show command, shell, working directory, expected scope, and warning indicators.
- Approve once and Reject are the initial v2 decisions. Broader persistent grants should be a separately designed policy feature, not an accidental extension.
- Decision buttons are spatially separated, keyboard safe, disabled while saving, and followed by a durable result.
- Raw payload remains available in an Advanced tab.

### 10. Audit

- Filterable, sortable, virtualized event ledger.
- Columns: time, actor, action, run, risk, status, target/message.
- Detail drawer with formatted data and redacted raw view.
- Copy/export with clear local destination and scope.
- Live updates that preserve scroll position and announce only important changes.

### 11. Settings

- Routed sections: Workspace, Execution, Safety, Integrations, Memory, Appearance, Advanced.
- Persistent labels, descriptions, units, bounds, and inline validation.
- Sticky dirty-state footer with Save and Discard.
- Confirmation for disabling approval mode.
- Restore-defaults at section level.
- Appearance includes theme, density, reduced effects, and preferred run mode.

## Shared component and state system

Create reusable, accessible primitives before feature reconstruction:

- AppShell, Sidebar, TopBar, Breadcrumbs, PageHeader.
- Button variants: primary, secondary, quiet, danger.
- Field, Input, Select, Checkbox/Switch, NumberField, PathField.
- FormSection, inline ErrorMessage, HelpText.
- StatusBadge, HealthIndicator, RiskBadge.
- ToastRegion, AlertBanner, EmptyState, Skeleton.
- Dialog, AlertDialog, Drawer, Popover, Tooltip, Tabs.
- DataTable, FilterBar, SearchField, Pagination/virtual list.
- Timeline, PhaseStepper, RunSummary, EventRenderer.
- CodeBlock, CommandPreview, JsonViewer, DiffViewer.

Each component needs documented keyboard behavior, loading/disabled/error states, high-contrast focus, and reduced-motion behavior.

State conventions:

- Use route-level error boundaries.
- Normalize API errors into field, action, authorization/conflict, connection, and unknown categories.
- Prefer local progress indicators to a single global error.
- Keep success toasts concise and use inline durable state for important operations.
- Use event-driven updates if feasible; otherwise poll only visible/scoped data and expose freshness.
- Preserve drafts and unsaved edits across harmless background refreshes.

## Accessibility release standard

Target WCAG 2.2 AA for all v2 routes.

Required checks:

- Complete keyboard operation with logical tab order.
- Visible focus on every interactive element.
- Skip link and semantic landmarks.
- Programmatic labels, descriptions, required state, and error association.
- Correct dialog/drawer focus trap and focus return.
- Live-region policy for errors, decisions, and phase changes.
- Text and non-text contrast validation.
- Status never conveyed by color alone.
- 44 px touch targets on touch layouts.
- Reflow without loss at 320 CSS px and 200% zoom.
- prefers-reduced-motion support.
- Screen-reader checks with NVDA on Windows and at least one Chromium browser.
- Automated axe checks plus manual verification; automated checks alone do not satisfy the gate.

## Front-end architecture renovation

The current single-file UI should be split without rewriting server behavior all at once.

Proposed shape:

    src/
      app/
        App.tsx
        router.tsx
        providers.tsx
      components/
        ui/
        layout/
      features/
        onboarding/
        dashboard/
        runs/
        agents/
        models/
        tools/
        workspace/
        memory/
        approvals/
        audit/
        settings/
      api/
        client.ts
        contracts.ts
        errors.ts
      styles/
        tokens.css
        base.css
        utilities.css
      test/

Guidance:

- Replace broad any usage with shared client/server contracts.
- Add a router for stable URLs.
- Use scoped server-state queries and cancellation rather than whole-store refreshes.
- Keep visual tokens in CSS custom properties.
- Avoid a large UI framework unless an accessibility and bundle review proves it worthwhile.
- Bundle chosen fonts/icons locally to preserve the project’s privacy posture.
- Do not break working API behavior merely to match a component library.

## Repository control plane

### Purpose

The control plane prevents agents from editing the same area simultaneously, preserves a durable record of work, and exposes known issues and release progress. It governs development of NexusHarness itself; it is distinct from runtime agent execution inside the product.

### Proposed directory

    AGENTS.md                         # root bootstrap: always read first
    control/
      AGENTS.md                       # canonical agent rules
      README.md                       # human/operator guide
      config.json                     # claim TTL, areas, statuses, version policy
      claims/
        active/                       # active machine-readable claims
        archive/
          YYYY-MM/                    # released, expired, or superseded claims
      issues/
        BOARD.md                      # generated standing board
        items/
          NH-0001.md                  # one authoritative record per issue
      worklogs/
        YYYY/
          MM/
            YYYY-MM-DD.md             # chronological summaries
      releases/
        v2.0.0.md                     # release readiness/checklist
      templates/
        claim.json
        issue.md
        release-notes.md
      scripts/
        control.mjs                   # status/claim/heartbeat/release/issue commands
      .locks/                         # local atomic mutex data; not committed

The root AGENTS.md is necessary because rules hidden only inside control/ may not be discovered before an agent starts elsewhere in the repository. It should be short and uncompromising: read control/AGENTS.md, inspect claims, obtain a claim, then work.

### Claim record

Every claim must contain:

- Unique claim ID.
- Agent/session identity.
- Human-readable task.
- Issue ID(s), if any.
- Exact path scopes and logical resources.
- Claim mode; exclusive is the v2 default.
- Created, heartbeat, and expiry timestamps in UTC.
- Expected version impact: none, patch, minor, or major.
- Dependencies/blockers.
- Status.

Examples of logical resources are release-metadata, dependencies, design-tokens, API-contracts, and control-plane. They catch conflicts that path matching alone would miss.

### Atomic claim protocol

1. Agent reads root AGENTS.md and control/AGENTS.md.
2. Agent runs the status command and reviews active claims plus the issue board.
3. Agent requests a claim with exact paths and logical resources.
4. control.mjs acquires a mutex by atomically creating control/.locks/claims.lock.
5. Under the mutex it normalizes paths and rejects exact, wildcard, parent/child, or logical-resource overlap.
6. It writes the claim to a temporary file and atomically renames it into claims/active.
7. It records the claim event in the worklog and releases the mutex.
8. The agent verifies its active claim before changing files.

A plain hand-edited Markdown ledger is not sufficient for collision prevention because two agents can read “free” simultaneously. Human-readable files remain, but acquisition and release must go through the atomic script.

### Heartbeats, stale work, and takeover

- Default claim lifetime should be configurable, initially 30 minutes.
- Long-running agents renew with a heartbeat command.
- An expired claim is marked stale but is never silently deleted.
- Takeover requires an explicit command, a reason, and confirmation that the previous agent is no longer active.
- The stale record moves to archive with status expired or superseded.
- A takeover event is added to the worklog and linked issue.
- If the previous agent resumes, it must obtain a new claim.

### Release protocol

Before releasing a claim, the agent must provide:

- Summary of work completed.
- Files changed.
- Verification commands and results.
- What worked.
- What did not work.
- Unfinished work or newly discovered issues.
- Any assumptions or risks.
- Version impact and changelog category.
- Follow-up recommendation.

The release command validates the notes, moves the claim to archive, appends a worklog entry, updates linked issue state, and only then frees the area.

### Issue board

Each issue file should contain:

- ID, title, severity, type, status, target release.
- Affected paths/logical areas.
- Description and user impact.
- Reproduction/evidence.
- Acceptance criteria.
- Dependencies and blockers.
- Linked claims and worklogs.
- Created/updated timestamps.

Allowed statuses:

    backlog -> ready -> in_progress -> verify -> done
                         \-> blocked

BOARD.md should be generated from issue files so the standing board cannot drift away from the authoritative records. The initial v2 board should be seeded from the audit IDs in this document, with release blockers and high-severity findings prioritized.

### Control commands

Add npm wrappers around control.mjs:

- npm run control:status
- npm run control:claim -- --agent NAME --task TEXT --area PATH
- npm run control:heartbeat -- --claim ID
- npm run control:release -- --claim ID --notes FILE
- npm run control:issue -- ...
- npm run control:board
- npm run control:verify

control:verify must fail when records are malformed, BOARD.md is stale, active claims overlap, archive notes are incomplete, or a release is attempted with prohibited active claims.

### Bootstrap exception

The control plane cannot enforce a claim before it exists. After owner approval, the implementing agent must:

1. Create the minimal root/control rules and atomic script.
2. Immediately acquire the first claim named control-plane-bootstrap.
3. Finish the remaining control-plane files under that claim.
4. Verify collision behavior with automated tests.
5. Release and archive the bootstrap claim with full notes.

No other v2 renovation work begins until this is complete.

## Versioning and change tracking system

### Version policy

Adopt Semantic Versioning:

- **Major:** incompatible behavior, data migration, removed capability, or intentionally breaking workflow.
- **Minor:** backward-compatible feature or substantial UX capability.
- **Patch:** backward-compatible fix, accessibility correction, copy/polish, or internal change with no feature break.
- **Prerelease:** alpha.N, beta.N, and rc.N for v2 stabilization.

The requested public release is v2.0.0. Recommended progression:

    2.0.0-alpha.1 -> 2.0.0-beta.1 -> 2.0.0-rc.1 -> 2.0.0

Prereleases are optional for distribution but valuable as internal checkpoints. They must never be mislabeled as the final release.

### Single source of truth

package.json becomes the authoritative version.

Generated or checked consumers:

- package-lock.json root/package version.
- marketplace.json version.
- API health/build response.
- UI About/version display.
- release artifact metadata.

Remove manually duplicated hard-coded version literals. A version-check script must fail CI/local release verification if consumers disagree.

### Build identity

Expose:

- Semantic version.
- Git commit SHA when available.
- Build timestamp.
- Development/production mode.
- API version/build identity.

The UI compares its build identity to the API. If versions or commits differ, show a non-destructive warning with restart/rebuild guidance. This directly addresses stale-process ambiguity.

### Change log

Add CHANGELOG.md using a consistent Unreleased section with:

- Added
- Changed
- Fixed
- Deprecated
- Removed
- Security

Every released control-plane claim declares its version impact and changelog category. User-visible changes must add a concise entry before the claim is released. Worklog detail remains in control/; CHANGELOG.md remains customer-facing.

### Commit and release conventions

Once Git is valid:

- Use Conventional Commit prefixes: feat, fix, refactor, perf, docs, test, build, ci, chore.
- Reference NH issue IDs where applicable.
- Do not combine unrelated claimed areas in one commit.
- Tag releases as vX.Y.Z.
- Generate release notes from CHANGELOG.md, not raw commit messages alone.
- Preserve the existing local-first security notes and migration warnings.

### Release automation

Create scripts that:

1. Verify a valid, clean Git worktree.
2. Verify no conflicting active claims; only the release-manager claim may remain.
3. Verify the issue board has no unresolved v2 release blockers.
4. Run control-plane validation.
5. Run version consistency validation.
6. Run lint, unit/component tests, accessibility checks, end-to-end tests, and build.
7. Apply the requested version to package.json and synchronized consumers.
8. Validate CHANGELOG.md and release notes.
9. Build artifacts and smoke-test API/UI version identity.
10. Create the Git commit/tag only after all checks pass.

The existing invalid Git state must be handled as a separate owner-approved repository operation before release automation is enabled. The plan must not assume it is safe to delete or replace D:\projects\.git.

## Implementation phases after approval

### Phase 0 — Confirm scope and design direction

Deliverables:

- Owner approval or requested changes to this plan.
- Decision on Midnight Prism direction.
- Decision whether all three workspace modes are v2 release requirements or whether Focus ships first.
- Confirmation on Git repair/initialization authority.

Exit gate: explicit owner approval.

### Phase 1 — Bootstrap the control plane

Deliverables:

- Root and control AGENTS.md.
- Atomic claim/heartbeat/release workflow.
- Worklogs, archive, issue records, and generated board.
- Automated overlap and stale-claim tests.
- First archived bootstrap claim.
- Audit findings seeded into the board.

Exit gate: another test agent/process cannot acquire an overlapping claim, and incomplete release notes are rejected.

### Phase 2 — Establish version and release foundations

Deliverables:

- package.json as single version source.
- Version/build metadata shared by API and UI.
- Version consistency check.
- CHANGELOG.md and versioning policy.
- v2.0.0 release record/checklist.
- Git-state decision completed by the owner-authorized path.

Exit gate: a deliberate mismatch fails verification and UI/API mismatch is visible.

### Phase 3 — UX foundation and prototypes

Deliverables:

- Route map and typed client contracts.
- Design tokens, typography, icons, surface/elevation, and motion rules.
- Accessible component primitives.
- Clickable or coded prototypes for onboarding, dashboard, run detail, and approval review.
- Desktop/tablet/mobile reference states.

Exit gate: owner signs off on representative screens before feature-wide implementation.

### Phase 4 — Shell, routing, onboarding, and dashboard

Deliverables:

- Responsive app shell and navigation.
- Stable routes and browser history.
- Global health/approval/version surfaces.
- First-launch wizard.
- Readiness dashboard.
- Loading/offline/error boundaries.

Exit gate: complete keyboard and responsive walkthrough from fresh install to ready dashboard.

### Phase 5 — Core run experience

Deliverables:

- Runs list and full run detail.
- Accurate phase-state model.
- Focus mode.
- Timeline and inspector.
- Resume/retry/duplicate/cancel actions.
- Draft composer and result presentation.

Exit gate: operator can understand a successful, failed, canceled, and waiting-approval run without reading raw store data.

### Phase 6 — Safety and observability

Deliverables:

- Approval queue and typed review renderers.
- Diff/command/file previews.
- Audit ledger, filters, details, and redacted export.
- Global attention behavior across breakpoints.

Exit gate: risky decisions are contextual, keyboard safe, idempotent in the UI, and recover gracefully from API conflicts.

### Phase 7 — Models, agents, tools, workspace, memory, and settings

Deliverables:

- Feature-specific forms and state handling.
- Agent assignment screen.
- Runtime health and inventory.
- Guided MCP setup and tool controls.
- Lazy workspace browser/preview.
- Searchable memory.
- Grouped settings with dirty-state protection.

Exit gate: every existing v1 capability is mapped, preserved or intentionally migrated, and covered by acceptance tests.

### Phase 8 — Studio and Orchestrate modes

Deliverables:

- Studio split-pane workspace.
- Orchestrate agent/subtask activity view.
- Resizing, persistence, and breakpoint behavior.

Exit gate: each advertised mode is meaningfully distinct, accessible, and fully usable. If this gate cannot be met, do not advertise the incomplete mode in v2.0.0.

### Phase 9 — Accessibility, performance, and release hardening

Deliverables:

- WCAG 2.2 AA audit closure.
- Visual regression suite.
- Responsive and zoom validation.
- Performance profiling and scoped live updates.
- Migration notes, help copy, metadata, icons, and About screen.
- v2.0.0 release candidate and final verification.

Exit gate: all release-blocker/high findings targeted for v2 are closed or explicitly deferred by the owner with documented rationale.

## Test and quality plan

### Automated

- Vitest component tests for fields, dialogs, phase state, errors, and decision state.
- React Testing Library for user-level interactions.
- axe accessibility checks on every major route/state.
- Playwright end-to-end tests for onboarding, runtime setup failure/retry, task submission, approvals, run completion/failure, settings dirty state, and responsive navigation.
- Visual regression at:
  - 1440 × 900
  - 1280 × 800
  - 1024 × 768
  - 768 × 1024
  - 390 × 844
  - 360 × 800
- Contract tests for UI/API version identity.
- Control-plane concurrency tests using competing claim processes.
- Version/release dry-run tests.

### Manual

- Keyboard-only walkthrough.
- NVDA walkthrough on Windows.
- 200% and 400% zoom spot checks.
- Reduced motion and high-contrast mode.
- Long model names, paths, commands, task text, audit payloads, and large run histories.
- API offline/restart/stale-build behavior.
- Slow runtime and MCP timeout behavior.
- Destructive and rejected approval recovery.

### Performance targets

Targets should be measured on a representative local machine:

- Initial shell should become interactive without waiting for runtime discovery.
- Navigation transitions should feel immediate and preserve drafts.
- Large audit/run/workspace lists must be virtualized or paginated.
- No full-store rerender every three seconds.
- No unexpected layout shift from font loading or live events.
- Animation must not block input and must be disabled by reduced-motion preference.

## v2.0.0 release acceptance criteria

v2.0.0 is ready only when:

- The control plane is active, tested, and used by all v2 work.
- There are no overlapping active claims.
- Every completed claim has finishing notes and version impact.
- The issue board and v2 release checklist are current.
- package, lockfile, marketplace, API, UI, and artifact versions all report 2.0.0.
- UI and API build identities match.
- CHANGELOG.md contains a complete 2.0.0 entry and migration notes.
- The interface works without horizontal clipping at 320 CSS px.
- All three advertised modes are real, or incomplete modes are removed from the release UI.
- Every form control has a persistent programmatic label and inline error behavior.
- All risky actions have contextual review and protected decision states.
- Runs expose accurate per-phase state and meaningful output/result detail.
- Core routes pass keyboard, screen-reader, contrast, reduced-motion, and zoom checks.
- Existing functional capabilities have regression coverage.
- npm test, npm run lint, npm run build, end-to-end tests, accessibility checks, control:verify, and version checks pass.
- A production-style smoke test verifies fresh install/startup, API health JSON, routing, and version identity.
- The owner approves the final visual review and release candidate.

## Recommended v2 priority split

### Must ship

- Control plane.
- Reliable versioning and changelog.
- Valid responsive shell and routing.
- Guided onboarding/readiness.
- Focus run experience with accurate state and outputs.
- Approval and audit renovation.
- Accessible labeled forms and feedback states.
- Models/MCP/workspace/memory/settings parity.
- WCAG 2.2 AA and responsive test gates.

### Ship only if complete

- Studio mode.
- Orchestrate mode.
- Development-only Project Control UI.
- Advanced audit exports.
- Persistent broad permission grants.

This split protects the quality of v2.0.0. A visually polished but incomplete advertised mode would repeat one of the largest current UX problems.

## Decisions requested from the owner

Before implementation, confirm or revise:

1. Approve the “Midnight Prism” visual direction.
2. Decide whether Focus, Studio, and Orchestrate must all ship in v2.0.0, or whether Focus is the required mode and the others follow in v2.x.
3. Approve creating both root AGENTS.md and control/AGENTS.md so the control rules cannot be missed.
4. Approve the atomic script-backed claim system rather than a hand-edited log alone.
5. Decide whether the optional Project Control status view belongs in v2.0.0.
6. Authorize a later, separately claimed repair/initialization of the invalid Git repository state.
7. Approve the prerelease progression before the final v2.0.0 tag.

Until those decisions are confirmed, this document remains an audit and proposed plan only.

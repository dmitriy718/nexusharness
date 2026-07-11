# NexusHarness human-required actions

This file records work that requires the project owner and cannot be completed safely or truthfully by an automated agent. Agents must keep implementation moving when an item is non-blocking and must not pretend a human-only check has passed.

## Current blocking actions

### HR-001 — Representative v2 visual review

- **Status:** Ready and blocking broad feature rollout.
- **Owner action:** Start the application with npm run dev, then review:
  1. http://127.0.0.1:5173/dashboard at approximately 1440 px, 1024 px, and 390 px widths.
  2. http://127.0.0.1:5173/onboarding.
  3. Open any run from http://127.0.0.1:5173/runs.
  4. http://127.0.0.1:5173/approvals. The detailed review appears when a real run has a pending approval.
  5. Keyboard focus visibility and the mobile navigation drawer.
- **Decision needed:** Reply with approval of the Midnight Prism direction or list concrete revisions. Studio and Orchestrate are intentionally labeled Preview at this checkpoint.
- **Why human input is required:** Visual preference and brand acceptance belong to the owner.
- **Agent verification already completed:** Lint, tests, TypeScript, production build, isolated production runtime, desktop dashboard/onboarding/run/approval rendering, and responsive shell inspection.
- **Blocks:** Phase 4 and later broad feature rollout.

## Scheduled owner checkpoints

### HR-002 — Manual assistive-technology review

- **Status:** Pending; not yet ready.
- **Needed after:** Phase 9 accessibility candidate.
- **Owner action:** Follow the supplied NVDA keyboard/screen-reader script on Windows and record any failures or confusion.
- **Why human input is required:** Automated accessibility checks cannot validate the lived screen-reader experience.
- **Blocks:** Closing the WCAG release gate.

### HR-003 — v2.0.0 release-candidate approval

- **Status:** Pending; not yet ready.
- **Needed after:** All automated verification, responsive captures, migration notes, and the release checklist are complete.
- **Owner action:** Approve the final visual review and authorize the v2.0.0 release tag.
- **Why human input is required:** The plan reserves final product and release acceptance for the owner.
- **Blocks:** Creating and publishing the final v2.0.0 tag.

## Completed actions

None yet.

## Entry requirements

Every new item must include:

- A stable HR identifier.
- Whether it blocks current work.
- Exact steps the owner must perform.
- Evidence or files the owner should inspect.
- The decision or result the agent needs in return.
- The project phase or release gate it blocks.

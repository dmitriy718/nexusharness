# NexusHarness human-required actions

This file records work that requires the project owner and cannot be completed safely or truthfully by an automated agent. Agents must keep implementation moving when an item is non-blocking and must not pretend a human-only check has passed.

## Current blocking actions

None.

## Scheduled owner checkpoints

### HR-001 — Representative v2 visual review

- **Status:** Pending; not yet ready.
- **Needed after:** Phase 3 coded prototypes for onboarding, dashboard, run detail, and approval review.
- **Owner action:** Review desktop, tablet, and mobile captures and approve the Midnight Prism application direction or list requested revisions.
- **Why human input is required:** Visual preference and brand acceptance belong to the owner.
- **Blocks:** Broad feature rollout after the representative prototype checkpoint.

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

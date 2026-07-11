# NexusHarness human-required actions

This file records work that requires the project owner and cannot be completed safely or truthfully by an automated agent. Agents must keep implementation moving when an item is non-blocking and must not pretend a human-only check has passed.

## Current blocking actions

None.

## Scheduled owner checkpoints

### HR-003 — v2.0.0 release-candidate approval

- **Status:** Pending; not yet ready.
- **Needed after:** All automated verification, responsive captures, migration notes, and the release checklist are complete.
- **Owner action:** Approve the final visual review and authorize the v2.0.0 release tag.
- **Why human input is required:** The plan reserves final product and release acceptance for the owner.
- **Blocks:** Creating and publishing the final v2.0.0 tag.

## Completed actions

### HR-002 — Manual assistive-technology review

- **Status:** Passed by the owner on 2026-07-11.
- **Evidence:** The owner returned `HR-002 Pass` after the prescribed NVDA and Chrome keyboard-only walkthrough.
- **Automated companion evidence:** Six production accessibility suites, WCAG A/AA axe scans, keyboard/focus behavior, 320 px reflow, 200%/400% scaling, reduced motion, forced colors, contrast, and touch-target checks pass.
- **Decision:** The manual assistive-technology gate is accepted without reported findings.
- **Result:** NH-0008 and the WCAG release gate may close. HR-003 remains a separate final product/release decision.

### HR-004 — Real-host Windows Sandbox isolation probe

- **Status:** Passed by the owner on 2026-07-11.
- **Evidence:** `seedRead`, `mappedWrite`, `networkBlocked`, `sandboxIdentity`, `hostWriteback`, and final `passed` all returned `true`; the guest identity was `WDAGUtilityAccount` and the command ended with `Windows Sandbox isolation probe passed.`
- **Repairs validated along the way:** guest-completion retention, host-owned session shutdown, mapped-folder cleanup retry, BOM-safe JSON interchange, and successful empty-session discovery.
- **Decision:** The hardened launcher may truthfully advertise its Windows Sandbox virtualization boundary. Full execution-cell provider integration remains a separate implementation gate.
- **Result:** Windows launcher boundary verification is unblocked; no claim is made yet about unfinished command transport, effect harvesting, persistence, or atomic promotion.

### HR-001 — Representative v2 visual review

- **Status:** Approved by the owner on 2026-07-11.
- **Decision:** Midnight Prism direction approved.
- **Evidence reviewed:** Dashboard, onboarding, run detail, approvals, responsive shell, focus visibility, and mobile navigation checkpoint.
- **Result:** Broad feature rollout is unblocked. Studio and Orchestrate remain clearly labeled Preview until their implementation gates pass.

## Entry requirements

Every new item must include:

- A stable HR identifier.
- Whether it blocks current work.
- Exact steps the owner must perform.
- Evidence or files the owner should inspect.
- The decision or result the agent needs in return.
- The project phase or release gate it blocks.

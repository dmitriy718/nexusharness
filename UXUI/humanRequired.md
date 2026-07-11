# NexusHarness human-required actions

This file records work that requires the project owner and cannot be completed safely or truthfully by an automated agent. Agents must keep implementation moving when an item is non-blocking and must not pretend a human-only check has passed.

## Current blocking actions

None.

## Scheduled owner checkpoints

### HR-004 — Real-host Windows Sandbox isolation probe

- **Status:** Ready for owner action; Windows Sandbox executable and `Containers-DisposableClientVM` feature were detected as enabled on 2026-07-11.
- **Needed after:** Hardened launcher candidate (now available in the current implementation branch and intended for `main` after verification).
- **Owner action:** From `D:\projects\nexus`, run `npm run test:windows-sandbox`. Windows Sandbox will open an interactive VM window and should close automatically within five minutes. Do not enter credentials or interact with unrelated files while it runs.
- **Expected result:** The command prints JSON with `seedRead`, `mappedWrite`, `hostWriteback`, `networkBlocked`, `sandboxIdentity`, and `passed` all set to `true`, followed by `Windows Sandbox isolation probe passed.`
- **Evidence to return:** Paste `HR-004: Pass` plus the final JSON, or `HR-004: Fail` plus the complete terminal error and whether the Sandbox window opened/closed.
- **Why human input is required:** The real Windows Sandbox boundary launches a visible interactive VM. Automated tests validate profile construction and launcher cleanup but cannot silently certify host virtualization, guest identity, or network egress denial.
- **Blocks:** Marking the Windows launcher as a verified security boundary and promoting it into a complete `windows-sandbox` execution-cell provider.

### HR-002 — Manual assistive-technology review

- **Status:** Ready for owner action; automated candidate passed on 2026-07-11.
- **Needed after:** Phase 9 accessibility candidate (now available on `main` after the accessibility claim is pushed).
- **Owner action:** With a current NVDA release and Chrome on Windows, start NexusHarness with `npm run dev`, then complete the following keyboard-only walkthrough. Do not use the mouse during the test.
  1. Open `/onboarding`. Confirm NVDA announces the NexusHarness setup context, each step heading, the Back/Continue controls, and the labels and hints for workspace, test, and lint fields.
  2. Open `/dashboard`, press `Tab` once, activate **Skip to main content**, and confirm focus lands at the main content. Use the primary navigation to open Runs and confirm NVDA announces the new page/title without requiring manual focus recovery.
  3. At a narrow Chrome window, activate **Open navigation**. Confirm focus enters the navigation dialog, `Tab` and `Shift+Tab` stay inside it, `Escape` closes it, and focus returns to **Open navigation**.
  4. Open a run. Confirm Focus, Studio, and Orchestrate are announced as pressed/unpressed buttons. In Focus, place focus on the Overview inspector tab and use Left/Right Arrow, Home, and End; confirm the selected tab and content change together.
  5. Open Workspace. Confirm entries are announced as buttons with folder expansion state where applicable. Use Up/Down Arrow to move between entries, Right Arrow to expand a closed folder, and Left Arrow to collapse it. Confirm a selected file’s bounded preview has a clear name.
  6. Open Models, choose **Add runtime**, and submit or edit intentionally invalid values. Confirm the field label, invalid state, hint, and error are announced together. Repeat with an out-of-range number in Settings > Execution.
  7. Open Audit and activate the first event review control. Confirm the event-detail dialog title is announced, focus starts on **Close event detail**, focus stays in the dialog, `Escape` closes it, and focus returns to the same event review control.
  8. Open Approvals if a pending item exists. Confirm risk, origin, target/command, and Review/Redacted raw tabs are understandable without visual context. Do not approve or reject a real request solely for this test.
  9. Trigger a safe copy action or save a harmless setting, then confirm the success notification is announced once and is dismissible. Disconnect/reconnect the local API only if convenient and confirm connection/error state is announced without continuous repetition.
  10. Record Pass/Fail plus exact route, control name, NVDA speech that was confusing or missing, and the expected wording for every failure.
- **Evidence to return:** A short result in the form `HR-002: Pass` or `HR-002: Fail`, followed by findings for any failed step. Screenshots are optional; NVDA speech notes are more useful.
- **Why human input is required:** Automated accessibility checks cannot validate the lived screen-reader experience.
- **Blocks:** Closing the WCAG release gate.

### HR-003 — v2.0.0 release-candidate approval

- **Status:** Pending; not yet ready.
- **Needed after:** All automated verification, responsive captures, migration notes, and the release checklist are complete.
- **Owner action:** Approve the final visual review and authorize the v2.0.0 release tag.
- **Why human input is required:** The plan reserves final product and release acceptance for the owner.
- **Blocks:** Creating and publishing the final v2.0.0 tag.

## Completed actions

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

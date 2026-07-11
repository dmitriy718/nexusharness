# NexusHarness human-required actions

This file records work that requires the project owner and cannot be completed safely or truthfully by an automated agent. Agents must keep implementation moving when an item is non-blocking and must not pretend a human-only check has passed.

## Current blocking actions

### HR-007 — Resolve owner-held worktree changes for the v2.0.0 tag

- **Status:** Owner decision required; blocks only the clean release tag.
- **Owner action:** Decide whether the existing edits in `README.md`, `VERIFICATION.md`, and `HARDENING_REVIEW.md` should be discarded or replaced with current final-release documentation, and authorize removal or retention outside Git of `UXUI/capture.png` and `UXUI/capture2.png`.
- **Evidence:** The three documents currently describe an earlier 22-test, non-sandbox build and conflict with the verified 249-test Windows Sandbox-capable release. The two captures are historical error screenshots and remain untracked.
- **Why human input is required:** These files predate and are outside the agent's owned claims. The agent will not silently stage, rewrite, or delete owner-held changes.
- **Blocks:** A clean Git worktree and creation/push of tag `v2.0.0`.

## Scheduled owner checkpoints

### HR-006 — Linux Firecracker/KVM isolation host

- **Status:** Environment required; non-blocking for Windows provider work.
- **Owner action:** Provide or designate a Linux host with `/dev/kvm`, matching statically linked Firecracker and `jailer` binaries, a dedicated non-root UID/GID, root-owned non-world-writable input paths, kernel image, and root filesystem image.
- **Evidence to return:** Host distribution/kernel, cgroup version, Firecracker/jailer version output, KVM accessibility, dedicated UID/GID, and approved paths for chroot, kernel, and rootfs. Do not send credentials or private keys.
- **Why human input is required:** This Windows host cannot verify KVM, jailer privilege dropping, cgroups, namespace isolation, seccomp, or microVM boot behavior.
- **Blocks:** Promoting the Firecracker launcher foundation to a verified Linux security boundary and complete execution-cell provider.

## Completed actions

### HR-003 — v2.0.0 release-candidate approval

- **Status:** Approved by the owner on 2026-07-11.
- **Evidence:** The owner stated that everything still pending approval is approved and instructed the agent to proceed after the complete automated, visual, accessibility, Windows Sandbox, and control-plane evidence had passed.
- **Decision:** Final visual review and the v2.0.0 release candidate are approved. Release identity finalization is authorized.
- **Result:** The final version may be prepared. Tag creation remains separately blocked only by HR-007's owner-held dirty worktree; HR-006 remains an environment-evidence gate for Linux, not an approval gate for v2.0.0.

### HR-005 — Real Windows Sandbox command-provider smoke

- **Status:** Passed by the owner on 2026-07-11.
- **Evidence:** The real guest returned a `succeeded` broker receipt and exit code 0; all five execution checks passed; the primary checkout remained unchanged before promotion; `sandbox-command-output.txt` was observed as `file.create`; variances were empty; policy evidence passed; diagnostics ended at `complete`; commit, promotion, audit linkage, and aggregate `passed` were all true.
- **Repairs validated along the way:** redacted condition reporting, staged transport diagnostics, structured guest-bootstrap failure status, synchronous encoded PowerShell exit capture, and alphanumeric-first bootstrap/completion filenames matching hardened launcher validation.
- **Decision:** The base Windows PowerShell command transport is accepted for live validation selection behind the verified Windows Sandbox provider. Additional guest toolchains such as Node, Git, or package managers remain separately capability-gated.
- **Result:** The Windows command-provider checkpoint is closed without expanding its claim beyond base PowerShell transport and receipt-gated file-effect promotion.

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

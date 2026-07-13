# NexusHarness verification report

## 2.1.0-beta.0 local release candidate

Date: 2026-07-13
Repository: `D:\projects\nexus`

The local `2.1.0-beta.0` candidate passes the complete automated source matrix:

| Gate | Result |
| --- | --- |
| Control-plane and synchronized package/lock/shrinkwrap/marketplace identity | Passed |
| Strict ESLint | Passed |
| Core unit/component/model/integration suites | 302 passed, 21 skipped |
| TypeScript server/client production builds | Passed |
| Portable deployment, lifecycle, migration, cleanup, purge, and compiled CLI suites | 24 passed |
| Accessibility browser suites | 6 passed |
| Consequential workflow browser suites | 5 passed |
| Visual regression suites | 6 viewports / 36 reviewed baselines passed |
| Performance browser suites | 4 passed |
| Production API/UI/CLI smoke | Passed as `2.1.0-beta.0` |
| Package allowlist and dry-run audit | Passed with 48 files at 0.31 MB before production dependencies |
| Production dependency audit and secret-prefix scan | 0 vulnerabilities; no matches |
| Release workflow YAML and local tag/changelog contract | Passed for expected tag `v2.1.0-beta.0` |

The prerelease visual change was inspected at desktop and mobile widths before baseline acceptance; the rendered difference was limited to the visible version changing from `2.0.0` to `2.1.0-beta.0`. A second visual run passed all baselines.

Hosted GitHub OIDC publication, npm provenance, the cross-platform hosted tarball matrix, registry installation, and Homebrew formula testing remain intentionally unverified. They require the external owner gates in `remainingsteps.md` and `control/releases/v2.1.0-beta.0.md`; the package and formula must not be presented as published until those real workflows pass.

## 2.0.0 released baseline

Date: 2026-07-11
Repository: `D:\projects\nexus`

### Release gate

The final `2.0.0` identity passed the complete automated release matrix:

| Gate | Result |
| --- | --- |
| Control-plane integrity | Passed |
| Version identity and drift checks | Passed |
| Strict ESLint | Passed |
| Core unit/component/model suites | 249 passed, 21 skipped |
| TypeScript server and client production builds | Passed |
| Accessibility browser suites | 6 passed |
| Consequential workflow browser suites | 5 passed |
| Visual regression suites | 6 passed |
| Performance browser suites | 4 passed |
| Production API/UI smoke | Passed |
| Package dry-run, contents, identity, and size | Passed as `nexusharness@2.0.0` |

Run the same matrix with:

```bash
npm run release:verify
```

The final visual changes were reviewed at desktop, tablet, and mobile breakpoints. Baselines were accepted only where the visible version changed from `2.0.0-beta.1` to `2.0.0`; two consecutive visual runs then passed.

### Independent release-identity perspective

A separate release audit verified:

- `package.json`, `package-lock.json`, `marketplace.json`, client metadata, API health, and built artifacts report `2.0.0`.
- `CHANGELOG.md` contains the dated final entry and `MIGRATION_V2.md` documents backup, compatibility, first launch, and rollback.
- Production smoke reports matching UI/API version and build identity, required security headers, bounded compact state, correct invalid-task handling, and correct API 404 behavior.
- Package dry-run includes required source/runtime/migration assets, stays under the 10 MB limit, and excludes local state, environment files, dependencies, and visual-diff artifacts.
- Version-drift tests independently prove that mismatched lockfile/marketplace versions fail, and that synchronization repairs them from `package.json`.
- The control plane has no overlapping or stale release claims, every completed claim carries finishing notes, and the issue board is generated from the issue records.

### Human and real-host evidence

- **HR-001:** Midnight Prism visual direction approved.
- **HR-002:** NVDA and Chrome keyboard-only walkthrough passed; companion automated checks cover WCAG A/AA axe scans, focus behavior, 320 px reflow, 200%/400% scaling, reduced motion, forced colors, contrast, and touch targets.
- **HR-003:** Final v2.0.0 release candidate approved.
- **HR-004:** Real Windows Sandbox isolation probe passed: seed read, mapped write, disabled TCP egress, `WDAGUtilityAccount` guest identity, host writeback, cleanup, and aggregate result were all verified.
- **HR-005:** Real brokered Windows Sandbox command probe passed: contract policy, receipt, exit code, declared effect observation, unchanged primary checkout before promotion, commit, audit linkage, and promotion were all verified.
- **HR-007:** Owner authorized replacement of stale pre-v2 documents and removal of diagnostic captures so the final release can be tagged from a clean tree.

### Security and recovery coverage

Automated tests cover workspace traversal and symbolic-link escape rejection, root deletion prevention, bounded inputs/outputs, consumed approvals, digest-bound writes, shell error/timeout handling, connector validation, transactional action contracts, single-use leases, effect variance, chained receipts, portable worktree isolation, Windows provider composition, interrupted-state recovery, orphan cleanup, rollback, receipt-gated promotion, and audit redaction.

The production UI/API checks also cover approval decisions, runtime failures, settings persistence, cancellation, focus management, reflow, reduced motion, forced colors, version mismatch presentation, health, compact state, security headers, and startup from built artifacts.

### Deliberately unverified or environment-dependent

- The Firecracker+jailer adapter is not a verified boundary. HR-006 requires a real Linux host with KVM, correct binaries, dedicated non-root identity, cgroups, kernel, and rootfs evidence.
- LM Studio, llama.cpp server/CLI, and third-party MCP behavior still depends on operator-provided services and compatible models/tools.
- MCP remote-effect compensation is not implemented; MCP therefore remains compatibility-only.
- Windows Sandbox verification covers the base brokered PowerShell transport. Additional guest toolchains are capability-gated and must be tested in the target environment.

No unavailable connector, host, or isolation result is reported as passed.

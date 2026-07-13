# NexusHarness easy deployment blueprint

> Status: implementation guide with Phase 0/1 foundations and the Phase 4 release pipeline implemented in the public `dmitriy718/nexusharness` repository. The package-manager releases do not exist today. Registry and formula facts were checked on July 12, 2026; npm ownership, protected-environment configuration, clean hosted CI evidence, publication, and Homebrew work remain required before presenting target install commands as working commands.

This guide defines how NexusHarness becomes a product that a user can install, launch, diagnose, update, and remove without understanding its source tree. It covers the first practical distribution channels and the application changes those channels depend on.

## Decisions at a glance

| Concern | Decision |
| --- | --- |
| Product | **NexusHarness** |
| License | Apache-2.0 |
| npm package | `@nexusharness/cli` |
| Installed command | `nexus` |
| Homebrew formula | `nexusharness` |
| Initial Homebrew install | `brew install dmitriy718/tap/nexusharness` |
| Future Homebrew/core install | `brew install nexusharness` |
| Canonical release | Immutable, tagged GitHub release with checksums, notes, provenance, and SBOM |
| First-model strategy | Discover existing local/cloud providers, explain their privacy and cost characteristics, then guide authentication or configuration and verify with a real request |
| Primary interfaces | Browser UI and terminal CLI |
| Persistent data | Per-user platform directories, never the installation directory or current working directory |
| Normal removal | Remove program files and processes; preserve user data |
| Destructive removal | `nexus uninstall --purge`, with preview and confirmation before package removal |

The intended one-task entry points are:

```text
nexus
nexus "build a marketing site"
nexus run "build a marketing site"
nexus open
nexus doctor
nexus uninstall --purge
```

## Implementation status

| Area | Repository status | Remaining release evidence |
| --- | --- | --- |
| Identity and legal | Public `dmitriy718/nexusharness` repository, `@nexusharness/cli`, `nexus`, Apache-2.0, license, and third-party notices are implemented | Confirm npm organization ownership, tap ownership, and security/support ownership |
| Portable CLI/runtime | Compiled CLI, module-relative resources, per-user paths, service locking, dynamic ports, health checks, stop, doctor, migration, clean, and purge are implemented | Complete the supported OS/CPU matrix and clean-machine usability/reliability gates |
| npm package | Explicit production allowlist, published shrinkwrap, pinned install-script review policy, exact-package inspection, clean-prefix install/start/doctor/stop smoke test, checksums, manifest, SBOM, and release notes are implemented | Run the protected tag workflow on hosted runners, configure npm trusted publishing, and publish a prerelease |
| GitHub release | `.github/workflows/release.yml` builds once, tests the exact tarball on Node 20/22 across Linux, Intel/Apple-Silicon macOS, and Windows, attests it, creates a draft release, publishes through OIDC, and then makes the release public | Protect version tags and the `npm-release` environment; verify the workflow and rollback procedure in the real repository |
| Homebrew | Formula architecture and acceptance gates are defined below | Create `dmitriy718/homebrew-tap` only after a real immutable release URL and checksum exist; implement and test the formula in that tap |

The local Phase 4 gates are:

```bash
npm run release:artifacts
npm run release:verify-artifacts
npm run release:smoke
```

`release:artifacts` stamps the browser build with the source commit and commit timestamp, then produces the exact npm tarball, `artifact-manifest.json`, `SBOM.cdx.json`, `SHA256SUMS`, and version-specific release notes under ignored `release-artifacts/`. The smoke gate installs that exact tarball into a clean temporary global prefix, launches it from an unrelated path containing spaces and Unicode, runs `nexus --version`, `nexus doctor --non-interactive`, starts and probes the loopback service, stops it, and removes the isolated data.

## What works now and what must change

The repository supports a repeat-safe **source installation** through `quickstart.sh` and `quickstart.ps1`, plus a portable compiled CLI and a locally verified npm tarball. Keep the quickstart scripts for contributors, evaluation, and source checkouts. Until the exact package passes the hosted release gates and is published, the honest immediate path is:

```bash
git clone https://github.com/dmitriy718/nexusharness.git
cd nexusharness
./quickstart.sh
```

```powershell
git clone https://github.com/dmitriy718/nexusharness.git
Set-Location .\nexusharness
.\quickstart.ps1
```

Do not label that workflow a one-command end-user install: it still requires a source checkout. The repository is public and its manifest and runtime portability blockers have been corrected, but the npm package is not yet public. Publication remains blocked on registry ownership, protected hosted CI, trusted-publisher configuration, the supported-platform matrix, and successful canary evidence. Never substitute a locally built tarball or an illustrative formula checksum for those gates.

The first supported end-user release should make these commands true:

```bash
npm i -g @nexusharness/cli
nexus doctor
nexus
```

On macOS or Linux with Homebrew, the first supported formula should make these commands true:

```bash
brew install dmitriy718/tap/nexusharness
nexus doctor
nexus
```

Those commands are release targets. At the time of research, `@nexusharness/cli` was not published and the tap still had to be created.

## Why the install names differ from the command

The names `nexus` are already occupied in both target registries:

- [`nexus` on npm](https://www.npmjs.com/package/nexus) is the GraphQL Nexus package. `npm view nexus` identifies it as “Scalable, strongly typed GraphQL schema development.” NexusHarness therefore cannot use `npm i -g nexus`.
- [`nexus` in Homebrew core](https://formulae.brew.sh/formula/nexus) is Sonatype's repository manager. `brew install nexus` installs that product, not NexusHarness.

Use the scoped npm identity `@nexusharness/cli` and the Homebrew formula name `nexusharness`. An npm package's `bin` map is independent of its registry name, so the scoped package can still install the short `nexus` executable. Homebrew can likewise expose `nexus` from the unambiguous `nexusharness` formula.

Do not create a same-named `nexus` tap formula. Homebrew searches core before other taps for an unqualified name, and duplicate tap formulae require a fully qualified reference; its [tap documentation](https://docs.brew.sh/Taps) and [formula naming guidance](https://docs.brew.sh/Formula-Cookbook) both favor avoiding that ambiguity.

## Distribution architecture

### One release, two package managers

Build one immutable release payload from one tagged commit. Promote the exact tested payload through npm and the project Homebrew tap; never rebuild application code independently after the tag. GitHub Releases is the canonical record and should contain:

```text
nexusharness-<version>/
  bin/
    nexus.js                 # compiled entry point with a Node shebang
  server/                    # compiled server/runtime modules
  web/                       # compiled browser assets
  migrations/               # ordered, idempotent data migrations
  runtime/                   # required schemas/templates/non-code assets
  package.json
  README.md
  LICENSE
  THIRD_PARTY_NOTICES.md
  SBOM.cdx.json
SHA256SUMS
release-notes.md
```

“Same release” means the npm tarball and Homebrew input have identical application files and version metadata from the tagged build. Channel-specific wrappers and metadata may differ. Record the SHA-256 of every artifact and a manifest of file hashes so CI can prove that no channel silently changed the payload.

The release bundle must contain compiled JavaScript, production browser assets, migrations, license and notices, and every runtime asset the application needs. Consumers must not need TypeScript, Vite, a Git checkout, or development dependencies. Use an explicit allowlist; never depend only on `.gitignore`/`.npmignore` to prevent secrets and local state from leaking.

The bundle also needs a reproducible production dependency closure. Bundle pure JavaScript where practical; pin remaining production dependencies exactly and publish an `npm-shrinkwrap.json` when npm must install them. Native modules require tested platform artifacts or a declared build path. A Homebrew archive may add a channel/platform dependency envelope around the identical application payload, but it must not fetch unversioned code. Record both layers in the release manifest and test the fully installed result, not just the inner application files.

### Portable launcher

Implement a small `nexus` launcher whose own module URL determines the installation root. In ESM, derive it from `import.meta.url`/`fileURLToPath`, then resolve `server`, `web`, migrations, and package metadata relative to that root. Reserve `process.cwd()` for the user's task context only. In particular:

- Static browser files must resolve from `<install-root>/web`, not `./dist`.
- Version metadata must resolve from the installed package, not `./package.json`.
- Migrations and runtime assets must resolve from the installed package.
- A launch directory is not automatically a workspace. An explicit CLI path or persisted workspace wins; otherwise onboarding asks for one.
- Installation resources are immutable. The server must never write logs, databases, downloads, credentials, locks, sockets, or generated configuration into them.

Pass resolved paths into the server rather than rediscovering them throughout the codebase. A useful internal contract is:

```ts
interface InstallationPaths {
  root: string;
  serverEntry: string;
  webRoot: string;
  migrationsRoot: string;
  packageJson: string;
}
```

### Per-user service

`nexus` should start or reconnect to one loopback-only service per operating-system user:

1. Acquire a per-user single-instance lock with process identity and creation time.
2. Read the service state file and verify that the recorded process is alive and belongs to the expected executable/version.
3. Probe the authenticated loopback health endpoint; never trust a PID or port alone.
4. If stale, safely remove only the stale Nexus-owned lock/state and start a replacement.
5. Bind to `127.0.0.1`/`::1`. If the preferred port is occupied, select a free port and atomically persist it instead of failing or killing an unrelated process.
6. Wait for readiness with a bounded timeout, then open the browser unless `--no-open` or terminal mode applies.
7. Handle `SIGINT`, `SIGTERM`, console close, and package removal cleanly. `nexus stop` performs an authenticated graceful shutdown and reports whether force cleanup was needed.

Because Homebrew has no general uninstall hook and npm lifecycle scripts can be disabled, process cleanup cannot rely only on a package-manager callback. The service must periodically verify a short installation lease (the expected launcher/package manifest still exists and matches its recorded install identity) and exit within a documented bounded interval when the installation disappears. npm may also use a safe `preuninstall` stop as a convenience, but correctness must not depend on it. Test direct package removal while the service is running.

Do not start a persistent service during `npm install` or `brew install`. Install hooks must not edit shell profiles, download models, collect credentials, start daemons, or make user-content network requests. First launch is the right time for explicit, visible setup.

### Native dependency strategy

The current dependency graph includes `better-sqlite3`, `sqlite-vec`, and Transformers.js/ONNX-related runtime components. They can introduce Node ABI, libc, CPU architecture, code-signing, and platform-binary constraints. Before declaring a platform supported:

- Inventory every native/transitive binary and its license.
- Establish whether it has compatible prebuilds for each Node/OS/architecture combination.
- Test fallback source builds on clean machines or fail early with an actionable prerequisite message.
- Verify Apple Silicon and Intel separately, and glibc Linux separately from any explicitly supported musl target.
- Keep runtime Node compatibility separate from the newer Node/npm version used by the npm publishing job.
- Pin or lock native payloads, verify checksums, and prohibit unversioned install-time downloads.
- Decide whether optional local embedding support belongs in the base package or an explicitly installed component. A large model is never bundled or downloaded silently.

The manifest now records pinned `allowScripts` approvals for the reviewed versions of `better-sqlite3`, ONNX Runtime, Sharp, protobufjs, and the build-only esbuild dependency. `npm approve-scripts --allow-scripts-pending` must remain empty in release CI. npm documents that this policy is advisory today but is intended to become enforcement, and that global installs use command-line or user configuration rather than the package's project policy. The exact-tarball smoke therefore derives `--allow-scripts` from those pinned approvals when it installs into its isolated global prefix. Re-evaluate this behavior whenever the publishing npm major changes ([npm approve-scripts](https://docs.npmjs.com/cli/v11/commands/npm-approve-scripts/), [npm install configuration](https://docs.npmjs.com/cli/install/)).

Publish a support matrix before release. Until evidence expands it, a conservative starting promise is Node 20 and 22 LTS on Windows x64/arm64 where native dependencies pass, macOS Apple Silicon and Intel, and mainstream glibc Linux x64/arm64. Do not put that matrix in package metadata until CI proves every listed cell.

## npm release channel

### Registry preparation

1. Create or confirm control of the `nexusharness` npm organization.
2. Reserve and initially publish `@nexusharness/cli`; a registry 404 proves only that it was not publicly visible when checked, not that ownership is guaranteed.
3. Require 2FA for maintainers and least-privilege organization roles.
4. Publish a harmless prerelease only after its exact tarball has passed the clean-install gates.

npm's [scoped public package guide](https://docs.npmjs.com/creating-and-publishing-scoped-public-packages/) requires an organization for an organization-scoped package and notes that scoped packages default to private visibility. The first public publication therefore uses `npm publish --access public` (or `publishConfig.access`).

### Production manifest

The distributable CLI can be a dedicated workspace/package rather than changing the entire repository root into the published unit. Its manifest should follow this shape, with URLs and supported platforms confirmed before release:

```json
{
  "name": "@nexusharness/cli",
  "version": "2.1.0",
  "description": "Local-first AI task harness with browser and terminal interfaces.",
  "license": "Apache-2.0",
  "type": "module",
  "bin": {
    "nexus": "bin/nexus.js"
  },
  "files": [
    "bin/",
    "server/",
    "web/",
    "migrations/",
    "runtime/",
    "README.md",
    "LICENSE",
    "THIRD_PARTY_NOTICES.md",
    "SBOM.cdx.json"
  ],
  "engines": {
    "node": ">=20"
  },
  "os": ["darwin", "linux", "win32"],
  "cpu": ["arm64", "x64"],
  "repository": {
    "type": "git",
    "url": "git+https://github.com/dmitriy718/nexusharness.git"
  },
  "homepage": "https://github.com/dmitriy718/nexusharness#readme",
  "bugs": {
    "url": "https://github.com/dmitriy718/nexusharness/issues"
  },
  "keywords": ["local-ai", "coding-agent", "mcp", "ollama", "lm-studio"],
  "publishConfig": {
    "access": "public"
  },
  "scripts": {
    "prepack": "npm run build:release && npm run verify:package"
  }
}
```

The actual package version must come from the repository's synchronized SemVer source. Replace the root manifest's `private: true` and `UNLICENSED` only when the repository really has adopted Apache-2.0 and includes `LICENSE` and third-party notices. Do not copy the sample version mechanically.

The `bin/nexus.js` file must be executable in the packed artifact and begin with:

```js
#!/usr/bin/env node
```

Use `prepack` to compile and validate the allowlisted payload. It must not make the installed user's machine compile the project. Avoid lifecycle scripts such as `postinstall` unless they are demonstrably essential, offline-safe, repeatable, and side-effect-free; ideally the package has none.

### Package verification

CI must build once, run `npm pack --json`, and treat the resulting `.tgz`—not the working tree—as the test subject. Gates include:

```bash
npm pack --json
npm install -g ./nexusharness-cli-<version>.tgz
nexus --version
nexus doctor --non-interactive
nexus open --no-open
npm uninstall -g @nexusharness/cli
```

Audit the tarball's file list, unpacked size, dependency inventory, executable mode, shebang, licenses, and secrets. Install it in a clean temporary user profile and launch it from a directory unrelated to the repository, including a path with spaces and Unicode and a read-only current directory. Repeat for upgrade and downgrade boundaries. Confirm that the application works without source files or global build tools.

### Secure publication

Publish from a protected Git tag through a GitHub-hosted Actions runner using npm trusted publishing. npm's current [trusted publishing documentation](https://docs.npmjs.com/trusted-publishers/) says OIDC avoids long-lived registry tokens, requires npm CLI 11.5.1+ and Node 22.14.0+ in the publishing job, and requires `id-token: write` for GitHub Actions. Trusted-publisher configurations created after May 20, 2026 must also select an allowed action; the current `release.yml` needs `npm publish` permission. That release-job requirement does not force the installed CLI to drop Node 20 if runtime tests still support it.

Recommended controls:

- Protected version tags and a protected GitHub release environment.
- Version agreement among package metadata, tag, changelog, browser/API version, bundle manifest, and formula.
- Build, tests, tarball audit, clean global-install smoke tests, vulnerability/license checks, secret scanning, and SBOM generation before publication.
- An npm trusted publisher restricted to `dmitriy718/nexusharness`, workflow filename `release.yml`, environment `npm-release`, and only the action the workflow uses (`npm publish` today). Prefer staged publishing with maintainer 2FA approval for the strongest future release control, but change both the workflow and trusted-publisher permission together.
- No stored `NPM_TOKEN`. After trusted publishing is proven, disallow traditional publish tokens.
- Public repository and public package so GitHub Actions trusted publishing automatically produces npm provenance, as documented by npm.
- Attach the tarball checksum and file manifest to the same GitHub release.

Use distribution tags deliberately:

| npm tag | Purpose | Promotion rule |
| --- | --- | --- |
| `canary` | Optional short-lived commit builds | Automated compatibility signal; never silently promoted |
| `next` | Release candidate/prerelease | Clean-machine canary cohort passes and release owner approves |
| `latest` | Supported stable release | Exact `next` version is verified and promoted without rebuilding |

Do not overwrite a released version. Deprecate a bad version, publish a fixed SemVer version, move the appropriate dist-tag, and document rollback.

### npm user lifecycle

```bash
# Install
npm i -g @nexusharness/cli

# Verify or repair
nexus doctor

# Update within the selected npm tag
npm update -g @nexusharness/cli

# Preserve Nexus data, then remove the program
nexus stop
npm uninstall -g @nexusharness/cli

# Preview and purge Nexus-owned state before removing the program
nexus uninstall --purge --dry-run
nexus uninstall --purge
npm uninstall -g @nexusharness/cli
```

## Homebrew release channel

### Two-stage publication

Launch with a maintained repository named `dmitriy718/homebrew-tap` and a formula named `nexusharness`:

```bash
brew install dmitriy718/tap/nexusharness
```

The fully qualified command is explicit, works without a separate `brew tap` step, and cannot be mistaken for the existing core `nexus` formula. Once NexusHarness has stable tagged releases, an acceptable open-source build, maintenance history, real third-party use, and sufficient adoption, apply to Homebrew/core. Current [core acceptance guidance](https://docs.brew.sh/Acceptable-Formulae) requires supported-platform builds/tests, stable tagged versions, a DFSG-compatible open-source license, maintainability, notability, and use beyond the author. Its published thresholds can change and must be rechecked when applying.

After acceptance, the stable command becomes:

```bash
brew install nexusharness
```

Retain the tap for prereleases only if that distinction is clear and maintainable.

### Formula design

The formula must:

- Point to an immutable, versioned release URL and verify its SHA-256.
- Declare `node` and every build/runtime native dependency that is not safely contained in the artifact.
- Install private application resources under `libexec`.
- Link only the `nexus` launcher into Homebrew's `bin`.
- Use the same tested application payload as npm and verify its embedded manifest.
- Avoid install-time service startup, credentials, shell-profile edits, model downloads, telemetry, or writes outside the Homebrew prefix.
- Disable application self-updating. `nexus update` must detect Homebrew and direct the user to `brew upgrade nexusharness`; Homebrew's acceptance policy explicitly discourages tools that bypass its upgrade mechanism.

A tap formula can start with this **illustrative** shape; adapt it to the finalized artifact and use valid release checksums:

```ruby
class Nexusharness < Formula
  desc "Local-first AI task harness with browser and terminal interfaces"
  homepage "https://github.com/dmitriy718/nexusharness"
  url "https://github.com/dmitriy718/nexusharness/releases/download/v2.1.0/nexusharness-2.1.0.tar.gz"
  sha256 "REPLACE_WITH_RELEASE_SHA256"
  license "Apache-2.0"

  depends_on "node"

  def install
    libexec.install Dir["*"]
    bin.install_symlink libexec/"bin/nexus.js" => "nexus"
  end

  test do
    ENV["NEXUSHARNESS_DATA_DIR"] = testpath/"data"
    assert_match version.to_s, shell_output("#{bin}/nexus --version")
    assert_match '"ok":true', shell_output("#{bin}/nexus doctor --non-interactive --json")
    assert_match '"status":"healthy"', shell_output("#{bin}/nexus probe --isolated --no-open --json")
  end
end
```

Validate the precise symlink/wrapper behavior on Intel and Apple Silicon. If the packaged launcher's shebang cannot reliably select the declared Homebrew Node, use a Homebrew-generated wrapper that invokes `Formula["node"].opt_bin/"node"` and the private script. The [Formula Cookbook](https://docs.brew.sh/Formula-Cookbook) documents `libexec` as private formula storage, relative `bin` symlinks, and non-interactive `test do` blocks. Its guidance says a functional test is stronger than only `--version`, which is why the isolated health probe is mandatory.

For eventual Homebrew/core submission, revisit artifact strategy: core generally expects source builds or acceptable cross-platform artifacts rather than an opaque binary-only formula. The formula must be able to reproduce or validate the application from the tagged open-source release without fetching unversioned content. A project tap is not permission to weaken checksum, license, or test controls.

### Homebrew verification and lifecycle

Run at least:

```bash
brew audit --strict --online nexusharness
brew style nexusharness
brew install --build-from-source dmitriy718/tap/nexusharness
brew test dmitriy718/tap/nexusharness
brew upgrade nexusharness
brew uninstall nexusharness
brew autoremove
```

Also test bottles for every supported architecture, installation from the tagged source, upgrades from each supported prior release, a deliberate downgrade/rollback procedure, an interrupted upgrade, and uninstall while the service is running. Formula tests must isolate `HOME`/data, use no real credentials, open no browser, clean up their child process, and perform a real startup/health interaction.

Normal `brew uninstall nexusharness` removes Homebrew-managed program files but intentionally preserves NexusHarness user data. Document purging before uninstall:

```bash
nexus uninstall --purge --dry-run
nexus uninstall --purge
brew uninstall nexusharness
brew autoremove
```

## First-run experience

The first safe task should not require users to understand agents, roles, memory modes, MCP, execution backends, or validation commands. On `nexus`:

1. Start or reconnect to the per-user service and perform fast installation, storage, database, loopback, and port checks.
2. Open the browser unless terminal mode or `--no-open` was requested.
3. Ask for the preferred view: **Simple/Chat**, **Studio/IDE**, or **Orchestrate/Agents**. Persist the choice and keep it changeable in Settings.
4. Discover configured providers and installed local runtimes without sending project content. Candidate sources include explicit Nexus settings, approved environment-variable names, loopback Ollama/LM Studio/llama.cpp endpoints, and installed local binaries.
5. Show what was found and ask before testing anything remote. A local loopback discovery probe may be automatic if it has no content; disclose it.
6. Test the chosen provider with the smallest real health/model request. A listed model, open port, or saved key is not proof of readiness.
7. If no provider is ready, present choices with exact prerequisites, authentication steps, data destination, likely cost, and whether project content leaves the machine. Never echo or persist raw secrets in ordinary settings/logs.
8. Focus the task input as soon as verification succeeds. Optional advanced settings stay out of the critical path.
9. Classify and route the request automatically.
10. Immediately display the interpreted task, workspace, workflow/agent, model, requested permissions, phase, and progress.

Target: a user with a working existing provider reaches the task input and starts a verified request in under one minute. Offline startup must remain useful: the UI opens, local history/settings work, discovery explains what is unavailable, and remote-dependent actions are clearly blocked rather than presented as application crashes.

## Deterministic task router

Put a single routing layer between task intake and execution so the browser and CLI make the same decision. Its versioned decision schema should contain:

```ts
interface RoutingDecision {
  requestId: string;
  intent: string;
  category: string;
  workspace: string | null;
  requiredCapabilities: string[];
  workflow: string;
  agents: string[];
  provider: string;
  model: string;
  permissions: Array<{ capability: string; scope: string; reason: string }>;
  risk: "low" | "medium" | "high" | "critical";
  confidence: number;
  missingPrerequisites: string[];
  explanation: string;
  routerVersion: string;
}
```

Routing order is deterministic:

1. Honor explicit workspace, workflow, agent, provider, model, and permission selections.
2. Reuse verified providers and workspace defaults compatible with required capabilities.
3. Filter out models that lack a required context, tool, modality, or policy capability.
4. Prefer the user's saved cost/privacy/locality priorities; otherwise use documented safe defaults.
5. Route ambiguous low-risk work with a reversible default.
6. Ask one focused question only when interpretations would materially change the result, target, cost, or required authority.
7. Present the route before consequential execution and require approval for newly requested authority.

Never silently broaden filesystem, network, credential, destructive, or external-service permissions. Allow a user to change model, workspace, or route without recreating the task. Store the decision and explanation in diagnostics with secrets redacted. Record subsequent reroutes as new versions, not destructive edits to history.

## Failure transparency and recovery

### Shared failure contract

Use one versioned failure object across the server, CLI, task timeline, and browser UI:

```json
{
  "schemaVersion": 1,
  "code": "PROVIDER_AUTH_REJECTED",
  "category": "provider_authentication",
  "title": "The provider rejected authentication",
  "whatFailed": "Planner model preflight",
  "why": "The configured credential was rejected by the provider.",
  "stage": "provider_preflight",
  "effects": { "changed": false, "summary": "No workspace files were changed." },
  "retry": { "safe": true, "automaticAttempted": false },
  "action": "Reauthenticate this provider or select another verified model.",
  "actions": ["reauthenticate", "change_model", "view_details"],
  "correlationId": "req_...",
  "diagnostics": { "providerStatus": 401 }
}
```

Every failure identifies:

- A stable error code and plain-language title.
- What failed, why, and at which execution stage.
- Whether work, settings, external systems, or files changed; list known partial effects.
- Whether retry is safe and what automatic recovery was attempted.
- The exact action needed from the user.
- Sanitized diagnostic detail and a correlation ID.
- A copyable support bundle with secrets and user content redacted by default.

Use these cause categories: Nexus defect, environment/prerequisite, provider/authentication, model capability/policy, request validation, permission denial, tool failure, workspace conflict, cancellation, and partial completion. A backend defect must remain a Nexus defect; never rewrite it as a user mistake.

### States and actions

The UI and CLI must distinguish `waiting`, `blocked`, `failed`, `cancelled`, `degraded`, and `partially_completed`. Only `failed` indicates an ended unsuccessful operation; waiting for approval is not a failure. Contextual recovery actions include Retry, Repair, Reauthenticate, Change model, Grant permission, Edit request, Resume, and View details. Enable an action only when its preconditions are true.

Retries must be idempotent or warn about duplicate external effects. Resume from durable checkpoints, show already completed effects, and never rerun destructive or billable work silently. Cancellation reports the last durable checkpoint and any operations that could not be cancelled.

Release-blocking reliability gates are zero uncaught expected task failures, verified storage consistency, idempotent startup, safe stale-process cleanup, port-conflict recovery, provider timeouts, corrupt/locked database recovery, interruption-safe migrations, and tested application/package rollback.

## Data placement, migration, and removal

### Per-user paths

Separate configuration, durable data, service state, and disposable cache internally even where a platform groups them under one application root:

| Platform | Configuration and durable data | State/runtime | Cache |
| --- | --- | --- | --- |
| Windows | `%LOCALAPPDATA%\NexusHarness\config` and `...\data` | `%LOCALAPPDATA%\NexusHarness\state` | `%LOCALAPPDATA%\NexusHarness\cache` |
| macOS | `~/Library/Application Support/NexusHarness/config` and `.../data` | `~/Library/Application Support/NexusHarness/state` | `~/Library/Caches/NexusHarness` |
| Linux | `${XDG_CONFIG_HOME:-~/.config}/nexusharness` and `${XDG_DATA_HOME:-~/.local/share}/nexusharness` | `${XDG_STATE_HOME:-~/.local/state}/nexusharness` | `${XDG_CACHE_HOME:-~/.cache}/nexusharness` |

Continue honoring `NEXUSHARNESS_DATA_DIR` as an explicit absolute override for the Nexus-managed root. Define its precedence over platform defaults and keep temporary/cache subdirectories identifiable. It must never cause user workspaces to become Nexus-owned data.

Store credentials in the operating system's secure credential facility where possible—Windows Credential Manager/DPAPI, macOS Keychain, or an appropriate Linux secret service. If a headless fallback is necessary, require explicit opt-in, restrictive permissions, encryption/key handling, and clear limitations. Logs, routing diagnostics, environment dumps, crash reports, and support bundles must redact credential values and sensitive headers.

### Legacy migration

On first launch after the path change:

1. Look for `.nexusharness` only in safe, explicit legacy candidates such as the previous installation/source root and selected workspace; do not recursively scan the disk.
2. Explain what was found, the source and destination, size, and whether the source will remain.
3. Offer **Copy and verify** as the safe default, plus Skip. Moving/deleting legacy data requires separate confirmation.
4. Lock both locations, copy to a staging directory, validate schema/database integrity and file counts/hashes, atomically promote, and record the migration.
5. Preserve the original until the new service has opened and passed health checks. Make reruns idempotent.
6. Never treat user-created workspace files as legacy application data.

### Normal uninstall versus purge

Package-manager uninstall removes installed program files. It must leave workspaces, user-created files, credentials, settings, memories, audit history, and run data untouched unless the user explicitly chose purge. It must leave no executable, autostart entry, scheduled job, or running background process behind.

`nexus uninstall --purge` runs **before** removing the package and performs:

1. Discovery of the active installation channel and every Nexus-owned config/data/state/cache/credential location.
2. A categorized preview with paths, sizes, running process, and explicit exclusions such as workspaces.
3. Confirmation naming the destructive operation; non-interactive purge requires an additional explicit confirmation flag.
4. Graceful service shutdown and verified process exit.
5. Credential deletion from the secure store when requested.
6. Removal using real-path containment checks against the known Nexus-owned roots.
7. A final report of removed, preserved, failed, and manually actionable items.

Support:

```text
--dry-run
--keep-data
--keep-credentials
--non-interactive --confirm-purge
```

`nexus clean` separately removes selected caches, stale downloads, old support bundles, and safe temporary data without deleting durable history or credentials.

## Stable CLI contract

| Command | Contract |
| --- | --- |
| `nexus` | Start/reconnect and open the preferred interactive view |
| `nexus "<task>"` | Submit one task and follow it interactively |
| `nexus run "<task>"` | Explicit task submission; suitable for scripted flags |
| `nexus open` | Open the browser UI for the running service |
| `nexus status` | Show service, version, provider readiness, and current-task state |
| `nexus doctor` | Diagnose installation and safely repair eligible problems |
| `nexus config` | Inspect/change settings without directly editing internal files |
| `nexus providers` | Discover, configure, authenticate, and test providers |
| `nexus logs` | Show or export sanitized diagnostics |
| `nexus update` | Detect install channel and explain/perform only channel-approved updates |
| `nexus clean` | Preview and remove disposable Nexus cache/temp data |
| `nexus stop` | Gracefully stop the per-user service |
| `nexus uninstall --purge` | Preview, confirm, and remove Nexus-owned state |

Cross-command flags:

```text
--json               Stable machine-readable result on stdout
--no-open            Never launch a browser
--verbose            Detailed sanitized diagnostics on stderr
--non-interactive    Never prompt; fail with a documented action when input is required
```

Commands must work from every directory and supported shell. Human-readable output goes to stderr when `--json` reserves stdout. Never put progress spinners or logs into JSON output. Handle quoting without reconstructing task text through a shell.

Document stable exit-code families:

| Code | Meaning |
| ---: | --- |
| 0 | Success, including an explicitly healthy/idle state |
| 1 | Nexus internal error |
| 2 | Invalid command/request |
| 3 | Missing prerequisite or unhealthy installation |
| 4 | Provider/authentication/model unavailable |
| 5 | Permission or approval denied |
| 6 | Workspace conflict or validation failure |
| 7 | Partial completion; inspect structured effects |
| 8 | Cancelled or interrupted |
| 10 | User input required in non-interactive mode |

Subcommands may expose stable detailed error codes in JSON, but must not repurpose these process codes between releases.

### `nexus doctor`

Doctor checks the executable/install root, Node/runtime compatibility, bundle manifest and checksums, user-directory permissions, database integrity/migrations, service lock/PID/port/health, browser launch capability, provider configuration, native modules, credential-store access, disk space, and update-channel metadata. It should repair only operations that are bounded, reversible, and Nexus-owned. Anything else gets a copyable command or exact manual action.

`nexus doctor --non-interactive` must never prompt or silently alter consequential settings. `--repair` previews repairs before applying them; in JSON it returns planned/applied repairs and restart requirements. Provider tests do not transmit project content.

### `nexus update`

Record installation provenance at package time, then behave by channel:

- npm: show the installed/current version and run or instruct `npm update -g @nexusharness/cli`; never assume privilege escalation.
- Homebrew: instruct `brew upgrade nexusharness` and do not self-modify.
- Source checkout: point to the documented Git/quickstart contributor update path.
- Unknown/manual: explain the detected executable path and provide no destructive guess.

Before a breaking data migration, create a validated backup and report rollback compatibility. Application rollback and data rollback are separate operations.

## Privacy, security, and operability

- NexusHarness remains local-first. Discovery sends no project content, and remote provider calls identify their destination before the first request.
- Bind the service to loopback and authenticate browser/CLI clients with a per-user secret protected by filesystem permissions. Defend browser endpoints against cross-origin and DNS-rebinding attacks.
- Never place credentials in command arguments, URLs, logs, task records, support bundles, or package artifacts.
- Sign or attest release artifacts where supported; publish SHA-256 checksums, npm provenance, an SBOM, license inventory, and release notes.
- Generate support bundles locally with a file manifest and redaction report. Make inclusion of task content/workspace files opt-in and previewable.
- Collect no task content in telemetry. If operational telemetry is introduced, obtain consent and restrict it to fields such as failure stage/code, recovery result, setup abandonment, duration, and time to first task.
- Define a vulnerability-reporting channel, supported-version policy, security-fix window, release owner, backup compatibility, and deprecation window before public distribution.

## Verification matrix and release gates

### Automated coverage

Every release candidate must test:

- npm tarball contents, executable permissions, package size, licenses, secrets, and production dependency completeness.
- Global npm install, `next` to `latest` promotion, upgrade, supported downgrade/rollback, and uninstall.
- Homebrew audit/style, source install, bottle install, functional formula test, upgrade, rollback recovery, uninstall, and `autoremove`.
- Windows PowerShell, supported macOS versions, and supported Linux distributions; Intel/x64 and ARM64 wherever promised.
- Launch from unrelated directories, paths with spaces and Unicode, a read-only current directory, and a fresh user profile without repository files.
- Port conflicts, stale/corrupt process state, duplicate launch, abrupt termination, and clean shutdown.
- Missing, corrupt, wrong-architecture, and partially installed native dependencies.
- First-run view persistence, later view changes, and reset/reconfiguration.
- Provider discovery, real readiness verification, authentication failure, timeout, rate limit, offline state, model incompatibility, and recovery.
- Direct one-command task submission, deterministic routing, rerouting, and permission non-escalation.
- Identical browser/CLI failure category, stage, effects, corrective action, and correlation ID.
- Offline startup, history access, and accurate degraded state.
- Legacy-data migration success, interruption, rerun, corruption, and rollback.
- Normal uninstall preserving data and leaving no process/executable; purge preview, keep flags, complete cleanup, and containment against workspace deletion.
- Data/schema compatibility across every supported upgrade and rollback boundary.
- Git tag, version, changelog, artifact manifest, checksums, npm provenance, SBOM, and Homebrew formula agreement.
- No credentials, `.env` files, user state, private files, or unredacted content in npm tarballs, archives, logs, telemetry, or support bundles.

Test installation on clean machines or disposable VMs—not only containers that inherit developer tools. Maintain fixtures for a space/Unicode username, restrictive permissions, occupied default port, locked database, stale service state, offline network, and expired provider credential.

### Launch acceptance targets

A stable launch is blocked until all are true:

- Installation completes without administrator access when the user's package manager is correctly configured.
- `nexus` launches from any directory and does not write into that directory.
- A user with a working existing provider reaches focused task input and starts a real task in under one minute.
- Setup never claims a model is ready until a real provider request succeeds.
- Every failed task states its stage, cause category, known effects, retry safety, and next corrective action.
- No expected failure reaches an uncaught exception; no critical backend/data-consistency defect is open.
- `nexus doctor` detects all catalogued installation problems and repairs every safely repairable one.
- Normal uninstall leaves no executable, autostart entry, or running process and preserves persistent data.
- Purge previews and removes only Nexus-owned state, with workspaces explicitly excluded.
- npm and Homebrew application artifacts originate from the same tagged, tested commit and match the release manifest.

## Phased implementation plan

### Phase 0 — identity, legal, and release prerequisites

- Adopt Apache-2.0; add `LICENSE`, copyright attribution, and third-party notices.
- Create/confirm the `nexusharness` npm organization and reserve `@nexusharness/cli`.
- Create and secure `dmitriy718/homebrew-tap`.
- Establish supported Node, OS, architecture, libc, and native-dependency versions.
- Define release ownership, vulnerability reporting, support/deprecation policy, and data rollback policy.
- Establish signed/protected Git tags, GitHub Releases, synchronized versioning, and a conventional changelog.

**Exit gate:** identities are controlled, licensing is publishable, and support/security boundaries are public.

### Phase 1 — portable runtime and CLI

- Split immutable application resources from per-user configuration/data/state/cache.
- Remove installation-resource and data-path dependence on `process.cwd()`.
- Build the compiled shebang-equipped `nexus` launcher and stable command/exit-code contract.
- Add authenticated service discovery, single-instance locking, port recovery, health checks, readiness, and clean shutdown.
- Implement platform directories, secure credentials, legacy-data migration, `--json`, and install provenance.

**Exit gate:** a packed install launches from a clean temporary directory on every supported platform.

### Phase 2 — first run and task routing

- Make Simple/Chat, Studio/IDE, or Orchestrate/Agents the first lightweight choice.
- Add privacy-preserving provider discovery, guided authentication, and real readiness verification.
- Move optional workspace/agent/runtime/memory configuration off the first-task critical path.
- Implement the versioned deterministic router, explanation, direct CLI submission, and rerouting.
- Persist onboarding state and allow complete reconfiguration in Settings.

**Exit gate:** an existing-provider user can install, launch, and start a real task in under one minute.

### Phase 3 — failure model and self-repair

- Introduce the shared failure schema and state model.
- Map server, broker, execution backend, provider, model, tool, validation, permission, cancellation, and partial completion into it.
- Add task timelines, actionable failure panels, effect reporting, safe retry/resume, and correlation IDs.
- Implement doctor, sanitized support bundles, port/stale-process repair, database checks/recovery, native-module checks, and provider diagnostics.
- Add consented content-free operational metrics if telemetry is desired.

**Exit gate:** every catalogued failure tells the truth and provides a corrective action; expected failures never become unhandled exceptions.

### Phase 4 — npm channel

- [x] Create the production package, explicit allowlist, published shrinkwrap, and compiled entry point.
- [x] Add tag/version/changelog enforcement and GitHub Actions trusted publishing without a stored registry token.
- [x] Build, inspect, checksum, inventory, and locally smoke-test the exact tarball from a clean temporary prefix.
- [ ] Run the exact-tarball matrix on clean hosted Linux, Intel/Apple-Silicon macOS, and Windows runners.
- [ ] Configure the protected `npm-release` environment and npm trusted publisher for the exact workflow path.
- Publish under `next` or stage it, run canaries, then promote the same version to `latest`.
- [x] Generate checksum manifest, CycloneDX SBOM, file manifest, and matching changelog-derived release notes; hosted provenance is generated by the protected workflow.

**Exit gate:** `npm i -g @nexusharness/cli && nexus doctor --non-interactive` passes everywhere supported.

### Phase 5 — Homebrew tap

- Add `Formula/nexusharness.rb` to `dmitriy718/homebrew-tap` using an immutable release and SHA-256.
- Add functional formula tests and CI for supported macOS/Linux architectures.
- Test source/bottle install, upgrade, rollback recovery, uninstall, no-process-left-behind, and preserved data.
- Document the fully qualified tap command and diagnostics.

**Exit gate:** `brew install dmitriy718/tap/nexusharness && nexus doctor --non-interactive` passes in clean environments.

### Phase 6 — production hardening and launch

- Complete security, dependency, native-binary, license, secret, artifact, and SBOM reviews.
- Run clean-machine usability studies with people unfamiliar with the repository.
- Measure install duration, onboarding completion, time to first task, failure comprehension, repair success, upgrades, and removal.
- Block launch on critical backend defects, inconsistent data, or ambiguous destructive behavior.
- Publish incident, compromise, rollback, hotfix, dist-tag/formula rollback, and package-deprecation procedures.

**Exit gate:** reliability targets are met and every supported release can be safely upgraded, removed, or rolled back.

### Phase 7 — Homebrew/core candidacy

- Build a track record of stable tagged releases and responsive upstream maintenance.
- Demonstrate Homebrew's current notability and third-party-use expectations.
- Confirm the source/artifact strategy, license, dependencies, and tests meet then-current core rules.
- Submit the unambiguous `nexusharness` formula and keep the tap only where it has a clear role.

**Exit gate:** the supported stable release installs with `brew install nexusharness`.

## Release runbook

For every release:

1. Freeze a SemVer version and changelog; verify legal, support, schema, and migration impact.
2. Build once from a clean protected tag and generate the bundle manifest, checksums, SBOM, and notices.
3. Run the complete source tests and clean-machine artifact matrix.
4. Create a draft GitHub release containing the immutable artifacts and notes.
5. Publish/stage the exact npm tarball with OIDC, install it from the registry under `next`, and compare it to the manifest.
6. Run the canary period. Fix by publishing a new version—never mutate the old artifact.
7. Promote the verified npm version to `latest` without rebuilding.
8. Update the tap formula to the matching tagged artifact/checksum; audit, test, bottle, and install it from the tap.
9. Verify update, normal uninstall, purge, and rollback from real package-manager installations.
10. Publish the release, support notes, known issues, and rollback commands; monitor content-free health signals.

If a release is defective, stop promotion, move npm tags back to the last supported version where safe, deprecate the bad package version with a precise message, revert/update the tap formula through normal version control, and publish a hotfix. Never tell users to delete arbitrary data directories or downgrade across a non-reversible migration without a validated backup/restore path.

## Assumptions and required confirmations

- The repository is public under Apache-2.0 and includes the required license and third-party notices.
- The `nexusharness` npm organization and package identity must be created/confirmed by an authorized owner.
- `dmitriy718/homebrew-tap` must be created and maintained by an authorized owner.
- GitHub Releases remains the canonical immutable artifact source, while npm and Homebrew are delivery channels.
- Users bring a local runtime or cloud-provider account/key. NexusHarness discovers and verifies it but does not bundle a large model.
- Local-first means project content is not silently transmitted. Remote use is explicit and its destination/cost/privacy implications are visible.
- The short runtime command remains `nexus`; only registry/formula identities use the unambiguous NexusHarness name.
- Normal package removal preserves data; explicit confirmed purge removes only Nexus-owned state.
- Final public URLs, supported platforms, version numbers, and release checksums must be substituted from actual release evidence rather than this blueprint's examples.

## Primary references

- [Existing `nexus` npm package](https://www.npmjs.com/package/nexus)
- [npm: creating and publishing scoped public packages](https://docs.npmjs.com/creating-and-publishing-scoped-public-packages/)
- [npm: `package.json` fields](https://docs.npmjs.com/cli/v11/configuring-npm/package-json/)
- [npm: trusted publishing with OIDC](https://docs.npmjs.com/trusted-publishers/)
- [Existing Homebrew `nexus` formula](https://formulae.brew.sh/formula/nexus)
- [Homebrew Formula Cookbook](https://docs.brew.sh/Formula-Cookbook)
- [Homebrew taps and duplicate-name resolution](https://docs.brew.sh/Taps)
- [Homebrew/core acceptable formulae](https://docs.brew.sh/Acceptable-Formulae)

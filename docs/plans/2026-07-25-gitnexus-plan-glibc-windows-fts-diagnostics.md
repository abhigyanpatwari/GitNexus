# GitNexus Engineering Plan

> Task: Correct the LadybugDB native-load diagnosis for hosts whose glibc is older than the prebuilt binary requires (#2672) and document/point at the Windows FTS runtime prerequisites, including the zero-install Git Bash path (#2669).
> Evidence verified at commit e34967eed58904fc707575a22c65da01bcdce8f7; GitNexus index 18 commits behind, refresh skipped: analyzer runner identity is stale (`node .gitnexus/run.cjs` resolves to published gitnexus 1.6.9, tagged 2026-07-04, while the working tree is at e34967ee and `gitnexus/dist/` was last built 2026-07-22) — graph findings are labelled and source-weighted, never load-bearing.
> Deepened once (2026-07-25): both graph-derived remedy-consumer claims upgraded to [verified], a fifth propagation surface found, two new hard constraints recorded, and the PDG layer coverage corrected.
> Evidence provenance schema 2; global dirty digest 0a9c85780067d9afcd0764f307b60891e3cee927ee11eaeb5ec7826d10fd82cd; cited-path manifest 17 sorted entries; exact generated plan path excluded.

## 1. Objective

Two user-facing diagnostic defects, one PR:

1. **#2672** — On a host with glibc 2.32, `@ladybugdb/core`'s prebuilt `lbugjs.node` cannot load because it requires `GLIBC_2.34`. GitNexus reports this as _"a truncated file, ABI mismatch, or wrong-platform binary"_ and instructs the user to re-run `install.js`, which re-downloads the identical binary and fails identically. Replace that advice, for this failure class only, with a truthful message: which glibc the binary needs, which glibc the host has, that reinstalling will not help, and what actually would.
2. **#2669** — The Windows FTS runtime prerequisites (MSVC redistributable **and** OpenSSL 3 on the DLL search path) are undocumented, and the runtime remedy omits the zero-install workaround the reporter verified: Git Bash's `C:\Program Files\Git\mingw64\bin` already ships `libssl-3-x64.dll` / `libcrypto-3-x64.dll`. Add the hint to the remedy text and document both prerequisites in the README.

Acceptance criteria:

- A `GLIBC_x.y' not found` load failure produces a message that names the required and host glibc versions, states reinstalling will not help, and does **not** prescribe `install.js` / pnpm / bun reinstall steps.
- Every other native-load failure class (missing file, zero-byte, truncated/SIGBUS, un-runnable probe) behaves exactly as it does today.
- The Windows error-126 remedy names the Git Bash / PATH workaround alongside the existing VC++ and OpenSSL guidance.
- `gitnexus/README.md` documents the Linux glibc floor and the Windows FTS prerequisites.
- No new i18n keys; unit tests cover both new behaviours; `tsc --noEmit`, eslint, prettier and the affected vitest suites pass.

## 2. Current Behaviour

`checkLbugNative` (`gitnexus/src/core/lbug/native-check.ts:16-113`) is the CLI startup gate [verified]:

1. Resolves the `@ladybugdb/core` package dir (16-36); missing package → "not installed" message.
2. Missing `lbugjs.node` (38-65) → the skipped-install-script message.
3. Otherwise loads the binary **in a throwaway child** (74-80) — `spawnSync(process.execPath, ['-e', 'require(process.argv[1])', binaryPath])` — because a truncated `.node` SIGBUSes the loader rather than throwing (#2441).
4. Line 88 `if (probe.error || probe.status === 0) return { ok: true, binaryPath }` — a probe that could not run is deliberately inconclusive, not a condemnation.
5. Everything else falls to the single failure message at 92-112, whose body is fixed [verified]:

```ts
'LadybugDB native binary (lbugjs.node) exists but failed to load:',
`  ${describeNativeLoadFailure(probe)}`,
'',
'This can happen with a truncated file, ABI mismatch, or wrong-platform binary.',
'',
'To repair:',
`  node ${path.join(pkgDir, 'install.js')}`,
```

`describeNativeLoadFailure` (120-134) reports a fatal signal as "likely truncated or corrupted", otherwise lifts the first `/^\w*Error: /` line out of the child's stderr [verified]. For #2672's host that line is `/lib64/libc.so.6: version \`GLIBC_2.34' not found (required by …/lbugjs.node)` [verified: issue #2672 body] — so the real cause is already displayed, and is then immediately contradicted by the three lines beneath it.

Consumers print `message` verbatim and exit 1: `lazy-action.ts:34` and `lazy-action.ts:75`, plus `doctor.ts:201` [verified]. The message text is the entire contract; no consumer parses it.

For #2669, `extension-load-error.ts` already classifies Windows error 126 correctly and refuses to prescribe a reinstall [verified]:

```ts
const windowsMissingDependencyRemedy = (label: string): string =>
  `The ${label} extension is present but a required runtime library is missing (Windows error 126). ` +
  'Reinstalling the extension will NOT help. Install ' + VC_REDIST_INSTALL_HINT +
  '; if the error persists, the extension also needs OpenSSL 3 ' +
  '(libcrypto-3-x64.dll / libssl-3-x64.dll) on the DLL search path.';
```

What it never says is *where those DLLs already exist on the machine*. The reporter proved the same command fails in PowerShell and succeeds in Git Bash purely because `C:\Program Files\Git\mingw64\bin` is on PATH there [verified: issue #2669 comment]. `gitnexus/README.md:351-354` lists only Node ≥ 22 and a git repository [verified].

## 3. Relevant Architecture

- **`native-check.ts` is dependency-light on purpose.** Its only imports are `fs`, `path`, `node:module`, `node:child_process` (1-4) [verified]. It is the gate that runs *before* the analyzer module graph is evaluated, and its own comments (67-73) explain the out-of-process design. Anything added here must stay in that budget.
- **`analyzer-identity.ts` already reads the host libc** — `detectLibcVariant` (354-378) pulls `process.report.getReport().header.glibcVersionRuntime` — but it is **not exported**, and its module is loaded through a deliberate dynamic `identityLoader` in `createAnalyzerLbugLazyAction` (`lazy-action.ts:57-59, 65-66`) [verified]. Importing it statically from `native-check.ts` would drag the analyzer identity module into every CLI startup and defeat that boundary, so the glibc read stays local (three lines of the same `process.report` access).
- **Diagnostic strings in this area are literal English by convention, not an i18n omission.** `doctor.ts:185-187` states it outright: _"Literal label (like the 'native' line below) to avoid adding i18n keys."_ `native-check.ts` and `extension-load-error.ts` contain no `label()`/`t()` calls [verified]. Both changes therefore add zero keys to `src/cli/i18n/en.ts` / `zh-CN.ts`.
- **`extension-load-error.ts` is a pure classifier** with a single shared `VC_REDIST_INSTALL_HINT` const (126-128) so the redist name/URL cannot drift between the Windows-126, hedged, and structural remedies (#2383 F5) [verified]. A new hint must follow the same single-const pattern.
- `FILE_CORRUPTION_SIGNATURES` (57-65) is byte-identical to a copy in `scripts/install-duckdb-extension.mjs` and is parity-tested [verified]. This change touches no signature array, so that guard is unaffected.

## 4. GitNexus Findings

All graph results below come from an index 18 commits behind HEAD and are **not load-bearing** — every claim they suggested was re-verified against source (§2, §3).

- `impact {target: "checkLbugNative", direction: "upstream", maxDepth: 3, includeTests: true}` → `impactedCount: 7`, `risk: "LOW"`, direct = 4 [graph]. d=1: `doctorCommand` (`src/cli/doctor.ts`), `createLbugLazyAction`, `createAnalyzerLbugLazyAction` (`src/cli/lazy-action.ts`), `test/unit/lbug-native-check.test.ts`. All four re-verified as message-only consumers [verified].
- The same result omits `test/unit/native-check-probe.test.ts`, which exists on disk — direct confirmation of index staleness (the probe suite arrived with #2441/#2651, one of the 18 unindexed commits) [verified].
- `impact {target: "diagnoseExtensionLoad", direction: "upstream", maxDepth: 3, includeTests: true}` → `impactedCount: 16`, `risk: "HIGH"`, direct = 5 [graph]: `doctorCommand`, `runFullAnalysis` (`src/core/run-analyze.ts`), `ExtensionManager.markUnavailable` (`src/core/lbug/extension-loader.ts`), `test/integration/extension-binary-real.test.ts`, `test/unit/extension-load-error.test.ts`. The HIGH rating reflects the classifier's fan-out, not this change: no signature, kind, or control flow is touched — only the text inside one remedy builder [inferred].
- Related tests located and read: `test/unit/lbug-native-check.test.ts` (97 lines), `test/unit/native-check-probe.test.ts` (121), `test/unit/extension-load-error.test.ts` (350), `test/unit/fts-degraded-warning.test.ts` (141), `test/integration/extension-binary-real.test.ts` [verified].
- `test/integration/extension-binary-real.test.ts` asserts only `kind` (`toMatchObject({ kind: 'missing_dependency' })`), never remedy text — appending to a remedy cannot break it [verified].

**Deepen pass — the two graph-derived remedy consumers, re-verified in source:**

- `runFullAnalysis` consumes the remedy at **two** sites, not one: `run-analyze.ts:791-800` (analyze degrade warning) and `run-analyze.ts:1938-1941` (`FTS_UNAVAILABLE_LEAD` tail). Both gate on `kind === 'missing_dependency'` and append `remedy` verbatim [verified, upgraded from [graph]].
- `ExtensionManager.markUnavailable` (`extension-loader.ts:326`) stores `diagnosis: diagnoseExtensionLoad(reason, label)` — the diagnosis, remedy included, is **cached at mark-unavailable time** so per-request surfaces do no file I/O (#2383 F3) [verified, upgraded from [graph]].
- **New finding — the hint propagates for free.** `ftsDegradedWarning` (`src/core/search/fts-indexes.ts:24-45`) does not compose its own Windows advice: it reads `fts.diagnosis ?? classifyExtensionLoadError(fts.reason)` and appends that remedy for `missing_dependency`. Its callers are the MCP `query` path and `createServer` (`/api/search`) [verified]. So a change made once in the remedy builder reaches **five** user-facing surfaces — `doctor` (×2), the analyze degrade warning (×2), and the per-request degraded warning — with no sibling call site left behind. Conversely, adding the hint at any call site instead of in the builder would miss the cached per-request path.

## 5. Statement-Level PDG Findings

`pdg_query {mode: "controls", target: "checkLbugNative"}` returned 12 CDG edges [graph]. Anchor `startLine: 15, endLine: 112` against a current `16-113` — a one-line offset consistent with the stale index; the quoted statement text matches current source exactly, so the control shape is unchanged [verified].

**Layer coverage (deepen pass):** the index carries the control-dependence layer but **not** the data-dependence one — `pdg_query {mode: "flows", target: "checkLbugNative", variable: "probe"}` returned `total: 0` with `note: "no PDG layer — run gitnexus analyze --pdg to record REACHING_DEF edges"` [graph]. Data-flow claims below are therefore source-derived, not PDG-derived, and the missing sub-layer was not repaired (a refresh is barred by the analyzer-provenance gate, §1 header).

Load-bearing edges:

| Controller | Dependent | Label | Guard |
| --- | --- | --- | --- |
| line 88 `(probe.error \|\| probe.status === 0)` | line 89 `return { ok: true, binaryPath }` | T | yes |
| line 88 | line 92 failure-message `return` | F | yes |
| line 39 `(!fs.existsSync(binaryPath))` | line 40 missing-binary `return` | T | yes |
| line 39 | line 74 `spawnSync(...)` probe | F | — |
| line 19 / line 23 | pkgDir resolution and the not-installed `return` | T/F | — |

Planning implications:

- Line 88 is the **sole** controller of both terminal returns. The glibc branch must live on its **F** arm, inside the failure path — placing it earlier would let a probe that never ran (`probe.error`) reach a glibc verdict it has no evidence for, inverting #2441's deliberate fail-open [inferred from the T-arm guard].
- `probe.stderr` is the only data source for both `describeNativeLoadFailure` and the new branch, so both must read the same captured string; no second spawn, no re-read [verified: `stdio: ['ignore','ignore','pipe']`, 77].
- Nothing between 74 and 92 mutates state, so a new early-return in that window has no ordering constraint beyond preceding the generic message [verified].

## 6. Proposed Changes

### 6.1 `gitnexus/src/core/lbug/native-check.ts` — glibc-too-old branch

- **Symbols:** new module-level `GLIBC_NOT_FOUND` regex; new exported pure helper `glibcTooOldMessage(stderr: string): string | null`; new local `hostGlibcVersion(): string | null`; one new early return inside `checkLbugNative`.
- **Responsibility:** turn the one native-load failure class that reinstalling cannot fix into an honest message.
- **Behavioural change:** when the child probe's stderr matches ``/version `GLIBC_([\d.]+)' not found/``, `checkLbugNative` returns `{ ok: false, binaryPath, message }` where the message states the required glibc, the host glibc when `process.report` exposes it, that reinstalling will **not** help, and the real options (a distro with glibc ≥ required — Ubuntu 22.04+, RHEL 9+, Debian 12+ — or the container image). All other paths are byte-identical to today.
- **Implementation notes:**
  - Collect **all** regex matches and report the highest version. `ld.so` names only the first unresolved symbol, but a message that under-reports the floor sends users to a distro that still fails; compare numerically by dotted segment, not lexically (`2.9` vs `2.34`).
  - Keep the pattern tolerant of quoting: anchor on `GLIBC_<digits.digits>` together with `not found`, rather than requiring glibc's exact `` `GLIBC_2.34' `` backtick/apostrophe pair. The wording is an unverifiable assumption (§12); a tolerant pattern degrades to today's message instead of misfiring if the loader ever re-quotes it.
  - `hostGlibcVersion` reads `process.report?.getReport()?.header?.glibcVersionRuntime` inside a `try`, returning `null` on any failure — Node builds without report support must degrade to "unknown", never throw inside a diagnostic path (same defensive posture as `analyzer-identity.ts:372-376`).
  - Keep the existing `describeNativeLoadFailure(probe)` line at the top of the new message so the user still sees the raw loader error.
  - Export `glibcTooOldMessage` for direct unit testing: a real `GLIBC_2.34` failure cannot be fabricated on a modern CI host, and the pure-classifier-plus-unit-test shape is exactly the pattern `extension-load-error.ts` already establishes for this subsystem.
- **Constraints:** no new imports beyond Node builtins; branch strictly on the line-88 F arm; do not alter `describeNativeLoadFailure`'s contract.

### 6.2 `gitnexus/src/core/lbug/extension-load-error.ts` — Git Bash / OpenSSL PATH hint

- **Symbols:** new `GIT_BASH_OPENSSL_HINT` const beside `VC_REDIST_INSTALL_HINT`; appended to `windowsMissingDependencyRemedy` and `structuralMissingDependencyRemedy`.
- **Behavioural change:** both remedies additionally state that Git for Windows ships `libssl-3-x64.dll` / `libcrypto-3-x64.dll` in `C:\Program Files\Git\mingw64\bin`, so running the command from Git Bash — or prepending that directory to `PATH` — resolves the load without installing anything.
- **Constraints:**
  - Single shared const (the #2383 F5 anti-drift pattern).
  - **The hint must live in the remedy builder, never at a call site.** `ExtensionManager.markUnavailable` caches the whole diagnosis (`extension-loader.ts:326`, #2383 F3) and `ftsDegradedWarning` replays that cached remedy — a call-site addition would silently miss the MCP `query` and `/api/search` surfaces [verified].
  - **The hint must not contain a `C:\Users\…` path.** `test/unit/fts-degraded-warning.test.ts:56` and `:78` assert the emitted warning never matches `/C:\\Users\\/`, and `redactPaths` is applied to the *reason* only — remedy text passes through unredacted [verified]. `C:\Program Files\Git\mingw64\bin` is a fixed system path and satisfies this; a `%USERPROFILE%`-style example would not.
  - Existing assertions in `test/unit/extension-load-error.test.ts:147-157` (`/Visual C\+\+/`, `/vc_redist\.x64\.exe/`, `/OpenSSL 3/`, `/will NOT help/`, and the negative `/Retry with network access/i`) must all still hold — appending satisfies every one [verified].
- `hedgedLoadFailureRemedy` is intentionally left alone (see §12).

### 6.3 `gitnexus/README.md` — Requirements

Extend the Requirements list (351-354) with the Linux prebuilt's glibc floor: `@ladybugdb/core`'s Linux x64 prebuilt requires **glibc ≥ 2.34** (Ubuntu 22.04+, RHEL 9+, Debian 12+); older hosts cannot load it and reinstalling does not help.

### 6.4 `gitnexus/README.md` — Windows FTS prerequisites

Add a Troubleshooting subsection (the section begins at 379): full-text search needs the Microsoft Visual C++ 2015-2022 x64 Redistributable **and** OpenSSL 3 (`libssl-3-x64.dll`, `libcrypto-3-x64.dll`) resolvable on `PATH`; without them `analyze` still completes but the search index is skipped with a warning; the zero-install fix is to run from Git Bash or prepend `C:\Program Files\Git\mingw64\bin`.

### 6.5 Tests

Per §8 — extend `test/unit/lbug-native-check.test.ts` and `test/unit/extension-load-error.test.ts`; no new test files.

## 7. Implementation Sequence

1. **glibc branch** — add the regex, `hostGlibcVersion`, `glibcTooOldMessage`, and the F-arm early return in `native-check.ts` (§6.1). Tree stays coherent: every existing path is untouched.
2. **glibc tests** — add the `glibcTooOldMessage` describe block to `test/unit/lbug-native-check.test.ts` (§8.1). Run that suite.
3. **Windows hint** — add `GIT_BASH_OPENSSL_HINT` and append it in the two remedies (§6.2); extend the existing Windows-126 remedy test (§8.2). Run that suite.
4. **README** — apply §6.3 and §6.4.
5. **Full verification** — `npx tsc --noEmit` (in `gitnexus/`), `npx vitest run test/unit/lbug-native-check.test.ts test/unit/extension-load-error.test.ts`, then `npx eslint .` and `npx prettier --check .` at the repo root. No goldens, fingerprints, or recorded baselines are affected by any step, so nothing needs regenerating.

Each step is independently landable; steps 1-2 and 3 are order-independent with respect to each other.

## 8. Test Strategy

### 8.1 `gitnexus/test/unit/lbug-native-check.test.ts` (extend)

New `describe('glibcTooOldMessage (#2672)')`, table-driven with `it.each` where the cases are homogeneous, matching the file's existing style (no conditional logic inside tests):

| Input (child stderr) | Expected |
| --- | --- |
| The reporter's line: ``Error: /lib64/libc.so.6: version `GLIBC_2.34' not found (required by …/lbugjs.node)`` | non-null; matches `/GLIBC_2\.34\|glibc 2\.34/`; matches `/will NOT help/`; does **not** match `/install\.js/`; does **not** match `/trustedDependencies/` |
| stderr naming both `GLIBC_2.29` and `GLIBC_2.34` | reports `2.34`, not `2.29` (numeric, not lexical, ordering) |
| stderr naming `GLIBC_2.9` and `GLIBC_2.34` | reports `2.34` (guards against string comparison) |
| `invalid ELF header` | `null` |
| `''` | `null` |

Plus a non-table case asserting the message mentions the host glibc when `process.report` is available (assert `/glibc/i` and that the reporter's required version appears — never pin the host's own version, which differs per runner).

Regression coverage already present and must keep passing unchanged: missing binary (15-36), zero-byte (38-51), truncated/SIGBUS (53-74), and un-runnable probe → `ok: true` (76-96) [verified].

### 8.2 `gitnexus/test/unit/extension-load-error.test.ts` (extend)

Extend the existing test at 147-157 (`'Windows missing-dependency remedy leads with MSVC redist…'`) with `expect(remedy).toMatch(/Git Bash|mingw64/)`, and add the same assertion to a structural-remedy case (the test at 309-324 already exercises `structuralMissingDependencyRemedy`). All existing assertions in both remain.

### 8.3 Edge cases and boundaries

- **musl hosts** produce a different loader message and correctly fall through to the generic message — asserted implicitly by the `null` cases.
- **Un-runnable probe** must still return `ok: true`; the new branch sits after that gate (§5).
- **No i18n impact** — no `label()`/`t()` keys added, so `en.ts`/`zh-CN.ts` stay in sync by construction (§3).
- **Path-redaction property must survive.** `test/unit/fts-degraded-warning.test.ts:56, 78` assert the degraded warning never emits `C:\Users\…`; the appended hint reaches that surface through the cached diagnosis, so run that suite too (§8.4) even though the file is not edited.
- **Cross-platform matrix:** `scripts/cross-platform-tests.ts` `PLATFORM_LOGIC` already lists `test/integration/extension-binary-real.test.ts`; both edited suites are pure string/logic tests with no platform-conditional behaviour, so no matrix entry is required [verified].

### 8.4 Verification commands (all confirmed to exist and be runnable)

- `cd gitnexus && npx tsc --noEmit` — matches `.github/workflows/ci-quality.yml:48-49` (`working-directory: gitnexus`) [verified].
- `cd gitnexus && npx vitest run test/unit/lbug-native-check.test.ts test/unit/extension-load-error.test.ts test/unit/fts-degraded-warning.test.ts` — `gitnexus/package.json` defines `test: vitest run`, `test:unit: vitest run test/unit` [verified]. The third suite is unedited but consumes the changed remedy through the cached diagnosis.
- `npx eslint .` at the repo root — matches `ci-quality.yml:38`; root `package.json` also exposes `lint` / `format:check` [verified].

## 9. Risk and Impact Analysis

Overall risk: **LOW**. Both changes are additive text/branch changes with no signature, schema, or control-flow modification outside one new early return.

Direct (d=1) dependents, each accounted for:

| Dependent | Relationship | Effect of this change |
| --- | --- | --- |
| `doctorCommand` (`src/cli/doctor.ts:196-202`) | calls `checkLbugNative`, prints `message` to stderr | Prints the new text on glibc hosts; unchanged elsewhere. No parsing, no format assumption [verified]. |
| `createLbugLazyAction` (`src/cli/lazy-action.ts:31-45`) | calls `checkLbugNative`, prints + `exitCode = 1` | Same message-only contract; exit code path untouched [verified]. |
| `createAnalyzerLbugLazyAction` (`src/cli/lazy-action.ts:64-85`) | calls `checkLbugNative` inside the identity capture | Unchanged: still returns `ok: false`, still exits 1 (#2441's fail-closed behaviour preserved) [verified]. |
| `test/unit/lbug-native-check.test.ts` | exercises `checkLbugNative` | Extended, not rewritten; existing cases must pass untouched [verified]. |
| `doctorCommand` (`doctor.ts:222`, `240`) | consumes `diagnoseExtensionLoad(...).remedy` | Prints one longer line; `kind` unchanged [verified]. |
| `runFullAnalysis` (`run-analyze.ts:791-800`, `1938-1941`) | consumes the remedy at two sites, both gated on `kind === 'missing_dependency'` | Longer warning text only; `kind` unchanged [verified]. |
| `ExtensionManager.markUnavailable` (`extension-loader.ts:326`) | caches the whole diagnosis at mark-unavailable time (#2383 F3) | Caches the longer remedy; no I/O or lifecycle change [verified]. |
| `ftsDegradedWarning` (`fts-indexes.ts:24-45`) → MCP `query`, `createServer` | replays the cached remedy on `/api/search` and MCP query | Inherits the hint automatically — the reason this change belongs in the builder [verified]. |
| `test/unit/fts-degraded-warning.test.ts:56, 78` | asserts the warning never emits `C:\Users\…` | Holds: the hint is a fixed `C:\Program Files\…` path, and remedy text is not redacted [verified]. |
| `test/integration/extension-binary-real.test.ts` | asserts `kind` only | Unaffected [verified]. |
| `test/unit/extension-load-error.test.ts` | asserts remedy substrings | Extended; all existing assertions remain true under appending [verified]. |

- **Compatibility:** the message is a human-facing diagnostic; no machine consumer parses it [verified across all five call sites].
- **Performance:** one regex over an already-captured stderr string on a path that is already failing; `process.report.getReport()` runs at most once per failure, never on the success path.
- **Concurrency / migration / observability:** none — no shared state, no persisted artifact, no schema.
- **Residual risk:** if `ld.so` ever changes its `version \`GLIBC_x.y' not found` wording, the branch silently falls back to today's message — a strict regression-free degradation (§12).

## 10. Files Expected to Change

| File | Symbols | Reason |
| ---- | ------- | ------ |
| `gitnexus/src/core/lbug/native-check.ts` | `GLIBC_NOT_FOUND`, `hostGlibcVersion`, `glibcTooOldMessage`, `checkLbugNative` | #2672: honest glibc-too-old diagnosis on the line-88 F arm |
| `gitnexus/src/core/lbug/extension-load-error.ts` | `GIT_BASH_OPENSSL_HINT`, `windowsMissingDependencyRemedy`, `structuralMissingDependencyRemedy` | #2669: name the zero-install Git Bash / PATH fix |
| `gitnexus/README.md` | Requirements, Troubleshooting | #2672 glibc floor; #2669 Windows FTS prerequisites |
| `gitnexus/test/unit/lbug-native-check.test.ts` | new `glibcTooOldMessage` describe | Cover the new branch and its ordering edge cases |
| `gitnexus/test/unit/extension-load-error.test.ts` | Windows-126 and structural remedy cases | Assert the new hint without weakening existing assertions |

## 11. Reusable Implementation Context

```yaml
implementation_context:
  task_summary: >-
    Replace the misleading "truncated / ABI mismatch / wrong-platform" advice for
    glibc-too-old native load failures with an accurate message (#2672), add the
    verified Git Bash / PATH workaround to the Windows error-126 extension remedy
    (#2669), and document the Linux glibc floor plus the Windows FTS prerequisites
    in gitnexus/README.md.
  acceptance_criteria:
    - "A `GLIBC_x.y' not found` probe failure yields a message naming the required and host glibc, stating reinstalling will NOT help, and omitting install.js/pnpm/bun reinstall steps."
    - 'Missing-file, zero-byte, truncated/SIGBUS and un-runnable-probe paths are byte-identical to today.'
    - 'windowsMissingDependencyRemedy and structuralMissingDependencyRemedy name the Git Bash / mingw64 PATH workaround.'
    - 'gitnexus/README.md documents glibc >= 2.34 for the Linux prebuilt and the Windows VC++ + OpenSSL 3 FTS prerequisites.'
    - 'No new i18n keys; tsc --noEmit, eslint, prettier --check and both touched vitest suites pass.'

  evidence_provenance:
    schema_version: 2
    head_commit: 'e34967eed58904fc707575a22c65da01bcdce8f7'
    generated_plan_path: 'docs/plans/2026-07-25-gitnexus-plan-glibc-windows-fts-diagnostics.md'
    global_dirty_digest:
      algorithm: 'sha256'
      canonicalization: 'gitnexus-evidence-provenance-v2 NUL-framed UTF-8 records'
      value: '0a9c85780067d9afcd0764f307b60891e3cee927ee11eaeb5ec7826d10fd82cd'
    cited_path_manifest:
      - path: '.github/workflows/ci-quality.yml'
        object_kind:
          head: 'regular'
          index: 'regular'
          worktree: 'regular'
          untracked: 'absent'
        state: 'clean'
        rename_from: null
        rename_to: null
        head_digest: 'sha256:e58cfeeb65d1206767cbec29e6240c15d3b997459622ce971529d49150e2da61'
        index_digest: 'sha256:e58cfeeb65d1206767cbec29e6240c15d3b997459622ce971529d49150e2da61'
        worktree_digest: 'sha256:e58cfeeb65d1206767cbec29e6240c15d3b997459622ce971529d49150e2da61'
        untracked_digest: 'absent'
      - path: 'gitnexus/README.md'
        object_kind:
          head: 'regular'
          index: 'regular'
          worktree: 'regular'
          untracked: 'absent'
        state: 'clean'
        rename_from: null
        rename_to: null
        head_digest: 'sha256:c5fe61178d96f70ba0c4e5662b1cada7a3453e21d7e5e3280c726c85dd1362e1'
        index_digest: 'sha256:c5fe61178d96f70ba0c4e5662b1cada7a3453e21d7e5e3280c726c85dd1362e1'
        worktree_digest: 'sha256:c5fe61178d96f70ba0c4e5662b1cada7a3453e21d7e5e3280c726c85dd1362e1'
        untracked_digest: 'absent'
      - path: 'gitnexus/package.json'
        object_kind:
          head: 'regular'
          index: 'regular'
          worktree: 'regular'
          untracked: 'absent'
        state: 'clean'
        rename_from: null
        rename_to: null
        head_digest: 'sha256:042dbb0ab76844382c5c5f175a20d172014801eed5f4001a821f2150a45eb1b7'
        index_digest: 'sha256:042dbb0ab76844382c5c5f175a20d172014801eed5f4001a821f2150a45eb1b7'
        worktree_digest: 'sha256:042dbb0ab76844382c5c5f175a20d172014801eed5f4001a821f2150a45eb1b7'
        untracked_digest: 'absent'
      - path: 'gitnexus/scripts/cross-platform-tests.ts'
        object_kind:
          head: 'regular'
          index: 'regular'
          worktree: 'regular'
          untracked: 'absent'
        state: 'clean'
        rename_from: null
        rename_to: null
        head_digest: 'sha256:8583c126a70362c4891d9409ba7986ab50cf3171a66c4ef0998412774f06f650'
        index_digest: 'sha256:8583c126a70362c4891d9409ba7986ab50cf3171a66c4ef0998412774f06f650'
        worktree_digest: 'sha256:8583c126a70362c4891d9409ba7986ab50cf3171a66c4ef0998412774f06f650'
        untracked_digest: 'absent'
      - path: 'gitnexus/src/cli/doctor.ts'
        object_kind:
          head: 'regular'
          index: 'regular'
          worktree: 'regular'
          untracked: 'absent'
        state: 'clean'
        rename_from: null
        rename_to: null
        head_digest: 'sha256:cb347b0605b8aa75cc635661962b16dae35b46fb3ce201dda5a4c543afd2b666'
        index_digest: 'sha256:cb347b0605b8aa75cc635661962b16dae35b46fb3ce201dda5a4c543afd2b666'
        worktree_digest: 'sha256:cb347b0605b8aa75cc635661962b16dae35b46fb3ce201dda5a4c543afd2b666'
        untracked_digest: 'absent'
      - path: 'gitnexus/src/cli/lazy-action.ts'
        object_kind:
          head: 'regular'
          index: 'regular'
          worktree: 'regular'
          untracked: 'absent'
        state: 'clean'
        rename_from: null
        rename_to: null
        head_digest: 'sha256:f7a510e9697e6a69738434e2c95c551c37472378d7e43e65486d4d672ee1d73a'
        index_digest: 'sha256:f7a510e9697e6a69738434e2c95c551c37472378d7e43e65486d4d672ee1d73a'
        worktree_digest: 'sha256:f7a510e9697e6a69738434e2c95c551c37472378d7e43e65486d4d672ee1d73a'
        untracked_digest: 'absent'
      - path: 'gitnexus/src/core/analyzer-identity.ts'
        object_kind:
          head: 'regular'
          index: 'regular'
          worktree: 'regular'
          untracked: 'absent'
        state: 'clean'
        rename_from: null
        rename_to: null
        head_digest: 'sha256:ff479bbe679697a1b8626bcb72d53a2c513cc7a33c631b70bfa29875ab8d726b'
        index_digest: 'sha256:ff479bbe679697a1b8626bcb72d53a2c513cc7a33c631b70bfa29875ab8d726b'
        worktree_digest: 'sha256:ff479bbe679697a1b8626bcb72d53a2c513cc7a33c631b70bfa29875ab8d726b'
        untracked_digest: 'absent'
      - path: 'gitnexus/src/core/lbug/extension-load-error.ts'
        object_kind:
          head: 'regular'
          index: 'regular'
          worktree: 'regular'
          untracked: 'absent'
        state: 'clean'
        rename_from: null
        rename_to: null
        head_digest: 'sha256:1ea543f8637922bedb91e968c93d5d10c8f045afe28de770faca5d94a5b0e365'
        index_digest: 'sha256:1ea543f8637922bedb91e968c93d5d10c8f045afe28de770faca5d94a5b0e365'
        worktree_digest: 'sha256:1ea543f8637922bedb91e968c93d5d10c8f045afe28de770faca5d94a5b0e365'
        untracked_digest: 'absent'
      - path: 'gitnexus/src/core/lbug/extension-loader.ts'
        object_kind:
          head: 'regular'
          index: 'regular'
          worktree: 'regular'
          untracked: 'absent'
        state: 'clean'
        rename_from: null
        rename_to: null
        head_digest: 'sha256:9f798d98a668a6130cb2557518afb8b792eb53c930bc65220f168a9b38c45d9a'
        index_digest: 'sha256:9f798d98a668a6130cb2557518afb8b792eb53c930bc65220f168a9b38c45d9a'
        worktree_digest: 'sha256:9f798d98a668a6130cb2557518afb8b792eb53c930bc65220f168a9b38c45d9a'
        untracked_digest: 'absent'
      - path: 'gitnexus/src/core/lbug/native-check.ts'
        object_kind:
          head: 'regular'
          index: 'regular'
          worktree: 'regular'
          untracked: 'absent'
        state: 'clean'
        rename_from: null
        rename_to: null
        head_digest: 'sha256:dc106d559328bbf45b97aa72b106c233d8485e2dd0ed605d58082859897a8715'
        index_digest: 'sha256:dc106d559328bbf45b97aa72b106c233d8485e2dd0ed605d58082859897a8715'
        worktree_digest: 'sha256:dc106d559328bbf45b97aa72b106c233d8485e2dd0ed605d58082859897a8715'
        untracked_digest: 'absent'
      - path: 'gitnexus/src/core/run-analyze.ts'
        object_kind:
          head: 'regular'
          index: 'regular'
          worktree: 'regular'
          untracked: 'absent'
        state: 'clean'
        rename_from: null
        rename_to: null
        head_digest: 'sha256:196c7da555fc7ac17480cd54844568d3166931e5c1a790da61a21c07a386bb78'
        index_digest: 'sha256:196c7da555fc7ac17480cd54844568d3166931e5c1a790da61a21c07a386bb78'
        worktree_digest: 'sha256:196c7da555fc7ac17480cd54844568d3166931e5c1a790da61a21c07a386bb78'
        untracked_digest: 'absent'
      - path: 'gitnexus/src/core/search/fts-indexes.ts'
        object_kind:
          head: 'regular'
          index: 'regular'
          worktree: 'regular'
          untracked: 'absent'
        state: 'clean'
        rename_from: null
        rename_to: null
        head_digest: 'sha256:237f4036160cbb1e06123b61b950754dcf22de8acb686cd9203ccd503f598dbc'
        index_digest: 'sha256:237f4036160cbb1e06123b61b950754dcf22de8acb686cd9203ccd503f598dbc'
        worktree_digest: 'sha256:237f4036160cbb1e06123b61b950754dcf22de8acb686cd9203ccd503f598dbc'
        untracked_digest: 'absent'
      - path: 'gitnexus/test/integration/extension-binary-real.test.ts'
        object_kind:
          head: 'regular'
          index: 'regular'
          worktree: 'regular'
          untracked: 'absent'
        state: 'clean'
        rename_from: null
        rename_to: null
        head_digest: 'sha256:4aaf26b5a310192b62bf7a4f6ac714b2a2f48c87518f058ae4acfb338b66afd4'
        index_digest: 'sha256:4aaf26b5a310192b62bf7a4f6ac714b2a2f48c87518f058ae4acfb338b66afd4'
        worktree_digest: 'sha256:4aaf26b5a310192b62bf7a4f6ac714b2a2f48c87518f058ae4acfb338b66afd4'
        untracked_digest: 'absent'
      - path: 'gitnexus/test/unit/extension-load-error.test.ts'
        object_kind:
          head: 'regular'
          index: 'regular'
          worktree: 'regular'
          untracked: 'absent'
        state: 'clean'
        rename_from: null
        rename_to: null
        head_digest: 'sha256:dc89a26c1124b78ed4a317f733982ae5b330cc842c14a1405c9bcd45cccb4d20'
        index_digest: 'sha256:dc89a26c1124b78ed4a317f733982ae5b330cc842c14a1405c9bcd45cccb4d20'
        worktree_digest: 'sha256:dc89a26c1124b78ed4a317f733982ae5b330cc842c14a1405c9bcd45cccb4d20'
        untracked_digest: 'absent'
      - path: 'gitnexus/test/unit/fts-degraded-warning.test.ts'
        object_kind:
          head: 'regular'
          index: 'regular'
          worktree: 'regular'
          untracked: 'absent'
        state: 'clean'
        rename_from: null
        rename_to: null
        head_digest: 'sha256:e6432b5346f3d22b8fbaa30373355321a2770c6fd119f4c9cea8149bdbdbf636'
        index_digest: 'sha256:e6432b5346f3d22b8fbaa30373355321a2770c6fd119f4c9cea8149bdbdbf636'
        worktree_digest: 'sha256:e6432b5346f3d22b8fbaa30373355321a2770c6fd119f4c9cea8149bdbdbf636'
        untracked_digest: 'absent'
      - path: 'gitnexus/test/unit/lbug-native-check.test.ts'
        object_kind:
          head: 'regular'
          index: 'regular'
          worktree: 'regular'
          untracked: 'absent'
        state: 'clean'
        rename_from: null
        rename_to: null
        head_digest: 'sha256:60f337dfe10f0126cca0f36c475d765d7977f81280f37902171084faa45a9de1'
        index_digest: 'sha256:60f337dfe10f0126cca0f36c475d765d7977f81280f37902171084faa45a9de1'
        worktree_digest: 'sha256:60f337dfe10f0126cca0f36c475d765d7977f81280f37902171084faa45a9de1'
        untracked_digest: 'absent'
      - path: 'gitnexus/test/unit/native-check-probe.test.ts'
        object_kind:
          head: 'regular'
          index: 'regular'
          worktree: 'regular'
          untracked: 'absent'
        state: 'clean'
        rename_from: null
        rename_to: null
        head_digest: 'sha256:acc502766be31f711376938a48850b9dbb5ba7864388358beeb86983473823c9'
        index_digest: 'sha256:acc502766be31f711376938a48850b9dbb5ba7864388358beeb86983473823c9'
        worktree_digest: 'sha256:acc502766be31f711376938a48850b9dbb5ba7864388358beeb86983473823c9'
        untracked_digest: 'absent'

  primary_symbols:
    - symbol: checkLbugNative
      file: gitnexus/src/core/lbug/native-check.ts
      lines: '16-113'
      role: 'CLI startup gate; owns the failure message that #2672 gets wrong'
    - symbol: describeNativeLoadFailure
      file: gitnexus/src/core/lbug/native-check.ts
      lines: '120-134'
      role: 'Lifts the loader error line out of the child probe stderr; stays unchanged'
    - symbol: windowsMissingDependencyRemedy
      file: gitnexus/src/core/lbug/extension-load-error.ts
      lines: '131-136'
      role: 'Windows error-126 remedy; gains the Git Bash / PATH hint'
    - symbol: structuralMissingDependencyRemedy
      file: gitnexus/src/core/lbug/extension-load-error.ts
      lines: '204-208'
      role: 'Structural missing-dependency remedy; gains the same shared hint'
    - symbol: detectLibcVariant
      file: gitnexus/src/core/analyzer-identity.ts
      lines: '354-378'
      role: 'Prior art for the process.report glibc read; NOT exported, deliberately not imported here'

  related_symbols:
    - symbol: createLbugLazyAction
      relationship: CALLS checkLbugNative
      relevance: 'Prints message to stderr and sets exitCode 1 (lazy-action.ts:31-45)'
    - symbol: createAnalyzerLbugLazyAction
      relationship: CALLS checkLbugNative
      relevance: 'Same contract inside the analyzer identity capture (lazy-action.ts:64-85)'
    - symbol: doctorCommand
      relationship: CALLS checkLbugNative and diagnoseExtensionLoad
      relevance: 'Prints both message and remedy (doctor.ts:196-202, 222, 240)'
    - symbol: VC_REDIST_INSTALL_HINT
      relationship: 'shared const in extension-load-error.ts:126-128'
      relevance: 'Anti-drift pattern (#2383 F5) the new GIT_BASH_OPENSSL_HINT must follow'
    - symbol: ExtensionManager.markUnavailable
      relationship: CALLS diagnoseExtensionLoad
      relevance: 'Remedy consumer; text-only impact'
    - symbol: runFullAnalysis
      relationship: CALLS diagnoseExtensionLoad
      relevance: 'Remedy consumer at run-analyze.ts:791-800 and 1938-1941; text-only impact'
    - symbol: ftsDegradedWarning
      relationship: 'reads the cached diagnosis remedy (fts-indexes.ts:24-45)'
      relevance: 'Per-request surface (MCP query + /api/search) that inherits the hint automatically; NOT edited'

  execution_path:
    - 'checkLbugNative resolves the @ladybugdb/core package dir (native-check.ts:16-36)'
    - 'Missing lbugjs.node returns the skipped-install-script message (38-65)'
    - 'Present binary is loaded in a throwaway child probe (74-80)'
    - 'Line 88: probe.error or status 0 returns ok:true (inconclusive stays fail-open)'
    - 'F arm: NEW glibc branch runs first, then the existing generic failure message (92-112)'
    - 'Callers print message verbatim and exit 1 (lazy-action.ts:34, 75; doctor.ts:201)'

  pdg_constraints:
    - description: 'Line 88 is the sole controller of both terminal returns (T -> ok:true, F -> failure message, both guard edges)'
      affected_statements:
        - 'gitnexus/src/core/lbug/native-check.ts:88'
        - 'gitnexus/src/core/lbug/native-check.ts:89'
        - 'gitnexus/src/core/lbug/native-check.ts:92'
      implementation_consequence: 'The glibc branch must live on the F arm; placing it earlier would let a probe that never ran produce a glibc verdict, inverting #2441 fail-open'
    - description: 'probe.stderr is the only captured output (stdio pipes stderr only, line 77)'
      affected_statements:
        - 'gitnexus/src/core/lbug/native-check.ts:74'
        - 'gitnexus/src/core/lbug/native-check.ts:124'
      implementation_consequence: 'Both describeNativeLoadFailure and the new branch read the same captured string; no second spawn'
    - description: 'Data-dependence layer absent: pdg_query flows returns "no PDG layer" (REACHING_DEF unrecorded) while CDG is present'
      affected_statements: []
      implementation_consequence: 'Data-flow claims in this plan are source-derived, not PDG-derived; do not expect impact mode:pdg statement slices to resolve here'

  architectural_patterns:
    - pattern: 'Pure classifier module + direct unit tests'
      example_location: 'gitnexus/src/core/lbug/extension-load-error.ts (classifyExtensionLoadError) with test/unit/extension-load-error.test.ts'
      usage_guidance: 'Export glibcTooOldMessage as a pure function so the branch is testable without fabricating a real GLIBC failure'
    - pattern: 'Single shared const for repeated remedy text'
      example_location: 'gitnexus/src/core/lbug/extension-load-error.ts:126-128 (VC_REDIST_INSTALL_HINT)'
      usage_guidance: 'Define GIT_BASH_OPENSSL_HINT once and reference it from both remedies'
    - pattern: 'Diagnosis cached once, replayed by per-request surfaces'
      example_location: 'gitnexus/src/core/lbug/extension-loader.ts:326 -> gitnexus/src/core/search/fts-indexes.ts:24-45'
      usage_guidance: 'Change remedy text in the builder only; a call-site addition would miss the cached MCP query and /api/search surfaces'
    - pattern: 'Remedy text is not path-redacted'
      example_location: 'gitnexus/src/core/search/fts-indexes.ts:27 (redactPaths applies to reason only); asserted by test/unit/fts-degraded-warning.test.ts:56,78'
      usage_guidance: 'Never put a C:\Users\ or home-directory path in remedy text'
    - pattern: 'Literal English diagnostics, no i18n keys'
      example_location: 'gitnexus/src/cli/doctor.ts:185-187'
      usage_guidance: 'Do not add en.ts / zh-CN.ts entries for these strings'
    - pattern: 'Dependency-light startup gate'
      example_location: 'gitnexus/src/core/lbug/native-check.ts:1-4'
      usage_guidance: 'Read process.report locally; do not import analyzer-identity.ts'
    - pattern: 'Table-driven vitest with it.each and toMatchObject, no branching in tests'
      example_location: 'gitnexus/test/unit/extension-load-error.test.ts:76-140'
      usage_guidance: 'Model the new glibc cases the same way'

  files_to_modify:
    - file: gitnexus/src/core/lbug/native-check.ts
      symbols: [GLIBC_NOT_FOUND, hostGlibcVersion, glibcTooOldMessage, checkLbugNative]
      intended_change: "Add a glibc-too-old branch on the line-88 F arm that reports required vs host glibc, states reinstalling will NOT help, and omits install.js/pnpm/bun advice; report the highest GLIBC_x.y found, compared numerically"
    - file: gitnexus/src/core/lbug/extension-load-error.ts
      symbols: [GIT_BASH_OPENSSL_HINT, windowsMissingDependencyRemedy, structuralMissingDependencyRemedy]
      intended_change: 'Append a shared hint naming C:\Program Files\Git\mingw64\bin (libssl-3-x64.dll / libcrypto-3-x64.dll) and the Git Bash / PATH-prepend workaround'
    - file: gitnexus/README.md
      symbols: [Requirements, Troubleshooting]
      intended_change: 'Document glibc >= 2.34 for the Linux x64 prebuilt, and a Windows FTS prerequisites note (VC++ x64 redist + OpenSSL 3 on PATH, Git Bash workaround, index built without search tables otherwise)'
    - file: gitnexus/test/unit/lbug-native-check.test.ts
      symbols: [glibcTooOldMessage describe]
      intended_change: 'Cover the reporter stderr, multi-version ordering (2.29/2.34 and 2.9/2.34), non-glibc null cases, and the host-glibc mention'
    - file: gitnexus/test/unit/extension-load-error.test.ts
      symbols: ['Windows missing-dependency remedy test', 'structural remedy test']
      intended_change: 'Assert /Git Bash|mingw64/ in both remedies while keeping every existing assertion'

  tests:
    - file: gitnexus/test/unit/lbug-native-check.test.ts
      scenarios:
        - "reporter stderr (/lib64/libc.so.6: version `GLIBC_2.34' not found) -> non-null message naming 2.34, containing 'will NOT help', and containing neither 'install.js' nor 'trustedDependencies'"
        - 'stderr naming GLIBC_2.29 and GLIBC_2.34 -> message reports 2.34'
        - 'stderr naming GLIBC_2.9 and GLIBC_2.34 -> message reports 2.34 (numeric, not lexical, comparison)'
        - "stderr 'invalid ELF header' -> null (falls through to the existing generic message)"
        - 'empty stderr -> null'
        - 'message mentions the host glibc when process.report exposes glibcVersionRuntime (assert /glibc/i, never pin the runner version)'
        - 'unchanged: missing binary, zero-byte, truncated/SIGBUS still say install.js; un-runnable probe still returns ok:true'
    - file: gitnexus/test/unit/extension-load-error.test.ts
      scenarios:
        - 'Windows error-126 remedy still matches Visual C++, vc_redist.x64.exe, OpenSSL 3 and "will NOT help", and now also matches /Git Bash|mingw64/'
        - 'structural missing-dependency remedy still carries vc_redist.x64.exe and now also matches /Git Bash|mingw64/'

  verification_commands:
    - 'cd gitnexus && npx tsc --noEmit'
    - 'cd gitnexus && npx vitest run test/unit/lbug-native-check.test.ts test/unit/extension-load-error.test.ts test/unit/fts-degraded-warning.test.ts'
    - 'cd gitnexus && npm run test:unit'
    - 'npx eslint .'
    - 'npx prettier --check .'

  risks:
    - 'ld.so wording change would silently disable the branch (degrades to today message, no regression)'
    - 'Index is 18 commits behind and the analyzer runner is the published 1.6.9; all remedy-consumer claims were re-verified in source during the deepen pass, but any NEW consumer added since 0eeecb37 would be invisible to the graph'
    - 'Appending to remedy strings lengthens doctor, analyze-warning and /api/search output lines; no consumer parses them'
    - 'A user-profile path in the new hint would break the path-redaction assertions in test/unit/fts-degraded-warning.test.ts:56,78'

  assumptions:
    - "glibc's loader wording `version \\`GLIBC_x.y' not found` is stable across distros — check by grepping the reporter output in issue #2672 before relying on the regex"
    - 'process.report.getReport().header.glibcVersionRuntime is present on supported Node builds (verified 2.36 on this host); the helper must degrade to null rather than throw'
    - 'The @ladybugdb/core linux-x64 prebuilt floor is GLIBC_2.34 (objdump on node_modules/@ladybugdb/core/lbugjs.node 0.18.3: dlopen/pthread_* @GLIBC_2.34, fstat64/lstat @GLIBC_2.33) — re-check with objdump if the dependency version changes before the README claim ships'
    - 'RESOLVED in the deepen pass: no test or script reads gitnexus/README.md structurally (the README hits under test/ are skill READMEs, graph fixtures, and git-utils scratch files), so the README edits carry no guard'

  open_questions:
    - 'Should the root README.md Quick Start also carry the Windows prerequisite note, or is the npm-facing gitnexus/README.md sufficient? (root README has no Requirements section today)'
    - 'Should an upstream issue be filed against LadybugDB for a lower-glibc (manylinux_2_28-era) prebuild? Out of scope for this PR.'

  avoid:
    - 'Do not repeat full repository discovery'
    - 'Do not replace established patterns without evidence'
    - 'Do not import analyzer-identity.ts (or any non-builtin) into native-check.ts — it is the dependency-light startup gate'
    - 'Do not add i18n keys for these strings; the subsystem is deliberately literal English (doctor.ts:185-187)'
    - 'Do not move the glibc branch above the line-88 probe.error / status===0 gate'
    - 'Do not change describeNativeLoadFailure, FILE_CORRUPTION_SIGNATURES, or any classifier kind'
    - 'Do not re-fix doctor "Full-text search: available" — already fixed on main by #2374/#2375 (commit 177bbc89), merely unreleased in 1.6.9'
    - 'Do not weaken or delete existing assertions in the two touched test files'
    - 'Do not add the Git Bash hint at a call site (doctor.ts, run-analyze.ts, fts-indexes.ts) — it belongs in the remedy builder, or the cached per-request surfaces miss it'
    - 'Do not put any C:\Users\ or home-directory path in remedy text (breaks the redaction assertions in fts-degraded-warning.test.ts:56,78)'
    - 'Do not edit gitnexus/src/core/search/fts-indexes.ts — it inherits the change and is only a verification target'
```

## 12. Assumptions and Open Questions

**Confirmed facts** (source-verified at e34967ee): the failure-message body and its `install.js` advice; the line-88 control gate; the five message consumers; the literal-English i18n convention; the existing remedy assertions; the absence of any README structure guard; the verification commands and their working directories.

**Assumptions** (carried into the pack for re-verification):

- glibc's loader wording ``version `GLIBC_x.y' not found`` is stable across distributions — the regex silently no-ops if it ever changes, degrading to today's message rather than regressing.
- `process.report.getReport().header.glibcVersionRuntime` is available on supported Node builds (observed `2.36` on this host); the helper must still degrade to "unknown".
- The `@ladybugdb/core` 0.18.3 linux-x64 floor is `GLIBC_2.34`, from `objdump -T` on the installed `lbugjs.node` (`dlopen`, `pthread_create`, `pthread_key_create`, `pthread_rwlock_*` @ `GLIBC_2.34`; `fstat64`, `lstat` @ `GLIBC_2.33`). This is the number the README will publish — re-check it if the dependency is bumped.

**Open questions:**

- Should the root `README.md` (GitHub landing page, no Requirements section today) also carry the Windows prerequisite note, or is the npm-published `gitnexus/README.md` sufficient?

**Explicitly deferred** (not in this PR):

- Filing the upstream LadybugDB issue asking for a prebuild against an older glibc base (manylinux_2_28-era). That is the only fix that makes GitNexus *work* on glibc < 2.34; this PR only stops lying about it.
- `hedgedLoadFailureRemedy` (`extension-load-error.ts:149-156`) is left unchanged. It is already the longest remedy and deliberately non-committal; adding a Windows-specific PATH hint to a language-independent hedge would dilute it.
- #2669's `doctor` complaint ("Full-text search: available" while the load failed) needs **no code change**: it was fixed on main by #2374/#2375 (commit `177bbc89`, 2026-07-06) and is simply not in published 1.6.9 (tagged 2026-07-04). Handle it as an issue reply / release note.
- Re-indexing the repository and rebuilding `gitnexus/dist` so the analyzer runner identity is current — a planning run must not build output.
- Recording the missing REACHING_DEF sub-layer (`analyze --index-only --pdg`). The deepen pass established that the index has CDG but no data-dependence edges; repairing it is barred by the same provenance gate, and every data-flow claim here is source-derived instead.

## 13. Definition of Done

- [ ] `glibcTooOldMessage` returns a message for the #2672 reporter's stderr that names the required glibc (2.34) and the host glibc, says reinstalling will **not** help, and contains neither `install.js` nor `trustedDependencies`.
- [ ] Multi-version stderr reports the highest required version, compared numerically (`2.9` < `2.34`).
- [ ] Non-glibc stderr returns `null`, and the existing missing/zero-byte/truncated/un-runnable-probe behaviours are unchanged (their tests pass untouched).
- [ ] `windowsMissingDependencyRemedy` and `structuralMissingDependencyRemedy` name the Git Bash / `mingw64\bin` PATH workaround; all pre-existing remedy assertions still pass.
- [ ] `gitnexus/README.md` documents the Linux glibc ≥ 2.34 floor and the Windows FTS prerequisites (VC++ x64 redist + OpenSSL 3 on PATH, Git Bash workaround, search index skipped otherwise).
- [ ] No new i18n keys in `src/cli/i18n/en.ts` or `zh-CN.ts`.
- [ ] `cd gitnexus && npx tsc --noEmit` clean.
- [ ] `cd gitnexus && npm run test:unit` green.
- [ ] `npx eslint .` and `npx prettier --check .` clean at the repo root.
- [ ] `detect_changes()` before commit shows only the five files in §10.

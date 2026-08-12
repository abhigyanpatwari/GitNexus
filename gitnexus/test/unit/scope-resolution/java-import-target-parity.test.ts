/**
 * Differential harness for the Java import-target index hoist (#2908).
 *
 * `resolveJavaImportTarget` answered its three-tier cascade with a full
 * `allFilePaths` scan, and ran that scan AGAIN inside the progressive
 * prefix-stripping loop — once per stripped segment. Replacing those scans with
 * the per-file-set indexes (`getWorkspaceFileIndex` +
 * `buildPackageDirIndex`/`firstFileDirectlyInPkgDir`) is a pure performance
 * change ONLY if every implicit tie-break survives, and those tie-breaks are
 * expressed through Set-iteration order and `indexOf` positions rather than
 * through anything the type system or the existing Java tests can see:
 *
 *   - the first pass `break`s on an exact whole-path hit, so an exact match wins
 *     over a suffix OR directory-child match found EARLIER in iteration order;
 *   - the stripping loop instead returns mid-scan at the first hit of
 *     `f === tailFile || f.endsWith('/' + tailFile)` — no exact-wins rule there
 *     — while its directory child is collected and returned only after the scan
 *     completes, so file/suffix beats directory child within one `skip` level
 *     regardless of order;
 *   - the directory-child leg answers when the file's PARENT directory ends
 *     with `pathLike`, so `com/example/com/example/Deep.java` DOES answer
 *     `com.example`. It took the FIRST `'/' + pathLike + '/'` occurrence until
 *     #2881, which made a package whose name repeats higher in its own path
 *     unresolvable;
 *   - a wildcard import drops its trailing `.*` before any of that runs;
 *   - paths are compared normalized (`\` → `/`) but returned RAW.
 *
 * So this file keeps a copy of the pre-change implementation — the
 * `resolveJavaImportTarget` that shipped before #2908, scans and all, minus the
 * one rule #2881 deliberately removed (see tie-break 3) — and
 * asserts the new one agrees with it, both on hand-built corpora built to force
 * exactly those cases and on a generated corpus replayed under three insertion
 * orders — order being the only channel most of these tie-breaks travel on.
 * The copy is the specification; if a future change makes an arm here fail, the
 * resolver's OUTPUT moved and Java's IMPORTS edges move with it.
 *
 * The hand-built arm additionally pins ABSOLUTE expectations. A pure
 * differential goes green when old and new agree on `null` everywhere, which is
 * also what a corpus that has quietly stopped matching anything looks like.
 *
 * The last arm counts how often the file Set is iterated, as the deterministic
 * guard against a scan reintroduced BESIDE the reused index. It is not the
 * guard for a defensive `new Set(allFilePaths)` copy in the orchestrator
 * ADAPTER — that lives one layer above every call here, and is guarded by
 * `test/integration/java-import-index-reuse.test.ts`.
 */
import { describe, expect, it } from 'vitest';
import type { ParsedImport, WorkspaceIndex } from 'gitnexus-shared';

import { resolveJavaImportTarget } from '../../../src/core/ingestion/languages/java/import-target.js';
import { CountingSet } from '../../helpers/counting-file-set.js';

// ─── pre-change implementation, minus the rule #2881 removed ─────────────────

interface LegacyJavaResolveContext {
  readonly fromFile: string;
  readonly allFilePaths: ReadonlySet<string>;
}

function legacyResolveJavaImportTarget(
  parsedImport: ParsedImport,
  workspaceIndex: WorkspaceIndex,
): string | null {
  const ctx = workspaceIndex as LegacyJavaResolveContext | undefined;
  if (
    ctx === undefined ||
    typeof (ctx as { fromFile?: unknown }).fromFile !== 'string' ||
    !((ctx as { allFilePaths?: unknown }).allFilePaths instanceof Set)
  ) {
    return null;
  }
  if (parsedImport.kind === 'dynamic-unresolved') return null;
  if (parsedImport.targetRaw === null || parsedImport.targetRaw === '') return null;

  // Strip trailing `.*` for wildcard imports: `com.example.*` → `com.example`
  let target = parsedImport.targetRaw;
  if (target.endsWith('.*')) {
    target = target.slice(0, -2);
  }

  // Package path: `com.example.User` → `com/example/User`
  const pathLike = target.replace(/\./g, '/');
  const suffix = `/${pathLike}`;

  let exactFile: string | null = null;
  let suffixFile: string | null = null;
  let directoryChild: string | null = null;
  const suffixDirPrefix = `/${pathLike}/`;

  for (const raw of ctx.allFilePaths) {
    const f = raw.replace(/\\/g, '/');
    if (!f.endsWith('.java')) continue;
    if (f === `${pathLike}.java`) {
      exactFile = raw;
      break;
    }
    if (suffixFile === null && f.endsWith(`${suffix}.java`)) {
      suffixFile = raw;
    }
    if (directoryChild === null) {
      // Since #2881: "the file's parent directory ends with `pathLike`". The
      // `atRoot`/`indexOf` pair this replaces said that AND "…and that is the
      // first occurrence". `>= 0`, not `> 0` — a repo-root file has `lastSlash`
      // 0 for `/Top.java` shapes and the bare-wildcard case depends on it.
      const lastSlash = f.lastIndexOf('/');
      if (lastSlash >= 0 && `/${f.slice(0, lastSlash)}/`.endsWith(suffixDirPrefix)) {
        directoryChild = raw;
      }
    }
  }

  if (exactFile !== null) return exactFile;
  if (suffixFile !== null) return suffixFile;
  if (directoryChild !== null) return directoryChild;

  // Progressive prefix stripping — handles `import com.example.User;`
  // in a repo laid out `User.java` (no `com/example/` prefix).
  const segments = pathLike.split('/').filter(Boolean);
  for (let skip = 1; skip < segments.length; skip++) {
    const tail = segments.slice(skip).join('/');
    if (tail === '') continue;
    const tailFile = `${tail}.java`;
    const tailSuffix = `/${tailFile}`;
    const tailSuffixDir = `/${tail}/`;
    let tailDirectChild: string | null = null;
    for (const raw of ctx.allFilePaths) {
      const f = raw.replace(/\\/g, '/');
      if (!f.endsWith('.java')) continue;
      if (f === tailFile) return raw;
      if (f.endsWith(tailSuffix)) return raw;
      if (tailDirectChild === null) {
        const lastSlash = f.lastIndexOf('/');
        if (lastSlash >= 0 && `/${f.slice(0, lastSlash)}/`.endsWith(tailSuffixDir)) {
          tailDirectChild = raw;
        }
      }
    }
    if (tailDirectChild !== null) return tailDirectChild;
  }

  return null;
}

// ─── harness ─────────────────────────────────────────────────────────────────

const FROM_FILE = 'src/main/java/com/example/App.java';

function javaImport(targetRaw: string): ParsedImport {
  return { kind: 'named', localName: '_', importedName: '_', targetRaw };
}

/** A file layout plus the import spelling resolved against it. */
interface Case {
  readonly label: string;
  readonly files: readonly string[];
  readonly target: string;
}

/**
 * `label => result`, so a divergence names the case instead of printing an
 * index into two long arrays. `null` is spelled, not dropped: "resolved
 * nothing" is a real answer and must be diffed like any other.
 */
function runAll(
  cases: readonly Case[],
  resolve: (i: ParsedImport, w: WorkspaceIndex) => string | null,
): string[] {
  return cases.map((c) => {
    const ws = { fromFile: FROM_FILE, allFilePaths: new Set(c.files) };
    return `${c.label} => ${resolve(javaImport(c.target), ws) ?? 'null'}`;
  });
}

// ─── hand-built tie-break corpora ────────────────────────────────────────────

/**
 * One corpus per tie-break, each as small as the rule it pins. The expectation
 * strings are the pre-change behaviour, derived by hand from the scan and
 * confirmed against the verbatim copy by the first `it` below.
 */
const HAND_CASES: readonly Case[] = [
  {
    // Tier 1: the scan `break`s on the exact hit, so it wins over the suffix
    // match already found at position 0. `index.get` alone returns position 0.
    label: 'exact-beats-earlier-suffix',
    files: ['src/main/java/com/example/model/User.java', 'com/example/model/User.java'],
    target: 'com.example.model.User',
  },
  {
    // Same rule against the directory-child leg.
    label: 'exact-beats-earlier-directory-child',
    files: ['com/example/util/Helper/Inner.java', 'com/example/util/Helper.java'],
    target: 'com.example.util.Helper',
  },
  {
    label: 'suffix-beats-earlier-directory-child',
    files: ['com/example/util/Helper/Inner.java', 'src/com/example/util/Helper.java'],
    target: 'com.example.util.Helper',
  },
  {
    label: 'directory-child-is-first-in-set-order',
    files: ['com/example/service/Beta.java', 'com/example/service/Alpha.java'],
    target: 'com.example.service',
  },
  {
    label: 'directory-child-order-follows-insertion',
    files: ['com/example/service/Alpha.java', 'com/example/service/Beta.java'],
    target: 'com.example.service',
  },
  {
    // Tie-break 3: `.*` is stripped, so this is the package-directory query.
    label: 'wildcard-resolves-as-package-directory',
    files: ['com/example/service/Beta.java', 'com/example/service/Alpha.java'],
    target: 'com.example.service.*',
  },
  {
    // A file named like the package beats that package's directory child.
    label: 'wildcard-exact-file-beats-directory',
    files: ['com/example/service/Alpha.java', 'com/example/service.java'],
    target: 'com.example.service.*',
  },
  {
    // Tie-break 5: the parent directory `com/example/com/example` ends with
    // `com/example`, so it answers. Until #2881 the leg took the FIRST
    // `/com/example/` occurrence, which leaves `com/example/Deep.java` after it
    // — still containing a slash — and the import resolved to null.
    label: 'self-nested-directory-answers-the-outer-package',
    files: ['com/example/com/example/Deep.java'],
    target: 'com.example',
  },
  {
    // Kept beside `self-nested-directory-answers-the-outer-package` even though
    // both now resolve to the same file: this one addresses the FULL path and
    // hits the exact-file/suffix tier, that one addresses the outer package and
    // hits the directory-child tier. Before #2881 the pair separated a hit from
    // a null; it now separates two tiers, which is why it is still two cases.
    label: 'self-nested-directory-matches-full-path',
    files: ['com/example/com/example/Deep.java'],
    target: 'com.example.com.example',
  },
  {
    // Tie-break 2: the directory child is seen first, the suffix hit second,
    // and the suffix hit still wins because the scan returns mid-loop.
    label: 'stripping-suffix-beats-earlier-directory-child',
    files: ['x/models/Order/Part.java', 'y/models/Order.java'],
    target: 'com.shop.models.Order',
  },
  {
    label: 'stripping-reaches-root-file',
    files: ['Order.java'],
    target: 'com.shop.Order',
  },
  {
    // The mirror of tie-break 1: inside the stripping loop the scan returns at
    // the first hit of `f === tailFile || f.endsWith('/' + tailFile)`, so the
    // suffix hit at position 0 beats the whole-path file behind it. Applying
    // tier 1's exact-wins rule here would answer `Order.java`.
    label: 'stripping-takes-the-first-hit-not-the-whole-path-one',
    files: ['a/Order.java', 'Order.java'],
    target: 'com.shop.Order',
  },
  {
    label: 'stripping-reaches-directory-child',
    files: ['proj/models/Thing.java'],
    target: 'com.shop.models',
  },
  {
    // Tie-break 4: matched on the normalized path, returned RAW.
    label: 'backslash-paths-normalize-and-return-raw',
    files: ['win\\src\\com\\example\\win\\Windows.java'],
    target: 'com.example.win.Windows',
  },
  {
    label: 'duplicate-normalized-path-keeps-first-raw-spelling',
    files: ['a/b/Dup.java', 'a\\b\\Dup.java'],
    target: 'a.b.Dup',
  },
  {
    label: 'duplicate-normalized-path-keeps-first-raw-spelling-reversed',
    files: ['a\\b\\Dup.java', 'a/b/Dup.java'],
    target: 'a.b.Dup',
  },
  {
    // Tie-break 4: the `.java` filter, on both the file and the directory legs.
    label: 'non-java-sibling-is-skipped',
    files: ['com/example/model/User.kt', 'com/example/model/User.java'],
    target: 'com.example.model.User',
  },
  {
    label: 'directory-of-non-java-files-is-not-a-package-directory',
    files: ['com/example/onlytext/notes.txt', 'com/example/onlytext/README.md'],
    target: 'com.example.onlytext',
  },
  {
    label: 'several-directories-share-a-last-segment',
    files: ['svc-b/shared/BShared.java', 'svc-a/shared/AShared.java'],
    target: 'shared',
  },
  {
    label: 'several-directories-share-a-last-segment-reversed',
    files: ['svc-a/shared/AShared.java', 'svc-b/shared/BShared.java'],
    target: 'shared',
  },
  {
    label: 'root-file-exact-match',
    files: ['src/Loose.java', 'Loose.java'],
    target: 'Loose',
  },
  {
    label: 'single-segment-target-has-no-stripping-pass',
    files: ['deep/pkg/Loose.java'],
    target: 'Loose',
  },
  {
    // `.*` alone strips to the empty package path — the degenerate query the
    // directory index answers through its empty-last-segment bucket.
    label: 'bare-wildcard-over-absolute-paths',
    files: ['/abs/Root.java', '/Top.java'],
    target: '.*',
  },
  {
    label: 'bare-wildcard-over-relative-paths',
    files: ['pkg/Root.java', 'Top.java'],
    target: '.*',
  },
  {
    label: 'empty-segments-are-not-collapsed-in-the-first-pass',
    files: ['com/example/User.java'],
    target: 'com..example.User',
  },
  {
    // Every tier is case-sensitive, so the package path never matches — but the
    // stripping loop reaches the bare basename, which does.
    label: 'case-mismatch-falls-through-to-basename-stripping',
    files: ['com/Example/Model/Cased.java'],
    target: 'com.example.model.Cased',
  },
  {
    label: 'directory-named-like-a-java-file',
    files: ['com/example/weird.java/Inside.java'],
    target: 'com.example.weird',
  },
  {
    // Java has no in-repo-namespace gate (C#'s #1881), so a JDK import whose
    // tail happens to exist locally resolves to it. Pinned, not endorsed.
    label: 'jdk-import-strips-into-a-local-lookalike',
    files: ['com/example/model/User.java', 'src/main/java/util/List.java'],
    target: 'java.util.List',
  },
  {
    label: 'jdk-import-with-no-lookalike-resolves-to-nothing',
    files: ['com/example/model/User.java'],
    target: 'java.util.List',
  },
  // ── negative control for the widening (#2881), matching Kotlin's ──────────
  // Everything above pins the widened leg from the POSITIVE side: a file whose
  // package directory repeats higher in its own path now answers. Nothing here
  // pinned the other half — that dropping the first-occurrence rule did not
  // widen "the parent directory ends with `pathLike`" into "`pathLike` appears
  // somewhere in the path". These three are the same trio
  // `kotlin-import-target-parity.test.ts` carries: the two positions the old
  // `atRoot`/`indexOf` pair distinguished, plus the positive control that keeps
  // the pair from passing by refusing everything.
  {
    label: 'not-the-parent-directory-stays-out-leading',
    files: ['com/example/sub/Repo.java'],
    target: 'com.example',
  },
  {
    label: 'not-the-parent-directory-stays-out-mid-path',
    files: ['top/com/example/mid/Repo.java'],
    target: 'com.example',
  },
  {
    label: 'the-parent-directory-itself-does-answer',
    files: ['top/com/example/Repo.java'],
    target: 'com.example',
  },
];

/** Absolute pre-change behaviour, so the differential cannot pass vacuously. */
const HAND_EXPECTED: readonly string[] = [
  'exact-beats-earlier-suffix => com/example/model/User.java',
  'exact-beats-earlier-directory-child => com/example/util/Helper.java',
  'suffix-beats-earlier-directory-child => src/com/example/util/Helper.java',
  'directory-child-is-first-in-set-order => com/example/service/Beta.java',
  'directory-child-order-follows-insertion => com/example/service/Alpha.java',
  'wildcard-resolves-as-package-directory => com/example/service/Beta.java',
  'wildcard-exact-file-beats-directory => com/example/service.java',
  'self-nested-directory-answers-the-outer-package => com/example/com/example/Deep.java',
  'self-nested-directory-matches-full-path => com/example/com/example/Deep.java',
  'stripping-suffix-beats-earlier-directory-child => y/models/Order.java',
  'stripping-reaches-root-file => Order.java',
  'stripping-takes-the-first-hit-not-the-whole-path-one => a/Order.java',
  'stripping-reaches-directory-child => proj/models/Thing.java',
  'backslash-paths-normalize-and-return-raw => win\\src\\com\\example\\win\\Windows.java',
  'duplicate-normalized-path-keeps-first-raw-spelling => a/b/Dup.java',
  'duplicate-normalized-path-keeps-first-raw-spelling-reversed => a\\b\\Dup.java',
  'non-java-sibling-is-skipped => com/example/model/User.java',
  'directory-of-non-java-files-is-not-a-package-directory => null',
  'several-directories-share-a-last-segment => svc-b/shared/BShared.java',
  'several-directories-share-a-last-segment-reversed => svc-a/shared/AShared.java',
  'root-file-exact-match => Loose.java',
  'single-segment-target-has-no-stripping-pass => deep/pkg/Loose.java',
  'bare-wildcard-over-absolute-paths => /Top.java',
  // A relative root file has no leading slash, so the empty package path finds
  // nothing — unlike the absolute case above.
  'bare-wildcard-over-relative-paths => null',
  // `filter(Boolean)` drops the empty segment, so stripping recovers the file
  // the first pass could not see.
  'empty-segments-are-not-collapsed-in-the-first-pass => com/example/User.java',
  'case-mismatch-falls-through-to-basename-stripping => com/Example/Model/Cased.java',
  'directory-named-like-a-java-file => null',
  'jdk-import-strips-into-a-local-lookalike => src/main/java/util/List.java',
  'jdk-import-with-no-lookalike-resolves-to-nothing => null',
  // `com/example/sub` ends with `example/sub`, not with `com/example`, and the
  // stripping loop's `example` level does not reach it either — so the file is
  // in no bucket the query can name.
  'not-the-parent-directory-stays-out-leading => null',
  'not-the-parent-directory-stays-out-mid-path => null',
  'the-parent-directory-itself-does-answer => top/com/example/Repo.java',
];

// ─── generated corpus ────────────────────────────────────────────────────────

const SOURCE_ROOTS = ['src/main/java', 'src/test/java', '', 'legacy', 'modules/core/src/main/java'];
const PACKAGE_DIRS = [
  'com/example/model',
  'com/example/service',
  'com/example/util',
  'org/acme/api',
  'io/gn/core',
];
const TYPE_NAMES = ['User', 'Order', 'Helper', 'Client', 'Registry'];

/**
 * A layout where the same package path exists under several source roots AND
 * root-relative, so most lookups have a whole-path candidate and one or more
 * earlier suffix candidates — the collision tier 1 turns on. The tail adds the
 * shapes a regular layout never produces: self-nested packages, directories
 * sharing a last segment, non-`.java` neighbours, root files, backslash paths,
 * and the stripping-only targets.
 */
function generatedFiles(): string[] {
  const files: string[] = [];
  for (const pkg of PACKAGE_DIRS) {
    for (const type of TYPE_NAMES) {
      for (const root of SOURCE_ROOTS) {
        files.push(root === '' ? `${pkg}/${type}.java` : `${root}/${pkg}/${type}.java`);
      }
    }
  }
  // A file whose whole path IS a package directory used elsewhere.
  files.push('com/example/service.java');
  files.push('src/main/java/com/example/model.java');
  // Packages nested inside themselves.
  files.push('com/example/model/com/example/model/Nested.java');
  files.push('legacy/io/gn/core/io/gn/core/Legacy.java');
  // Directories sharing a last segment across trees.
  for (let i = 0; i < 4; i++) {
    files.push(`svc${i}/shared/Shared${i}.java`);
    files.push(`svc${i}/shared/internal/Deep${i}.java`);
  }
  // Non-`.java` neighbours, including a directory with none of them accepted.
  files.push('com/example/model/User.kt');
  files.push('com/example/model/package-info.txt');
  files.push('com/example/resources/application.yaml');
  files.push('com/example/weird.java/Inside.java');
  // Root files and a deep chain.
  files.push('Loose.java');
  files.push('Order.java');
  files.push('a/b/c/d/e/f/Deep6.java');
  // Backslash spellings, one of them a duplicate of a forward-slash entry.
  files.push('win\\src\\main\\java\\com\\example\\win\\WinUser.java');
  files.push('a/b/Dup.java');
  files.push('a\\b\\Dup.java');
  // Reachable only after progressive prefix stripping, with a directory child
  // planted ahead of the suffix hit at the same `skip` level.
  files.push('x/models/Order/Part.java');
  files.push('bare/models/Order.java');
  files.push('bare/models/Invoice.java');
  return files;
}

function generatedTargets(): string[] {
  const targets: string[] = [];
  for (const pkg of PACKAGE_DIRS) {
    const dotted = pkg.replace(/\//g, '.');
    targets.push(dotted);
    targets.push(`${dotted}.*`);
    for (const type of TYPE_NAMES) targets.push(`${dotted}.${type}`);
  }
  targets.push(
    // Package prefixes: partial paths that are directories but not packages.
    'com',
    'com.example',
    'com.*',
    'org',
    'org.acme',
    'io',
    'io.gn',
    'src.main.java.com.example.model.User',
    'legacy.com.example.util.Helper',
    'modules.core.src.main.java.io.gn.core.Client',
    // Self-nesting.
    'com.example.model.com.example.model',
    'com.example.model.com.example.model.Nested',
    'io.gn.core.io.gn.core.Legacy',
    // Shared last segments.
    'shared',
    'shared.*',
    'svc0.shared',
    'svc2.shared.internal',
    'internal',
    // Stripping-only.
    'com.shop.models.Order',
    'com.shop.models',
    'com.shop.models.*',
    'whatever.bare.models.Invoice',
    'nowhere.Loose',
    'nowhere.deeply.nested.Order',
    // Non-`.java` and odd shapes.
    'com.example.resources',
    'com.example.weird',
    'com.example.model.User.kt',
    'a.b.Dup',
    'a.b.c.d.e.f.Deep6',
    'com.example.win.WinUser',
    '.*',
    '*',
    'com..example.User',
    'Loose',
    'Order',
    // Unresolvable: JDK and third-party, the majority case in real source.
    'java.util.List',
    'java.util.*',
    'java.io.File',
    'javax.annotation.Nullable',
    'org.junit.jupiter.api.Test',
    'org.springframework.boot.SpringApplication',
    'com.google.common.collect.ImmutableList',
    'com.example.missing.Absent',
  );
  return targets;
}

/**
 * Three insertion orders over the same paths. Set-iteration order IS the
 * tie-break channel for every "first match wins" rule here, so replaying the
 * same targets under a reversal and a rotation exercises each collision from
 * both sides — the as-built order alone would leave half of them one-sided.
 */
function orderedCorpora(): ReadonlyMap<string, readonly string[]> {
  const base = generatedFiles();
  const reversed = [...base].reverse();
  const rotation = 7;
  const rotated = [...base.slice(rotation), ...base.slice(0, rotation)];
  return new Map([
    ['as-built', base],
    ['reversed', reversed],
    ['rotated', rotated],
  ]);
}

function generatedCases(): Case[] {
  const cases: Case[] = [];
  for (const [order, files] of orderedCorpora()) {
    for (const target of generatedTargets()) {
      cases.push({ label: `${order}|${target}`, files, target });
    }
  }
  return cases;
}

const GENERATED_CASES = generatedCases();

// ─── arms ────────────────────────────────────────────────────────────────────

describe('Java import target — index hoist parity (#2908)', () => {
  it('reproduces the pre-change results on the hand-built tie-break corpora', () => {
    expect(runAll(HAND_CASES, legacyResolveJavaImportTarget)).toEqual(HAND_EXPECTED);
    expect(runAll(HAND_CASES, resolveJavaImportTarget)).toEqual(HAND_EXPECTED);
  });

  it('reproduces the pre-change results across three insertion orders', () => {
    expect(runAll(GENERATED_CASES, resolveJavaImportTarget)).toEqual(
      runAll(GENERATED_CASES, legacyResolveJavaImportTarget),
    );
  });

  it('the generated corpus resolves a broad set of distinct targets', () => {
    const results = runAll(GENERATED_CASES, resolveJavaImportTarget);
    const resolvedFiles = new Set(
      results.map((r) => r.split(' => ')[1]).filter((r) => r !== 'null'),
    );

    // Non-vacuity: a differential is worthless if both sides answer `null`.
    // Sized just under the current values so ordinary corpus edits do not trip
    // it, while a corpus that stops matching does.
    expect(results.filter((r) => !r.endsWith('=> null')).length).toBeGreaterThan(150);
    expect(resolvedFiles.size).toBeGreaterThan(40);
    // ...and it must keep exercising the unresolvable majority, which is the
    // only case that runs the whole cascade.
    expect(results.filter((r) => r.endsWith('=> null')).length).toBeGreaterThan(50);
  });

  it('matches the pre-change guards for unusable inputs', () => {
    const files = new Set(['com/example/model/User.java']);
    const good = { fromFile: FROM_FILE, allFilePaths: files };
    const inputs: readonly (readonly [string, ParsedImport, WorkspaceIndex])[] = [
      ['undefined context', javaImport('com.example.model.User'), undefined],
      ['missing fromFile', javaImport('com.example.model.User'), { allFilePaths: files }],
      [
        'allFilePaths is not a Set',
        javaImport('com.example.model.User'),
        { fromFile: FROM_FILE, allFilePaths: ['com/example/model/User.java'] },
      ],
      [
        'dynamic-unresolved import',
        { kind: 'dynamic-unresolved', localName: '', targetRaw: 'com.example.model.User' },
        good,
      ],
      // `targetRaw: null` is reachable only on `dynamic-unresolved`, which the
      // kind check above already refuses, so the resolver's null branch has no
      // typeable input of its own.
      ['empty target', javaImport(''), good],
      ['wildcard kind', { kind: 'wildcard', targetRaw: 'com.example.model.*' }, good],
    ];

    const legacy = inputs.map(([label, imp, ws]) => {
      return `${label} => ${legacyResolveJavaImportTarget(imp, ws) ?? 'null'}`;
    });
    const current = inputs.map(([label, imp, ws]) => {
      return `${label} => ${resolveJavaImportTarget(imp, ws) ?? 'null'}`;
    });

    expect(current).toEqual(legacy);
    // Every one of them refuses, except the last — a well-formed call, so the
    // arm cannot pass by refusing everything.
    expect(current).toEqual([
      'undefined context => null',
      'missing fromFile => null',
      'allFilePaths is not a Set => null',
      'dynamic-unresolved import => null',
      'empty target => null',
      'wildcard kind => com/example/model/User.java',
    ]);
  });

  it('pins WHICH of two competing package directories the first-child leg takes', () => {
    // `firstFileDirectlyInPkgDir` commits to ONE file with no downstream
    // filter, and #2881 widened the set it chooses from. Every widened-shape
    // case in HAND_CASES uses a ONE-FILE corpus, so the widened bucket has a
    // single member and the choice is not exercised anywhere — yet a different
    // first child is the largest class of movement the change produced.
    //
    // Both files below are legitimate members of the widened `com/example`
    // set: `com/example/legacy/com/example` ends with `com/example` (it is the
    // self-nested shape #2881 admitted) and `src/main/java/com/example` ends
    // with it too. Nothing in the resolver prefers one over the other. The
    // tie-break is FILE-SET ITERATION ORDER — the insertion order of the Set
    // the caller passes — so reversing the corpus reverses the answer. That is
    // the property these assertions pin, and the one nothing else watches:
    // membership is already pinned above, the WINNER was not.
    const set = (files: readonly string[]): WorkspaceIndex =>
      ({ fromFile: FROM_FILE, allFilePaths: new Set(files) }) as WorkspaceIndex;
    const nestedFirst = [
      'com/example/legacy/com/example/Old.java',
      'src/main/java/com/example/App.java',
    ];
    const conventionalFirst = [...nestedFirst].reverse();

    expect(resolveJavaImportTarget(javaImport('com.example'), set(nestedFirst))).toBe(
      'com/example/legacy/com/example/Old.java',
    );
    expect(resolveJavaImportTarget(javaImport('com.example'), set(conventionalFirst))).toBe(
      'src/main/java/com/example/App.java',
    );
    // A wildcard drops its `.*` before any of that, so it lands on the same leg
    // and moves with it. Spelled out because `com.example.*` is how real Java
    // source reaches this tier.
    expect(resolveJavaImportTarget(javaImport('com.example.*'), set(nestedFirst))).toBe(
      'com/example/legacy/com/example/Old.java',
    );
    expect(resolveJavaImportTarget(javaImport('com.example.*'), set(conventionalFirst))).toBe(
      'src/main/java/com/example/App.java',
    );
    // The pre-change copy agrees on both orders, which places the movement in
    // #2881's removal of the first-occurrence rule rather than in #2908's
    // index hoist: the hoist did not touch the tie-break, it inherited it.
    expect(legacyResolveJavaImportTarget(javaImport('com.example'), set(nestedFirst))).toBe(
      'com/example/legacy/com/example/Old.java',
    );
    expect(legacyResolveJavaImportTarget(javaImport('com.example'), set(conventionalFirst))).toBe(
      'src/main/java/com/example/App.java',
    );
  });

  it('builds each index once per file set rather than once per import', () => {
    const files = new CountingSet(generatedFiles());
    const ws = { fromFile: FROM_FILE, allFilePaths: files };
    const targets = generatedTargets();

    const results = targets.map((t) => resolveJavaImportTarget(javaImport(t), ws));

    // Two traversals for the whole run: the shared workspace/suffix index and
    // the package-directory index, each memoized on this Set's identity. The
    // pre-change resolver traversed once per import PLUS once per stripped
    // segment.
    expect(files.scans).toBe(2);
    // Paired result assertion — a count of 2 is equally true of a resolver that
    // has stopped resolving anything at all.
    expect(results.filter((r) => r !== null).length).toBeGreaterThan(20);
    expect(resolveJavaImportTarget(javaImport('com.example.model.User'), ws)).toBe(
      'com/example/model/User.java',
    );
  });
});

/**
 * Differential harness for the PHP import-target index (#2901).
 *
 * PHP was the last language resolving imports with a full workspace scan per
 * import: both adapters in `languages/php/import-target.ts` materialized
 * `[...allFilePaths]` twice and then passed `resolvePhpImportInternal` an
 * `index` of `undefined`, dropping it onto `suffixResolve`'s linear `findIndex`
 * — one pass over every file per path-part × per extension.
 *
 * Unlike #2877–#2880, handing that function the SHARED `SuffixIndex` is not a
 * hoist. `resolvePhpImportInternal` reads the index at three sites and all
 * three answer a different question than the scan they short-circuit, so the
 * fix passes a PARITY view instead (see the `#2901` header in
 * `import-target.ts`). This file is the proof that the view is faithful: it
 * holds verbatim copies of the pre-change implementations
 * (`git show HEAD~:gitnexus/src/core/ingestion/languages/php/import-target.ts`)
 * and asserts the shipped ones agree with them everywhere.
 *
 * The corpus is built to force the three divergences, because ordinary PHP
 * imports do not show them — a plain `use App\Models\User;` against one
 * matching file agrees under either index:
 *
 *   1. PSR-4 class-style is `allFiles.has(filePath)`, an exact whole-path test,
 *      and the raw index would add a case-insensitive SUFFIX probe beside it —
 *      so the corpus contains `vendor/**` mirrors that differ only in case.
 *   2. The namespace-directory scan is anchored at the repo root
 *      (`f.startsWith(nsDir + '/')`), the raw index's `getFilesInDir` is keyed
 *      on every directory SUFFIX — so the corpus contains
 *      `vendor/pkg/app/Models/` beside `app/Models/`.
 *   3. `suffixResolve`'s scan tests `endsWith('/' + S)` and therefore can only
 *      match a PROPER suffix, while `buildSuffixIndex` indexes the whole path
 *      too — so the corpus contains root-level files and paths that are
 *      themselves the suffix another file carries, in BOTH iteration orders.
 *
 * Set iteration order is the tie-break for every one of those, which is why the
 * generated corpus is emitted in a fixed order and several hand cases appear
 * twice with the two files swapped. Nothing here is random.
 *
 * Every hand case additionally pins ABSOLUTE `expected` /
 * `expectedViaWorkspace` literals, for the reason spelled out under the
 * verbatim-copy banner below: the differential cannot fail on anything the two
 * sides share, and they share `resolvePhpImportInternal` itself.
 *
 * This file calls the resolver functions directly, so it does NOT guard PR
 * #1918 review finding P1 — a defensive `new Set(allFilePaths)` in
 * `php/scope-resolver.ts` leaves every arm here green. That is
 * `test/integration/php-import-index-reuse.test.ts`.
 */
import { describe, expect, it } from 'vitest';
import type { ParsedFile, ParsedImport, SymbolDefinition, WorkspaceIndex } from 'gitnexus-shared';

import {
  resolvePhpImportTarget,
  resolvePhpImportTargetInternal,
  type PhpResolveContext,
} from '../../../src/core/ingestion/languages/php/import-target.js';
import { resolvePhpImportInternal } from '../../../src/core/ingestion/import-resolvers/php.js';
import { buildSuffixIndex } from '../../../src/core/ingestion/import-resolvers/utils.js';
import type { ComposerConfig } from '../../../src/core/ingestion/language-config.js';
import type { ImportResolutionContext } from '../../../src/core/ingestion/scope-resolution/contract/scope-resolver.js';
import { CountingSet } from '../../helpers/counting-file-set.js';

// ─── verbatim pre-change implementation ──────────────────────────────────────
// Copied from `git show HEAD~:gitnexus/src/core/ingestion/languages/php/
// import-target.ts`. `resolvePhpImportInternal` is NOT copied — it is imported
// from the shipped source, and #2901 (`67307cc91`) DID change it: 41 lines,
// including the `if (index) … else` split that moved the namespace-directory
// scan out of the empty-bucket path.
//
// Passing `index: undefined` still reaches the pre-change behaviour through that
// new `else`, so the legacy side remains a faithful stand-in for the one
// function — but it is a stand-in built out of the code under test. The `..`
// guard, the PSR-4 prefix loop, `allFiles.has`, the `nsDir` computation and the
// `suffixResolve` call are LITERALLY SHARED with the current side, so an edit to
// any of them moves both sides identically and `expect(current).toBe(legacy)`
// stays green. That is a real weakness of importing rather than copying, and it
// is why every hand case below also pins absolute literals: the differential
// proves the index hoist preserved behaviour, the literals prove the behaviour
// being preserved is the one the case is named for.

function legacyNormalizePhpPath(value: string): string {
  return value.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '');
}

function legacyNamespaceDirectories(
  targetRaw: string,
  composerConfig: ComposerConfig | null,
  resolved: string | null,
): string[] {
  const directories = new Set<string>();
  if (resolved !== null) {
    const normalizedResolved = legacyNormalizePhpPath(resolved);
    const separator = normalizedResolved.lastIndexOf('/');
    if (separator >= 0) directories.add(normalizedResolved.slice(0, separator));
  }

  if (composerConfig === null) return [...directories];

  const normalizedTarget = legacyNormalizePhpPath(targetRaw);
  const mappings = [...composerConfig.psr4.entries()].sort((left, right) => {
    const lengthDifference = right[0].length - left[0].length;
    return lengthDifference !== 0 ? lengthDifference : left[0].localeCompare(right[0]);
  });
  for (const [namespacePrefix, directoryPrefix] of mappings) {
    const normalizedPrefix = legacyNormalizePhpPath(namespacePrefix);
    if (
      normalizedTarget !== normalizedPrefix &&
      !normalizedTarget.startsWith(`${normalizedPrefix}/`)
    ) {
      continue;
    }

    const remainder = normalizedTarget.slice(normalizedPrefix.length).replace(/^\//, '');
    const separator = remainder.lastIndexOf('/');
    const relativeNamespace = separator >= 0 ? remainder.slice(0, separator) : '';
    directories.add(
      legacyNormalizePhpPath(
        relativeNamespace === '' ? directoryPrefix : `${directoryPrefix}/${relativeNamespace}`,
      ),
    );
    break;
  }
  return [...directories];
}

const legacyPhpDirectoryIndexCache = new WeakMap<
  readonly ParsedFile[],
  ReadonlyMap<string, readonly ParsedFile[]>
>();

function legacyParentDirectory(filePath: string): string {
  const normalizedPath = legacyNormalizePhpPath(filePath);
  const separator = normalizedPath.lastIndexOf('/');
  return separator < 0 ? '' : normalizedPath.slice(0, separator);
}

function legacyDirectoryAliases(filePath: string): string[] {
  const normalizedPath = legacyNormalizePhpPath(filePath);
  const separator = normalizedPath.lastIndexOf('/');
  if (separator < 0) return [''];

  const parent = normalizedPath.slice(0, separator);
  const aliases = new Set([parent]);
  const segments = parent.split('/').filter(Boolean);
  for (let index = 0; index < segments.length; index++) {
    aliases.add(segments.slice(index).join('/'));
  }
  return [...aliases];
}

function legacyFilesByDirectory(
  parsedFiles: readonly ParsedFile[],
): ReadonlyMap<string, readonly ParsedFile[]> {
  const cached = legacyPhpDirectoryIndexCache.get(parsedFiles);
  if (cached) return cached;

  const mutable = new Map<string, ParsedFile[]>();
  for (const parsed of parsedFiles) {
    for (const directory of legacyDirectoryAliases(parsed.filePath)) {
      const files = mutable.get(directory) ?? [];
      files.push(parsed);
      mutable.set(directory, files);
    }
  }
  legacyPhpDirectoryIndexCache.set(parsedFiles, mutable);
  return mutable;
}

function legacyResolvePhpImportTarget(
  parsedImport: ParsedImport,
  workspaceIndex: WorkspaceIndex,
): string | null {
  // The shipped adapter spells this guard `ctx === undefined || ...`; CodeQL
  // flags that as a comparison between inconvertible types (`WorkspaceIndex` is
  // an object type, never `undefined`). Optional chaining is the same guard at
  // runtime — an undefined index still fails the `typeof` test and returns null
  // — so the copy stays behaviourally verbatim.
  const ctx = workspaceIndex as PhpResolveContext;
  if (
    typeof (workspaceIndex as { fromFile?: unknown } | undefined)?.fromFile !== 'string' ||
    !((workspaceIndex as { allFilePaths?: unknown } | undefined)?.allFilePaths instanceof Set)
  ) {
    return null;
  }
  if (parsedImport.kind === 'dynamic-unresolved') return null;
  if (parsedImport.targetRaw === null || parsedImport.targetRaw === '') return null;

  const allFiles = ctx.allFilePaths as Set<string>;
  const normalizedFileList = [...allFiles].map((f) => f.replace(/\\/g, '/'));
  const allFileList = [...allFiles];

  return resolvePhpImportInternal(
    parsedImport.targetRaw,
    null, // composerConfig not available through LanguageProvider path
    allFiles,
    normalizedFileList,
    allFileList,
    undefined,
  );
}

function legacyResolvePhpImportTargetInternal(
  targetRaw: string,
  _fromFile: string,
  allFilePaths: ReadonlySet<string>,
  resolutionConfig?: unknown,
  context?: ImportResolutionContext,
): string | null {
  if (targetRaw === '') return null;

  const composerConfig =
    resolutionConfig !== undefined && resolutionConfig !== null
      ? (resolutionConfig as ComposerConfig)
      : null;

  const allFiles = allFilePaths as Set<string>;
  const normalizedFileList = [...allFiles].map((f) => f.replace(/\\/g, '/'));
  const allFileList = [...allFiles];

  const resolved = resolvePhpImportInternal(
    targetRaw,
    composerConfig,
    allFiles,
    normalizedFileList,
    allFileList,
    undefined,
  );

  const parsedImport = context?.parsedImport;
  const symbolKind =
    parsedImport?.kind === 'named' || parsedImport?.kind === 'alias'
      ? parsedImport.importedSymbolKind
      : undefined;
  if (
    context === undefined ||
    parsedImport === undefined ||
    (symbolKind !== 'function' && symbolKind !== 'const')
  ) {
    return resolved;
  }

  const importedName = targetRaw.replace(/\\/g, '/').split('/').filter(Boolean).at(-1);
  if (importedName === undefined) return resolved;

  const directories = legacyNamespaceDirectories(targetRaw, composerConfig, resolved);
  const directoryIndex = legacyFilesByDirectory(context.parsedFiles);
  const candidateFiles = [
    ...new Set(
      directories.flatMap((directory) => {
        const files = directoryIndex.get(legacyNormalizePhpPath(directory)) ?? [];
        const distinctParents = new Set(files.map((file) => legacyParentDirectory(file.filePath)));
        return distinctParents.size > 1 ? [] : files;
      }),
    ),
  ];
  const expectedType = symbolKind === 'function' ? 'Function' : 'Variable';
  const declaringFiles = candidateFiles.filter((parsed) =>
    parsed.localDefs.some((def) => {
      if (def.type !== expectedType) return false;
      const simpleName = (def.qualifiedName ?? '').split(/[\\.]/).at(-1);
      return simpleName === importedName;
    }),
  );

  if (declaringFiles.length > 1) return null;
  if (declaringFiles.length === 1) return declaringFiles[0].filePath;

  if (symbolKind === 'const' && candidateFiles.length === 1) return candidateFiles[0].filePath;
  return resolved;
}

// ─── fixtures ────────────────────────────────────────────────────────────────

/**
 * One differential case. `files` is emitted in the listed order and that order
 * is the tie-break under test, so cases that exist to pin a tie appear twice
 * with the order reversed rather than relying on one arrangement.
 */
interface Case {
  readonly name: string;
  readonly files: readonly string[];
  readonly target: string;
  readonly composer?: ComposerConfig;
  readonly parsedImport?: ParsedImport;
  readonly defs?: ReadonlyMap<string, readonly [SymbolDefinition['type'], string][]>;
}

/**
 * A hand case plus the two literals it must produce. Required, not optional:
 * the generated sweep is a pure differential by design, but a hand case exists
 * to pin one named behaviour and cannot do that without saying what it is.
 */
interface HandCase extends Case {
  /**
   * What the ScopeResolver adapter (`resolvePhpImportTargetInternal`) returns.
   * That is the path with `composerConfig` and the function/const declaration
   * leg, so it is the one PSR-4 and `context` actually reach.
   */
  readonly expected: string | null;
  /**
   * What the LanguageProvider adapter (`resolvePhpImportTarget`) returns. It
   * hard-codes `composerConfig: null` and takes no `ImportResolutionContext`,
   * so for every case carrying a `composer` or a `parsedImport` this is the
   * plain `suffixResolve` answer and differs from `expected`.
   */
  readonly expectedViaWorkspace: string | null;
}

function composer(entries: readonly (readonly [string, string])[]): ComposerConfig {
  return { psr4: new Map(entries) };
}

function definition(
  filePath: string,
  type: SymbolDefinition['type'],
  name: string,
): SymbolDefinition {
  return { nodeId: `def:${filePath}:${type}:${name}`, filePath, type, qualifiedName: name };
}

function parsedFilesFor(testCase: Case): readonly ParsedFile[] {
  return testCase.files.map(
    (filePath) =>
      ({
        filePath,
        localDefs: (testCase.defs?.get(filePath) ?? []).map(([type, name]) =>
          definition(filePath, type, name),
        ),
      }) as ParsedFile,
  );
}

function namedImport(
  targetRaw: string,
  kind: 'function' | 'const' | 'class',
  localName: string,
): ParsedImport {
  return {
    kind: 'named',
    localName,
    importedName: localName,
    targetRaw,
    importedSymbolKind: kind,
  } as ParsedImport;
}

const APP_PSR4 = composer([['App', 'app']]);
const SRC_PSR4 = composer([['App', 'src']]);
const NESTED_PSR4 = composer([
  ['App', 'app'],
  ['App\\Models', 'app/Domain'],
]);
const ROOT_PSR4 = composer([['App', '']]);
const TRAILING_SLASH_PSR4 = composer([['App', 'app/']]);

/**
 * A deterministic multi-root workspace. Every root carries the same relative
 * layout so that a suffix-keyed lookup and a root-anchored scan disagree about
 * which root wins, and `Vendor`/`vendor` differ only in case.
 */
function generatedFiles(): string[] {
  const files: string[] = [];
  for (let i = 0; i < 12; i++) {
    files.push(`vendor/pkg${i % 3}/app/Models/Entity${i}.php`);
    files.push(`app/Models/Entity${i}.php`);
    files.push(`app/Services/Service${i}.php`);
    files.push(`src/App/Legacy/Entity${i}.php`);
    files.push(`APP/models/entity${i}.php`);
    files.push(`Entity${i}.php`);
    files.push(`app/Helpers/helpers${i}.phtml`);
    files.push(`packages/mod${i}/src/Widget.php`);
    files.push(`app\\Windows\\Entity${i}.php`);
  }
  files.push('index.php');
  files.push('app/Models/User.php');
  files.push('app/Models/functions.php');
  files.push('app/Config/constants.php');
  return files;
}

const GENERATED_FILES = generatedFiles();

/** Targets swept across `GENERATED_FILES`: hits, near-misses and full misses. */
function generatedTargets(): string[] {
  const targets: string[] = [];
  for (let i = 0; i < 12; i++) {
    targets.push(`App\\Models\\Entity${i}`);
    targets.push(`app\\models\\entity${i}`);
    targets.push(`Entity${i}`);
    targets.push(`Models\\Entity${i}`);
    targets.push(`App\\Legacy\\Entity${i}`);
    targets.push(`App\\Services\\Service${i}`);
    targets.push(`Widget`);
    targets.push(`Symfony\\Component\\Console\\Command${i}`);
    targets.push(`App\\Models\\helper${i}`);
    targets.push(`\\App\\Models\\Entity${i}`);
    targets.push(`App/Models/Entity${i}`);
  }
  targets.push('index');
  targets.push('App\\Models\\User');
  targets.push('..\\App\\Models\\User');
  targets.push('App');
  return targets;
}

const GENERATED_CASES: readonly Case[] = generatedTargets().flatMap((target) =>
  [undefined, APP_PSR4, SRC_PSR4, NESTED_PSR4, ROOT_PSR4, TRAILING_SLASH_PSR4].map(
    (config, configIndex) => ({
      name: `generated ${target} · composer#${configIndex}`,
      files: GENERATED_FILES,
      target,
      composer: config,
    }),
  ),
);

/**
 * Hand-built cases, one per tie-break the index could have moved.
 *
 * Every `expected` / `expectedViaWorkspace` below was derived by hand from
 * `resolvePhpImportInternal` + `suffixResolve` and then confirmed against both
 * implementations. Two rules do most of the work and are worth stating once:
 *
 *  - `suffixResolve`'s PATH-PART loop is OUTER and its EXTENSION loop is inner,
 *    so a longer suffix always beats a shorter one no matter which extensions
 *    are involved; within one path-part it is first-in-Set-order and
 *    case-INSENSITIVE (the scan's `endsWith(p)` disjunct is subsumed by its
 *    `toLowerCase().endsWith(...)` one).
 *  - the PSR-4 namespace-directory fallback is NOT gated on the imported symbol
 *    kind. It fires for a class import too, whenever the class-style path
 *    misses, and returns the FIRST `.php` file directly in the namespace
 *    directory — see the "known limitation" note atop `import-resolvers/php.ts`.
 *    Cases that lean on it are marked; their answers are order-dependent in
 *    general and deterministic here only because the fixture pins the order.
 */
const HAND_CASES: readonly HandCase[] = [
  // ── divergence 3: whole-path vs proper suffix ────────────────────────────
  {
    // `Foo.php` IS the suffix, not a file carrying it, and `endsWith('/Foo.php')`
    // can only match a PROPER suffix. Unresolvable — the behaviour the parity
    // view exists to preserve.
    name: 'root-level file is not a proper suffix of itself',
    files: ['Foo.php', 'src/Bar.php'],
    target: 'Foo',
    expected: null,
    expectedViaWorkspace: null,
  },
  {
    // `App/Models/User.php` is invisible at path-part 0 (whole path), so both
    // files compete at part 1 on `/Models/User.php` and Set order decides.
    name: 'whole-path match loses to an earlier proper-suffix match',
    files: ['vendor/x/Models/User.php', 'App/Models/User.php'],
    target: 'App\\Models\\User',
    expected: 'vendor/x/Models/User.php',
    expectedViaWorkspace: 'vendor/x/Models/User.php',
  },
  {
    name: 'whole-path match loses to a later proper-suffix match too',
    files: ['App/Models/User.php', 'vendor/x/Models/User.php'],
    target: 'App\\Models\\User',
    expected: 'App/Models/User.php',
    expectedViaWorkspace: 'App/Models/User.php',
  },
  {
    // Still not found as a whole path — found at part 1, as `Models/User.php`.
    name: 'whole path is the only candidate at all',
    files: ['App/Models/User.php'],
    target: 'App\\Models\\User',
    expected: 'App/Models/User.php',
    expectedViaWorkspace: 'App/Models/User.php',
  },
  {
    // A whole-path candidate the scan must skip, plus TWO proper-suffix
    // candidates behind it — so the skip has to land on the first of them and
    // not merely on "some other file". Both are hit at path-part 0.
    name: 'whole-path match skipped, first of several proper-suffix matches wins',
    files: ['App/Models/User.php', 'one/App/Models/User.php', 'two/App/Models/User.php'],
    target: 'App\\Models\\User',
    expected: 'one/App/Models/User.php',
    expectedViaWorkspace: 'one/App/Models/User.php',
  },
  {
    name: 'whole-path match skipped, first of several proper-suffix matches wins, reversed',
    files: ['two/App/Models/User.php', 'App/Models/User.php', 'one/App/Models/User.php'],
    target: 'App\\Models\\User',
    expected: 'two/App/Models/User.php',
    expectedViaWorkspace: 'two/App/Models/User.php',
  },
  {
    name: 'root-level file with a namespace-shaped import',
    files: ['index.php', 'Kernel.php'],
    target: 'Kernel',
    expected: null,
    expectedViaWorkspace: null,
  },
  // ── divergence 3: case-sensitive hit must not outrank an earlier ci hit ──
  {
    // `a/FOO.php` matches `/Foo.php` case-insensitively and comes first, so the
    // exact-case `b/Foo.php` behind it never gets a turn.
    name: 'lowercase file first, exact-case file second',
    files: ['a/FOO.php', 'b/Foo.php'],
    target: 'Foo',
    expected: 'a/FOO.php',
    expectedViaWorkspace: 'a/FOO.php',
  },
  {
    name: 'exact-case file first, lowercase file second',
    files: ['b/Foo.php', 'a/FOO.php'],
    target: 'Foo',
    expected: 'b/Foo.php',
    expectedViaWorkspace: 'b/Foo.php',
  },
  {
    name: 'case tie across a multi-segment suffix',
    files: ['vendor/x/models/user.php', 'app/Models/User.php'],
    target: 'Models\\User',
    expected: 'vendor/x/models/user.php',
    expectedViaWorkspace: 'vendor/x/models/user.php',
  },
  {
    name: 'case tie across a multi-segment suffix, reversed',
    files: ['app/Models/User.php', 'vendor/x/models/user.php'],
    target: 'Models\\User',
    expected: 'app/Models/User.php',
    expectedViaWorkspace: 'app/Models/User.php',
  },
  // ── divergence 1: PSR-4 class-style is an exact whole-path test ──────────
  {
    // The only case in this group that the class-style `allFiles.has` leg
    // actually answers: `App\Models\User` + `App => app` is exactly
    // `app/Models/User.php`. Everything below it misses that leg and falls
    // through, which is what makes the group interesting.
    name: 'psr-4 exact hit',
    files: ['app/Models/User.php'],
    target: 'App\\Models\\User',
    composer: APP_PSR4,
    expected: 'app/Models/User.php',
    // No composer on this path, so it comes from `/Models/User.php` at part 1.
    expectedViaWorkspace: 'app/Models/User.php',
  },
  {
    // PSR-4 is case-sensitive by spec, so the exact leg correctly misses
    // `app/models/user.php`, the namespace directory `app/Models` does not
    // exist either, and the answer comes from the case-INSENSITIVE suffix
    // fallback. Loose, but it is the shipped behaviour and predates #2901.
    name: 'psr-4 target differs from the file only by case',
    files: ['app/models/user.php'],
    target: 'App\\Models\\User',
    composer: APP_PSR4,
    expected: 'app/models/user.php',
    expectedViaWorkspace: 'app/models/user.php',
  },
  {
    // KNOWN LIMITATION: the class-style path `src/Models/User.php` misses, and
    // the namespace-directory fallback then answers a CLASS import with "first
    // `.php` in `src/Models/`" — here `src/Models/user.php`, which is only
    // coincidentally the right file. `other/Models/User.php` is never reached.
    name: 'psr-4 mapped dir differs from the namespace, file differs by case',
    files: ['src/Models/user.php', 'other/Models/User.php'],
    target: 'App\\Models\\User',
    composer: SRC_PSR4,
    expected: 'src/Models/user.php',
    expectedViaWorkspace: 'src/Models/user.php',
  },
  {
    // `src/Models/` does not exist at the repo root, so the root-anchored
    // directory bucket is empty and the suffix leg finds the vendor copy at
    // path-part 1. A directory index keyed on suffixes would have answered it
    // one leg earlier — same file here, different file in the case below.
    name: 'psr-4 mapped dir exists only under vendor, by case-insensitive suffix',
    files: ['vendor/pkg/src/Models/User.php'],
    target: 'App\\Models\\User',
    composer: SRC_PSR4,
    expected: 'vendor/pkg/src/Models/User.php',
    expectedViaWorkspace: 'vendor/pkg/src/Models/User.php',
  },
  {
    // The mapped directory (`src/lib`) shares no segment with the namespace
    // (`App`), so the class-style probe and the `suffixResolve` fallback name
    // two DIFFERENT files. Only the exact-`has` leg is supposed to see the
    // first one; the raw index's case-insensitive suffix probe reaches it.
    // Correct answer: the suffix leg's `other/Models/User.php`, first in order.
    name: 'psr-4 mapped dir path and namespace path name different files',
    files: ['other/Models/User.php', 'vendor/one/src/lib/Models/user.php'],
    target: 'App\\Models\\User',
    composer: composer([['App', 'src/lib']]),
    expected: 'other/Models/User.php',
    expectedViaWorkspace: 'other/Models/User.php',
  },
  {
    name: 'psr-4 mapped dir path and namespace path name different files, reversed',
    files: ['vendor/one/src/lib/Models/user.php', 'other/Models/User.php'],
    target: 'App\\Models\\User',
    composer: composer([['App', 'src/lib']]),
    expected: 'vendor/one/src/lib/Models/user.php',
    expectedViaWorkspace: 'vendor/one/src/lib/Models/user.php',
  },
  {
    // `App\Models => app/Domain` sorts before `App => app` (longer key), so the
    // class-style leg hits `app/Domain/User.php` and never considers
    // `app/Models/User.php`. The two adapters legitimately disagree here: with
    // no composer there is no longest-prefix rule and the suffix leg answers
    // `/Models/User.php` instead.
    name: 'psr-4 longest-prefix mapping wins',
    files: ['app/Domain/User.php', 'app/Models/User.php'],
    target: 'App\\Models\\User',
    composer: NESTED_PSR4,
    expected: 'app/Domain/User.php',
    expectedViaWorkspace: 'app/Models/User.php',
  },
  {
    // KNOWN LIMITATION: an empty `dirPrefix` builds the class-style path as
    // `'' + '/Models/User' + '.php'` = `/Models/User.php`, with a leading slash
    // no repo-relative path has — so a root PSR-4 mapping never hits that leg,
    // and `nsDir` comes out `/Models` which no directory bucket holds either.
    // The answer is the suffix leg's, and only at path-part 2 (`/User.php`):
    // `Models/User.php` is the whole path, invisible to `/Models/User.php`.
    name: 'psr-4 mapped to the repo root',
    files: ['Models/User.php'],
    target: 'App\\Models\\User',
    composer: ROOT_PSR4,
    expected: 'Models/User.php',
    expectedViaWorkspace: 'Models/User.php',
  },
  {
    // KNOWN LIMITATION: a mapping kept with its trailing slash concatenates to
    // `app//Models/User.php`, which misses every leg. `loadPhpComposerConfig`
    // strips trailing slashes, so production never builds this config — the
    // arm pins what happens if one ever reaches the resolver. The answer is
    // again the plain suffix leg's.
    name: 'psr-4 dir prefix carries a trailing slash',
    files: ['app/Models/User.php'],
    target: 'App\\Models\\User',
    composer: TRAILING_SLASH_PSR4,
    expected: 'app/Models/User.php',
    expectedViaWorkspace: 'app/Models/User.php',
  },
  // ── divergence 2: namespace-directory scan is root-anchored ──────────────
  {
    // The witness for divergence 2: `app/Models` is also a SUFFIX of
    // `vendor/pkg/app/Models`, and the vendor file comes first in Set order, so
    // a suffix-keyed directory index answers `vendor/pkg/app/Models/Zed.php`.
    // Root-anchored, only `app/Models/Aaa.php` is in the bucket.
    name: 'namespace dir: root-anchored candidate beats a suffix-matching vendor dir',
    files: ['vendor/pkg/app/Models/Zed.php', 'app/Models/Aaa.php'],
    target: 'App\\Models\\getUser',
    composer: APP_PSR4,
    expected: 'app/Models/Aaa.php',
    // Without composer there is no namespace-directory leg at all, and
    // `getUser` is not a file, so nothing matches.
    expectedViaWorkspace: null,
  },
  {
    // Same witness from the other side: with the root-anchored bucket empty the
    // vendor mirror is unreachable, where a suffix-keyed one would return it.
    name: 'namespace dir: only a suffix-matching vendor dir exists',
    files: ['vendor/pkg/app/Models/Zed.php'],
    target: 'App\\Models\\getUser',
    composer: APP_PSR4,
    expected: null,
    expectedViaWorkspace: null,
  },
  {
    // KNOWN LIMITATION, pinned rather than endorsed: "first `.php` file in the
    // namespace directory" is Set-iteration order, so `Bbb` beats the
    // alphabetically-earlier `Aaa`. Deterministic here only because the fixture
    // fixes the insertion order; in a real repo it follows the walker's.
    name: 'namespace dir: several candidates, first in order wins',
    files: ['app/Models/Bbb.php', 'app/Models/Aaa.php', 'app/Models/Ccc.php'],
    target: 'App\\Models\\getUser',
    composer: APP_PSR4,
    expected: 'app/Models/Bbb.php',
    expectedViaWorkspace: null,
  },
  {
    name: 'namespace dir: nested subdirectory is not a direct child',
    files: ['app/Models/Nested/Deep.php'],
    target: 'App\\Models\\getUser',
    composer: APP_PSR4,
    expected: null,
    expectedViaWorkspace: null,
  },
  {
    name: 'namespace dir: non-php sibling is skipped',
    files: ['app/Models/notes.md', 'app/Models/Aaa.php'],
    target: 'App\\Models\\getUser',
    composer: APP_PSR4,
    expected: 'app/Models/Aaa.php',
    expectedViaWorkspace: null,
  },
  {
    // KNOWN LIMITATION, the multi-segment half of the trailing-slash bug: the
    // remainder `Models/getUser` has a separator, so `nsDir` is built as
    // `'app/' + '/' + 'Models'` = `app//Models` and matches no directory. Not
    // reachable from a parsed `composer.json` (trailing slashes are stripped).
    name: 'namespace dir with a trailing-slash mapping',
    files: ['app/Models/Aaa.php'],
    target: 'App\\Models\\getUser',
    composer: TRAILING_SLASH_PSR4,
    expected: null,
    expectedViaWorkspace: null,
  },
  {
    // `nsDir` keeps the mapping's trailing slash when the remainder has no
    // separator, so the directory bucket must be keyed without it. `nsDir` is
    // `app/` here, and `app/bootstrap.php` is its only direct `.php` child —
    // `app/Models/User.php` lives one level down.
    name: 'namespace dir IS the trailing-slash mapping',
    files: ['app/bootstrap.php', 'app/Models/User.php'],
    target: 'App\\getUser',
    composer: TRAILING_SLASH_PSR4,
    expected: 'app/bootstrap.php',
    expectedViaWorkspace: null,
  },
  {
    // KNOWN LIMITATION: with `App => ''` the namespace directory is the repo
    // root, and neither the bucket (built from `lastIndexOf('/')`, so root files
    // are in no directory) nor the scan it mirrors (`startsWith('/')`) can see
    // `User.php`. A root-mapped function import is unresolvable.
    name: 'namespace dir at the repo root',
    files: ['User.php', 'nested/Other.php'],
    target: 'App\\getUser',
    composer: ROOT_PSR4,
    expected: null,
    expectedViaWorkspace: null,
  },
  // ── raw vs normalized paths ──────────────────────────────────────────────
  {
    // Matched on the normalized path, returned RAW.
    name: 'backslash file paths',
    files: ['src\\App\\Models\\User.php'],
    target: 'App\\Models\\User',
    expected: 'src\\App\\Models\\User.php',
    expectedViaWorkspace: 'src\\App\\Models\\User.php',
  },
  {
    // `allFiles.has('app/Models/User.php')` is a miss (the Set holds the
    // backslash spelling) and the directory bucket is keyed on raw paths, which
    // have no `/` at all — so only the normalized suffix leg can answer.
    name: 'backslash file paths under a psr-4 mapping',
    files: ['app\\Models\\User.php'],
    target: 'App\\Models\\User',
    composer: APP_PSR4,
    expected: 'app\\Models\\User.php',
    expectedViaWorkspace: 'app\\Models\\User.php',
  },
  {
    // Same, minus a suffix leg that can match: `getUser` is not a file.
    name: 'backslash namespace dir candidate',
    files: ['app\\Models\\Aaa.php'],
    target: 'App\\Models\\getUser',
    composer: APP_PSR4,
    expected: null,
    expectedViaWorkspace: null,
  },
  // ── extension order and misses ───────────────────────────────────────────
  {
    name: 'extension order: .php before .phtml at the same depth',
    files: ['x/User.phtml', 'y/User.php'],
    target: 'User',
    expected: 'y/User.php',
    expectedViaWorkspace: 'y/User.php',
  },
  {
    // The path-part loop is OUTER, so the full `App/Models/User` + `.php` is
    // tried before any extension is tried against the bare `User` — the `.ts`
    // file never gets a turn even though `.ts` precedes `.php` in `EXTENSIONS`.
    // (Renamed: the old name, "a .ts file shadows a deeper .php file", claimed
    // the opposite of what this resolves to. Writing the literal down is what
    // surfaced that.)
    name: 'extension order: the outer path-part loop beats the inner extension list',
    files: ['x/User.ts', 'y/App/Models/User.php'],
    target: 'App\\Models\\User',
    expected: 'y/App/Models/User.php',
    expectedViaWorkspace: 'y/App/Models/User.php',
  },
  {
    name: 'plain miss',
    files: ['src/App/Models/User.php'],
    target: 'Other\\Thing',
    expected: null,
    expectedViaWorkspace: null,
  },
  {
    // Refused by `if (normalized.includes('..')) return null` before any index
    // is consulted. Without that guard the suffix leg resolves this to
    // `app/Models/User.php` at path-part 1 — on BOTH sides, so the literal is
    // the only assertion here that can see the guard disappear.
    name: 'path traversal is rejected',
    files: ['app/Models/User.php'],
    target: '..\\Models\\User',
    expected: null,
    expectedViaWorkspace: null,
  },
  {
    name: 'empty file set',
    files: [],
    target: 'App\\Models\\User',
    composer: APP_PSR4,
    expected: null,
    expectedViaWorkspace: null,
  },
  {
    name: 'single-segment miss',
    files: ['app/Models/User.php'],
    target: 'Nope',
    expected: null,
    expectedViaWorkspace: null,
  },
  // ── function / const leg (context-driven) ────────────────────────────────
  //
  // Only the ScopeResolver adapter takes an `ImportResolutionContext`, so
  // `expectedViaWorkspace` is the no-composer suffix answer throughout — `null`
  // for every one of them, because a symbol name is not a file name.
  {
    // The namespace-directory leg answers `app/Models/User.php` (first in the
    // bucket, and the wrong file); the declaration search then overrides it with
    // the file that actually declares `getUser`. That override is the whole
    // point of the leg, so pinning the literal is what proves it ran.
    name: 'function import with a unique declaration',
    files: ['app/Models/User.php', 'app/Models/UserFactory.php'],
    target: 'App\\Models\\getUser',
    composer: APP_PSR4,
    parsedImport: namedImport('App\\Models\\getUser', 'function', 'getUser'),
    defs: new Map([
      ['app/Models/User.php', [['Class', 'User'] as const]],
      ['app/Models/UserFactory.php', [['Function', 'getUser'] as const]],
    ]),
    expected: 'app/Models/UserFactory.php',
    expectedViaWorkspace: null,
  },
  {
    // Two declarations of the same name: `declaringFiles.length > 1` returns
    // null outright, rather than falling back to the namespace-directory answer.
    name: 'function import with duplicate declarations fails closed',
    files: ['app/Models/First.php', 'app/Models/Second.php'],
    target: 'App\\Models\\getUser',
    composer: APP_PSR4,
    parsedImport: namedImport('App\\Models\\getUser', 'function', 'getUser'),
    defs: new Map([
      ['app/Models/First.php', [['Function', 'getUser'] as const]],
      ['app/Models/Second.php', [['Function', 'getUser'] as const]],
    ]),
    expected: null,
    expectedViaWorkspace: null,
  },
  {
    // KNOWN LIMITATION: the `app/Models` directory ALIAS spans two roots, so
    // `distinctParents.size > 1` empties the candidate list and the leg falls
    // back to `resolved` — `app/Models/functions.php`, which does NOT declare
    // `getUser`. The file that does (`vendor/pkg/app/Models/helpers.php`) is
    // never returned. Failing closed here means "keep the composer answer",
    // not "return null".
    name: 'function import across suffix-colliding roots',
    files: ['app/Models/functions.php', 'vendor/pkg/app/Models/helpers.php'],
    target: 'App\\Models\\getUser',
    composer: APP_PSR4,
    parsedImport: namedImport('App\\Models\\getUser', 'function', 'getUser'),
    defs: new Map([['vendor/pkg/app/Models/helpers.php', [['Function', 'getUser'] as const]]]),
    expected: 'app/Models/functions.php',
    expectedViaWorkspace: null,
  },
  {
    // PHP constants are not emitted as local definitions, so `declaringFiles` is
    // always empty and the single-candidate rule decides.
    name: 'const import with a single candidate file',
    files: ['app/Config/constants.php'],
    target: 'App\\Config\\MAX_USERS',
    composer: APP_PSR4,
    parsedImport: namedImport('App\\Config\\MAX_USERS', 'const', 'MAX_USERS'),
    defs: new Map(),
    expected: 'app/Config/constants.php',
    expectedViaWorkspace: null,
  },
  {
    // KNOWN LIMITATION: the single-candidate rule declines, but the fallback is
    // `resolved` — itself "first `.php` in `app/Config/`", i.e. the same Set
    // order the rule is documented as refusing to inherit. Declining changes
    // which code picks the file, not whether order picks it.
    name: 'const import with several candidate files',
    files: ['app/Config/constants.php', 'app/Config/more.php'],
    target: 'App\\Config\\MAX_USERS',
    composer: APP_PSR4,
    parsedImport: namedImport('App\\Config\\MAX_USERS', 'const', 'MAX_USERS'),
    defs: new Map(),
    expected: 'app/Config/constants.php',
    expectedViaWorkspace: null,
  },
  {
    // `importedSymbolKind: 'class'` returns before the declaration leg, so this
    // is the plain PSR-4 class-style hit — and the one context-carrying case
    // whose LanguageProvider answer is not null.
    name: 'class import ignores the declaration leg',
    files: ['app/Models/User.php'],
    target: 'App\\Models\\User',
    composer: APP_PSR4,
    parsedImport: namedImport('App\\Models\\User', 'class', 'User'),
    defs: new Map([['app/Models/User.php', [['Class', 'User'] as const]]]),
    expected: 'app/Models/User.php',
    expectedViaWorkspace: 'app/Models/User.php',
  },
];

function runBoth(testCase: Case): {
  readonly legacy: string | null;
  readonly current: string | null;
} {
  const legacyFiles = new Set(testCase.files);
  const currentFiles = new Set(testCase.files);
  const parsedFiles = parsedFilesFor(testCase);
  const context: ImportResolutionContext | undefined =
    testCase.parsedImport === undefined
      ? undefined
      : { parsedFiles, parsedImport: testCase.parsedImport };

  return {
    legacy: legacyResolvePhpImportTargetInternal(
      testCase.target,
      'app/Main.php',
      legacyFiles,
      testCase.composer,
      context,
    ),
    current: resolvePhpImportTargetInternal(
      testCase.target,
      'app/Main.php',
      currentFiles,
      testCase.composer,
      context,
    ),
  };
}

function runBothWorkspaceAdapter(testCase: Case): {
  readonly legacy: string | null;
  readonly current: string | null;
} {
  const parsedImport = testCase.parsedImport ?? namedImport(testCase.target, 'class', 'Imported');
  const legacyIndex: PhpResolveContext = {
    fromFile: 'app/Main.php',
    allFilePaths: new Set(testCase.files),
  };
  const currentIndex: PhpResolveContext = {
    fromFile: 'app/Main.php',
    allFilePaths: new Set(testCase.files),
  };
  return {
    legacy: legacyResolvePhpImportTarget(parsedImport, legacyIndex as WorkspaceIndex),
    current: resolvePhpImportTarget(parsedImport, currentIndex as WorkspaceIndex),
  };
}

// ─── the differential ────────────────────────────────────────────────────────

describe('PHP import-target parity with the pre-index implementation (#2901)', () => {
  // Three assertions per arm, and each answers a different question.
  // `current === legacy` proves the index hoist behaviour-preserving, but it
  // is blind to every line the two sides SHARE — including all of
  // `resolvePhpImportInternal`, which is imported rather than copied. Pinning
  // the literal on both sides is what makes the arm able to fail on a change
  // there, and what says the case still exercises the behaviour it is named
  // for rather than having decayed into `null === null`.
  it.each(HAND_CASES.map((testCase) => [testCase.name, testCase] as const))(
    'ScopeResolver adapter agrees: %s',
    (_name, testCase) => {
      const { legacy, current } = runBoth(testCase);
      expect(legacy).toBe(testCase.expected);
      expect(current).toBe(testCase.expected);
      expect(current).toBe(legacy);
    },
  );

  it.each(HAND_CASES.map((testCase) => [testCase.name, testCase] as const))(
    'LanguageProvider adapter agrees: %s',
    (_name, testCase) => {
      const { legacy, current } = runBothWorkspaceAdapter(testCase);
      expect(legacy).toBe(testCase.expectedViaWorkspace);
      expect(current).toBe(testCase.expectedViaWorkspace);
      expect(current).toBe(legacy);
    },
  );

  /**
   * Non-vacuity, the way the Java and COBOL harnesses state it: a table of
   * literals is only a specification if enough of them are real paths. 32 of
   * the 86 arms above legitimately expect `null` (a resolver miss is a real
   * answer and must be pinned like any other), so this fixes the balance rather
   * than letting a corpus that quietly stopped matching pass as one that never
   * matched.
   */
  it('the hand corpus pins real paths, not only misses', () => {
    const scopeHits = HAND_CASES.filter((testCase) => testCase.expected !== null);
    const workspaceHits = HAND_CASES.filter((testCase) => testCase.expectedViaWorkspace !== null);
    const distinct = new Set([
      ...scopeHits.map((testCase) => testCase.expected),
      ...workspaceHits.map((testCase) => testCase.expectedViaWorkspace),
    ]);

    expect(scopeHits.length).toBe(31);
    expect(workspaceHits.length).toBe(23);
    expect(distinct.size).toBeGreaterThan(20);
    // The two adapters must not be the same assertion twice: `composer` and
    // `context` are visible only through the ScopeResolver one.
    expect(
      HAND_CASES.filter((testCase) => testCase.expected !== testCase.expectedViaWorkspace).length,
    ).toBe(9);
  });

  it('agrees on every generated target × composer configuration', () => {
    const disagreements = GENERATED_CASES.filter((testCase) => {
      const { legacy, current } = runBoth(testCase);
      return legacy !== current;
    }).map((testCase) => testCase.name);

    expect(disagreements).toEqual([]);
  });

  it('agrees on every generated target through the LanguageProvider adapter', () => {
    const disagreements = GENERATED_CASES.filter((testCase) => {
      const { legacy, current } = runBothWorkspaceAdapter(testCase);
      return legacy !== current;
    }).map((testCase) => testCase.name);

    expect(disagreements).toEqual([]);
  });

  /**
   * The corpus is only a specification if it actually exercises the three
   * divergences. Each of these resolves to a DIFFERENT file (or from null to a
   * file) when `resolvePhpImportInternal` is handed the raw shared index
   * instead of the parity view, so a future edit that quietly drops one of the
   * corrections cannot pass the arms above by also deleting its witness.
   */
  it('the corpus contains a witness for each of the three divergences', () => {
    const witnesses = [
      'root-level file is not a proper suffix of itself',
      'whole-path match loses to an earlier proper-suffix match',
      'lowercase file first, exact-case file second',
      'psr-4 mapped dir path and namespace path name different files',
      'namespace dir: root-anchored candidate beats a suffix-matching vendor dir',
      'namespace dir: only a suffix-matching vendor dir exists',
    ];
    const byName = new Map(HAND_CASES.map((testCase) => [testCase.name, testCase]));

    const notWitnessed = witnesses.filter((name) => {
      const testCase = byName.get(name);
      if (testCase === undefined) return true;
      const files = [...testCase.files];
      const normalized = files.map((file) => file.replace(/\\/g, '/'));
      // The raw index — exactly what a "just pass getWorkspaceFileIndex().index
      // through" fix would have handed the resolver.
      const rawIndexResult = resolvePhpImportInternal(
        testCase.target,
        testCase.composer ?? null,
        new Set(files),
        normalized,
        files,
        buildSuffixIndex(normalized, files),
      );
      return rawIndexResult === runBoth(testCase).legacy;
    });

    expect(notWitnessed).toEqual([]);
  });

  it('resolves real PHP imports (the differential is not vacuous)', () => {
    const files = new Set([
      'app/Models/User.php',
      'app/Services/UserService.php',
      'app/Models/functions.php',
    ]);

    expect(
      resolvePhpImportTargetInternal('App\\Models\\User', 'app/Main.php', files, APP_PSR4),
    ).toBe('app/Models/User.php');
    expect(
      resolvePhpImportTargetInternal('App\\Services\\UserService', 'app/Main.php', files, APP_PSR4),
    ).toBe('app/Services/UserService.php');
    expect(
      resolvePhpImportTargetInternal('Nope\\Missing', 'app/Main.php', files, APP_PSR4),
    ).toBeNull();
  });
});

// ─── index reuse at the resolver level ───────────────────────────────────────

describe('PHP import-target index reuse (#2901)', () => {
  /**
   * Counts iterations of the file-set Set. This is the resolver-level half of
   * the guard — a rescan reintroduced INSIDE the resolver. The adapter-level
   * copy hazard is `test/integration/php-import-index-reuse.test.ts`.
   */
  it('iterates the file set once for many imports with no composer.json', () => {
    const files = new CountingSet(GENERATED_FILES);
    const results: (string | null)[] = [];

    for (const target of generatedTargets()) {
      results.push(resolvePhpImportTargetInternal(target, 'app/Main.php', files, undefined));
    }

    expect(files.scans).toBe(1);
    // No composer.json, so this is pure `suffixResolve`: the earliest file in
    // Set order carrying `App/Models/Entity0.php` as a proper suffix wins, and
    // the corpus deliberately puts the vendor mirror first.
    expect(results[0]).toBe('vendor/pkg0/app/Models/Entity0.php');
    expect(results.some((result) => result === null)).toBe(true);
  });

  it('iterates the file set once for many PSR-4 imports', () => {
    const files = new CountingSet(GENERATED_FILES);
    const results: (string | null)[] = [];

    for (let i = 0; i < 12; i++) {
      // Class-style hit (`allFiles.has`), namespace-directory fallback, and a
      // third-party namespace that matches no PSR-4 prefix — the three legs
      // that answer from the index or return before reaching one.
      results.push(
        resolvePhpImportTargetInternal(`App\\Models\\Entity${i}`, 'app/Main.php', files, APP_PSR4),
      );
      results.push(
        resolvePhpImportTargetInternal(`App\\Models\\helper${i}`, 'app/Main.php', files, APP_PSR4),
      );
      results.push(
        resolvePhpImportTargetInternal(`Psr\\Log\\Missing${i}`, 'app/Main.php', files, APP_PSR4),
      );
    }

    expect(files.scans).toBe(1);
    expect(results[0]).toBe('app/Models/Entity0.php');
    expect(results[1]).toBe('app/Models/Entity0.php');
    expect(results[2]).toBeNull();
  });

  /**
   * `nsDir` keeps a PSR-4 mapping's trailing slash, while the directory bucket
   * is keyed on the raw path's own parent (no trailing slash). Getting that
   * wrong is invisible to every result assertion — the empty bucket just falls
   * through to the scan, which returns the same file — so only the count sees
   * it.
   */
  it('answers a trailing-slash PSR-4 namespace directory from the index', () => {
    const files = new CountingSet(['app/bootstrap.php', 'app/Models/User.php']);
    const results: (string | null)[] = [];

    for (let i = 0; i < 5; i++) {
      results.push(
        resolvePhpImportTargetInternal(
          `App\\getUser${i}`,
          'app/Main.php',
          files,
          TRAILING_SLASH_PSR4,
        ),
      );
    }

    expect(files.scans).toBe(1);
    expect(results[0]).toBe('app/bootstrap.php');
  });

  /**
   * The last per-import traversal in PHP resolution, now closed.
   *
   * `resolvePhpImportInternal` used to run its namespace-directory scan
   * whenever `getFilesInDir` came back EMPTY, not merely when no index was
   * supplied — despite the comment above it saying "only when SuffixIndex
   * unavailable":
   *
   *     if (index) { const c = index.getFilesInDir(nsDir, '.php');
   *                  if (c.length > 0) return c[0]; }
   *     for (const f of allFiles) { ... }   // ran even WITH an index
   *
   * An empty bucket is the correct answer, so the scan could only ever confirm
   * it — at the cost of one full pass for every import whose namespace matches
   * a PSR-4 prefix but whose directory holds no direct `.php` child
   * (`App\Legacy\…` here: `app/Legacy/` does not exist). Measured at 11
   * traversals for 10 imports.
   *
   * The scan is now in the `else`, which is safe because the bucket is a
   * SUPERSET of what the scan can find: a root-anchored direct child
   * `nsDir/<x>.php` has its directory exactly equal to `nsDir`, and a
   * directory is always one of its own suffixes — so both the shared
   * suffix-keyed `dirMap` and this file's root-anchored parity index contain
   * it. Empty superset implies empty scan.
   *
   * The results below are unchanged by that: these imports resolve through the
   * later suffix leg, and the namespace-directory pass was pure waste.
   */
  it('no longer scans per import when the PSR-4 namespace directory is empty', () => {
    const files = new CountingSet(GENERATED_FILES);
    const results: (string | null)[] = [];

    for (let i = 0; i < 10; i++) {
      results.push(
        resolvePhpImportTargetInternal(`App\\Legacy\\Entity${i}`, 'app/Main.php', files, APP_PSR4),
      );
    }

    // One build, and nothing per import. Was `1 + 10` before the `else`.
    expect(files.scans).toBe(1);
    // Paired result assertion: a traversal count of 1 must not be the count of
    // a resolver that stopped answering. These resolve via the suffix leg.
    expect(results.every((result) => result === 'src/App/Legacy/Entity0.php')).toBe(false);
    expect(results[0]).toBe('src/App/Legacy/Entity0.php');
  });

  it('a distinct file set gets its own index', () => {
    const a = new CountingSet(['app/Models/User.php']);
    const b = new CountingSet(['lib/Other.php']);

    expect(resolvePhpImportTargetInternal('App\\Models\\User', 'app/Main.php', a, undefined)).toBe(
      'app/Models/User.php',
    );
    expect(
      resolvePhpImportTargetInternal('App\\Models\\User', 'app/Main.php', b, undefined),
    ).toBeNull();
    expect(resolvePhpImportTargetInternal('Other', 'app/Main.php', b, undefined)).toBe(
      'lib/Other.php',
    );

    expect(a.scans).toBe(1);
    expect(b.scans).toBe(1);
  });
});

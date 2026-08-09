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
// import-target.ts`. `resolvePhpImportInternal` itself is untouched by #2901,
// so it is imported rather than copied — the whole subject of this file is what
// the sixth argument does to it.

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
  const ctx = workspaceIndex as PhpResolveContext | undefined;
  if (
    ctx === undefined ||
    typeof (ctx as { fromFile?: unknown }).fromFile !== 'string' ||
    !((ctx as { allFilePaths?: unknown }).allFilePaths instanceof Set)
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

/** Hand-built cases, one per tie-break the index could have moved. */
const HAND_CASES: readonly Case[] = [
  // ── divergence 3: whole-path vs proper suffix ────────────────────────────
  {
    name: 'root-level file is not a proper suffix of itself',
    files: ['Foo.php', 'src/Bar.php'],
    target: 'Foo',
  },
  {
    name: 'whole-path match loses to an earlier proper-suffix match',
    files: ['vendor/x/Models/User.php', 'App/Models/User.php'],
    target: 'App\\Models\\User',
  },
  {
    name: 'whole-path match loses to a later proper-suffix match too',
    files: ['App/Models/User.php', 'vendor/x/Models/User.php'],
    target: 'App\\Models\\User',
  },
  {
    name: 'whole path is the only candidate at all',
    files: ['App/Models/User.php'],
    target: 'App\\Models\\User',
  },
  {
    // A whole-path candidate the scan must skip, plus TWO proper-suffix
    // candidates behind it — so the skip has to land on the first of them and
    // not merely on "some other file".
    name: 'whole-path match skipped, first of several proper-suffix matches wins',
    files: ['App/Models/User.php', 'one/App/Models/User.php', 'two/App/Models/User.php'],
    target: 'App\\Models\\User',
  },
  {
    name: 'whole-path match skipped, first of several proper-suffix matches wins, reversed',
    files: ['two/App/Models/User.php', 'App/Models/User.php', 'one/App/Models/User.php'],
    target: 'App\\Models\\User',
  },
  {
    name: 'root-level file with a namespace-shaped import',
    files: ['index.php', 'Kernel.php'],
    target: 'Kernel',
  },
  // ── divergence 3: case-sensitive hit must not outrank an earlier ci hit ──
  {
    name: 'lowercase file first, exact-case file second',
    files: ['a/FOO.php', 'b/Foo.php'],
    target: 'Foo',
  },
  {
    name: 'exact-case file first, lowercase file second',
    files: ['b/Foo.php', 'a/FOO.php'],
    target: 'Foo',
  },
  {
    name: 'case tie across a multi-segment suffix',
    files: ['vendor/x/models/user.php', 'app/Models/User.php'],
    target: 'Models\\User',
  },
  {
    name: 'case tie across a multi-segment suffix, reversed',
    files: ['app/Models/User.php', 'vendor/x/models/user.php'],
    target: 'Models\\User',
  },
  // ── divergence 1: PSR-4 class-style is an exact whole-path test ──────────
  {
    name: 'psr-4 exact hit',
    files: ['app/Models/User.php'],
    target: 'App\\Models\\User',
    composer: APP_PSR4,
  },
  {
    name: 'psr-4 target differs from the file only by case',
    files: ['app/models/user.php'],
    target: 'App\\Models\\User',
    composer: APP_PSR4,
  },
  {
    name: 'psr-4 mapped dir differs from the namespace, file differs by case',
    files: ['src/Models/user.php', 'other/Models/User.php'],
    target: 'App\\Models\\User',
    composer: SRC_PSR4,
  },
  {
    name: 'psr-4 mapped dir exists only under vendor, by case-insensitive suffix',
    files: ['vendor/pkg/src/Models/User.php'],
    target: 'App\\Models\\User',
    composer: SRC_PSR4,
  },
  {
    // The mapped directory (`src/lib`) shares no segment with the namespace
    // (`App`), so the class-style probe and the `suffixResolve` fallback name
    // two DIFFERENT files. Only the exact-`has` leg is supposed to see the
    // first one; the raw index's case-insensitive suffix probe reaches it.
    name: 'psr-4 mapped dir path and namespace path name different files',
    files: ['other/Models/User.php', 'vendor/one/src/lib/Models/user.php'],
    target: 'App\\Models\\User',
    composer: composer([['App', 'src/lib']]),
  },
  {
    name: 'psr-4 mapped dir path and namespace path name different files, reversed',
    files: ['vendor/one/src/lib/Models/user.php', 'other/Models/User.php'],
    target: 'App\\Models\\User',
    composer: composer([['App', 'src/lib']]),
  },
  {
    name: 'psr-4 longest-prefix mapping wins',
    files: ['app/Domain/User.php', 'app/Models/User.php'],
    target: 'App\\Models\\User',
    composer: NESTED_PSR4,
  },
  {
    name: 'psr-4 mapped to the repo root',
    files: ['Models/User.php'],
    target: 'App\\Models\\User',
    composer: ROOT_PSR4,
  },
  {
    name: 'psr-4 dir prefix carries a trailing slash',
    files: ['app/Models/User.php'],
    target: 'App\\Models\\User',
    composer: TRAILING_SLASH_PSR4,
  },
  // ── divergence 2: namespace-directory scan is root-anchored ──────────────
  {
    name: 'namespace dir: root-anchored candidate beats a suffix-matching vendor dir',
    files: ['vendor/pkg/app/Models/Zed.php', 'app/Models/Aaa.php'],
    target: 'App\\Models\\getUser',
    composer: APP_PSR4,
  },
  {
    name: 'namespace dir: only a suffix-matching vendor dir exists',
    files: ['vendor/pkg/app/Models/Zed.php'],
    target: 'App\\Models\\getUser',
    composer: APP_PSR4,
  },
  {
    name: 'namespace dir: several candidates, first in order wins',
    files: ['app/Models/Bbb.php', 'app/Models/Aaa.php', 'app/Models/Ccc.php'],
    target: 'App\\Models\\getUser',
    composer: APP_PSR4,
  },
  {
    name: 'namespace dir: nested subdirectory is not a direct child',
    files: ['app/Models/Nested/Deep.php'],
    target: 'App\\Models\\getUser',
    composer: APP_PSR4,
  },
  {
    name: 'namespace dir: non-php sibling is skipped',
    files: ['app/Models/notes.md', 'app/Models/Aaa.php'],
    target: 'App\\Models\\getUser',
    composer: APP_PSR4,
  },
  {
    name: 'namespace dir with a trailing-slash mapping',
    files: ['app/Models/Aaa.php'],
    target: 'App\\Models\\getUser',
    composer: TRAILING_SLASH_PSR4,
  },
  {
    // `nsDir` keeps the mapping's trailing slash when the remainder has no
    // separator, so the directory bucket must be keyed without it.
    name: 'namespace dir IS the trailing-slash mapping',
    files: ['app/bootstrap.php', 'app/Models/User.php'],
    target: 'App\\getUser',
    composer: TRAILING_SLASH_PSR4,
  },
  {
    name: 'namespace dir at the repo root',
    files: ['User.php', 'nested/Other.php'],
    target: 'App\\getUser',
    composer: ROOT_PSR4,
  },
  // ── raw vs normalized paths ──────────────────────────────────────────────
  {
    name: 'backslash file paths',
    files: ['src\\App\\Models\\User.php'],
    target: 'App\\Models\\User',
  },
  {
    name: 'backslash file paths under a psr-4 mapping',
    files: ['app\\Models\\User.php'],
    target: 'App\\Models\\User',
    composer: APP_PSR4,
  },
  {
    name: 'backslash namespace dir candidate',
    files: ['app\\Models\\Aaa.php'],
    target: 'App\\Models\\getUser',
    composer: APP_PSR4,
  },
  // ── extension order and misses ───────────────────────────────────────────
  {
    name: 'extension order: .php before .phtml at the same depth',
    files: ['x/User.phtml', 'y/User.php'],
    target: 'User',
  },
  {
    name: 'extension order: a .ts file shadows a deeper .php file',
    files: ['x/User.ts', 'y/App/Models/User.php'],
    target: 'App\\Models\\User',
  },
  { name: 'plain miss', files: ['src/App/Models/User.php'], target: 'Other\\Thing' },
  {
    name: 'path traversal is rejected',
    files: ['app/Models/User.php'],
    target: '..\\Models\\User',
  },
  { name: 'empty file set', files: [], target: 'App\\Models\\User', composer: APP_PSR4 },
  { name: 'single-segment miss', files: ['app/Models/User.php'], target: 'Nope' },
  // ── function / const leg (context-driven) ────────────────────────────────
  {
    name: 'function import with a unique declaration',
    files: ['app/Models/User.php', 'app/Models/UserFactory.php'],
    target: 'App\\Models\\getUser',
    composer: APP_PSR4,
    parsedImport: namedImport('App\\Models\\getUser', 'function', 'getUser'),
    defs: new Map([
      ['app/Models/User.php', [['Class', 'User'] as const]],
      ['app/Models/UserFactory.php', [['Function', 'getUser'] as const]],
    ]),
  },
  {
    name: 'function import with duplicate declarations fails closed',
    files: ['app/Models/First.php', 'app/Models/Second.php'],
    target: 'App\\Models\\getUser',
    composer: APP_PSR4,
    parsedImport: namedImport('App\\Models\\getUser', 'function', 'getUser'),
    defs: new Map([
      ['app/Models/First.php', [['Function', 'getUser'] as const]],
      ['app/Models/Second.php', [['Function', 'getUser'] as const]],
    ]),
  },
  {
    name: 'function import across suffix-colliding roots',
    files: ['app/Models/functions.php', 'vendor/pkg/app/Models/helpers.php'],
    target: 'App\\Models\\getUser',
    composer: APP_PSR4,
    parsedImport: namedImport('App\\Models\\getUser', 'function', 'getUser'),
    defs: new Map([['vendor/pkg/app/Models/helpers.php', [['Function', 'getUser'] as const]]]),
  },
  {
    name: 'const import with a single candidate file',
    files: ['app/Config/constants.php'],
    target: 'App\\Config\\MAX_USERS',
    composer: APP_PSR4,
    parsedImport: namedImport('App\\Config\\MAX_USERS', 'const', 'MAX_USERS'),
    defs: new Map(),
  },
  {
    name: 'const import with several candidate files',
    files: ['app/Config/constants.php', 'app/Config/more.php'],
    target: 'App\\Config\\MAX_USERS',
    composer: APP_PSR4,
    parsedImport: namedImport('App\\Config\\MAX_USERS', 'const', 'MAX_USERS'),
    defs: new Map(),
  },
  {
    name: 'class import ignores the declaration leg',
    files: ['app/Models/User.php'],
    target: 'App\\Models\\User',
    composer: APP_PSR4,
    parsedImport: namedImport('App\\Models\\User', 'class', 'User'),
    defs: new Map([['app/Models/User.php', [['Class', 'User'] as const]]]),
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
  it.each(HAND_CASES.map((testCase) => [testCase.name, testCase] as const))(
    'ScopeResolver adapter agrees: %s',
    (_name, testCase) => {
      const { legacy, current } = runBoth(testCase);
      expect(current).toBe(legacy);
    },
  );

  it.each(HAND_CASES.map((testCase) => [testCase.name, testCase] as const))(
    'LanguageProvider adapter agrees: %s',
    (_name, testCase) => {
      const { legacy, current } = runBothWorkspaceAdapter(testCase);
      expect(current).toBe(legacy);
    },
  );

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

/**
 * Builds the prepared copy that mutation runs execute in (KTD7, KTD8).
 *
 *   <out>/prepare-report.json             what was copied, blanked and rejected, plus the path map
 *   <out>/gitnexus/                       the package sources (tracked and untracked, not ignored)
 *   <out>/gitnexus/node_modules           symlink to the checkout's gitnexus/node_modules
 *   <out>/gitnexus/relocated/gitnexus-shared/{package.json,src/}
 *                                         gitnexus-shared, relocated inside the package (KTD8)
 *
 * `vendor/` and `prebuilds/` (native binaries), `dist/` and other build output are left out:
 * the pure-JS slice does not load them. Each `--mutate` file has its `as` assertions blanked
 * (blank-assertions.ts). A file that fails the AST-equality check keeps its original text, is
 * listed under `failed` in the report, and makes the command exit 1.
 *
 * The output directory must lie outside the checkout. An existing non-empty directory is
 * replaced only when it holds a previous prepare's marker file. Exit codes: 0 prepared,
 * 1 prepared but some `--mutate` file was rejected, 2 usage or setup error.
 *
 * Usage (from gitnexus/):
 *   node --import tsx tools/mutation/prepare/prepare.ts --out <dir> [--mutate <repo path>]...
 * `--mutate` takes repo-relative paths under gitnexus/src/ or gitnexus-shared/src/.
 */
import { execFileSync } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { blankScope } from './blank-assertions.js';
import {
  PACKAGE_DIR,
  PATH_MAP,
  RELOCATED_SHARED_DIR,
  toPreparedPath,
  toRepoPath,
  type PathMapEntry,
} from './path-map.js';

/** Marks a directory as created by this tool, so a re-run may delete it. */
export const MARKER_FILE = '.gitnexus-mutation-prepared';
export const REPORT_FILE = 'prepare-report.json';

/** Top-level package entries never copied: native binaries, build output, local state. */
const EXCLUDED_TOP_LEVEL = new Set([
  'vendor',
  'prebuilds',
  'dist',
  'node_modules',
  'coverage',
  '.stryker-tmp',
  'reports',
]);

export interface PrepareOptions {
  /** Absolute path of the repo checkout. */
  repoRoot: string;
  /** Prepared root to create; must lie outside `repoRoot`. */
  outDir: string;
  /** Repo-relative `.ts` files whose `as` assertions are blanked. */
  mutate: readonly string[];
  /**
   * Maps `mutate` into the prepared tree; defaults to {@link PATH_MAP}. A fixture project's
   * extended map (`buildPathMap`) lets its files be blanked in place.
   */
  pathMap?: readonly PathMapEntry[];
}

export interface PrepareReport {
  version: 1;
  repoRoot: string;
  outDir: string;
  packageDir: string;
  relocatedShared: string;
  pathMap: readonly PathMapEntry[];
  copiedFiles: number;
  /** Every `--mutate` file that passed the AST check, with its assertion count (0 = unchanged). */
  blanked: { file: string; assertions: number }[];
  /** `--mutate` files that failed the AST check; their prepared copy keeps the original text. */
  failed: { file: string; reason: string }[];
}

/** Package-relative paths to copy, without excluded top-level entries; sorted. */
export function selectPackageFiles(files: readonly string[]): string[] {
  return [...new Set(files)].filter((file) => !EXCLUDED_TOP_LEVEL.has(file.split('/')[0])).sort();
}

/** True when `child` is `parent` or lies inside it. */
const isInside = (parent: string, child: string): boolean => {
  const relative = path.relative(parent, child);
  const escapes = relative === '..' || relative.startsWith(`..${path.sep}`);
  return !escapes && !path.isAbsolute(relative);
};

/** Tracked and untracked, not ignored files under `dir`, relative to it. */
function listSourceFiles(dir: string): string[] {
  const out = execFileSync(
    'git',
    ['-c', 'core.quotePath=false', 'ls-files', '-z', '--cached', '--others', '--exclude-standard'],
    { cwd: dir, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 },
  );
  return out.split('\0').filter((file) => file !== '');
}

/** Copies one file or symlink; returns false when the source no longer exists. */
function copyEntry(from: string, to: string): boolean {
  const stat = lstatSync(from, { throwIfNoEntry: false });
  if (stat === undefined) return false; // deleted in the working tree but still in the index
  mkdirSync(path.dirname(to), { recursive: true });
  if (stat.isSymbolicLink()) symlinkSync(readlinkSync(from), to);
  else copyFileSync(from, to);
  return true;
}

/** Creates `outDir`, replacing it only if a previous prepare left its marker. */
function resetOutDir(repoRoot: string, outDir: string): void {
  if (isInside(repoRoot, outDir) || isInside(outDir, repoRoot)) {
    throw new Error(`prepare: --out ${outDir} must lie outside the checkout ${repoRoot}`);
  }
  if (existsSync(outDir) && readdirSync(outDir).length > 0) {
    if (!existsSync(path.join(outDir, MARKER_FILE))) {
      throw new Error(
        `prepare: ${outDir} is not empty and was not created by this tool; choose another --out`,
      );
    }
    rmSync(outDir, { recursive: true, force: true });
  }
  mkdirSync(outDir, { recursive: true });
  writeFileSync(path.join(outDir, MARKER_FILE), '');
}

function checkMutatePath(file: string): void {
  if (!file.endsWith('.ts') || file.endsWith('.d.ts')) {
    throw new Error(`prepare: --mutate ${file} is not a .ts source file`);
  }
}

/**
 * The `--mutate` files as canonical repo paths (separators, `./`), each once, in first-seen
 * order. Throws for a non-`.ts` file or a path outside the map's roots.
 */
export function canonicalMutatePaths(
  mutate: readonly string[],
  pathMap: readonly PathMapEntry[] = PATH_MAP,
): string[] {
  mutate.forEach(checkMutatePath);
  return [...new Set(mutate.map((file) => toRepoPath(toPreparedPath(file, pathMap), pathMap)))];
}

/** Builds the prepared copy and returns its report (also written to `<out>/prepare-report.json`). */
export function prepare(options: PrepareOptions): PrepareReport {
  const repoRoot = path.resolve(options.repoRoot);
  const outDir = path.resolve(options.outDir);
  const sourcePackage = path.join(repoRoot, PACKAGE_DIR);
  const sourceModules = path.join(sourcePackage, 'node_modules');
  const pathMap = options.pathMap ?? PATH_MAP;
  const mutate = canonicalMutatePaths(options.mutate, pathMap);
  if (!existsSync(sourceModules)) {
    throw new Error(`prepare: ${sourceModules} is missing; run npm ci in ${PACKAGE_DIR}/ first`);
  }

  resetOutDir(repoRoot, outDir);
  const preparedPackage = path.join(outDir, PACKAGE_DIR);
  let copiedFiles = 0;
  for (const file of selectPackageFiles(listSourceFiles(sourcePackage))) {
    if (copyEntry(path.join(sourcePackage, file), path.join(preparedPackage, file))) copiedFiles++;
  }
  symlinkSync(sourceModules, path.join(preparedPackage, 'node_modules'), 'dir');

  const sharedRoot = path.join(repoRoot, 'gitnexus-shared');
  const relocatedRoot = path.join(preparedPackage, RELOCATED_SHARED_DIR);
  for (const file of listSourceFiles(path.join(sharedRoot, 'src'))) {
    const from = path.join(sharedRoot, 'src', file);
    if (copyEntry(from, path.join(outDir, toPreparedPath(`gitnexus-shared/src/${file}`)))) {
      copiedFiles++;
    }
  }
  copyFileSync(path.join(sharedRoot, 'package.json'), path.join(relocatedRoot, 'package.json'));
  copiedFiles++;

  const scope = blankScope(
    mutate.map((file) => {
      const absolute = path.join(outDir, toPreparedPath(file, pathMap));
      if (!existsSync(absolute)) throw new Error(`prepare: --mutate ${file} not found`);
      return { path: file, source: readFileSync(absolute, 'utf8') };
    }),
  );
  for (const file of scope.written) {
    writeFileSync(path.join(outDir, toPreparedPath(file.path, pathMap)), file.text);
  }

  const report: PrepareReport = {
    version: 1,
    repoRoot,
    outDir,
    packageDir: PACKAGE_DIR,
    relocatedShared: `${PACKAGE_DIR}/${RELOCATED_SHARED_DIR}`,
    pathMap,
    copiedFiles,
    blanked: scope.written.map(({ path: file, assertions }) => ({ file, assertions })),
    failed: scope.failed.map(({ path: file, reason }) => ({ file, reason })),
  };
  writeFileSync(path.join(outDir, REPORT_FILE), `${JSON.stringify(report, null, 2)}\n`);
  return report;
}

// ── CLI ────────────────────────────────────────────────────────────────────

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const { values } = parseArgs({
    options: {
      out: { type: 'string' },
      mutate: { type: 'string', multiple: true, default: [] },
    },
    strict: true,
  });
  if (!values.out) {
    console.error(
      'usage: node --import tsx tools/mutation/prepare/prepare.ts --out <dir> [--mutate <repo path>]...',
    );
    process.exit(2);
  }
  const repoRoot = fileURLToPath(new URL('../../../../', import.meta.url));
  try {
    const report = prepare({ repoRoot, outDir: path.resolve(values.out), mutate: values.mutate });
    const assertions = report.blanked.reduce((sum, file) => sum + file.assertions, 0);
    console.log(
      `prepare: ${report.copiedFiles} files into ${report.outDir}; ` +
        `${report.blanked.length} mutate file(s) processed (${assertions} assertions blanked), ` +
        `${report.failed.length} rejected`,
    );
    for (const failure of report.failed) {
      console.error(`  rejected ${failure.file}: ${failure.reason}`);
    }
    process.exitCode = report.failed.length > 0 ? 1 : 0;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 2;
  }
}

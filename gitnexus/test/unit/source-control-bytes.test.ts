import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Guard: no tracked source file may carry a raw control byte.
 *
 * A NUL written as a literal 0x00 rather than the `\0` escape is invisible in
 * an editor and identical at runtime, but it makes the file test as BINARY:
 * git shows `Bin` instead of a diff, so the change cannot be read on the PR,
 * cannot take an inline comment, and cannot be three-way merged; `file(1)`
 * reports `data`; `ugrep` returns empty with exit 1 (indistinguishable from
 * "no match", with no message); and BSD grep replaces the matching lines with
 * `Binary file … matches`. A search that should hit comes back as a confident
 * "not present", which is the worst way for a file to be unreadable.
 *
 * The byte class is deliberately split, because the two halves are not the
 * same rule:
 *
 *   - 0x00 is checked across EVERY tracked source file. git's binary heuristic
 *     keys on NUL alone, so NUL is the byte that actually costs a file its
 *     text status. Both recurrences in this repo landed outside `src/` —
 *     b620773b1 in `gitnexus/bench/cpp-qualified-ns/measure.mjs`, and
 *     38d737bb5 in a `gitnexus/test/integration/` fixture — so a guard scoped
 *     to `src/` would have caught neither, and one of the two was not even a
 *     `.ts` file.
 *   - The wider C0 class (everything except tab, LF and CR) stays scoped to
 *     `gitnexus/src`. Those bytes only *look* binary to some tools; they do not
 *     flip git's own classification, and outside `src/` they have a legitimate
 *     user: `test/unit/logger.test.ts` feeds a real 0x1b ANSI escape through the
 *     NDJSON encoder, which is the entire point of that test. Widening this half
 *     repo-wide would go red on that fixture the day it landed.
 *
 * The file list comes from `git ls-files` at the repository root rather than a
 * directory walk: it is exactly the set git applies its binary heuristic to, it
 * never descends into `node_modules`, `dist` or `vendor`, and it honours
 * `.gitignore` for free. The tradeoff is that a brand-new file is only covered
 * once git knows about it — `git add -N` is enough.
 *
 * Files are read as Buffers and scanned byte-wise. Decoding each one to a
 * string first bought nothing: the scan is ~10 ms for the whole repo, and the
 * reads dominate, which is why they go through a small concurrency pool.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));

/**
 * Asking git rather than resolving `../../..` keeps this correct inside a
 * linked worktree, and fails loudly (instead of silently scanning nothing) if
 * this test is ever run outside a checkout.
 */
const REPO_ROOT = execFileSync('git', ['rev-parse', '--show-toplevel'], {
  cwd: HERE,
  encoding: 'utf8',
}).trim();

/**
 * Every tracked text format a raw NUL would silently turn binary.
 *
 * Not just the JS/TS family, and not just code: git's heuristic does not care
 * what a file is for. This repo tracks Python, Java, Go, Rust, C/C++, Ruby,
 * PHP, Kotlin, Swift, C#, COBOL, shell and Dart sources as resolver fixtures,
 * and it hand-edits far more configuration than source — `package.json`, the
 * workflow YAML, `go.mod` and `*.csproj` fixtures, the docs, and the vitest
 * `.snap` files that are regenerated on demand and reviewed as diffs. A NUL
 * costs any of them its diff on exactly the same terms.
 *
 * `.scm` (tree-sitter queries) and `.gyp` are listed for the same reason, even
 * though every tracked instance of both today sits inside the vendored
 * grammar tree: the day a first-party query file lands outside it, it is
 * covered without a second round of this.
 *
 * The list stays an ALLOWLIST rather than "everything git tracks" because the
 * index also names the tree-sitter `.node` prebuilds and a `.png`, and those 31
 * files are genuinely binary — they are the whole reason a NUL scan cannot just
 * read the index.
 */
const SOURCE_EXTENSIONS =
  /\.(?:ts|tsx|js|jsx|mjs|cjs|mts|cts|py|pyi|java|kt|kts|go|rs|c|h|cc|cpp|hpp|cs|rb|php|swift|scala|dart|lua|pl|sh|bash|zsh|cbl|cpy|jcl|sql|vue|svelte|html|htm|css|scss|less|jinja|toml|cfg|ini|properties|env|example|json|jsonc|jsonl|yml|yaml|xml|csv|txt|md|mdc|mdm|mdx|snap|scm|proto|lock|mod|sum|csproj|props|targets|sln|gradle|gyp|gypi|ps1|bat|cmd)$/;

/**
 * Tracked text files whose whole NAME is the format — the half no extension
 * regex can reach.
 *
 * {@link SOURCE_EXTENSIONS} is end-anchored on a dot, so `Dockerfile`,
 * `CODEOWNERS`, `LICENSE`, `SHA256SUMS` and the husky hook never match it at
 * any width, and neither does a bare dotfile like `.gitignore` or
 * `.prettierrc`, whose entire name reads as an extension. Every one of them is
 * hand-edited here, and a NUL would cost each of them its diff.
 *
 * Matched against the BASENAME, so one entry covers every directory the name
 * appears in, and matched case-sensitively, which is how git stores the path.
 */
const SOURCE_BASENAMES =
  /^(?:Dockerfile(?:\..+)?|CODEOWNERS|LICENSE|SHA256SUMS|pre-commit|\.(?:cursorrules|dockerignore|git-blame-ignore-revs|gitattributes|gitignore|gitkeep|gitleaksignore|npmignore|prettierignore|prettierrc|windsurfrules))$/;

/** Scope of the wider control-byte rule. git paths are always `/`-separated. */
const STRICT_SOURCE_ROOT = 'gitnexus/src/';

/** Enough to hide per-file I/O latency without risking EMFILE. */
const READ_CONCURRENCY = 16;

interface ScanTarget {
  /** Absolute path to read. */
  readonly abs: string;
  /** Path as reported in failures — repo-root-relative for tracked files. */
  readonly rel: string;
}

interface Offender {
  readonly rel: string;
  readonly line: number;
  readonly byte: number;
}

/** The one byte git's binary heuristic keys on. */
function findNulByte(buf: Buffer): number {
  return buf.indexOf(0);
}

/** C0 controls minus the three that are legitimate in source: tab, LF, CR. */
function findControlByte(buf: Buffer): number {
  for (let i = 0; i < buf.length; i += 1) {
    const byte = buf[i];
    if (byte > 0x1f) continue;
    if (byte === 0x09 || byte === 0x0a || byte === 0x0d) continue;
    return i;
  }
  return -1;
}

/** Only ever called for an actual offender, so the O(offset) count is free. */
function lineOfOffset(buf: Buffer, offset: number): number {
  let line = 1;
  for (let i = 0; i < offset; i += 1) {
    if (buf[i] === 0x0a) line += 1;
  }
  return line;
}

/**
 * `git ls-files` reports the index, which can name a path that is not on disk
 * (a staged deletion, a sparse checkout). Those are not offenders. Any other
 * read failure propagates rather than quietly shrinking the scanned set.
 */
async function readTrackedFile(abs: string): Promise<Buffer | null> {
  try {
    return await fsp.readFile(abs);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

async function scanTarget(
  target: ScanTarget,
  locate: (buf: Buffer) => number,
): Promise<Offender | null> {
  const buf = await readTrackedFile(target.abs);
  if (buf === null) return null;
  const offset = locate(buf);
  if (offset === -1) return null;
  return { rel: target.rel, line: lineOfOffset(buf, offset), byte: buf[offset] };
}

/**
 * Reads run concurrently, so the completion order is not the input order — the
 * result is sorted before it is returned so the assertion never depends on it.
 */
async function scanTargets(
  targets: readonly ScanTarget[],
  locate: (buf: Buffer) => number,
): Promise<Offender[]> {
  const offenders: Offender[] = [];
  let cursor = 0;

  const worker = async (): Promise<void> => {
    for (;;) {
      const index = cursor;
      cursor += 1;
      if (index >= targets.length) return;
      const offender = await scanTarget(targets[index], locate);
      if (offender !== null) offenders.push(offender);
    }
  };

  const workers = Math.min(READ_CONCURRENCY, targets.length);
  await Promise.all(Array.from({ length: workers }, () => worker()));

  return offenders.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : a.line - b.line));
}

/**
 * The collector's whole filter, in one predicate.
 *
 * Exposed as a function so the planted-fixture cases below can put a fixture
 * name through the SAME decision the repo-wide scan makes. Asserting on
 * `scanTargets` alone proves only that the byte locator works; it says nothing
 * about whether the collector would ever hand that file to the locator, and
 * that second half is the one that has been too narrow.
 */
function isScannedTextFile(rel: string): boolean {
  return SOURCE_EXTENSIONS.test(rel) || SOURCE_BASENAMES.test(path.posix.basename(rel));
}

function listTrackedSourceFiles(): ScanTarget[] {
  const stdout = execFileSync('git', ['ls-files', '-z'], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  // `-z` emits raw, NUL-terminated paths, so nothing is quoted or escaped and
  // the trailing empty segment is dropped by the filter (it has neither a
  // matching extension nor a matching basename).
  return stdout
    .split('\u0000')
    .filter((rel) => isScannedTextFile(rel))
    .map((rel) => ({ abs: path.join(REPO_ROOT, rel), rel }));
}

const TRACKED_SOURCE_FILES = listTrackedSourceFiles();
const STRICT_SOURCE_FILES = TRACKED_SOURCE_FILES.filter((target) =>
  target.rel.startsWith(STRICT_SOURCE_ROOT),
);

function describeOffender(offender: Offender): string {
  const byte = `0x${offender.byte.toString(16).padStart(2, '0')}`;
  return `${offender.rel}:${offender.line} contains ${byte}`;
}

function failureMessage(lead: readonly string[], offenders: readonly Offender[]): string {
  return [...lead, ...offenders.map((offender) => `  - ${describeOffender(offender)}`)].join('\n');
}

/** Line 3 carries the raw NUL; the two lines above it prove the line count. */
const PLANTED_NUL_SOURCE = ['const a = 1;', 'const b = 2;', "const sep = '\u0000';", ''].join('\n');

/** Line 2 carries a raw ESC — the byte the repo-wide half deliberately allows. */
const PLANTED_ESCAPE_SOURCE = ['const a = 1;', "const red = '\u001b[31m';", ''].join('\n');

/**
 * The same defect in a non-JS source file. git classifies this as binary for
 * exactly the same reason, and an allowlist that stops at `.cts` would collect
 * neither the file nor the byte.
 */
const PLANTED_PY_NUL_SOURCE = ['a = 1', 'b = 2', "sep = '\u0000'", ''].join('\n');

/**
 * The same defect again, in the four shapes the JS/TS extension list could not
 * reach. The last two are why a second, basename filter has to exist at all:
 * `Dockerfile` has no extension, and `.gitignore` is a name that IS its
 * extension, so an end-anchored `\.(…)$` regex can never match either,
 * however far its alternation is widened.
 */
const PLANTED_JSON_NUL_SOURCE = ['{', '  "a": 1,', '  "sep": "\u0000"', '}', ''].join('\n');
const PLANTED_MD_NUL_SOURCE = ['# Heading', 'separator: \u0000', ''].join('\n');
const PLANTED_DOCKERFILE_NUL_SOURCE = ['FROM node:22-bookworm', 'RUN echo \u0000', ''].join('\n');
const PLANTED_DOTFILE_NUL_SOURCE = ['dist/', 'sep-\u0000/', ''].join('\n');

function writeFixture(dir: string, name: string, source: string): ScanTarget {
  const abs = path.join(dir, name);
  // Written as a Buffer so the escapes above land as single raw bytes on disk,
  // which is the shape the guard has to catch.
  fs.writeFileSync(abs, Buffer.from(source, 'utf8'));
  return { abs, rel: name };
}

function removeDir(dir: string | null): void {
  if (dir === null) return;
  fs.rmSync(dir, { recursive: true, force: true });
}

describe('source hygiene', () => {
  let fixtureDir: string | null = null;

  afterEach(() => {
    removeDir(fixtureDir);
    fixtureDir = null;
  });

  it('has no raw NUL byte in any tracked source file', async () => {
    const offenders = await scanTargets(TRACKED_SOURCE_FILES, findNulByte);

    expect(
      offenders.map(describeOffender),
      failureMessage(
        [
          'A raw NUL makes git classify the whole file as binary: it shows as `Bin`',
          'with no diff, takes no inline review comment, and will not three-way',
          'merge. Write the character as an escape instead (e.g. `\\0` or',
          '`\\u0000`), which is identical at runtime and keeps the file text:',
        ],
        offenders,
      ),
    ).toEqual([]);
  });

  it('has no other raw control byte under gitnexus/src', async () => {
    const offenders = await scanTargets(STRICT_SOURCE_FILES, findControlByte);

    expect(
      offenders.map(describeOffender),
      failureMessage(
        [
          'Raw control bytes make a source file test as binary to `file(1)`, `less`',
          'and several greps, so those tools skip it silently. Write the character',
          'as an escape instead, which is identical at runtime and keeps the file',
          'text. If the raw byte is the subject of the code (an ANSI-escape',
          'fixture, say), it belongs in the test tree, not in src/:',
        ],
        offenders,
      ),
    ).toEqual([]);
  });

  it('scans past gitnexus/src and past .ts, where both recurrences landed', () => {
    const outsideSrc = TRACKED_SOURCE_FILES.map((target) => target.rel).filter(
      (rel) => !rel.startsWith(STRICT_SOURCE_ROOT),
    );

    // Narrowing the collector back to src/, or back to .ts only, is what let
    // this defect land twice. Each of these would go red on that narrowing.
    expect(outsideSrc.length).toBeGreaterThan(0);
    expect(outsideSrc.filter((rel) => rel.startsWith('gitnexus/bench/')).length).toBeGreaterThan(0);
    expect(outsideSrc.filter((rel) => rel.startsWith('gitnexus/test/')).length).toBeGreaterThan(0);
    expect(outsideSrc.filter((rel) => rel.endsWith('.mjs')).length).toBeGreaterThan(0);
  });

  it('reports the path, line and byte value of a planted control byte', async () => {
    fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), 'source-control-bytes-'));
    const planted = [
      writeFixture(fixtureDir, 'planted-escape.ts', PLANTED_ESCAPE_SOURCE),
      writeFixture(fixtureDir, 'planted-nul.py', PLANTED_PY_NUL_SOURCE),
      writeFixture(fixtureDir, 'planted-nul.ts', PLANTED_NUL_SOURCE),
    ];

    const nulOffenders = await scanTargets(planted, findNulByte);
    const controlOffenders = await scanTargets(planted, findControlByte);

    // Without this the guard above is unfalsifiable: a collector that returns
    // an empty list, or a locator that never matches, passes it forever.
    expect(nulOffenders.map(describeOffender)).toEqual([
      'planted-nul.py:3 contains 0x00',
      'planted-nul.ts:3 contains 0x00',
    ]);
    expect(controlOffenders.map(describeOffender)).toEqual([
      'planted-escape.ts:2 contains 0x1b',
      'planted-nul.py:3 contains 0x00',
      'planted-nul.ts:3 contains 0x00',
    ]);
  });

  it('collects tracked sources outside the JS/TS family', () => {
    // The allowlist is the collector's only filter, so a language missing from
    // it is a language the NUL rule silently does not cover. This goes red if
    // the list is ever narrowed back to JS/TS.
    const collected = TRACKED_SOURCE_FILES.map((target) => target.rel);
    const byExtension = (ext: string): number =>
      collected.filter((rel) => rel.endsWith(ext)).length;

    expect(byExtension('.py')).toBeGreaterThan(0);
    expect(byExtension('.java')).toBeGreaterThan(0);
    expect(byExtension('.go')).toBeGreaterThan(0);
    expect(byExtension('.rs')).toBeGreaterThan(0);
  });

  it('reports a planted NUL in the shapes the JS/TS extension list never reached', async () => {
    fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), 'source-control-bytes-'));
    const planted = [
      writeFixture(fixtureDir, '.gitignore', PLANTED_DOTFILE_NUL_SOURCE),
      writeFixture(fixtureDir, 'Dockerfile', PLANTED_DOCKERFILE_NUL_SOURCE),
      writeFixture(fixtureDir, 'planted-nul.json', PLANTED_JSON_NUL_SOURCE),
      writeFixture(fixtureDir, 'planted-nul.md', PLANTED_MD_NUL_SOURCE),
    ];

    // Through the collector's own predicate, not straight into the locator: a
    // file the collector never yields is a file the guard never reads, and that
    // is the failure mode both halves of the filter exist to close. Dropping
    // either half deletes entries from this list.
    const scanned = planted.filter((target) => isScannedTextFile(target.rel));
    const offenders = await scanTargets(scanned, findNulByte);

    expect(offenders.map(describeOffender)).toEqual([
      '.gitignore:2 contains 0x00',
      'Dockerfile:2 contains 0x00',
      'planted-nul.json:3 contains 0x00',
      'planted-nul.md:2 contains 0x00',
    ]);
  });

  it('collects every tracked text format, files with no extension included', () => {
    const collected = TRACKED_SOURCE_FILES.map((target) => target.rel);
    const byExtension = (ext: string): number =>
      collected.filter((rel) => rel.endsWith(ext)).length;

    // Data and configuration formats. git's heuristic does not care that these
    // are not code: a NUL costs `package.json` its diff exactly as it costs a
    // `.ts` file, and every format below is hand-edited in this repo.
    expect(byExtension('.json')).toBeGreaterThan(0);
    expect(byExtension('.yml')).toBeGreaterThan(0);
    expect(byExtension('.yaml')).toBeGreaterThan(0);
    expect(byExtension('.md')).toBeGreaterThan(0);
    expect(byExtension('.snap')).toBeGreaterThan(0);
    expect(byExtension('.txt')).toBeGreaterThan(0);
    expect(byExtension('.csproj')).toBeGreaterThan(0);
    expect(byExtension('go.mod')).toBeGreaterThan(0);
    expect(byExtension('.properties')).toBeGreaterThan(0);
    expect(byExtension('.cbl')).toBeGreaterThan(0);

    // The basename half. An end-anchored EXTENSION regex cannot reach any of
    // these however far its alternation is widened, so widening alone would
    // have left all of them outside the guard.
    expect(collected).toContain('.devcontainer/Dockerfile');
    expect(collected).toContain('.github/CODEOWNERS');
    expect(collected).toContain('.husky/pre-commit');
    expect(collected).toContain('LICENSE');
    expect(byExtension('.gitignore')).toBeGreaterThan(0);
    expect(byExtension('.prettierrc')).toBeGreaterThan(0);
  });

  it('still leaves tracked binary formats out of the scan', () => {
    const collected = TRACKED_SOURCE_FILES.map((target) => target.rel);

    // Why this stays an allowlist rather than "everything git tracks". The
    // index also names the tree-sitter prebuilds and one docs screenshot, and
    // those 31 files are the only tracked files here that really do carry a
    // NUL — scanning them would report all 31 forever.
    expect(collected.filter((rel) => rel.endsWith('.node'))).toEqual([]);
    expect(collected.filter((rel) => rel.endsWith('.png'))).toEqual([]);
    expect(isScannedTextFile('gitnexus/prebuilds/linux-x64/tree-sitter-kotlin.node')).toBe(false);
    expect(isScannedTextFile('Documentation/docs-asset/kilo-code-mcp.png')).toBe(false);
  });
});

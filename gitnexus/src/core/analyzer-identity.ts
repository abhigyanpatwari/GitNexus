/**
 * Reproducible analyzer identity stamped into RepoMeta after a successful run.
 *
 * Schema v4 uses length-prefixed canonical frames. Build files and runtime
 * artifacts contribute SHA-256 payload digests, so a validated stat inventory
 * can safely reuse those expensive per-file digests across short-lived CLI and
 * server-worker processes. The cache is only an optimization: malformed,
 * mismatched, or missing entries are rehashed, and every identity calculation
 * performs a final return-boundary inventory before returning.
 *
 * `invokedArtifact` remains in the receipt for diagnostics, but is deliberately
 * excluded from semantic freshness. The CLI and the server analyze worker are
 * different entry files inside the same build tree; alternating between them
 * must not make an otherwise identical index stale.
 */

import {
  closeSync,
  constants as fsConstants,
  existsSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import type { Dirent } from 'node:fs';
import { createHash, randomBytes, type Hash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { isDeepStrictEqual } from 'node:util';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AnalyzerRunnerIdentity } from '../storage/repo-manager.js';

export const ANALYZER_RUNNER_IDENTITY_SCHEMA_VERSION = 4 as const;
const BUILD_CANONICALIZATION = 'gitnexus-analyzer-build-v2' as const;
const DEPENDENCY_RUNTIME_CANONICALIZATION = 'gitnexus-analyzer-dependency-runtime-v4' as const;
const IDENTITY_CACHE_SCHEMA_VERSION = 6 as const;
const MAX_CACHE_ENTRIES = 100_000;
const MAX_CACHE_FILE_BYTES = 64 * 1024 * 1024;
const HASH_BUFFER_BYTES = 256 * 1024;
const SHA256_PATTERN = /^sha256:[a-f0-9]{64}$/;

export interface AnalyzerIdentityTraversalLimits {
  buildEntries: number;
  buildDepth: number;
  buildBytes: number;
  runtimePackages: number;
  runtimeEdges: number;
  runtimeEntries: number;
  runtimeDepth: number;
  runtimePayloads: number;
  runtimeBytes: number;
  resolutionAncestors: number;
}

const DEFAULT_TRAVERSAL_LIMITS: Readonly<AnalyzerIdentityTraversalLimits> = {
  buildEntries: 100_000,
  buildDepth: 128,
  buildBytes: 512 * 1024 * 1024,
  runtimePackages: 10_000,
  runtimeEdges: 100_000,
  runtimeEntries: 250_000,
  runtimeDepth: 64,
  runtimePayloads: 100_000,
  runtimeBytes: 2 * 1024 * 1024 * 1024,
  resolutionAncestors: 256,
};

type PackageManifest = {
  name?: unknown;
  version?: unknown;
  dependencies?: Record<string, unknown>;
  optionalDependencies?: Record<string, unknown>;
  peerDependencies?: Record<string, unknown>;
};

type StatState = {
  dev: string;
  ino: string;
  mode: string;
  nlink: string;
  size: string;
  mtimeNs: string;
  ctimeNs: string;
};

type ReadableFileState = {
  link: StatState;
  target: StatState;
  symlinkTarget?: string;
};

type RuntimePackage = {
  root: string;
  locator: string;
  manifestPath: string;
  manifestBytes: Buffer;
  manifestState: ReadableFileState;
  manifest: PackageManifest;
  label: string;
};

type RuntimeDependencyEdge = {
  parentLocator: string;
  parentLabel: string;
  dependencyName: string;
  childLocator: string;
  childLabel: string;
};

type RuntimeVariant = {
  executablePath: string;
  nodeVersion: string;
  platform: string;
  architecture: string;
  endianness: string;
  modulesAbi: string;
  napiAbi: string;
  libc: string;
};

type RuntimeArtifactScanBudget = {
  entries: number;
  artifacts: number;
  bytes: number;
  packages: number;
  edges: number;
};

type RuntimeArtifact = {
  absolutePath: string;
  canonicalPath: string;
  kind: 'file' | 'symlink';
};

type BuildEntry = {
  absolutePath: string;
  relativePath: string;
  kind: 'directory' | 'file' | 'symlink';
  state: StatState;
};

type CachedBuildEntry = {
  relativePath: string;
  kind: BuildEntry['kind'];
  state: StatState;
  digest?: string;
};

type CachedArtifactEntry = {
  absolutePath: string;
  canonicalPath: string;
  kind: RuntimeArtifact['kind'];
  state: ReadableFileState;
  digest: string;
};

type CachedBuildDirectoryGuard = {
  relativePath: string;
  state: StatState;
  entriesDigest: string;
};

type CachedDependencyDirectoryGuard = {
  absolutePath: string;
  state: StatState;
  entriesDigest: string;
};

type DependencyDirectoryGuard = Omit<CachedDependencyDirectoryGuard, 'absolutePath'>;

type DependencyPathGuardResult = {
  type: 'directory' | 'file' | 'symlink' | 'other';
  state: StatState;
  symlinkTarget?: string;
} | null;

type CachedDependencyPathGuard = {
  absolutePath: string;
  result: DependencyPathGuardResult;
};

type IdentityCachePayload = {
  schemaVersion: typeof IDENTITY_CACHE_SCHEMA_VERSION;
  packageRoot: string;
  buildRoot: string;
  packageVersion: string;
  buildKind: AnalyzerRunnerIdentity['build']['kind'];
  buildCanonicalization: typeof BUILD_CANONICALIZATION;
  dependencyCanonicalization: typeof DEPENDENCY_RUNTIME_CANONICALIZATION;
  traversalLimits: AnalyzerIdentityTraversalLimits;
  runtimeVariant: RuntimeVariant;
  buildRootState: StatState;
  buildDigest: string;
  buildEntries: CachedBuildEntry[];
  buildDirectoryGuards: CachedBuildDirectoryGuard[];
  dependencyIdentity: AnalyzerRunnerIdentity['dependencyRuntime'];
  dependencyFileGuards: Array<{ absolutePath: string; state: ReadableFileState }>;
  dependencyDirectoryGuards: CachedDependencyDirectoryGuard[];
  dependencyPathGuards: CachedDependencyPathGuard[];
  artifactEntries: CachedArtifactEntry[];
};

type IdentityCacheEnvelope = {
  payload: IdentityCachePayload;
  checksum: string;
};

type CacheGuardRequest = {
  absolutePath: string;
  mode: 'link' | 'readable-file' | 'directory-inventory';
};

type CacheGuardResult =
  | {
      type: 'directory' | 'file' | 'symlink' | 'other';
      state: StatState;
      symlinkTarget?: string;
    }
  | { type: 'readable-file'; state: ReadableFileState }
  | { type: 'directory-inventory'; state: StatState; entriesDigest: string }
  | null;

type DependencyInputs = {
  manifestPath: string;
  lockfilePath: string | null;
  lockfileBytes: Buffer | null;
  lockfileState: ReadableFileState | null;
  packages: RuntimePackage[];
  edges: RuntimeDependencyEdge[];
  vendoredManifests: Array<{
    canonicalPath: string;
    absolutePath: string;
    bytes: Buffer;
    state: ReadableFileState;
  }>;
  artifacts: RuntimeArtifact[];
  directoryGuards: Map<string, DependencyDirectoryGuard>;
  pathGuards: Map<string, DependencyPathGuardResult>;
};

export interface AnalyzerIdentityResolveOptions {
  /** Override the persistent digest-cache directory (primarily for tests). */
  cacheDirectory?: string;
  /** Tighten traversal limits for constrained hosts/tests; never raises production bounds. */
  traversalLimits?: Partial<AnalyzerIdentityTraversalLimits>;
  /** Observe actual file payload reads; cache hits do not invoke this callback. */
  onHashedInput?: (input: {
    kind: 'build' | 'runtime-artifact';
    path: string;
    bytes: number;
  }) => void;
  /** Observe cold-path topology work; a complete cache hit emits nothing. */
  onCacheMissWork?: (input: { kind: 'directory-walk' | 'manifest-read'; path: string }) => void;
  /** Observe complete return-boundary cache validations (primarily for tests). */
  onCacheValidationPass?: (input: { guardCount: number }) => void;
  /** @internal Observe the first failed guard in a validation pass. */
  onCacheValidationFailure?: (input: { mode: CacheGuardRequest['mode']; path: string }) => void;
}

function toBuffer(value: Buffer | string): Buffer {
  return Buffer.isBuffer(value) ? value : Buffer.from(value);
}

/** Update a hash with one unambiguous, length-prefixed canonical record. */
function updateCanonicalFrame(hash: Hash, fields: readonly (Buffer | string)[]): void {
  const fieldCount = Buffer.allocUnsafe(4);
  fieldCount.writeUInt32BE(fields.length);
  hash.update(fieldCount);
  for (const field of fields) {
    const bytes = toBuffer(field);
    const length = Buffer.allocUnsafe(8);
    length.writeBigUInt64BE(BigInt(bytes.length));
    hash.update(length);
    hash.update(bytes);
  }
}

function hashCanonicalFrames(frames: readonly (readonly (Buffer | string)[])[]): string {
  const hash = createHash('sha256');
  for (const frame of frames) updateCanonicalFrame(hash, frame);
  return `sha256:${hash.digest('hex')}`;
}

/** @internal Regression seam for adversarial canonical-framing tests. */
export const _hashAnalyzerIdentityFramesForTests = hashCanonicalFrames;

function sha256(payload: Buffer | string): string {
  return `sha256:${createHash('sha256').update(payload).digest('hex')}`;
}

function digestBytes(digest: string): Buffer {
  if (!SHA256_PATTERN.test(digest)) throw new Error(`Invalid SHA-256 digest: ${digest}`);
  return Buffer.from(digest.slice('sha256:'.length), 'hex');
}

function statState(stat: ReturnType<typeof lstatSync>): StatState {
  const bigintStat = stat as unknown as {
    dev: bigint;
    ino: bigint;
    mode: bigint;
    nlink: bigint;
    size: bigint;
    mtimeNs: bigint;
    ctimeNs: bigint;
  };
  return {
    dev: String(bigintStat.dev),
    ino: String(bigintStat.ino),
    mode: String(bigintStat.mode),
    nlink: String(bigintStat.nlink),
    size: String(bigintStat.size),
    mtimeNs: String(bigintStat.mtimeNs),
    ctimeNs: String(bigintStat.ctimeNs),
  };
}

function resolveTraversalLimits(
  options: AnalyzerIdentityResolveOptions,
): AnalyzerIdentityTraversalLimits {
  const overrides = options.traversalLimits ?? {};
  const resolved = { ...DEFAULT_TRAVERSAL_LIMITS };
  for (const key of Object.keys(DEFAULT_TRAVERSAL_LIMITS) as Array<
    keyof AnalyzerIdentityTraversalLimits
  >) {
    const value = overrides[key];
    if (value === undefined) continue;
    if (!Number.isSafeInteger(value) || value < 1) {
      throw new Error(`Analyzer identity traversal limit ${key} must be a positive safe integer`);
    }
    resolved[key] = Math.min(value, DEFAULT_TRAVERSAL_LIMITS[key]);
  }
  return resolved;
}

function stateSize(state: StatState, label: string): number {
  const value = BigInt(state.size);
  if (value < 0n || value > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error(`Analyzer identity input has an unsupported size: ${label}`);
  }
  return Number(value);
}

function detectLibcVariant(): string {
  if (process.platform !== 'linux') return 'not-applicable';
  try {
    const report = process.report?.getReport() as
      | {
          header?: { glibcVersionRuntime?: unknown };
          sharedObjects?: unknown;
        }
      | undefined;
    const glibc = report?.header?.glibcVersionRuntime;
    if (typeof glibc === 'string' && glibc.length > 0) return `glibc:${glibc}`;
    if (Array.isArray(report?.sharedObjects)) {
      const musl = report.sharedObjects.find(
        (entry): entry is string =>
          typeof entry === 'string' && /(?:^|[/\\])(?:ld-)?musl[^/\\]*\.so/i.test(entry),
      );
      if (musl) return `musl:${path.basename(musl)}`;
    }
  } catch {
    // Runtime reporting is optional on some embedded Node builds. Unknown is
    // still a distinct, fail-closed variant rather than being conflated with
    // glibc or a known musl loader.
  }
  return 'linux-libc:unknown';
}

const LIBC_VARIANT = detectLibcVariant();

function resolveRuntimeVariant(): RuntimeVariant {
  return {
    executablePath: resolveExistingPath(process.execPath),
    nodeVersion: process.version,
    platform: process.platform,
    architecture: process.arch,
    endianness: os.endianness(),
    modulesAbi: process.versions.modules ?? 'unknown',
    napiAbi: process.versions.napi ?? 'unknown',
    libc: LIBC_VARIANT,
  };
}

function snapshotReadableFile(candidate: string): ReadableFileState {
  const link = lstatSync(candidate, { bigint: true });
  const target = statSync(candidate, { bigint: true });
  if (!target.isFile()) throw new Error(`Analyzer identity input is not a file: ${candidate}`);
  return {
    link: statState(link),
    target: statState(target),
    ...(link.isSymbolicLink() ? { symlinkTarget: readlinkSync(candidate) } : {}),
  };
}

function snapshotDirectory(candidate: string): StatState {
  const stat = lstatSync(candidate, { bigint: true });
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error(`Analyzer identity input is not a directory: ${candidate}`);
  }
  return statState(stat);
}

function readDirectory(candidate: string, options: AnalyzerIdentityResolveOptions): Dirent[] {
  options.onCacheMissWork?.({ kind: 'directory-walk', path: candidate });
  return readdirSync(candidate, { withFileTypes: true });
}

function directoryEntriesDigestFrom(entriesInput: readonly Dirent[]): string {
  const entries = entriesInput
    .map((entry) => ({
      name: entry.name,
      kind: entry.isDirectory()
        ? 'directory'
        : entry.isFile()
          ? 'file'
          : entry.isSymbolicLink()
            ? 'symlink'
            : 'other',
    }))
    .sort((a, b) => compareBytes(a.name, b.name));
  const hash = createHash('sha256');
  updateCanonicalFrame(hash, ['directory-entries-v1']);
  for (const entry of entries) updateCanonicalFrame(hash, [entry.name, entry.kind]);
  return `sha256:${hash.digest('hex')}`;
}

function directoryEntriesDigest(candidate: string): string {
  return directoryEntriesDigestFrom(readdirSync(candidate, { withFileTypes: true }));
}

function snapshotDirectoryInventory(candidate: string): {
  state: StatState;
  entriesDigest: string;
} {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const before = snapshotDirectory(candidate);
    const entriesDigest = directoryEntriesDigest(candidate);
    const after = snapshotDirectory(candidate);
    if (isDeepStrictEqual(before, after)) return { state: after, entriesDigest };
  }
  throw new Error(`Analyzer identity directory changed while it was read: ${candidate}`);
}

function readStableFile(candidate: string): { bytes: Buffer; state: ReadableFileState } {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const before = snapshotReadableFile(candidate);
    const bytes = readFileSync(candidate);
    const after = snapshotReadableFile(candidate);
    if (isDeepStrictEqual(before, after)) return { bytes, state: after };
  }
  throw new Error(`Analyzer identity input changed while it was being read: ${candidate}`);
}

function readStableFileWithinBudget(
  candidate: string,
  budget: RuntimeArtifactScanBudget,
  maxBytes: number,
): { bytes: Buffer; state: ReadableFileState } {
  const before = snapshotReadableFile(candidate);
  const bytes = stateSize(before.target, candidate);
  if (budget.bytes + bytes > maxBytes) {
    throw new Error(`Analyzer runtime scan exceeded ${maxBytes} bytes: ${candidate}`);
  }
  const stable = readStableFile(candidate);
  budget.bytes += stable.bytes.length;
  return stable;
}

/** Hash a stable file through a fixed-size buffer instead of materializing it. */
function hashStableFile(candidate: string): {
  digest: string;
  state: ReadableFileState;
  bytes: number;
} {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const before = snapshotReadableFile(candidate);
    const expectedBytes = stateSize(before.target, candidate);
    let descriptor: number | null = null;
    try {
      descriptor = openSync(candidate, fsConstants.O_RDONLY);
      const openedBefore = statState(fstatSync(descriptor, { bigint: true }));
      if (!isDeepStrictEqual(openedBefore, before.target)) continue;

      const hash = createHash('sha256');
      const buffer = Buffer.allocUnsafe(HASH_BUFFER_BYTES);
      let bytes = 0;
      while (true) {
        const read = readSync(descriptor, buffer, 0, buffer.length, null);
        if (read === 0) break;
        hash.update(buffer.subarray(0, read));
        bytes += read;
        if (bytes > expectedBytes) break;
      }
      const openedAfter = statState(fstatSync(descriptor, { bigint: true }));
      closeSync(descriptor);
      descriptor = null;
      const after = snapshotReadableFile(candidate);
      if (
        bytes === expectedBytes &&
        isDeepStrictEqual(openedBefore, openedAfter) &&
        isDeepStrictEqual(before, after)
      ) {
        return { digest: `sha256:${hash.digest('hex')}`, state: after, bytes };
      }
    } finally {
      if (descriptor !== null) closeSync(descriptor);
    }
  }
  throw new Error(`Analyzer identity input changed while it was being hashed: ${candidate}`);
}

function resolveExistingPath(candidate: string): string {
  return realpathSync.native(path.resolve(candidate));
}

function isFile(candidate: string): boolean {
  try {
    return statSync(candidate).isFile();
  } catch {
    return false;
  }
}

function readManifest(
  manifestPath: string,
  options: AnalyzerIdentityResolveOptions,
  budget: RuntimeArtifactScanBudget,
  limits: AnalyzerIdentityTraversalLimits,
): {
  bytes: Buffer;
  state: ReadableFileState;
  manifest: PackageManifest;
} {
  options.onCacheMissWork?.({ kind: 'manifest-read', path: manifestPath });
  const { bytes, state } = readStableFileWithinBudget(manifestPath, budget, limits.runtimeBytes);
  return { bytes, state, manifest: JSON.parse(bytes.toString('utf8')) as PackageManifest };
}

function manifestLabel(manifest: PackageManifest): string {
  const name = typeof manifest.name === 'string' ? manifest.name : '<unnamed>';
  const version = typeof manifest.version === 'string' ? manifest.version : '<unversioned>';
  return `${name}@${version}`;
}

function isInside(parent: string, candidate: string): boolean {
  const relative = path.relative(parent, candidate);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..');
}

function resolveBuildRoot(analyzerModulePath: string): {
  packageRoot: string;
  buildRoot: string;
  kind: AnalyzerRunnerIdentity['build']['kind'];
} {
  let cursor = path.dirname(analyzerModulePath);
  while (true) {
    const base = path.basename(cursor);
    if (base === 'src' || base === 'dist') {
      const packageRoot = path.dirname(cursor);
      const packageJson = path.join(packageRoot, 'package.json');
      if (lstatSync(packageJson).isFile()) {
        return {
          packageRoot,
          buildRoot: cursor,
          kind: base === 'src' ? 'source' : 'distribution',
        };
      }
    }
    const parent = path.dirname(cursor);
    if (parent === cursor) break;
    cursor = parent;
  }
  throw new Error(
    `Cannot resolve GitNexus package root from analyzer module: ${analyzerModulePath}`,
  );
}

function compareBytes(a: string, b: string): number {
  return Buffer.compare(Buffer.from(a), Buffer.from(b));
}

function collectBuildEntries(
  buildRoot: string,
  options: AnalyzerIdentityResolveOptions,
  limits: AnalyzerIdentityTraversalLimits,
): BuildEntry[] {
  const entries: BuildEntry[] = [];
  const pending: Array<{ absoluteDir: string; depth: number }> = [
    { absoluteDir: buildRoot, depth: 0 },
  ];
  let scannedEntries = 0;
  let scannedBytes = 0;

  while (pending.length > 0) {
    const next = pending.pop();
    if (!next) break;
    const { absoluteDir, depth } = next;
    const directoryEntries = readDirectory(absoluteDir, options);
    scannedEntries += directoryEntries.length;
    if (scannedEntries > limits.buildEntries) {
      throw new Error(`Analyzer build scan exceeded ${limits.buildEntries} entries: ${buildRoot}`);
    }
    for (const entry of directoryEntries) {
      const absolutePath = path.join(absoluteDir, entry.name);
      const relativePath = path.relative(buildRoot, absolutePath).split(path.sep).join('/');
      const link = lstatSync(absolutePath, { bigint: true });
      if (link.isDirectory()) {
        entries.push({
          absolutePath,
          relativePath,
          kind: 'directory',
          state: statState(link),
        });
        if (depth >= limits.buildDepth) {
          throw new Error(
            `Analyzer build scan exceeded depth ${limits.buildDepth}: ${absolutePath}`,
          );
        }
        pending.push({ absoluteDir: absolutePath, depth: depth + 1 });
      } else if (link.isFile()) {
        const state = statState(link);
        scannedBytes += stateSize(state, absolutePath);
        if (scannedBytes > limits.buildBytes) {
          throw new Error(`Analyzer build scan exceeded ${limits.buildBytes} bytes: ${buildRoot}`);
        }
        entries.push({ absolutePath, relativePath, kind: 'file', state });
      } else if (link.isSymbolicLink()) {
        entries.push({ absolutePath, relativePath, kind: 'symlink', state: statState(link) });
      } else {
        throw new Error(`Unsupported analyzer build entry: ${absolutePath}`);
      }
    }
  }
  entries.sort((a, b) => compareBytes(a.relativePath, b.relativePath));
  return entries;
}

function buildSnapshot(entries: readonly BuildEntry[]): Array<{
  relativePath: string;
  kind: BuildEntry['kind'];
  state: StatState;
}> {
  return entries.map(({ relativePath, kind, state }) => ({ relativePath, kind, state }));
}

function buildCacheKey(entry: Pick<BuildEntry, 'relativePath' | 'kind'>): string {
  return JSON.stringify([entry.kind, entry.relativePath]);
}

function hashBuildTree(
  buildRoot: string,
  cache: IdentityCachePayload | null,
  options: AnalyzerIdentityResolveOptions,
  limits: AnalyzerIdentityTraversalLimits,
): {
  digest: string;
  entries: CachedBuildEntry[];
  snapshot: ReturnType<typeof buildSnapshot>;
  rootState: StatState;
  directoryGuards: CachedBuildDirectoryGuard[];
} {
  const entries = collectBuildEntries(buildRoot, options, limits);
  const cachedEntries = new Map(
    (cache?.buildEntries ?? []).map((entry) => [buildCacheKey(entry), entry]),
  );
  const nextEntries: CachedBuildEntry[] = [];
  const hash = createHash('sha256');
  updateCanonicalFrame(hash, ['domain', BUILD_CANONICALIZATION]);

  for (const entry of entries) {
    const cached = cachedEntries.get(buildCacheKey(entry));
    let digest: string | undefined;
    if (
      entry.kind !== 'directory' &&
      cached?.digest &&
      SHA256_PATTERN.test(cached.digest) &&
      isDeepStrictEqual(cached.state, entry.state)
    ) {
      digest = cached.digest;
    } else if (entry.kind === 'file') {
      const stable = hashStableFile(entry.absolutePath);
      entry.state = stable.state.link;
      digest = stable.digest;
      options.onHashedInput?.({
        kind: 'build',
        path: entry.absolutePath,
        bytes: stable.bytes,
      });
    } else if (entry.kind === 'symlink') {
      // Imported files and directories are resolved through symlinks by Node.
      // Hashing only link text would let bytes outside buildRoot change without
      // changing the receipt. Reject them instead of inventing an incomplete
      // recursive trust boundary (target containment, cycles, and TOCTOU).
      throw new Error(
        `Analyzer build symbolic links are not supported; materialize the build tree: ${entry.absolutePath}`,
      );
    }

    updateCanonicalFrame(hash, [
      'build-entry',
      entry.relativePath,
      entry.kind,
      digest ? digestBytes(digest) : Buffer.alloc(0),
    ]);
    nextEntries.push({
      relativePath: entry.relativePath,
      kind: entry.kind,
      state: entry.state,
      ...(digest ? { digest } : {}),
    });
  }

  const directoryGuards: CachedBuildDirectoryGuard[] = [
    { relativePath: '', state: snapshotDirectory(buildRoot), entriesDigest: '' },
    ...nextEntries
      .filter((entry) => entry.kind === 'directory')
      .map((entry) => ({
        relativePath: entry.relativePath,
        state: entry.state,
        entriesDigest: '',
      })),
  ].map((guard) => {
    const absolutePath = guard.relativePath
      ? path.join(buildRoot, ...guard.relativePath.split('/'))
      : buildRoot;
    const inventory = snapshotDirectoryInventory(absolutePath);
    return {
      relativePath: guard.relativePath,
      state: inventory.state,
      entriesDigest: inventory.entriesDigest,
    };
  });

  return {
    digest: `sha256:${hash.digest('hex')}`,
    entries: nextEntries,
    snapshot: buildSnapshot(entries),
    rootState: directoryGuards[0].state,
    directoryGuards,
  };
}

function recordDirectoryGuard(
  guards: Map<string, DependencyDirectoryGuard>,
  candidate: string,
): boolean {
  if (guards.has(candidate)) return true;
  try {
    guards.set(candidate, snapshotDirectoryInventory(candidate));
    return true;
  } catch {
    return false;
  }
}

function snapshotDependencyPathGuard(candidate: string): DependencyPathGuardResult {
  try {
    const stat = lstatSync(candidate, { bigint: true });
    const type = stat.isDirectory()
      ? 'directory'
      : stat.isFile()
        ? 'file'
        : stat.isSymbolicLink()
          ? 'symlink'
          : 'other';
    return {
      type,
      state: statState(stat),
      ...(type === 'symlink' ? { symlinkTarget: readlinkSync(candidate) } : {}),
    };
  } catch {
    return null;
  }
}

function recordDependencyPathGuard(
  guards: Map<string, DependencyPathGuardResult>,
  candidate: string,
): DependencyPathGuardResult {
  if (guards.has(candidate)) return guards.get(candidate) ?? null;
  const result = snapshotDependencyPathGuard(candidate);
  guards.set(candidate, result);
  return result;
}

function findNearestPackageLock(
  packageRoot: string,
  pathGuards: Map<string, DependencyPathGuardResult>,
  limits: AnalyzerIdentityTraversalLimits,
): string | null {
  let cursor = packageRoot;
  let ancestors = 0;
  while (true) {
    ancestors += 1;
    if (ancestors > limits.resolutionAncestors) {
      throw new Error(
        `Analyzer package-lock lookup exceeded ${limits.resolutionAncestors} ancestors: ${packageRoot}`,
      );
    }
    const candidate = path.join(cursor, 'package-lock.json');
    recordDependencyPathGuard(pathGuards, candidate);
    // Preserve the link path so ReadableFileState guards both the link and its
    // resolved target. Realpathing here would miss a later retarget while the
    // old target remained unchanged.
    try {
      const link = lstatSync(candidate);
      if (link.isFile()) return path.resolve(candidate);
      if (link.isSymbolicLink()) {
        try {
          const target = statSync(candidate);
          if (!target.isFile()) {
            throw new Error(
              `Analyzer package lock symbolic link does not resolve to a file: ${candidate}`,
            );
          }
        } catch {
          throw new Error(
            `Analyzer package lock symbolic link does not resolve to a file: ${candidate}`,
          );
        }
        return path.resolve(candidate);
      }
      throw new Error(`Analyzer package lock is not a regular file: ${candidate}`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    const parent = path.dirname(cursor);
    if (parent === cursor) return null;
    cursor = parent;
  }
}

function runtimePackageLocator(packageRoot: string, runtimeRoot: string): string {
  if (runtimeRoot === packageRoot) return 'root:.';
  const relative = path.relative(packageRoot, runtimeRoot).split(path.sep).join('/');
  return `relative:${relative}`;
}

function dependencyNames(manifest: PackageManifest): string[] {
  const names = new Set<string>();
  for (const section of [
    manifest.dependencies,
    manifest.optionalDependencies,
    manifest.peerDependencies,
  ]) {
    if (!section || typeof section !== 'object') continue;
    for (const name of Object.keys(section)) names.add(name);
  }
  return [...names].sort(compareBytes);
}

function resolveDependencyPackageRoot(
  fromRoot: string,
  packageName: string,
  pathGuards: Map<string, DependencyPathGuardResult>,
  limits: AnalyzerIdentityTraversalLimits,
): string | null {
  let cursor = fromRoot;
  const segments = packageName.split('/');
  let ancestors = 0;
  while (true) {
    ancestors += 1;
    if (ancestors > limits.resolutionAncestors) {
      throw new Error(
        `Analyzer dependency resolution exceeded ${limits.resolutionAncestors} ancestors: ${packageName}`,
      );
    }
    const nodeModulesRoot = path.join(cursor, 'node_modules');
    recordDependencyPathGuard(pathGuards, nodeModulesRoot);
    let candidateParent = nodeModulesRoot;
    for (const segment of segments) {
      candidateParent = path.join(candidateParent, segment);
      // Guard every lexical hop, not only the final manifest. Package
      // managers commonly expose packages through symlinks; a retarget can
      // otherwise preserve a hard-linked manifest's stat identity while
      // changing the runtime payload tree selected by Node.
      recordDependencyPathGuard(pathGuards, candidateParent);
    }
    const manifestPath = path.join(candidateParent, 'package.json');
    recordDependencyPathGuard(pathGuards, manifestPath);
    if (isFile(manifestPath)) return resolveExistingPath(path.dirname(manifestPath));
    const parent = path.dirname(cursor);
    if (parent === cursor) return null;
    cursor = parent;
  }
}

function collectRuntimePackages(
  packageRoot: string,
  directoryGuards: Map<string, DependencyDirectoryGuard>,
  pathGuards: Map<string, DependencyPathGuardResult>,
  options: AnalyzerIdentityResolveOptions,
  budget: RuntimeArtifactScanBudget,
  limits: AnalyzerIdentityTraversalLimits,
): {
  packages: RuntimePackage[];
  edges: RuntimeDependencyEdge[];
} {
  const rootManifestPath = path.join(packageRoot, 'package.json');
  recordDirectoryGuard(directoryGuards, packageRoot);
  const rootRead = readManifest(rootManifestPath, options, budget, limits);
  const rootPackage: RuntimePackage = {
    root: packageRoot,
    locator: runtimePackageLocator(packageRoot, packageRoot),
    manifestPath: rootManifestPath,
    manifestBytes: rootRead.bytes,
    manifestState: rootRead.state,
    manifest: rootRead.manifest,
    label: manifestLabel(rootRead.manifest),
  };
  const queue = [rootPackage];
  const packages = new Map<string, RuntimePackage>([[packageRoot, rootPackage]]);
  const edges: RuntimeDependencyEdge[] = [];
  budget.packages = 1;

  for (let index = 0; index < queue.length; index += 1) {
    const parent = queue[index];
    for (const dependencyName of dependencyNames(parent.manifest)) {
      budget.edges += 1;
      if (budget.edges > limits.runtimeEdges) {
        throw new Error(
          `Analyzer dependency graph exceeded ${limits.runtimeEdges} edges: ${packageRoot}`,
        );
      }
      const childRoot = resolveDependencyPackageRoot(
        parent.root,
        dependencyName,
        pathGuards,
        limits,
      );
      if (!childRoot) {
        edges.push({
          parentLocator: parent.locator,
          parentLabel: parent.label,
          dependencyName,
          childLocator: '<missing>',
          childLabel: '<missing>',
        });
        continue;
      }

      let child = packages.get(childRoot);
      if (!child) {
        budget.packages += 1;
        if (budget.packages > limits.runtimePackages) {
          throw new Error(
            `Analyzer dependency graph exceeded ${limits.runtimePackages} packages: ${packageRoot}`,
          );
        }
        const manifestPath = path.join(childRoot, 'package.json');
        recordDirectoryGuard(directoryGuards, childRoot);
        const read = readManifest(manifestPath, options, budget, limits);
        child = {
          root: childRoot,
          locator: runtimePackageLocator(packageRoot, childRoot),
          manifestPath,
          manifestBytes: read.bytes,
          manifestState: read.state,
          manifest: read.manifest,
          label: manifestLabel(read.manifest),
        };
        packages.set(childRoot, child);
        queue.push(child);
      }
      edges.push({
        parentLocator: parent.locator,
        parentLabel: parent.label,
        dependencyName,
        childLocator: child.locator,
        childLabel: child.label,
      });
    }
  }

  return { packages: [...packages.values()], edges };
}

const PRUNED_RUNTIME_DIRECTORIES = new Set(['node_modules', '.git', '.hg', '.svn']);

function shouldHashRuntimePayload(relativePath: string): boolean {
  const lower = relativePath.toLowerCase();
  // Each package manifest is already hashed as a separately framed dependency
  // input. Avoid counting/reading it twice while still hashing every other
  // package payload: JavaScript modules, JSON data, native/Wasm binaries,
  // extensionless exports, and files loaded explicitly through fs APIs. File
  // and directory names are not authoritative platform-selection metadata:
  // loaders may select or read a payload whose name mentions another target.
  return lower !== 'package.json';
}

function collectArtifacts(
  root: string,
  canonicalPrefix: string,
  directoryGuards: Map<string, DependencyDirectoryGuard>,
  options: AnalyzerIdentityResolveOptions,
  budget: RuntimeArtifactScanBudget,
  limits: AnalyzerIdentityTraversalLimits,
): RuntimeArtifact[] {
  const artifacts: RuntimeArtifact[] = [];
  const pending: Array<{ absoluteDir: string; depth: number }> = [{ absoluteDir: root, depth: 0 }];
  while (pending.length > 0) {
    const next = pending.pop();
    if (!next) break;
    const { absoluteDir, depth } = next;
    if (!recordDirectoryGuard(directoryGuards, absoluteDir)) {
      throw new Error(`Analyzer runtime payload directory is unavailable: ${absoluteDir}`);
    }
    const entries = readDirectory(absoluteDir, options);
    budget.entries += entries.length;
    if (budget.entries > limits.runtimeEntries) {
      throw new Error(
        `Analyzer runtime payload scan exceeded ${limits.runtimeEntries} entries: ${root}`,
      );
    }
    for (const entry of entries) {
      // Nested dependencies are collected from their manifests as separate
      // packages. Only prune those separately traversed trees and VCS
      // metadata; generic cache/model directories can contain loadable code,
      // native addons, Wasm modules, or data consumed by the runtime.
      if (entry.isDirectory() && PRUNED_RUNTIME_DIRECTORIES.has(entry.name)) {
        continue;
      }
      const absolutePath = path.join(absoluteDir, entry.name);
      const relativePath = path.relative(root, absolutePath).split(path.sep).join('/');
      const stat = lstatSync(absolutePath);
      if (stat.isDirectory()) {
        if (depth >= limits.runtimeDepth) {
          throw new Error(
            `Analyzer runtime payload scan exceeded depth ${limits.runtimeDepth}: ${absolutePath}`,
          );
        }
        pending.push({ absoluteDir: absolutePath, depth: depth + 1 });
      } else if (
        (stat.isFile() || stat.isSymbolicLink()) &&
        shouldHashRuntimePayload(relativePath)
      ) {
        const readableState = snapshotReadableFile(absolutePath);
        const payloadBytes = stateSize(readableState.target, absolutePath);
        budget.artifacts += 1;
        if (budget.artifacts > limits.runtimePayloads) {
          throw new Error(
            `Analyzer runtime payload scan exceeded ${limits.runtimePayloads} payloads: ${root}`,
          );
        }
        if (budget.bytes + payloadBytes > limits.runtimeBytes) {
          throw new Error(
            `Analyzer runtime scan exceeded ${limits.runtimeBytes} bytes: ${absolutePath}`,
          );
        }
        budget.bytes += payloadBytes;
        artifacts.push({
          absolutePath,
          canonicalPath: `${canonicalPrefix}/${relativePath}`,
          kind: stat.isSymbolicLink() ? 'symlink' : 'file',
        });
      } else if (!stat.isFile() && !stat.isSymbolicLink()) {
        throw new Error(`Unsupported analyzer runtime payload entry: ${absolutePath}`);
      }
    }
  }
  return artifacts;
}

function collectVendoredGrammarInputs(
  packageRoot: string,
  directoryGuards: Map<string, DependencyDirectoryGuard>,
  options: AnalyzerIdentityResolveOptions,
  budget: RuntimeArtifactScanBudget,
  limits: AnalyzerIdentityTraversalLimits,
): {
  manifests: DependencyInputs['vendoredManifests'];
  artifacts: RuntimeArtifact[];
} {
  const vendorRoot = path.join(packageRoot, 'vendor');
  if (!existsSync(vendorRoot) || !lstatSync(vendorRoot).isDirectory()) {
    recordDirectoryGuard(directoryGuards, packageRoot);
    return { manifests: [], artifacts: [] };
  }

  const manifests: DependencyInputs['vendoredManifests'] = [];
  const artifacts: RuntimeArtifact[] = [];
  if (!recordDirectoryGuard(directoryGuards, vendorRoot)) {
    throw new Error(`Analyzer vendored runtime directory is unavailable: ${vendorRoot}`);
  }
  const vendorEntries = readDirectory(vendorRoot, options);
  budget.entries += vendorEntries.length;
  if (budget.entries > limits.runtimeEntries) {
    throw new Error(
      `Analyzer runtime payload scan exceeded ${limits.runtimeEntries} entries: ${vendorRoot}`,
    );
  }
  for (const entry of vendorEntries) {
    if (!entry.isDirectory() || !entry.name.startsWith('tree-sitter-')) continue;
    const grammarRoot = path.join(vendorRoot, entry.name);
    const manifestPath = path.join(grammarRoot, 'package.json');
    if (isFile(manifestPath)) {
      options.onCacheMissWork?.({ kind: 'manifest-read', path: manifestPath });
      const read = readStableFileWithinBudget(manifestPath, budget, limits.runtimeBytes);
      manifests.push({
        canonicalPath: `vendor:${entry.name}/package.json`,
        absolutePath: manifestPath,
        bytes: read.bytes,
        state: read.state,
      });
    }
    artifacts.push(
      ...collectArtifacts(
        grammarRoot,
        `vendor:${entry.name}`,
        directoryGuards,
        options,
        budget,
        limits,
      ),
    );
  }
  return { manifests, artifacts };
}

function collectDependencyInputs(
  packageRoot: string,
  options: AnalyzerIdentityResolveOptions,
  limits: AnalyzerIdentityTraversalLimits,
): DependencyInputs {
  const directoryGuards = new Map<string, DependencyDirectoryGuard>();
  const pathGuards = new Map<string, DependencyPathGuardResult>();
  const artifactScanBudget: RuntimeArtifactScanBudget = {
    entries: 0,
    artifacts: 0,
    bytes: 0,
    packages: 0,
    edges: 0,
  };
  const manifestPath = resolveExistingPath(path.join(packageRoot, 'package.json'));
  const lockfilePath = findNearestPackageLock(packageRoot, pathGuards, limits);
  if (lockfilePath) options.onCacheMissWork?.({ kind: 'manifest-read', path: lockfilePath });
  const lockfile = lockfilePath
    ? readStableFileWithinBudget(lockfilePath, artifactScanBudget, limits.runtimeBytes)
    : null;
  const { packages, edges } = collectRuntimePackages(
    packageRoot,
    directoryGuards,
    pathGuards,
    options,
    artifactScanBudget,
    limits,
  );
  const vendored = collectVendoredGrammarInputs(
    packageRoot,
    directoryGuards,
    options,
    artifactScanBudget,
    limits,
  );
  // The root build and vendored grammars are covered separately. Every
  // resolved external runtime package is scanned, regardless of package name:
  // native loaders are not constrained to a permanent allowlist (for example,
  // Transformers resolves Sharp's @img platform packages).
  const artifacts = packages
    .slice(1)
    .flatMap((runtimePackage) =>
      collectArtifacts(
        runtimePackage.root,
        `package:${runtimePackage.locator}`,
        directoryGuards,
        options,
        artifactScanBudget,
        limits,
      ),
    );
  artifacts.push(...vendored.artifacts);
  artifacts.sort((a, b) =>
    compareBytes(
      `${a.canonicalPath}\u0000${a.absolutePath}`,
      `${b.canonicalPath}\u0000${b.absolutePath}`,
    ),
  );

  return {
    manifestPath,
    lockfilePath,
    lockfileBytes: lockfile?.bytes ?? null,
    lockfileState: lockfile?.state ?? null,
    packages,
    edges,
    vendoredManifests: vendored.manifests,
    artifacts,
    directoryGuards,
    pathGuards,
  };
}

function dependencySnapshot(inputs: DependencyInputs): unknown {
  const edgeKey = (edge: RuntimeDependencyEdge): string =>
    JSON.stringify([
      edge.parentLocator,
      edge.parentLabel,
      edge.dependencyName,
      edge.childLocator,
      edge.childLabel,
    ]);
  return {
    manifestPath: inputs.manifestPath,
    lockfilePath: inputs.lockfilePath,
    lockfileDigest: inputs.lockfileBytes ? sha256(inputs.lockfileBytes) : null,
    lockfileState: inputs.lockfileState,
    packages: inputs.packages
      .map((runtimePackage) => ({
        root: runtimePackage.root,
        locator: runtimePackage.locator,
        manifestPath: runtimePackage.manifestPath,
        manifestDigest: sha256(runtimePackage.manifestBytes),
        manifestState: runtimePackage.manifestState,
        label: runtimePackage.label,
      }))
      .sort((a, b) => compareBytes(a.locator, b.locator)),
    edges: inputs.edges.map(edgeKey).sort(compareBytes),
    vendoredManifests: inputs.vendoredManifests
      .map((entry) => ({
        canonicalPath: entry.canonicalPath,
        absolutePath: entry.absolutePath,
        digest: sha256(entry.bytes),
        state: entry.state,
      }))
      .sort((a, b) => compareBytes(a.canonicalPath, b.canonicalPath)),
    artifacts: inputs.artifacts.map((artifact) => ({
      absolutePath: artifact.absolutePath,
      canonicalPath: artifact.canonicalPath,
      kind: artifact.kind,
      state: snapshotReadableFile(artifact.absolutePath),
    })),
    directories: [...inputs.directoryGuards.entries()]
      .map(([absolutePath, guard]) => ({ absolutePath, ...guard }))
      .sort((a, b) => compareBytes(a.absolutePath, b.absolutePath)),
    paths: [...inputs.pathGuards.entries()]
      .map(([absolutePath, result]) => ({ absolutePath, result }))
      .sort((a, b) => compareBytes(a.absolutePath, b.absolutePath)),
  };
}

function artifactCacheKey(
  artifact: Pick<RuntimeArtifact, 'absolutePath' | 'canonicalPath' | 'kind'>,
): string {
  return JSON.stringify([artifact.kind, artifact.canonicalPath, artifact.absolutePath]);
}

function hashRuntimeArtifact(
  artifact: RuntimeArtifact,
  cache: CachedArtifactEntry | undefined,
  options: AnalyzerIdentityResolveOptions,
): { digest: string; state: ReadableFileState } {
  const before = snapshotReadableFile(artifact.absolutePath);
  if (cache && SHA256_PATTERN.test(cache.digest) && isDeepStrictEqual(cache.state, before)) {
    return { digest: cache.digest, state: before };
  }

  const stable = hashStableFile(artifact.absolutePath);
  const digest = hashCanonicalFrames([
    [
      'runtime-payload-content-v1',
      artifact.kind,
      stable.state.symlinkTarget ?? '',
      digestBytes(stable.digest),
    ],
  ]);
  options.onHashedInput?.({
    kind: 'runtime-artifact',
    path: artifact.absolutePath,
    bytes: stable.bytes,
  });
  return { digest, state: stable.state };
}

function compareEdges(a: RuntimeDependencyEdge, b: RuntimeDependencyEdge): number {
  return compareBytes(
    JSON.stringify([
      a.parentLocator,
      a.parentLabel,
      a.dependencyName,
      a.childLocator,
      a.childLabel,
    ]),
    JSON.stringify([
      b.parentLocator,
      b.parentLabel,
      b.dependencyName,
      b.childLocator,
      b.childLabel,
    ]),
  );
}

function hashDependencyRuntime(
  inputs: DependencyInputs,
  cache: IdentityCachePayload | null,
  options: AnalyzerIdentityResolveOptions,
  runtimeVariant: RuntimeVariant,
): { identity: AnalyzerRunnerIdentity['dependencyRuntime']; entries: CachedArtifactEntry[] } {
  const cachedArtifacts = new Map(
    (cache?.artifactEntries ?? []).map((entry) => [artifactCacheKey(entry), entry]),
  );
  const nextArtifacts: CachedArtifactEntry[] = [];
  const hash = createHash('sha256');
  updateCanonicalFrame(hash, ['domain', DEPENDENCY_RUNTIME_CANONICALIZATION]);
  updateCanonicalFrame(hash, [
    'runtime-variant',
    runtimeVariant.nodeVersion,
    runtimeVariant.platform,
    runtimeVariant.architecture,
    runtimeVariant.endianness,
    runtimeVariant.modulesAbi,
    runtimeVariant.napiAbi,
    runtimeVariant.libc,
  ]);
  updateCanonicalFrame(hash, [
    'lockfile',
    inputs.lockfilePath ? 'present' : 'absent',
    inputs.lockfileBytes ?? Buffer.alloc(0),
  ]);

  const packageEntries = inputs.packages
    .map((runtimePackage) => ({
      canonicalPath: `package:${runtimePackage.locator}/package.json`,
      bytes: runtimePackage.manifestBytes,
    }))
    .concat(inputs.vendoredManifests.map(({ canonicalPath, bytes }) => ({ canonicalPath, bytes })))
    .sort((a, b) => compareBytes(a.canonicalPath, b.canonicalPath));
  for (const entry of packageEntries) {
    updateCanonicalFrame(hash, ['package-manifest', entry.canonicalPath, entry.bytes]);
  }
  for (const edge of [...inputs.edges].sort(compareEdges)) {
    updateCanonicalFrame(hash, [
      'dependency-edge',
      edge.parentLocator,
      edge.parentLabel,
      edge.dependencyName,
      edge.childLocator,
      edge.childLabel,
    ]);
  }
  for (const artifact of inputs.artifacts) {
    const hashed = hashRuntimeArtifact(
      artifact,
      cachedArtifacts.get(artifactCacheKey(artifact)),
      options,
    );
    updateCanonicalFrame(hash, [
      'runtime-artifact',
      artifact.canonicalPath,
      artifact.kind,
      digestBytes(hashed.digest),
    ]);
    nextArtifacts.push({ ...artifact, state: hashed.state, digest: hashed.digest });
  }

  return {
    identity: {
      manifestPath: inputs.manifestPath,
      lockfilePath: inputs.lockfilePath,
      canonicalization: DEPENDENCY_RUNTIME_CANONICALIZATION,
      packageCount: inputs.packages.length,
      artifactCount: inputs.artifacts.length,
      digest: `sha256:${hash.digest('hex')}`,
    },
    entries: nextArtifacts,
  };
}

function isStatState(value: unknown): value is StatState {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  return ['dev', 'ino', 'mode', 'nlink', 'size', 'mtimeNs', 'ctimeNs'].every(
    (key) => typeof record[key] === 'string',
  );
}

function isReadableFileState(value: unknown): value is ReadableFileState {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    isStatState(record.link) &&
    isStatState(record.target) &&
    (record.symlinkTarget === undefined || typeof record.symlinkTarget === 'string')
  );
}

function isDependencyPathGuardResult(value: unknown): value is DependencyPathGuardResult {
  if (value === null) return true;
  if (typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  return (
    ['directory', 'file', 'symlink', 'other'].includes(String(record.type)) &&
    isStatState(record.state) &&
    (record.type === 'symlink'
      ? typeof record.symlinkTarget === 'string'
      : record.symlinkTarget === undefined)
  );
}

function isRuntimeVariant(value: unknown): value is RuntimeVariant {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  return [
    'executablePath',
    'nodeVersion',
    'platform',
    'architecture',
    'endianness',
    'modulesAbi',
    'napiAbi',
    'libc',
  ].every((key) => typeof record[key] === 'string' && record[key].length > 0);
}

function isTraversalLimits(value: unknown): value is AnalyzerIdentityTraversalLimits {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    Object.keys(DEFAULT_TRAVERSAL_LIMITS) as Array<keyof AnalyzerIdentityTraversalLimits>
  ).every(
    (key) =>
      Number.isSafeInteger(record[key]) &&
      Number(record[key]) >= 1 &&
      Number(record[key]) <= DEFAULT_TRAVERSAL_LIMITS[key],
  );
}

function isDependencyRuntimeIdentity(
  value: unknown,
): value is AnalyzerRunnerIdentity['dependencyRuntime'] {
  if (typeof value !== 'object' || value === null) return false;
  const dependency = value as Record<string, unknown>;
  return (
    typeof dependency.manifestPath === 'string' &&
    dependency.manifestPath.length > 0 &&
    (dependency.lockfilePath === null ||
      (typeof dependency.lockfilePath === 'string' && dependency.lockfilePath.length > 0)) &&
    dependency.canonicalization === DEPENDENCY_RUNTIME_CANONICALIZATION &&
    Number.isSafeInteger(dependency.packageCount) &&
    Number(dependency.packageCount) >= 1 &&
    Number.isSafeInteger(dependency.artifactCount) &&
    Number(dependency.artifactCount) >= 0 &&
    typeof dependency.digest === 'string' &&
    SHA256_PATTERN.test(dependency.digest)
  );
}

function isSafeBuildRelativePath(value: unknown): value is string {
  if (typeof value !== 'string' || value.length === 0 || path.posix.isAbsolute(value)) {
    return false;
  }
  const normalized = path.posix.normalize(value);
  return normalized === value && normalized !== '..' && !normalized.startsWith('../');
}

function isSafeBuildDirectoryGuardPath(value: unknown): value is string {
  return value === '' || isSafeBuildRelativePath(value);
}

function isIdentityCachePayload(
  value: unknown,
  packageRoot: string,
  buildRoot: string,
  runtimeVariant: RuntimeVariant,
  traversalLimits: AnalyzerIdentityTraversalLimits,
): value is IdentityCachePayload {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  if (
    record.schemaVersion !== IDENTITY_CACHE_SCHEMA_VERSION ||
    record.packageRoot !== packageRoot ||
    record.buildRoot !== buildRoot ||
    typeof record.packageVersion !== 'string' ||
    record.packageVersion.length === 0 ||
    (record.buildKind !== 'source' && record.buildKind !== 'distribution') ||
    record.buildCanonicalization !== BUILD_CANONICALIZATION ||
    record.dependencyCanonicalization !== DEPENDENCY_RUNTIME_CANONICALIZATION ||
    !isTraversalLimits(record.traversalLimits) ||
    !isDeepStrictEqual(record.traversalLimits, traversalLimits) ||
    !isRuntimeVariant(record.runtimeVariant) ||
    !isDeepStrictEqual(record.runtimeVariant, runtimeVariant) ||
    !isStatState(record.buildRootState) ||
    typeof record.buildDigest !== 'string' ||
    !SHA256_PATTERN.test(record.buildDigest) ||
    !isDependencyRuntimeIdentity(record.dependencyIdentity) ||
    !Array.isArray(record.buildEntries) ||
    !Array.isArray(record.buildDirectoryGuards) ||
    !Array.isArray(record.dependencyFileGuards) ||
    !Array.isArray(record.dependencyDirectoryGuards) ||
    !Array.isArray(record.dependencyPathGuards) ||
    !Array.isArray(record.artifactEntries) ||
    record.buildEntries.length > MAX_CACHE_ENTRIES ||
    record.buildDirectoryGuards.length > MAX_CACHE_ENTRIES ||
    record.dependencyFileGuards.length > MAX_CACHE_ENTRIES ||
    record.dependencyDirectoryGuards.length > MAX_CACHE_ENTRIES ||
    record.dependencyPathGuards.length > MAX_CACHE_ENTRIES ||
    record.artifactEntries.length > MAX_CACHE_ENTRIES
  ) {
    return false;
  }
  const buildEntriesValid = record.buildEntries.every((entry: unknown) => {
    if (typeof entry !== 'object' || entry === null) return false;
    const item = entry as Record<string, unknown>;
    return (
      isSafeBuildRelativePath(item.relativePath) &&
      ['directory', 'file'].includes(String(item.kind)) &&
      isStatState(item.state) &&
      (item.kind === 'directory'
        ? item.digest === undefined
        : typeof item.digest === 'string' && SHA256_PATTERN.test(item.digest))
    );
  });
  const buildDirectoryGuardsValid = record.buildDirectoryGuards.every((entry: unknown) => {
    if (typeof entry !== 'object' || entry === null) return false;
    const item = entry as Record<string, unknown>;
    return (
      isSafeBuildDirectoryGuardPath(item.relativePath) &&
      isStatState(item.state) &&
      typeof item.entriesDigest === 'string' &&
      SHA256_PATTERN.test(item.entriesDigest)
    );
  });
  const dependencyFileGuardsValid = record.dependencyFileGuards.every((entry: unknown) => {
    if (typeof entry !== 'object' || entry === null) return false;
    const item = entry as Record<string, unknown>;
    return (
      typeof item.absolutePath === 'string' &&
      path.isAbsolute(item.absolutePath) &&
      isReadableFileState(item.state)
    );
  });
  const dependencyDirectoryGuardsValid = record.dependencyDirectoryGuards.every(
    (entry: unknown) => {
      if (typeof entry !== 'object' || entry === null) return false;
      const item = entry as Record<string, unknown>;
      return (
        typeof item.absolutePath === 'string' &&
        path.isAbsolute(item.absolutePath) &&
        isStatState(item.state) &&
        typeof item.entriesDigest === 'string' &&
        SHA256_PATTERN.test(item.entriesDigest)
      );
    },
  );
  const dependencyPathGuardsValid = record.dependencyPathGuards.every((entry: unknown) => {
    if (typeof entry !== 'object' || entry === null) return false;
    const item = entry as Record<string, unknown>;
    return (
      typeof item.absolutePath === 'string' &&
      path.isAbsolute(item.absolutePath) &&
      isDependencyPathGuardResult(item.result)
    );
  });
  const artifactEntriesValid = record.artifactEntries.every((entry: unknown) => {
    if (typeof entry !== 'object' || entry === null) return false;
    const item = entry as Record<string, unknown>;
    return (
      typeof item.absolutePath === 'string' &&
      path.isAbsolute(item.absolutePath) &&
      typeof item.canonicalPath === 'string' &&
      (item.kind === 'file' || item.kind === 'symlink') &&
      isReadableFileState(item.state) &&
      typeof item.digest === 'string' &&
      SHA256_PATTERN.test(item.digest)
    );
  });
  const hasBuildRootGuard = record.buildDirectoryGuards.some(
    (entry: unknown) =>
      typeof entry === 'object' &&
      entry !== null &&
      (entry as Record<string, unknown>).relativePath === '',
  );
  return (
    buildEntriesValid &&
    buildDirectoryGuardsValid &&
    hasBuildRootGuard &&
    dependencyFileGuardsValid &&
    dependencyDirectoryGuardsValid &&
    dependencyPathGuardsValid &&
    artifactEntriesValid
  );
}

function currentUid(): number | null {
  return typeof process.getuid === 'function' ? process.getuid() : null;
}

function isOwnedPrivateDirectory(candidate: string): boolean {
  try {
    const stat = lstatSync(candidate);
    if (!stat.isDirectory() || stat.isSymbolicLink()) return false;
    const uid = currentUid();
    return uid !== null && stat.uid === uid && (stat.mode & 0o077) === 0;
  } catch {
    return false;
  }
}

function isSafeTemporaryParent(candidate: string): boolean {
  try {
    const stat = lstatSync(candidate);
    if (!stat.isDirectory() || stat.isSymbolicLink()) return false;
    if (currentUid() === null) return false;
    // A shared temp root is safe only with the sticky bit: another UID then
    // cannot replace the private child after our atomic mkdir + owner check.
    const writableByOthers = (stat.mode & 0o022) !== 0;
    return !writableByOthers || (stat.mode & 0o1000) !== 0;
  } catch {
    return false;
  }
}

function ensurePrivateChild(parent: string, childName: string): string | null {
  let resolvedParent: string;
  try {
    resolvedParent = realpathSync.native(parent);
  } catch {
    return null;
  }
  if (!isSafeTemporaryParent(resolvedParent)) return null;
  const candidate = path.join(resolvedParent, childName);
  try {
    // Non-recursive mkdir is intentional: it cannot follow an attacker-made
    // intermediate symlink. EEXIST is accepted only after the ownership/mode
    // validation below.
    mkdirSync(candidate, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') return null;
  }
  return isOwnedPrivateDirectory(candidate) ? candidate : null;
}

function defaultCacheDirectory(): string | null {
  // On platforms without POSIX ownership APIs we cannot prove that a default
  // cache file is private to this process's user. Persistence is therefore
  // disabled unless the operator supplied an explicit trusted override.
  const uid = currentUid();
  if (uid === null) return null;

  // XDG_RUNTIME_DIR is already per-user and normally 0700. Use it only when
  // that contract is true; a spoofed/insecure value falls back to the sticky
  // OS temp root rather than becoming a cache-poisoning surface.
  const runtimeDir = process.env.XDG_RUNTIME_DIR;
  if (runtimeDir) {
    try {
      const resolvedRuntime = realpathSync.native(runtimeDir);
      if (isOwnedPrivateDirectory(resolvedRuntime)) {
        const runtimeCache = ensurePrivateChild(resolvedRuntime, 'gitnexus-analyzer-identity');
        if (runtimeCache) return runtimeCache;
      }
    } catch {
      /* fall through to the OS temp directory */
    }
  }

  let tempRoot: string;
  try {
    tempRoot = realpathSync.native(os.tmpdir());
  } catch {
    return null;
  }
  return ensurePrivateChild(tempRoot, `gitnexus-analyzer-identity-${uid}`);
}

const TRUSTED_CACHE_DIRECTORY_ENV = 'GITNEXUS_ANALYZER_IDENTITY_CACHE_DIR';

function pathsEqual(left: string, right: string): boolean {
  return process.platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right;
}

function trustedEnvironmentCacheDirectory(): string | null {
  const configured = process.env[TRUSTED_CACHE_DIRECTORY_ENV];
  if (configured === undefined) return null;
  if (configured.length === 0 || configured.includes('\0') || !path.isAbsolute(configured)) {
    throw new Error(`${TRUSTED_CACHE_DIRECTORY_ENV} must name an absolute protected directory`);
  }
  const normalized = path.normalize(configured);
  let resolved: string;
  try {
    const link = lstatSync(normalized);
    if (!link.isDirectory() || link.isSymbolicLink()) {
      throw new Error('not a real directory');
    }
    resolved = realpathSync.native(normalized);
  } catch {
    throw new Error(
      `${TRUSTED_CACHE_DIRECTORY_ENV} must name a pre-existing protected non-symlink directory`,
    );
  }
  // Reject junctions/symlinked ancestors as well as a symlink final component.
  // The environment variable is an explicit trust assertion, but its spelling
  // must still bind exactly to the directory the cache will use.
  if (!pathsEqual(path.resolve(normalized), resolved)) {
    throw new Error(`${TRUSTED_CACHE_DIRECTORY_ENV} must not traverse symbolic links or junctions`);
  }
  return resolved;
}

function cacheDirectory(
  options: AnalyzerIdentityResolveOptions,
  packageRoot: string,
  buildRoot: string,
): string | null {
  // An explicit location is a trusted operator/test override and therefore
  // remains authoritative, including when the secure default is unavailable.
  if (options.cacheDirectory) {
    const explicit = path.resolve(options.cacheDirectory);
    try {
      // Create it before any build/dependency directory guards are captured.
      // A cache nested immediately under a package root then changes that
      // parent's directory state once, not after we persist the first entry.
      mkdirSync(explicit, { recursive: true, mode: 0o700 });
    } catch {
      /* persistence remains optional and will fail closed */
    }
    return explicit;
  }
  const configured = trustedEnvironmentCacheDirectory();
  if (configured) {
    if (isInside(packageRoot, configured) || isInside(buildRoot, configured)) {
      throw new Error(
        `${TRUSTED_CACHE_DIRECTORY_ENV} must be outside the analyzer package and build roots`,
      );
    }
    return configured;
  }
  return defaultCacheDirectory();
}

function hasTrustedCacheOverride(options: AnalyzerIdentityResolveOptions): boolean {
  return (
    options.cacheDirectory !== undefined || process.env[TRUSTED_CACHE_DIRECTORY_ENV] !== undefined
  );
}

function identityCacheKey(
  packageRoot: string,
  buildRoot: string,
  runtimeVariant: RuntimeVariant,
  traversalLimits: AnalyzerIdentityTraversalLimits,
): string {
  return hashCanonicalFrames([
    [
      'analyzer-identity-cache-key-v3',
      String(IDENTITY_CACHE_SCHEMA_VERSION),
      packageRoot,
      buildRoot,
      runtimeVariant.executablePath,
      runtimeVariant.nodeVersion,
      runtimeVariant.platform,
      runtimeVariant.architecture,
      runtimeVariant.endianness,
      runtimeVariant.modulesAbi,
      runtimeVariant.napiAbi,
      runtimeVariant.libc,
      JSON.stringify(traversalLimits),
    ],
  ]).slice('sha256:'.length);
}

const MAX_PROCESS_CACHE_ENTRIES = 12;
const processIdentityCache = new Map<string, IdentityCachePayload>();

/** @internal Clear process-local reuse between simulated-process unit tests. */
export function _clearAnalyzerIdentityProcessCacheForTests(): void {
  processIdentityCache.clear();
}

function cachePathFor(
  packageRoot: string,
  buildRoot: string,
  runtimeVariant: RuntimeVariant,
  traversalLimits: AnalyzerIdentityTraversalLimits,
  options: AnalyzerIdentityResolveOptions,
): string | null {
  const directory = cacheDirectory(options, packageRoot, buildRoot);
  if (!directory) return null;
  const key = identityCacheKey(packageRoot, buildRoot, runtimeVariant, traversalLimits);
  return path.join(directory, `${key}.json`);
}

function readCacheFile(target: string): string | null {
  let descriptor: number | null = null;
  try {
    const noFollow = 'O_NOFOLLOW' in fsConstants ? fsConstants.O_NOFOLLOW : 0;
    descriptor = openSync(target, fsConstants.O_RDONLY | noFollow);
    const stat = fstatSync(descriptor);
    const uid = currentUid();
    if (
      !stat.isFile() ||
      stat.isSymbolicLink() ||
      stat.size > MAX_CACHE_FILE_BYTES ||
      (uid !== null && (stat.uid !== uid || (stat.mode & 0o077) !== 0))
    ) {
      return null;
    }
    return readFileSync(descriptor, 'utf8');
  } catch {
    return null;
  } finally {
    if (descriptor !== null) closeSync(descriptor);
  }
}

function loadIdentityCache(
  packageRoot: string,
  buildRoot: string,
  runtimeVariant: RuntimeVariant,
  traversalLimits: AnalyzerIdentityTraversalLimits,
  options: AnalyzerIdentityResolveOptions,
): IdentityCachePayload | null {
  // Invalid explicit cache configuration is an operator error, not an optional
  // cache miss. Resolve it outside the best-effort envelope read below.
  const target = cachePathFor(packageRoot, buildRoot, runtimeVariant, traversalLimits, options);
  try {
    // Validate any operator-selected persistence location on every call, even
    // when the payload itself is reusable from this process's guarded LRU.
    const key = identityCacheKey(packageRoot, buildRoot, runtimeVariant, traversalLimits);
    const local = processIdentityCache.get(key);
    if (local) return local;
    if (!target) return null;
    const raw = readCacheFile(target);
    if (raw === null) return null;
    const parsed = JSON.parse(raw) as IdentityCacheEnvelope;
    if (
      typeof parsed !== 'object' ||
      parsed === null ||
      typeof parsed.checksum !== 'string' ||
      !isIdentityCachePayload(
        parsed.payload,
        packageRoot,
        buildRoot,
        runtimeVariant,
        traversalLimits,
      ) ||
      parsed.checksum !== sha256(JSON.stringify(parsed.payload))
    ) {
      return null;
    }
    return parsed.payload;
  } catch {
    return null;
  }
}

const CACHE_GUARD_PROBE_SCRIPT = String.raw`
const fs = require('node:fs/promises');
const crypto = require('node:crypto');
const state = (value) => ({
  dev: String(value.dev), ino: String(value.ino), mode: String(value.mode),
  nlink: String(value.nlink), size: String(value.size),
  mtimeNs: String(value.mtimeNs), ctimeNs: String(value.ctimeNs),
});
const frame = (hash, fields) => {
  const fieldCount = Buffer.allocUnsafe(4);
  fieldCount.writeUInt32BE(fields.length);
  hash.update(fieldCount);
  for (const field of fields) {
    const bytes = Buffer.from(field);
    const length = Buffer.allocUnsafe(8);
    length.writeBigUInt64BE(BigInt(bytes.length));
    hash.update(length);
    hash.update(bytes);
  }
};
const inventoryDigest = (entries) => {
  const normalized = entries.map((entry) => ({
    name: entry.name,
    kind: entry.isDirectory() ? 'directory'
      : entry.isFile() ? 'file'
      : entry.isSymbolicLink() ? 'symlink' : 'other',
  })).sort((a, b) => Buffer.compare(Buffer.from(a.name), Buffer.from(b.name)));
  const hash = crypto.createHash('sha256');
  frame(hash, ['directory-entries-v1']);
  for (const entry of normalized) frame(hash, [entry.name, entry.kind]);
  return 'sha256:' + hash.digest('hex');
};
const probe = async (request) => {
  try {
    const link = await fs.lstat(request.absolutePath, { bigint: true });
    const type = link.isDirectory() ? 'directory'
      : link.isFile() ? 'file'
      : link.isSymbolicLink() ? 'symlink' : 'other';
    if (request.mode === 'link') return {
      type,
      state: state(link),
      ...(type === 'symlink' ? { symlinkTarget: await fs.readlink(request.absolutePath) } : {}),
    };
    if (request.mode === 'directory-inventory') {
      if (!link.isDirectory() || link.isSymbolicLink()) return null;
      const entriesDigest = inventoryDigest(
        await fs.readdir(request.absolutePath, { withFileTypes: true }),
      );
      const after = await fs.lstat(request.absolutePath, { bigint: true });
      if (JSON.stringify(state(link)) !== JSON.stringify(state(after))) return null;
      return { type: 'directory-inventory', state: state(after), entriesDigest };
    }
    const target = await fs.stat(request.absolutePath, { bigint: true });
    if (!target.isFile()) return null;
    const result = { type: 'readable-file', state: { link: state(link), target: state(target) } };
    if (link.isSymbolicLink()) result.state.symlinkTarget = await fs.readlink(request.absolutePath);
    return result;
  } catch { return null; }
};
let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => { input += chunk; });
process.stdin.on('end', async () => {
  try {
    const requests = JSON.parse(input);
    const results = [];
    for (let offset = 0; offset < requests.length; offset += 512) {
      results.push(...await Promise.all(requests.slice(offset, offset + 512).map(probe)));
    }
    process.stdout.write(JSON.stringify(results));
  } catch { process.exitCode = 1; }
});
`;

function snapshotCacheGuardDirect(request: CacheGuardRequest): CacheGuardResult {
  try {
    if (request.mode === 'readable-file') {
      return { type: 'readable-file', state: snapshotReadableFile(request.absolutePath) };
    }
    if (request.mode === 'directory-inventory') {
      const inventory = snapshotDirectoryInventory(request.absolutePath);
      return { type: 'directory-inventory', ...inventory };
    }
    const stat = lstatSync(request.absolutePath, { bigint: true });
    const type = stat.isDirectory()
      ? 'directory'
      : stat.isFile()
        ? 'file'
        : stat.isSymbolicLink()
          ? 'symlink'
          : 'other';
    return {
      type,
      state: statState(stat),
      ...(type === 'symlink' ? { symlinkTarget: readlinkSync(request.absolutePath) } : {}),
    };
  } catch {
    return null;
  }
}

function snapshotCacheGuards(requests: CacheGuardRequest[]): CacheGuardResult[] {
  if (requests.length < 128) return requests.map(snapshotCacheGuardDirect);
  try {
    const probe = spawnSync(
      process.execPath,
      ['--input-type=commonjs', '-e', CACHE_GUARD_PROBE_SCRIPT],
      {
        input: JSON.stringify(requests),
        encoding: 'utf8',
        maxBuffer: MAX_CACHE_FILE_BYTES,
        timeout: 30_000,
        windowsHide: true,
      },
    );
    if (probe.status === 0 && !probe.error) {
      const parsed = JSON.parse(probe.stdout) as unknown;
      if (Array.isArray(parsed) && parsed.length === requests.length) {
        return parsed as CacheGuardResult[];
      }
    }
  } catch {
    /* fall through to the slower in-process validator */
  }
  return requests.map(snapshotCacheGuardDirect);
}

function validateIdentityCache(
  cache: IdentityCachePayload,
  options: AnalyzerIdentityResolveOptions,
): boolean {
  const expected = new Map<string, CacheGuardResult>();
  const add = (request: CacheGuardRequest, result: CacheGuardResult): boolean => {
    const key = JSON.stringify([request.mode, request.absolutePath]);
    const prior = expected.get(key);
    if (expected.has(key) && !isDeepStrictEqual(prior, result)) {
      options.onCacheValidationFailure?.({ mode: request.mode, path: request.absolutePath });
      return false;
    }
    expected.set(key, result);
    return true;
  };

  if (
    !add(
      { absolutePath: cache.buildRoot, mode: 'link' },
      { type: 'directory', state: cache.buildRootState },
    )
  ) {
    return false;
  }
  for (const entry of cache.buildEntries) {
    const absolutePath = path.join(cache.buildRoot, ...entry.relativePath.split('/'));
    if (
      !isInside(cache.buildRoot, absolutePath) ||
      !add({ absolutePath, mode: 'link' }, { type: entry.kind, state: entry.state })
    ) {
      return false;
    }
  }
  for (const guard of cache.buildDirectoryGuards) {
    const absolutePath = guard.relativePath
      ? path.join(cache.buildRoot, ...guard.relativePath.split('/'))
      : cache.buildRoot;
    if (
      !isInside(cache.buildRoot, absolutePath) ||
      !add(
        { absolutePath, mode: 'directory-inventory' },
        {
          type: 'directory-inventory',
          state: guard.state,
          entriesDigest: guard.entriesDigest,
        },
      )
    ) {
      return false;
    }
  }
  for (const guard of cache.dependencyDirectoryGuards) {
    if (
      !add(
        { absolutePath: guard.absolutePath, mode: 'directory-inventory' },
        {
          type: 'directory-inventory',
          state: guard.state,
          entriesDigest: guard.entriesDigest,
        },
      )
    ) {
      return false;
    }
  }
  for (const guard of cache.dependencyPathGuards) {
    if (!add({ absolutePath: guard.absolutePath, mode: 'link' }, guard.result)) {
      return false;
    }
  }
  for (const guard of cache.dependencyFileGuards) {
    if (
      !add(
        { absolutePath: guard.absolutePath, mode: 'readable-file' },
        { type: 'readable-file', state: guard.state },
      )
    ) {
      return false;
    }
  }
  for (const artifact of cache.artifactEntries) {
    if (
      !add(
        { absolutePath: artifact.absolutePath, mode: 'readable-file' },
        { type: 'readable-file', state: artifact.state },
      )
    ) {
      return false;
    }
  }

  const entries = [...expected.entries()];
  const requests = entries.map(([key]) => {
    const [mode, absolutePath] = JSON.parse(key) as [CacheGuardRequest['mode'], string];
    return { mode, absolutePath };
  });
  options.onCacheValidationPass?.({ guardCount: requests.length });
  const actual = snapshotCacheGuards(requests);
  const mismatch = actual.findIndex(
    (result, index) => !isDeepStrictEqual(result, entries[index][1]),
  );
  if (mismatch !== -1) {
    const [mode, absolutePath] = JSON.parse(entries[mismatch][0]) as [
      CacheGuardRequest['mode'],
      string,
    ];
    options.onCacheValidationFailure?.({ mode, path: absolutePath });
    return false;
  }
  return true;
}

function cachedBuildDigestForPath(
  cache: IdentityCachePayload,
  absolutePath: string,
): string | null {
  if (!isInside(cache.buildRoot, absolutePath)) return null;
  const relativePath = path.relative(cache.buildRoot, absolutePath).split(path.sep).join('/');
  const entry = cache.buildEntries.find(
    (candidate) => candidate.kind === 'file' && candidate.relativePath === relativePath,
  );
  return entry?.digest ?? null;
}

function dependencyFileGuards(
  inputs: DependencyInputs,
): Array<{ absolutePath: string; state: ReadableFileState }> {
  const guards = new Map<string, ReadableFileState>();
  if (inputs.lockfilePath && inputs.lockfileState) {
    guards.set(inputs.lockfilePath, inputs.lockfileState);
  }
  for (const runtimePackage of inputs.packages) {
    guards.set(runtimePackage.manifestPath, runtimePackage.manifestState);
  }
  for (const manifest of inputs.vendoredManifests) {
    guards.set(manifest.absolutePath, manifest.state);
  }
  return [...guards.entries()]
    .map(([absolutePath, state]) => ({ absolutePath, state }))
    .sort((a, b) => compareBytes(a.absolutePath, b.absolutePath));
}

function dependencyDirectoryGuards(inputs: DependencyInputs): CachedDependencyDirectoryGuard[] {
  return [...inputs.directoryGuards.entries()]
    .map(([absolutePath, guard]) => ({ absolutePath, ...guard }))
    .sort((a, b) => compareBytes(a.absolutePath, b.absolutePath));
}

function dependencyPathGuards(inputs: DependencyInputs): CachedDependencyPathGuard[] {
  return [...inputs.pathGuards.entries()]
    .map(([absolutePath, result]) => ({ absolutePath, result }))
    .sort((a, b) => compareBytes(a.absolutePath, b.absolutePath));
}

function persistIdentityCache(
  packageRoot: string,
  buildRoot: string,
  payload: IdentityCachePayload,
  previous: IdentityCachePayload | null,
  options: AnalyzerIdentityResolveOptions,
): void {
  if (previous && isDeepStrictEqual(previous, payload)) return;
  const target = cachePathFor(
    packageRoot,
    buildRoot,
    payload.runtimeVariant,
    payload.traversalLimits,
    options,
  );
  if (!target) return;
  const temporary = `${target}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
  try {
    if (options.cacheDirectory) {
      mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
    } else if (
      !hasTrustedCacheOverride(options) &&
      !isOwnedPrivateDirectory(path.dirname(target))
    ) {
      return;
    }
    const envelope: IdentityCacheEnvelope = {
      payload,
      checksum: sha256(JSON.stringify(payload)),
    };
    writeFileSync(temporary, `${JSON.stringify(envelope)}\n`, {
      encoding: 'utf8',
      flag: 'wx',
      mode: 0o600,
    });
    renameSync(temporary, target);
  } catch {
    // The cache is optional (notably for read-only package/container setups).
    // A failed write only loses the optimization; identity remains fail-closed.
    try {
      unlinkSync(temporary);
    } catch {
      /* already renamed or never created */
    }
  }
}

function rememberIdentityCache(payload: IdentityCachePayload): void {
  const key = identityCacheKey(
    payload.packageRoot,
    payload.buildRoot,
    payload.runtimeVariant,
    payload.traversalLimits,
  );
  processIdentityCache.delete(key);
  processIdentityCache.set(key, payload);
  while (processIdentityCache.size > MAX_PROCESS_CACHE_ENTRIES) {
    const oldest = processIdentityCache.keys().next().value as string | undefined;
    if (oldest === undefined) break;
    processIdentityCache.delete(oldest);
  }
}

function resolveInvokedArtifact(buildRoot: string, analyzerModulePath: string): string {
  const argvEntry = process.argv[1];
  if (!argvEntry) return analyzerModulePath;
  try {
    const resolved = resolveExistingPath(argvEntry);
    return isInside(buildRoot, resolved) && lstatSync(resolved).isFile()
      ? resolved
      : analyzerModulePath;
  } catch {
    return analyzerModulePath;
  }
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function runnerRuntimeIdentity(runtimeVariant: RuntimeVariant): AnalyzerRunnerIdentity['runtime'] {
  return {
    executablePath: runtimeVariant.executablePath,
    version: runtimeVariant.nodeVersion,
    platform: runtimeVariant.platform,
    architecture: runtimeVariant.architecture,
    modulesAbi: runtimeVariant.modulesAbi,
    libc: runtimeVariant.libc,
  };
}

function isAnalyzerRunnerIdentity(value: unknown): value is AnalyzerRunnerIdentity {
  if (typeof value !== 'object' || value === null) return false;
  const identity = value as Record<string, unknown>;
  const runtime = identity.runtime as Record<string, unknown> | undefined;
  const invoked = identity.invokedArtifact as Record<string, unknown> | undefined;
  const build = identity.build as Record<string, unknown> | undefined;
  const dependency = identity.dependencyRuntime as Record<string, unknown> | undefined;
  return (
    identity.schemaVersion === ANALYZER_RUNNER_IDENTITY_SCHEMA_VERSION &&
    !!runtime &&
    isNonEmptyString(runtime.executablePath) &&
    isNonEmptyString(runtime.version) &&
    isNonEmptyString(runtime.platform) &&
    isNonEmptyString(runtime.architecture) &&
    isNonEmptyString(runtime.modulesAbi) &&
    isNonEmptyString(runtime.libc) &&
    isNonEmptyString(identity.cliVersion) &&
    !!invoked &&
    isNonEmptyString(invoked.path) &&
    typeof invoked.digest === 'string' &&
    SHA256_PATTERN.test(invoked.digest) &&
    !!build &&
    (build.kind === 'source' || build.kind === 'distribution') &&
    isNonEmptyString(build.rootPath) &&
    build.canonicalization === BUILD_CANONICALIZATION &&
    typeof build.digest === 'string' &&
    SHA256_PATTERN.test(build.digest) &&
    !!dependency &&
    isNonEmptyString(dependency.manifestPath) &&
    (dependency.lockfilePath === null || isNonEmptyString(dependency.lockfilePath)) &&
    dependency.canonicalization === DEPENDENCY_RUNTIME_CANONICALIZATION &&
    Number.isSafeInteger(dependency.packageCount) &&
    Number(dependency.packageCount) >= 1 &&
    Number.isSafeInteger(dependency.artifactCount) &&
    Number(dependency.artifactCount) >= 0 &&
    typeof dependency.digest === 'string' &&
    SHA256_PATTERN.test(dependency.digest)
  );
}

export type AnalyzerRunnerSemanticIdentity = Omit<AnalyzerRunnerIdentity, 'invokedArtifact'>;

/**
 * Normalize a raw diagnostic receipt for freshness comparison. The entrypoint
 * is the only excluded field; malformed/legacy receipts never compare equal.
 */
export function normalizeAnalyzerRunnerIdentityForComparison(
  identity: unknown,
): AnalyzerRunnerSemanticIdentity | null {
  if (!isAnalyzerRunnerIdentity(identity)) return null;
  const { invokedArtifact: _diagnosticEntrypoint, ...semantic } = identity;
  return semantic;
}

/** Resolve the identity of the analyzer build and runtime executing now. */
export function resolveAnalyzerRunnerIdentity(
  analyzerModuleUrl: string,
  options: AnalyzerIdentityResolveOptions = {},
): AnalyzerRunnerIdentity {
  const analyzerModulePath = resolveExistingPath(fileURLToPath(analyzerModuleUrl));
  const { packageRoot, buildRoot, kind } = resolveBuildRoot(analyzerModulePath);
  const runtimeVariant = resolveRuntimeVariant();
  const traversalLimits = resolveTraversalLimits(options);
  const previousCache = loadIdentityCache(
    packageRoot,
    buildRoot,
    runtimeVariant,
    traversalLimits,
    options,
  );
  const invokedArtifactPath = resolveInvokedArtifact(buildRoot, analyzerModulePath);

  if (previousCache?.buildKind === kind) {
    const invokedDigest = cachedBuildDigestForPath(previousCache, invokedArtifactPath);
    if (invokedDigest) {
      const cachedIdentity: AnalyzerRunnerIdentity = {
        schemaVersion: ANALYZER_RUNNER_IDENTITY_SCHEMA_VERSION,
        runtime: runnerRuntimeIdentity(runtimeVariant),
        cliVersion: previousCache.packageVersion,
        invokedArtifact: { path: invokedArtifactPath, digest: invokedDigest },
        build: {
          kind,
          rootPath: buildRoot,
          canonicalization: BUILD_CANONICALIZATION,
          digest: previousCache.buildDigest,
        },
        dependencyRuntime: previousCache.dependencyIdentity,
      };
      // One batched pass is deliberately the last filesystem observation on
      // a warm hit. Repeating the complete inventory both doubles status
      // latency and still cannot close the post-check scheduling window.
      if (validateIdentityCache(previousCache, options)) {
        rememberIdentityCache(previousCache);
        return cachedIdentity;
      }
    }
  }

  const build = hashBuildTree(buildRoot, previousCache, options, traversalLimits);
  const dependencyInputs = collectDependencyInputs(packageRoot, options, traversalLimits);
  const dependencySnapshotBefore = dependencySnapshot(dependencyInputs);
  const dependency = hashDependencyRuntime(
    dependencyInputs,
    previousCache,
    options,
    runtimeVariant,
  );

  const packageVersion = dependencyInputs.packages[0]?.manifest.version;
  if (typeof packageVersion !== 'string' || packageVersion.trim() === '') {
    throw new Error(`GitNexus package version is unavailable in ${packageRoot}`);
  }

  const buildSnapshotAfter = buildSnapshot(
    collectBuildEntries(buildRoot, options, traversalLimits),
  );
  if (!isDeepStrictEqual(build.snapshot, buildSnapshotAfter)) {
    throw new Error(`Analyzer build changed while its identity was being computed: ${buildRoot}`);
  }
  const dependencySnapshotAfter = dependencySnapshot(
    collectDependencyInputs(packageRoot, options, traversalLimits),
  );
  if (!isDeepStrictEqual(dependencySnapshotBefore, dependencySnapshotAfter)) {
    throw new Error(
      `Analyzer dependency runtime changed while its identity was being computed: ${packageRoot}`,
    );
  }

  const nextCache: IdentityCachePayload = {
    schemaVersion: IDENTITY_CACHE_SCHEMA_VERSION,
    packageRoot,
    buildRoot,
    packageVersion,
    buildKind: kind,
    buildCanonicalization: BUILD_CANONICALIZATION,
    dependencyCanonicalization: DEPENDENCY_RUNTIME_CANONICALIZATION,
    traversalLimits,
    runtimeVariant,
    buildRootState: build.rootState,
    buildDigest: build.digest,
    buildEntries: build.entries,
    buildDirectoryGuards: build.directoryGuards,
    dependencyIdentity: dependency.identity,
    dependencyFileGuards: dependencyFileGuards(dependencyInputs),
    dependencyDirectoryGuards: dependencyDirectoryGuards(dependencyInputs),
    dependencyPathGuards: dependencyPathGuards(dependencyInputs),
    artifactEntries: dependency.entries,
  };
  const invokedDigest = cachedBuildDigestForPath(nextCache, invokedArtifactPath);
  if (!invokedDigest) {
    throw new Error(
      `Invoked analyzer artifact is absent from the validated build: ${invokedArtifactPath}`,
    );
  }
  const identity: AnalyzerRunnerIdentity = {
    schemaVersion: ANALYZER_RUNNER_IDENTITY_SCHEMA_VERSION,
    runtime: runnerRuntimeIdentity(runtimeVariant),
    cliVersion: packageVersion,
    invokedArtifact: {
      path: invokedArtifactPath,
      digest: invokedDigest,
    },
    build: {
      kind,
      rootPath: buildRoot,
      canonicalization: BUILD_CANONICALIZATION,
      digest: build.digest,
    },
    dependencyRuntime: dependency.identity,
  };
  let validationFailure: { mode: CacheGuardRequest['mode']; path: string } | undefined;
  const validationOptions: AnalyzerIdentityResolveOptions = {
    ...options,
    onCacheValidationFailure: (failure) => {
      validationFailure = failure;
      options.onCacheValidationFailure?.(failure);
    },
  };
  if (!validateIdentityCache(nextCache, validationOptions)) {
    const mismatch = validationFailure
      ? ` (failed ${validationFailure.mode} guard: ${validationFailure.path})`
      : '';
    throw new Error(
      `Analyzer build or dependency runtime changed while its identity was being computed: ${packageRoot}${mismatch}`,
    );
  }
  rememberIdentityCache(nextCache);
  persistIdentityCache(packageRoot, buildRoot, nextCache, previousCache, options);
  return identity;
}

/**
 * Semantic freshness comparison. Both receipts must be well-formed schema-v4
 * values; only the diagnostic entrypoint field is normalized away.
 */
export function analyzerRunnerIdentitiesEqual(
  indexedIdentity: unknown,
  currentIdentity: unknown,
): boolean {
  const indexed = normalizeAnalyzerRunnerIdentityForComparison(indexedIdentity);
  const current = normalizeAnalyzerRunnerIdentityForComparison(currentIdentity);
  return indexed !== null && current !== null && isDeepStrictEqual(indexed, current);
}

/**
 * Capture analyzer identity before invoking a loader that may evaluate the
 * analyzer module graph. The explicit receipt is then threaded into analysis
 * and checked again immediately before metadata commit.
 */
export async function captureAnalyzerIdentityBeforeLoad<T>(
  analyzerModuleUrl: string,
  loader: () => Promise<T>,
  options: AnalyzerIdentityResolveOptions = {},
): Promise<{ runnerIdentity: AnalyzerRunnerIdentity; loaded: T }> {
  const runnerIdentity = resolveAnalyzerRunnerIdentity(analyzerModuleUrl, options);
  const loaded = await loader();
  return { runnerIdentity, loaded };
}

/** Re-resolve immediately before commit and reject analyzer mutation mid-run. */
export function finalizeAnalyzerRunnerIdentity(
  analyzerModuleUrl: string,
  startedWith: AnalyzerRunnerIdentity,
  options: AnalyzerIdentityResolveOptions = {},
): AnalyzerRunnerIdentity {
  const finalIdentity = resolveAnalyzerRunnerIdentity(analyzerModuleUrl, options);
  if (!analyzerRunnerIdentitiesEqual(startedWith, finalIdentity)) {
    throw new Error(
      'Analyzer build or dependency runtime changed during analysis; refusing to stamp metadata. ' +
        'Retry with a stable GitNexus installation.',
    );
  }
  return finalIdentity;
}

/** Parser compatibility is a content identity, independent of analyzer freshness and wire formats. */
import {
  closeSync,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  readdirSync,
  realpathSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { analyzerIdentityArtifacts as artifacts } from './analyzer-identity.js';
import { GRAMMAR_SOURCES } from './tree-sitter/grammar-sources.js';
import { VENDORED_GRAMMAR_PACKAGES } from './tree-sitter/vendored-grammars.js';
import { resolveParseWorkerUrl } from './ingestion/workers/worker-entry.js';

const FORMAT = 'gitnexus-parse-artifacts-v1';

/** Owned recursively. CFG is a separate component even when statically imported by providers. */
export const PARSE_CACHE_BASE_ROOTS = [
  'core/ingestion',
  'core/tree-sitter',
  'lib',
  'core/graph',
] as const;
export const PARSE_CACHE_BASE_FILES = [
  'core/vendor-root.ts',
  'core/parse-cache-identity.ts',
  'core/analyzer-identity.ts',
  'core/analysis-features.ts',
  'core/embeddings/line-index.ts',
  'config/ignore-service.ts',
  'config/repo-control-file.ts',
  'types/pipeline.ts',
  'storage/parse-cache.ts',
  'storage/parsedfile-store.ts',
  'storage/v8-sidecar.ts',
] as const;

/** Non-grammar parser dependencies; grammar names come from the runtime loader registry. */
export const PARSE_CACHE_PACKAGE_INPUTS = [
  'tree-sitter',
  'node-gyp-build',
  'js-yaml',
  'smol-toml',
  'glob',
  'ignore',
] as const;

// These extraction-only helpers live beside their provider. flow-source stays
// in base because its tokenizer is also consumed by ordinary COBOL captures.
const PDG_ONLY_INGESTION_FILES = new Set([
  'languages/cobol/flow.ts',
  'languages/cobol/flow-harvest.ts',
]);

export interface ParseCacheIdentity {
  base: string;
  pdg: string;
}

export interface ParseCacheIdentityResolveOptions {
  workerUrlForTest?: URL;
  /** @internal Isolates native fallback/marker fixtures from the host executable. */
  nativeRuntimePathsForTest?: { executable: string; alpineMarker: string };
  skipOptionalGrammars?: string;
  /** Bounds may only be tightened. */
  traversalLimits?: Partial<{
    entries: number;
    bytes: number;
    depth: number;
    packages: number;
    ancestors: number;
  }>;
  /** @internal Observes real payload reads, useful for race and coverage tests. */
  onHashedInput?: (input: { path: string; bytes: number }) => void;
}

export type ParseCacheIdentityResolution =
  | { ok: true; identity: ParseCacheIdentity; workerUrl: URL }
  | { ok: false; reason: string };

type Component = 'base' | 'pdg';
type Frame = readonly string[];
type FileState = ReturnType<typeof artifacts.snapshotReadableFile>;
const DEFAULT_LIMITS = {
  entries: 250_000,
  bytes: 2 * 1024 * 1024 * 1024,
  depth: 64,
  packages: 2_000,
  ancestors: 128,
};
const digestMemo = new Map<string, { state: FileState; digest: string }>();
const MAX_MEMO_ENTRIES = 100_000;
const identityMemo = new Map<
  string,
  { inventory: ParseArtifactInventory; identity: ParseCacheIdentity; workerUrl: URL }
>();
const compare = (left: string, right: string) =>
  Buffer.compare(Buffer.from(left), Buffer.from(right));
const slash = (value: string) => value.split(path.sep).join('/');

function optionalStat(candidate: string): ReturnType<typeof lstatSync> | null {
  try {
    return lstatSync(candidate);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error; // EACCES, ELOOP and inspection failures are not optional absence.
  }
}

/** Node export conditions can select different loaders from the same package payload. */
function moduleResolutionConditions(): string[] {
  const raw = process.env.NODE_OPTIONS ?? '';
  // NODE_OPTIONS accepts double-quoted arguments. Refuse an unterminated quote
  // rather than certify a differently interpreted module-resolution setting.
  const tokens: string[] = [];
  let token = '';
  let quoted = false;
  for (let i = 0; i < raw.length; i++) {
    const char = raw[i];
    if (char === '"') quoted = !quoted;
    else if (char === '\\' && quoted && i + 1 < raw.length) token += raw[++i];
    else if (/\s/.test(char) && !quoted) {
      if (token) tokens.push(token);
      token = '';
    } else token += char;
  }
  if (quoted) throw new Error('Unverifiable module resolution override: malformed NODE_OPTIONS');
  if (token) tokens.push(token);
  tokens.push(...process.execArgv);
  const conditions = new Set<string>();
  for (let i = 0; i < tokens.length; i++) {
    const argument = tokens[i];
    if (/^--preserve[-_]symlinks(?:[-_]main)?(?:=|$)/.test(argument))
      throw new Error('Unverifiable module resolution override: preserve-symlinks');
    if (argument === '--conditions' || argument === '-C') {
      if (!tokens[i + 1])
        throw new Error('Unverifiable module resolution override: missing condition');
      conditions.add(tokens[++i]);
    } else if (argument.startsWith('--conditions=')) conditions.add(argument.slice(13));
    else if (argument.startsWith('-C') && argument.length > 2) conditions.add(argument.slice(2));
  }
  return [...conditions].sort(compare);
}

function effectiveEnvironment(skip: string, alpine: boolean): Frame[] {
  const normalized = skip.trim().toLowerCase();
  const all = ['1', 'true', 'all', '*'].includes(normalized);
  const named = new Set(
    normalized
      .split(',')
      .flatMap((value) => [value.trim(), value.trim().replace(/^tree-sitter-/, '')]),
  );
  const skipped = Object.entries(GRAMMAR_SOURCES)
    .filter(([key, source]) => source.userSkippable && (all || named.has(key)))
    .map(([key]) => key)
    .sort(compare);
  const numeric = (name: string, fallback: number, floor: boolean): string => {
    const raw = process.env[name];
    const value = raw === undefined || raw === '' ? fallback : Number(raw);
    return String(
      Number.isFinite(value) && value >= 0 ? (floor ? Math.floor(value) : value) : fallback,
    );
  };
  return [
    ['skipped-grammars', ...skipped],
    ['parse-timeout-ms', numeric('GITNEXUS_PARSE_TIMEOUT_MS', 15_000, true)],
    ['capture-budget-ms', numeric('GITNEXUS_CPP_CAPTURE_BUDGET_MS', 20_000, false)],
    ['strict-clone', String(process.env.GITNEXUS_STRICT_CLONE === '1')],
    ['module-conditions', ...moduleResolutionConditions()],
    // node-gyp-build snapshots these at module evaluation. The package payload
    // inventory covers every candidate; these frames distinguish its selector.
    [
      'native-loader-defaults',
      JSON.stringify({
        alpine,
        armVersion:
          (process.config.variables as { arm_version?: string | number }).arm_version ?? '',
        uvMajor: (process.versions.uv ?? '').split('.')[0],
        electron: process.versions.electron ?? '',
        nw: process.versions.nw ?? '',
      }),
    ],
    ...[
      'npm_config_arch',
      'npm_config_platform',
      'LIBC',
      'ARM_VERSION',
      'PREBUILDS_ONLY',
      'ELECTRON_RUN_AS_NODE',
    ].map((name) => ['native-loader-environment', name, process.env[name] ?? '']),
  ];
}

class ParseArtifactInventory {
  readonly frames: Record<Component, Frame[]> = { base: [], pdg: [] };
  private readonly guards = new Map<string, { snapshot: () => unknown; state: unknown }>();
  private readonly fileDigests = new Map<string, string>();
  private readonly limits = { ...DEFAULT_LIMITS };
  private entries = 0;
  private bytes = 0;
  private packages = 0;
  private readonly packageLocations = new Map<string, string>();

  constructor(private readonly options: ParseCacheIdentityResolveOptions) {
    for (const [key, value] of Object.entries(options.traversalLimits ?? {})) {
      if (!(key in this.limits) || !Number.isSafeInteger(value) || value < 1)
        throw new Error(`Invalid parser identity traversal limit: ${key}`);
      this.limits[key as keyof typeof this.limits] = Math.min(
        value,
        DEFAULT_LIMITS[key as keyof typeof DEFAULT_LIMITS],
      );
    }
  }

  private guard(key: string, snapshot: () => unknown): unknown {
    const state = snapshot();
    const previous = this.guards.get(key);
    if (previous && !isDeepStrictEqual(previous.state, state))
      throw new Error(`Parser artifact changed during identity capture: ${key}`);
    if (!previous) this.guards.set(key, { snapshot, state });
    return state;
  }

  inspect(candidate: string): ReturnType<typeof lstatSync> | null {
    // Bigint nanosecond timestamps and link targets guard path resolution too.
    this.guard(`path:${candidate}`, () => {
      const stat = optionalStat(candidate);
      if (!stat) return null;
      const state = lstatSync(candidate, { bigint: true });
      return [
        realpathSync.native(candidate),
        state.dev,
        state.ino,
        state.mode,
        state.nlink,
        state.size,
        state.mtimeNs,
        state.ctimeNs,
      ];
    });
    return optionalStat(candidate);
  }

  private fileDigest(candidate: string): string {
    let digest = this.fileDigests.get(candidate);
    if (!digest) {
      const before = artifacts.snapshotReadableFile(candidate);
      const size = Number(before.target.size);
      if (!Number.isSafeInteger(size) || size < 0 || this.bytes + size > this.limits.bytes)
        throw new Error(`Parser identity scan exceeded ${this.limits.bytes} bytes: ${candidate}`);
      this.bytes += size;
      const cached = digestMemo.get(candidate);
      if (cached && isDeepStrictEqual(cached.state, before)) {
        digest = cached.digest;
      } else {
        const hashed = artifacts.hashStableFile(candidate);
        if (!isDeepStrictEqual(before, hashed.state))
          throw new Error(`Parser artifact changed during identity capture: ${candidate}`);
        digest = hashed.digest;
        this.options.onHashedInput?.({ path: candidate, bytes: hashed.bytes });
        digestMemo.set(candidate, { state: hashed.state, digest });
        if (digestMemo.size > MAX_MEMO_ENTRIES) digestMemo.delete(digestMemo.keys().next().value!);
      }
      this.guards.set(`file:${candidate}`, {
        snapshot: () => artifacts.snapshotReadableFile(candidate),
        state: before,
      });
      this.fileDigests.set(candidate, digest);
    }
    return digest;
  }

  file(candidate: string, logical: string, component: Component): void {
    this.frames[component].push(['file', logical, this.fileDigest(candidate)]);
  }

  tree(
    root: string,
    logical: string,
    component: Component,
    splitCfg = false,
    packagePayload = false,
  ): void {
    const initial = this.inspect(root);
    if (!initial?.isDirectory() || initial.isSymbolicLink())
      throw new Error(`Parser input is not a regular directory: ${root}`);
    const pending = [{ directory: root, depth: 0 }];
    while (pending.length) {
      const { directory, depth } = pending.pop()!;
      this.guard(`directory:${directory}`, () => artifacts.snapshotDirectoryInventory(directory));
      const entries = readdirSync(directory, { withFileTypes: true }).sort((a, b) =>
        compare(a.name, b.name),
      );
      for (const entry of entries) {
        if (entry.name === 'node_modules') {
          if (!packagePayload)
            throw new Error(
              `Unclassified nested parser dependencies: ${path.join(directory, entry.name)}`,
            );
          continue; // Package manifests enumerate dependency trees separately.
        }
        if (['.git', '.hg', '.svn'].includes(entry.name) || entry.name.endsWith('.map')) continue;
        if (++this.entries > this.limits.entries)
          throw new Error(`Parser identity scan exceeded ${this.limits.entries} entries: ${root}`);
        const candidate = path.join(directory, entry.name);
        const stat = lstatSync(candidate);
        if (stat.isSymbolicLink())
          throw new Error(`Unverifiable parser symbolic link: ${candidate}`);
        if (stat.isDirectory()) {
          if (depth >= this.limits.depth)
            throw new Error(
              `Parser identity scan exceeded depth ${this.limits.depth}: ${candidate}`,
            );
          pending.push({ directory: candidate, depth: depth + 1 });
        } else if (stat.isFile()) {
          const relative = slash(path.relative(root, candidate));
          const ownedComponent =
            splitCfg &&
            (relative.startsWith('cfg/') ||
              PDG_ONLY_INGESTION_FILES.has(relative.replace(/\.js$/, '.ts')))
              ? 'pdg'
              : component;
          this.file(candidate, `${logical}/${relative}`, ownedComponent);
        } else throw new Error(`Unsupported parser artifact: ${candidate}`);
      }
    }
  }

  manifest(root: string): {
    dependencies?: Record<string, string>;
    optionalDependencies?: Record<string, string>;
    peerDependencies?: Record<string, string>;
    peerDependenciesMeta?: Record<string, { optional?: boolean }>;
  } {
    const candidate = path.join(root, 'package.json');
    // Guard and bound the read; the package tree assigns its logical identity.
    this.fileDigest(candidate);
    // A manifest can grow between the stat and read. Read only the bounded
    // captured length through an fd; never allocate from an unverified new size.
    const before = artifacts.snapshotReadableFile(candidate);
    const size = Number(before.target.size);
    if (size > Math.min(this.limits.bytes, 4 * 1024 * 1024))
      throw new Error(`Parser manifest exceeded byte limit: ${candidate}`);
    const descriptor = openSync(candidate, 'r');
    try {
      const bytes = Buffer.alloc(size);
      let offset = 0;
      while (offset < size) {
        const count = readSync(descriptor, bytes, offset, size - offset, null);
        if (!count) break;
        offset += count;
      }
      const opened = fstatSync(descriptor, { bigint: true });
      const after = artifacts.snapshotReadableFile(candidate);
      if (
        offset !== size ||
        String(opened.ino) !== before.target.ino ||
        String(opened.dev) !== before.target.dev ||
        String(opened.size) !== before.target.size ||
        String(opened.mtimeNs) !== before.target.mtimeNs ||
        String(opened.ctimeNs) !== before.target.ctimeNs ||
        !isDeepStrictEqual(before, after)
      )
        throw new Error(`Parser manifest changed during identity capture: ${candidate}`);
      return JSON.parse(bytes.toString('utf8'));
    } finally {
      closeSync(descriptor);
    }
  }

  packageRoot(from: string, name: string): string | null {
    if (!/^(?:@[a-zA-Z0-9_.-]+\/)?[a-zA-Z0-9_.-]+$/.test(name))
      throw new Error(`Unsupported parser package name: ${name}`);
    let cursor = from;
    for (let count = 0; count < this.limits.ancestors; count++) {
      const modules = path.join(cursor, 'node_modules');
      this.inspect(modules);
      let candidate = modules;
      for (const segment of name.split('/')) {
        candidate = path.join(candidate, segment);
        this.inspect(candidate);
      }
      const manifest = path.join(candidate, 'package.json');
      if (this.inspect(manifest)?.isFile()) return realpathSync.native(candidate);
      const parent = path.dirname(cursor);
      if (parent === cursor) return null;
      cursor = parent;
    }
    throw new Error(
      `Parser package resolution exceeded ${this.limits.ancestors} ancestors: ${name}`,
    );
  }

  dependencyTrees(packageRoot: string, from: string, prefix: string): void {
    const roots = new Map<string, { root: string | null; optional: boolean }>();
    for (const name of PARSE_CACHE_PACKAGE_INPUTS)
      roots.set(name, { root: this.packageRoot(from, name), optional: false });
    for (const source of Object.values(GRAMMAR_SOURCES)) {
      const name = source.packageName;
      const vendor = path.join(packageRoot, 'vendor', name);
      const root = VENDORED_GRAMMAR_PACKAGES.has(name)
        ? this.inspect(vendor)
          ? realpathSync.native(vendor)
          : null
        : this.packageRoot(from, name);
      roots.set(name, { root, optional: source.optional === true });
    }
    // Includes inventory-only grammars (for example the protobuf parser).
    for (const name of VENDORED_GRAMMAR_PACKAGES) {
      if (roots.has(name)) continue;
      const vendor = path.join(packageRoot, 'vendor', name);
      roots.set(name, {
        root: this.inspect(vendor) ? realpathSync.native(vendor) : null,
        optional: true,
      });
    }
    const pending = [...roots]
      .sort(([a], [b]) => compare(a, b))
      .map(([name, input]) => ({ ...input, name, parent: prefix }));
    while (pending.length) {
      const { root, optional, name, parent } = pending.shift()!;
      const logical = `${parent}>${name}`;
      if (!root) {
        if (!optional) throw new Error(`Required parser package is unavailable: ${name}`);
        this.frames.base.push(['optional-package-absent', logical]);
        continue;
      }
      const prior = this.packageLocations.get(root);
      this.frames.base.push(['package-edge', parent, name, prior ?? logical]);
      if (prior) continue;
      if (++this.packages > this.limits.packages)
        throw new Error(`Parser identity scan exceeded ${this.limits.packages} packages`);
      this.packageLocations.set(root, logical);
      const override = `${name.replace(/-/g, '_').toUpperCase()}_PREBUILD`;
      if (process.env[override])
        throw new Error(`Unverifiable external native loader override: ${override}`);
      const manifest = this.manifest(root);
      this.tree(root, logical, 'base', false, true);
      const dependencies = {
        ...manifest.peerDependencies,
        ...manifest.dependencies,
        ...manifest.optionalDependencies,
      };
      for (const dependency of Object.keys(dependencies).sort(compare)) {
        pending.push({
          root: this.packageRoot(root, dependency),
          name: dependency,
          parent: logical,
          optional:
            Object.hasOwn(manifest.optionalDependencies ?? {}, dependency) ||
            manifest.peerDependenciesMeta?.[dependency]?.optional === true,
        });
      }
    }
  }

  verify(): void {
    for (const [label, guard] of this.guards) {
      if (!isDeepStrictEqual(guard.state, guard.snapshot()))
        throw new Error(`Parser artifact changed during identity capture: ${label}`);
    }
  }
}

function collectBuild(
  inventory: ParseArtifactInventory,
  root: string,
  logical: string,
  kind: 'source' | 'distribution',
): void {
  for (const owned of PARSE_CACHE_BASE_ROOTS)
    inventory.tree(
      path.join(root, owned),
      `${logical}/${owned}`,
      'base',
      owned === 'core/ingestion',
    );
  for (const owned of PARSE_CACHE_BASE_FILES) {
    const relative = kind === 'source' ? owned : owned.replace(/\.ts$/, '.js');
    // A source checkout can select a worker compiled before this coordinator
    // existed. The worker does not execute the parent's identity module.
    if (
      logical === 'worker' &&
      owned === 'core/parse-cache-identity.ts' &&
      !inventory.inspect(path.join(root, relative))
    )
      continue;
    inventory.file(path.join(root, relative), `${logical}/${relative}`, 'base');
  }
}

function collectShared(
  inventory: ParseArtifactInventory,
  buildRoot: string,
  logical: string,
  kind: 'source' | 'distribution',
): void {
  if (kind === 'distribution') {
    inventory.tree(path.join(buildRoot, '_shared'), `${logical}/shared-runtime`, 'base');
    return;
  }
  const sharedRoot = inventory.packageRoot(path.join(buildRoot, 'core'), 'gitnexus-shared');
  if (!sharedRoot) throw new Error('Required parser package is unavailable: gitnexus-shared');
  inventory.file(path.join(sharedRoot, 'package.json'), `${logical}/shared-manifest`, 'base');
  const sourceRoot = path.join(sharedRoot, 'src');
  const distributionRoot = path.join(sharedRoot, 'dist');
  const isSharedInput = (candidate: string) =>
    artifacts.isInside(sourceRoot, candidate) || artifacts.isInside(distributionRoot, candidate);
  const manifest = inventory.manifest(sharedRoot) as { exports?: unknown; main?: string };
  const validateTargets = (target: unknown): void => {
    if (target === null || target === undefined) return;
    if (typeof target === 'string') {
      if (!target.startsWith('./') || !isSharedInput(path.resolve(sharedRoot, target)))
        throw new Error('Shared parser export is outside its declared source/distribution roots');
    } else if (typeof target === 'object') {
      for (const value of Object.values(target)) validateTargets(value);
    } else throw new Error('Unverifiable shared parser export target');
  };
  validateTargets(
    manifest.exports ?? (manifest.main ? `./${manifest.main.replace(/^\.\//, '')}` : undefined),
  );
  const resolved = createRequire(
    pathToFileURL(path.join(buildRoot, 'core/run-analyze.ts')),
  ).resolve('gitnexus-shared');
  if (!isSharedInput(realpathSync.native(resolved)))
    throw new Error('Shared parser runtime resolved outside its declared roots');
  // require.resolve and ESM imports can choose different export branches.
  // Inventory their canonical owned roots, not only the require entry's folder.
  inventory.tree(distributionRoot, `${logical}/shared-runtime`, 'base');
  inventory.tree(sourceRoot, `${logical}/shared-contracts`, 'base');
}

/** Resolve once before cache use. No worker is spawned and no native module is evaluated. */
export function resolveParseCacheIdentity(
  analyzerModuleUrl: string,
  options: ParseCacheIdentityResolveOptions = {},
): ParseCacheIdentityResolution {
  try {
    const inventory = new ParseArtifactInventory(options);
    const modulePath = realpathSync.native(fileURLToPath(analyzerModuleUrl));
    const build = artifacts.resolveBuildRoot(modulePath);
    const implUrl = pathToFileURL(
      path.join(
        build.buildRoot,
        'core/ingestion/pipeline-phases',
        build.kind === 'source' ? 'parse-impl.ts' : 'parse-impl.js',
      ),
    ).href;
    const workerUrl = resolveParseWorkerUrl(implUrl, options.workerUrlForTest);
    const { executablePath, ...runtime } = artifacts.resolveRuntimeVariant();
    const nativePaths = options.nativeRuntimePathsForTest ?? {
      executable: executablePath,
      alpineMarker: '/etc/alpine-release',
    };
    const alpine =
      (process.env.npm_config_platform || process.platform) === 'linux' &&
      inventory.inspect(nativePaths.alpineMarker) !== null;
    const environment = effectiveEnvironment(
      options.skipOptionalGrammars ?? process.env.GITNEXUS_SKIP_OPTIONAL_GRAMMARS ?? '',
      alpine,
    );
    const loaderOverrides = Object.keys(process.env)
      .filter((name) => name.endsWith('_PREBUILD'))
      .sort()
      .map((name) => [name, process.env[name]]);
    const memoKey = JSON.stringify([
      modulePath,
      workerUrl.href,
      options.traversalLimits ?? {},
      runtime,
      environment,
      loaderOverrides,
      nativePaths,
    ]);
    const previous = identityMemo.get(memoKey);
    if (previous) {
      try {
        previous.inventory.verify();
        if (resolveParseWorkerUrl(implUrl, options.workerUrlForTest).href !== workerUrl.href)
          throw new Error('Parser worker selection changed during identity capture');
        return {
          ok: true,
          identity: { ...previous.identity },
          workerUrl: new URL(previous.workerUrl),
        };
      } catch {
        identityMemo.delete(memoKey); // Changed or unverifiable inputs must be resolved again, never reused.
      }
    }
    // node-gyp-build falls back here if the package has no matching binary.
    // Keep its entire candidate tree under a location-independent logical name;
    // absence is guarded too, so a later fallback cannot reuse an old receipt.
    const fallback = path.join(path.dirname(nativePaths.executable), 'prebuilds');
    if (inventory.inspect(fallback))
      inventory.tree(fallback, 'native-executable-prebuilds', 'base');
    else inventory.frames.base.push(['native-executable-prebuilds-absent']);
    const workerPath = realpathSync.native(fileURLToPath(workerUrl));
    const workerBuild = artifacts.resolveBuildRoot(workerPath);
    if (workerBuild.packageRoot !== build.packageRoot)
      throw new Error('Parser worker resolved outside its installation');
    collectBuild(inventory, build.buildRoot, 'parent', build.kind);
    collectShared(inventory, build.buildRoot, 'parent', build.kind);
    if (workerBuild.buildRoot !== build.buildRoot) {
      collectBuild(inventory, workerBuild.buildRoot, 'worker', workerBuild.kind);
      collectShared(inventory, workerBuild.buildRoot, 'worker', workerBuild.kind);
    }
    inventory.file(
      workerPath,
      `selected-worker/${workerBuild.kind}/${slash(path.relative(workerBuild.buildRoot, workerPath))}`,
      'base',
    );
    inventory.dependencyTrees(
      build.packageRoot,
      path.join(build.buildRoot, 'core/tree-sitter'),
      'parent-packages',
    );
    if (workerBuild.buildRoot !== build.buildRoot)
      inventory.dependencyTrees(
        workerBuild.packageRoot,
        path.join(workerBuild.buildRoot, 'core/tree-sitter'),
        'worker-packages',
      );
    inventory.frames.base.push(['runtime', JSON.stringify(runtime)], ...environment);
    const componentHash = (component: Component) =>
      artifacts.hashCanonicalFrames([
        [FORMAT, component, build.kind, workerBuild.kind],
        ...inventory.frames[component].sort((a, b) =>
          compare(JSON.stringify(a), JSON.stringify(b)),
        ),
      ]);
    const identity = { base: componentHash('base'), pdg: componentHash('pdg') };
    inventory.verify();
    if (resolveParseWorkerUrl(implUrl, options.workerUrlForTest).href !== workerUrl.href)
      throw new Error('Parser worker selection changed during identity capture');
    identityMemo.set(memoKey, { inventory, identity, workerUrl });
    if (identityMemo.size > 4) identityMemo.delete(identityMemo.keys().next().value!);
    return { ok: true, identity: { ...identity }, workerUrl: new URL(workerUrl) };
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) };
  }
}

/** A publication check includes the alternate compiled worker, unlike source-only analyzer freshness. */
export function finalizeParseCacheIdentity(
  analyzerModuleUrl: string,
  startedWith: ParseCacheIdentity,
  options: ParseCacheIdentityResolveOptions = {},
): ParseCacheIdentity {
  const final = resolveParseCacheIdentity(analyzerModuleUrl, options);
  if (final.ok === false || !isDeepStrictEqual(final.identity, startedWith)) {
    throw new Error(
      `Parser build changed during analysis; refusing to publish reusable output.${final.ok === false ? ` ${final.reason}` : ''}`,
    );
  }
  return final.identity;
}

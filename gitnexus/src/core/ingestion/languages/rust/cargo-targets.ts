/** Cargo target evidence for the name-guess veto, never a directory heuristic. */
import fs from 'node:fs/promises';
import path from 'node:path';
import { glob, escape } from 'glob';
import { parse } from 'smol-toml';
import Parser from 'tree-sitter';
import { SupportedLanguages } from 'gitnexus-shared';
import { getLanguageGrammar } from '../../../tree-sitter/parser-loader.js';
import { parseSourceSafe } from '../../../tree-sitter/safe-parse.js';
import { readRepoControlFile } from '../../../../config/repo-control-file.js';
import { rustModuleFiles, rustPublicUses } from './cargo-module-files.js';

const MAX_FILES = 100_000;
type Table = Record<string, unknown>;
const table = (value: unknown): value is Table =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

/** A target is identified by its entry file, not its package directory. */
export function cargoTargetRoots(
  manifest: string,
  content: string,
  files: ReadonlySet<string>,
  workspaceEditions?: ReadonlyMap<string, string>,
): readonly string[] | undefined {
  let data: Table;
  try {
    data = parse(content);
  } catch {
    return undefined;
  }
  if (!table(data.package)) return table(data.workspace) ? [] : undefined;
  const pkg = data.package;
  if (typeof pkg.name !== 'string') return undefined;
  if (pkg.build !== undefined && typeof pkg.build !== 'string' && typeof pkg.build !== 'boolean')
    return undefined;
  const dir = path.posix.dirname(manifest);
  let edition: unknown = pkg.edition ?? '2015';
  if (table(edition) && edition.workspace === true) {
    let workspace =
      typeof pkg.workspace === 'string' ? path.posix.join(dir, pkg.workspace, '.') : dir;
    while (
      !workspaceEditions?.has(workspace) &&
      typeof pkg.workspace !== 'string' &&
      workspace !== '.'
    ) {
      workspace = path.posix.dirname(workspace);
    }
    edition = workspaceEditions?.get(workspace);
  }
  if (typeof edition !== 'string' || !['2015', '2018', '2021', '2024'].includes(edition))
    return undefined;
  const relative = (file: string): string => path.posix.normalize(path.posix.join(dir, file));
  const roots = new Set<string>();
  for (const [kind, folder] of [
    ['lib', 'src'],
    ['bin', 'src/bin'],
    ['test', 'tests'],
    ['bench', 'benches'],
    ['example', 'examples'],
  ] as const) {
    const autoKey = {
      lib: 'autolib',
      bin: 'autobins',
      test: 'autotests',
      bench: 'autobenches',
      example: 'autoexamples',
    }[kind];
    if (pkg[autoKey] !== undefined && typeof pkg[autoKey] !== 'boolean') return undefined;
    const discovered = new Map<string, string>();
    if (kind === 'lib') {
      if (files.has(relative('src/lib.rs'))) discovered.set(pkg.name, relative('src/lib.rs'));
    } else {
      if (kind === 'bin' && files.has(relative('src/main.rs'))) {
        discovered.set(pkg.name, relative('src/main.rs'));
      }
      const prefix = `${relative(folder)}/`;
      for (const file of files) {
        if (!file.startsWith(prefix)) continue;
        const tail = file.slice(prefix.length);
        const match = /^([^/]+)\.rs$/.exec(tail) ?? /^([^/]+)\/main\.rs$/.exec(tail);
        if (match) discovered.set(match[1]!, file);
      }
    }
    const explicit = data[kind] === undefined ? [] : kind === 'lib' ? [data[kind]] : data[kind];
    if (!Array.isArray(explicit)) return undefined;
    // Cargo 2015's opt-in discovery rule is PER target kind: an explicit
    // binary does not disable integration tests, examples, benches or the lib.
    const legacy = edition === '2015' && explicit.length > 0;
    const overridden = new Set<string>();
    for (const entry of explicit) {
      if (!table(entry)) return undefined;
      const name = kind === 'lib' ? pkg.name : entry.name;
      if (typeof name !== 'string') return undefined;
      if (entry.path !== undefined && typeof entry.path !== 'string') return undefined;
      if (typeof entry.path === 'string' && path.posix.isAbsolute(entry.path)) return undefined;
      const file = typeof entry.path === 'string' ? relative(entry.path) : discovered.get(name);
      if (!file || !files.has(file)) return undefined;
      roots.add(file);
      overridden.add(name);
    }
    if (pkg[autoKey] === true || (pkg[autoKey] !== false && !legacy)) {
      for (const [name, file] of discovered) if (!overridden.has(name)) roots.add(file);
    }
  }
  // Build scripts are crates too, even when located outside src/.
  if (typeof pkg.build === 'string') {
    const file = relative(pkg.build);
    if (!files.has(file)) return undefined;
    if (roots.has(file)) return undefined; // Multiple target roles need separate identities.
    roots.add(file);
  } else if (pkg.build !== false && files.has(relative('build.rs'))) {
    if (roots.has(relative('build.rs'))) return undefined;
    roots.add(relative('build.rs'));
  }
  return [...roots];
}

class RustCargoTargets {
  constructor(
    readonly targetsByFile: ReadonlyMap<string, ReadonlySet<string>>,
    readonly rootImports: ReadonlyMap<string, ReadonlyMap<string, ReadonlySet<string>>>,
    readonly publicUsesByFile: ReadonlyMap<string, ReadonlySet<string>>,
  ) {}
}

/** Exact public-use evidence, independent of the capture's coarse reexport kind. */
export function rustCargoPubliclyReexports(
  config: unknown,
  file: string,
  module: string,
  target: string,
  kind: string,
  name: string,
): boolean {
  return (
    config instanceof RustCargoTargets &&
    config.publicUsesByFile.get(file)?.has(JSON.stringify([module, target, kind, name])) === true
  );
}

/** Positive evidence that this import names this library's ROOT, not a module
 *  elsewhere (or a binary/test entry point that cannot be imported as a lib). */
export function rustImportNamesCargoRoot(
  config: unknown,
  caller: string,
  candidate: string,
  importedModule: string,
): boolean {
  if (!(config instanceof RustCargoTargets)) return false;
  const segments = importedModule.split('::').filter(Boolean);
  if (segments.length !== 1) return false;
  for (const target of config.targetsByFile.get(caller) ?? []) {
    if (config.rootImports.get(target)?.get(segments[0]!)?.has(candidate)) return true;
  }
  return false;
}

/** Every known membership must identify this file as the entry point. A file
 *  shared as a module in another target does not have a single root role. */
export function rustIsExclusiveCargoRoot(config: unknown, file: string): boolean {
  if (!(config instanceof RustCargoTargets)) return false;
  const targets = config.targetsByFile.get(file);
  return targets?.size === 1 && targets.has(file);
}

/** Establish crate identity before the existing module-path plausibility test. */
export function rustImportReachesCargoTarget(
  config: unknown,
  caller: string,
  candidate: string,
  importedModule: string,
): boolean {
  if (!(config instanceof RustCargoTargets)) return false;
  const name = importedModule.split('::').filter(Boolean)[0];
  if (!name) return false;
  const candidates = config.targetsByFile.get(candidate);
  for (const target of config.targetsByFile.get(caller) ?? []) {
    for (const imported of config.rootImports.get(target)?.get(name) ?? []) {
      if (candidates?.has(imported)) return true;
    }
  }
  return false;
}

/** Import names are target/package-relative. A dependency alias in another
 *  package must not authorize a guess here merely because its spelling matches. */
function cargoRootImports(
  manifests: ReadonlyMap<string, Table>,
  targets: ReadonlyMap<string, readonly string[]>,
): Map<string, Map<string, Set<string>>> {
  const libraries = new Map<string, { root: string; name: string }>();
  for (const [manifest, data] of manifests) {
    if (!table(data.package)) continue;
    const lib = table(data.lib) ? data.lib : undefined;
    if (!lib && data.package.autolib === false) continue;
    const root = path.posix.join(
      path.posix.dirname(manifest),
      typeof lib?.path === 'string' ? lib.path : 'src/lib.rs',
    );
    const name = lib?.name ?? data.package.name;
    if (typeof name === 'string' && targets.get(manifest)?.includes(root)) {
      libraries.set(manifest, {
        root,
        name: name.replaceAll('-', '_'),
      });
    }
  }
  const result = new Map<string, Map<string, Set<string>>>();
  for (const [manifest, data] of manifests) {
    if (!table(data.package)) continue;
    const dir = path.posix.dirname(manifest);
    let workspace =
      typeof data.package.workspace === 'string'
        ? path.posix.join(dir, data.package.workspace, '.')
        : dir;
    while (
      !table(manifests.get(path.posix.join(workspace, 'Cargo.toml'))?.workspace) &&
      typeof data.package.workspace !== 'string' &&
      workspace !== '.'
    )
      workspace = path.posix.dirname(workspace);
    const workspaceData = manifests.get(path.posix.join(workspace, 'Cargo.toml'))?.workspace;
    const workspaceDeps =
      table(workspaceData) && table(workspaceData.dependencies) ? workspaceData.dependencies : {};
    const sections = [
      data,
      ...(table(data.target) ? Object.values(data.target).filter(table) : []),
    ];
    for (const target of targets.get(manifest) ?? []) {
      let imports = result.get(target);
      if (!imports) result.set(target, (imports = new Map()));
      const add = (name: string, root: string) => {
        let roots = imports.get(name);
        if (!roots) imports.set(name, (roots = new Set()));
        roots.add(root);
      };
      const own = libraries.get(manifest);
      const buildRoot = path.posix.join(
        dir,
        typeof data.package.build === 'string' ? data.package.build : 'build.rs',
      );
      const isBuild = data.package.build !== false && target === buildRoot;
      if (own && !isBuild) add(own.name, own.root);
      for (const section of sections) {
        // Libraries/binaries can also compile as unit-test targets, so retain
        // dev dependencies across cfg modes. Build scripts have their own
        // dependency namespace and cannot import the package's own library.
        const kinds = isBuild ? ['build-dependencies'] : ['dependencies', 'dev-dependencies'];
        for (const kind of kinds) {
          const deps = section[kind];
          if (!table(deps)) continue;
          for (const [key, declared] of Object.entries(deps)) {
            const inherited = table(declared) && declared.workspace === true;
            const dep = inherited ? workspaceDeps[key] : declared;
            if (!table(dep) || typeof dep.path !== 'string') continue;
            const dependency = libraries.get(
              path.posix.join(inherited ? workspace : dir, dep.path, 'Cargo.toml'),
            );
            if (!dependency) continue;
            // Cargo uses the dependency key whenever `package` is explicit,
            // even if it equals the package name and [lib].name differs.
            const renamed = typeof dep.package === 'string';
            add(renamed ? key.replaceAll('-', '_') : dependency.name, dependency.root);
          }
        }
      }
    }
  }
  return result;
}

/** Undefined means no complete membership proof; never interpret it as disjoint. */
export function rustFilesShareCargoTarget(
  config: unknown,
  caller: string,
  candidate: string,
): boolean | undefined {
  if (!(config instanceof RustCargoTargets)) return undefined;
  const callers = config.targetsByFile.get(caller);
  const candidates = config.targetsByFile.get(candidate);
  if (!callers || !candidates) return undefined;
  return [...callers].some((root) => candidates.has(root));
}

/**
 * Static, bounded, one-shot provider loader. No cargo/rustc, build scripts,
 * repository wrappers, or network. Parse only files reachable from Cargo roots.
 * Unknown expansion anywhere can add shared membership, so it invalidates the
 * negative proof for this snapshot rather than producing a partial veto.
 */
export async function loadRustCargoTargets(repoPath: string): Promise<unknown> {
  try {
    const root = await fs.realpath(repoPath);
    const files = new Set<string>();
    const manifests: string[] = [];
    for await (const entry of glob.iterate('**/Cargo.toml', {
      // Cargo metadata must include targets the graph scanner omits (notably
      // src/bin). An omitted target can share a source file with another crate.
      cwd: root,
      nodir: true,
      follow: false,
      posix: true,
      dot: true,
      ignore: [
        '**/.git/**',
        '**/node_modules/**',
        '**/.gitnexus/**',
        '**/target/debug/**',
        '**/target/release/**',
        '**/target/incremental/**',
        '**/target/doc/**',
        '**/target/tmp/**',
        '**/target/.fingerprint/**',
        '**/target/CACHEDIR.TAG',
      ],
    })) {
      if (files.size >= MAX_FILES) return undefined;
      files.add(entry);
      manifests.push(entry);
    }
    if (manifests.length === 0) return undefined;
    // Artifact-layout pruning (`target/debug`, `target/release`, …) must not
    // erase a source path whose segment is named `target` (`src/target/mod.rs`,
    // `[lib] path = "target/entry.rs"`, `src/bin/target/main.rs`). Re-scan
    // Cargo's auto-target slots without that filter.
    for (const manifest of manifests) {
      for await (const entry of glob.iterate(
        [
          'src/lib.rs',
          'src/main.rs',
          'src/bin/*.rs',
          'src/bin/*/main.rs',
          'tests/*.rs',
          'tests/*/main.rs',
          'benches/*.rs',
          'benches/*/main.rs',
          'examples/*.rs',
          'examples/*/main.rs',
          'build.rs',
        ],
        {
          cwd: path.join(root, path.posix.dirname(manifest)),
          nodir: true,
          follow: false,
          posix: true,
        },
      )) {
        if (files.size >= MAX_FILES) return undefined;
        files.add(path.posix.join(path.posix.dirname(manifest), entry));
      }
    }
    const read = async (file: string): Promise<string> => {
      const requested = path.resolve(root, file);
      const absolute = await fs.realpath(requested);
      const rel = path.relative(root, absolute);
      if (rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) {
        throw new Error('Cargo module outside repository');
      }
      if (absolute !== requested) throw new Error('Cargo module alias has unknown membership');
      // The shared reader validates its opened descriptor and bounds streamed
      // bytes; the outer realpath check is a separate containment/alias guard.
      const content = await readRepoControlFile(root, file);
      if (content === null) throw new Error('Cargo source disappeared');
      return content;
    };
    const contents = new Map<string, string>();
    const manifestData = new Map<string, Table>();
    const workspaceEditions = new Map<string, string>();
    for (const manifest of manifests) {
      const content = await read(manifest);
      contents.set(manifest, content);
      const data = parse(content);
      // A dependency alias can replace a std/core/alloc extern-prelude entry.
      // In that case the module walker cannot identify standard macros safely.
      const sections = [
        data,
        ...(table(data.target) ? Object.values(data.target).filter(table) : []),
      ];
      if (
        sections.some((section) =>
          ['dependencies', 'dev-dependencies', 'build-dependencies'].some(
            (kind) =>
              table(section[kind]) &&
              ['std', 'core', 'alloc'].some((name) => Object.hasOwn(section[kind], name)),
          ),
        )
      )
        return undefined;
      manifestData.set(manifest, data);
      if (
        table(data.workspace) &&
        table(data.workspace.package) &&
        typeof data.workspace.package.edition === 'string'
      ) {
        workspaceEditions.set(path.posix.dirname(manifest), data.workspace.package.edition);
      }
    }
    // Manifest discovery prunes artifacts, but explicit source paths and mod
    // declarations are authoritative candidates even beneath a `target` folder.
    // Probe only those literal paths; never crawl the artifact tree recursively.
    const discover = async (candidates: Iterable<string>): Promise<void> => {
      const patterns = [...candidates].map((file) => {
        if (
          path.posix.isAbsolute(file) ||
          file === '..' ||
          file.startsWith('../') ||
          file.includes('\\')
        )
          throw new Error('Cargo source outside repository');
        if (
          !file.endsWith('.rs') ||
          file
            .split('/')
            .some((part) => ['.git', '.gitnexus', 'node_modules'].includes(part.toLowerCase()))
        )
          throw new Error('Cargo source excluded from inventory');
        return escape(file);
      });
      for await (const entry of glob.iterate(patterns, {
        cwd: root,
        nodir: true,
        follow: false,
        posix: true,
        dot: true,
      })) {
        if (files.size >= MAX_FILES) throw new Error('Cargo file limit');
        files.add(entry);
      }
    };
    for (const [manifest, data] of manifestData) {
      const explicit = [
        data.lib,
        ...['bin', 'test', 'bench', 'example'].flatMap((kind) =>
          Array.isArray(data[kind]) ? data[kind] : [],
        ),
      ];
      const paths = explicit
        .filter(table)
        .map((entry) => entry.path)
        .filter((value): value is string => typeof value === 'string');
      if (table(data.package) && typeof data.package.build === 'string')
        paths.push(data.package.build);
      await discover(paths.map((file) => path.posix.join(path.posix.dirname(manifest), file)));
    }
    const roots = new Set<string>();
    const targetsByManifest = new Map<string, readonly string[]>();
    for (const [manifest, content] of contents) {
      const targets = cargoTargetRoots(manifest, content, files, workspaceEditions);
      if (targets === undefined) return undefined;
      targetsByManifest.set(manifest, targets);
      for (const target of targets) roots.add(target);
    }
    const parser = new Parser();
    parser.setLanguage(getLanguageGrammar(SupportedLanguages.Rust));
    const targetsByFile = new Map<string, Set<string>>();
    const publicUsesByFile = new Map<string, ReadonlySet<string>>();
    // A file may be reached conventionally AND through #[path]. Those have
    // different submodule bases, so cache and visit both contexts separately.
    const childrenByFile = new Map<string, NonNullable<ReturnType<typeof rustModuleFiles>>>();
    let visits = 0;
    for (const target of roots) {
      const pending = [{ file: target, ownsDirectory: true }];
      const visited = new Set<string>();
      while (pending.length > 0) {
        if (++visits > MAX_FILES) return undefined;
        const { file, ownsDirectory } = pending.pop()!;
        const key = `${file === target ? 'root' : ownsDirectory ? 'owned' : 'module'}:${file}`;
        if (visited.has(key)) continue;
        visited.add(key);
        let owners = targetsByFile.get(file);
        if (!owners) targetsByFile.set(file, (owners = new Set()));
        owners.add(target);
        let children = childrenByFile.get(key);
        if (!children) {
          const tree = parseSourceSafe(parser, await read(file));
          const missing = new Set<string>();
          let result = rustModuleFiles(
            tree.rootNode,
            file,
            ownsDirectory,
            files,
            missing,
            file === target,
          );
          if (result === undefined && missing.size > 0) {
            await discover(missing);
            result = rustModuleFiles(
              tree.rootNode,
              file,
              ownsDirectory,
              files,
              undefined,
              file === target,
            );
          }
          if (result === undefined) return undefined;
          publicUsesByFile.set(file, rustPublicUses(tree.rootNode));
          children = result;
          childrenByFile.set(key, children);
        }
        pending.push(...children);
      }
    }
    return new RustCargoTargets(
      targetsByFile,
      cargoRootImports(manifestData, targetsByManifest),
      publicUsesByFile,
    );
  } catch {
    // I/O, parse or containment failure cannot establish target separation.
    return undefined;
  }
}

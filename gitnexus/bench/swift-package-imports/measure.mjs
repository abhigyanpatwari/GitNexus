/**
 * Build-free bench for Swift Package.swift declaration resolve (#2964 / #2931).
 *
 * WHY THIS EXISTS. `bench/import-target`'s Swift arm never threads a
 * `resolutionConfig`. It times the no-manifest directory-segment index
 * (`getSwiftModuleIndex`) and cannot see a revert that starts scanning
 * `allFilePaths` per `import`, drops declaration-only resolve, treats
 * `https://` as a comment, or matches a target dir inside another path
 * segment (#2931). Graph output on a tiny fixture is identical either way.
 * This file is the same shape as `bench/parse-dispatch-rounds`: exact floors
 * first, ratio timing only, never a millisecond ceiling.
 *
 * ARMS:
 *
 * - `targets` / `files` / `imports` — EXACT, and they are the FLOOR.
 *   `declared_resolved` only asserts something while the corpus still has
 *   many files and imports to walk. Shrink it to one happy-path module and
 *   the resolve arm still passes, gating a property the corpus no longer has.
 *
 * - `declared_resolved` / `sdk_external` / `undeclared_external` /
 *   `empty_declared_external` / `reexport_extra` / `nested_repeat_resolved` /
 *   `first_wins` — EXACT. Declaration map hits stay hits. Foundation / UIKit
 *   and an in-repo `CoreUI` folder that is NOT in Package.swift stay
 *   external. An empty `declaredTargets` map fails every name closed. Import
 *   of a module that `@_exported import`s another unions that module's files.
 *   A `#2931` nested `Sources/Mod0` path still belongs to Mod0. Grouping
 *   assigns a two-prefix file to the FIRST target only.
 *
 * - `parse_targets` / `parse_binary_skipped` / `url_comment_targets` /
 *   `parse_complete` — EXACT. Source factories are kept; binary/plugin
 *   factories are not modules; `https://` on the same line does not hide a
 *   later `.target`.
 *
 * - `layout_fingerprint` — EXACT. sha256 over sorted `from|target->files`
 *   rows on the unique query set. Catches a target-set change that leaves
 *   the counts intact.
 *
 * - `resolve_scaling_ratio` / `strategy_scaling_ratio` / `parse_scaling_ratio`
 *   — the only timing arms, RATIOS not millisecond ceilings.
 *   `(t_4n / t_n) / 4` divides the machine out; ~1.0 is linear.
 *   Files-per-target is FIXED while target count (and therefore files and
 *   imports) grow 4x, so a hit returns a constant-size file list. A correct
 *   once-per-pass index is then linear in imports; a per-import scan of
 *   allFilePaths scores ~4. Parse scales factory count 4x on a fixed-shape
 *   manifest.
 *
 * Usage:
 *   node --import tsx bench/swift-package-imports/measure.mjs
 *   node --import tsx bench/swift-package-imports/measure.mjs --check
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { parseSwiftPackageManifest } from '../../src/core/ingestion/language-config.ts';
import { swiftPackageStrategy } from '../../src/core/ingestion/import-resolvers/configs/swift.ts';
import { resolveSwiftImportTarget } from '../../src/core/ingestion/languages/swift/import-target.ts';
import { groupSwiftFilesBySpmTarget } from '../../src/core/ingestion/languages/swift/target-grouping.ts';

const baselines = JSON.parse(readFileSync(new URL('./baselines.json', import.meta.url), 'utf8'));

const REPS = 15;
const TARGETS_SMALL = 16;
const FILES_PER_TARGET = 16;
const QUERY_REPEATS = 8;
const PARSE_TARGETS = 256;
const SCALE = 4;

function queryKinds(targetCount) {
  return [
    (t) => ({ raw: `Mod${(t + 1) % targetCount}`, expect: 'declared' }),
    () => ({ raw: 'Foundation', expect: 'sdk' }),
    () => ({ raw: 'CoreUI', expect: 'undeclared' }),
    (t) => ({ raw: `Mod${(t + 1) % targetCount}.Model`, expect: 'declared' }),
    () => ({ raw: 'UIKit', expect: 'sdk' }),
    () => ({ raw: 'Ghost', expect: 'miss' }),
  ];
}

function parsedImport(targetRaw) {
  return { kind: 'namespace', localName: targetRaw, importedName: targetRaw, targetRaw };
}

function stubFile(filePath, parsedImports = []) {
  return {
    filePath,
    moduleScope: `module:${filePath}`,
    scopes: [],
    parsedImports,
    localDefs: [],
    referenceSites: [],
  };
}

function targetMap(targetCount) {
  const targets = new Map();
  for (let t = 0; t < targetCount; t++) targets.set(`Mod${t}`, `Sources/Mod${t}`);
  return targets;
}

function declaredConfig(targets) {
  return { origin: 'package.swift', targets, declaredTargets: targets };
}

function buildCorpus(targetCount) {
  const targets = targetMap(targetCount);
  const files = [];
  const parsedFiles = [];
  for (let t = 0; t < targetCount; t++) {
    for (let i = 0; i < FILES_PER_TARGET; i++) {
      const filePath = `Sources/Mod${t}/File${i}.swift`;
      files.push(filePath);
      const imports =
        t === 0 && i === 0
          ? [{ kind: 'reexport', localName: 'Mod1', importedName: 'Mod1', targetRaw: 'Mod1' }]
          : [];
      parsedFiles.push(stubFile(filePath, imports));
    }
  }

  const foundation = 'Sources/Foundation/Thing.swift';
  const coreUi = 'Sources/CoreUI/View.swift';
  const nested = 'vendor/Sources/Mod0/Sources/Mod0/Nested.swift';
  const clash = 'Sources/Mod0/Vendor/Sources/Mod1/Clash.swift';
  for (const extra of [foundation, coreUi, nested, clash]) {
    files.push(extra);
    parsedFiles.push(stubFile(extra));
  }

  const kinds = queryKinds(targetCount);
  const queries = [];
  for (let t = 0; t < targetCount; t++) {
    for (let i = 0; i < FILES_PER_TARGET; i++) {
      const from = `Sources/Mod${t}/File${i}.swift`;
      for (let r = 0; r < QUERY_REPEATS; r++) {
        for (const kind of kinds) {
          const { raw, expect } = kind(t);
          queries.push({ from, raw, expect, unique: r === 0 && i === 0 });
        }
      }
    }
  }

  return {
    files,
    parsedFiles,
    queries,
    targets,
    config: declaredConfig(targets),
    extras: { foundation, coreUi, nested, clash },
    targetCount,
  };
}

function outcomeKey(from, raw, result) {
  if (result == null) return `${from}|${raw}-><null>`;
  const list = typeof result === 'string' ? [result] : [...result];
  return `${from}|${raw}->${list.sort().join(',')}`;
}

function resultFiles(result) {
  if (result == null) return [];
  return typeof result === 'string' ? [result] : [...result];
}

function resolveOne(query, allFilePaths, config, parsedFiles) {
  return resolveSwiftImportTarget(parsedImport(query.raw), {
    fromFile: query.from,
    allFilePaths,
    resolutionConfig: config,
    parsedFiles,
  });
}

function strategyCtx(files, config) {
  return {
    allFilePaths: new Set(files),
    allFileList: files,
    normalizedFileList: files.map((p) => p.replace(/\\/g, '/')),
    index: {},
    resolveCache: new Map(),
    configs: {
      tsconfigPaths: null,
      goModule: null,
      composerConfig: null,
      swiftPackageConfig: config,
      csharpConfigs: [],
    },
  };
}

function resolvePass(corpus) {
  const allFilePaths = new Set(corpus.files);
  let resolved = 0;
  for (const query of corpus.queries) {
    if (resolveOne(query, allFilePaths, corpus.config, corpus.parsedFiles) != null) resolved++;
  }
  return resolved;
}

function strategyPass(corpus) {
  const ctx = strategyCtx(corpus.files, corpus.config);
  let resolved = 0;
  for (const query of corpus.queries) {
    if (swiftPackageStrategy(query.raw, query.from, ctx) != null) resolved++;
  }
  return resolved;
}

function manifestFor(targetCount) {
  const rows = [];
  for (let i = 0; i < targetCount; i++) {
    rows.push(
      `    .target(name: "Mod${i}", dependencies: [.product(name: "X", package: "https://example.com/x")]),`,
    );
    if (i % 8 === 0) {
      rows.push(
        `    .binaryTarget(name: "Bin${i}", url: "https://example.com/b${i}.xcframework"),`,
      );
    }
  }
  return `let package = Package(\n  name: "Demo",\n  targets: [\n${rows.join('\n')}\n  ]\n)\n`;
}

function fastest(fn, reps) {
  fn();
  let best = Infinity;
  for (let r = 0; r < reps; r++) {
    const t0 = performance.now();
    fn();
    best = Math.min(best, performance.now() - t0);
  }
  return best;
}

function correctness(corpus) {
  const allFilePaths = new Set(corpus.files);
  const records = [];
  let declaredResolved = 0;
  let sdkExternal = 0;
  let undeclaredExternal = 0;

  const unique = corpus.queries.filter((q) => q.unique);
  for (const query of unique) {
    const result = resolveOne(query, allFilePaths, corpus.config, corpus.parsedFiles);
    records.push(outcomeKey(query.from, query.raw, result));
    if (query.expect === 'declared' && result != null) declaredResolved++;
    if (query.expect === 'sdk' && result == null) sdkExternal++;
    if (query.expect === 'undeclared' && result == null) undeclaredExternal++;
  }

  const fromOther = 'Sources/Mod2/File0.swift';
  const reexport = resultFiles(
    resolveOne({ from: fromOther, raw: 'Mod0' }, allFilePaths, corpus.config, corpus.parsedFiles),
  );
  const reexportExtra =
    reexport.includes('Sources/Mod0/File0.swift') && reexport.includes('Sources/Mod1/File0.swift')
      ? 1
      : 0;
  const nestedRepeatResolved = reexport.includes(corpus.extras.nested) ? 1 : 0;

  const empty = resolveOne(
    { from: fromOther, raw: 'Mod0' },
    allFilePaths,
    { origin: 'package.swift', targets: corpus.targets, declaredTargets: new Map() },
    corpus.parsedFiles,
  );
  const emptyDeclaredExternal = empty == null ? 1 : 0;

  const groups = groupSwiftFilesBySpmTarget(corpus.files, (p) => p, corpus.targets);
  const firstWins =
    groups.get('Mod0')?.includes(corpus.extras.clash) === true &&
    groups.get('Mod1')?.includes(corpus.extras.clash) !== true
      ? 1
      : 0;

  const parseFixed = parseSwiftPackageManifest(`
let package = Package(
    name: "Demo",
    dependencies: [.package(url: "https://example.com/foo.git", from: "1.0.0")],
    targets: [
        .target(name: "Models"),
        .target(name: "App"),
        .binaryTarget(name: "Lib", url: "https://example.com/Lib.xcframework", checksum: "abc"),
        .testTarget(name: "AppTests"),
        .plugin(name: "Gen"),
        .systemLibrary(name: "CFoo"),
    ]
)
`);
  const urlComment = parseSwiftPackageManifest(
    'let package = Package(name: "Demo", dependencies: [.package(url: "https://example.com/foo.git", from: "1.0.0")], targets: [.target(name: "T")])',
  );

  return {
    declaredResolved,
    sdkExternal,
    undeclaredExternal,
    emptyDeclaredExternal,
    reexportExtra,
    nestedRepeatResolved,
    firstWins,
    parseTargets: parseFixed.targets.size,
    parseBinarySkipped:
      parseFixed.targets.has('Lib') ||
      parseFixed.targets.has('Gen') ||
      parseFixed.targets.has('CFoo')
        ? 0
        : 1,
    urlCommentTargets: urlComment.targets.get('T') === 'Sources/T' ? 1 : 0,
    parseComplete: parseFixed.complete && urlComment.complete ? 1 : 0,
    fingerprint: createHash('sha256').update(records.sort().join('\n')).digest('hex'),
  };
}

const small = buildCorpus(TARGETS_SMALL);
const large = buildCorpus(TARGETS_SMALL * SCALE);
const shape = correctness(small);

const smallResolveMs = fastest(() => resolvePass(small), REPS);
const largeResolveMs = fastest(() => resolvePass(large), REPS);
const resolveScaling = largeResolveMs / smallResolveMs / SCALE;

const smallStrategyMs = fastest(() => strategyPass(small), REPS);
const largeStrategyMs = fastest(() => strategyPass(large), REPS);
const strategyScaling = largeStrategyMs / smallStrategyMs / SCALE;

const parseSmallSrc = manifestFor(PARSE_TARGETS);
const parseLargeSrc = manifestFor(PARSE_TARGETS * SCALE);
const parseSmall = parseSwiftPackageManifest(parseSmallSrc);
const parseLarge = parseSwiftPackageManifest(parseLargeSrc);
const smallParseMs = fastest(() => parseSwiftPackageManifest(parseSmallSrc), REPS);
const largeParseMs = fastest(() => parseSwiftPackageManifest(parseLargeSrc), REPS);
const parseScaling = largeParseMs / smallParseMs / SCALE;

const files = small.files.length;
const imports = small.queries.length;

console.log(`targets                : ${small.targetCount}  (expect ${baselines.targets})`);
console.log(`files                  : ${files}  (expect ${baselines.files})`);
console.log(`imports                : ${imports}  (expect ${baselines.imports})`);
console.log(
  `declared_resolved      : ${shape.declaredResolved}  (expect ${baselines.declared_resolved})`,
);
console.log(`sdk_external           : ${shape.sdkExternal}  (expect ${baselines.sdk_external})`);
console.log(
  `undeclared_external    : ${shape.undeclaredExternal}  (expect ${baselines.undeclared_external})`,
);
console.log(
  `empty_declared_external: ${shape.emptyDeclaredExternal}  (expect ${baselines.empty_declared_external})`,
);
console.log(
  `reexport_extra         : ${shape.reexportExtra}  (expect ${baselines.reexport_extra})`,
);
console.log(
  `nested_repeat_resolved : ${shape.nestedRepeatResolved}  (expect ${baselines.nested_repeat_resolved})`,
);
console.log(`first_wins             : ${shape.firstWins}  (expect ${baselines.first_wins})`);
console.log(`parse_targets          : ${shape.parseTargets}  (expect ${baselines.parse_targets})`);
console.log(
  `parse_binary_skipped   : ${shape.parseBinarySkipped}  (expect ${baselines.parse_binary_skipped})`,
);
console.log(
  `url_comment_targets    : ${shape.urlCommentTargets}  (expect ${baselines.url_comment_targets})`,
);
console.log(
  `parse_complete         : ${shape.parseComplete}  (expect ${baselines.parse_complete})`,
);
console.log(`layout_fingerprint     : ${shape.fingerprint}`);
console.log(
  `resolve_scaling_ratio  : ${resolveScaling.toFixed(3)}  (budget <= ${baselines.resolve_scaling_budget}; ~1.0 is linear)`,
);
console.log(
  `strategy_scaling_ratio : ${strategyScaling.toFixed(3)}  (budget <= ${baselines.strategy_scaling_budget}; ~1.0 is linear)`,
);
console.log(
  `parse_scaling_ratio    : ${parseScaling.toFixed(3)}  (budget <= ${baselines.parse_scaling_budget}; ~1.0 is linear)`,
);
console.log(
  `reps                   : ${REPS}   resolve ${smallResolveMs.toFixed(2)}ms / 4x ${largeResolveMs.toFixed(2)}ms   strategy ${smallStrategyMs.toFixed(2)}ms / 4x ${largeStrategyMs.toFixed(2)}ms   parse ${smallParseMs.toFixed(2)}ms / 4x ${largeParseMs.toFixed(2)}ms`,
);
console.log(
  `parse_scale_shape      : ${parseSmall.targets.size} -> ${parseLarge.targets.size} targets (expect ${PARSE_TARGETS} -> ${PARSE_TARGETS * SCALE})`,
);

if (process.argv.includes('--check')) {
  let failed = false;

  if (shape.fingerprint !== baselines.layout_fingerprint) {
    failed = true;
    console.error(
      `\nFAIL layout_fingerprint: ${shape.fingerprint}\n` +
        `  expected ${baselines.layout_fingerprint}\n` +
        `  Unique-query target set moved. Explain it; do not re-baseline alone.`,
    );
  }

  const exact = [
    ['targets', small.targetCount],
    ['files', files],
    ['imports', imports],
    ['declared_resolved', shape.declaredResolved],
    ['sdk_external', shape.sdkExternal],
    ['undeclared_external', shape.undeclaredExternal],
    ['empty_declared_external', shape.emptyDeclaredExternal],
    ['reexport_extra', shape.reexportExtra],
    ['nested_repeat_resolved', shape.nestedRepeatResolved],
    ['first_wins', shape.firstWins],
    ['parse_targets', shape.parseTargets],
    ['parse_binary_skipped', shape.parseBinarySkipped],
    ['url_comment_targets', shape.urlCommentTargets],
    ['parse_complete', shape.parseComplete],
  ];
  for (const [name, value] of exact) {
    if (value !== baselines[name]) {
      failed = true;
      console.error(`\nFAIL ${name}: ${value}, expected exactly ${baselines[name]}.`);
    }
  }

  if (
    small.targetCount !== baselines.targets ||
    files !== baselines.files ||
    imports !== baselines.imports
  ) {
    failed = true;
    console.error(
      `\nFAIL shape: the corpus must stay large enough that declared_resolved still measures a walk.`,
    );
  }

  if (
    parseSmall.targets.size !== PARSE_TARGETS ||
    parseLarge.targets.size !== PARSE_TARGETS * SCALE
  ) {
    failed = true;
    console.error(
      `\nFAIL parse scale shape: ${parseSmall.targets.size} -> ${parseLarge.targets.size}, ` +
        `expected ${PARSE_TARGETS} -> ${PARSE_TARGETS * SCALE}.`,
    );
  }

  if (resolveScaling > baselines.resolve_scaling_budget) {
    failed = true;
    console.error(
      `\nFAIL resolve_scaling_ratio: ${resolveScaling.toFixed(3)} exceeds ` +
        `${baselines.resolve_scaling_budget} (~1.0 is linear).\n` +
        `  resolveSwiftImportTarget grew superlinearly in file+import count — a\n` +
        `  per-import scan of allFilePaths scores ~4 here. Re-run on an idle\n` +
        `  machine before investigating, and check \`reps\` first.`,
    );
  }

  if (strategyScaling > baselines.strategy_scaling_budget) {
    failed = true;
    console.error(
      `\nFAIL strategy_scaling_ratio: ${strategyScaling.toFixed(3)} exceeds ` +
        `${baselines.strategy_scaling_budget} (~1.0 is linear).\n` +
        `  swiftPackageStrategy grew superlinearly — usually the WeakMap target\n` +
        `  index falling back to O(imports × files). Re-run idle; check \`reps\`.`,
    );
  }

  if (parseScaling > baselines.parse_scaling_budget) {
    failed = true;
    console.error(
      `\nFAIL parse_scaling_ratio: ${parseScaling.toFixed(3)} exceeds ` +
        `${baselines.parse_scaling_budget} (~1.0 is linear).\n` +
        `  parseSwiftPackageManifest grew superlinearly in factory count.\n` +
        `  Re-run on an idle machine before investigating, and check \`reps\` first.`,
    );
  }

  if (failed) process.exit(1);
  console.log('\nOK — within budget.');
}

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { builtinModules } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from '@babel/parser';
import { traverseFast, type Node } from '@babel/types';
import { describe, expect, it } from 'vitest';
import {
  PARSE_CACHE_BASE_FILES,
  PARSE_CACHE_BASE_ROOTS,
  PARSE_CACHE_PACKAGE_INPUTS,
} from '../../src/core/parse-cache-identity.js';
import { GRAMMAR_SOURCES } from '../../src/core/tree-sitter/grammar-sources.js';
import { VENDORED_GRAMMAR_PACKAGES } from '../../src/core/tree-sitter/vendored-grammars.js';

const sourceRoot = fileURLToPath(new URL('../../src/', import.meta.url));
const packageInputs = new Set<string>([
  ...PARSE_CACHE_PACKAGE_INPUTS,
  ...Object.values(GRAMMAR_SOURCES).map((source) => source.packageName),
  ...VENDORED_GRAMMAR_PACKAGES,
  'gitnexus-shared', // collectShared inventories both contracts and selected runtime roots.
]);
const builtins = new Set(builtinModules.flatMap((name) => [name, `node:${name}`]));

// Each exception is non-parser infrastructure reached by the conservative
// ingestion boundary. New outside inputs must receive an explicit decision.
const infrastructure: Record<string, string> = {
  'config/ignore-service.ts:storage/git.ts':
    'Ignore-file discovery changes the enumerated source inputs, already included in chunk keys.',
  'core/analyzer-identity.ts:storage/repo-manager.ts':
    'Type-only analyzer receipt contract; parser identity uses independent frames.',
  'core/ingestion/finalize-orchestrator.ts:storage/scope-index-store.ts':
    'Post-parse scope-tree persistence; not worker results or ParsedFile extraction.',
  'core/ingestion/scope-resolution/pipeline/run.ts:storage/scope-index-store.ts':
    'Post-parse scope-tree persistence; resolution is replayed on every cache hit.',
  'core/ingestion/pipeline.ts:core/lbug/graph-emit-sink.ts':
    'Graph streaming after cached parse output, protected by analyzer identity.',
  'core/ingestion/pipeline-phases/types.ts:core/lbug/graph-emit-sink.ts':
    'Type-only graph writer contract.',
  'core/ingestion/scope-resolution/pipeline/phase.ts:core/lbug/lbug-config.ts':
    'Native-safe graph output directory selection, not parse extraction.',
  'core/ingestion/scope-resolution/pipeline/phase.ts:core/lbug/pdg-emit-sink.ts':
    'PDG graph emission consumes cached CFG facts after extraction.',
  'types/pipeline.ts:core/lbug/graph-emit-sink.ts': 'Type-only graph writer contract.',
  'types/pipeline.ts:core/lbug/pdg-emit-sink.ts': 'Type-only graph writer contract.',
  'storage/parsedfile-store.ts:storage/fs-atomic.ts':
    'Atomic byte transport, not serialized output interpretation.',
  'storage/v8-sidecar.ts:storage/fs-atomic.ts':
    'Atomic byte transport, independently checked by envelope validation.',
};
const infrastructurePackages: Record<string, string> = {
  'config/ignore-service.ts:path-scurry':
    'Type-only glob Path contract; glob runtime dependencies are recursively hashed.',
  'core/ingestion/community-processor.ts:graphology':
    'Community detection runs after parsing and does not produce cached parser facts.',
  'core/ingestion/community-processor.ts:graphology-types': 'Type-only community graph contract.',
};
const dynamicBoundaries: Record<string, string> = {
  'core/ingestion/community-processor.ts:_require(leidenPath)':
    'Vendored Leiden runs after parsing, independently protected by analyzer freshness.',
  'core/tree-sitter/grammar-sources.ts:requireVendoredGrammar(this.packageName)':
    'The single grammar registry selects names from the separately validated vendored inventory.',
  'core/tree-sitter/grammar-sources.ts:_require(this.packageName)':
    'The single grammar registry supplies every packageName to dependencyTrees.',
  "core/tree-sitter/grammar-sources.ts:_require(path.join(root, 'src/node-types.json'))":
    'The C# package payload includes node-types.json and every native candidate.',
  'core/tree-sitter/grammar-sources.ts:_require.resolve(`${this.packageName}/package.json`)':
    'The registry package manifest is hashed alongside its entire native-loader payload.',
  'core/tree-sitter/vendored-grammars.ts:_require(vendoredGrammarDir(packageName))':
    'The validated vendored inventory is hashed in dependencyTrees.',
};

const covered = (relative: string) =>
  relative.startsWith('_shared/') ||
  PARSE_CACHE_BASE_ROOTS.some((root) => relative.startsWith(`${root}/`)) ||
  (PARSE_CACHE_BASE_FILES as readonly string[]).includes(relative);

const sourcePath = (file: string) =>
  file
    .replace(/\.d\.(ts|mts|cts)$/, '.$1')
    .replace(/\.(js|jsx|mjs|cjs)$/, (extension) => extension.replace('js', 'ts'));

function audit(relative: string, source: string): string[] {
  relative = sourcePath(relative);
  const ast = parse(source, { sourceType: 'module', plugins: ['typescript'] });
  const text = (node: Node) => source.slice(node.start ?? 0, node.end ?? 0);
  const violations: string[] = [];
  const requireNames = new Set(['require', '_require', 'requireVendoredGrammar']);
  traverseFast(ast, (node) => {
    if (
      node.type === 'VariableDeclarator' &&
      node.id.type === 'Identifier' &&
      node.init?.type === 'CallExpression' &&
      node.init.callee.type === 'Identifier' &&
      node.init.callee.name === 'createRequire'
    )
      requireNames.add(node.id.name);
  });
  // Logging only: the logger never contributes parser facts.
  const check = (specifier: string) => {
    if (builtins.has(specifier)) return;
    if (specifier.startsWith('.')) {
      const target = sourcePath(
        path.posix.normalize(path.posix.join(path.posix.dirname(relative), specifier)),
      );
      if (
        !covered(target) &&
        target !== 'core/logger.ts' &&
        !infrastructure[`${relative}:${target}`]
      )
        violations.push(`${relative} -> ${target}`);
    } else {
      const name = specifier.startsWith('@')
        ? specifier.split('/').slice(0, 2).join('/')
        : specifier.split('/')[0];
      if (!packageInputs.has(name) && !infrastructurePackages[`${relative}:${name}`])
        violations.push(`${relative} -> package:${name}`);
    }
  };
  traverseFast(ast, (node) => {
    if (
      (node.type === 'ImportDeclaration' ||
        node.type === 'ExportNamedDeclaration' ||
        node.type === 'ExportAllDeclaration') &&
      node.source
    ) {
      check(node.source.value);
    } else if (node.type === 'TSImportType') {
      check(node.source.value);
    } else if (
      node.type === 'TSImportEqualsDeclaration' &&
      node.moduleReference.type === 'TSExternalModuleReference'
    ) {
      check(node.moduleReference.expression.value);
    } else if (node.type === 'ImportExpression') {
      if (node.source.type === 'StringLiteral') check(node.source.value);
      else violations.push(`${relative} -> dynamic:${text(node)}`);
    } else if (
      node.type === 'CallExpression' &&
      ((node.callee.type === 'Identifier' && requireNames.has(node.callee.name)) ||
        (node.callee.type === 'MemberExpression' &&
          node.callee.object.type === 'Identifier' &&
          requireNames.has(node.callee.object.name) &&
          node.callee.property.type === 'Identifier' &&
          node.callee.property.name === 'resolve'))
    ) {
      const specifier = node.arguments[0];
      if (specifier?.type === 'StringLiteral') check(specifier.value);
      else if (!dynamicBoundaries[`${relative}:${text(node)}`])
        violations.push(`${relative} -> dynamic:${text(node)}`);
    } else if (
      node.type === 'NewExpression' &&
      node.callee.type === 'Identifier' &&
      node.callee.name === 'URL' &&
      node.arguments[1] &&
      text(node.arguments[1]) === 'import.meta.url'
    ) {
      const specifier = node.arguments[0];
      if (specifier?.type === 'StringLiteral') check(specifier.value);
      else violations.push(`${relative} -> dynamic-asset:${text(node)}`);
    }
  });
  return violations;
}

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const candidate = path.join(directory, entry.name);
    return entry.isDirectory()
      ? sourceFiles(candidate)
      : /\.(?:[cm]?[jt]s|[jt]sx)$/.test(entry.name)
        ? [candidate]
        : [];
  });
}

describe('parse artifact input ownership', () => {
  it('classifies every local import, re-export, literal dynamic import and runtime asset', () => {
    const buildRoots = [sourceRoot];
    const distRoot = path.resolve(sourceRoot, '../dist');
    if (existsSync(path.join(distRoot, 'core/ingestion'))) buildRoots.push(distRoot);
    const violations = buildRoots.flatMap((root) => {
      const compiled = root === distRoot;
      const files = new Set([
        ...PARSE_CACHE_BASE_ROOTS.flatMap((owned) => sourceFiles(path.join(root, owned))),
        ...PARSE_CACHE_BASE_FILES.map((file) =>
          path.join(
            root,
            compiled
              ? file.replace(/\.(ts|tsx|mts|cts)$/, (extension) => extension.replace('ts', 'js'))
              : file,
          ),
        ),
      ]);
      return [...files]
        .filter(existsSync)
        .flatMap((file) =>
          audit(path.relative(root, file).split(path.sep).join('/'), readFileSync(file, 'utf8')),
        );
    });
    expect([...new Set(violations)].sort()).toEqual([]);
  });

  it.each([
    ['ts', 'ts'],
    ['tsx', 'tsx'],
    ['js', 'ts'],
    ['jsx', 'tsx'],
    ['mts', 'mts'],
    ['cts', 'cts'],
    ['mjs', 'mts'],
    ['cjs', 'cts'],
  ])('discovers and audits outside imports in .%s files', (extension, sourceExtension) => {
    const root = mkdtempSync(path.join(tmpdir(), 'parse-input-coverage-'));
    try {
      const directory = path.join(root, 'core/ingestion');
      mkdirSync(directory, { recursive: true });
      const file = path.join(directory, `new-provider.${extension}`);
      writeFileSync(file, `import '../../outside.${extension}';`);
      const files = sourceFiles(root);
      expect(files).toEqual([file]);
      expect(
        files.flatMap((entry) =>
          audit(path.relative(root, entry).split(path.sep).join('/'), readFileSync(entry, 'utf8')),
        ),
      ).toEqual([`core/ingestion/new-provider.${sourceExtension} -> outside.${sourceExtension}`]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it.each([
    "import { parse } from '../../outside.js';",
    "export * from '../../outside.js';",
    "const parser = import('../../outside.js');",
    "const parser = require('../../outside.js');",
    "const grammar = new URL('../../outside.wasm', import.meta.url);",
    'const parser = import(providerPath);',
    'const parser = require(providerPath);',
    'const load = createRequire(import.meta.url); const parser = load(providerPath);',
    "const parser = require.resolve('../../outside.js');",
    'const grammar = new URL(grammarPath, import.meta.url);',
  ])('fails when a new input escapes ownership: %s', (source) => {
    expect(audit('core/ingestion/new-provider.ts', source)).toHaveLength(1);
  });

  it('accepts newly added providers and CFG dependencies inside the owned roots', () => {
    expect(
      audit(
        'core/ingestion/new-provider.ts',
        "export * from './languages/new.js'; import('./cfg/new.js');",
      ),
    ).toEqual([]);
  });

  it('uses existing loader inventories and explicit readable ownership roots', () => {
    for (const file of PARSE_CACHE_BASE_FILES)
      expect(existsSync(path.join(sourceRoot, file)), file).toBe(true);
    for (const source of Object.values(GRAMMAR_SOURCES)) {
      expect(source.packageName).toMatch(/^tree-sitter-/);
      expect(typeof source.load).toBe('function');
    }
  });
});

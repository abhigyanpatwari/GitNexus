/**
 * Soundness of the persisted `import X` narrowing, over every Swift fixture
 * this suite can reach: the `swift-*` resolution fixtures, the T1 layouts and
 * matrix, and the size fixture. Each fixture is analyzed twice, with the
 * narrowing and without it (every file of an imported module keeps its edge),
 * and two properties must hold for every (importer, module file) pair the
 * narrowing drops:
 *
 * - no CALLS, ACCESSES, EXTENDS or IMPLEMENTS edge leads from the importer
 *   into the file, except where a documented drop says so;
 * - an oracle, written independently of `name-facts.ts`, finds no declaration
 *   of the file, at any depth, whose name the importer writes in the way that
 *   reaches it: a top-level or extension-member name (or an extension
 *   subscript label) among the importer's identifiers, a static or enum case
 *   among its implicit members, a custom operator among its operator tokens.
 *   Instance members of type bodies are not counted: they are reached through
 *   their type, and a value of inferred type is a documented drop. A name the
 *   importer writes that a top-level `typealias` of another candidate file
 *   declares stands, one hop on, for the names on the alias's right.
 *
 * The first property sees only uses that leave a resolved edge; the second
 * also sees many that leave none (enum cases, implicit statics, operators,
 * aliases). The oracle does not model extended types reached by spelling the
 * type (`extTypes`); T1 pins those.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getRelationships, runPipelineFromRepo, writeFixtureRepo } from './helpers.js';
import {
  DROPS_FIXTURE,
  FANOUT_LAYOUTS,
  fanoutFixture,
  localsFixture,
  matrixFixture,
  NAMES_FIXTURE,
  NEGATIVES_FIXTURE,
  SAME_NAMED_TYPES,
  sizeFixture,
  UNKNOWN_FIXTURE,
} from './swift-fanout-fixtures.js';
import { swiftScopeResolver } from '../../../src/core/ingestion/languages/swift/scope-resolver.js';
import { getSwiftParser } from '../../../src/core/ingestion/languages/swift/query.js';
import { preprocessSwiftConditionalDirectives } from '../../../src/core/ingestion/languages/swift/conditional-directive-preprocess.js';
import type { SyntaxNode } from '../../../src/core/ingestion/utils/ast-helpers.js';
import { isLanguageAvailable } from '../../../src/core/tree-sitter/parser-loader.js';
import { SupportedLanguages } from '../../../src/config/supported-languages.js';

const swiftAvailable = isLanguageAvailable(SupportedLanguages.Swift);
const IMPORT_REASON = 'swift-scope: import';
const FIXTURE_ROOT = path.resolve(__dirname, '../../fixtures/lang-resolution');

function readTree(dir: string): Record<string, string> {
  const files: Record<string, string> = {};
  const walk = (current: string): void => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else
        files[path.relative(dir, full).split(path.sep).join('/')] = fs.readFileSync(full, 'utf8');
    }
  };
  walk(dir);
  return files;
}

const FIXTURES: readonly { readonly name: string; readonly files: () => Record<string, string> }[] =
  [
    ...fs
      .readdirSync(FIXTURE_ROOT)
      .filter((name) => name.startsWith('swift-'))
      .sort()
      .map((name) => ({ name, files: () => readTree(path.join(FIXTURE_ROOT, name)) })),
    ...FANOUT_LAYOUTS.map((layout) => ({
      name: `fanout: ${layout.name}`,
      files: () => fanoutFixture(layout),
    })),
    { name: 'fanout: names', files: () => NAMES_FIXTURE },
    { name: 'fanout: unknown declarations', files: () => UNKNOWN_FIXTURE },
    { name: 'fanout: negatives', files: () => NEGATIVES_FIXTURE },
    { name: 'fanout: documented drops', files: () => DROPS_FIXTURE },
    { name: 'fanout: matrix', files: () => matrixFixture('Kit') },
    {
      name: 'fanout: matrix beside same-named types',
      files: () => matrixFixture('Kit', SAME_NAMED_TYPES),
    },
    { name: 'fanout: shared local names', files: () => localsFixture() },
    { name: 'fanout: size', files: () => sizeFixture() },
  ];

/** Pairs the narrowing drops on purpose (`on-demand-imports.ts`), as
 *  `fixture|importer|target`. */
const DOCUMENTED_DROPS: ReadonlyMap<string, string> = new Map([
  [
    'fanout: documented drops|App/Inferred.swift|Drop/Runner.swift',
    'type-body member reached through a value of inferred type',
  ],
  [
    'fanout: documented drops|App/CrossImportAlias.swift|Core/Money.swift',
    'alias to a type of another import statement; the hop stays within one statement',
  ],
  ...['InheritedLocal', 'InheritedParam', 'InheritedInside'].map(
    (importer) =>
      [
        `fanout: documented drops|App/${importer}.swift|Drop/Base.swift`,
        'superclass member reached through a subclass; CALLS remains',
      ] as const,
  ),
]);

interface Analysis {
  readonly kept: ReadonlySet<string>;
  readonly all: ReadonlySet<string>;
  readonly edges: readonly { type: string; pair: string; row: string }[];
}

const pairKey = (from: string, to: string) => `${from}|${to}`;

async function analyze(files: Record<string, string>): Promise<Analysis> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gitnexus-swift-soundness-'));
  const hooks = swiftScopeResolver as { onDemandImportTargets?: unknown };
  const narrowing = hooks.onDemandImportTargets;
  try {
    writeFixtureRepo(root, files);
    const narrowed = await runPipelineFromRepo(root, () => {});
    hooks.onDemandImportTargets = undefined;
    const full = await runPipelineFromRepo(root, () => {});
    const imports = (result: typeof narrowed) =>
      new Set(
        getRelationships(result, 'IMPORTS')
          .filter((e) => e.rel.reason === IMPORT_REASON)
          .map((e) => pairKey(e.sourceFilePath, e.targetFilePath)),
      );
    return {
      kept: imports(narrowed),
      all: imports(full),
      edges: ['CALLS', 'ACCESSES', 'EXTENDS', 'IMPLEMENTS'].flatMap((type) =>
        getRelationships(narrowed, type)
          .filter((e) => e.sourceFilePath !== e.targetFilePath)
          .map((e) => ({
            type,
            pair: pairKey(e.sourceFilePath, e.targetFilePath),
            row: `${type} ${e.source}@${e.sourceFilePath}->${e.target}@${e.targetFilePath}`,
          })),
      ),
    };
  } finally {
    hooks.onDemandImportTargets = narrowing;
    fs.rmSync(root, { recursive: true, force: true });
  }
}

// ── The oracle: an independent reading of what a file declares and uses ──

const STANDARD_OPERATORS = new Set(
  '== != < > <= >= + - * / % += -= *= /= %= && || ! ... ..< ?? ~= === !== & | ^ ~ << >> = ?'.split(
    ' ',
  ),
);
const strip = (name: string) =>
  name.length > 2 && name.startsWith('`') && name.endsWith('`') ? name.slice(1, -1) : name;
const isOperator = (node: SyntaxNode) =>
  node.type === 'custom_operator' ||
  (!node.isNamed && /^[-+*/%=<>!&|^~?.]{2,}$|^[-+*/%<>!&|^~]$/.test(node.type));
const operatorText = (node: SyntaxNode) =>
  node.type === 'custom_operator' ? node.text : node.type;

function parse(source: string): SyntaxNode {
  return getSwiftParser().parse(preprocessSwiftConditionalDirectives(source), undefined, {
    bufferSize: 8 * 1024 * 1024,
  }).rootNode as unknown as SyntaxNode;
}

function hidden(node: SyntaxNode): boolean {
  return node.namedChildren.some(
    (child) =>
      child?.type === 'modifiers' &&
      child.namedChildren.some(
        (modifier) =>
          modifier?.type === 'visibility_modifier' && /^(private|fileprivate)$/.test(modifier.text),
      ),
  );
}

function isStatic(node: SyntaxNode): boolean {
  return node.children.some(
    (child) =>
      child?.type === 'static' ||
      (child?.type === 'modifiers' && /\b(static|class)\b/.test(child.text)),
  );
}

/** Names a file declares: `named` (reached by writing the name anywhere),
 *  `implicit` (statics and enum cases, reached as `.name`), `ops`. */
function declaredNames(source: string) {
  const named = new Set<string>();
  const implicit = new Set<string>();
  const ops = new Set<string>();
  type Context = 'top' | 'type' | 'extension';
  const stack: { node: SyntaxNode; context: Context }[] = parse(source)
    .namedChildren.filter((child): child is SyntaxNode => child !== null)
    .map((node) => ({ node, context: 'top' as Context }));
  const bindings = (node: SyntaxNode) => {
    const out: string[] = [];
    const pending = node.childrenForFieldName('name');
    while (pending.length > 0) {
      const next = pending.pop()!;
      if (next.type === 'simple_identifier') out.push(strip(next.text));
      else if (next.type === 'pattern') pending.push(...(next.namedChildren as SyntaxNode[]));
    }
    return out;
  };
  while (stack.length > 0) {
    const { node, context } = stack.pop()!;
    if (node.type === 'operator_declaration') {
      for (const token of node.children)
        if (token !== null && isOperator(token)) ops.add(operatorText(token));
      continue;
    }
    if (hidden(node)) continue;
    const memberName = (name: string) => {
      if (context === 'type') {
        if (isStatic(node)) implicit.add(name);
      } else named.add(name);
    };
    switch (node.type) {
      case 'class_declaration':
      case 'protocol_declaration': {
        const isExtension = node.childForFieldName('declaration_kind')?.type === 'extension';
        const name = node.childForFieldName('name');
        if (!isExtension && name?.type === 'type_identifier' && context !== 'type')
          named.add(strip(name.text));
        const body = node.childForFieldName('body');
        for (const member of body?.namedChildren ?? [])
          if (member !== null)
            stack.push({ node: member, context: isExtension ? 'extension' : 'type' });
        break;
      }
      case 'typealias_declaration': {
        const name = node.childForFieldName('name');
        if (name !== null && context !== 'type') named.add(strip(name.text));
        break;
      }
      case 'macro_declaration':
      case 'precedence_group_declaration': {
        const name = node.namedChildren.find((child) => child?.type === 'simple_identifier');
        if (name) named.add(strip(name.text));
        break;
      }
      case 'function_declaration': {
        const name = node.childForFieldName('name');
        if (name === null) break;
        if (isOperator(name)) {
          if (!STANDARD_OPERATORS.has(operatorText(name))) ops.add(operatorText(name));
        } else memberName(strip(name.text));
        break;
      }
      case 'property_declaration':
        for (const name of bindings(node)) memberName(name);
        break;
      case 'enum_entry':
        for (const name of node.childrenForFieldName('name')) implicit.add(strip(name.text));
        break;
      case 'subscript_declaration':
        if (context === 'extension')
          for (const parameter of node.namedChildren) {
            const label =
              parameter?.type === 'parameter' ? parameter.childForFieldName('external_name') : null;
            if (label !== null && label !== undefined && label.text !== '_')
              named.add(strip(label.text));
          }
        break;
    }
  }
  return { named, implicit, ops };
}

/** Names a file writes, outside its imports. */
function writtenNames(source: string) {
  const ids = new Set<string>();
  const implicit = new Set<string>();
  const ops = new Set<string>();
  const stack: SyntaxNode[] = [parse(source)];
  while (stack.length > 0) {
    const node = stack.pop()!;
    if (node.type === 'import_declaration') continue;
    if (node.type === 'simple_identifier' || node.type === 'type_identifier')
      ids.add(strip(node.text));
    else if (isOperator(node)) ops.add(operatorText(node));
    else if (
      node.type === '.' &&
      !['navigation_suffix', 'user_type', 'identifier'].includes(node.parent?.type ?? '') &&
      node.nextSibling !== null
    ) {
      // The member is the first word of the next node: an identifier, or a
      // keyword written as one (`.true`, `.nil`, `.repeat(1)`).
      let leaf: SyntaxNode = node.nextSibling;
      while (leaf.childCount > 0 && leaf.firstChild !== null) leaf = leaf.firstChild;
      const word = strip(leaf.isNamed ? leaf.text : leaf.type);
      if (/^[A-Za-z_]\w*$/.test(word)) implicit.add(word);
    }
    for (const child of node.children) if (child !== null) stack.push(child);
  }
  return { ids, implicit, ops };
}

/** The names each top-level, non-private `typealias` of a file stands for. */
function aliasesIn(source: string): Map<string, Set<string>> {
  const aliases = new Map<string, Set<string>>();
  for (const node of parse(source).namedChildren) {
    if (node?.type !== 'typealias_declaration' || hidden(node)) continue;
    const [name, ...right] = node.childrenForFieldName('name');
    if (name === undefined) continue;
    const names = new Set<string>();
    const stack = [...right];
    while (stack.length > 0) {
      const next = stack.pop()!;
      if (next.type === 'type_identifier') names.add(strip(next.text));
      for (const child of next.namedChildren) if (child !== null) stack.push(child);
    }
    aliases.set(strip(name.text), names);
  }
  return aliases;
}

/** The top-level type and value names a file declares. */
function topLevelNames(source: string): Set<string> {
  const names = new Set<string>();
  for (const node of parse(source).namedChildren) {
    if (node === null || hidden(node)) continue;
    if (node.childForFieldName('declaration_kind')?.type === 'extension') continue;
    const name = node.childForFieldName('name');
    if (name !== null && /identifier$/.test(name.type)) names.add(strip(name.text));
  }
  return names;
}

const intersect = (a: ReadonlySet<string>, b: ReadonlySet<string>) =>
  [...a].filter((x) => b.has(x));

describe.skipIf(!swiftAvailable)('Swift import X narrowing is sound on every fixture', () => {
  const analyses = new Map<string, Analysis>();
  beforeAll(async () => {
    for (const fixture of FIXTURES) analyses.set(fixture.name, await analyze(fixture.files()));
  }, 600000);
  afterAll(() => analyses.clear());

  it('reaches at least one dropped pair in most fixtures that import a module', () => {
    const withDrops = [...analyses.values()].filter((a) => a.all.size > a.kept.size).length;
    expect(withDrops).toBeGreaterThanOrEqual(10);
  });

  it.each(FIXTURES.map((fixture) => fixture.name))(
    '%s: every resolved edge into a module file keeps its IMPORTS pair',
    (name) => {
      const analysis = analyses.get(name)!;
      const violations = analysis.edges
        .filter((edge) => analysis.all.has(edge.pair) && !analysis.kept.has(edge.pair))
        .filter((edge) => !DOCUMENTED_DROPS.has(`${name}|${edge.pair}`))
        .map((edge) => edge.row);
      expect(violations).toEqual([]);
    },
  );

  it.each(FIXTURES.map((fixture) => fixture.name))(
    '%s: no dropped file declares a name the importer writes in a way that reaches it',
    (name) => {
      const analysis = analyses.get(name)!;
      const files = FIXTURES.find((fixture) => fixture.name === name)!.files();
      const violations: string[] = [];
      const memo = <T>(read: (source: string) => T) => {
        const cache = new Map<string, T>();
        return (file: string): T => {
          let value = cache.get(file);
          if (value === undefined) cache.set(file, (value = read(files[file] ?? '')));
          return value;
        };
      };
      const declaredOf = memo(declaredNames);
      const writtenOf = memo(writtenNames);
      const aliasesOf = memo(aliasesIn);
      const topOf = memo(topLevelNames);
      const candidatesOf = new Map<string, string[]>();
      for (const pair of analysis.all) {
        const [from, file] = pair.split('|') as [string, string];
        candidatesOf.set(from, [...(candidatesOf.get(from) ?? []), file]);
      }
      // One alias hop: names the importer reaches through an alias that a
      // candidate file of the importer declares.
      const aliasTargets = new Map<string, Set<string>>();
      const throughAlias = (importer: string) => {
        let names = aliasTargets.get(importer);
        if (names !== undefined) return names;
        names = new Set<string>();
        for (const file of candidatesOf.get(importer) ?? [])
          for (const [alias, right] of aliasesOf(file))
            if (writtenOf(importer).ids.has(alias)) for (const n of right) names.add(n);
        aliasTargets.set(importer, names);
        return names;
      };
      for (const pair of analysis.all) {
        if (analysis.kept.has(pair) || DOCUMENTED_DROPS.has(`${name}|${pair}`)) continue;
        const [importer, target] = pair.split('|') as [string, string];
        const declared = declaredOf(target);
        const written = writtenOf(importer);
        const shared = [
          ...intersect(declared.named, written.ids),
          ...intersect(declared.implicit, written.implicit),
          ...intersect(declared.ops, written.ops),
          ...intersect(topOf(target), throughAlias(importer)).map((n) => `${n} (alias)`),
        ];
        if (shared.length > 0) violations.push(`${pair}: ${shared.sort().join(', ')}`);
      }
      expect(violations).toEqual([]);
    },
  );
});

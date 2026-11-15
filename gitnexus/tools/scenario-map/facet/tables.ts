/**
 * Production tables and numeric constants for the input facet (Layer 2, U6, R5, KTD6, design
 * §5.3 rule 3).
 *
 * A table is one list of values written in one production file:
 *  - a string array (at least two string elements, and at least 80% of its elements strings);
 *  - the entries of `new Set([...])` and the keys of `new Map([[k, v], ...])`, strings or numbers
 *    (D3: Set/Map entries are tables, never named constants);
 *  - the keys of an object literal with at least three properties (D3);
 *  - the string cases of a `switch`;
 *  - the word alternatives of a regex literal or of `new RegExp('…')` (`(?:get|set)`).
 * Array, switch and regex tables keep strings of two characters or more; Set, Map and object-key
 * tables keep every non-empty string. A table has at least two values.
 *
 * Property columns: across the run's production files, the string values of every array (or
 * `new Set([...])`) written as an object property's value, grouped by the property key
 * (`prop:<key>`), the descriptor and provider columns of the language registry. Generic keys
 * (`name`, `type`, `kind` …) and columns over 300 values are left out.
 *
 * Numeric constants (the ±1 rule of KTD6): every numeric literal of a production file, negated
 * under a unary minus, and every outermost arithmetic expression Babel's `evaluate()` folds with
 * confidence (`2 * 50`, `LIMIT + 1` over a `const`). Literals inside Set/Map entries and numeric
 * object keys are tables (D3), not constants.
 *
 * {@link TableIndex} searches for the best-fit table of a value tier by tier (design §5.3 rule
 * 3): the test's executed production files, then its static import closure up to two hops, then
 * the property columns. Within a tier the table that holds the most of the test's literals wins,
 * then the larger one; tables are never pooled across files.
 *
 * Library only; input-facet.ts builds one {@link TableIndex} per run.
 */
import { parse } from '@babel/parser';
import traverse, { type NodePath } from '@babel/traverse';
import * as t from '@babel/types';
import { byText } from '../util.js';

/** A value as a table holds it: `s:<text>` for strings, `n:<String(number)>` for numbers. */
export type LiteralKey = string;

export const stringKey = (value: string): LiteralKey => `s:${value}`;
export const numberKey = (value: number): LiteralKey => `n:${String(value)}`;

export interface ProductionTable {
  /** `<repo path>#<index in the file>`, or `prop:<key>` for a property column. */
  id: string;
  values: ReadonlySet<LiteralKey>;
}

export interface FileFacts {
  /** Repo path. */
  file: string;
  tables: ProductionTable[];
  /** Numeric constants for the ±1 rule. */
  constants: ReadonlySet<number>;
  /** Property key → string values of arrays written as that property's value. */
  columns: ReadonlyMap<string, readonly string[]>;
}

/** Where a test's best-fit table is searched, in tier order (repo paths of production files). */
export interface TableSearch {
  /** Production files the test executed (Layer 1 provenance). */
  executed: readonly string[];
  /** Production files within two hops of the test file's static imports. */
  closure: readonly string[];
}

const PLUGINS: ['typescript', 'decorators-legacy'] = ['typescript', 'decorators-legacy'];
/** Property keys whose columns mix unrelated values. */
const GENERIC_KEYS: ReadonlySet<string> = new Set([
  'name',
  'type',
  'kind',
  'id',
  'label',
  'title',
  'description',
  'message',
  'text',
  'value',
  'key',
  'path',
  'file',
  'filePath',
  'source',
  'target',
  'lang',
  'language',
  'version',
  'default',
]);
const MAX_COLUMN_SIZE = 300;
const MIN_OBJECT_KEYS = 3;

const EMPTY_FACTS = (file: string): FileFacts => ({
  file,
  tables: [],
  constants: new Set(),
  columns: new Map(),
});

/** A string literal or a plain template's text, else null. */
function stringOf(node: t.Node | null | undefined): string | null {
  if (node === null || node === undefined) return null;
  if (t.isStringLiteral(node)) return node.value;
  if (t.isTemplateLiteral(node) && node.expressions.length === 0) {
    return node.quasis[0]?.value.cooked ?? null;
  }
  return null;
}

/** A numeric literal's value, negated under a unary minus, else null. */
function numberOf(node: t.Node | null | undefined): number | null {
  if (node === null || node === undefined) return null;
  if (t.isNumericLiteral(node)) return node.value;
  if (t.isUnaryExpression(node, { operator: '-' }) && t.isNumericLiteral(node.argument)) {
    return -node.argument.value;
  }
  return null;
}

/** The words of a regex's alternations: `(?:THRU|THROUGH)`, `\b(STRING|UNSTRING)\b` … */
export function regexWords(pattern: string): string[] {
  const out = new Set<string>();
  const clean = pattern.replace(/\\[sSdDwWbB]/g, ' ').replace(/\\(.)/g, '$1');
  for (const group of clean.match(/\(([^()]*\|[^()]*)\)/g) ?? []) {
    for (const alternative of group.replace(/^\((\?[:!=<]+)?|\)$/g, '').split('|')) {
      const word = alternative.replace(/[?*+{}[\]^$.]/g, '').trim();
      if (/^[\w-]{2,}$/.test(word)) out.add(word);
    }
  }
  return [...out];
}

/** `new Set(<array>)` / `new Map(<array>)`: the entries array, else null. */
function collectionEntries(node: t.Node): { kind: 'Set' | 'Map'; array: t.ArrayExpression } | null {
  if (!t.isNewExpression(node) || !t.isIdentifier(node.callee)) return null;
  const kind = node.callee.name;
  const array = node.arguments[0];
  if ((kind !== 'Set' && kind !== 'Map') || !t.isArrayExpression(array)) return null;
  return { kind, array };
}

function objectKeyOf(property: t.Node): string | null {
  if (!t.isObjectProperty(property) && !t.isObjectMethod(property)) return null;
  if (property.computed) return stringOf(property.key);
  if (t.isIdentifier(property.key)) return property.key.name;
  if (t.isStringLiteral(property.key)) return property.key.value;
  return null;
}

interface Collected {
  tables: LiteralKey[][];
  columns: Map<string, Set<string>>;
  /** Numeric literal nodes that are table entries or keys, not constants (D3). */
  tableNumbers: Set<t.Node>;
}

function collectTables(ast: t.File): Collected {
  const tables: LiteralKey[][] = [];
  const columns = new Map<string, Set<string>>();
  const tableNumbers = new Set<t.Node>();
  const handled = new WeakSet<t.Node>();
  const add = (values: readonly (LiteralKey | null)[]): void => {
    const unique = [...new Set(values.filter((value): value is LiteralKey => value !== null))];
    if (unique.length >= 2) tables.push(unique);
  };
  const strictString = (value: string | null): LiteralKey | null =>
    value !== null && value.length >= 2 ? stringKey(value) : null;
  const looseString = (value: string | null): LiteralKey | null =>
    value !== null && value.length >= 1 ? stringKey(value) : null;
  const entryKey = (node: t.Node | null | undefined): LiteralKey | null => {
    const n = numberOf(node);
    if (n !== null && node) tableNumbers.add(t.isUnaryExpression(node) ? node.argument : node);
    return n !== null ? numberKey(n) : looseString(stringOf(node));
  };

  t.traverseFast(ast, (node) => {
    const collection = collectionEntries(node);
    if (collection !== null) {
      handled.add(collection.array);
      const { elements } = collection.array;
      if (collection.kind === 'Set') add(elements.map((element) => entryKey(element)));
      else {
        add(
          elements.map((element) =>
            t.isArrayExpression(element) ? entryKey(element.elements[0]) : null,
          ),
        );
        for (const element of elements) {
          if (t.isArrayExpression(element)) {
            t.traverseFast(element, (inner) => {
              if (t.isNumericLiteral(inner)) tableNumbers.add(inner);
            });
          }
        }
      }
    }
    if (t.isArrayExpression(node) && !handled.has(node)) {
      const strings = node.elements.map((element) => stringOf(element));
      const count = strings.filter((value) => value !== null).length;
      if (count >= 2 && count >= node.elements.length * 0.8) add(strings.map(strictString));
      const keys = node.elements.map((element) =>
        t.isArrayExpression(element) ? stringOf(element.elements[0]) : null,
      );
      if (keys.filter((key) => key !== null).length >= 2) add(keys.map(strictString));
    }
    if (t.isObjectProperty(node) && !node.computed) {
      const key = objectKeyOf(node);
      let value: t.Node = node.value;
      const set = collectionEntries(value);
      if (set !== null && set.kind === 'Set') value = set.array;
      if (key !== null && t.isArrayExpression(value)) {
        const values = value.elements
          .map((element) => stringOf(element))
          .filter((text): text is string => text !== null && text.length >= 2);
        if (values.length > 0) {
          const column = columns.get(key) ?? new Set<string>();
          for (const text of values) column.add(text);
          columns.set(key, column);
        }
      }
      if (t.isNumericLiteral(node.key)) tableNumbers.add(node.key);
    }
    if (t.isObjectExpression(node) && node.properties.length >= MIN_OBJECT_KEYS) {
      add(node.properties.map((property) => looseString(objectKeyOf(property))));
    } else if (t.isSwitchStatement(node)) {
      add(node.cases.map((switchCase) => strictString(stringOf(switchCase.test))));
    } else if (t.isRegExpLiteral(node)) {
      add(regexWords(node.pattern).map(stringKey));
    } else if (
      t.isNewExpression(node) &&
      t.isIdentifier(node.callee, { name: 'RegExp' }) &&
      node.arguments[0] !== undefined
    ) {
      const pattern = stringOf(node.arguments[0]);
      if (pattern !== null) add(regexWords(pattern).map(stringKey));
    }
  });
  return { tables, columns, tableNumbers };
}

const finite = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value);

/** Callees Babel's `evaluate()` folds (`Math.max(1, 2)`); other calls are not constants. */
const FOLDABLE_CALLEE = /^(Math|Number)\./;

function collectConstants(ast: t.File, tableNumbers: ReadonlySet<t.Node>): Set<number> {
  const constants = new Set<number>();
  const literal = (node: t.NumericLiteral, parent: t.Node | null): void => {
    if (tableNumbers.has(node)) return;
    if (t.isTSLiteralType(parent)) return;
    constants.add(t.isUnaryExpression(parent, { operator: '-' }) ? -node.value : node.value);
  };
  const fold = (path: NodePath<t.Node>): void => {
    const result = path.evaluate();
    const value: unknown = result.value;
    if (result.confident && finite(value)) constants.add(value);
  };
  try {
    traverse(ast, {
      NumericLiteral(path) {
        literal(path.node, path.parent);
      },
      BinaryExpression(path) {
        if (!t.isBinaryExpression(path.parent)) fold(path);
      },
      UnaryExpression(path) {
        if (!t.isNumericLiteral(path.node.argument)) fold(path);
      },
      CallExpression(path) {
        const callee = path.node.callee;
        const name =
          t.isMemberExpression(callee) &&
          t.isIdentifier(callee.object) &&
          t.isIdentifier(callee.property)
            ? `${callee.object.name}.${callee.property.name}`
            : '';
        if (FOLDABLE_CALLEE.test(name)) fold(path);
      },
    });
  } catch {
    // Babel's scope tracker throws on code that would not compile; keep the plain literals.
    constants.clear();
    const parents = new Map<t.Node, t.Node>();
    t.traverseFast(ast, (node) => {
      for (const key of t.VISITOR_KEYS[node.type] ?? []) {
        const child: unknown = (node as unknown as Record<string, unknown>)[key];
        const children = Array.isArray(child) ? child : [child];
        for (const c of children) if (t.isNode(c)) parents.set(c, node);
      }
      if (t.isNumericLiteral(node)) literal(node, parents.get(node) ?? null);
    });
  }
  return constants;
}

/** Tables, constants and property columns of one production source; null when it does not parse. */
export function factsOf(file: string, source: string): FileFacts {
  let ast: t.File;
  try {
    ast = parse(source, { sourceType: 'module', plugins: PLUGINS, errorRecovery: true });
  } catch {
    return EMPTY_FACTS(file);
  }
  const { tables, columns, tableNumbers } = collectTables(ast);
  return {
    file,
    tables: tables.map((values, index) => ({ id: `${file}#${index}`, values: new Set(values) })),
    constants: collectConstants(ast, tableNumbers),
    columns: new Map([...columns].map(([key, values]) => [key, [...values]])),
  };
}

export interface TableIndexOptions {
  /** Text of a repo path, null when it cannot be read. */
  read(repoPath: string): string | null;
  /** Production files of the run (repo paths): the property-column universe. */
  columnFiles: readonly string[];
}

/** Lazily parsed production facts of one run, with the tiered best-fit search. */
export class TableIndex {
  private readonly facts = new Map<string, FileFacts>();
  private columnTables: ProductionTable[] | null = null;

  constructor(private readonly options: TableIndexOptions) {}

  /** The facts of a production file; empty when it cannot be read or parsed. */
  factsOf(file: string): FileFacts {
    let facts = this.facts.get(file);
    if (facts === undefined) {
      const source = this.options.read(file);
      facts = source === null ? EMPTY_FACTS(file) : factsOf(file, source);
      this.facts.set(file, facts);
    }
    return facts;
  }

  /** The property columns over the run's production files, built on first use. */
  columns(): readonly ProductionTable[] {
    if (this.columnTables === null) {
      const merged = new Map<string, Set<string>>();
      for (const file of [...this.options.columnFiles].sort()) {
        for (const [key, values] of this.factsOf(file).columns) {
          const column = merged.get(key) ?? new Set<string>();
          for (const value of values) column.add(value);
          merged.set(key, column);
        }
      }
      this.columnTables = [...merged]
        .filter(
          ([key, values]) =>
            !GENERIC_KEYS.has(key) && values.size >= 2 && values.size <= MAX_COLUMN_SIZE,
        )
        .sort(([a], [b]) => byText(a, b))
        .map(([key, values]) => ({
          id: `prop:${key}`,
          values: new Set([...values].map(stringKey)),
        }));
    }
    return this.columnTables;
  }

  /**
   * The best-fit table holding `value`, tier by tier (executed files, two-hop closure, property
   * columns); null when no tier has one. `literals` are the test's literal keys (duplicates count).
   */
  tableOf(search: TableSearch, value: LiteralKey, literals: readonly LiteralKey[]): string | null {
    const inFiles = (files: readonly string[]): ProductionTable[] =>
      files.flatMap((file) => this.factsOf(file).tables);
    return (
      bestFit(inFiles(search.executed), value, literals) ??
      bestFit(inFiles(search.closure), value, literals) ??
      bestFit(this.columns(), value, literals)
    );
  }

  /** The numeric constants of `files`, merged. */
  constantsOf(files: readonly string[]): Set<number> {
    const merged = new Set<number>();
    for (const file of files) for (const value of this.factsOf(file).constants) merged.add(value);
    return merged;
  }

  /** Every string value of the tables of `files` (rule 1's GitNexus builtin names). */
  stringValues(files: readonly string[]): Set<string> {
    const out = new Set<string>();
    for (const file of files) {
      for (const table of this.factsOf(file).tables) {
        for (const key of table.values) if (key.startsWith('s:')) out.add(key.slice(2));
      }
    }
    return out;
  }
}

/** The table that holds `value` and most of `literals`, then the largest; first wins a tie. */
export function bestFit(
  tables: readonly ProductionTable[],
  value: LiteralKey,
  literals: readonly LiteralKey[],
): string | null {
  let best: string | null = null;
  let bestScore = 0;
  for (const table of tables) {
    if (!table.values.has(value)) continue;
    const explained = literals.filter((literal) => table.values.has(literal)).length;
    const score = explained * 1e6 + table.values.size;
    if (score > bestScore) {
      best = table.id;
      bestScore = score;
    }
  }
  return best;
}

/** True when `value - 1`, `value` or `value + 1` is one of `constants` (KTD6). */
export const nearConstant = (constants: ReadonlySet<number>, value: number): boolean =>
  constants.has(value) || constants.has(value - 1) || constants.has(value + 1);

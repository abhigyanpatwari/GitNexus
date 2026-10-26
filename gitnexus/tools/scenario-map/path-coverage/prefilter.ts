/**
 * The test files Layer 1 must run for the fingerprint (fingerprint plan E7).
 *
 * Past the path rule, a pair is a duplicate, a possible duplicate or a table row only when both
 * tests have the same checks-and-context key or a key is unknown: `checks-differ` makes every other
 * pair Distinct unless its inputs are equal (verdict/fingerprint.ts). The key is static (KTD5,
 * facet/checks.ts over the static inventory), so a file whose every test has a key no other test
 * shares needs no run. A file stays when one of its tests has a key another test shares or no key,
 * when a call's instance count is not static, when a body reads a file snapshot (the runtime full
 * name picks the entry, and the static one may differ), when it may register tests the inventory
 * cannot see ({@link registersUnseenTests}: a helper such as
 * test/helpers/rename-integration-cases.ts `defineRenameFixtureTests`), or when it did not parse.
 *
 * Given up: `different-checks` (the same path and input, other checks) between a test of a skipped
 * file and any other test; the last full run over the unit tests had none in 6,264 candidate pairs.
 * The plan and coverage stages apply it unless mutation scope is `all` or the run is the controls.
 *
 * Library only; it reads the test files and their snapshot and helper modules.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { parse, type ParserPlugin } from '@babel/parser';
import type * as t from '@babel/types';
import { checksContextKey, fsModuleReader, fsSnapshotReader } from '../facet/checks.js';
import { loadStaticInventory } from '../inventory/cases.js';
import { fromPackagePath } from '../types.js';

const PLUGINS: ParserPlugin[] = ['typescript', 'jsx', 'decorators-legacy'];

/** Callees that register tests or hooks themselves; a suite's callback registers in turn. */
const SUITES = new Set(['describe', 'suite']);
const KNOWN = new Set([
  ...SUITES,
  'it',
  'test',
  'bench',
  'beforeAll',
  'afterAll',
  'beforeEach',
  'afterEach',
  'aroundAll',
  'aroundEach',
  'vi',
  'expect',
]);

/** The identifier a call chain starts from: `it` of `it.each(rows)('t', fn)`; null otherwise. */
function rootOf(node: t.Node): string | null {
  let current = node;
  for (;;) {
    if (current.type === 'CallExpression') current = current.callee;
    else if (current.type === 'MemberExpression') current = current.object;
    else if (current.type === 'TaggedTemplateExpression') current = current.tag;
    else if (current.type === 'AwaitExpression') current = current.argument;
    else return current.type === 'Identifier' ? current.name : null;
  }
}

const DECLARATIONS = new Set([
  'ImportDeclaration',
  'ExportNamedDeclaration',
  'ExportDefaultDeclaration',
  'ExportAllDeclaration',
  'VariableDeclaration',
  'FunctionDeclaration',
  'ClassDeclaration',
  'TSInterfaceDeclaration',
  'TSTypeAliasDeclaration',
  'TSEnumDeclaration',
  'TSModuleDeclaration',
  'TSImportEqualsDeclaration',
  'TSDeclareFunction',
  'EmptyStatement',
]);

/**
 * Whether statements at a registration level (the module, a suite callback, a loop or branch in
 * either) call anything but the test API: such a call may register tests the inventory does not
 * see, so its file always runs. Declarations never register; a suite's callback is walked.
 */
export function registersUnseenTests(statements: readonly t.Statement[]): boolean {
  return statements.some((statement): boolean => {
    if (DECLARATIONS.has(statement.type)) return false;
    switch (statement.type) {
      case 'BlockStatement':
        return registersUnseenTests(statement.body);
      case 'IfStatement':
        return [statement.consequent, statement.alternate].some(
          (branch) => branch !== null && registersUnseenTests([branch]),
        );
      case 'ForStatement':
      case 'ForInStatement':
      case 'ForOfStatement':
      case 'WhileStatement':
      case 'DoWhileStatement':
        return registersUnseenTests([statement.body]);
      case 'ExpressionStatement': {
        const root = rootOf(statement.expression);
        if (root === null || !KNOWN.has(root)) return true;
        if (!SUITES.has(root) || statement.expression.type !== 'CallExpression') return false;
        const callback = statement.expression.arguments.at(-1);
        if (
          callback === undefined ||
          (callback.type !== 'ArrowFunctionExpression' && callback.type !== 'FunctionExpression')
        ) {
          return false;
        }
        return callback.body.type === 'BlockStatement'
          ? registersUnseenTests(callback.body.body)
          : true;
      }
      default:
        return true;
    }
  });
}

/** Matchers that read a `.snap` file entry named after the runtime test name. */
const FILE_SNAPSHOT = /\.(?:toMatchSnapshot|toMatchFileSnapshot|toThrowErrorMatchingSnapshot)\(/;

export interface Layer1Files {
  /** The files Layer 1 runs, in input order. */
  files: string[];
  /**
   * The others: every test has a checks-and-context key no other test shares, or (diff scope) the
   * file is neither changed nor shares a key with a changed file's test.
   */
  skipped: string[];
}

/**
 * Splits package-path test files into those Layer 1 must run and the rest. With `changed` (a
 * diff-scoped run, fingerprint plan E8) only pairs with a changed file's test count: the changed
 * files the whole-suite rule keeps, plus every file with a test whose key a changed file's test
 * has. A changed file the static view cannot vouch for finds its pairs among those files only.
 */
export function layer1Files(
  repoRoot: string,
  files: readonly string[],
  changed: ReadonlySet<string> | null = null,
): Layer1Files {
  const inventory = loadStaticInventory(repoRoot, files);
  const options = { snapshots: fsSnapshotReader(repoRoot), modules: fsModuleReader(repoRoot) };
  const keep = new Set(inventory.skipped);
  const seen = new Set(inventory.sites.map((site) => site.file));
  for (const file of files) {
    if (!seen.has(file)) {
      keep.add(file);
      continue;
    }
    const source = readFileSync(path.join(repoRoot, fromPackagePath(file)), 'utf8');
    const ast = parse(source, { sourceType: 'module', plugins: PLUGINS, errorRecovery: true });
    if (registersUnseenTests(ast.program.body)) keep.add(file);
  }
  const keys: { file: string; key: string }[] = [];
  for (const site of inventory.sites) {
    if (site.instances === null || FILE_SNAPSHOT.test(site.record.body)) {
      keep.add(site.file);
      continue;
    }
    for (const instance of site.instances) {
      const key = checksContextKey(
        { record: site.record, instance, fullName: site.fullName },
        options,
      );
      if (key === null) keep.add(site.file);
      else keys.push({ file: site.file, key });
    }
  }
  const count = new Map<string, number>();
  for (const { key } of keys) count.set(key, (count.get(key) ?? 0) + 1);
  for (const { file, key } of keys) if ((count.get(key) ?? 0) > 1) keep.add(file);
  if (changed !== null) {
    // Keys another test also has: a key only one test has pairs with nothing.
    const changedKeys = new Set(
      keys
        .filter(({ file, key }) => changed.has(file) && (count.get(key) ?? 0) > 1)
        .map(({ key }) => key),
    );
    const scoped = new Set([
      ...[...keep].filter((file) => changed.has(file)),
      ...keys.filter(({ key }) => changedKeys.has(key)).map(({ file }) => file),
    ]);
    keep.clear();
    for (const file of scoped) keep.add(file);
  }
  return {
    files: files.filter((file) => keep.has(file)),
    skipped: files.filter((file) => !keep.has(file)),
  };
}

/**
 * Enforces KTD15: code under tools/mutation/oracle/ never imports code under
 * tools/mutation/runner/ (the vitest5 runner), so gate 3 compares two independent
 * implementations. The scanner reads every direct import specifier of each oracle module with
 * @babel/parser: `import` (type-only included), `export ... from`, `import x = require()`,
 * `import()` and `require()`; a dynamic import or require with a non-literal argument fails,
 * because it cannot be checked. Relative specifiers resolve against the module's directory.
 *
 * Allowed: the scope driver (tools/mutation/driver/) and the prepare step
 * (tools/mutation/prepare/), which KTD18 lets runner and oracle share. command-run.ts (U13)
 * imports driver/run-scope.ts, which imports runner/run-manifest.ts and runner/sidecar.ts; the
 * oracle reaches those runner modules only transitively through the driver, and only this
 * direct-import rule is enforced.
 */
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from '@babel/parser';
import { describe, expect, it } from 'vitest';

const PACKAGE_DIR = fileURLToPath(new URL('../../../', import.meta.url));
const ORACLE_DIR = path.join(PACKAGE_DIR, 'tools/mutation/oracle');
const RUNNER_DIR = path.join(PACKAGE_DIR, 'tools/mutation/runner');

interface ImportSite {
  specifier: string | null;
  line: number;
}

interface Violation {
  file: string;
  line: number;
  detail: string;
}

interface AstNode {
  type: string;
  loc?: { start: { line: number } } | null;
  [key: string]: unknown;
}

const isNode = (value: unknown): value is AstNode =>
  typeof value === 'object' && value !== null && typeof Reflect.get(value, 'type') === 'string';

/** The cooked text of a template element (`{ value: { raw, cooked } }`). */
const cooked = (quasi: unknown): string => {
  const value: unknown = isNode(quasi) ? quasi.value : undefined;
  const text: unknown =
    typeof value === 'object' && value !== null ? Reflect.get(value, 'cooked') : undefined;
  return typeof text === 'string' ? text : '';
};

const literal = (node: unknown): string | null =>
  isNode(node) && node.type === 'StringLiteral' && typeof node.value === 'string'
    ? node.value
    : isNode(node) &&
        node.type === 'TemplateLiteral' &&
        Array.isArray(node.expressions) &&
        node.expressions.length === 0 &&
        Array.isArray(node.quasis)
      ? node.quasis.map(cooked).join('')
      : null;

/** Every direct import site of a module's source, in source order. */
function importSites(source: string): ImportSite[] {
  const ast = parse(source, { sourceType: 'module', plugins: ['typescript'] });
  const sites: ImportSite[] = [];
  const visit = (node: unknown): void => {
    if (Array.isArray(node)) {
      for (const child of node) visit(child);
      return;
    }
    if (!isNode(node)) return;
    const line = node.loc?.start.line ?? 0;
    const declares =
      node.type === 'ImportDeclaration' ||
      node.type === 'ExportAllDeclaration' ||
      (node.type === 'ExportNamedDeclaration' && node.source !== null);
    if (declares) sites.push({ specifier: literal(node.source), line });
    if (node.type === 'TSExternalModuleReference') {
      sites.push({ specifier: literal(node.expression), line });
    }
    if (node.type === 'ImportExpression') sites.push({ specifier: literal(node.source), line });
    const callee = node.type === 'CallExpression' && isNode(node.callee) ? node.callee : null;
    const calls =
      callee !== null &&
      (callee.type === 'Import' || (callee.type === 'Identifier' && callee.name === 'require'));
    if (calls && Array.isArray(node.arguments)) {
      sites.push({ specifier: literal(node.arguments[0]), line });
    }
    for (const [key, value] of Object.entries(node)) {
      if (key !== 'loc' && key !== 'start' && key !== 'end') visit(value);
    }
  };
  visit(ast.program);
  return sites;
}

const inside = (dir: string, file: string): boolean => {
  const relative = path.relative(dir, file);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
};

/** Import sites of `source` (a module at `file`) that reach the runner or cannot be checked. */
function boundaryViolations(file: string, source: string): Violation[] {
  return importSites(source).flatMap((site): Violation[] => {
    const at = {
      file: path.relative(PACKAGE_DIR, file).split(path.sep).join('/'),
      line: site.line,
    };
    if (site.specifier === null) return [{ ...at, detail: 'non-literal dynamic import' }];
    const relative = site.specifier.startsWith('.') || path.isAbsolute(site.specifier);
    if (!relative) return [];
    const target = path.resolve(path.dirname(file), site.specifier);
    return inside(RUNNER_DIR, target) ? [{ ...at, detail: `imports ${site.specifier}` }] : [];
  });
}

const oracleModules = (): string[] =>
  readdirSync(ORACLE_DIR, { recursive: true, encoding: 'utf8' })
    .filter((name) => /\.[cm]?[jt]s$/.test(name))
    .map((name) => path.join(ORACLE_DIR, name))
    .sort();

const SYNTHETIC = path.join(ORACLE_DIR, 'synthetic.ts');

describe('oracle boundary (KTD15)', () => {
  it('scans the oracle modules', () => {
    const names = oracleModules().map((file) => path.basename(file));
    expect(names).toEqual(
      expect.arrayContaining([
        'command-run.ts',
        'command-wrapper.ts',
        'compare.ts',
        'freeze.ts',
        'launch-single.ts',
        'oracle-classify.ts',
        'oracle-reporter.ts',
        'oracle-setup.ts',
        'probe.ts',
      ]),
    );
  });

  it('no module under oracle/ imports from runner/', () => {
    const violations = oracleModules().flatMap((file) =>
      boundaryViolations(file, readFileSync(file, 'utf8')),
    );
    expect(violations).toEqual([]);
  });

  it('command-run.ts reaches the runner only through the scope driver', () => {
    const file = path.join(ORACLE_DIR, 'command-run.ts');
    const specifiers = importSites(readFileSync(file, 'utf8')).map((site) => site.specifier);
    expect(specifiers).toEqual(expect.arrayContaining(['../driver/run-scope.js']));
  });

  it.each([
    ['a static import', 1, "import { RUNNER_NAME } from '../runner/plugin.js';"],
    ['a type-only import', 1, "import type { FileMeta } from '../runner/protocol.js';"],
    ['a re-export', 1, "export { readSidecars } from '../runner/sidecar.js';"],
    ['a star re-export', 1, "export * from '../runner/test-ids.js';"],
    ['a dynamic import', 1, "const m = await import('../runner/setup.js');"],
    ['a template-literal import', 1, 'const m = await import(`../runner/setup.js`);'],
    ['a require', 1, "const m = require('../runner/version-guard.js');"],
    ['an import-equals', 1, "import m = require('../runner/run-manifest.js');"],
    ['a longer path into the runner', 1, "import '../../mutation/runner/plugin.js';"],
    ['the runner directory itself', 1, "import '../runner';"],
    ['a non-literal dynamic import', 1, 'const m = await import(name);'],
    ['the scope driver (allowed)', 0, "import { runScope } from '../driver/run-scope.js';"],
    ['the prepare step (allowed)', 0, "import { prepare } from '../prepare/prepare.js';"],
    ['another oracle module (allowed)', 0, "import { classifyRun } from './oracle-classify.js';"],
    ['a package (allowed)', 0, "import { startVitest } from 'vitest/node';"],
    ['a sibling named like the runner (allowed)', 0, "import x from '../runner-notes/x.js';"],
  ])('a synthetic oracle module with %s has %i violation(s)', (_label, count, source) => {
    expect(boundaryViolations(SYNTHETIC, source)).toHaveLength(count);
  });

  it('reports the module and line of a violation', () => {
    const source = "import path from 'node:path';\n\nimport { x } from '../runner/plugin.js';\n";
    expect(boundaryViolations(SYNTHETIC, source)).toEqual([
      {
        file: 'tools/mutation/oracle/synthetic.ts',
        line: 3,
        detail: 'imports ../runner/plugin.js',
      },
    ]);
  });
});

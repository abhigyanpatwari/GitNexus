/**
 * Regression tests for PHP scope-resolution coverage gaps (issue #1931).
 */
import { describe, it, expect, beforeAll } from 'vitest';
import path from 'path';
import { emitPhpScopeCaptures } from '../../../src/core/ingestion/languages/php/index.js';
import type { CaptureMatch } from 'gitnexus-shared';

// ---------------------------------------------------------------------------
// F53 — comma-separated use statements
// ---------------------------------------------------------------------------

describe('F53 — comma-separated use declarations', () => {
  it('use A, B, C produces 3 import names', () => {
    const src = `<?php\nuse A, B, C;\n`;
    const matches = emitPhpScopeCaptures(src, 'test.php') as CaptureMatch[];
    const importNames = matches.filter((m) => m['@import.name']).map((m) => m['@import.name'].text);
    // A, B, C should each appear
    expect(importNames).toContain('A');
    expect(importNames).toContain('B');
    expect(importNames).toContain('C');
    expect(importNames.length).toBe(3);
  });

  it('use Foo\\Bar, Baz\\Qux as Quux produces correct names and aliases', () => {
    const src = `<?php\nuse Foo\\Bar, Baz\\Qux as Quux;\n`;
    const matches = emitPhpScopeCaptures(src, 'test.php') as CaptureMatch[];
    const importNames = matches.filter((m) => m['@import.name']).map((m) => m['@import.name'].text);
    expect(importNames).toContain('Bar');
    expect(importNames).toContain('Quux');
    expect(importNames.length).toBe(2);
    // Check alias
    const aliasImport = matches.find((m) => m['@import.alias']);
    expect(aliasImport).toBeDefined();
    expect(aliasImport!['@import.alias'].text).toBe('Quux');
  });
});

// ---------------------------------------------------------------------------
// F54 — enum cases
// ---------------------------------------------------------------------------

describe('F54 — enum case declarations', () => {
  it('enum case captures @declaration.const with case name', () => {
    const src = `<?php\nenum Role { case Admin; case Editor; }\n`;
    const matches = emitPhpScopeCaptures(src, 'test.php') as CaptureMatch[];
    const cases = matches.filter((m) => m['@declaration.const']);
    expect(cases.length).toBe(2);
    const names = cases.map((m) => m['@declaration.name'].text).sort();
    expect(names).toEqual(['Admin', 'Editor']);
  });

  it('enum_declaration still emits @scope.class and @declaration.enum', () => {
    const src = `<?php\nenum Role { case Admin; }\n`;
    const matches = emitPhpScopeCaptures(src, 'test.php') as CaptureMatch[];
    const scopes = matches.filter((m) => m['@scope.class']);
    const enumScope = scopes.find((m) => m['@scope.class']?.text.includes('enum'));
    expect(enumScope).toBeDefined();
    const enumDecl = matches.filter((m) => m['@declaration.enum']);
    expect(enumDecl.length).toBe(1);
    expect(enumDecl[0]['@declaration.name'].text).toBe('Role');
  });

  it('backed enum (with value) still captures case name', () => {
    const src = `<?php\nenum Role: string { case Admin = 'admin'; }\n`;
    const matches = emitPhpScopeCaptures(src, 'test.php') as CaptureMatch[];
    const cases = matches.filter((m) => m['@declaration.const']);
    expect(cases.length).toBe(1);
    expect(cases[0]['@declaration.name'].text).toBe('Admin');
  });
});

// ---------------------------------------------------------------------------
// F55 — anonymous class scope
// ---------------------------------------------------------------------------

describe('F55 — anonymous class scope', () => {
  it('anonymous class emits @scope.class', () => {
    const src = `<?php\n$s = new class { public function run() {} };\n`;
    const matches = emitPhpScopeCaptures(src, 'test.php') as CaptureMatch[];
    const classScopes = matches.filter((m) => m['@scope.class']);
    expect(classScopes.length).toBe(1);
  });

  it('method inside anonymous class has @scope.function', () => {
    const src = `<?php\n$s = new class { public function run() {} };\n`;
    const matches = emitPhpScopeCaptures(src, 'test.php') as CaptureMatch[];
    const fnScopes = matches.filter((m) => m['@scope.function']);
    // Method-scoping regression guard — pre-existing, not F55-specific.
    expect(fnScopes.length).toBeGreaterThanOrEqual(1);
  });
});

// ---------------------------------------------------------------------------
// F55 — anonymous class pipeline test (runPipelineFromRepo)
// ---------------------------------------------------------------------------

describe('F55 — anonymous class pipeline graph output', () => {
  let importResult: any;

  beforeAll(async () => {
    // Dynamic import to avoid loading helpers at module level (transitive
    // tree-sitter-dart import fails when the optional grammar is missing).
    const { FIXTURES, getNodesByLabel, getRelationships, runPipelineFromRepo } =
      await import('./helpers.js');
    const result = await runPipelineFromRepo(path.join(FIXTURES, 'php-anonymous-class'), () => {});
    importResult = { result, getNodesByLabel, getRelationships };
  }, 60000);

  it('creates a Method node for the anonymous class execute method', () => {
    const { result, getNodesByLabel } = importResult;
    const methods = getNodesByLabel(result, 'Method');
    expect(methods).toContain('execute');
  });

  it('$service->execute() produces a CALLS edge', () => {
    const { result, getRelationships } = importResult;
    const calls = getRelationships(result, 'CALLS');
    const executeCall = calls.find((e: any) => e.target === 'execute');
    expect(executeCall).toBeDefined();
  });

  it('the CALLS edge source is resolved (not MISSING)', () => {
    const { result, getRelationships } = importResult;
    const calls = getRelationships(result, 'CALLS');
    const executeCall = calls.find((e: any) => e.target === 'execute');
    expect(executeCall).toBeDefined();
    expect(executeCall!.source).not.toBe('MISSING');
  });
});

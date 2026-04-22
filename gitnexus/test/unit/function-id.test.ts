import { describe, it, expect } from 'vitest';
import Parser from 'tree-sitter';
import Go from 'tree-sitter-go';
import { SupportedLanguages } from 'gitnexus-shared';
import { getProvider } from '../../src/core/ingestion/languages/index.js';
import {
  computeFunctionArityId,
  findDescendant,
} from '../../src/core/ingestion/utils/ast-helpers.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function parseGo(code: string): { tree: Parser.Tree; parser: Parser } {
  const parser = new Parser();
  parser.setLanguage(Go);
  const tree = parser.parse(code);
  return { tree, parser };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('computeFunctionArityId', () => {
  const provider = getProvider(SupportedLanguages.Go);

  it('generates correct ID for Go receiver method with zero params (issue #986)', () => {
    const code = [
      'package example',
      '',
      'type Example struct{}',
      '',
      'func (e *Example) Caller() {',
      '  callee()',
      '}',
    ].join('\n');

    const { tree } = parseGo(code);

    const methodDecl = findDescendant(tree.rootNode, 'method_declaration');
    expect(methodDecl).not.toBeNull();

    const id = computeFunctionArityId(methodDecl!, 'example.go', provider, SupportedLanguages.Go);
    expect(id).toBe('Method:example.go:Example.Caller#0');
  });

  it('generates correct ID for Go function (no receiver)', () => {
    const code = ['package example', '', 'func callee() {}'].join('\n');

    const { tree } = parseGo(code);
    const funcDecl = findDescendant(tree.rootNode, 'function_declaration');
    expect(funcDecl).not.toBeNull();

    const id = computeFunctionArityId(funcDecl!, 'util.go', provider, SupportedLanguages.Go);
    expect(id).toBe('Function:util.go:callee');
  });

  it('generates correct ID for Go receiver method with params', () => {
    const code = [
      'package example',
      '',
      'type Service struct{}',
      '',
      'func (s *Service) Handle(name string, age int) {',
      '  doWork()',
      '}',
    ].join('\n');

    const { tree } = parseGo(code);
    const methodDecl = findDescendant(tree.rootNode, 'method_declaration');
    expect(methodDecl).not.toBeNull();

    const id = computeFunctionArityId(methodDecl!, 'service.go', provider, SupportedLanguages.Go);
    expect(id).toBe('Method:service.go:Service.Handle#2');
  });
});

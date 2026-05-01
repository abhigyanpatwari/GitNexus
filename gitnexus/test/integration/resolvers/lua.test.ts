/**
 * Lua: basic pipeline integration — functions, methods, imports, calls.
 * Verifies that the Lua language provider correctly parses module-pattern
 * classes, colon-syntax methods, require() imports, and cross-file calls.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import path from 'path';
import {
  FIXTURES,
  getRelationships,
  getNodesByLabel,
  edgeSet,
  runPipelineFromRepo,
  type PipelineResult,
} from './helpers.js';
import { isLanguageAvailable } from '../../../src/core/tree-sitter/parser-loader.js';
import { SupportedLanguages } from '../../../src/config/supported-languages.js';

const luaAvailable = isLanguageAvailable(SupportedLanguages.Lua);

describe.skipIf(!luaAvailable)('Lua pipeline integration', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(path.join(FIXTURES, 'lua-app'), () => {});
  }, 60000);

  it('detects Lua files', () => {
    const files = getNodesByLabel(result, 'File');
    expect(files).toContain('main.lua');
    expect(files).toContain('user.lua');
    expect(files).toContain('service.lua');
  });

  it('extracts functions and methods', () => {
    const functions = getNodesByLabel(result, 'Function');
    const methods = getNodesByLabel(result, 'Method');
    const allSymbols = [...functions, ...methods];
    expect(allSymbols).toContain('main');
    expect(allSymbols).toContain('new');
    expect(allSymbols).toContain('greet');
    expect(allSymbols).toContain('get_email');
    expect(allSymbols).toContain('create_user');
    expect(allSymbols).toContain('process');
  });

  it('extracts require() import edges', () => {
    const imports = getRelationships(result, 'IMPORTS');
    const importEdges = edgeSet(imports);
    expect(importEdges.length).toBeGreaterThanOrEqual(1);
  });

  it('extracts call edges', () => {
    const calls = getRelationships(result, 'CALLS');
    expect(calls.length).toBeGreaterThanOrEqual(1);
    const callNames = calls.map((c) => c.target);
    expect(callNames).toContain('main');
  });
});

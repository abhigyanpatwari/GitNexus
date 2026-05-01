/**
 * Scala: basic pipeline integration — classes, traits, objects, methods, imports, calls.
 * Verifies that the Scala language provider correctly parses JVM-style code
 * with class/trait/object definitions, method extraction, and cross-file calls.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import path from 'path';
import {
  FIXTURES,
  getRelationships,
  getNodesByLabel,
  runPipelineFromRepo,
  type PipelineResult,
} from './helpers.js';
import { isLanguageAvailable } from '../../../src/core/tree-sitter/parser-loader.js';
import { SupportedLanguages } from '../../../src/config/supported-languages.js';

const scalaAvailable = isLanguageAvailable(SupportedLanguages.Scala);

describe.skipIf(!scalaAvailable)('Scala pipeline integration', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(path.join(FIXTURES, 'scala-app'), () => {});
  }, 60000);

  it('detects Scala files', () => {
    const files = getNodesByLabel(result, 'File');
    expect(files).toContain('Main.scala');
    expect(files).toContain('User.scala');
    expect(files).toContain('UserService.scala');
  });

  it('extracts classes, traits, and objects', () => {
    const classes = getNodesByLabel(result, 'Class');
    const interfaces = getNodesByLabel(result, 'Interface');
    expect(classes).toContain('User');
    expect(classes).toContain('UserService');
    expect(classes).toContain('Main');
    expect(interfaces).toContain('Greeter');
  });

  it('extracts methods', () => {
    const methods = getNodesByLabel(result, 'Method');
    expect(methods).toContain('greet');
    expect(methods).toContain('getEmail');
    expect(methods).toContain('create');
    expect(methods).toContain('createUser');
    expect(methods).toContain('process');
    expect(methods).toContain('main');
  });

  it('extracts call edges', () => {
    const calls = getRelationships(result, 'CALLS');
    expect(calls.length).toBeGreaterThanOrEqual(1);
    const callNames = calls.map((c) => c.target);
    expect(callNames).toContain('create');
  });

  it('extracts cross-file calls', () => {
    const calls = getRelationships(result, 'CALLS');
    const callNames = calls.map((c) => c.target);
    expect(callNames).toContain('createUser');
    expect(callNames).toContain('process');
  });
});

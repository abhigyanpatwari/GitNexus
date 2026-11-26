import { readFileSync } from 'node:fs';
import Parser from 'tree-sitter';
import TypeScript from 'tree-sitter-typescript';
import { collectFunctionCfgs } from '../../../../src/core/ingestion/cfg/collect.js';
import { getProvider } from '../../../../src/core/ingestion/languages/index.js';
import { SupportedLanguages } from '../../../../src/config/supported-languages.js';
import type { FunctionCfg } from '../../../../src/core/ingestion/cfg/types.js';

export const cfgFixture = new URL(
  '../../../../test/fixtures/compiler-conformance/typescript-control-flow/',
  import.meta.url,
);

export function cfgsOfFile(file: string): readonly FunctionCfg[] {
  const visitor = getProvider(SupportedLanguages.TypeScript).cfgVisitor;
  if (!visitor) throw new Error('Missing TypeScript control-flow visitor');
  const source = readFileSync(new URL(file, cfgFixture), 'utf8');
  const parser = new Parser();
  parser.setLanguage(TypeScript.typescript);
  return collectFunctionCfgs(parser.parse(source).rootNode, visitor, file).cfgs;
}

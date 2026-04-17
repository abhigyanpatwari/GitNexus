/**
 * Structural Extractor Module
 *
 * Reuses ingestion pipeline's AST-based MethodExtractor / FieldExtractor
 * to extract method and field names for embedding text generation.
 */

import { getProviderForFile } from '../ingestion/languages/index.js';
import type { MethodExtractorContext, ExtractedMethods } from '../ingestion/method-types.js';
import type { FieldExtractorContext, ExtractedFields } from '../ingestion/field-types.js';
import type { LanguageProvider } from '../ingestion/language-provider.js';
import { buildTypeEnv } from '../ingestion/type-env.js';
import { SupportedLanguages } from 'gitnexus-shared';
import { ensureAndParse, findDeclarationNode } from './ast-utils.js';

export interface StructuralNames {
  methodNames: string[];
  fieldNames: string[];
}

const NOOP_SYMBOL_TABLE = {
  lookupExactAll: () => [],
  lookupExact: () => undefined,
  lookupExactFull: () => undefined,
} as any;

/**
 * Extract method and field names from a class/struct/interface node
 * using the ingestion pipeline's AST extractors.
 */
export const extractStructuralNames = async (
  content: string,
  filePath: string,
): Promise<StructuralNames> => {
  const provider = getProviderForFile(filePath);
  if (!provider) return { methodNames: [], fieldNames: [] };

  const tree = await ensureAndParse(content, filePath);
  if (!tree) return { methodNames: [], fieldNames: [] };

  // Parse node.content (a snippet) — find declaration directly, not by range
  const classNode = findDeclarationNode(tree.rootNode);
  if (!classNode) return { methodNames: [], fieldNames: [] };

  const language = provider.id;

  const methodNames = extractMethodNames(classNode, provider, filePath, language);
  const fieldNames = extractFieldNames(classNode, provider, tree, filePath, language);

  return { methodNames, fieldNames };
};

function extractMethodNames(
  classNode: any,
  provider: LanguageProvider,
  filePath: string,
  language: SupportedLanguages,
): string[] {
  if (!provider.methodExtractor) return [];

  const context: MethodExtractorContext = { filePath, language };
  const result: ExtractedMethods | null = provider.methodExtractor.extract(classNode, context);
  if (!result?.methods?.length) return [];

  return result.methods.map((m) => m.name);
}

function extractFieldNames(
  classNode: any,
  provider: LanguageProvider,
  tree: any,
  filePath: string,
  language: SupportedLanguages,
): string[] {
  if (!provider.fieldExtractor) return [];

  const typeEnv = buildTypeEnv(tree, language);

  const context: FieldExtractorContext = {
    typeEnv,
    symbolTable: NOOP_SYMBOL_TABLE,
    filePath,
    language,
  };
  const result: ExtractedFields | null = provider.fieldExtractor.extract(classNode, context);
  if (!result?.fields?.length) return [];

  return result.fields.map((f) => f.name);
}

import path from 'path';
import {
  SupportedLanguages,
  type CaptureMatch,
  type ParsedImport,
  type ParsedTypeBinding,
} from 'gitnexus-shared';
import Parser from 'tree-sitter';
import { defineLanguage } from '../language-provider.js';
import type { ImportResolverFn } from '../import-resolvers/types.js';
import { getLanguageGrammar } from '../../tree-sitter/parser-loader.js';
import { parseSourceSafe } from '../../tree-sitter/safe-parse.js';
import { assertCloneable } from '../workers/clone-safety.js';
import { preprocessObjectiveCMacroMarkers } from './objective-c/macro-marker-preprocess.js';
import {
  buildObjectiveCSemanticGraph,
  buildObjectiveCScopeCaptures,
  collectObjectiveCCaptureSideChannel,
  collectObjectiveCFacts,
  parseObjCType,
  setObjectiveCFileFacts,
} from './objective-c/facts.js';

const OBJECTIVE_C_SCOPE_QUERY = `((translation_unit) @objc.root)`;

const EMPTY_TYPE_CONFIG = {
  declarationNodeTypes: new Set<string>(),
  extractDeclaration: () => null,
  extractParameter: () => null,
};

const noImportResolution: ImportResolverFn = () => null;

function normalizedExt(filePath: string): string {
  return path.extname(filePath).toLowerCase();
}

function isObjectiveCSourcePath(filePath: string): boolean {
  const ext = normalizedExt(filePath);
  return ext === '.m' || ext === '.mm';
}

function isHeaderPath(filePath: string): boolean {
  return normalizedExt(filePath) === '.h';
}

const OBJECTIVE_C_HEADER_NODE_TYPES = new Set([
  'class_declaration',
  'class_interface',
  'class_implementation',
  'compatibility_alias_declaration',
  'module_import',
  'protocol_declaration',
]);

const OBJECTIVE_C_HEADER_DIRECTIVES = [
  '@class',
  '@compatibility_alias',
  '@import',
  '@implementation',
  '@interface',
  '@protocol',
];

function hasObjectiveCHeaderSyntax(sourceText: string): boolean {
  try {
    const tree = parseObjectiveCSource(sourceText);
    const stack: Parser.SyntaxNode[] = [tree.rootNode];
    while (stack.length > 0) {
      const node = stack.pop();
      if (node === undefined) continue;
      if (OBJECTIVE_C_HEADER_NODE_TYPES.has(node.type)) return true;
      for (let i = node.namedChildCount - 1; i >= 0; i--) {
        const child = node.namedChild(i);
        if (child !== null) stack.push(child);
      }
    }
  } catch {
    // Keep unambiguous Objective-C headers on the normal unavailable-parser path.
    return hasObjectiveCHeaderDirective(sourceText);
  }
  return false;
}

function hasObjectiveCHeaderDirective(sourceText: string): boolean {
  let index = 0;
  let state: 'code' | 'line-comment' | 'block-comment' | 'single-quote' | 'double-quote' = 'code';

  while (index < sourceText.length) {
    const current = sourceText[index];
    const next = sourceText[index + 1];

    if (state === 'line-comment') {
      if (current === '\n' || current === '\r') state = 'code';
      index++;
      continue;
    }
    if (state === 'block-comment') {
      if (current === '*' && next === '/') {
        state = 'code';
        index += 2;
      } else {
        index++;
      }
      continue;
    }
    if (state === 'single-quote' || state === 'double-quote') {
      if (current === '\\') {
        index += 2;
      } else if (
        (state === 'single-quote' && current === "'") ||
        (state === 'double-quote' && current === '"')
      ) {
        state = 'code';
        index++;
      } else {
        index++;
      }
      continue;
    }

    if (current === '/' && next === '/') {
      state = 'line-comment';
      index += 2;
      continue;
    }
    if (current === '/' && next === '*') {
      state = 'block-comment';
      index += 2;
      continue;
    }
    if (current === "'") {
      state = 'single-quote';
      index++;
      continue;
    }
    if (current === '"') {
      state = 'double-quote';
      index++;
      continue;
    }
    if (current === '@') {
      const directive = OBJECTIVE_C_HEADER_DIRECTIVES.find((candidate) =>
        sourceText.startsWith(candidate, index),
      );
      if (directive !== undefined && !isIdentifierCharacter(sourceText[index + directive.length])) {
        return true;
      }
    }
    index++;
  }
  return false;
}

function isIdentifierCharacter(character: string | undefined): boolean {
  return character !== undefined && /[A-Za-z0-9_]/.test(character);
}

export function classifyObjectiveCFileContent(filePath: string, sourceText: string): boolean {
  if (isObjectiveCSourcePath(filePath)) return true;
  if (!isHeaderPath(filePath)) return false;
  return hasObjectiveCHeaderSyntax(sourceText);
}

function parseObjectiveCSource(sourceText: string): Parser.Tree {
  const parser = new Parser();
  parser.setLanguage(getLanguageGrammar(SupportedLanguages.ObjectiveC));
  return parseSourceSafe(
    parser,
    preprocessObjectiveCMacroMarkers(sourceText),
    undefined,
    undefined,
    'Objective-C source',
  );
}

function treeFromCachedOrSource(cachedTree: unknown, sourceText: string): Parser.Tree {
  if (cachedTree !== undefined && looksLikeTree(cachedTree)) return cachedTree;
  return parseObjectiveCSource(sourceText);
}

function looksLikeTree(value: unknown): value is Parser.Tree {
  return (
    value !== null &&
    typeof value === 'object' &&
    'rootNode' in value &&
    (value as { rootNode?: unknown }).rootNode !== undefined
  );
}

function interpretObjectiveCImport(captures: CaptureMatch): ParsedImport | null {
  const source = captures['@import.source'];
  if (source === undefined || source.text.trim().length === 0) return null;
  const targetRaw = source.text.trim();
  const kind = captures['@import.kind']?.text.trim();
  const isSystemHeader = targetRaw.startsWith('<') && targetRaw.endsWith('>');
  return {
    kind: 'side-effect',
    // Scope resolution needs to distinguish a quoted header path from a bare
    // @import module name and an angle-bracket system header. The latter stays
    // wrapped so the Objective-C resolver can fail closed instead of resolving
    // a framework header to a same-named local file.
    targetRaw:
      isSystemHeader || kind === 'module' || targetRaw.startsWith('./')
        ? targetRaw
        : `./${targetRaw}`,
  };
}

function interpretObjectiveCTypeBinding(captures: CaptureMatch): ParsedTypeBinding | null {
  const name = captures['@type-binding.name'];
  const type = captures['@type-binding.type'];
  if (name === undefined || type === undefined) return null;
  const parsed = parseObjCType(type.text);
  return {
    boundName: name.text,
    rawTypeName: parsed?.name ?? parsed?.raw ?? type.text,
    declaredSpelling: type.text,
    source: 'annotation',
  };
}

export const objectiveCProvider = defineLanguage({
  id: SupportedLanguages.ObjectiveC,
  extensions: ['.m', '.mm'],
  treeSitterQueries: OBJECTIVE_C_SCOPE_QUERY,
  typeConfig: EMPTY_TYPE_CONFIG,
  exportChecker: () => true,
  importResolver: noImportResolution,
  classifyFileContent: classifyObjectiveCFileContent,
  shouldClassifyFileContent: isHeaderPath,
  preprocessSource: preprocessObjectiveCMacroMarkers,
  importsExecuteWhereWritten: false,

  emitScopeCaptures: (sourceText, filePath, cachedTree): readonly CaptureMatch[] => {
    const tree = treeFromCachedOrSource(cachedTree, sourceText);
    const facts = collectObjectiveCFacts(tree, filePath);
    setObjectiveCFileFacts(facts);
    return buildObjectiveCScopeCaptures(facts, tree.rootNode);
  },

  collectCaptureSideChannel: (filePath) =>
    assertCloneable(collectObjectiveCCaptureSideChannel(filePath)),

  interpretImport: interpretObjectiveCImport,
  interpretTypeBinding: interpretObjectiveCTypeBinding,

  extractSemanticGraph: (tree, filePath) => {
    const facts = collectObjectiveCFacts(tree, filePath);
    setObjectiveCFileFacts(facts);
    return buildObjectiveCSemanticGraph(facts);
  },
});

import { parentPort } from 'node:worker_threads';
import Parser from 'tree-sitter';
import JavaScript from 'tree-sitter-javascript';
import TypeScript from 'tree-sitter-typescript';
import Python from 'tree-sitter-python';
import Java from 'tree-sitter-java';
import C from 'tree-sitter-c';
import CPP from 'tree-sitter-cpp';
import CSharp from 'tree-sitter-c-sharp';
import Go from 'tree-sitter-go';
import Rust from 'tree-sitter-rust';
import PHP from 'tree-sitter-php';
import Ruby from 'tree-sitter-ruby';
import { createRequire } from 'node:module';
import { SupportedLanguages } from 'gitnexus-shared';
import { getProvider } from '../languages/index.js';
import { getTreeSitterBufferSize, TREE_SITTER_MAX_BUFFER } from '../constants.js';
import { SymbolTable } from '../symbol-table.js';

/** Language grammar type accepted by Parser.setLanguage(). */
type TreeSitterLanguage = Parameters<typeof Parser.prototype.setLanguage>[0];

// tree-sitter-swift is an optionalDependency — may not be installed
const _require = createRequire(import.meta.url);
let Swift: TreeSitterLanguage | null = null;
try {
  Swift = _require('tree-sitter-swift');
} catch {}

// tree-sitter-dart is an optionalDependency — may not be installed
let Dart: TreeSitterLanguage | null = null;
try {
  Dart = _require('tree-sitter-dart');
} catch {}

// tree-sitter-kotlin is an optionalDependency — may not be installed
let Kotlin: TreeSitterLanguage | null = null;
try {
  Kotlin = _require('tree-sitter-kotlin');
} catch {}
import { getLanguageFromFilename } from 'gitnexus-shared';
import {
  FUNCTION_NODE_TYPES,
  extractFunctionName,
  getDefinitionNodeFromCaptures,
  findEnclosingClassInfo,
  type EnclosingClassInfo,
  getLabelFromCaptures,
  extractMethodSignature,
  findDescendant,
  extractStringContent,
  type SyntaxNode,
} from '../utils/ast-helpers.js';
import {
  countCallArguments,
  inferCallForm,
  extractReceiverName,
  extractReceiverNode,
  extractMixedChain,
  extractCallArgTypes,
  type MixedChainStep,
} from '../utils/call-analysis.js';
import { extractParsedCallSite } from '../call-sites/extract-language-call-site.js';
import { buildTypeEnv } from '../type-env.js';
import type { ConstructorBinding } from '../type-env.js';
import { detectFrameworkFromAST } from '../framework-detection.js';
import { generateId } from '../../../lib/utils.js';
import { preprocessImportPath } from '../import-processor.js';
import {
  extractVueScript,
  extractTemplateComponents,
  isVueSetupTopLevel,
} from '../vue-sfc-extractor.js';
import type { NamedBinding } from '../named-bindings/types.js';
import type { NodeLabel } from 'gitnexus-shared';
import type { FieldInfo, FieldExtractorContext } from '../field-types.js';
import type { MethodInfo, MethodExtractorContext } from '../method-types.js';
import { CLASS_CONTAINER_TYPES } from '../utils/ast-helpers.js';

// ============================================================================
// Types for serializable results
// ============================================================================

interface ParsedNode {
  id: string;
  label: string;
  properties: {
    name: string;
    filePath: string;
    startLine: number;
    endLine: number;
    language: SupportedLanguages;
    isExported: boolean;
    astFrameworkMultiplier?: number;
    astFrameworkReason?: string;
    description?: string;
    parameterCount?: number;
    requiredParameterCount?: number;
    returnType?: string;
    // Field/property metadata (populated by FieldExtractor)
    declaredType?: string;
    visibility?: string;
    isStatic?: boolean;
    isReadonly?: boolean;
  };
}

interface ParsedRelationship {
  id: string;
  sourceId: string;
  targetId: string;
  type: 'DEFINES' | 'HAS_METHOD' | 'HAS_PROPERTY';
  confidence: number;
  reason: string;
}

interface ParsedSymbol {
  filePath: string;
  name: string;
  nodeId: string;
  type: NodeLabel;
  parameterCount?: number;
  requiredParameterCount?: number;
  parameterTypes?: string[];
  returnType?: string;
  declaredType?: string;
  ownerId?: string;
  visibility?: string;
  isStatic?: boolean;
  isReadonly?: boolean;
  isAbstract?: boolean;
  isFinal?: boolean;
  annotations?: string[];
}

export interface ExtractedImport {
  filePath: string;
  rawImportPath: string;
  language: SupportedLanguages;
  /** Named bindings from the import (e.g., import {User as U} → [{local:'U', exported:'User'}]) */
  namedBindings?: NamedBinding[];
}

export interface ExtractedCall {
  filePath: string;
  calledName: string;
  /** generateId of enclosing function, or generateId('File', filePath) for top-level */
  sourceId: string;
  /** From call AST; omitted for some seeds (e.g. Java `::`) so arity filter is skipped */
  argCount?: number;
  /** Discriminates free function calls from member/constructor calls */
  callForm?: 'free' | 'member' | 'constructor';
  /** Simple identifier of the receiver for member calls (e.g., 'user' in user.save()) */
  receiverName?: string;
  /** Resolved type name of the receiver (e.g., 'User' for user.save() when user: User) */
  receiverTypeName?: string;
  /**
   * Unified mixed chain when the receiver is a chain of field accesses and/or method calls.
   * Steps are ordered base-first (innermost to outermost). Examples:
   *   `svc.getUser().save()`        → chain=[{kind:'call',name:'getUser'}], receiverName='svc'
   *   `user.address.save()`         → chain=[{kind:'field',name:'address'}], receiverName='user'
   *   `svc.getUser().address.save()` → chain=[{kind:'call',name:'getUser'},{kind:'field',name:'address'}]
   * Length is capped at MAX_CHAIN_DEPTH (3).
   */
  receiverMixedChain?: MixedChainStep[];
  argTypes?: (string | undefined)[];
}

export interface ExtractedAssignment {
  filePath: string;
  /** generateId of enclosing function, or generateId('File', filePath) for top-level */
  sourceId: string;
  /** Receiver text (e.g., 'user' from user.address = value) */
  receiverText: string;
  /** Property name being written (e.g., 'address') */
  propertyName: string;
  /** Resolved type name of the receiver if available from TypeEnv */
  receiverTypeName?: string;
}

export interface ExtractedHeritage {
  filePath: string;
  className: string;
  parentName: string;
  /** 'extends' | 'implements' | 'trait-impl' | 'include' | 'extend' | 'prepend' */
  kind: string;
}

export interface ExtractedRoute {
  filePath: string;
  httpMethod: string;
  routePath: string | null;
  controllerName: string | null;
  methodName: string | null;
  middleware: string[];
  prefix: string | null;
  lineNumber: number;
}

export interface ExtractedFetchCall {
  filePath: string;
  fetchURL: string;
  lineNumber: number;
}

export interface ExtractedDecoratorRoute {
  filePath: string;
  routePath: string;
  httpMethod: string;
  decoratorName: string;
  lineNumber: number;
}

export interface ExtractedToolDef {
  filePath: string;
  toolName: string;
  description: string;
  lineNumber: number;
}

export interface ExtractedORMQuery {
  filePath: string;
  orm: 'prisma' | 'supabase';
  model: string;
  method: string;
  lineNumber: number;
}

/** Constructor bindings keyed by filePath for cross-file type resolution */
export interface FileConstructorBindings {
  filePath: string;
  bindings: ConstructorBinding[];
}

/** File-scope type bindings from TypeEnv fixpoint — used for cross-file ExportedTypeMap. */
export interface FileTypeEnvBindings {
  filePath: string;
  /** [varName, typeName] pairs from file scope (scope = '') */
  bindings: [string, string][];
}

export interface ParseWorkerResult {
  nodes: ParsedNode[];
  relationships: ParsedRelationship[];
  symbols: ParsedSymbol[];
  imports: ExtractedImport[];
  calls: ExtractedCall[];
  assignments: ExtractedAssignment[];
  heritage: ExtractedHeritage[];
  routes: ExtractedRoute[];
  fetchCalls: ExtractedFetchCall[];
  decoratorRoutes: ExtractedDecoratorRoute[];
  toolDefs: ExtractedToolDef[];
  ormQueries: ExtractedORMQuery[];
  constructorBindings: FileConstructorBindings[];
  /** File-scope type bindings from TypeEnv fixpoint for exported symbol collection. */
  typeEnvBindings: FileTypeEnvBindings[];
  skippedLanguages: Record<string, number>;
  fileCount: number;
}

export interface ParseWorkerInput {
  path: string;
  content: string;
}

type WorkerIncomingMessage =
  | { type: 'sub-batch'; files: ParseWorkerInput[] }
  | { type: 'flush' }
  | ParseWorkerInput[];

// ============================================================================
// Worker-local parser + language map
// ============================================================================

const parser = new Parser();

const languageMap: Record<string, TreeSitterLanguage> = {
  [SupportedLanguages.JavaScript]: JavaScript,
  [SupportedLanguages.TypeScript]: TypeScript.typescript,
  [`${SupportedLanguages.TypeScript}:tsx`]: TypeScript.tsx,
  [SupportedLanguages.Python]: Python,
  [SupportedLanguages.Java]: Java,
  [SupportedLanguages.C]: C,
  [SupportedLanguages.CPlusPlus]: CPP,
  [SupportedLanguages.CSharp]: CSharp,
  [SupportedLanguages.Go]: Go,
  [SupportedLanguages.Rust]: Rust,
  ...(Kotlin ? { [SupportedLanguages.Kotlin]: Kotlin } : {}),
  [SupportedLanguages.PHP]: PHP.php_only,
  [SupportedLanguages.Ruby]: Ruby,
  [SupportedLanguages.Vue]: TypeScript.typescript,
  ...(Dart ? { [SupportedLanguages.Dart]: Dart } : {}),
  ...(Swift ? { [SupportedLanguages.Swift]: Swift } : {}),
};

/**
 * Check if a language grammar is available in this worker.
 * Duplicated from parser-loader.ts because workers can't import from the main thread.
 * Extra filePath parameter needed to distinguish .tsx from .ts (different grammars
 * under the same SupportedLanguages.TypeScript key).
 */
const isLanguageAvailable = (language: SupportedLanguages, filePath: string): boolean => {
  const key =
    language === SupportedLanguages.TypeScript && filePath.endsWith('.tsx')
      ? `${language}:tsx`
      : language;
  return key in languageMap && languageMap[key] != null;
};

const setLanguage = (language: SupportedLanguages, filePath: string): void => {
  const key =
    language === SupportedLanguages.TypeScript && filePath.endsWith('.tsx')
      ? `${language}:tsx`
      : language;
  const lang = languageMap[key];
  if (!lang) throw new Error(`Unsupported language: ${language}`);
  parser.setLanguage(lang);
};

// ============================================================================
// Per-file O(1) memoization — avoids repeated parent-chain walks per symbol.
// Three bare Maps cleared at file boundaries. Map.get() returns undefined for
// missing keys, so `cached !== undefined` distinguishes "not computed" from
// a stored null (enclosing class/function not found = top-level).
// ============================================================================

const classIdCache = new Map<SyntaxNode, EnclosingClassInfo | null>();
const functionIdCache = new Map<SyntaxNode, string | null>();
const exportCache = new Map<SyntaxNode, boolean>();

const clearCaches = (): void => {
  classIdCache.clear();
  functionIdCache.clear();
  exportCache.clear();
  fieldInfoCache.clear();
  methodInfoCache.clear();
};

// ============================================================================
// FieldExtractor cache — extract field metadata once per class, reuse for each property.
// Keyed by class node startIndex (unique per AST node within a file).
// ============================================================================

const fieldInfoCache = new Map<number, Map<string, FieldInfo>>();

/**
 * Walk up from a definition node to find the nearest enclosing class/struct/interface
 * AST node. Returns the SyntaxNode itself (not an ID) for passing to FieldExtractor.
 */
function findEnclosingClassNode(node: SyntaxNode): SyntaxNode | null {
  let current = node.parent;
  while (current) {
    if (CLASS_CONTAINER_TYPES.has(current.type)) {
      // Ruby singleton_class (class << self) has no name field — walk up to
      // the enclosing class/module so the caller gets a node with a findable name.
      if (current.type === 'singleton_class') {
        current = current.parent;
        continue;
      }
      return current;
    }
    current = current.parent;
  }
  return null;
}

/**
 * For C++ out-of-class method definitions (e.g. `void Foo::bar() {}`), extract the
 * class name from the qualified_identifier scope and find the class declaration in the
 * file's AST. Returns the class SyntaxNode or null if not found.
 *
 * Handles pointer/reference return types where function_declarator is nested inside
 * pointer_declarator or reference_declarator.
 */
function findClassNodeByQualifiedName(node: SyntaxNode): SyntaxNode | null {
  const declarator = node.childForFieldName('declarator');
  if (!declarator) return null;

  // Find the function_declarator, recursively unwrapping pointer_declarator /
  // reference_declarator chains (e.g. int** Foo::bar() has
  // pointer_declarator → pointer_declarator → function_declarator).
  let funcDecl: SyntaxNode | null = null;
  if (declarator.type === 'function_declarator') {
    funcDecl = declarator;
  } else {
    let current: SyntaxNode | null = declarator;
    while (current && !funcDecl) {
      for (let i = 0; i < current.namedChildCount; i++) {
        const child = current.namedChild(i);
        if (child?.type === 'function_declarator') {
          funcDecl = child;
          break;
        }
      }
      if (!funcDecl) {
        const next = current.namedChildren.find(
          (c) => c.type === 'pointer_declarator' || c.type === 'reference_declarator',
        );
        current = next ?? null;
      }
    }
  }
  if (!funcDecl) return null;

  // Check if the inner declarator is a qualified_identifier (Foo::bar)
  const innerDecl = funcDecl.childForFieldName('declarator');
  if (!innerDecl || innerDecl.type !== 'qualified_identifier') return null;

  const scope = innerDecl.childForFieldName('scope');
  if (!scope) return null;
  const className = scope.text;

  // Search the file for a matching class/struct specifier, including inside
  // namespace_definition blocks (the majority of production C++ uses namespaces).
  const root = node.tree.rootNode;
  const classTypes = new Set(['class_specifier', 'struct_specifier']);
  const searchIn = (parent: SyntaxNode): SyntaxNode | null => {
    for (let i = 0; i < parent.namedChildCount; i++) {
      const child = parent.namedChild(i);
      if (!child) continue;
      if (classTypes.has(child.type)) {
        const nameNode = child.childForFieldName('name');
        if (nameNode?.text === className) return child;
      }
      // Recurse into namespace blocks
      if (child.type === 'namespace_definition') {
        const found = searchIn(child);
        if (found) return found;
      }
    }
    return null;
  };
  return searchIn(root);
}

/**
 * Minimal no-op SymbolTable stub for FieldExtractorContext in the worker.
 * Field extraction only uses symbolTable.lookupExactAll for optional type resolution —
 * returning [] causes the extractor to use the raw type string, which is fine for us.
 */
const NOOP_SYMBOL_TABLE = {
  lookupExactAll: () => [],
  lookupExact: () => undefined,
  lookupExactFull: () => undefined,
} as unknown as SymbolTable;

/**
 * Get (or extract and cache) field info for a class node.
 * Returns a name→FieldInfo map, or undefined if the provider has no field extractor
 * or the class yielded no fields.
 */
function getFieldInfo(
  classNode: SyntaxNode,
  provider: LanguageProvider,
  context: FieldExtractorContext,
): Map<string, FieldInfo> | undefined {
  if (!provider.fieldExtractor) return undefined;

  const cacheKey = classNode.startIndex;
  let cached = fieldInfoCache.get(cacheKey);
  if (cached) return cached;

  const result = provider.fieldExtractor.extract(classNode, context);
  if (!result?.fields?.length) return undefined;

  cached = new Map<string, FieldInfo>();
  for (const field of result.fields) {
    cached.set(field.name, field);
  }
  fieldInfoCache.set(cacheKey, cached);
  return cached;
}

// ============================================================================
// MethodExtractor cache — extract method metadata once per class, reuse for each method.
// Keyed by class node startIndex (unique per AST node within a file).
// ============================================================================

const methodInfoCache = new Map<number, Map<string, MethodInfo>>();

/**
 * Get (or extract and cache) method info for a class node.
 * Returns a "name:line" → MethodInfo map, or undefined if the provider has no method extractor
 * or the class yielded no methods.
 * Keyed by name:line (not name alone) to support overloaded methods in Java/Kotlin.
 */
function getMethodInfo(
  classNode: SyntaxNode,
  provider: LanguageProvider,
  context: MethodExtractorContext,
): Map<string, MethodInfo> | undefined {
  if (!provider.methodExtractor) return undefined;

  const cacheKey = classNode.startIndex;
  let cached = methodInfoCache.get(cacheKey);
  if (cached) return cached;

  const result = provider.methodExtractor.extract(classNode, context);
  if (!result?.methods?.length) return undefined;

  cached = new Map<string, MethodInfo>();
  for (const method of result.methods) {
    cached.set(`${method.name}:${method.line}`, method);
  }
  methodInfoCache.set(cacheKey, cached);
  return cached;
}

// ============================================================================
// Enclosing function detection (for call extraction) — cached
// ============================================================================

import type { LanguageProvider } from '../language-provider.js';

/** Walk up AST to find enclosing function, return its generateId or null for top-level.
 *  Applies provider.labelOverride so the label matches the definition phase (single source of truth). */
const findEnclosingFunctionId = (
  node: SyntaxNode,
  filePath: string,
  provider: LanguageProvider,
): string | null => {
  const cached = functionIdCache.get(node);
  if (cached !== undefined) return cached;

  let current = node.parent;
  while (current) {
    if (FUNCTION_NODE_TYPES.has(current.type)) {
      const { funcName, label } = extractFunctionName(current);
      if (funcName) {
        // Apply labelOverride so label matches definition phase (e.g., Kotlin Function→Method).
        // null means "skip as definition" — keep original label for scope identification.
        let finalLabel = label;
        if (provider.labelOverride) {
          const override = provider.labelOverride(current, label);
          if (override !== null) finalLabel = override;
        }
        // Qualify with enclosing class to match definition-phase node IDs
        const classInfo = cachedFindEnclosingClassInfo(current, filePath);
        const qualifiedName = classInfo ? `${classInfo.className}.${funcName}` : funcName;
        const result = generateId(finalLabel, `${filePath}:${qualifiedName}`);
        functionIdCache.set(node, result);
        return result;
      }
    }

    // Language-specific enclosing function resolution (e.g., Dart where
    // function_body is a sibling of function_signature, not a child).
    if (provider.enclosingFunctionFinder) {
      const customResult = provider.enclosingFunctionFinder(current);
      if (customResult) {
        let finalLabel: NodeLabel = customResult.label;
        if (provider.labelOverride) {
          const override = provider.labelOverride(current.previousSibling, finalLabel);
          if (override !== null) finalLabel = override;
        }
        // Qualify custom result with enclosing class
        const classInfo = cachedFindEnclosingClassInfo(
          current.previousSibling ?? current,
          filePath,
        );
        const qualifiedName = classInfo
          ? `${classInfo.className}.${customResult.funcName}`
          : customResult.funcName;
        const result = generateId(finalLabel, `${filePath}:${qualifiedName}`);
        functionIdCache.set(node, result);
        return result;
      }
    }

    current = current.parent;
  }
  functionIdCache.set(node, null);
  return null;
};

/** Cached wrapper for findEnclosingClassInfo — avoids repeated parent walks. */
const cachedFindEnclosingClassInfo = (
  node: SyntaxNode,
  filePath: string,
): EnclosingClassInfo | null => {
  const cached = classIdCache.get(node);
  if (cached !== undefined) return cached;

  const result = findEnclosingClassInfo(node, filePath);
  classIdCache.set(node, result);
  return result;
};

/** Cached wrapper for export checking — avoids repeated parent walks per symbol. */
const cachedExportCheck = (
  checker: (node: SyntaxNode, name: string) => boolean,
  node: SyntaxNode,
  name: string,
): boolean => {
  const cached = exportCache.get(node);
  if (cached !== undefined) return cached;

  const result = checker(node, name);
  exportCache.set(node, result);
  return result;
};

// Label detection moved to shared getLabelFromCaptures in utils.ts

// DEFINITION_CAPTURE_KEYS and getDefinitionNodeFromCaptures imported from ../utils.js

// ============================================================================
// Process a batch of files
// ============================================================================

const processBatch = (
  files: ParseWorkerInput[],
  onProgress?: (filesProcessed: number) => void,
): ParseWorkerResult => {
  const result: ParseWorkerResult = {
    nodes: [],
    relationships: [],
    symbols: [],
    imports: [],
    calls: [],
    assignments: [],
    heritage: [],
    routes: [],
    fetchCalls: [],
    decoratorRoutes: [],
    toolDefs: [],
    ormQueries: [],
    constructorBindings: [],
    typeEnvBindings: [],
    skippedLanguages: {},
    fileCount: 0,
  };

  // Group by language to minimize setLanguage calls
  const byLanguage = new Map<SupportedLanguages, ParseWorkerInput[]>();
  for (const file of files) {
    const lang = getLanguageFromFilename(file.path);
    if (!lang) continue;
    let list = byLanguage.get(lang);
    if (!list) {
      list = [];
      byLanguage.set(lang, list);
    }
    list.push(file);
  }

  let totalProcessed = 0;
  let lastReported = 0;
  const PROGRESS_INTERVAL = 100; // report every 100 files

  const onFileProcessed = onProgress
    ? () => {
        totalProcessed++;
        if (totalProcessed - lastReported >= PROGRESS_INTERVAL) {
          lastReported = totalProcessed;
          onProgress(totalProcessed);
        }
      }
    : undefined;

  for (const [language, langFiles] of byLanguage) {
    const provider = getProvider(language);
    const queryString = provider.treeSitterQueries;
    if (!queryString) continue;

    // Track if we need to handle tsx separately
    const tsxFiles: ParseWorkerInput[] = [];
    const regularFiles: ParseWorkerInput[] = [];

    if (language === SupportedLanguages.TypeScript) {
      for (const f of langFiles) {
        if (f.path.endsWith('.tsx')) {
          tsxFiles.push(f);
        } else {
          regularFiles.push(f);
        }
      }
    } else {
      regularFiles.push(...langFiles);
    }

    // Process regular files for this language
    if (regularFiles.length > 0) {
      if (isLanguageAvailable(language, regularFiles[0].path)) {
        try {
          setLanguage(language, regularFiles[0].path);
          processFileGroup(regularFiles, language, queryString, result, onFileProcessed);
        } catch {
          // parser unavailable — skip this language group
        }
      } else {
        result.skippedLanguages[language] =
          (result.skippedLanguages[language] || 0) + regularFiles.length;
      }
    }

    // Process tsx files separately (different grammar)
    if (tsxFiles.length > 0) {
      if (isLanguageAvailable(language, tsxFiles[0].path)) {
        try {
          setLanguage(language, tsxFiles[0].path);
          processFileGroup(tsxFiles, language, queryString, result, onFileProcessed);
        } catch {
          // parser unavailable — skip this language group
        }
      } else {
        result.skippedLanguages[language] =
          (result.skippedLanguages[language] || 0) + tsxFiles.length;
      }
    }
  }

  return result;
};

// ============================================================================
// Laravel Route Extraction (procedural AST walk)
// ============================================================================

interface RouteGroupContext {
  middleware: string[];
  prefix: string | null;
  controller: string | null;
}

const ROUTE_HTTP_METHODS = new Set([
  'get',
  'post',
  'put',
  'patch',
  'delete',
  'options',
  'any',
  'match',
]);

const ROUTE_RESOURCE_METHODS = new Set(['resource', 'apiResource']);

// Express/Hono method names that register routes
const EXPRESS_ROUTE_METHODS = new Set([
  'get',
  'post',
  'put',
  'delete',
  'patch',
  'all',
  'use',
  'route',
]);

// HTTP client methods that are ONLY used by clients, not Express route registration.
// Methods like get/post/put/delete/patch overlap with Express — those are captured by
// the express_route handler as route definitions, not consumers. The fetch() global
// function is captured separately by the route.fetch query.
const HTTP_CLIENT_ONLY_METHODS = new Set(['head', 'options', 'request', 'ajax']);

// Decorator names that indicate HTTP route handlers (NestJS, Flask, FastAPI, Spring)
const ROUTE_DECORATOR_NAMES = new Set([
  'Get',
  'Post',
  'Put',
  'Delete',
  'Patch',
  'Route',
  'get',
  'post',
  'put',
  'delete',
  'patch',
  'route',
  'RequestMapping',
  'GetMapping',
  'PostMapping',
  'PutMapping',
  'DeleteMapping',
]);

const RESOURCE_ACTIONS = ['index', 'create', 'store', 'show', 'edit', 'update', 'destroy'];
const API_RESOURCE_ACTIONS = ['index', 'store', 'show', 'update', 'destroy'];

/** Check if node is a scoped_call_expression with object 'Route' */
function isRouteStaticCall(node: SyntaxNode): boolean {
  if (node.type !== 'scoped_call_expression') return false;
  const obj = node.childForFieldName?.('object') ?? node.children?.[0];
  return obj?.text === 'Route';
}

/** Get the method name from a scoped_call_expression or member_call_expression */
function getCallMethodName(node: SyntaxNode): string | null {
  const nameNode =
    node.childForFieldName?.('name') ?? node.children?.find((c: SyntaxNode) => c.type === 'name');
  return nameNode?.text ?? null;
}

/** Get the arguments node from a call expression */
function getArguments(node: SyntaxNode): SyntaxNode | null {
  return node.children?.find((c: SyntaxNode) => c.type === 'arguments') ?? null;
}

/** Find the closure body inside arguments */
function findClosureBody(argsNode: SyntaxNode | null): SyntaxNode | null {
  if (!argsNode) return null;
  for (const child of argsNode.children ?? []) {
    if (child.type === 'argument') {
      for (const inner of child.children ?? []) {
        if (inner.type === 'anonymous_function' || inner.type === 'arrow_function') {
          return (
            inner.childForFieldName?.('body') ??
            inner.children?.find((c: SyntaxNode) => c.type === 'compound_statement') ??
            null
          );
        }
      }
    }
    if (child.type === 'anonymous_function' || child.type === 'arrow_function') {
      return (
        child.childForFieldName?.('body') ??
        child.children?.find((c: SyntaxNode) => c.type === 'compound_statement') ??
        null
      );
    }
  }
  return null;
}

/** Extract first string argument from arguments node */
function extractFirstStringArg(argsNode: SyntaxNode | null): string | null {
  if (!argsNode) return null;
  for (const child of argsNode.children ?? []) {
    const target = child.type === 'argument' ? child.children?.[0] : child;
    if (!target) continue;
    if (target.type === 'string' || target.type === 'encapsed_string') {
      return extractStringContent(target);
    }
  }
  return null;
}

/** Extract middleware from arguments — handles string or array */
function extractMiddlewareArg(argsNode: SyntaxNode | null): string[] {
  if (!argsNode) return [];
  for (const child of argsNode.children ?? []) {
    const target = child.type === 'argument' ? child.children?.[0] : child;
    if (!target) continue;
    if (target.type === 'string' || target.type === 'encapsed_string') {
      const val = extractStringContent(target);
      return val ? [val] : [];
    }
    if (target.type === 'array_creation_expression') {
      const items: string[] = [];
      for (const el of target.children ?? []) {
        if (el.type === 'array_element_initializer') {
          const str = el.children?.find(
            (c: SyntaxNode) => c.type === 'string' || c.type === 'encapsed_string',
          );
          const val = str ? extractStringContent(str) : null;
          if (val) items.push(val);
        }
      }
      return items;
    }
  }
  return [];
}

/** Extract Controller::class from arguments */
function extractClassArg(argsNode: SyntaxNode | null): string | null {
  if (!argsNode) return null;
  for (const child of argsNode.children ?? []) {
    const target = child.type === 'argument' ? child.children?.[0] : child;
    if (target?.type === 'class_constant_access_expression') {
      return target.children?.find((c: SyntaxNode) => c.type === 'name')?.text ?? null;
    }
  }
  return null;
}

/** Extract controller class name from arguments: [Controller::class, 'method'] or 'Controller@method' */
function extractControllerTarget(argsNode: SyntaxNode | null): {
  controller: string | null;
  method: string | null;
} {
  if (!argsNode) return { controller: null, method: null };

  const args: (SyntaxNode | undefined)[] = [];
  for (const child of argsNode.children ?? []) {
    if (child.type === 'argument') args.push(child.children?.[0]);
    else if (child.type !== '(' && child.type !== ')' && child.type !== ',') args.push(child);
  }

  // Second arg is the handler
  const handlerNode = args[1];
  if (!handlerNode) return { controller: null, method: null };

  // Array syntax: [UserController::class, 'index']
  if (handlerNode.type === 'array_creation_expression') {
    let controller: string | null = null;
    let method: string | null = null;
    const elements: SyntaxNode[] = [];
    for (const el of handlerNode.children ?? []) {
      if (el.type === 'array_element_initializer') elements.push(el);
    }
    if (elements[0]) {
      const classAccess = findDescendant(elements[0], 'class_constant_access_expression');
      if (classAccess) {
        controller = classAccess.children?.find((c: SyntaxNode) => c.type === 'name')?.text ?? null;
      }
    }
    if (elements[1]) {
      const str = findDescendant(elements[1], 'string');
      method = str ? extractStringContent(str) : null;
    }
    return { controller, method };
  }

  // String syntax: 'UserController@index'
  if (handlerNode.type === 'string' || handlerNode.type === 'encapsed_string') {
    const text = extractStringContent(handlerNode);
    if (text?.includes('@')) {
      const [controller, method] = text.split('@');
      return { controller, method };
    }
  }

  // Class reference: UserController::class (invokable controller)
  if (handlerNode.type === 'class_constant_access_expression') {
    const controller =
      handlerNode.children?.find((c: SyntaxNode) => c.type === 'name')?.text ?? null;
    return { controller, method: '__invoke' };
  }

  return { controller: null, method: null };
}

interface ChainedRouteCall {
  isRouteFacade: boolean;
  terminalMethod: string;
  attributes: { method: string; argsNode: SyntaxNode | null }[];
  terminalArgs: SyntaxNode | null;
  node: SyntaxNode;
}

/**
 * Unwrap a chained call like Route::middleware('auth')->prefix('api')->group(fn)
 */
function unwrapRouteChain(node: SyntaxNode): ChainedRouteCall | null {
  if (node.type !== 'member_call_expression') return null;

  const terminalMethod = getCallMethodName(node);
  if (!terminalMethod) return null;

  const terminalArgs = getArguments(node);
  const attributes: { method: string; argsNode: SyntaxNode | null }[] = [];

  let current = node.children?.[0];

  while (current) {
    if (current.type === 'member_call_expression') {
      const method = getCallMethodName(current);
      const args = getArguments(current);
      if (method) attributes.unshift({ method, argsNode: args });
      current = current.children?.[0];
    } else if (current.type === 'scoped_call_expression') {
      const obj = current.childForFieldName?.('object') ?? current.children?.[0];
      if (obj?.text !== 'Route') return null;

      const method = getCallMethodName(current);
      const args = getArguments(current);
      if (method) attributes.unshift({ method, argsNode: args });

      return { isRouteFacade: true, terminalMethod, attributes, terminalArgs, node };
    } else {
      break;
    }
  }

  return null;
}

/** Parse Route::group(['middleware' => ..., 'prefix' => ...], fn) array syntax */
function parseArrayGroupArgs(argsNode: SyntaxNode | null): RouteGroupContext {
  const ctx: RouteGroupContext = { middleware: [], prefix: null, controller: null };
  if (!argsNode) return ctx;

  for (const child of argsNode.children ?? []) {
    const target = child.type === 'argument' ? child.children?.[0] : child;
    if (target?.type === 'array_creation_expression') {
      for (const el of target.children ?? []) {
        if (el.type !== 'array_element_initializer') continue;
        const children = el.children ?? [];
        const arrowIdx = children.findIndex((c: SyntaxNode) => c.type === '=>');
        if (arrowIdx === -1) continue;
        const key = extractStringContent(children[arrowIdx - 1]);
        const val = children[arrowIdx + 1];
        if (key === 'middleware') {
          if (val?.type === 'string') {
            const s = extractStringContent(val);
            if (s) ctx.middleware.push(s);
          } else if (val?.type === 'array_creation_expression') {
            for (const item of val.children ?? []) {
              if (item.type === 'array_element_initializer') {
                const str = item.children?.find((c: SyntaxNode) => c.type === 'string');
                const s = str ? extractStringContent(str) : null;
                if (s) ctx.middleware.push(s);
              }
            }
          }
        } else if (key === 'prefix') {
          ctx.prefix = extractStringContent(val) ?? null;
        } else if (key === 'controller') {
          if (val?.type === 'class_constant_access_expression') {
            ctx.controller = val.children?.find((c: SyntaxNode) => c.type === 'name')?.text ?? null;
          }
        }
      }
    }
  }
  return ctx;
}

function extractLaravelRoutes(tree: Parser.Tree, filePath: string): ExtractedRoute[] {
  const routes: ExtractedRoute[] = [];

  function resolveStack(stack: RouteGroupContext[]): {
    middleware: string[];
    prefix: string | null;
    controller: string | null;
  } {
    const middleware: string[] = [];
    let prefix: string | null = null;
    let controller: string | null = null;
    for (const ctx of stack) {
      middleware.push(...ctx.middleware);
      if (ctx.prefix) prefix = prefix ? `${prefix}/${ctx.prefix}`.replace(/\/+/g, '/') : ctx.prefix;
      if (ctx.controller) controller = ctx.controller;
    }
    return { middleware, prefix, controller };
  }

  function emitRoute(
    httpMethod: string,
    argsNode: SyntaxNode | null,
    lineNumber: number,
    groupStack: RouteGroupContext[],
    chainAttrs: { method: string; argsNode: SyntaxNode | null }[],
  ) {
    const effective = resolveStack(groupStack);

    for (const attr of chainAttrs) {
      if (attr.method === 'middleware')
        effective.middleware.push(...extractMiddlewareArg(attr.argsNode));
      if (attr.method === 'prefix') {
        const p = extractFirstStringArg(attr.argsNode);
        if (p) effective.prefix = effective.prefix ? `${effective.prefix}/${p}` : p;
      }
      if (attr.method === 'controller') {
        const cls = extractClassArg(attr.argsNode);
        if (cls) effective.controller = cls;
      }
    }

    const routePath = extractFirstStringArg(argsNode);

    if (ROUTE_RESOURCE_METHODS.has(httpMethod)) {
      const target = extractControllerTarget(argsNode);
      const actions = httpMethod === 'apiResource' ? API_RESOURCE_ACTIONS : RESOURCE_ACTIONS;
      for (const action of actions) {
        routes.push({
          filePath,
          httpMethod,
          routePath,
          controllerName: target.controller ?? effective.controller,
          methodName: action,
          middleware: [...effective.middleware],
          prefix: effective.prefix,
          lineNumber,
        });
      }
    } else {
      const target = extractControllerTarget(argsNode);
      routes.push({
        filePath,
        httpMethod,
        routePath,
        controllerName: target.controller ?? effective.controller,
        methodName: target.method,
        middleware: [...effective.middleware],
        prefix: effective.prefix,
        lineNumber,
      });
    }
  }

  function walk(node: SyntaxNode, groupStack: RouteGroupContext[]) {
    // Case 1: Simple Route::get(...), Route::post(...), etc.
    if (isRouteStaticCall(node)) {
      const method = getCallMethodName(node);
      if (method && (ROUTE_HTTP_METHODS.has(method) || ROUTE_RESOURCE_METHODS.has(method))) {
        emitRoute(method, getArguments(node), node.startPosition.row, groupStack, []);
        return;
      }
      if (method === 'group') {
        const argsNode = getArguments(node);
        const groupCtx = parseArrayGroupArgs(argsNode);
        const body = findClosureBody(argsNode);
        if (body) {
          groupStack.push(groupCtx);
          walkChildren(body, groupStack);
          groupStack.pop();
        }
        return;
      }
    }

    // Case 2: Fluent chain — Route::middleware(...)->group(...) or Route::middleware(...)->get(...)
    const chain = unwrapRouteChain(node);
    if (chain) {
      if (chain.terminalMethod === 'group') {
        const groupCtx: RouteGroupContext = { middleware: [], prefix: null, controller: null };
        for (const attr of chain.attributes) {
          if (attr.method === 'middleware')
            groupCtx.middleware.push(...extractMiddlewareArg(attr.argsNode));
          if (attr.method === 'prefix') groupCtx.prefix = extractFirstStringArg(attr.argsNode);
          if (attr.method === 'controller') groupCtx.controller = extractClassArg(attr.argsNode);
        }
        const body = findClosureBody(chain.terminalArgs);
        if (body) {
          groupStack.push(groupCtx);
          walkChildren(body, groupStack);
          groupStack.pop();
        }
        return;
      }
      if (
        ROUTE_HTTP_METHODS.has(chain.terminalMethod) ||
        ROUTE_RESOURCE_METHODS.has(chain.terminalMethod)
      ) {
        emitRoute(
          chain.terminalMethod,
          chain.terminalArgs,
          node.startPosition.row,
          groupStack,
          chain.attributes,
        );
        return;
      }
    }

    // Default: recurse into children
    walkChildren(node, groupStack);
  }

  function walkChildren(node: SyntaxNode, groupStack: RouteGroupContext[]) {
    for (const child of node.children ?? []) {
      walk(child, groupStack);
    }
  }

  walk(tree.rootNode, []);
  return routes;
}

// ============================================================================
// ORM Query Detection (Prisma + Supabase)
// ============================================================================

const PRISMA_QUERY_RE =
  /\bprisma\.(\w+)\.(findMany|findFirst|findUnique|findUniqueOrThrow|findFirstOrThrow|create|createMany|update|updateMany|delete|deleteMany|upsert|count|aggregate|groupBy)\s*\(/g;
const SUPABASE_QUERY_RE =
  /\bsupabase\.from\s*\(\s*['"](\w+)['"]\s*\)\s*\.(select|insert|update|delete|upsert)\s*\(/g;

/**
 * Extract ORM query calls from file content via regex.
 * Appends results to the provided array (avoids allocation when no matches).
 */
export function extractORMQueries(
  filePath: string,
  content: string,
  out: ExtractedORMQuery[],
): void {
  const hasPrisma = content.includes('prisma.');
  const hasSupabase = content.includes('supabase.from');
  if (!hasPrisma && !hasSupabase) return;

  if (hasPrisma) {
    PRISMA_QUERY_RE.lastIndex = 0;
    let m;
    while ((m = PRISMA_QUERY_RE.exec(content)) !== null) {
      const model = m[1];
      if (model.startsWith('$')) continue;
      out.push({
        filePath,
        orm: 'prisma',
        model,
        method: m[2],
        lineNumber: content.substring(0, m.index).split('\n').length - 1,
      });
    }
  }

  if (hasSupabase) {
    SUPABASE_QUERY_RE.lastIndex = 0;
    let m;
    while ((m = SUPABASE_QUERY_RE.exec(content)) !== null) {
      out.push({
        filePath,
        orm: 'supabase',
        model: m[1],
        method: m[2],
        lineNumber: content.substring(0, m.index).split('\n').length - 1,
      });
    }
  }
}

const processFileGroup = (
  files: ParseWorkerInput[],
  language: SupportedLanguages,
  queryString: string,
  result: ParseWorkerResult,
  onFileProcessed?: () => void,
): void => {
  let query: Parser.Query;
  try {
    const lang = parser.getLanguage();
    query = new Parser.Query(lang, queryString);
  } catch (err) {
    const message = `Query compilation failed for ${language}: ${err instanceof Error ? err.message : String(err)}`;
    if (parentPort) {
      parentPort.postMessage({ type: 'warning', message });
    } else {
      console.warn(message);
    }
    return;
  }

  for (const file of files) {
    // Skip files larger than the max tree-sitter buffer (32 MB)
    if (file.content.length > TREE_SITTER_MAX_BUFFER) continue;

    // Vue SFC preprocessing: extract <script> block content
    let parseContent = file.content;
    let lineOffset = 0;
    let isVueSetup = false;
    if (language === SupportedLanguages.Vue) {
      const extracted = extractVueScript(file.content);
      if (!extracted) continue; // skip .vue files with no script block
      parseContent = extracted.scriptContent;
      lineOffset = extracted.lineOffset;
      isVueSetup = extracted.isSetup;
    }

    clearCaches(); // Reset memoization before each new file

    let tree;
    try {
      tree = parser.parse(parseContent, undefined, {
        bufferSize: getTreeSitterBufferSize(parseContent.length),
      });
    } catch (err) {
      console.warn(
        `Failed to parse file ${file.path}: ${err instanceof Error ? err.message : String(err)}`,
      );
      continue;
    }

    result.fileCount++;
    onFileProcessed?.();

    let matches;
    try {
      matches = query.matches(tree.rootNode);
    } catch (err) {
      console.warn(
        `Query execution failed for ${file.path}: ${err instanceof Error ? err.message : String(err)}`,
      );
      continue;
    }

    // Pre-pass: extract heritage from query matches to build parentMap for buildTypeEnv.
    // Heritage edges (EXTENDS/IMPLEMENTS) are created by heritage-processor which runs
    // in PARALLEL with call-processor, so the graph edges don't exist when buildTypeEnv
    // runs. This pre-pass makes parent class information available for type resolution.
    const fileParentMap = new Map<string, string[]>();
    for (const match of matches) {
      const captureMap: Record<string, SyntaxNode> = {};
      for (const c of match.captures) {
        captureMap[c.name] = c.node;
      }
      if (captureMap['heritage.class'] && captureMap['heritage.extends']) {
        const className: string = captureMap['heritage.class'].text;
        const parentName: string = captureMap['heritage.extends'].text;
        // Skip Go named fields (only anonymous fields are struct embedding)
        const extendsNode = captureMap['heritage.extends'];
        const fieldDecl = extendsNode.parent;
        if (fieldDecl?.type === 'field_declaration' && fieldDecl.childForFieldName('name'))
          continue;
        let parents = fileParentMap.get(className);
        if (!parents) {
          parents = [];
          fileParentMap.set(className, parents);
        }
        if (!parents.includes(parentName)) parents.push(parentName);
      }
    }

    // Build per-file type environment + constructor bindings in a single AST walk.
    // Constructor bindings are verified against the SymbolTable in processCallsFromExtracted.
    const parentMap: ReadonlyMap<string, readonly string[]> = fileParentMap;
    const provider = getProvider(language);
    const typeEnv = buildTypeEnv(tree, language, {
      parentMap,
      enclosingFunctionFinder: provider?.enclosingFunctionFinder,
    });
    const callRouter = provider.callRouter;

    if (typeEnv.constructorBindings.length > 0) {
      result.constructorBindings.push({
        filePath: file.path,
        bindings: [...typeEnv.constructorBindings],
      });
    }

    // Extract file-scope bindings for ExportedTypeMap (closes worker/sequential quality gap).
    // Sequential path uses collectExportedBindings(typeEnv) directly; worker path serializes
    // these bindings so the main thread can merge them into ExportedTypeMap.
    const fileScope = typeEnv.fileScope();
    if (fileScope.size > 0) {
      const bindings: [string, string][] = [];
      for (const [name, type] of fileScope) bindings.push([name, type]);
      result.typeEnvBindings.push({ filePath: file.path, bindings });
    }

    // Per-file map: decorator end-line → decorator info, for associating with definitions
    const fileDecorators = new Map<number, { name: string; arg?: string; isTool?: boolean }>();

    for (const match of matches) {
      const captureMap: Record<string, SyntaxNode> = {};
      for (const c of match.captures) {
        captureMap[c.name] = c.node;
      }

      // Extract import paths before skipping
      if (captureMap['import'] && captureMap['import.source']) {
        const rawImportPath = preprocessImportPath(
          captureMap['import.source'].text,
          captureMap['import'],
          provider,
        );
        if (!rawImportPath) continue;
        const extractor = provider.namedBindingExtractor;
        const namedBindings = extractor ? extractor(captureMap['import']) : undefined;
        result.imports.push({
          filePath: file.path,
          rawImportPath,
          language: language,
          ...(namedBindings ? { namedBindings } : {}),
        });
        continue;
      }

      // Extract assignment sites (field write access)
      if (
        captureMap['assignment'] &&
        captureMap['assignment.receiver'] &&
        captureMap['assignment.property']
      ) {
        const receiverText = captureMap['assignment.receiver'].text;
        const propertyName = captureMap['assignment.property'].text;
        if (receiverText && propertyName) {
          const srcId =
            findEnclosingFunctionId(captureMap['assignment'], file.path, provider) ||
            generateId('File', file.path);
          let receiverTypeName: string | undefined;
          if (typeEnv) {
            receiverTypeName = typeEnv.lookup(receiverText, captureMap['assignment']) ?? undefined;
          }
          result.assignments.push({
            filePath: file.path,
            sourceId: srcId,
            receiverText,
            propertyName,
            ...(receiverTypeName ? { receiverTypeName } : {}),
          });
        }
        if (!captureMap['call']) continue;
      }

      // Store decorator metadata for later association with definitions
      if (captureMap['decorator'] && captureMap['decorator.name']) {
        const decoratorName = captureMap['decorator.name'].text;
        const decoratorArg = captureMap['decorator.arg']?.text;
        const decoratorNode = captureMap['decorator'];
        // Store by the decorator's end line — the definition follows immediately after
        fileDecorators.set(decoratorNode.endPosition.row, {
          name: decoratorName,
          arg: decoratorArg,
        });

        if (ROUTE_DECORATOR_NAMES.has(decoratorName)) {
          const routePath = decoratorArg || '';
          const method = decoratorName.replace('Mapping', '').toUpperCase();
          const httpMethod = ['GET', 'POST', 'PUT', 'DELETE', 'PATCH'].includes(method)
            ? method
            : 'GET';
          result.decoratorRoutes.push({
            filePath: file.path,
            routePath,
            httpMethod,
            decoratorName,
            lineNumber: decoratorNode.startPosition.row + lineOffset,
          });
        }
        // MCP/RPC tool detection: @mcp.tool(), @app.tool(), @server.tool()
        if (decoratorName === 'tool') {
          // Re-store with isTool flag for the definition handler
          fileDecorators.set(decoratorNode.endPosition.row, {
            name: decoratorName,
            arg: decoratorArg,
            isTool: true,
          });
        }
        continue;
      }

      // Extract HTTP consumer URLs: fetch(), axios.get(), $.get(), requests.get(), etc.
      if (captureMap['route.fetch']) {
        const urlNode = captureMap['route.url'] ?? captureMap['route.template_url'];
        if (urlNode) {
          result.fetchCalls.push({
            filePath: file.path,
            fetchURL: urlNode.text,
            lineNumber: captureMap['route.fetch'].startPosition.row + lineOffset,
          });
        }
        continue;
      }

      // HTTP client calls: axios.get('/path'), $.post('/path'), requests.get('/path')
      // Skip methods also in EXPRESS_ROUTE_METHODS to avoid double-registering Express
      // routes as both route definitions AND consumers (both queries match same AST node)
      if (captureMap['http_client'] && captureMap['http_client.url']) {
        const method = captureMap['http_client.method']?.text;
        const url = captureMap['http_client.url'].text;
        if (method && HTTP_CLIENT_ONLY_METHODS.has(method) && url.startsWith('/')) {
          result.fetchCalls.push({
            filePath: file.path,
            fetchURL: url,
            lineNumber: captureMap['http_client'].startPosition.row + lineOffset,
          });
        }
        continue;
      }

      // Express/Hono route registration: app.get('/path', handler)
      if (
        captureMap['express_route'] &&
        captureMap['express_route.method'] &&
        captureMap['express_route.path']
      ) {
        const method = captureMap['express_route.method'].text;
        const routePath = captureMap['express_route.path'].text;
        if (EXPRESS_ROUTE_METHODS.has(method) && routePath.startsWith('/')) {
          const httpMethod =
            method === 'all' || method === 'use' || method === 'route'
              ? 'GET'
              : method.toUpperCase();
          result.decoratorRoutes.push({
            filePath: file.path,
            routePath,
            httpMethod,
            decoratorName: `express.${method}`,
            lineNumber: captureMap['express_route'].startPosition.row + lineOffset,
          });
        }
        continue;
      }

      // Extract call sites
      if (captureMap['call']) {
        const callNode0 = captureMap['call'];
        const languageSeed = extractParsedCallSite(language, callNode0);
        if (languageSeed) {
          if (!provider.isBuiltInName(languageSeed.calledName)) {
            const sourceId =
              findEnclosingFunctionId(callNode0, file.path, provider) ||
              generateId('File', file.path);
            const receiverName =
              languageSeed.callForm === 'member' ? languageSeed.receiverName : undefined;
            let receiverTypeName = receiverName
              ? typeEnv.lookup(receiverName, callNode0)
              : undefined;
            // Type-as-receiver (e.g. Java `User::getName`): no TypeEnv binding for the class name
            if (
              receiverName !== undefined &&
              receiverTypeName === undefined &&
              languageSeed.callForm === 'member' &&
              (language === SupportedLanguages.Java ||
                language === SupportedLanguages.CSharp ||
                language === SupportedLanguages.Kotlin)
            ) {
              const c0 = receiverName.charCodeAt(0);
              if (c0 >= 65 && c0 <= 90) receiverTypeName = receiverName;
            }
            result.calls.push({
              filePath: file.path,
              calledName: languageSeed.calledName,
              sourceId,
              callForm: languageSeed.callForm,
              ...(receiverName !== undefined ? { receiverName } : {}),
              ...(receiverTypeName !== undefined ? { receiverTypeName } : {}),
            });
          }
          continue;
        }

        const callNameNode = captureMap['call.name'];
        if (callNameNode) {
          const calledName = callNameNode.text;

          // Dispatch: route language-specific calls (heritage, properties, imports)
          const routed = callRouter?.(calledName, captureMap['call']);
          if (routed) {
            if (routed.kind === 'skip') continue;

            if (routed.kind === 'import') {
              result.imports.push({
                filePath: file.path,
                rawImportPath: routed.importPath,
                language,
              });
              continue;
            }

            if (routed.kind === 'heritage') {
              for (const item of routed.items) {
                result.heritage.push({
                  filePath: file.path,
                  className: item.enclosingClass,
                  parentName: item.mixinName,
                  kind: item.heritageKind,
                });
              }
              continue;
            }

            if (routed.kind === 'properties') {
              const propEnclosingInfo = cachedFindEnclosingClassInfo(captureMap['call'], file.path);
              const propEnclosingClassId = propEnclosingInfo?.classId ?? null;
              // Enrich routed properties with FieldExtractor metadata
              let routedFieldMap: Map<string, FieldInfo> | undefined;
              if (provider.fieldExtractor && typeEnv) {
                const classNode = findEnclosingClassNode(captureMap['call']);
                if (classNode) {
                  routedFieldMap = getFieldInfo(classNode, provider, {
                    typeEnv,
                    symbolTable: NOOP_SYMBOL_TABLE,
                    filePath: file.path,
                    language,
                  });
                }
              }
              for (const item of routed.items) {
                const routedFieldInfo = routedFieldMap?.get(item.propName);
                const propQualifiedName = propEnclosingInfo
                  ? `${propEnclosingInfo.className}.${item.propName}`
                  : item.propName;
                const nodeId = generateId('Property', `${file.path}:${propQualifiedName}`);
                result.nodes.push({
                  id: nodeId,
                  label: 'Property',
                  properties: {
                    name: item.propName,
                    filePath: file.path,
                    startLine: item.startLine,
                    endLine: item.endLine,
                    language,
                    isExported: true,
                    description: item.accessorType,
                    ...(item.declaredType
                      ? { declaredType: item.declaredType }
                      : routedFieldInfo?.type
                        ? { declaredType: routedFieldInfo.type }
                        : {}),
                    ...(routedFieldInfo?.visibility !== undefined
                      ? { visibility: routedFieldInfo.visibility }
                      : {}),
                    ...(routedFieldInfo?.isStatic !== undefined
                      ? { isStatic: routedFieldInfo.isStatic }
                      : {}),
                    ...(routedFieldInfo?.isReadonly !== undefined
                      ? { isReadonly: routedFieldInfo.isReadonly }
                      : {}),
                  },
                });
                result.symbols.push({
                  filePath: file.path,
                  name: item.propName,
                  nodeId,
                  type: 'Property',
                  ...(propEnclosingClassId ? { ownerId: propEnclosingClassId } : {}),
                  ...(item.declaredType
                    ? { declaredType: item.declaredType }
                    : routedFieldInfo?.type
                      ? { declaredType: routedFieldInfo.type }
                      : {}),
                  ...(routedFieldInfo?.visibility !== undefined
                    ? { visibility: routedFieldInfo.visibility }
                    : {}),
                  ...(routedFieldInfo?.isStatic !== undefined
                    ? { isStatic: routedFieldInfo.isStatic }
                    : {}),
                  ...(routedFieldInfo?.isReadonly !== undefined
                    ? { isReadonly: routedFieldInfo.isReadonly }
                    : {}),
                });
                const fileId = generateId('File', file.path);
                const relId = generateId('DEFINES', `${fileId}->${nodeId}`);
                result.relationships.push({
                  id: relId,
                  sourceId: fileId,
                  targetId: nodeId,
                  type: 'DEFINES',
                  confidence: 1.0,
                  reason: '',
                });
                if (propEnclosingClassId) {
                  result.relationships.push({
                    id: generateId('HAS_PROPERTY', `${propEnclosingClassId}->${nodeId}`),
                    sourceId: propEnclosingClassId,
                    targetId: nodeId,
                    type: 'HAS_PROPERTY',
                    confidence: 1.0,
                    reason: '',
                  });
                }
              }
              continue;
            }

            // kind === 'call' — fall through to normal call processing below
          }

          if (!provider.isBuiltInName(calledName)) {
            const callNode = captureMap['call'];
            const sourceId =
              findEnclosingFunctionId(callNode, file.path, provider) ||
              generateId('File', file.path);
            const callForm = inferCallForm(callNode, callNameNode);
            let receiverName =
              callForm === 'member' ? extractReceiverName(callNameNode) : undefined;
            let receiverTypeName = receiverName
              ? typeEnv.lookup(receiverName, callNode)
              : undefined;
            let receiverMixedChain: MixedChainStep[] | undefined;

            // When the receiver is a complex expression (call chain, field chain, or mixed),
            // extractReceiverName returns undefined. Walk the receiver node to build a unified
            // mixed chain for deferred resolution in processCallsFromExtracted.
            if (callForm === 'member' && receiverName === undefined && !receiverTypeName) {
              const receiverNode = extractReceiverNode(callNameNode);
              if (receiverNode) {
                const extracted = extractMixedChain(receiverNode);
                if (extracted && extracted.chain.length > 0) {
                  receiverMixedChain = extracted.chain;
                  receiverName = extracted.baseReceiverName;
                  // Try the type environment immediately for the base receiver
                  // (covers explicitly-typed locals and annotated parameters).
                  if (receiverName) {
                    receiverTypeName = typeEnv.lookup(receiverName, callNode);
                  }
                }
              }
            }

            const inferLiteralType = provider.typeConfig?.inferLiteralType;
            const argCountForOverloadHints = countCallArguments(callNode);
            // Skip when no arg list / zero args: nothing to infer for overload typing; saves AST walks + payload size.
            const argTypes =
              inferLiteralType &&
              argCountForOverloadHints !== undefined &&
              argCountForOverloadHints > 0
                ? extractCallArgTypes(callNode, inferLiteralType, (varName, cn) =>
                    typeEnv.lookup(varName, cn),
                  )
                : undefined;

            result.calls.push({
              filePath: file.path,
              calledName,
              sourceId,
              argCount: countCallArguments(callNode),
              ...(callForm !== undefined ? { callForm } : {}),
              ...(receiverName !== undefined ? { receiverName } : {}),
              ...(receiverTypeName !== undefined ? { receiverTypeName } : {}),
              ...(receiverMixedChain !== undefined ? { receiverMixedChain } : {}),
              ...(argTypes !== undefined ? { argTypes } : {}),
            });
          }
        }
        continue;
      }

      // Extract heritage (extends/implements)
      if (captureMap['heritage.class']) {
        if (captureMap['heritage.extends']) {
          // Go struct embedding: the query matches ALL field_declarations with
          // type_identifier, but only anonymous fields (no name) are embedded.
          // Named fields like `Breed string` also match — skip them.
          const extendsNode = captureMap['heritage.extends'];
          const fieldDecl = extendsNode.parent;
          const isNamedField =
            fieldDecl?.type === 'field_declaration' && fieldDecl.childForFieldName('name');
          if (!isNamedField) {
            result.heritage.push({
              filePath: file.path,
              className: captureMap['heritage.class'].text,
              parentName: captureMap['heritage.extends'].text,
              kind: 'extends',
            });
          }
        }
        if (captureMap['heritage.implements']) {
          result.heritage.push({
            filePath: file.path,
            className: captureMap['heritage.class'].text,
            parentName: captureMap['heritage.implements'].text,
            kind: 'implements',
          });
        }
        if (captureMap['heritage.trait']) {
          result.heritage.push({
            filePath: file.path,
            className: captureMap['heritage.class'].text,
            parentName: captureMap['heritage.trait'].text,
            kind: 'trait-impl',
          });
        }
        if (
          captureMap['heritage.extends'] ||
          captureMap['heritage.implements'] ||
          captureMap['heritage.trait']
        ) {
          continue;
        }
      }

      const nodeLabel = getLabelFromCaptures(captureMap, provider);
      if (!nodeLabel) continue;

      const nameNode = captureMap['name'];
      // Synthesize name for constructors without explicit @name capture (e.g. Swift init)
      if (!nameNode && nodeLabel !== 'Constructor') continue;
      const nodeName = nameNode ? nameNode.text : 'init';
      const definitionNode = getDefinitionNodeFromCaptures(captureMap);
      const startLine = definitionNode
        ? definitionNode.startPosition.row + lineOffset
        : nameNode
          ? nameNode.startPosition.row + lineOffset
          : lineOffset;

      // Compute enclosing class BEFORE node ID — needed to qualify method IDs
      const needsOwner =
        nodeLabel === 'Method' ||
        nodeLabel === 'Constructor' ||
        nodeLabel === 'Property' ||
        nodeLabel === 'Function';
      const enclosingClassInfo = needsOwner
        ? cachedFindEnclosingClassInfo(nameNode || definitionNode, file.path)
        : null;
      const enclosingClassId = enclosingClassInfo?.classId ?? null;

      // Qualify method/property IDs with enclosing class name to avoid collisions
      const qualifiedName = enclosingClassInfo
        ? `${enclosingClassInfo.className}.${nodeName}`
        : nodeName;
      const nodeId = generateId(nodeLabel, `${file.path}:${qualifiedName}`);

      const description = provider.descriptionExtractor?.(nodeLabel, nodeName, captureMap);

      let frameworkHint = definitionNode
        ? detectFrameworkFromAST(language, (definitionNode.text || '').slice(0, 300))
        : null;

      // Decorators appear on lines immediately before their definition; allow up to
      // MAX_DECORATOR_SCAN_LINES gap for blank lines / multi-line decorator stacks.
      const MAX_DECORATOR_SCAN_LINES = 5;
      if (definitionNode) {
        const defStartLine = definitionNode.startPosition.row;
        for (
          let checkLine = defStartLine - 1;
          checkLine >= Math.max(0, defStartLine - MAX_DECORATOR_SCAN_LINES);
          checkLine--
        ) {
          const dec = fileDecorators.get(checkLine);
          if (dec) {
            // Use first (closest) decorator found for framework hint
            if (!frameworkHint) {
              frameworkHint = {
                framework: 'decorator',
                entryPointMultiplier: 1.2,
                reason: `@${dec.name}${dec.arg ? `("${dec.arg}")` : ''}`,
              };
            }
            // Emit tool definition if this is a @tool decorator
            if (dec.isTool) {
              result.toolDefs.push({
                filePath: file.path,
                toolName: nodeName,
                description: dec.arg || '',
                lineNumber: definitionNode.startPosition.row + lineOffset,
              });
            }
            fileDecorators.delete(checkLine);
          }
        }
      }

      let parameterCount: number | undefined;
      let requiredParameterCount: number | undefined;
      let parameterTypes: string[] | undefined;
      let returnType: string | undefined;
      let declaredType: string | undefined;
      let visibility: string | undefined;
      let isStatic: boolean | undefined;
      let isReadonly: boolean | undefined;
      let isAbstract: boolean | undefined;
      let isFinal: boolean | undefined;
      let isVirtual: boolean | undefined;
      let isOverride: boolean | undefined;
      let isAsync: boolean | undefined;
      let isPartial: boolean | undefined;
      let annotations: string[] | undefined;
      if (nodeLabel === 'Function' || nodeLabel === 'Method' || nodeLabel === 'Constructor') {
        // Try MethodExtractor first — it provides everything extractMethodSignature does, plus
        // isAbstract/isFinal/annotations. Only fall back to extractMethodSignature when no
        // MethodExtractor is available or the method isn't inside a class body.
        let enrichedByMethodExtractor = false;
        if (provider.methodExtractor && definitionNode) {
          const classNode =
            findEnclosingClassNode(definitionNode) ?? findClassNodeByQualifiedName(definitionNode);
          if (classNode) {
            const methodMap = getMethodInfo(classNode, provider, {
              filePath: file.path,
              language,
            });
            const defLine = definitionNode.startPosition.row + 1;
            const info = methodMap?.get(`${nodeName}:${defLine}`);
            if (info) {
              enrichedByMethodExtractor = true;
              const hasVariadic = info.parameters.some((p) => p.isVariadic);
              parameterCount = hasVariadic ? undefined : info.parameters.length;
              const types: string[] = [];
              let optionalCount = 0;
              for (const p of info.parameters) {
                if (p.type !== null) types.push(p.type);
                if (p.isOptional) optionalCount++;
              }
              parameterTypes = types.length > 0 ? types : undefined;
              requiredParameterCount =
                !hasVariadic && optionalCount > 0
                  ? info.parameters.length - optionalCount
                  : undefined;
              returnType = info.returnType ?? undefined;
              visibility = info.visibility;
              isStatic = info.isStatic;
              isAbstract = info.isAbstract;
              isFinal = info.isFinal;
              if (info.isVirtual) isVirtual = info.isVirtual;
              if (info.isOverride) isOverride = info.isOverride;
              if (info.isAsync) isAsync = info.isAsync;
              if (info.isPartial) isPartial = info.isPartial;
              if (info.annotations.length > 0) annotations = info.annotations;
            }
          }
        }

        // For top-level methods (e.g. Go method_declaration), try extractFromNode
        if (
          !enrichedByMethodExtractor &&
          provider.methodExtractor?.extractFromNode &&
          definitionNode
        ) {
          const info = provider.methodExtractor.extractFromNode(definitionNode, {
            filePath: file.path,
            language,
          });
          if (info) {
            enrichedByMethodExtractor = true;
            const hasVariadic = info.parameters.some((p) => p.isVariadic);
            parameterCount = hasVariadic ? undefined : info.parameters.length;
            const types: string[] = [];
            let optionalCount = 0;
            for (const p of info.parameters) {
              if (p.type !== null) types.push(p.type);
              if (p.isOptional) optionalCount++;
            }
            parameterTypes = types.length > 0 ? types : undefined;
            requiredParameterCount =
              !hasVariadic && optionalCount > 0
                ? info.parameters.length - optionalCount
                : undefined;
            returnType = info.returnType ?? undefined;
            visibility = info.visibility;
            isStatic = info.isStatic;
            isAbstract = info.isAbstract;
            isFinal = info.isFinal;
            if (info.isVirtual) isVirtual = info.isVirtual;
            if (info.isOverride) isOverride = info.isOverride;
            if (info.isAsync) isAsync = info.isAsync;
            if (info.isPartial) isPartial = info.isPartial;
            if (info.annotations.length > 0) annotations = info.annotations;
          }
        }

        if (!enrichedByMethodExtractor) {
          const sig = extractMethodSignature(definitionNode);
          parameterCount = sig.parameterCount;
          requiredParameterCount = sig.requiredParameterCount;
          parameterTypes = sig.parameterTypes;
          returnType = sig.returnType;
        }

        // Language-specific return type fallback (e.g. Ruby YARD @return [Type])
        // Also upgrades uninformative AST types like PHP `array` with PHPDoc `@return User[]`
        if (
          (!returnType || returnType === 'array' || returnType === 'iterable') &&
          definitionNode
        ) {
          const tc = provider.typeConfig;
          if (tc?.extractReturnType) {
            const docReturn = tc.extractReturnType(definitionNode);
            if (docReturn) returnType = docReturn;
          }
        }
      } else if (nodeLabel === 'Property' && definitionNode) {
        // FieldExtractor is the single source of truth when available
        if (provider.fieldExtractor && typeEnv) {
          const classNode = findEnclosingClassNode(definitionNode);
          if (classNode) {
            const fieldMap = getFieldInfo(classNode, provider, {
              typeEnv,
              symbolTable: NOOP_SYMBOL_TABLE,
              filePath: file.path,
              language,
            });
            const info = fieldMap?.get(nodeName);
            if (info) {
              declaredType = info.type ?? undefined;
              visibility = info.visibility;
              isStatic = info.isStatic;
              isReadonly = info.isReadonly;
            }
          }
        }
      }

      result.nodes.push({
        id: nodeId,
        label: nodeLabel,
        properties: {
          name: nodeName,
          filePath: file.path,
          startLine: definitionNode ? definitionNode.startPosition.row + lineOffset : startLine,
          endLine: definitionNode ? definitionNode.endPosition.row + lineOffset : startLine,
          language: language,
          isExported:
            language === SupportedLanguages.Vue && isVueSetup
              ? isVueSetupTopLevel(nameNode || definitionNode)
              : cachedExportCheck(provider.exportChecker, nameNode || definitionNode, nodeName),
          ...(frameworkHint
            ? {
                astFrameworkMultiplier: frameworkHint.entryPointMultiplier,
                astFrameworkReason: frameworkHint.reason,
              }
            : {}),
          ...(description !== undefined ? { description } : {}),
          ...(parameterCount !== undefined ? { parameterCount } : {}),
          ...(requiredParameterCount !== undefined ? { requiredParameterCount } : {}),
          ...(parameterTypes !== undefined ? { parameterTypes } : {}),
          ...(returnType !== undefined ? { returnType } : {}),
          ...(declaredType !== undefined ? { declaredType } : {}),
          ...(visibility !== undefined ? { visibility } : {}),
          ...(isStatic !== undefined ? { isStatic } : {}),
          ...(isReadonly !== undefined ? { isReadonly } : {}),
          ...(isAbstract !== undefined ? { isAbstract } : {}),
          ...(isFinal !== undefined ? { isFinal } : {}),
          ...(isVirtual !== undefined ? { isVirtual } : {}),
          ...(isOverride !== undefined ? { isOverride } : {}),
          ...(isAsync !== undefined ? { isAsync } : {}),
          ...(isPartial !== undefined ? { isPartial } : {}),
          ...(annotations !== undefined ? { annotations } : {}),
        },
      });

      // enclosingClassId already computed above (before nodeId generation)

      result.symbols.push({
        filePath: file.path,
        name: nodeName,
        nodeId,
        type: nodeLabel,
        ...(parameterCount !== undefined ? { parameterCount } : {}),
        ...(requiredParameterCount !== undefined ? { requiredParameterCount } : {}),
        ...(parameterTypes !== undefined ? { parameterTypes } : {}),
        ...(returnType !== undefined ? { returnType } : {}),
        ...(declaredType !== undefined ? { declaredType } : {}),
        ...(enclosingClassId ? { ownerId: enclosingClassId } : {}),
        ...(visibility !== undefined ? { visibility } : {}),
        ...(isStatic !== undefined ? { isStatic } : {}),
        ...(isReadonly !== undefined ? { isReadonly } : {}),
        ...(isAbstract !== undefined ? { isAbstract } : {}),
        ...(isFinal !== undefined ? { isFinal } : {}),
        ...(isVirtual !== undefined ? { isVirtual } : {}),
        ...(isOverride !== undefined ? { isOverride } : {}),
        ...(isAsync !== undefined ? { isAsync } : {}),
        ...(isPartial !== undefined ? { isPartial } : {}),
        ...(annotations !== undefined ? { annotations } : {}),
      });

      const fileId = generateId('File', file.path);
      const relId = generateId('DEFINES', `${fileId}->${nodeId}`);
      result.relationships.push({
        id: relId,
        sourceId: fileId,
        targetId: nodeId,
        type: 'DEFINES',
        confidence: 1.0,
        reason: '',
      });

      // ── HAS_METHOD / HAS_PROPERTY: link member to enclosing class ──
      if (enclosingClassId) {
        const memberEdgeType = nodeLabel === 'Property' ? 'HAS_PROPERTY' : 'HAS_METHOD';
        result.relationships.push({
          id: generateId(memberEdgeType, `${enclosingClassId}->${nodeId}`),
          sourceId: enclosingClassId,
          targetId: nodeId,
          type: memberEdgeType,
          confidence: 1.0,
          reason: '',
        });
      }
    }

    // Extract framework routes via provider detection (e.g., Laravel routes.php)
    if (provider.isRouteFile?.(file.path)) {
      const extractedRoutes = extractLaravelRoutes(tree, file.path);
      result.routes.push(...extractedRoutes);
    }

    // Extract ORM queries (Prisma, Supabase)
    extractORMQueries(file.path, parseContent, result.ormQueries);

    // Vue: emit CALLS edges for components used in <template>
    if (language === SupportedLanguages.Vue) {
      const templateComponents = extractTemplateComponents(file.content);
      for (const componentName of templateComponents) {
        result.calls.push({
          filePath: file.path,
          calledName: componentName,
          sourceId: generateId('File', file.path),
          callForm: 'free',
        });
      }
    }
  }
};

// ============================================================================
// Worker message handler — supports sub-batch streaming
// ============================================================================

/** Accumulated result across sub-batches */
let accumulated: ParseWorkerResult = {
  nodes: [],
  relationships: [],
  symbols: [],
  imports: [],
  calls: [],
  assignments: [],
  heritage: [],
  routes: [],
  fetchCalls: [],
  decoratorRoutes: [],
  toolDefs: [],
  ormQueries: [],
  constructorBindings: [],
  typeEnvBindings: [],
  skippedLanguages: {},
  fileCount: 0,
};
let cumulativeProcessed = 0;

const mergeResult = (target: ParseWorkerResult, src: ParseWorkerResult) => {
  target.nodes.push(...src.nodes);
  target.relationships.push(...src.relationships);
  target.symbols.push(...src.symbols);
  target.imports.push(...src.imports);
  target.calls.push(...src.calls);
  target.assignments.push(...src.assignments);
  target.heritage.push(...src.heritage);
  target.routes.push(...src.routes);
  target.fetchCalls.push(...src.fetchCalls);
  target.decoratorRoutes.push(...src.decoratorRoutes);
  target.toolDefs.push(...src.toolDefs);
  target.ormQueries.push(...src.ormQueries);
  target.constructorBindings.push(...src.constructorBindings);
  target.typeEnvBindings.push(...src.typeEnvBindings);
  for (const [lang, count] of Object.entries(src.skippedLanguages)) {
    target.skippedLanguages[lang] = (target.skippedLanguages[lang] || 0) + count;
  }
  target.fileCount += src.fileCount;
};

parentPort!.on('message', (msg: WorkerIncomingMessage) => {
  try {
    // Legacy single-message mode (backward compat): array of files
    if (Array.isArray(msg)) {
      const result = processBatch(msg, (filesProcessed) => {
        parentPort!.postMessage({ type: 'progress', filesProcessed });
      });
      parentPort!.postMessage({ type: 'result', data: result });
      return;
    }

    // Sub-batch mode: { type: 'sub-batch', files: [...] }
    if (msg.type === 'sub-batch') {
      const result = processBatch(msg.files, (filesProcessed) => {
        parentPort!.postMessage({
          type: 'progress',
          filesProcessed: cumulativeProcessed + filesProcessed,
        });
      });
      cumulativeProcessed += result.fileCount;
      mergeResult(accumulated, result);
      // Signal ready for next sub-batch
      parentPort!.postMessage({ type: 'sub-batch-done' });
      return;
    }

    // Flush: send accumulated results
    if (msg.type === 'flush') {
      parentPort!.postMessage({ type: 'result', data: accumulated });
      // Reset for potential reuse
      accumulated = {
        nodes: [],
        relationships: [],
        symbols: [],
        imports: [],
        calls: [],
        assignments: [],
        heritage: [],
        routes: [],
        fetchCalls: [],
        decoratorRoutes: [],
        toolDefs: [],
        ormQueries: [],
        constructorBindings: [],
        typeEnvBindings: [],
        skippedLanguages: {},
        fileCount: 0,
      };
      cumulativeProcessed = 0;
      return;
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    parentPort!.postMessage({ type: 'error', error: message });
  }
});

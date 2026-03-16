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
import { SupportedLanguages } from '../../../config/supported-languages.js';
import { LANGUAGE_QUERIES } from '../tree-sitter-queries.js';
import { getTreeSitterBufferSize, TREE_SITTER_MAX_BUFFER } from '../constants.js';

// tree-sitter-swift is an optionalDependency — may not be installed
const _require = createRequire(import.meta.url);
let Swift: any = null;
try { Swift = _require('tree-sitter-swift'); } catch {}

// tree-sitter-kotlin is an optionalDependency — may not be installed
let Kotlin: any = null;
try { Kotlin = _require('tree-sitter-kotlin'); } catch {}
import {
  getLanguageFromFilename,
  FUNCTION_NODE_TYPES,
  extractFunctionName,
  isBuiltInOrNoise,
  getDefinitionNodeFromCaptures,
  findEnclosingClassId,
  extractMethodSignature,
  countCallArguments,
  inferCallForm,
  extractReceiverName,
  extractReceiverNode,
  CALL_EXPRESSION_TYPES,
  extractCallChain,
} from '../utils.js';
import { buildTypeEnv } from '../type-env.js';
import type { ConstructorBinding } from '../type-env.js';
import { isNodeExported } from '../export-detection.js';
import { detectFrameworkFromAST } from '../framework-detection.js';
import { typeConfigs } from '../type-extractors/index.js';
import { generateId } from '../../../lib/utils.js';
import { extractNamedBindings } from '../named-binding-extraction.js';
import { appendKotlinWildcard } from '../resolvers/index.js';
import { callRouters } from '../call-routing.js';

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
    returnType?: string;
  };
}

interface ParsedRelationship {
  id: string;
  sourceId: string;
  targetId: string;
  type: 'DEFINES' | 'HAS_METHOD';
  confidence: number;
  reason: string;
}

interface ParsedSymbol {
  filePath: string;
  name: string;
  nodeId: string;
  type: string;
  parameterCount?: number;
  returnType?: string;
  ownerId?: string;
}

export interface ExtractedImport {
  filePath: string;
  rawImportPath: string;
  language: SupportedLanguages;
  /** Named bindings from the import (e.g., import {User as U} → [{local:'U', exported:'User'}]) */
  namedBindings?: { local: string; exported: string }[];
}

export interface ExtractedCall {
  filePath: string;
  calledName: string;
  /** generateId of enclosing function, or generateId('File', filePath) for top-level */
  sourceId: string;
  argCount?: number;
  /** Discriminates free function calls from member/constructor calls */
  callForm?: 'free' | 'member' | 'constructor';
  /** Simple identifier of the receiver for member calls (e.g., 'user' in user.save()) */
  receiverName?: string;
  /** Resolved type name of the receiver (e.g., 'User' for user.save() when user: User) */
  receiverTypeName?: string;
  /**
   * Chained call names when the receiver is itself a call expression.
   * For `svc.getUser().save()`, the `save` ExtractedCall gets receiverCallChain = ['getUser']
   * with receiverName = 'svc'.  The chain is ordered outermost-last, e.g.:
   *   `a.b().c().d()` → calledName='d', receiverCallChain=['b','c'], receiverName='a'
   * Length is capped at MAX_CHAIN_DEPTH (3).
   */
  receiverCallChain?: string[];
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

/** Constructor bindings keyed by filePath for cross-file type resolution */
export interface FileConstructorBindings {
  filePath: string;
  bindings: ConstructorBinding[];
}

export interface ParseWorkerResult {
  nodes: ParsedNode[];
  relationships: ParsedRelationship[];
  symbols: ParsedSymbol[];
  imports: ExtractedImport[];
  calls: ExtractedCall[];
  heritage: ExtractedHeritage[];
  routes: ExtractedRoute[];
  constructorBindings: FileConstructorBindings[];
  skippedLanguages: Record<string, number>;
  fileCount: number;
}

export interface ParseWorkerInput {
  path: string;
  content: string;
}

// ============================================================================
// Worker-local parser + language map
// ============================================================================

const parser = new Parser();

const languageMap: Record<string, any> = {
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
  ...(Swift ? { [SupportedLanguages.Swift]: Swift } : {}),
};

/**
 * Check if a language grammar is available in this worker.
 * Duplicated from parser-loader.ts because workers can't import from the main thread.
 * Extra filePath parameter needed to distinguish .tsx from .ts (different grammars
 * under the same SupportedLanguages.TypeScript key).
 */
const isLanguageAvailable = (language: SupportedLanguages, filePath: string): boolean => {
  const key = language === SupportedLanguages.TypeScript && filePath.endsWith('.tsx')
    ? `${language}:tsx`
    : language;
  return key in languageMap && languageMap[key] != null;
};

const setLanguage = (language: SupportedLanguages, filePath: string): void => {
  const key = language === SupportedLanguages.TypeScript && filePath.endsWith('.tsx')
    ? `${language}:tsx`
    : language;
  const lang = languageMap[key];
  if (!lang) throw new Error(`Unsupported language: ${language}`);
  parser.setLanguage(lang);
};

// isNodeExported imported from ../export-detection.js (shared module)

// ============================================================================
// Enclosing function detection (for call extraction)
// ============================================================================

/** Walk up AST to find enclosing function, return its generateId or null for top-level */
const findEnclosingFunctionId = (node: any, filePath: string): string | null => {
  let current = node.parent;
  while (current) {
    if (FUNCTION_NODE_TYPES.has(current.type)) {
      const { funcName, label } = extractFunctionName(current);
      if (funcName) {
        return generateId(label, `${filePath}:${funcName}`);
      }
    }
    current = current.parent;
  }
  return null;
};

// ============================================================================
// Label detection from capture map
// ============================================================================

const getLabelFromCaptures = (captureMap: Record<string, any>): string | null => {
  // Skip imports (handled separately) and calls
  if (captureMap['import'] || captureMap['call']) return null;
  if (!captureMap['name']) return null;

  if (captureMap['definition.function']) return 'Function';
  if (captureMap['definition.class']) return 'Class';
  if (captureMap['definition.interface']) return 'Interface';
  if (captureMap['definition.method']) return 'Method';
  if (captureMap['definition.struct']) return 'Struct';
  if (captureMap['definition.enum']) return 'Enum';
  if (captureMap['definition.namespace']) return 'Namespace';
  if (captureMap['definition.module']) return 'Module';
  if (captureMap['definition.trait']) return 'Trait';
  if (captureMap['definition.impl']) return 'Impl';
  if (captureMap['definition.type']) return 'TypeAlias';
  if (captureMap['definition.const']) return 'Const';
  if (captureMap['definition.static']) return 'Static';
  if (captureMap['definition.typedef']) return 'Typedef';
  if (captureMap['definition.macro']) return 'Macro';
  if (captureMap['definition.union']) return 'Union';
  if (captureMap['definition.property']) return 'Property';
  if (captureMap['definition.record']) return 'Record';
  if (captureMap['definition.delegate']) return 'Delegate';
  if (captureMap['definition.annotation']) return 'Annotation';
  if (captureMap['definition.constructor']) return 'Constructor';
  if (captureMap['definition.template']) return 'Template';
  return 'CodeElement';
};

// DEFINITION_CAPTURE_KEYS and getDefinitionNodeFromCaptures imported from ../utils.js


// ============================================================================
// Process a batch of files
// ============================================================================

const processBatch = (files: ParseWorkerInput[], onProgress?: (filesProcessed: number) => void): ParseWorkerResult => {
  const result: ParseWorkerResult = {
    nodes: [],
    relationships: [],
    symbols: [],
    imports: [],
    calls: [],
    heritage: [],
    routes: [],
    constructorBindings: [],
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

  const onFileProcessed = onProgress ? () => {
    totalProcessed++;
    if (totalProcessed - lastReported >= PROGRESS_INTERVAL) {
      lastReported = totalProcessed;
      onProgress(totalProcessed);
    }
  } : undefined;

  for (const [language, langFiles] of byLanguage) {
    const queryString = LANGUAGE_QUERIES[language];
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
        result.skippedLanguages[language] = (result.skippedLanguages[language] || 0) + regularFiles.length;
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
        result.skippedLanguages[language] = (result.skippedLanguages[language] || 0) + tsxFiles.length;
      }
    }
  }

  return result;
};

// ============================================================================
// PHP Eloquent metadata extraction
// ============================================================================

/** Eloquent model properties whose array values are worth indexing */
const ELOQUENT_ARRAY_PROPS = new Set(['fillable', 'casts', 'hidden', 'guarded', 'with', 'appends']);

/** Eloquent relationship method names */
const ELOQUENT_RELATIONS = new Set([
  'hasMany', 'hasOne', 'belongsTo', 'belongsToMany',
  'morphTo', 'morphMany', 'morphOne', 'morphToMany', 'morphedByMany',
  'hasManyThrough', 'hasOneThrough',
]);

function findDescendant(node: any, type: string): any {
  if (node.type === type) return node;
  for (const child of (node.children ?? [])) {
    const found = findDescendant(child, type);
    if (found) return found;
  }
  return null;
}

function extractStringContent(node: any): string | null {
  if (!node) return null;
  const content = node.children?.find((c: any) => c.type === 'string_content');
  if (content) return content.text;
  if (node.type === 'string_content') return node.text;
  return null;
}

/**
 * For a PHP property_declaration node, extract array values as a description string.
 * Returns null if not an Eloquent model property or no array values found.
 */
function extractPhpPropertyDescription(propName: string, propDeclNode: any): string | null {
  if (!ELOQUENT_ARRAY_PROPS.has(propName)) return null;

  const arrayNode = findDescendant(propDeclNode, 'array_creation_expression');
  if (!arrayNode) return null;

  const items: string[] = [];
  for (const child of (arrayNode.children ?? [])) {
    if (child.type !== 'array_element_initializer') continue;
    const children = child.children ?? [];
    const arrowIdx = children.findIndex((c: any) => c.type === '=>');
    if (arrowIdx !== -1) {
      // key => value pair (used in $casts)
      const key = extractStringContent(children[arrowIdx - 1]);
      const val = extractStringContent(children[arrowIdx + 1]);
      if (key && val) items.push(`${key}:${val}`);
    } else {
      // Simple value (used in $fillable, $hidden, etc.)
      const val = extractStringContent(children[0]);
      if (val) items.push(val);
    }
  }

  return items.length > 0 ? items.join(', ') : null;
}

/**
 * For a PHP method_declaration node, detect if it defines an Eloquent relationship.
 * Returns description like "hasMany(Post)" or null.
 */
function extractEloquentRelationDescription(methodNode: any): string | null {
  function findRelationCall(node: any): any {
    if (node.type === 'member_call_expression') {
      const children = node.children ?? [];
      const objectNode = children.find((c: any) => c.type === 'variable_name' && c.text === '$this');
      const nameNode = children.find((c: any) => c.type === 'name');
      if (objectNode && nameNode && ELOQUENT_RELATIONS.has(nameNode.text)) return node;
    }
    for (const child of (node.children ?? [])) {
      const found = findRelationCall(child);
      if (found) return found;
    }
    return null;
  }

  const callNode = findRelationCall(methodNode);
  if (!callNode) return null;

  const relType = callNode.children?.find((c: any) => c.type === 'name')?.text;
  const argsNode = callNode.children?.find((c: any) => c.type === 'arguments');
  let targetModel: string | null = null;
  if (argsNode) {
    const firstArg = argsNode.children?.find((c: any) => c.type === 'argument');
    if (firstArg) {
      const classConstant = firstArg.children?.find((c: any) =>
        c.type === 'class_constant_access_expression'
      );
      if (classConstant) {
        targetModel = classConstant.children?.find((c: any) => c.type === 'name')?.text ?? null;
      }
    }
  }

  if (relType && targetModel) return `${relType}(${targetModel})`;
  if (relType) return relType;
  return null;
}

// ============================================================================
// Laravel Route Extraction (procedural AST walk)
// ============================================================================

interface RouteGroupContext {
  middleware: string[];
  prefix: string | null;
  controller: string | null;
}

const ROUTE_HTTP_METHODS = new Set([
  'get', 'post', 'put', 'patch', 'delete', 'options', 'any', 'match',
]);

const ROUTE_RESOURCE_METHODS = new Set(['resource', 'apiResource']);

const RESOURCE_ACTIONS = ['index', 'create', 'store', 'show', 'edit', 'update', 'destroy'];
const API_RESOURCE_ACTIONS = ['index', 'store', 'show', 'update', 'destroy'];

/** Check if node is a scoped_call_expression with object 'Route' */
function isRouteStaticCall(node: any): boolean {
  if (node.type !== 'scoped_call_expression') return false;
  const obj = node.childForFieldName?.('object') ?? node.children?.[0];
  return obj?.text === 'Route';
}

/** Get the method name from a scoped_call_expression or member_call_expression */
function getCallMethodName(node: any): string | null {
  const nameNode = node.childForFieldName?.('name') ??
    node.children?.find((c: any) => c.type === 'name');
  return nameNode?.text ?? null;
}

/** Get the arguments node from a call expression */
function getArguments(node: any): any {
  return node.children?.find((c: any) => c.type === 'arguments') ?? null;
}

/** Find the closure body inside arguments */
function findClosureBody(argsNode: any): any | null {
  if (!argsNode) return null;
  for (const child of argsNode.children ?? []) {
    if (child.type === 'argument') {
      for (const inner of child.children ?? []) {
        if (inner.type === 'anonymous_function' ||
            inner.type === 'arrow_function') {
          return inner.childForFieldName?.('body') ??
            inner.children?.find((c: any) => c.type === 'compound_statement');
        }
      }
    }
    if (child.type === 'anonymous_function' ||
        child.type === 'arrow_function') {
      return child.childForFieldName?.('body') ??
        child.children?.find((c: any) => c.type === 'compound_statement');
    }
  }
  return null;
}

/** Extract first string argument from arguments node */
function extractFirstStringArg(argsNode: any): string | null {
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
function extractMiddlewareArg(argsNode: any): string[] {
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
          const str = el.children?.find((c: any) => c.type === 'string' || c.type === 'encapsed_string');
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
function extractClassArg(argsNode: any): string | null {
  if (!argsNode) return null;
  for (const child of argsNode.children ?? []) {
    const target = child.type === 'argument' ? child.children?.[0] : child;
    if (target?.type === 'class_constant_access_expression') {
      return target.children?.find((c: any) => c.type === 'name')?.text ?? null;
    }
  }
  return null;
}

/** Extract controller class name from arguments: [Controller::class, 'method'] or 'Controller@method' */
function extractControllerTarget(argsNode: any): { controller: string | null; method: string | null } {
  if (!argsNode) return { controller: null, method: null };

  const args: any[] = [];
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
    const elements: any[] = [];
    for (const el of handlerNode.children ?? []) {
      if (el.type === 'array_element_initializer') elements.push(el);
    }
    if (elements[0]) {
      const classAccess = findDescendant(elements[0], 'class_constant_access_expression');
      if (classAccess) {
        controller = classAccess.children?.find((c: any) => c.type === 'name')?.text ?? null;
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
    const controller = handlerNode.children?.find((c: any) => c.type === 'name')?.text ?? null;
    return { controller, method: '__invoke' };
  }

  return { controller: null, method: null };
}

interface ChainedRouteCall {
  isRouteFacade: boolean;
  terminalMethod: string;
  attributes: { method: string; argsNode: any }[];
  terminalArgs: any;
  node: any;
}

/**
 * Unwrap a chained call like Route::middleware('auth')->prefix('api')->group(fn)
 */
function unwrapRouteChain(node: any): ChainedRouteCall | null {
  if (node.type !== 'member_call_expression') return null;

  const terminalMethod = getCallMethodName(node);
  if (!terminalMethod) return null;

  const terminalArgs = getArguments(node);
  const attributes: { method: string; argsNode: any }[] = [];

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
function parseArrayGroupArgs(argsNode: any): RouteGroupContext {
  const ctx: RouteGroupContext = { middleware: [], prefix: null, controller: null };
  if (!argsNode) return ctx;

  for (const child of argsNode.children ?? []) {
    const target = child.type === 'argument' ? child.children?.[0] : child;
    if (target?.type === 'array_creation_expression') {
      for (const el of target.children ?? []) {
        if (el.type !== 'array_element_initializer') continue;
        const children = el.children ?? [];
        const arrowIdx = children.findIndex((c: any) => c.type === '=>');
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
                const str = item.children?.find((c: any) => c.type === 'string');
                const s = str ? extractStringContent(str) : null;
                if (s) ctx.middleware.push(s);
              }
            }
          }
        } else if (key === 'prefix') {
          ctx.prefix = extractStringContent(val) ?? null;
        } else if (key === 'controller') {
          if (val?.type === 'class_constant_access_expression') {
            ctx.controller = val.children?.find((c: any) => c.type === 'name')?.text ?? null;
          }
        }
      }
    }
  }
  return ctx;
}

function extractLaravelRoutes(tree: any, filePath: string): ExtractedRoute[] {
  const routes: ExtractedRoute[] = [];

  function resolveStack(stack: RouteGroupContext[]): { middleware: string[]; prefix: string | null; controller: string | null } {
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
    argsNode: any,
    lineNumber: number,
    groupStack: RouteGroupContext[],
    chainAttrs: { method: string; argsNode: any }[],
  ) {
    const effective = resolveStack(groupStack);

    for (const attr of chainAttrs) {
      if (attr.method === 'middleware') effective.middleware.push(...extractMiddlewareArg(attr.argsNode));
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
          filePath, httpMethod, routePath,
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
        filePath, httpMethod, routePath,
        controllerName: target.controller ?? effective.controller,
        methodName: target.method,
        middleware: [...effective.middleware],
        prefix: effective.prefix,
        lineNumber,
      });
    }
  }

  function walk(node: any, groupStack: RouteGroupContext[]) {
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
          if (attr.method === 'middleware') groupCtx.middleware.push(...extractMiddlewareArg(attr.argsNode));
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
      if (ROUTE_HTTP_METHODS.has(chain.terminalMethod) || ROUTE_RESOURCE_METHODS.has(chain.terminalMethod)) {
        emitRoute(chain.terminalMethod, chain.terminalArgs, node.startPosition.row, groupStack, chain.attributes);
        return;
      }
    }

    // Default: recurse into children
    walkChildren(node, groupStack);
  }

  function walkChildren(node: any, groupStack: RouteGroupContext[]) {
    for (const child of node.children ?? []) {
      walk(child, groupStack);
    }
  }

  walk(tree.rootNode, []);
  return routes;
}

const processFileGroup = (
  files: ParseWorkerInput[],
  language: SupportedLanguages,
  queryString: string,
  result: ParseWorkerResult,
  onFileProcessed?: () => void,
): void => {
  let query: any;
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

    let tree;
    try {
      tree = parser.parse(file.content, undefined, { bufferSize: getTreeSitterBufferSize(file.content.length) });
    } catch (err) {
      console.warn(`Failed to parse file ${file.path}: ${err instanceof Error ? err.message : String(err)}`);
      continue;
    }

    result.fileCount++;
    onFileProcessed?.();

    // Build per-file type environment + constructor bindings in a single AST walk.
    // Constructor bindings are verified against the SymbolTable in processCallsFromExtracted.
    const typeEnv = buildTypeEnv(tree, language);
    const callRouter = callRouters[language];

    if (typeEnv.constructorBindings.length > 0) {
      result.constructorBindings.push({ filePath: file.path, bindings: [...typeEnv.constructorBindings] });
    }

    let matches;
    try {
      matches = query.matches(tree.rootNode);
    } catch (err) {
      console.warn(`Query execution failed for ${file.path}: ${err instanceof Error ? err.message : String(err)}`);
      continue;
    }

    for (const match of matches) {
      const captureMap: Record<string, any> = {};
      for (const c of match.captures) {
        captureMap[c.name] = c.node;
      }

      // Extract import paths before skipping
      if (captureMap['import'] && captureMap['import.source']) {
        const rawImportPath = language === SupportedLanguages.Kotlin
          ? appendKotlinWildcard(captureMap['import.source'].text.replace(/['"<>]/g, ''), captureMap['import'])
          : captureMap['import.source'].text.replace(/['"<>]/g, '');
        const namedBindings = extractNamedBindings(captureMap['import'], language);
        result.imports.push({
          filePath: file.path,
          rawImportPath,
          language: language,
          ...(namedBindings ? { namedBindings } : {}),
        });
        continue;
      }

      // Extract call sites
      if (captureMap['call']) {
        const callNameNode = captureMap['call.name'];
        if (callNameNode) {
          const calledName = callNameNode.text;

          // Dispatch: route language-specific calls (heritage, properties, imports)
          const routed = callRouter(calledName, captureMap['call']);
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
              const propEnclosingClassId = findEnclosingClassId(captureMap['call'], file.path);
              for (const item of routed.items) {
                const nodeId = generateId('Property', `${file.path}:${item.propName}`);
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
                  },
                });
                result.symbols.push({
                  filePath: file.path,
                  name: item.propName,
                  nodeId,
                  type: 'Property',
                  ...(propEnclosingClassId ? { ownerId: propEnclosingClassId } : {}),
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
                    id: generateId('HAS_METHOD', `${propEnclosingClassId}->${nodeId}`),
                    sourceId: propEnclosingClassId,
                    targetId: nodeId,
                    type: 'HAS_METHOD',
                    confidence: 1.0,
                    reason: '',
                  });
                }
              }
              continue;
            }

            // kind === 'call' — fall through to normal call processing below
          }

          if (!isBuiltInOrNoise(calledName)) {
            const callNode = captureMap['call'];
            const sourceId = findEnclosingFunctionId(callNode, file.path)
              || generateId('File', file.path);
            const callForm = inferCallForm(callNode, callNameNode);
            let receiverName = callForm === 'member' ? extractReceiverName(callNameNode) : undefined;
            let receiverTypeName = receiverName ? typeEnv.lookup(receiverName, callNode) : undefined;
            let receiverCallChain: string[] | undefined;

            // When the receiver is a call_expression (e.g. svc.getUser().save()),
            // extractReceiverName returns undefined because it refuses complex expressions.
            // Instead, walk the receiver node to build a call chain for deferred resolution.
            // We capture the base receiver name so processCallsFromExtracted can look it up
            // from constructor bindings. receiverTypeName is intentionally left unset here —
            // the chain resolver in processCallsFromExtracted needs the base type as input and
            // produces the final receiver type as output.
            if (callForm === 'member' && receiverName === undefined && !receiverTypeName) {
              const receiverNode = extractReceiverNode(callNameNode);
              if (receiverNode && CALL_EXPRESSION_TYPES.has(receiverNode.type)) {
                const extracted = extractCallChain(receiverNode);
                if (extracted) {
                  receiverCallChain = extracted.chain;
                  // Set receiverName to the base object so Step 1 in processCallsFromExtracted
                  // can resolve it via constructor bindings to a base type for the chain.
                  receiverName = extracted.baseReceiverName;
                  // Also try the type environment immediately (covers explicitly-typed locals
                  // and annotated parameters like `fn process(svc: &UserService)`).
                  // This sets a base type that chain resolution (Step 2) will use as input.
                  if (receiverName) {
                    receiverTypeName = typeEnv.lookup(receiverName, callNode);
                  }
                }
              }
            }

            result.calls.push({
              filePath: file.path,
              calledName,
              sourceId,
              argCount: countCallArguments(callNode),
              ...(callForm !== undefined ? { callForm } : {}),
              ...(receiverName !== undefined ? { receiverName } : {}),
              ...(receiverTypeName !== undefined ? { receiverTypeName } : {}),
              ...(receiverCallChain !== undefined ? { receiverCallChain } : {}),
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
          const isNamedField = fieldDecl?.type === 'field_declaration'
            && fieldDecl.childForFieldName('name');
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
        if (captureMap['heritage.extends'] || captureMap['heritage.implements'] || captureMap['heritage.trait']) {
          continue;
        }
      }

      const nodeLabel = getLabelFromCaptures(captureMap);
      if (!nodeLabel) continue;

      const nameNode = captureMap['name'];
      // Synthesize name for constructors without explicit @name capture (e.g. Swift init)
      if (!nameNode && nodeLabel !== 'Constructor') continue;
      const nodeName = nameNode ? nameNode.text : 'init';
      const definitionNode = getDefinitionNodeFromCaptures(captureMap);
      const startLine = definitionNode ? definitionNode.startPosition.row : (nameNode ? nameNode.startPosition.row : 0);
      const nodeId = generateId(nodeLabel, `${file.path}:${nodeName}`);

      let description: string | undefined;
      if (language === SupportedLanguages.PHP) {
        if (nodeLabel === 'Property' && captureMap['definition.property']) {
          description = extractPhpPropertyDescription(nodeName, captureMap['definition.property']) ?? undefined;
        } else if (nodeLabel === 'Method' && captureMap['definition.method']) {
          description = extractEloquentRelationDescription(captureMap['definition.method']) ?? undefined;
        }
      }

      const frameworkHint = definitionNode
        ? detectFrameworkFromAST(language, (definitionNode.text || '').slice(0, 300))
        : null;

      let parameterCount: number | undefined;
      let returnType: string | undefined;
      if (nodeLabel === 'Function' || nodeLabel === 'Method' || nodeLabel === 'Constructor') {
        const sig = extractMethodSignature(definitionNode);
        parameterCount = sig.parameterCount;
        returnType = sig.returnType;

        // Language-specific return type fallback (e.g. Ruby YARD @return [Type])
        if (!returnType && definitionNode) {
          const tc = typeConfigs[language as keyof typeof typeConfigs];
          if (tc?.extractReturnType) {
            returnType = tc.extractReturnType(definitionNode);
          }
        }
      }

      result.nodes.push({
        id: nodeId,
        label: nodeLabel,
        properties: {
          name: nodeName,
          filePath: file.path,
          startLine: definitionNode ? definitionNode.startPosition.row : startLine,
          endLine: definitionNode ? definitionNode.endPosition.row : startLine,
          language: language,
          isExported: isNodeExported(nameNode || definitionNode, nodeName, language),
          ...(frameworkHint ? {
            astFrameworkMultiplier: frameworkHint.entryPointMultiplier,
            astFrameworkReason: frameworkHint.reason,
          } : {}),
          ...(description !== undefined ? { description } : {}),
          ...(parameterCount !== undefined ? { parameterCount } : {}),
          ...(returnType !== undefined ? { returnType } : {}),
        },
      });

      // Compute enclosing class for Method/Constructor/Property/Function — used for both ownerId and HAS_METHOD
      // Function is included because Kotlin/Rust/Python capture class methods as Function nodes
      const needsOwner = nodeLabel === 'Method' || nodeLabel === 'Constructor' || nodeLabel === 'Property' || nodeLabel === 'Function';
      const enclosingClassId = needsOwner ? findEnclosingClassId(nameNode || definitionNode, file.path) : null;

      result.symbols.push({
        filePath: file.path,
        name: nodeName,
        nodeId,
        type: nodeLabel,
        ...(parameterCount !== undefined ? { parameterCount } : {}),
        ...(returnType !== undefined ? { returnType } : {}),
        ...(enclosingClassId ? { ownerId: enclosingClassId } : {}),
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

      // ── HAS_METHOD: link method/constructor/property to enclosing class ──
      if (enclosingClassId) {
        result.relationships.push({
          id: generateId('HAS_METHOD', `${enclosingClassId}->${nodeId}`),
          sourceId: enclosingClassId,
          targetId: nodeId,
          type: 'HAS_METHOD',
          confidence: 1.0,
          reason: '',
        });
      }
    }

    // Extract Laravel routes from route files via procedural AST walk
    if (language === SupportedLanguages.PHP && (file.path.includes('/routes/') || file.path.startsWith('routes/')) && file.path.endsWith('.php')) {
      const extractedRoutes = extractLaravelRoutes(tree, file.path);
      result.routes.push(...extractedRoutes);
    }
  }
};

// ============================================================================
// Worker message handler — supports sub-batch streaming
// ============================================================================

/** Accumulated result across sub-batches */
let accumulated: ParseWorkerResult = {
  nodes: [], relationships: [], symbols: [],
  imports: [], calls: [], heritage: [], routes: [], constructorBindings: [], skippedLanguages: {}, fileCount: 0,
};
let cumulativeProcessed = 0;

const mergeResult = (target: ParseWorkerResult, src: ParseWorkerResult) => {
  target.nodes.push(...src.nodes);
  target.relationships.push(...src.relationships);
  target.symbols.push(...src.symbols);
  target.imports.push(...src.imports);
  target.calls.push(...src.calls);
  target.heritage.push(...src.heritage);
  target.routes.push(...src.routes);
  target.constructorBindings.push(...src.constructorBindings);
  for (const [lang, count] of Object.entries(src.skippedLanguages)) {
    target.skippedLanguages[lang] = (target.skippedLanguages[lang] || 0) + count;
  }
  target.fileCount += src.fileCount;
};

parentPort!.on('message', (msg: any) => {
  try {
    // Sub-batch mode: { type: 'sub-batch', files: [...] }
    if (msg && msg.type === 'sub-batch') {
      const result = processBatch(msg.files, (filesProcessed) => {
        parentPort!.postMessage({ type: 'progress', filesProcessed: cumulativeProcessed + filesProcessed });
      });
      cumulativeProcessed += result.fileCount;
      mergeResult(accumulated, result);
      // Signal ready for next sub-batch
      parentPort!.postMessage({ type: 'sub-batch-done' });
      return;
    }

    // Flush: send accumulated results
    if (msg && msg.type === 'flush') {
      parentPort!.postMessage({ type: 'result', data: accumulated });
      // Reset for potential reuse
      accumulated = { nodes: [], relationships: [], symbols: [], imports: [], calls: [], heritage: [], routes: [], constructorBindings: [], skippedLanguages: {}, fileCount: 0 };
      cumulativeProcessed = 0;
      return;
    }

    // Legacy single-message mode (backward compat): array of files
    if (Array.isArray(msg)) {
      const result = processBatch(msg, (filesProcessed) => {
        parentPort!.postMessage({ type: 'progress', filesProcessed });
      });
      parentPort!.postMessage({ type: 'result', data: result });
      return;
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    parentPort!.postMessage({ type: 'error', error: message });
  }
});

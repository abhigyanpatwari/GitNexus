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
import { extractSpringRoutes } from './spring-route-extractor.js';
import { extractExpressRoutes } from '../route-extractors/express.js';
import { extractFastApiRoutes } from '../route-extractors/python.js';
import { extractGinRoutes } from '../route-extractors/go.js';
import { extractAngularRoutes, isAngularFile } from '../route-extractors/angular.js';
import { extractAngularMetadata, type ExtractedAngularEdge } from '../extractors/angular-metadata.js';
import { extractAngularCalls } from '../extractors/angular-calls.js';
import { collectGoImplementsHeritage, collectGoCompositionHeritage, collectGoInterfaceMethods, collectGoImplementsCrossFile, type GoInterfaceMethodEntry, type GoCrossFileImplementsHeritageItem } from './go-relationships.js';
import { LANGUAGE_QUERIES } from '../tree-sitter-queries.js';
import { getTreeSitterBufferSize, TREE_SITTER_MAX_BUFFER } from '../constants.js';
import type { AnnotationInfo } from '../annotation-extractor.js';
import { extractSingleAnnotation } from '../annotation-extractor.js';
import { isVerboseIngestionEnabled } from '../utils/verbose.js';

// tree-sitter-swift is an optionalDependency — may not be installed
const _require = createRequire(import.meta.url);
let Swift: any = null;
try { Swift = _require('tree-sitter-swift'); } catch {}

// tree-sitter-kotlin is an optionalDependency — may not be installed
let Kotlin: any = null;
try { Kotlin = _require('tree-sitter-kotlin'); } catch {}
import {
  getLanguageFromFilename,
} from '../utils/language-detection.js';
import {
  FUNCTION_NODE_TYPES,
  extractFunctionName,
  getDefinitionNodeFromCaptures,
  findEnclosingClassId,
  extractMethodSignature,
} from '../utils/ast-helpers.js';
import {
  countCallArguments,
  inferCallForm,
  extractReceiverName,
  extractReceiverNode,
  CALL_EXPRESSION_TYPES,
  extractCallChain,
} from '../utils/call-analysis.js';
import { extractAnnotations } from '../annotation-extractor.js';
import { buildTypeEnv } from '../type-env.js';
import type { ConstructorBinding } from '../type-env.js';
import {
  tsExportChecker,
  pythonExportChecker,
  javaExportChecker,
  csharpExportChecker,
  goExportChecker,
  rustExportChecker,
  kotlinExportChecker,
  cCppExportChecker,
  phpExportChecker,
  swiftExportChecker,
  rubyExportChecker,
  dartExportChecker,
} from '../export-detection.js';
import { detectFrameworkFromAST } from '../framework-detection.js';
import { javaTypeConfig, kotlinTypeConfig } from '../type-extractors/jvm.js';
import { typeConfig as typescriptTypeConfig } from '../type-extractors/typescript.js';
import { typeConfig as pythonTypeConfig } from '../type-extractors/python.js';
import { typeConfig as goTypeConfig } from '../type-extractors/go.js';
import { typeConfig as cCppTypeConfig } from '../type-extractors/c-cpp.js';
import { typeConfig as csharpTypeConfig } from '../type-extractors/csharp.js';
import { typeConfig as rustTypeConfig } from '../type-extractors/rust.js';
import { typeConfig as phpTypeConfig } from '../type-extractors/php.js';
import { typeConfig as rubyTypeConfig } from '../type-extractors/ruby.js';
import { typeConfig as swiftTypeConfig } from '../type-extractors/swift.js';
import { typeConfig as dartTypeConfig } from '../type-extractors/dart.js';
import { generateId } from '../../../lib/utils.js';
import { appendKotlinWildcard } from '../import-resolvers/jvm.js';
import type { CallRouter } from '../call-routing.js';
import { extractJavaNamedBindings } from '../named-bindings/java.js';
import { extractKotlinNamedBindings } from '../named-bindings/kotlin.js';
import { extractTsNamedBindings } from '../named-bindings/typescript.js';
import { extractPythonNamedBindings } from '../named-bindings/python.js';
import { extractCSharpNamedBindings } from '../named-bindings/csharp.js';
import { extractRustNamedBindings } from '../named-bindings/rust.js';
import { extractPhpNamedBindings } from '../named-bindings/php.js';
import type { NamedBinding } from '../named-bindings/types.js';

// ============================================================================
// Language-specific helpers (worker has no access to LanguageProvider registry)
// ============================================================================

/** Map languages to their export checker functions */
const exportCheckers: Record<string, (node: any, name: string) => boolean> = {
  [SupportedLanguages.JavaScript]: tsExportChecker,
  [SupportedLanguages.TypeScript]: tsExportChecker,
  [SupportedLanguages.Python]: pythonExportChecker,
  [SupportedLanguages.Java]: javaExportChecker,
  [SupportedLanguages.Kotlin]: kotlinExportChecker,
  [SupportedLanguages.Go]: goExportChecker,
  [SupportedLanguages.Rust]: rustExportChecker,
  [SupportedLanguages.CSharp]: csharpExportChecker,
  [SupportedLanguages.C]: cCppExportChecker,
  [SupportedLanguages.CPlusPlus]: cCppExportChecker,
  [SupportedLanguages.PHP]: phpExportChecker,
  [SupportedLanguages.Ruby]: rubyExportChecker,
  [SupportedLanguages.Swift]: swiftExportChecker,
  [SupportedLanguages.Dart]: dartExportChecker,
};

/** Check if a symbol is exported/public in its language */
const isNodeExported = (node: any, name: string, language: SupportedLanguages): boolean => {
  const checker = exportCheckers[language];
  return checker ? checker(node, name) : true; // Default to true for unknown languages
};

/** Map languages to their type configs */
const typeConfigs: Record<string, any> = {
  [SupportedLanguages.Java]: javaTypeConfig,
  [SupportedLanguages.Kotlin]: kotlinTypeConfig,
  [SupportedLanguages.TypeScript]: typescriptTypeConfig,
  [SupportedLanguages.JavaScript]: typescriptTypeConfig,
  [SupportedLanguages.Python]: pythonTypeConfig,
  [SupportedLanguages.Go]: goTypeConfig,
  [SupportedLanguages.C]: cCppTypeConfig,
  [SupportedLanguages.CPlusPlus]: cCppTypeConfig,
  [SupportedLanguages.CSharp]: csharpTypeConfig,
  [SupportedLanguages.Rust]: rustTypeConfig,
  [SupportedLanguages.PHP]: phpTypeConfig,
  [SupportedLanguages.Ruby]: rubyTypeConfig,
  [SupportedLanguages.Swift]: swiftTypeConfig,
  [SupportedLanguages.Dart]: dartTypeConfig,
};

/** Map languages to their named binding extractors */
const namedBindingExtractors: Record<string, (node: any) => NamedBinding[] | undefined> = {
  [SupportedLanguages.Java]: extractJavaNamedBindings,
  [SupportedLanguages.Kotlin]: extractKotlinNamedBindings,
  [SupportedLanguages.TypeScript]: extractTsNamedBindings,
  [SupportedLanguages.JavaScript]: extractTsNamedBindings,
  [SupportedLanguages.Python]: extractPythonNamedBindings,
  [SupportedLanguages.CSharp]: extractCSharpNamedBindings,
  [SupportedLanguages.Rust]: extractRustNamedBindings,
  [SupportedLanguages.PHP]: extractPhpNamedBindings,
};

/** Extract named bindings from an import node for the given language */
const extractNamedBindings = (importNode: any, language: SupportedLanguages): NamedBinding[] | undefined => {
  const extractor = namedBindingExtractors[language];
  return extractor ? extractor(importNode) : undefined;
};

/** Built-in names that should be excluded from call graphs (noise reduction) */
const BUILTIN_NOISE = new Set([
  // JavaScript/TypeScript
  'console', 'window', 'document', 'Math', 'JSON', 'Object', 'Array', 'String', 'Number', 'Boolean',
  'Promise', 'Symbol', 'Map', 'Set', 'WeakMap', 'WeakSet', 'Date', 'RegExp', 'Error', 'Function',
  'parseInt', 'parseFloat', 'isNaN', 'isFinite', 'setTimeout', 'setInterval', 'clearTimeout', 'clearInterval',
  'require', 'module', 'exports', '__dirname', '__filename', 'process',
  // Python
  'print', 'len', 'range', 'str', 'int', 'float', 'list', 'dict', 'set', 'tuple', 'bool', 'None',
  'True', 'False', 'type', 'isinstance', 'hasattr', 'getattr', 'setattr', 'open', 'input',
  // Java
  'System', 'String', 'Integer', 'Long', 'Double', 'Float', 'Boolean', 'Object', 'Class',
  'List', 'Map', 'Set', 'Arrays', 'Collections', 'Optional',
  // Go
  'fmt', 'log', 'os', 'io', 'strings', 'strconv', 'time', 'context',
  // Rust
  'println', 'vec', 'Option', 'Result', 'String', 'Box', 'Rc', 'Arc', 'Cell', 'RefCell',
  // C#
  'Console', 'String', 'Int32', 'Int64', 'Double', 'Boolean', 'Object', 'Task', 'Enumerable',
  // PHP
  'echo', 'print', 'var_dump', 'die', 'exit', 'isset', 'empty', 'array', 'string', 'int',
  // Ruby
  'puts', 'print', 'p', 'raise', 'fail', 'require', 'include', 'extend', 'attr_reader', 'attr_writer', 'attr_accessor',
  // Swift
  'print', 'debugPrint', 'fatalError', 'preconditionFailure', 'assertionFailure',
]);

/** Check if a name is a built-in or noise symbol (excluded from call graph) */
const isBuiltInOrNoise = (name: string): boolean => BUILTIN_NOISE.has(name);

// Ruby call router for import/heritage/property dispatch
const rubyCallRouter: CallRouter = (calledName: string, callNode: any) => {
  // Ruby require/require_relative
  if (calledName === 'require' || calledName === 'require_relative') {
    // Extract the path from the first argument
    const args = callNode.childForFieldName?.('arguments') ?? callNode.children.find((c: any) => c.type === 'argument_list');
    if (args) {
      const firstArg = args.namedChildren?.[0];
      if (firstArg?.type === 'string') {
        const path = firstArg.text.slice(1, -1); // Remove quotes
        return { kind: 'import', importPath: path, isRelative: calledName === 'require_relative' };
      }
    }
  }
  // Ruby include/extend/prepend for heritage
  if (calledName === 'include' || calledName === 'extend' || calledName === 'prepend') {
    // Extract the mixin names from arguments
    const args = callNode.childForFieldName?.('arguments') ?? callNode.children.find((c: any) => c.type === 'argument_list');
    if (args) {
      const items: { enclosingClass: string; mixinName: string; heritageKind: 'include' | 'extend' | 'prepend' }[] = [];
      // Find enclosing class/module
      let parent = callNode.parent;
      let enclosingClass = '';
      while (parent) {
        if (parent.type === 'class' || parent.type === 'module') {
          const nameNode = parent.childForFieldName?.('name') ?? parent.children.find((c: any) => c.type === 'constant' || c.type === 'identifier');
          if (nameNode) enclosingClass = nameNode.text;
          break;
        }
        parent = parent.parent;
      }
      for (const arg of args.namedChildren ?? []) {
        if (arg.type === 'constant' || arg.type === 'identifier') {
          items.push({
            enclosingClass,
            mixinName: arg.text,
            heritageKind: calledName as 'include' | 'extend' | 'prepend',
          });
        }
      }
      return { kind: 'heritage', items };
    }
  }
  // Ruby attr_accessor/attr_reader/attr_writer for properties
  if (calledName === 'attr_accessor' || calledName === 'attr_reader' || calledName === 'attr_writer') {
    const args = callNode.childForFieldName?.('arguments') ?? callNode.children.find((c: any) => c.type === 'argument_list');
    if (args) {
      const items: { propName: string; accessorType: 'attr_accessor' | 'attr_reader' | 'attr_writer'; startLine: number; endLine: number }[] = [];
      for (const arg of args.namedChildren ?? []) {
        if (arg.type === 'simple_symbol' || arg.type === 'symbol') {
          const name = arg.text.replace(/^:/, '');
          items.push({
            propName: name,
            accessorType: calledName as 'attr_accessor' | 'attr_reader' | 'attr_writer',
            startLine: arg.startPosition.row,
            endLine: arg.endPosition.row,
          });
        }
      }
      return { kind: 'properties', items };
    }
  }
  return null;
};

/** Map languages to their call routers */
const callRouters: Record<string, CallRouter> = {
  [SupportedLanguages.Ruby]: rubyCallRouter,
};

/** Get the call router for a language */
const callRouter = (language: SupportedLanguages): CallRouter | null => {
  return callRouters[language] ?? null;
};

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
    /** Array of parameter type names for method overloading */
    parameterTypes?: string; // JSON array of parameter type names
    returnType?: string;
    /** JSON array of annotations on method/class: [{name: "@Transactional", attrs?: {key: value}}] */
    annotations?: string;
    /** JSON array of field info for DTO/Entity classes: [{name, type, annotations[]}] */
    fields?: string;
    /** JSON array of parameter annotations: [{name, type, annotations: string[]}] */
    parameterAnnotations?: string;
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
  requiredParameterCount?: number;
  parameterTypes?: string[];
  returnType?: string;
  declaredType?: string;
  ownerId?: string;
}

export interface ExtractedImport {
  filePath: string;
  rawImportPath: string;
  language: SupportedLanguages;
  /** Named bindings from the import (e.g., import {User as U} → [{local:'U', exported:'User'}]) */
  namedBindings?: { local: string; exported: string }[];
}

// Re-export from separate module (allows testing without worker init)
export { extractAnnotations } from '../annotation-extractor.js';
export type { AnnotationInfo } from '../annotation-extractor.js';

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
  /** Mixed chain of field and call expressions for complex receivers */
  receiverMixedChain?: Array<{ kind: 'field' | 'call'; name: string }>;
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
  /** Whether the route is defined on a @Controller class (vs @RestController or inherited) */
  isControllerClass?: boolean;
  /** Whether the method is inherited from a parent class */
  isInherited?: boolean;
  /** Media types the route produces, taken from `produces` attribute of @RequestMapping / @*Mapping */
  produces?: string[];
  /** Media types the route consumes, taken from `consumes` attribute of @RequestMapping / @*Mapping */
  consumes?: string[];
}

/**
 * Re-export of ExtractedAngularEdge from extractors/angular-metadata.ts.
 * The Angular module-metadata extractor lives in its own file so it can be
 * unit-tested without spinning up the worker; this re-export keeps the
 * existing `parse-worker` import surface for the orchestration layer.
 */
export type { ExtractedAngularEdge } from '../extractors/angular-metadata.js';

/** Constructor bindings keyed by filePath for cross-file type resolution */
export interface FileConstructorBindings {
  filePath: string;
  bindings: ConstructorBinding[];
}

/** Assignment extraction for type propagation (unused in current implementation) */
export interface ExtractedAssignment {
  filePath: string;
  lhs: string;
  rhs: string;
  sourceId: string;
  receiverTypeName?: string;
  receiverText?: string;
  propertyName?: string;
}

/** Fetch call for API tracking (unused in current implementation) */
export interface ExtractedFetchCall {
  filePath: string;
  url: string;
  method: string;
  sourceId: string;
  fetchURL?: string;
  lineNumber?: number;
}

/** Expo Router navigation call (router.push/replace/navigate) */
export interface ExtractedExpoNav {
  filePath: string;
  url: string;
  method: string;
  sourceId: string;
  lineNumber?: number;
}

/** Decorator-based route (Express/Hono/NestJS route handlers) */
export interface ExtractedDecoratorRoute {
  filePath: string;
  decorator: string;
  method?: string;
  path?: string;
  lineNumber?: number;
  /**
   * Optional handler function name (e.g. FastAPI `list_users`, Gin `listUsers`).
   * Framework routes whose receiver is a local app/router variable (not a
   * controller class) flow through the decorator-route path; when present this
   * is used as the Route node's handlerMethod instead of the HTTP verb.
   */
  handlerName?: string;
}

/** Tool definition for MCP */
export interface ExtractedToolDef {
  filePath: string;
  name: string;
  description?: string;
  lineNumber?: number;
}

/** ORM query extraction (unused in current implementation) */
export interface ExtractedORMQuery {
  filePath: string;
  entityType: string;
  operation: string;
  sourceId: string;
}

/** Type environment bindings per file */
export interface FileTypeEnvBindings {
  filePath: string;
  bindings: Map<string, string>;
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
  // Optional fields for future use (currently empty in worker)
  assignments?: ExtractedAssignment[];
  fetchCalls?: ExtractedFetchCall[];
  expoNavCalls?: ExtractedExpoNav[];
  decoratorRoutes?: ExtractedDecoratorRoute[];
  toolDefs?: ExtractedToolDef[];
  ormQueries?: ExtractedORMQuery[];
  typeEnvBindings?: FileTypeEnvBindings[];
  /** Angular @NgModule metadata edges (DECLARES / IMPORTS_MODULE / PROVIDES / BOOTSTRAPS) */
  angularMetadata?: ExtractedAngularEdge[];
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
// Annotation extraction (Java/Kotlin)
// ============================================================================

// Annotation extraction functions are in annotation-extractor.ts
// extractAnnotations is re-exported for use in this module

// ============================================================================
// Label detection from capture map
// ============================================================================

const getLabelFromCaptures = (captureMap: Record<string, any>): string | null => {
  // Skip imports (handled separately) and calls
  if (captureMap['import'] || captureMap['call']) return null;
  if (!captureMap['name']) return null;

  // Native HTML JSX tags (e.g. <div>, <span>, <h1>) start with a lowercase
  // letter; user-defined React components start with uppercase. Drop the
  // native tags so they don't pollute the graph (#107 follow-up).
  if (captureMap['definition.jsx_element']) {
    const tagName = captureMap['name'].text ?? '';
    if (!/^[A-Z]/.test(tagName)) return null;
    return 'CodeElement';
  }

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
    typeEnvBindings: [],
    skippedLanguages: {},
    fileCount: 0,
    ormQueries: [],
    expoNavCalls: [],
    fetchCalls: [],
    decoratorRoutes: [],
    angularMetadata: [],
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

    // Pick the right query for the grammar being used. For .ts files we use
    // TYPESCRIPT_QUERIES; for .tsx files we use TSX_QUERIES (which extends
    // the base with JSX-specific captures — Issue #107).
    const tsxQueryString = LANGUAGE_QUERIES[`${language}:tsx`] ?? queryString;

    // Process regular files for this language
    if (regularFiles.length > 0) {
      if (isLanguageAvailable(language, regularFiles[0].path)) {
        try {
          setLanguage(language, regularFiles[0].path);
          processFileGroup(regularFiles, language, queryString, result, onFileProcessed);
        } catch (err) {
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
          processFileGroup(tsxFiles, language, tsxQueryString, result, onFileProcessed);
        } catch (err) {
          // parser unavailable — skip this language group
        }
      } else {
        result.skippedLanguages[language] = (result.skippedLanguages[language] || 0) + tsxFiles.length;
      }
    }
  }

  // Verbose logging for call extraction
  if (isVerboseIngestionEnabled()) {
    const javaCalls = result.calls.filter(c => c.filePath.endsWith('.java')).length;
    console.debug(`[parse-worker] Extracted ${result.calls.length} calls (${javaCalls} Java), ${result.nodes.length} nodes, ${result.symbols.length} symbols`);
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
// Class Field Extraction (for DTOs and Entities)
// ============================================================================

/** Extracted field information from a class declaration */
export interface FieldInfo {
  name: string;
  type: string | null;
  annotations: string[];              // Annotation names only (backward compat)
  annotationAttrs?: AnnotationInfo[];  // Full annotation info with attrs
  modifiers?: string[];                // e.g., ["static", "final", "private"]
  value?: string;                      // Literal value for static final constants
}

/**
 * Extracts field information from a class declaration AST node.
 * Supports Java, TypeScript, C#, C++, Kotlin, PHP, Python, Ruby, Rust, Go, Swift field declarations.
 * Exported for use by sequential parsing path in parsing-processor.ts.
 */
export function extractClassFields(node: Parser.SyntaxNode, language: SupportedLanguages): FieldInfo[] {
  const fields: FieldInfo[] = [];

  // Find class body based on language
  const classBodyName = getClassBodyNodeName(language);
  const classBody = node.children.find((c: Parser.SyntaxNode) => c.type === classBodyName);
  if (!classBody) return [];

  for (const child of classBody.children) {
    const fieldInfo = extractFieldFromNode(child, language);
    if (fieldInfo) {
      fields.push(fieldInfo);
    }
  }

  return fields;
}

/**
 * Get the class body node type name for a given language.
 */
function getClassBodyNodeName(language: SupportedLanguages): string {
  switch (language) {
    case SupportedLanguages.Java:
      return 'class_body';
    case SupportedLanguages.TypeScript:
    case SupportedLanguages.JavaScript:
      return 'class_body';
    case SupportedLanguages.CSharp:
      return 'declaration_list';
    case SupportedLanguages.C:
    case SupportedLanguages.CPlusPlus:
      return 'field_declaration_list';
    case SupportedLanguages.Kotlin:
      return 'class_body';
    case SupportedLanguages.PHP:
      return 'declaration_list';
    case SupportedLanguages.Python:
      return 'block'; // Python uses block for class body
    case SupportedLanguages.Ruby:
      return 'body_statement';
    case SupportedLanguages.Rust:
      return 'field_declaration'; // Rust struct fields are in field_declaration_list
    case SupportedLanguages.Go:
      return 'field_declaration_list';
    case SupportedLanguages.Swift:
      return 'class_body';
    default:
      return 'class_body';
  }
}

/**
 * Extract field info from a single AST node (field_declaration, property_declaration, etc.)
 */
function extractFieldFromNode(node: Parser.SyntaxNode, language: SupportedLanguages): FieldInfo | null {
  const fieldNodeTypes = getFieldNodeTypes(language);

  if (!fieldNodeTypes.includes(node.type)) return null;

  switch (language) {
    case SupportedLanguages.Java:
      return extractJavaField(node);
    case SupportedLanguages.TypeScript:
    case SupportedLanguages.JavaScript:
      return extractTypeScriptField(node);
    case SupportedLanguages.CSharp:
      return extractCSharpField(node);
    case SupportedLanguages.C:
    case SupportedLanguages.CPlusPlus:
      return extractCppField(node);
    case SupportedLanguages.Kotlin:
      return extractKotlinField(node);
    case SupportedLanguages.PHP:
      return extractPhpField(node);
    case SupportedLanguages.Python:
      return extractPythonField(node);
    case SupportedLanguages.Ruby:
      return extractRubyField(node);
    case SupportedLanguages.Rust:
      return extractRustField(node);
    case SupportedLanguages.Go:
      return extractGoField(node);
    case SupportedLanguages.Swift:
      return extractSwiftField(node);
    default:
      return null;
  }
}

/**
 * Get field declaration node types for a language.
 */
function getFieldNodeTypes(language: SupportedLanguages): string[] {
  switch (language) {
    case SupportedLanguages.Java:
      return ['field_declaration'];
    case SupportedLanguages.TypeScript:
    case SupportedLanguages.JavaScript:
      return ['public_field_definition', 'field_definition'];
    case SupportedLanguages.CSharp:
      return ['field_declaration'];
    case SupportedLanguages.C:
    case SupportedLanguages.CPlusPlus:
      return ['field_declaration'];
    case SupportedLanguages.Kotlin:
      return ['property_declaration'];
    case SupportedLanguages.PHP:
      return ['property_declaration'];
    case SupportedLanguages.Python:
      return ['expression_statement', 'assignment']; // Python class variables
    case SupportedLanguages.Ruby:
      return ['assignment']; // Ruby class variables
    case SupportedLanguages.Rust:
      return ['field_declaration'];
    case SupportedLanguages.Go:
      return ['field_declaration'];
    case SupportedLanguages.Swift:
      return ['property_declaration'];
    default:
      return ['field_declaration'];
  }
}

/** Extract annotations from a node's modifiers or preceding siblings */
function extractAnnotationsFromModifiers(node: Parser.SyntaxNode): string[] {
  const annotations: string[] = [];

  // Check for modifiers sibling or child
  const parent = node.parent;
  if (!parent) return annotations;

  // Look for modifiers preceding this node
  for (const child of parent.children) {
    if (child === node) break; // Stop when we reach the current node

    if (child.type === 'modifiers') {
      for (const modifier of child.children) {
        if (modifier.type === 'marker_annotation' || modifier.type === 'annotation') {
          const annName = extractAnnotationName(modifier);
          if (annName) annotations.push(annName);
        }
      }
    } else if (child.type === 'marker_annotation' || child.type === 'annotation') {
      const annName = extractAnnotationName(child);
      if (annName) annotations.push(annName);
    }
  }

  // Also check for modifiers child (some grammars have modifiers inside field_declaration)
  const modifiersInside = node.children.find((c: Parser.SyntaxNode) => c.type === 'modifiers');
  if (modifiersInside) {
    for (const modifier of modifiersInside.children) {
      if (modifier.type === 'marker_annotation' || modifier.type === 'annotation') {
        const annName = extractAnnotationName(modifier);
        if (annName) annotations.push(annName);
      }
    }
  }

  // Check for annotation children (some grammars)
  for (const child of node.children) {
    if (child.type === 'marker_annotation' || child.type === 'annotation') {
      const annName = extractAnnotationName(child);
      if (annName) annotations.push(annName);
    }
  }

  return annotations;
}

/** Extract the name of an annotation (e.g., @Column, @NotNull).
 *  For binding annotations with a string argument (e.g., @PathVariable("id")),
 *  includes the argument: @PathVariable("id"). */
function extractAnnotationName(node: Parser.SyntaxNode): string | null {
  // marker_annotation: @ColumnName
  // annotation: @ColumnName(args)
  const nameNode = node.childForFieldName?.('name') ??
    node.children.find((c: Parser.SyntaxNode) => c.type === 'identifier' || c.type === 'scoped_identifier');
  if (!nameNode) return null;

  const annotationName = '@' + nameNode.text;

  // For parameter-binding annotations, extract the first string argument if present.
  // Spring uses this to bind to path/query/header variables: @PathVariable("bondProductCode")
  const BINDING_ANNOTATIONS = ['@PathVariable', '@RequestParam', '@RequestHeader', '@CookieValue', '@RequestBody'];
  if (BINDING_ANNOTATIONS.includes(annotationName)) {
    // Look for argument_list or arguments child containing a string_literal
    const argList = node.childForFieldName?.('arguments') ??
      node.children.find((c: Parser.SyntaxNode) => c.type === 'argument_list' || c.type === 'arguments');
    if (argList) {
      for (const arg of argList.children) {
        // string_literal: "bondProductCode"
        if (arg.type === 'string_literal') {
          // Strip surrounding quotes
          const argValue = arg.text.slice(1, -1);
          return `${annotationName}("${argValue}")`;
        }
        // Some parsers nest string_literal inside an argument
        const innerStr = arg.children?.find((c: Parser.SyntaxNode) => c.type === 'string_literal');
        if (innerStr) {
          const argValue = innerStr.text.slice(1, -1);
          return `${annotationName}("${argValue}")`;
        }
      }
    }
  }

  return annotationName;
}

/** Extract modifiers (static, final, private, public, etc.) from a field declaration */
function extractModifiersFromDeclaration(node: Parser.SyntaxNode): string[] {
  const modifiers: string[] = [];
  const parent = node.parent;
  if (!parent) return modifiers;

  // Look for modifiers preceding this node (Java-style: modifiers before field)
  for (const child of parent.children) {
    if (child === node) break;

    if (child.type === 'modifiers') {
      for (const mod of child.children) {
        // Skip annotations - they're handled separately
        if (mod.type === 'marker_annotation' || mod.type === 'annotation') continue;
        const text = mod.text.trim();
        if (text && !modifiers.includes(text)) {
          modifiers.push(text);
        }
      }
    } else if (child.type !== 'marker_annotation' && child.type !== 'annotation') {
      // Standalone modifier (e.g., 'static', 'final')
      const text = child.text.trim();
      if (text && !modifiers.includes(text)) {
        modifiers.push(text);
      }
    }
  }

  // Also check for modifiers inside field_declaration (some grammars)
  const modifiersInside = node.children.find((c: Parser.SyntaxNode) => c.type === 'modifiers');
  if (modifiersInside) {
    for (const mod of modifiersInside.children) {
      if (mod.type === 'marker_annotation' || mod.type === 'annotation') continue;
      const text = mod.text.trim();
      if (text && !modifiers.includes(text)) {
        modifiers.push(text);
      }
    }
  }

  return modifiers;
}

/**
 * Extract parameter annotations from a Java/Kotlin method declaration.
 * Returns array of {name, type, annotations: string[]}
 */
export function extractMethodParameterAnnotations(methodNode: Parser.SyntaxNode, language: SupportedLanguages): Array<{name: string, type: string, annotations: string[]}> {
  const params: Array<{name: string, type: string, annotations: string[]}> = [];

  if (language !== SupportedLanguages.Java && language !== SupportedLanguages.Kotlin) {
    return params;
  }

  // Find method_parameters or formal_parameters node
  const paramListNode = methodNode.children.find((c: Parser.SyntaxNode) =>
    c.type === 'method_parameters' ||
    c.type === 'formal_parameters' ||
    c.type === 'constructor_parameters'
  );

  if (!paramListNode) return params;

  for (const paramNode of paramListNode.children) {
    // Skip separators
    if (paramNode.type === ',' || paramNode.type === '(' || paramNode.type === ')') continue;

    const param: {name: string, type: string, annotations: string[]} = {
      name: '',
      type: '',
      annotations: []
    };

    // Extract annotations from modifiers
    const modifiers = paramNode.children.find((c: Parser.SyntaxNode) => c.type === 'modifiers');
    if (modifiers) {
      for (const mod of modifiers.children) {
        if (mod.type === 'marker_annotation' || mod.type === 'annotation') {
          const annName = extractAnnotationName(mod);
          if (annName) param.annotations.push(annName);
        }
      }
    }

    // Also check for annotations directly before parameter (some grammars)
    for (const child of paramNode.children) {
      if (child.type === 'marker_annotation' || child.type === 'annotation') {
        const annName = extractAnnotationName(child);
        if (annName) param.annotations.push(annName);
      }
    }

    // Extract type
    const typeNode = paramNode.children.find((c: Parser.SyntaxNode) =>
      c.type === 'type_identifier' ||
      c.type === 'integral_type' ||
      c.type === 'floating_point_type' ||
      c.type === 'boolean_type' ||
      c.type === 'void_type' ||
      c.type === 'generic_type' ||
      c.type === 'array_type' ||
      c.type === 'scoped_type_identifier' ||
      c.type === 'class_type' ||
      c.type === 'primitive_type'
    );
    if (typeNode) param.type = typeNode.text;

    // Extract name
    const nameNode = paramNode.children.find((c: Parser.SyntaxNode) =>
      c.type === 'identifier' ||
      c.type === 'variable_declarator_id'
    );
    if (nameNode) {
      if (nameNode.type === 'variable_declarator_id') {
        const id = nameNode.children.find((c: Parser.SyntaxNode) => c.type === 'identifier');
        param.name = id?.text ?? '';
      } else {
        param.name = nameNode.text;
      }
    }

    if (param.name) {
      params.push(param);
    }
  }

  return params;
}

/** Extract literal value from a variable_declarator (for static final constants) */
function extractFieldInitializerValue(varDeclarator: Parser.SyntaxNode): string | null {
  // variable_declarator: identifier = value
  // Find the '=' sign
  const eqIndex = varDeclarator.children.findIndex((c: Parser.SyntaxNode) => c.text === '=');
  if (eqIndex === -1) return null;

  const valueNode = varDeclarator.children[eqIndex + 1];
  if (!valueNode) return null;

  // Handle string literals
  if (valueNode.type === 'string_literal') {
    for (const child of valueNode.children) {
      if (child.type === 'string_fragment') {
        return child.text;
      }
    }
    // Fallback: remove quotes
    return valueNode.text.replace(/^["']|["']$/g, '');
  }

  // Handle number literals, boolean, identifiers (for enum constants)
  if (valueNode.type === 'number' ||
      valueNode.type === 'decimal_integer_literal' ||
      valueNode.type === 'decimal_floating_point_literal' ||
      valueNode.type === 'hex_integer_literal' ||
      valueNode.type === 'octal_integer_literal' ||
      valueNode.type === 'binary_integer_literal' ||
      valueNode.type === 'true' ||
      valueNode.type === 'false' ||
      valueNode.type === 'identifier' ||
      valueNode.type === 'type_identifier') {
    return valueNode.text;
  }

  // Handle field_access (e.g., SomeClass.CONSTANT)
  if (valueNode.type === 'field_access' || valueNode.type === 'scoped_identifier') {
    return valueNode.text;
  }

  // Handle null literal
  if (valueNode.type === 'null_literal') {
    return 'null';
  }

  return null;
}

/** Extract annotations with full attributes (for @Value("${...}") etc.) */
function extractAnnotationsWithAttrs(node: Parser.SyntaxNode): AnnotationInfo[] {
  const annotations: AnnotationInfo[] = [];
  const parent = node.parent;
  if (!parent) return annotations;

  // Look for modifiers preceding this node
  for (const child of parent.children) {
    if (child === node) break;

    if (child.type === 'modifiers') {
      for (const modifier of child.children) {
        if (modifier.type === 'marker_annotation' || modifier.type === 'annotation') {
          const ann = extractSingleAnnotation(modifier);
          if (ann) annotations.push(ann);
        }
      }
    } else if (child.type === 'marker_annotation' || child.type === 'annotation') {
      const ann = extractSingleAnnotation(child);
      if (ann) annotations.push(ann);
    }
  }

  // Check for modifiers inside field_declaration
  const modifiersInside = node.children.find((c: Parser.SyntaxNode) => c.type === 'modifiers');
  if (modifiersInside) {
    for (const modifier of modifiersInside.children) {
      if (modifier.type === 'marker_annotation' || modifier.type === 'annotation') {
        const ann = extractSingleAnnotation(modifier);
        if (ann) annotations.push(ann);
      }
    }
  }

  // Check for annotation children (some grammars)
  for (const child of node.children) {
    if (child.type === 'marker_annotation' || child.type === 'annotation') {
      const ann = extractSingleAnnotation(child);
      if (ann) annotations.push(ann);
    }
  }

  return annotations;
}

/** Java field extraction */
function extractJavaField(node: Parser.SyntaxNode): FieldInfo | null {
  // field_declaration: (modifiers)? type variable_declarator (,) *
  const typeNode = node.children.find((c: Parser.SyntaxNode) =>
    c.type === 'type_identifier' ||
    c.type === 'integral_type' ||
    c.type === 'floating_point_type' ||
    c.type === 'boolean_type' ||
    c.type === 'void_type' ||
    c.type === 'generic_type' ||
    c.type === 'array_type' ||
    c.type === 'scoped_type_identifier' ||
    c.type === 'class_type' ||
    c.type === 'primitive_type'
  );

  // Get type from type node
  let fieldType: string | null = null;
  if (typeNode) {
    fieldType = typeNode.text;
  }

  // Get name from variable_declarator
  const varDeclarator = node.children.find((c: Parser.SyntaxNode) => c.type === 'variable_declarator');
  if (!varDeclarator) return null;

  const nameNode = varDeclarator.children.find((c: Parser.SyntaxNode) =>
    c.type === 'identifier' ||
    c.type === 'field_identifier' ||
    (c.type === 'variable_declarator_id' && c.children[0])
  );

  let fieldName: string | null = null;
  if (nameNode) {
    fieldName = nameNode.text;
  } else if (varDeclarator.children[0]) {
    // variable_declarator_id contains the identifier
    const vdi = varDeclarator.children[0];
    if (vdi.type === 'identifier' || vdi.type === 'variable_declarator_id') {
      fieldName = vdi.text;
    }
  }

  if (!fieldName) return null;

  // Extract annotation names (backward compat)
  const annotations = extractAnnotationsFromModifiers(node);

  // Extract annotations with full attributes (for @Value etc.)
  const annotationAttrs = extractAnnotationsWithAttrs(node);

  // Extract modifiers (static, final, private, etc.)
  const modifiers = extractModifiersFromDeclaration(node);

  // Extract value for static final constants
  let value: string | undefined;
  if (modifiers.includes('static') && modifiers.includes('final')) {
    const initValue = extractFieldInitializerValue(varDeclarator);
    if (initValue !== null) {
      value = initValue;
    }
  }

  const result: FieldInfo = {
    name: fieldName,
    type: fieldType,
    annotations,
  };

  // Add optional fields if they have values
  if (annotationAttrs.length > 0) {
    result.annotationAttrs = annotationAttrs;
  }
  if (modifiers.length > 0) {
    result.modifiers = modifiers;
  }
  if (value !== undefined) {
    result.value = value;
  }

  return result;
}

/** TypeScript field extraction */
function extractTypeScriptField(node: Parser.SyntaxNode): FieldInfo | null {
  // public_field_definition: (accessibility_modifier)? (static)? name (: type)? (= value)?
  // field_definition in class body

  let fieldName: string | null = null;
  let fieldType: string | null = null;

  // Get name
  const nameNode = node.childForFieldName?.('name') ??
    node.children.find((c: Parser.SyntaxNode) =>
      c.type === 'property_identifier' ||
      c.type === 'identifier' ||
      c.type === 'private_field_identifier'
    );

  if (nameNode) {
    fieldName = nameNode.text;
  }

  // Get type
  const typeNode = node.childForFieldName?.('type') ??
    node.children.find((c: Parser.SyntaxNode) => c.type === 'type_annotation');

  if (typeNode) {
    // Handle type_annotation nodes: use firstNamedChild to strip ': ' prefix
    fieldType = typeNode.type === 'type_annotation'
      ? (typeNode.firstNamedChild?.text ?? null)
      : typeNode.text;
  }
  const annotations = extractAnnotationsFromModifiers(node);

  return { name: fieldName, type: fieldType, annotations };
}

/** C# field extraction */
function extractCSharpField(node: Parser.SyntaxNode): FieldInfo | null {
  // field_declaration: (modifiers)? type name (= value)? ;

  let fieldName: string | null = null;
  let fieldType: string | null = null;

  // Get type
  const typeNode = node.children.find((c: Parser.SyntaxNode) =>
    c.type === 'identifier' ||
    c.type === 'predefined_type' ||
    c.type === 'generic_name' ||
    c.type === 'array_type' ||
    c.type === 'nullable_type' ||
    c.type === 'type'
  );

  if (typeNode) {
    fieldType = typeNode.text;
  }

  // Get name from variable_declarator
  const varDeclarator = node.children.find((c: Parser.SyntaxNode) => c.type === 'variable_declarator');
  if (varDeclarator) {
    const nameNode = varDeclarator.childForFieldName?.('name') ??
      varDeclarator.children.find((c: Parser.SyntaxNode) => c.type === 'identifier');
    if (nameNode) {
      fieldName = nameNode.text;
    }
  }

  if (!fieldName) return null;

  const annotations = extractAnnotationsFromModifiers(node);

  return { name: fieldName, type: fieldType, annotations };
}

/** C++ field extraction */
function extractCppField(node: Parser.SyntaxNode): FieldInfo | null {
  // field_declaration: type name ;

  let fieldName: string | null = null;
  let fieldType: string | null = null;

  // Get type (could be primitive_identifier, type_identifier, etc.)
  const typeNode = node.children.find((c: Parser.SyntaxNode) =>
    c.type === 'primitive_type' ||
    c.type === 'type_identifier' ||
    c.type === 'sized_type_specifier' ||
    c.type === 'struct_specifier' ||
    c.type === 'class_specifier' ||
    c.type === 'qualified_identifier' ||
    c.type === 'template_type'
  );

  if (typeNode) {
    fieldType = typeNode.text;
  }

  // Get name from field_identifier
  const nameNode = node.children.find((c: Parser.SyntaxNode) =>
    c.type === 'field_identifier' ||
    c.type === 'identifier'
  );

  if (nameNode) {
    fieldName = nameNode.text;
  }

  if (!fieldName) return null;

  const annotations: string[] = []; // C++ doesn't have annotations in the same way

  return { name: fieldName, type: fieldType, annotations };
}

/** Kotlin field extraction */
function extractKotlinField(node: Parser.SyntaxNode): FieldInfo | null {
  // property_declaration: (modifiers)? (val|var) name (: type)? (= value)?

  let fieldName: string | null = null;
  let fieldType: string | null = null;

  // Get name from variable_declaration -> simple_identifier
  const varDecl = node.children.find((c: Parser.SyntaxNode) => c.type === 'variable_declaration');
  if (varDecl) {
    const nameNode = varDecl.children.find((c: Parser.SyntaxNode) => c.type === 'simple_identifier');
    if (nameNode) {
      fieldName = nameNode.text;
    }
  }

  // Fallback: direct simple_identifier
  if (!fieldName) {
    const nameNode = node.children.find((c: Parser.SyntaxNode) => c.type === 'simple_identifier');
    if (nameNode) {
      fieldName = nameNode.text;
    }
  }

  // Get type from type annotation
  const typeNode = node.children.find((c: Parser.SyntaxNode) => c.type === 'user_type') ??
    node.children.find((c: Parser.SyntaxNode) => c.type === 'type');
  if (typeNode) {
    fieldType = typeNode.text;
  }

  if (!fieldName) return null;

  const annotations = extractAnnotationsFromModifiers(node);

  return { name: fieldName, type: fieldType, annotations };
}

/** PHP field extraction */
function extractPhpField(node: Parser.SyntaxNode): FieldInfo | null {
  // property_declaration: (modifiers)? type? $name (= value)? ;

  let fieldName: string | null = null;
  let fieldType: string | null = null;

  // Get type
  const typeNode = node.children.find((c: Parser.SyntaxNode) =>
    c.type === 'union_type' ||
    c.type === 'intersection_type' ||
    c.type === 'nullable_type' ||
    c.type === 'primitive_type' ||
    c.type === 'class_type' ||
    c.type === 'type_identifier'
  );

  if (typeNode) {
    fieldType = typeNode.text;
  }

  // Get name from property_element -> variable_name -> name
  const propElement = node.children.find((c: Parser.SyntaxNode) => c.type === 'property_element');
  if (propElement) {
    const varName = propElement.children.find((c: Parser.SyntaxNode) => c.type === 'variable_name');
    if (varName) {
      const nameNode = varName.children.find((c: Parser.SyntaxNode) => c.type === 'name');
      if (nameNode) {
        fieldName = nameNode.text;
      }
    }
  }

  // Fallback: look for variable_name directly
  if (!fieldName) {
    const varName = node.children.find((c: Parser.SyntaxNode) => c.type === 'variable_name');
    if (varName) {
      const nameNode = varName.children.find((c: Parser.SyntaxNode) => c.type === 'name');
      if (nameNode) {
        fieldName = nameNode.text;
      } else {
        // Variable name without child name node
        fieldName = varName.text.replace(/^\$/, '');
      }
    }
  }

  if (!fieldName) return null;

  const annotations = extractAnnotationsFromModifiers(node);

  return { name: fieldName, type: fieldType, annotations };
}

/** Python field extraction (class variables) */
function extractPythonField(node: Parser.SyntaxNode): FieldInfo | null {
  // expression_statement containing assignment

  // Skip if this is inside a function (method)
  let parent = node.parent;
  while (parent) {
    if (parent.type === 'function_definition') return null;
    parent = parent.parent;
  }

  // Look for assignment within expression_statement
  const assignment = node.type === 'assignment' ? node :
    node.children.find((c: Parser.SyntaxNode) => c.type === 'assignment');

  if (!assignment) return null;

  const nameNode = assignment.children[0];
  if (!nameNode || nameNode.type !== 'identifier') return null;

  const fieldName = nameNode.text;
  const fieldType: string | null = null; // Python has no type annotations at class level in AST

  return { name: fieldName, type: fieldType, annotations: [] };
}

/** Ruby field extraction */
function extractRubyField(node: Parser.SyntaxNode): FieldInfo | null {
  // assignment in class body
  let parent = node.parent?.parent;
  if (parent && parent.type === 'method') return null;

  const nameNode = node.children[0];
  if (!nameNode || (nameNode.type !== 'identifier' && nameNode.type !== 'constant')) return null;

  // Skip instance/class variable assignments (they start with @ or @@)
  if (nameNode.text.startsWith('@')) return null;

  return { name: nameNode.text, type: null, annotations: [] };
}

/** Rust field extraction */
function extractRustField(node: Parser.SyntaxNode): FieldInfo | null {
  // field_declaration: name: type
  const nameNode = node.childForFieldName?.('name') ??
    node.children.find((c: Parser.SyntaxNode) => c.type === 'field_identifier' || c.type === 'identifier');

  if (!nameNode) return null;

  const typeNode = node.childForFieldName?.('type') ??
    node.children.find((c: Parser.SyntaxNode) => c.type === 'type_identifier' || c.type === 'generic_type');

  return {
    name: nameNode.text,
    type: typeNode?.text ?? null,
    annotations: [], // Rust uses attributes, not annotations
  };
}

/** Go field extraction */
function extractGoField(node: Parser.SyntaxNode): FieldInfo | null {
  // field_declaration: name type (embedded fields have no name)
  const nameNode = node.childForFieldName?.('name') ??
    node.children.find((c: Parser.SyntaxNode) => c.type === 'field_identifier' || c.type === 'identifier');

  if (!nameNode) return null; // Embedded field, skip

  const typeNode = node.children.find((c: Parser.SyntaxNode) =>
    c.type === 'type_identifier' ||
    c.type === 'qualified_type' ||
    c.type === 'pointer_type' ||
    c.type === 'slice_type' ||
    c.type === 'array_type' ||
    c.type === 'struct_type' ||
    c.type === 'interface_type'
  );

  return {
    name: nameNode.text,
    type: typeNode?.text ?? null,
    annotations: [], // Go uses tags, not annotations
  };
}

/** Swift field extraction */
function extractSwiftField(node: Parser.SyntaxNode): FieldInfo | null {
  // property_declaration: (modifiers)? let/var name (: type)? (= value)?
  const nameNode = node.childForFieldName?.('name') ??
    node.children.find((c: Parser.SyntaxNode) =>
      c.type === 'simple_identifier' ||
      c.type === 'identifier' ||
      c.type === 'pattern' // Swift uses pattern for names
    );

  if (!nameNode) return null;

  let fieldName = nameNode.text;
  // Unwrap pattern if needed
  if (nameNode.type === 'pattern' && nameNode.children[0]) {
    fieldName = nameNode.children[0].text;
  }

  const typeNode = node.childForFieldName?.('type') ??
    node.children.find((c: Parser.SyntaxNode) => c.type === 'type' || c.type === 'user_type');

  const annotations = extractAnnotationsFromModifiers(node);

  return {
    name: fieldName,
    type: typeNode?.text ?? null,
    annotations,
  };
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

// ============================================================================
// ORM Query extraction (Prisma and Supabase)
// ============================================================================

/**
 * Extract ORM queries from TypeScript/JavaScript files.
 * Detects Prisma: prisma.model.operation()
 * Detects Supabase: supabase.from('table').select(), etc.
 */
export function extractORMQueries(tree: any, filePath: string): ExtractedORMQuery[] {
  const queries: ExtractedORMQuery[] = [];

  // Prisma patterns: prisma.user.findMany(), prisma.post.create(), etc.
  // We look for call_expression where:
  //   - receiver is member_expression: prisma.user
  //   - property (operation) is one of: findMany, findUnique, findFirst, create, update, delete, upsert, count, etc.
  function findPrismaCalls(node: any): void {
    if (!node) return;

    if (node.type === 'call_expression') {
      const funcNode = node.childForFieldName?.('function');
      if (funcNode?.type === 'member_expression') {
        const property = funcNode.childForFieldName?.('property');
        const receiver = funcNode.childForFieldName?.('object');

        // Check if receiver is "prisma" or "prisma.something"
        let receiverName = '';
        let isPrismaChain = false;
        let modelName = '';
        if (receiver?.type === 'identifier') {
          receiverName = receiver.text;
        } else if (receiver?.type === 'member_expression') {
          const obj = receiver.childForFieldName?.('object');
          const prop = receiver.childForFieldName?.('property');
          // obj should be 'prisma' identifier, prop should be the model name
          if (obj?.type === 'identifier' && obj.text === 'prisma' && prop?.type === 'property_identifier') {
            receiverName = 'prisma';
            modelName = prop.text;
            isPrismaChain = true;
          }
        }

        if ((receiverName === 'prisma' || isPrismaChain) && property?.type === 'property_identifier') {
          const operation = property.text;
          // For prisma.user.findMany, the model name is extracted above as 'user'

          if (modelName && isPrismaOperation(operation)) {
            // Find enclosing function for sourceId
            let enclosingFunc = node.parent;
            while (enclosingFunc && !FUNCTION_NODE_TYPES.has(enclosingFunc.type)) {
              enclosingFunc = enclosingFunc.parent;
            }
            let sourceId = generateId('File', filePath);
            if (enclosingFunc) {
              const { funcName, label } = extractFunctionName(enclosingFunc);
              if (funcName) {
                sourceId = generateId(label, `${filePath}:${funcName}`);
              }
            }
            queries.push({
              filePath,
              entityType: modelName,
              operation: `prisma-${operation}`,
              sourceId,
            });
          }
        }
      }
    }

    // Recurse into children
    for (const child of node.children ?? []) {
      findPrismaCalls(child);
    }
  }

  // Supabase patterns: supabase.from('table').select(), supabase.from('bookings').insert(), etc.
  // We look for call_expression where:
  //   - receiver chain starts with "supabase"
  //   - first method is "from" with a string argument (table name)
  //   - subsequent methods are operations like select, insert, update, delete, etc.
  function findSupabaseCalls(node: any): void {
    if (!node) return;

    if (node.type === 'call_expression') {
      const funcNode = node.childForFieldName?.('function');
      if (funcNode?.type === 'member_expression') {
        const property = funcNode.childForFieldName?.('property');
        const receiver = funcNode.childForFieldName?.('object');

        if (property?.type === 'property_identifier' && receiver) {
          const operation = property.text;

          // Determine if this chain starts from supabase and extract table name from 'from' calls
          // Walk the receiver chain to find the root and extract tableName from 'from' argument
          let rootName = '';
          let tableName = '';
          let current: any = receiver;
          let depth = 0;
          const MAX_DEPTH = 5;

          while (current && depth < MAX_DEPTH) {
            depth++;
            if (current.type === 'identifier') {
              rootName = current.text;
              break;
            } else if (current.type === 'member_expression') {
              const obj = current.childForFieldName?.('object');
              const prop = current.childForFieldName?.('property');
              if (obj?.type === 'identifier' && obj.text === 'supabase' && prop?.type === 'property_identifier') {
                rootName = 'supabase';
              }
              current = obj;
            } else if (current.type === 'call_expression') {
              // This is a chained method call (e.g. supabase.from('bookings'))
              const fn = current.childForFieldName?.('function');
              if (fn?.type === 'member_expression') {
                const fnProp = fn.childForFieldName?.('property');
                const fnObj = fn.childForFieldName?.('object');
                if (fnProp?.type === 'property_identifier' && fnObj?.type === 'identifier' && fnObj.text === 'supabase') {
                  rootName = 'supabase';
                  // Extract table name from 'from' or 'rpc' argument
                  if (fnProp.text === 'from' || fnProp.text === 'rpc') {
                    const argsNode = current.childForFieldName?.('arguments');
                    if (argsNode) {
                      const firstArg = argsNode.namedChildren?.[0];
                      if (firstArg?.type === 'string') {
                        tableName = firstArg.text.slice(1, -1);
                      } else if (firstArg?.type === 'template_string') {
                        tableName = extractTemplateString(firstArg);
                      }
                    }
                  }
                }
                current = fnObj;
              } else {
                break;
              }
            } else {
              break;
            }
          }

          // For supabase method calls, create QUERIES entries
          if (rootName === 'supabase' && isSupabaseOperation(operation)) {
            // Find enclosing function for sourceId
            let enclosingFunc = node.parent;
            while (enclosingFunc && !FUNCTION_NODE_TYPES.has(enclosingFunc.type)) {
              enclosingFunc = enclosingFunc.parent;
            }
            let sourceId = generateId('File', filePath);
            if (enclosingFunc) {
              const { funcName, label } = extractFunctionName(enclosingFunc);
              if (funcName) {
                sourceId = generateId(label, `${filePath}:${funcName}`);
              }
            }
            queries.push({
              filePath,
              entityType: tableName,
              operation: `supabase-${operation}`,
              sourceId,
            });
          }
        }
      }
    }

    // Recurse into children
    for (const child of node.children ?? []) {
      findSupabaseCalls(child);
    }
  }

  findPrismaCalls(tree.rootNode);
  findSupabaseCalls(tree.rootNode);

  return queries;
}

function isPrismaOperation(op: string): boolean {
  return PRISMA_OPERATIONS.has(op);
}

function isSupabaseOperation(op: string): boolean {
  return SUPABASE_OPERATIONS.has(op);
}

function extractTemplateString(node: any): string {
  // Handle template strings - extract the template literal content
  const templateChildren = node.children ?? [];
  for (const child of templateChildren) {
    if (child.type === 'template_substitution') {
      // Dynamic template string - skip
      return '';
    }
    if (child.type === 'string_content') {
      return child.text;
    }
  }
  return '';
}

const PRISMA_OPERATIONS = new Set([
  'findMany', 'findUnique', 'findFirst', 'findFirstOrThrow',
  'create', 'createMany', 'upsert', 'update', 'updateMany',
  'delete', 'deleteMany', 'count', 'aggregate',
  'findRaw', 'aggregateRaw', 'groupBy',
]);

const SUPABASE_OPERATIONS = new Set([
  'select', 'insert', 'update', 'delete', 'upsert',
  'rpc', 'eq', 'neq', 'gt', 'gte', 'lt', 'lte',
  'order', 'limit', 'range', 'single', 'maybeSingle',
  'auth', 'storage', 'realtime',
]);

export function extractLaravelRoutes(tree: any, filePath: string): ExtractedRoute[] {
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
    if (isVerboseIngestionEnabled() && language === 'java') {
      console.debug(`[parse-worker] Java query created with language: ${lang ? 'loaded' : 'MISSING'}`);
      // Test query on a sample to verify it works
      const testCode = 'public class T { void m() { obj.method(); } }';
      const testTree = parser.parse(testCode);
      const testMatches = query.matches(testTree.rootNode);
      let callCount = 0;
      for (const m of testMatches) {
        for (const c of m.captures) {
          if (c.name === 'call') callCount++;
        }
      }
      console.debug(`[parse-worker] Test query on sample: ${testMatches.length} matches, ${callCount} call captures`);
    }
  } catch (err) {
    const message = `Query compilation failed for ${language}: ${err instanceof Error ? err.message : String(err)}`;
    if (parentPort) {
      parentPort.postMessage({ type: 'warning', message });
    } else {
      console.warn(message);
    }
    return;
  }

  // Pre-pass (WI-H85): if this group is Go, build a global registry
  // of Go interface method sets across the entire group. The per-file
  // loop below reuses the trees parsed here to avoid a second parse.
  // This registry enables the cross-file IMPLEMENTS detector to match
  // structs against interfaces defined in other files.
  const goGlobalRegistry: GoInterfaceMethodEntry[] = [];
  // WI-H85 pre-pass tree cache: maps file path → parsed Tree. The
  // per-file loop checks this first; if a tree is present it skips
  // `parser.parse()` entirely, eliminating the wasted re-parse that
  // the previous implementation paid (it only kept `rootNode` and
  // re-parsed to get a fresh `Tree` for the main loop).
  const goPreParsedTrees = new Map<string, Parser.Tree>();
  if (language === SupportedLanguages.Go) {
    for (const file of files) {
      if (file.content.length > TREE_SITTER_MAX_BUFFER) continue;
      try {
        const t = parser.parse(file.content, undefined, {
          bufferSize: getTreeSitterBufferSize(file.content.length),
        });
        goPreParsedTrees.set(file.path, t);
      } catch {
        // Skip un-parseable files; the per-file loop logs a warning.
      }
    }
    const registryEntries: Array<{ path: string; rootNode: Parser.SyntaxNode }> = [];
    for (const [p, t] of goPreParsedTrees) registryEntries.push({ path: p, rootNode: t.rootNode });
    goGlobalRegistry.push(...collectGoInterfaceMethods(registryEntries));
  }

  for (const file of files) {
    // Skip files larger than the max tree-sitter buffer (32 MB)
    if (file.content.length > TREE_SITTER_MAX_BUFFER) continue;

    let tree = goPreParsedTrees.get(file.path);
    if (!tree) {
      try {
        tree = parser.parse(file.content, undefined, { bufferSize: getTreeSitterBufferSize(file.content.length) });
      } catch (err) {
        console.warn(`Failed to parse file ${file.path}: ${err instanceof Error ? err.message : String(err)}`);
        continue;
      }
    }

    result.fileCount++;
    onFileProcessed?.();

    // Debug: log Java file processing
    if (isVerboseIngestionEnabled() && language === 'java') {
      console.debug(`[parse-worker] Processing Java file: ${file.path}`);
    }

    // Build per-file type environment + constructor bindings in a single AST walk.
    // Constructor bindings are verified against the SymbolTable in processCallsFromExtracted.
    const typeEnv = buildTypeEnv(tree, language);
    const routerForLanguage = callRouters[language];

    // Extract FILE_SCOPE bindings for field/local variable type resolution
    // This enables resolution of receiver types for calls like `cashService.unholdMoney()`
    // where `cashService` is a field declared as `private CashService cashService;`
    const fileScopeBindings = typeEnv.fileScope();
    if (fileScopeBindings.size > 0) {
      result.typeEnvBindings.push({ filePath: file.path, bindings: new Map(fileScopeBindings) });
      if (isVerboseIngestionEnabled() && language === 'java') {
        console.debug(`[parse-worker] FILE_SCOPE bindings for ${file.path}: ${fileScopeBindings.size} entries`);
      }
    }

    if (typeEnv.constructorBindings.length > 0) {
      result.constructorBindings.push({ filePath: file.path, bindings: [...typeEnv.constructorBindings] });
    }

    let matches;
    try {
      matches = query.matches(tree.rootNode);
      if (isVerboseIngestionEnabled() && language === 'java') {
        console.debug(`[parse-worker] JAVA_MATCH: ${file.path}: ${matches.length} matches returned`);
      }
    } catch (err) {
      console.warn(`Query execution failed for ${file.path}: ${err instanceof Error ? err.message : String(err)}`);
      continue;
    }

    // Debug: log Java file processing summary
    if (isVerboseIngestionEnabled() && language === 'java') {
      const callCaptures = matches.reduce((count, m) => {
        const hasCall = m.captures.some((c: any) => c.name === 'call');
        return hasCall ? count + 1 : count;
      }, 0);

      // Count method_invocation nodes in tree
      const countNodes = (node: any, type: string): number => {
        let count = node.type === type ? 1 : 0;
        for (let i = 0; i < node.childCount; i++) {
          count += countNodes(node.child(i), type);
        }
        return count;
      };
      const methodInvCount = countNodes(tree.rootNode, 'method_invocation');

      console.debug(`[parse-worker] JAVA_ALL: ${file.path}: ${matches.length} matches, ${callCaptures} calls, ${methodInvCount} method_inv`);
    }

    // Track method name occurrences per file to generate unique IDs for overloaded methods.
    // Java/Kotlin/C# support method overloading — multiple methods with the same name but different
    // signatures. Without disambiguation, overloaded methods collide on the same node ID and only
    // the first overload survives in the graph.
    const methodNameCounts = new Map<string, number>();

    for (const match of matches) {
      const captureMap: Record<string, any> = {};
      for (const c of match.captures) {
        captureMap[c.name] = c.node;
      }

      // Extract Express/Hono route registration BEFORE call processing.
      // Some Express calls (app.get) also match as call expressions, so we
      // handle them here first to prevent them from being treated as generic calls.
      if (captureMap['express_route'] && captureMap['express_route.method'] && captureMap['express_route.path']) {
        const method = captureMap['express_route.method'].text;
        const routePath = captureMap['express_route.path'].text;
        result.decoratorRoutes.push({
          filePath: file.path,
          decorator: method,
          path: routePath,
          lineNumber: captureMap['express_route'].startPosition.row,
        });
        continue;
      }

      // Extract HTTP decorators: @Get('/path'), @Post('/path'), @RequestMapping('/path')
      if (captureMap['decorator'] && captureMap['decorator.name']) {
        const decoratorName = captureMap['decorator.name'].text;
        const ROUTE_DECORATOR_NAMES = new Set(['Get', 'Post', 'Put', 'Delete', 'Patch', 'Route', 'RequestMapping', 'GetMapping', 'PostMapping', 'PutMapping', 'DeleteMapping', 'PatchMapping']);
        if (ROUTE_DECORATOR_NAMES.has(decoratorName)) {
          const decoratorArg = captureMap['decorator.arg']?.text;
          const routePath = decoratorArg || '';
          const httpMethod = decoratorName.replace(/Mapping$/, '').toUpperCase();
          result.decoratorRoutes.push({
            filePath: file.path,
            decorator: decoratorName,
            method: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH'].includes(httpMethod) ? httpMethod : 'GET',
            path: routePath,
            lineNumber: captureMap['decorator'].startPosition.row,
          });
          continue;
        }
      }

      // Extract MCP tool decorators: @mcp.tool() or @tool()
      if (captureMap['mcp_tool'] && captureMap['mcp_tool.name']) {
        const funcNameNode = captureMap['mcp_tool.name'];
        const decoratorNode = captureMap['mcp_tool'];

        // Verify that the decorator is @mcp.tool()
        const mcpObj = captureMap['_mcp_obj'];
        const toolMethod = captureMap['_tool_method'];
        if (mcpObj?.text === 'mcp' && toolMethod?.text === 'tool') {
          // Extract description from docstring if present
          let description: string | undefined;
          const decoratedDef = decoratorNode;
          const funcDef = decoratedDef.children?.find((c: any) => c.type === 'function_definition');
          if (funcDef) {
            const bodyNode = funcDef.childForFieldName?.('body') ?? funcDef.children?.find((c: any) => c.type === 'block' || c.type === 'function_body');
            if (bodyNode && bodyNode.children) {
              const firstChild = bodyNode.children.find((c: any) => c.type === 'expression_statement' || c.type === 'string');
              if (firstChild?.firstChild?.type === 'string') {
                const stringNode = firstChild.firstChild;
                const stringContent = stringNode.childForFieldName?.('content') ?? stringNode.children?.find((c: any) => c.type === 'string_content');
                if (stringContent) {
                  description = stringContent.text;
                }
              }
            }
          }

          result.toolDefs.push({
            filePath: file.path,
            name: funcNameNode.text,
            description,
            lineNumber: decoratorNode.startPosition.row,
          });
        }
        continue;
      }

      // Extract fetch() calls: fetch('/api/grants')
      if (captureMap['route.fetch']) {
        const urlNode = captureMap['route.url'] ?? captureMap['route.template_url'];
        if (urlNode) {
          result.fetchCalls.push({
            filePath: file.path,
            url: urlNode.text,
            method: 'GET',
            sourceId: generateId('File', file.path),
            fetchURL: urlNode.text,
            lineNumber: captureMap['route.fetch'].startPosition.row,
          });
        }
        continue;
      }

      // Extract HTTP client calls (axios.get, $.post, etc.) — consumer, not route definition
      if (captureMap['http_client'] && captureMap['http_client.url']) {
        const method = captureMap['http_client.method']?.text;
        const url = captureMap['http_client.url'].text;
        const EXPRESS_ROUTE_METHODS = new Set(['get', 'post', 'put', 'delete', 'patch', 'all', 'use', 'route']);
        if (method && !EXPRESS_ROUTE_METHODS.has(method) && url.startsWith('/')) {
          result.fetchCalls.push({
            filePath: file.path,
            url,
            method: method.toUpperCase(),
            sourceId: generateId('File', file.path),
            fetchURL: url,
            lineNumber: captureMap['http_client'].startPosition.row,
          });
        }
        continue;
      }

      // Extract Expo Router navigation calls: router.push('/path'), router.replace('/path'), router.navigate('/path')
      if (captureMap['expo_nav'] && captureMap['expo_nav.url']) {
        const url = captureMap['expo_nav.url'].text;
        const navMethod = captureMap['expo_nav.method']?.text;
        result.expoNavCalls.push({
          filePath: file.path,
          url,
          method: navMethod?.toUpperCase() ?? 'PUSH',
          sourceId: generateId('File', file.path),
          lineNumber: captureMap['expo_nav'].startPosition.row,
        });
        continue;
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
          if (routerForLanguage) {
            const routed = routerForLanguage(calledName, captureMap['call']);
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
          }

          if (!isBuiltInOrNoise(calledName)) {
            const callNode = captureMap['call'];
            const sourceId = findEnclosingFunctionId(callNode, file.path)
              || generateId('File', file.path);
            const callForm = inferCallForm(callNode, callNameNode);
            let receiverName = callForm === 'member' ? extractReceiverName(callNameNode) : undefined;
            let receiverTypeName = receiverName ? typeEnv.lookup(receiverName, callNode) : undefined;

            // DEBUG: Log when typeEnv.lookup fails for controller fields
            if (isVerboseIngestionEnabled() && language === 'java' && receiverName && !receiverTypeName && file.path.includes('Controller')) {
              const fileScope = typeEnv.fileScope();
              const inFileScope = fileScope.has(receiverName);
              console.debug(`[parse-worker] typeEnv.lookup('${receiverName}') returned undefined in ${file.path}`);
              console.debug(`[parse-worker]   FILE_SCOPE has '${receiverName}': ${inFileScope}`);
              if (inFileScope) {
                console.debug(`[parse-worker]   FILE_SCOPE['${receiverName}'] = ${fileScope.get(receiverName)}`);
              }
            }

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
          // For Go (issue #26), anonymous fields emit a COMPOSITION edge via
          // the post-pass collectGoCompositionHeritage rather than EXTENDS.
          // Other languages do not embed types via anonymous fields, so the
          // original `extends` emission is preserved for them.
          const extendsNode = captureMap['heritage.extends'];
          const fieldDecl = extendsNode.parent;
          const isNamedField = fieldDecl?.type === 'field_declaration'
            && !!fieldDecl.childForFieldName('name');
          if (language === SupportedLanguages.Go) {
            // Go (issue #26): anonymous embedded fields emit a COMPOSITION edge via
            // the post-pass collectGoCompositionHeritage (below), NOT EXTENDS. Named
            // Go struct fields (e.g. `Breed string`) are not inheritance and emit
            // nothing here. Either way, Go pushes no 'extends' from this branch.
          } else if (!isNamedField) {
            // All other languages: the heritage.extends parent is a superclass
            // clause (superclasses / base_list / class_heritage / base_class_clause
            // / extends_clause / ...), never a named field_declaration — so this
            // preserves the original EXTENDS emission for normal class inheritance.
            // (Restored after #150; the prior isAnonymousField guard silently
            // dropped non-Go EXTENDS in the worker path.)
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

      // Debug: log when Method nodes are created
      if (isVerboseIngestionEnabled() && nodeLabel === 'Method' && file.path.includes('Controller')) {
        console.debug(`[parse-worker] Creating Method node: ${nodeName} in ${file.path}`);
      }

      const definitionNode = getDefinitionNodeFromCaptures(captureMap);
      const startLine = definitionNode ? definitionNode.startPosition.row : (nameNode ? nameNode.startPosition.row : 0);

      // Generate unique node ID for Method/Constructor nodes, handling method overloading.
      // For overloaded methods (same name, different parameters), append a 0-based index suffix
      // to distinguish them: Method:filePath:methodName for the first overload,
      // Method:filePath:methodName:1 for the second, etc.
      // Overload 0 keeps the original format for backward compatibility.
      let nodeId: string;
      if (nodeLabel === 'Method' || nodeLabel === 'Constructor') {
        const nameKey = `${file.path}:${nodeName}`;
        const overloadIndex = methodNameCounts.get(nameKey) ?? 0;
        methodNameCounts.set(nameKey, overloadIndex + 1);
        nodeId = overloadIndex > 0
          ? `${generateId(nodeLabel, `${file.path}:${nodeName}`)}:${overloadIndex}`
          : generateId(nodeLabel, `${file.path}:${nodeName}`);
      } else {
        nodeId = generateId(nodeLabel, `${file.path}:${nodeName}`);
      }

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
      let parameterTypes: string[] | undefined;
      let requiredParameterCount: number | undefined;
      if (nodeLabel === 'Function' || nodeLabel === 'Method' || nodeLabel === 'Constructor') {
        const sig = extractMethodSignature(definitionNode);
        parameterCount = sig.parameterCount;
        returnType = sig.returnType;
        // Store parameter types for languages with method overloading
        if (sig.parameterTypes && sig.parameterTypes.length > 0) {
          parameterTypes = sig.parameterTypes;
        }
        requiredParameterCount = sig.requiredParameterCount;

        // Language-specific return type fallback (e.g. Ruby YARD @return [Type])
        // Also upgrades uninformative AST types like PHP `array` with PHPDoc `@return User[]`
        if ((!returnType || returnType === 'array' || returnType === 'iterable') && definitionNode) {
          const tc = typeConfigs[language as keyof typeof typeConfigs];
          if (tc?.extractReturnType) {
            const docReturn = tc.extractReturnType(definitionNode);
            if (docReturn) returnType = docReturn;
          }
        }
      }

      // ── Annotation extraction for Java/Kotlin methods and classes ──
      let annotations: string | undefined;
      if ((language === SupportedLanguages.Java || language === SupportedLanguages.Kotlin) &&
          (nodeLabel === 'Method' || nodeLabel === 'Class') &&
          definitionNode) {
        const extractedAnns = extractAnnotations(definitionNode);
        if (extractedAnns.length > 0) {
          annotations = JSON.stringify(extractedAnns);
        }
      }

      // ── Parameter annotation extraction for Java/Kotlin methods ──
      let parameterAnnotations: string | undefined;
      if ((language === SupportedLanguages.Java || language === SupportedLanguages.Kotlin) &&
          (nodeLabel === 'Method' || nodeLabel === 'Constructor') &&
          definitionNode) {
        const params = extractMethodParameterAnnotations(definitionNode, language);
        if (params.length > 0) {
          parameterAnnotations = JSON.stringify(params);
        }
      }

      // ── Field extraction for DTO/Entity classes ──
      let fields: string | undefined;
      if (nodeLabel === 'Class' && definitionNode) {
        const classFields = extractClassFields(definitionNode, language);
        if (classFields.length > 0) {
          fields = JSON.stringify(classFields);
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
          ...(parameterTypes !== undefined ? { parameterTypes: JSON.stringify(parameterTypes) } : {}),
          ...(annotations !== undefined ? { annotations } : {}),
          ...(fields !== undefined ? { fields } : {}),
          ...(parameterAnnotations !== undefined ? { parameterAnnotations } : {}),
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
        ...(requiredParameterCount !== undefined ? { requiredParameterCount } : {}),
        ...(parameterTypes !== undefined ? { parameterTypes } : {}),
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

    // Extract ORM queries (Prisma and Supabase)
    const extractedORMQueries = extractORMQueries(tree, file.path);
    if (extractedORMQueries.length > 0) {
      result.ormQueries.push(...extractedORMQueries);
    }

    // Extract Laravel routes from route files via procedural AST walk
    if (language === SupportedLanguages.PHP && (file.path.includes('/routes/') || file.path.startsWith('routes/')) && file.path.endsWith('.php')) {
      const extractedRoutes = extractLaravelRoutes(tree, file.path);
      result.routes.push(...extractedRoutes);
    }

    // Extract Spring routes from Java controller files
    if (language === SupportedLanguages.Java && (file.content.includes('@Controller') || file.content.includes('@RestController'))) {
      const springRoutes = extractSpringRoutes(tree, file.path);
      result.routes.push(...springRoutes);
    }

    // Extract Express/Hono routes via procedural AST walk (fallback when tree-sitter query patterns don't match)
    if (language === SupportedLanguages.JavaScript || language === SupportedLanguages.TypeScript) {
      const expressRoutes = extractExpressRoutes(tree, file.path);
      if (expressRoutes.length > 0) {
        result.decoratorRoutes.push(...expressRoutes);
      }
    }

    // Extract FastAPI routes from Python files (Issues #79, #5, #78)
    if (language === SupportedLanguages.Python) {
      const fastApiRoutes = extractFastApiRoutes(tree, file.path);
      if (fastApiRoutes.length > 0) {
        result.routes.push(...fastApiRoutes);
      }
    }

    // Extract Gin routes from Go files (Issues #80, #6)
    if (language === SupportedLanguages.Go) {
      const ginRoutes = extractGinRoutes(tree, file.path);
      if (ginRoutes.length > 0) {
        result.routes.push(...ginRoutes);
      }
    }

    // Extract Angular routes from `.ts`/`.tsx` files that import `@angular/router`
    // or use `RouterModule` / `provideRouter`. Emits `ExtractedRoute` records
    // (client-side Angular routes have no HTTP method — we use GET).
    if (language === SupportedLanguages.TypeScript && isAngularFile(file.path, file.content)) {
      const angularRoutes = extractAngularRoutes(tree, file.path);
      if (angularRoutes.length > 0) {
        result.routes.push(...angularRoutes);
      }
    }

    // Extract Angular @NgModule metadata edges (#32 — AppModule has no outgoing edges)
    // For every class decorated with `@NgModule({...})`, emit one edge per
    // identifier in `declarations` / `imports` / `providers` / `bootstrap` arrays.
    // Edge types: DECLARES, IMPORTS_MODULE, PROVIDES, BOOTSTRAPS.
    if (language === SupportedLanguages.TypeScript || language === SupportedLanguages.JavaScript) {
      const angularMetadata = extractAngularMetadata(tree, file.path);
      if (angularMetadata.length > 0) {
        result.angularMetadata.push(...angularMetadata);
      }
    }

    // Extract Angular CALLS edges (#31).
    //   @NgModule({ providers: [X, Y] })            → CALLS AppModule → X, Y
    //   @Component({ template: '(click)="on()"' })  → CALLS AppComponent → on
    // Emits ExtractedCall records that flow through processCallsFromExtracted.
    if (language === SupportedLanguages.TypeScript || language === SupportedLanguages.JavaScript) {
      const angularCalls = extractAngularCalls(tree, file.path);
      for (const ac of angularCalls) {
        result.calls.push({
          filePath: ac.filePath,
          calledName: ac.calledName,
          sourceId: ac.sourceId,
          callForm: ac.callForm,
          ...(ac.receiverName !== undefined ? { receiverName: ac.receiverName } : {}),
          ...(ac.receiverTypeName !== undefined ? { receiverTypeName: ac.receiverTypeName } : {}),
        });
      }
    }

    // Go-specific relationship passes (issue #20 + #26).
    // Runs AFTER the main match loop so per-file struct method sets are stable
    // and AST-derived interface method sets are authoritative. The Go query's
    // `definition.method` capture collapses interface methods with struct
    // methods of the same name (one Method node per file:method), so we
    // re-walk interface_type bodies here to recover interface method sets.
    if (language === SupportedLanguages.Go) {
      const fileSymbols = result.symbols.filter((s) => s.filePath === file.path);
      // IMPLEMENTS via method-set superset (#20)
      const implementsItems = collectGoImplementsHeritage(file.path, tree.rootNode, fileSymbols);
      // Track same-file pairs for cross-file dedup (invariant 7).
      const sameFilePairs = new Set<string>();
      for (const it of implementsItems) {
        sameFilePairs.add(`${it.className}->${it.parentName}`);
        result.heritage.push({
          filePath: it.filePath,
          className: it.className,
          parentName: it.parentName,
          kind: it.kind,
        });
      }
      // WI-H85 / Issue #85: cross-file Go IMPLEMENTS second pass.
      // The same-file pass above is authoritative for same-file pairs.
      // This second pass adds cross-file pairs at confidence 0.7 and
      // tags them with kind 'cross-file-implements' + a confidence
      // payload so the consumer (processHeritageFromExtracted) can
      // apply the cross-file confidence directly.
      const crossFileItems = collectGoImplementsCrossFile(
        file.path,
        tree.rootNode,
        fileSymbols,
        goGlobalRegistry,
        sameFilePairs,
      );
      for (const it of crossFileItems) {
        // Encode confidence and parentFilePath in the kind string so the
        // downstream consumer can recover them. The consumer
        // (processHeritageFromExtracted) parses this back to the typed
        // shape via `crossFileItems[i].confidence` / `.parentFilePath`.
        // The format is: `cross-file-implements|<parentFilePath>|<confidence>`
        result.heritage.push({
          filePath: it.filePath,
          className: it.className,
          parentName: it.parentName,
          kind: `cross-file-implements|${it.parentFilePath}|${it.confidence}`,
        });
      }
      // COMPOSITION for anonymous struct fields (#26).
      // Replaces the previous EXTENDS emission from the Go heritage query —
      // see the heritage query de-duplication in this same loop: anonymous
      // fields no longer reach `result.heritage` as 'extends' because we
      // skip them when `fieldDecl.childForFieldName('name')` is truthy.
      // (See heritage.extends branch above for the field-name guard.)
      const compositionItems = collectGoCompositionHeritage(file.path, tree.rootNode);
      for (const it of compositionItems) {
        result.heritage.push({
          filePath: it.filePath,
          className: it.className,
          parentName: it.parentName,
          kind: it.kind,
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
  nodes: [], relationships: [], symbols: [],
  imports: [], calls: [], heritage: [], routes: [], constructorBindings: [], typeEnvBindings: [], skippedLanguages: {}, fileCount: 0,
  ormQueries: [],
  fetchCalls: [],
  expoNavCalls: [],
  decoratorRoutes: [],
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
  if (src.ormQueries) {
    if (!target.ormQueries) target.ormQueries = [];
    target.ormQueries.push(...src.ormQueries);
  }
  if (src.typeEnvBindings) {
    if (!target.typeEnvBindings) target.typeEnvBindings = [];
    target.typeEnvBindings.push(...src.typeEnvBindings);
  }
  if (src.fetchCalls) {
    if (!target.fetchCalls) target.fetchCalls = [];
    target.fetchCalls.push(...src.fetchCalls);
  }
  if (src.expoNavCalls) {
    if (!target.expoNavCalls) target.expoNavCalls = [];
    target.expoNavCalls.push(...src.expoNavCalls);
  }
  if (src.decoratorRoutes) {
    if (!target.decoratorRoutes) target.decoratorRoutes = [];
    target.decoratorRoutes.push(...src.decoratorRoutes);
  }
  for (const [lang, count] of Object.entries(src.skippedLanguages)) {
    target.skippedLanguages[lang] = (target.skippedLanguages[lang] || 0) + count;
  }
  target.fileCount += src.fileCount;
};

// Only set up message handler when running as a worker (parentPort is defined)
if (parentPort) {
  parentPort.on('message', (msg: any) => {
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
      accumulated = { nodes: [], relationships: [], symbols: [], imports: [], calls: [], heritage: [], routes: [], constructorBindings: [], typeEnvBindings: [], skippedLanguages: {}, fileCount: 0, ormQueries: [] };
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
}

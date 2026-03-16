import { KnowledgeGraph } from '../graph/types.js';
import { ASTCache } from './ast-cache.js';
import type { SymbolDefinition } from './symbol-table.js';
import Parser from 'tree-sitter';
import type { ResolutionContext } from './resolution-context.js';
import { TIER_CONFIDENCE, type ResolutionTier } from './resolution-context.js';
import { isLanguageAvailable, loadParser, loadLanguage } from '../tree-sitter/parser-loader.js';
import { LANGUAGE_QUERIES } from './tree-sitter-queries.js';
import { generateId } from '../../lib/utils.js';
import {
  getLanguageFromFilename,
  isVerboseIngestionEnabled,
  yieldToEventLoop,
  FUNCTION_NODE_TYPES,
  extractFunctionName,
  isBuiltInOrNoise,
  countCallArguments,
  inferCallForm,
  extractReceiverName,
  extractReceiverNode,
  findEnclosingClassId,
  CALL_EXPRESSION_TYPES,
  MAX_CHAIN_DEPTH,
  extractCallChain,
} from './utils.js';
import { buildTypeEnv } from './type-env.js';
import type { ConstructorBinding } from './type-env.js';
import { getTreeSitterBufferSize } from './constants.js';
import type { ExtractedCall, ExtractedHeritage, ExtractedRoute, FileConstructorBindings } from './workers/parse-worker.js';
import { callRouters } from './call-routing.js';

/**
 * Walk up the AST from a node to find the enclosing function/method.
 * Returns null if the call is at module/file level (top-level code).
 */
const findEnclosingFunction = (
  node: any,
  filePath: string,
  ctx: ResolutionContext
): string | null => {
  let current = node.parent;

  while (current) {
    if (FUNCTION_NODE_TYPES.has(current.type)) {
      const { funcName, label } = extractFunctionName(current);

      if (funcName) {
        const resolved = ctx.resolve(funcName, filePath);
        if (resolved?.tier === 'same-file' && resolved.candidates.length > 0) {
          return resolved.candidates[0].nodeId;
        }

        return generateId(label, `${filePath}:${funcName}`);
      }
    }
    current = current.parent;
  }

  return null;
};

/**
 * Verify constructor bindings against SymbolTable and infer receiver types.
 * Shared between sequential (processCalls) and worker (processCallsFromExtracted) paths.
 */
const verifyConstructorBindings = (
  bindings: readonly ConstructorBinding[],
  filePath: string,
  ctx: ResolutionContext,
  graph?: KnowledgeGraph,
): Map<string, string> => {
  const verified = new Map<string, string>();

  for (const { scope, varName, calleeName, receiverClassName } of bindings) {
    const tiered = ctx.resolve(calleeName, filePath);
    const isClass = tiered?.candidates.some(def => def.type === 'Class') ?? false;

    if (isClass) {
      verified.set(receiverKey(scope, varName), calleeName);
    } else {
      let callableDefs = tiered?.candidates.filter(d =>
        d.type === 'Function' || d.type === 'Method'
      );

      // When receiver class is known (e.g. $this->method() in PHP), narrow
      // candidates to methods owned by that class to avoid false disambiguation failures.
      if (callableDefs && callableDefs.length > 1 && receiverClassName) {
        if (graph) {
          // Worker path: use graph.getNode (fast, already in-memory)
          const narrowed = callableDefs.filter(d => {
            if (!d.ownerId) return false;
            const owner = graph.getNode(d.ownerId);
            return owner?.properties.name === receiverClassName;
          });
          if (narrowed.length > 0) callableDefs = narrowed;
        } else {
          // Sequential path: use ctx.resolve (no graph available)
          const classResolved = ctx.resolve(receiverClassName, filePath);
          if (classResolved && classResolved.candidates.length > 0) {
            const classNodeIds = new Set(classResolved.candidates.map(c => c.nodeId));
            const narrowed = callableDefs.filter(d =>
              d.ownerId && classNodeIds.has(d.ownerId)
            );
            if (narrowed.length > 0) callableDefs = narrowed;
          }
        }
      }

      if (callableDefs && callableDefs.length === 1 && callableDefs[0].returnType) {
        const typeName = extractReturnTypeName(callableDefs[0].returnType);
        if (typeName) {
          verified.set(receiverKey(scope, varName), typeName);
        }
      }
    }
  }

  return verified;
};

export const processCalls = async (
  graph: KnowledgeGraph,
  files: { path: string; content: string }[],
  astCache: ASTCache,
  ctx: ResolutionContext,
  onProgress?: (current: number, total: number) => void,
): Promise<ExtractedHeritage[]> => {
  const parser = await loadParser();
  const collectedHeritage: ExtractedHeritage[] = [];
  const logSkipped = isVerboseIngestionEnabled();
  const skippedByLang = logSkipped ? new Map<string, number>() : null;

  for (let i = 0; i < files.length; i++) {
    const file = files[i];
    onProgress?.(i + 1, files.length);
    if (i % 20 === 0) await yieldToEventLoop();

    const language = getLanguageFromFilename(file.path);
    if (!language) continue;
    if (!isLanguageAvailable(language)) {
      if (skippedByLang) {
        skippedByLang.set(language, (skippedByLang.get(language) ?? 0) + 1);
      }
      continue;
    }

    const queryStr = LANGUAGE_QUERIES[language];
    if (!queryStr) continue;

    await loadLanguage(language, file.path);

    let tree = astCache.get(file.path);
    if (!tree) {
      try {
        tree = parser.parse(file.content, undefined, { bufferSize: getTreeSitterBufferSize(file.content.length) });
      } catch (parseError) {
        continue;
      }
      astCache.set(file.path, tree);
    }

    let query;
    let matches;
    try {
      const language = parser.getLanguage();
      query = new Parser.Query(language, queryStr);
      matches = query.matches(tree.rootNode);
    } catch (queryError) {
      console.warn(`Query error for ${file.path}:`, queryError);
      continue;
    }

    const lang = getLanguageFromFilename(file.path);
    const typeEnv = lang ? buildTypeEnv(tree, lang, ctx.symbols) : null;
    const callRouter = callRouters[language];

    const verifiedReceivers = typeEnv && typeEnv.constructorBindings.length > 0
      ? verifyConstructorBindings(typeEnv.constructorBindings, file.path, ctx)
      : new Map<string, string>();

    ctx.enableCache(file.path);

    matches.forEach(match => {
      const captureMap: Record<string, any> = {};
      match.captures.forEach(c => captureMap[c.name] = c.node);

      if (!captureMap['call']) return;

      const nameNode = captureMap['call.name'];
      if (!nameNode) return;

      const calledName = nameNode.text;

      const routed = callRouter(calledName, captureMap['call']);
      if (routed) {
        switch (routed.kind) {
          case 'skip':
          case 'import':
            return;

          case 'heritage':
            for (const item of routed.items) {
              collectedHeritage.push({
                filePath: file.path,
                className: item.enclosingClass,
                parentName: item.mixinName,
                kind: item.heritageKind,
              });
            }
            return;

          case 'properties': {
            const fileId = generateId('File', file.path);
            const propEnclosingClassId = findEnclosingClassId(captureMap['call'], file.path);
            for (const item of routed.items) {
              const nodeId = generateId('Property', `${file.path}:${item.propName}`);
              graph.addNode({
                id: nodeId,
                label: 'Property' as any, // TODO: add 'Property' to graph node label union
                properties: {
                  name: item.propName, filePath: file.path,
                  startLine: item.startLine, endLine: item.endLine,
                  language, isExported: true,
                  description: item.accessorType,
                },
              });
              ctx.symbols.add(file.path, item.propName, nodeId, 'Property',
                propEnclosingClassId ? { ownerId: propEnclosingClassId } : undefined);
              const relId = generateId('DEFINES', `${fileId}->${nodeId}`);
              graph.addRelationship({
                id: relId, sourceId: fileId, targetId: nodeId,
                type: 'DEFINES', confidence: 1.0, reason: '',
              });
              if (propEnclosingClassId) {
                graph.addRelationship({
                  id: generateId('HAS_METHOD', `${propEnclosingClassId}->${nodeId}`),
                  sourceId: propEnclosingClassId, targetId: nodeId,
                  type: 'HAS_METHOD', confidence: 1.0, reason: '',
                });
              }
            }
            return;
          }

          case 'call':
            break;
        }
      }

      if (isBuiltInOrNoise(calledName)) return;

      const callNode = captureMap['call'];
      const callForm = inferCallForm(callNode, nameNode);
      const receiverName = callForm === 'member' ? extractReceiverName(nameNode) : undefined;
      let receiverTypeName = receiverName && typeEnv ? typeEnv.lookup(receiverName, callNode) : undefined;
      // Fall back to verified constructor bindings for return type inference
      if (!receiverTypeName && receiverName && verifiedReceivers.size > 0) {
        const enclosingFunc = findEnclosingFunction(callNode, file.path, ctx);
        const funcName = enclosingFunc ? extractFuncNameFromSourceId(enclosingFunc) : '';
        receiverTypeName = lookupReceiverType(verifiedReceivers, funcName, receiverName);
      }
      // Fall back to class-as-receiver for static method calls (e.g. UserService.find_user()).
      // When the receiver name is not a variable in TypeEnv but resolves to a Class/Struct/Interface
      // through the standard tiered resolution, use it directly as the receiver type.
      if (!receiverTypeName && receiverName && callForm === 'member') {
        const typeResolved = ctx.resolve(receiverName, file.path);
        if (typeResolved && typeResolved.candidates.some(
          d => d.type === 'Class' || d.type === 'Interface' || d.type === 'Struct' || d.type === 'Enum',
        )) {
          receiverTypeName = receiverName;
        }
      }
      // Fall back to chained call resolution when the receiver is a call expression
      // (e.g. svc.getUser().save() — receiver of save() is getUser(), not a simple identifier).
      if (callForm === 'member' && !receiverTypeName && !receiverName) {
        const receiverNode = extractReceiverNode(nameNode);
        if (receiverNode && CALL_EXPRESSION_TYPES.has(receiverNode.type)) {
          const extracted = extractCallChain(receiverNode);
          if (extracted) {
            // Resolve the base receiver type if possible
            let baseType = extracted.baseReceiverName && typeEnv
              ? typeEnv.lookup(extracted.baseReceiverName, callNode)
              : undefined;
            if (!baseType && extracted.baseReceiverName && verifiedReceivers.size > 0) {
              const enclosingFunc = findEnclosingFunction(callNode, file.path, ctx);
              const funcName = enclosingFunc ? extractFuncNameFromSourceId(enclosingFunc) : '';
              baseType = lookupReceiverType(verifiedReceivers, funcName, extracted.baseReceiverName);
            }
            // Class-as-receiver for chain base (e.g. UserService.find_user().save())
            if (!baseType && extracted.baseReceiverName) {
              const cr = ctx.resolve(extracted.baseReceiverName, file.path);
              if (cr?.candidates.some(d =>
                d.type === 'Class' || d.type === 'Interface' || d.type === 'Struct' || d.type === 'Enum',
              )) {
                baseType = extracted.baseReceiverName;
              }
            }
            receiverTypeName = resolveChainedReceiver(extracted.chain, baseType, file.path, ctx);
          }
        }
      }

      const resolved = resolveCallTarget({
        calledName,
        argCount: countCallArguments(callNode),
        callForm,
        receiverTypeName,
      }, file.path, ctx);

      if (!resolved) return;

      const enclosingFuncId = findEnclosingFunction(callNode, file.path, ctx);
      const sourceId = enclosingFuncId || generateId('File', file.path);
      const relId = generateId('CALLS', `${sourceId}:${calledName}->${resolved.nodeId}`);

      graph.addRelationship({
        id: relId,
        sourceId,
        targetId: resolved.nodeId,
        type: 'CALLS',
        confidence: resolved.confidence,
        reason: resolved.reason,
      });
    });

    ctx.clearCache();
  }

  if (skippedByLang && skippedByLang.size > 0) {
    for (const [lang, count] of skippedByLang.entries()) {
      console.warn(
        `[ingestion] Skipped ${count} ${lang} file(s) in call processing — ${lang} parser not available.`
      );
    }
  }

  return collectedHeritage;
};

/**
 * Resolution result with confidence scoring
 */
interface ResolveResult {
  nodeId: string;
  confidence: number;
  reason: string;
}

const CALLABLE_SYMBOL_TYPES = new Set([
  'Function',
  'Method',
  'Constructor',
  'Macro',
  'Delegate',
]);

const CONSTRUCTOR_TARGET_TYPES = new Set(['Constructor', 'Class', 'Struct', 'Record']);

const filterCallableCandidates = (
  candidates: readonly SymbolDefinition[],
  argCount?: number,
  callForm?: 'free' | 'member' | 'constructor',
): SymbolDefinition[] => {
  let kindFiltered: SymbolDefinition[];

  if (callForm === 'constructor') {
    const constructors = candidates.filter(c => c.type === 'Constructor');
    if (constructors.length > 0) {
      kindFiltered = constructors;
    } else {
      const types = candidates.filter(c => CONSTRUCTOR_TARGET_TYPES.has(c.type));
      kindFiltered = types.length > 0 ? types : candidates.filter(c => CALLABLE_SYMBOL_TYPES.has(c.type));
    }
  } else {
    kindFiltered = candidates.filter(c => CALLABLE_SYMBOL_TYPES.has(c.type));
  }

  if (kindFiltered.length === 0) return [];
  if (argCount === undefined) return kindFiltered;

  const hasParameterMetadata = kindFiltered.some(candidate => candidate.parameterCount !== undefined);
  if (!hasParameterMetadata) return kindFiltered;

  return kindFiltered.filter(candidate =>
    candidate.parameterCount === undefined || candidate.parameterCount === argCount
  );
};

const toResolveResult = (
  definition: SymbolDefinition,
  tier: ResolutionTier,
): ResolveResult => ({
  nodeId: definition.nodeId,
  confidence: TIER_CONFIDENCE[tier],
  reason: tier === 'same-file' ? 'same-file' : tier === 'import-scoped' ? 'import-resolved' : 'global',
});

/**
 * Resolve a chain of intermediate method calls to find the receiver type for a
 * final member call.  Called when the receiver of a call is itself a call
 * expression (e.g. `svc.getUser().save()`).
 *
 * @param chainNames  Ordered list of method names from outermost to innermost
 *                    intermediate call (e.g. ['getUser'] for `svc.getUser().save()`).
 * @param baseReceiverTypeName  The already-resolved type of the base receiver
 *                              (e.g. 'UserService' for `svc`), or undefined.
 * @param currentFile  The file path for resolution context.
 * @param ctx  The resolution context for symbol lookup.
 * @returns The type name of the final intermediate call's return type, or undefined
 *          if resolution fails at any step.
 */
function resolveChainedReceiver(
  chainNames: string[],
  baseReceiverTypeName: string | undefined,
  currentFile: string,
  ctx: ResolutionContext,
): string | undefined {
  let currentType = baseReceiverTypeName;
  for (const name of chainNames) {
    const resolved = resolveCallTarget(
      { calledName: name, callForm: 'member', receiverTypeName: currentType },
      currentFile,
      ctx,
    );
    if (!resolved) return undefined;

    const candidates = ctx.symbols.lookupFuzzy(name);
    const symDef = candidates.find(c => c.nodeId === resolved.nodeId);
    if (!symDef?.returnType) return undefined;

    const returnTypeName = extractReturnTypeName(symDef.returnType);
    if (!returnTypeName) return undefined;

    currentType = returnTypeName;
  }
  return currentType;
}

/**
 * Resolve a function call to its target node ID using priority strategy:
 * A. Narrow candidates by scope tier via ctx.resolve()
 * B. Filter to callable symbol kinds (constructor-aware when callForm is set)
 * C. Apply arity filtering when parameter metadata is available
 * D. Apply receiver-type filtering for member calls with typed receivers
 *
 * If filtering still leaves multiple candidates, refuse to emit a CALLS edge.
 */
const resolveCallTarget = (
  call: Pick<ExtractedCall, 'calledName' | 'argCount' | 'callForm' | 'receiverTypeName'>,
  currentFile: string,
  ctx: ResolutionContext,
): ResolveResult | null => {
  const tiered = ctx.resolve(call.calledName, currentFile);
  if (!tiered) return null;

  const filteredCandidates = filterCallableCandidates(tiered.candidates, call.argCount, call.callForm);

  // D. Receiver-type filtering: for member calls with a known receiver type,
  // resolve the type through the same tiered import infrastructure, then
  // filter method candidates to the type's defining file. Fall back to
  // fuzzy ownerId matching only when file-based narrowing is inconclusive.
  //
  // Applied regardless of candidate count — the sole same-file candidate may
  // belong to the wrong class (e.g. super.save() should hit the parent's save,
  // not the child's own save method in the same file).
  if (call.callForm === 'member' && call.receiverTypeName) {
    // D1. Resolve the receiver type
    const typeResolved = ctx.resolve(call.receiverTypeName, currentFile);
    if (typeResolved && typeResolved.candidates.length > 0) {
      const typeNodeIds = new Set(typeResolved.candidates.map(d => d.nodeId));
      const typeFiles = new Set(typeResolved.candidates.map(d => d.filePath));

      // D2. Widen candidates: same-file tier may miss the parent's method when
      //     it lives in another file. Query the symbol table directly for all
      //     global methods with this name, then apply arity/kind filtering.
      const methodPool = filteredCandidates.length <= 1
        ? filterCallableCandidates(ctx.symbols.lookupFuzzy(call.calledName), call.argCount, call.callForm)
        : filteredCandidates;

      // D3. File-based: prefer candidates whose filePath matches the resolved type's file
      const fileFiltered = methodPool.filter(c => typeFiles.has(c.filePath));
      if (fileFiltered.length === 1) {
        return toResolveResult(fileFiltered[0], tiered.tier);
      }

      // D4. ownerId fallback: narrow by ownerId matching the type's nodeId
      const pool = fileFiltered.length > 0 ? fileFiltered : methodPool;
      const ownerFiltered = pool.filter(c => c.ownerId && typeNodeIds.has(c.ownerId));
      if (ownerFiltered.length === 1) {
        return toResolveResult(ownerFiltered[0], tiered.tier);
      }
      if (fileFiltered.length > 1 || ownerFiltered.length > 1) return null;
    }
  }

  if (filteredCandidates.length !== 1) return null;

  return toResolveResult(filteredCandidates[0], tiered.tier);
};

// ── Return type text helpers ─────────────────────────────────────────────
// extractSimpleTypeName works on AST nodes; this operates on raw return-type
// text already stored in SymbolDefinition (e.g. "User", "Promise<User>",
// "User | null", "*User").  Extracts the base user-defined type name.

/** Primitive / built-in types that should NOT produce a receiver binding. */
const PRIMITIVE_TYPES = new Set([
  'string', 'number', 'boolean', 'void', 'int', 'float', 'double', 'long',
  'short', 'byte', 'char', 'bool', 'str', 'i8', 'i16', 'i32', 'i64',
  'u8', 'u16', 'u32', 'u64', 'f32', 'f64', 'usize', 'isize',
  'undefined', 'null', 'None', 'nil',
]);

/**
 * Extract a simple type name from raw return-type text.
 * Handles common patterns:
 *   "User"                → "User"
 *   "Promise<User>"       → "User"   (unwrap wrapper generics)
 *   "Option<User>"        → "User"
 *   "Result<User, Error>" → "User"   (first type arg)
 *   "User | null"         → "User"   (strip nullable union)
 *   "User?"               → "User"   (strip nullable suffix)
 *   "*User"               → "User"   (Go pointer)
 *   "&User"               → "User"   (Rust reference)
 * Returns undefined for complex types or primitives.
 */
const WRAPPER_GENERICS = new Set([
  'Promise', 'Observable', 'Future', 'CompletableFuture', 'Task', 'ValueTask',  // async wrappers
  'Option', 'Some', 'Optional', 'Maybe',                                         // nullable wrappers
  'Result', 'Either',                                                             // result wrappers
  // Rust smart pointers (Deref to inner type)
  'Rc', 'Arc', 'Weak',                                                          // pointer types
  'MutexGuard', 'RwLockReadGuard', 'RwLockWriteGuard',                          // guard types
  'Ref', 'RefMut',                                                               // RefCell guards
  'Cow',                                                                         // copy-on-write
  // Containers (List, Array, Vec, Set, etc.) are intentionally excluded —
  // methods are called on the container, not the element type.
  // Non-wrapper generics return the base type (e.g., List) via the else branch.
]);

/**
 * Extracts the first type argument from a comma-separated generic argument string,
 * respecting nested angle brackets. For example:
 *   "Result<User, Error>"  → "Result<User, Error>"  (no top-level comma)
 *   "User, Error"          → "User"
 *   "Map<K, V>, string"    → "Map<K, V>"
 */
function extractFirstGenericArg(args: string): string {
  let depth = 0;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '<') depth++;
    else if (args[i] === '>') depth--;
    else if (args[i] === ',' && depth === 0) return args.slice(0, i).trim();
  }
  return args.trim();
}

/**
 * Extract the first non-lifetime type argument from a generic argument string.
 * Skips Rust lifetime parameters (e.g., `'a`, `'_`) to find the actual type.
 *   "'_, User"       → "User"
 *   "'a, User"       → "User"
 *   "User, Error"    → "User"  (no lifetime — delegates to extractFirstGenericArg)
 */
function extractFirstTypeArg(args: string): string {
  let remaining = args;
  while (remaining) {
    const first = extractFirstGenericArg(remaining);
    if (!first.startsWith("'")) return first;
    // Skip past this lifetime arg + the comma separator
    const commaIdx = remaining.indexOf(',', first.length);
    if (commaIdx < 0) return first; // only lifetimes — fall through
    remaining = remaining.slice(commaIdx + 1).trim();
  }
  return args.trim();
}

export const extractReturnTypeName = (raw: string, depth = 0): string | undefined => {
  if (depth > 10) return undefined;
  let text = raw.trim();
  if (!text) return undefined;

  // Strip pointer/reference prefixes: *User, &User, &mut User
  text = text.replace(/^[&*]+\s*(mut\s+)?/, '');

  // Strip nullable suffix: User?
  text = text.replace(/\?$/, '');

  // Handle union types: "User | null" → "User"
  if (text.includes('|')) {
    const parts = text.split('|').map(p => p.trim()).filter(p =>
      p !== 'null' && p !== 'undefined' && p !== 'void' && p !== 'None' && p !== 'nil'
    );
    if (parts.length === 1) text = parts[0];
    else return undefined; // genuine union — too complex
  }

  // Handle generics: Promise<User> → unwrap if wrapper, else take base
  const genericMatch = text.match(/^(\w+)\s*<(.+)>$/);
  if (genericMatch) {
    const [, base, args] = genericMatch;
    if (WRAPPER_GENERICS.has(base)) {
      // Take the first non-lifetime type argument, using bracket-balanced splitting
      // so that nested generics like Result<User, Error> are not split at the inner
      // comma. Lifetime parameters (Rust 'a, '_) are skipped.
      const firstArg = extractFirstTypeArg(args);
      return extractReturnTypeName(firstArg, depth + 1);
    }
    // Non-wrapper generic: return the base type (e.g., Map<K,V> → Map)
    return PRIMITIVE_TYPES.has(base.toLowerCase()) ? undefined : base;
  }

  // Bare wrapper type without generic argument (e.g. Task, Promise, Option)
  // should not produce a binding — these are meaningless without a type parameter
  if (WRAPPER_GENERICS.has(text)) return undefined;

  // Handle qualified names: models.User → User, Models::User → User, \App\Models\User → User
  if (text.includes('::') || text.includes('.') || text.includes('\\')) {
    text = text.split(/::|[.\\]/).pop()!;
  }

  // Final check: skip primitives
  if (PRIMITIVE_TYPES.has(text) || PRIMITIVE_TYPES.has(text.toLowerCase())) return undefined;

  // Must start with uppercase (class/type convention) or be a valid identifier
  if (!/^[A-Z_]\w*$/.test(text)) return undefined;

  return text;
};

// ── Scope key helpers ────────────────────────────────────────────────────
// Scope keys use the format "funcName@startIndex" (produced by type-env.ts).
// Source IDs use "Label:filepath:funcName" (produced by parse-worker.ts).
// NUL (\0) is used as a composite-key separator because it cannot appear
// in source-code identifiers, preventing ambiguous concatenation.
//
// receiverKey stores the FULL scope (funcName@startIndex) to prevent
// collisions between overloaded methods with the same name in different
// classes (e.g. User.save@100 and Repo.save@200 are distinct keys).
// Lookup uses a secondary funcName-only index built in lookupReceiverType.

/** Extract the function name from a scope key ("funcName@startIndex" → "funcName"). */
const extractFuncNameFromScope = (scope: string): string =>
  scope.slice(0, scope.indexOf('@'));

/** Extract the trailing function name from a sourceId ("Function:filepath:funcName" → "funcName"). */
const extractFuncNameFromSourceId = (sourceId: string): string => {
  const lastColon = sourceId.lastIndexOf(':');
  return lastColon >= 0 ? sourceId.slice(lastColon + 1) : '';
};

/**
 * Build a composite key for receiver type storage.
 * Uses the full scope string (e.g. "save@100") to distinguish overloaded
 * methods with the same name in different classes.
 */
const receiverKey = (scope: string, varName: string): string =>
  `${scope}\0${varName}`;

/**
 * Look up a receiver type from a verified receiver map.
 * The map is keyed by `scope\0varName` (full scope with @startIndex).
 * Since the lookup side only has `funcName` (no startIndex), we scan for
 * all entries whose key starts with `funcName@` and has the matching varName.
 * If exactly one unique type is found, return it. If multiple distinct types
 * exist (true overload collision), return undefined (refuse to guess).
 * Falls back to the file-level scope key `\0varName` (empty funcName).
 */
const lookupReceiverType = (
  map: Map<string, string>,
  funcName: string,
  varName: string,
): string | undefined => {
  // Fast path: file-level scope (empty funcName — used as fallback)
  const fileLevelKey = receiverKey('', varName);

  const prefix = `${funcName}@`;
  const suffix = `\0${varName}`;
  let found: string | undefined;
  let ambiguous = false;

  for (const [key, value] of map) {
    if (key === fileLevelKey) continue; // handled separately below
    if (key.startsWith(prefix) && key.endsWith(suffix)) {
      // Verify the key is exactly "funcName@<digits>\0varName" with no extra chars.
      // The part between prefix and suffix should be the startIndex (digits only),
      // but we accept any non-empty segment to be forward-compatible.
      const middle = key.slice(prefix.length, key.length - suffix.length);
      if (middle.length === 0) continue; // malformed key — skip
      if (found === undefined) {
        found = value;
      } else if (found !== value) {
        ambiguous = true;
        break;
      }
    }
  }

  if (!ambiguous && found !== undefined) return found;

  // Fallback: file-level scope (bindings outside any function)
  return map.get(fileLevelKey);
};

/**
 * Fast path: resolve pre-extracted call sites from workers.
 * No AST parsing — workers already extracted calledName + sourceId.
 */
export const processCallsFromExtracted = async (
  graph: KnowledgeGraph,
  extractedCalls: ExtractedCall[],
  ctx: ResolutionContext,
  onProgress?: (current: number, total: number) => void,
  constructorBindings?: FileConstructorBindings[],
) => {
  // Scope-aware receiver types: keyed by filePath → "funcName\0varName" → typeName.
  // The scope dimension prevents collisions when two functions in the same file
  // have same-named locals pointing to different constructor types.
  const fileReceiverTypes = new Map<string, Map<string, string>>();
  if (constructorBindings) {
    for (const { filePath, bindings } of constructorBindings) {
      const verified = verifyConstructorBindings(bindings, filePath, ctx, graph);
      if (verified.size > 0) {
        fileReceiverTypes.set(filePath, verified);
      }
    }
  }

  const byFile = new Map<string, ExtractedCall[]>();
  for (const call of extractedCalls) {
    let list = byFile.get(call.filePath);
    if (!list) { list = []; byFile.set(call.filePath, list); }
    list.push(call);
  }

  const totalFiles = byFile.size;
  let filesProcessed = 0;

  for (const [filePath, calls] of byFile) {
    filesProcessed++;
    if (filesProcessed % 100 === 0) {
      onProgress?.(filesProcessed, totalFiles);
      await yieldToEventLoop();
    }

    ctx.enableCache(filePath);
    const receiverMap = fileReceiverTypes.get(filePath);

    for (const call of calls) {
      let effectiveCall = call;

      // Step 1: resolve receiver type from constructor bindings
      if (!call.receiverTypeName && call.receiverName && receiverMap) {
        const callFuncName = extractFuncNameFromSourceId(call.sourceId);
        const resolvedType = lookupReceiverType(receiverMap, callFuncName, call.receiverName);
        if (resolvedType) {
          effectiveCall = { ...call, receiverTypeName: resolvedType };
        }
      }

      // Step 1b: class-as-receiver for static method calls (e.g. UserService.find_user())
      if (!effectiveCall.receiverTypeName && effectiveCall.receiverName && effectiveCall.callForm === 'member') {
        const typeResolved = ctx.resolve(effectiveCall.receiverName, effectiveCall.filePath);
        if (typeResolved && typeResolved.candidates.some(
          d => d.type === 'Class' || d.type === 'Interface' || d.type === 'Struct' || d.type === 'Enum',
        )) {
          effectiveCall = { ...effectiveCall, receiverTypeName: effectiveCall.receiverName };
        }
      }

      // Step 2: if the call has a receiver call chain (e.g. svc.getUser().save()),
      // resolve the chain to determine the final receiver type.
      // This runs whenever receiverCallChain is present — even when Step 1 set a
      // receiverTypeName, that type is the BASE receiver (e.g. UserService for svc),
      // and the chain must be walked to produce the FINAL receiver (e.g. User from
      // getUser() : User).
      if (effectiveCall.receiverCallChain?.length) {
        // Step 1 may have resolved the base receiver type (e.g. svc → UserService).
        // Use it as the starting point for chain resolution.
        let baseType = effectiveCall.receiverTypeName;
        // If Step 1 didn't resolve it, try the receiver map directly.
        if (!baseType && effectiveCall.receiverName && receiverMap) {
          const callFuncName = extractFuncNameFromSourceId(effectiveCall.sourceId);
          baseType = lookupReceiverType(receiverMap, callFuncName, effectiveCall.receiverName);
        }
        const chainedType = resolveChainedReceiver(
          effectiveCall.receiverCallChain,
          baseType,
          effectiveCall.filePath,
          ctx,
        );
        if (chainedType) {
          effectiveCall = { ...effectiveCall, receiverTypeName: chainedType };
        }
      }

      const resolved = resolveCallTarget(effectiveCall, effectiveCall.filePath, ctx);
      if (!resolved) continue;

      const relId = generateId('CALLS', `${effectiveCall.sourceId}:${effectiveCall.calledName}->${resolved.nodeId}`);
      graph.addRelationship({
        id: relId,
        sourceId: effectiveCall.sourceId,
        targetId: resolved.nodeId,
        type: 'CALLS',
        confidence: resolved.confidence,
        reason: resolved.reason,
      });
    }

    ctx.clearCache();
  }

  onProgress?.(totalFiles, totalFiles);
};

/**
 * Resolve pre-extracted Laravel routes to CALLS edges from route files to controller methods.
 */
export const processRoutesFromExtracted = async (
  graph: KnowledgeGraph,
  extractedRoutes: ExtractedRoute[],
  ctx: ResolutionContext,
  onProgress?: (current: number, total: number) => void,
) => {
  for (let i = 0; i < extractedRoutes.length; i++) {
    const route = extractedRoutes[i];
    if (i % 50 === 0) {
      onProgress?.(i, extractedRoutes.length);
      await yieldToEventLoop();
    }

    if (!route.controllerName || !route.methodName) continue;

    const controllerResolved = ctx.resolve(route.controllerName, route.filePath);
    if (!controllerResolved || controllerResolved.candidates.length === 0) continue;
    if (controllerResolved.tier === 'global' && controllerResolved.candidates.length > 1) continue;

    const controllerDef = controllerResolved.candidates[0];
    const confidence = TIER_CONFIDENCE[controllerResolved.tier];

    const methodResolved = ctx.resolve(route.methodName, controllerDef.filePath);
    const methodId = methodResolved?.tier === 'same-file' ? methodResolved.candidates[0]?.nodeId : undefined;
    const sourceId = generateId('File', route.filePath);

    if (!methodId) {
      const guessedId = generateId('Method', `${controllerDef.filePath}:${route.methodName}`);
      const relId = generateId('CALLS', `${sourceId}:route->${guessedId}`);
      graph.addRelationship({
        id: relId,
        sourceId,
        targetId: guessedId,
        type: 'CALLS',
        confidence: confidence * 0.8,
        reason: 'laravel-route',
      });
      continue;
    }

    const relId = generateId('CALLS', `${sourceId}:route->${methodId}`);
    graph.addRelationship({
      id: relId,
      sourceId,
      targetId: methodId,
      type: 'CALLS',
      confidence,
      reason: 'laravel-route',
    });
  }

  onProgress?.(extractedRoutes.length, extractedRoutes.length);
};

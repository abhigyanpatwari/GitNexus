/**
 * Swift same-module (SPM target) implicit visibility for the
 * `populateNamespaceSiblings` hook.
 *
 * Swift gives every file in a module access to every other file's
 * top-level declarations WITHOUT any `import` statement (whole-module
 * visibility). This is the Swift analogue of Go's same-package sibling
 * visibility — `populateGoPackageSiblings` is the template.
 *
 * Module identity: Swift has no in-source `package X` marker. The SPM
 * target is a directory subtree (`Sources/<Target>/…`). Module membership
 * is threaded in via the SPM target map (`ctx.resolutionConfig` →
 * `coerceSwiftTargets`) and grouped by `groupSwiftFilesBySpmTarget`.
 * The helper preserves the legacy `wireSwiftImplicitImports` bucketing
 * contract for ordinary layouts (first target wins and unmatched files use
 * `__default__`) but intentionally fixes #2931's repeated-prefix edge case.
 * When a target map is present (declared Package.swift or inferred
 * `Sources/*` folders), files are grouped by SPM target subtree;
 * otherwise ALL Swift files form one module (`__default__`,
 * single-Xcode-project assumption). Every `.swift` file in the same target
 * sees its siblings' top-level defs.
 *
 * Bindings are added through the append-only `bindingAugmentations`
 * channel (Contract Invariant I8) with `origin: 'namespace'`, exactly
 * like the Go implementation — `indexes.bindings` is frozen post-
 * finalize and must not be mutated.
 */

import type { BindingRef, ParsedFile, Scope, ScopeId, SymbolDefinition } from 'gitnexus-shared';
import type { ScopeResolutionIndexes } from '../../model/scope-resolution-indexes.js';
import { isClassLike } from '../../scope-resolution/scope/walkers.js';
import { coerceSwiftTargets, groupSwiftFilesBySpmTarget } from './target-grouping.js';

export function populateSwiftTargetSiblings(
  parsedFiles: readonly ParsedFile[],
  indexes: ScopeResolutionIndexes,
  ctx: {
    readonly fileContents: ReadonlyMap<string, string>;
    readonly resolutionConfig?: unknown;
  },
): void {
  const targets = coerceSwiftTargets(ctx.resolutionConfig);
  const filesByTarget = groupSwiftFilesBySpmTarget(
    parsedFiles,
    (parsed) => parsed.filePath,
    targets,
  );

  const augmentations = indexes.bindingAugmentations as Map<ScopeId, Map<string, BindingRef[]>>;

  for (const [, group] of filesByTarget) {
    populateNestedTypeFragments(group, indexes, augmentations, ctx.fileContents);
    if (group.length < 2) continue; // no file siblings to share
    const siblings = group.map((parsed) => ({
      filePath: parsed.filePath,
      defs: [...parsed.localDefs] as SymbolDefinition[],
    }));
    for (const target of siblings) {
      for (const receiver of siblings) {
        if (receiver.filePath === target.filePath) continue; // no self-reference
        const receiverModule = indexes.moduleScopes.byFilePath.get(receiver.filePath);
        if (receiverModule === undefined) continue;

        for (const def of target.defs) {
          addNamespaceBinding(augmentations, receiverModule, def);
        }
      }
    }
  }
}

/**
 * A Swift extension is a second lexical fragment of its extended type. Make
 * nested types declared by the primary fragment visible from every same-target
 * fragment with the same logical owner. Keeping this on class scopes preserves
 * lexical precedence when an unrelated top-level type has the same simple name.
 */
function populateNestedTypeFragments(
  group: readonly ParsedFile[],
  indexes: ScopeResolutionIndexes,
  augmentations: Map<ScopeId, Map<string, BindingRef[]>>,
  fileContents: ReadonlyMap<string, string>,
): void {
  const scopesByOwner = new Map<string, ScopeId[]>();
  const lineStartsByFile = new Map<string, readonly number[]>();
  for (const parsed of group) {
    const source = fileContents.get(parsed.filePath);
    let lineStarts: readonly number[] | undefined;
    if (source !== undefined) {
      lineStarts = lineStartsByFile.get(parsed.filePath);
      if (lineStarts === undefined) {
        lineStarts = lineStartsOf(source);
        lineStartsByFile.set(parsed.filePath, lineStarts);
      }
    }
    for (const scope of parsed.scopes) {
      if (scope.kind !== 'Class') continue;
      const key = scopeOwnerKey(scope, source, lineStarts);
      if (key === undefined) continue;
      let scopes = scopesByOwner.get(key);
      if (scopes === undefined) {
        scopes = [];
        scopesByOwner.set(key, scopes);
      }
      scopes.push(scope.id);
    }
  }

  for (const parsed of group) {
    for (const def of parsed.localDefs) {
      if (!isClassLike(def.type) || def.ownerId === undefined) continue;
      const owner = indexes.defs.byId.get(def.ownerId);
      if (owner === undefined) continue;
      const targetScopes = scopesByOwner.get(logicalOwnerKey(owner));
      if (targetScopes === undefined) continue;
      for (const scopeId of targetScopes) {
        addNamespaceBinding(augmentations, scopeId, def);
      }
    }
  }
}

function scopeOwnerKey(
  scope: Scope,
  source: string | undefined,
  lineStarts?: readonly number[],
): string | undefined {
  const owner = scope.ownedDefs.find((def) => isClassLike(def.type));
  if (owner !== undefined) return logicalOwnerKey(owner);

  // Extension scopes carry no synthetic class def. Capture generation keeps
  // only the trailing owner on members (`Inner.f` for `extension Outer.Inner`),
  // so recover the full owner from this scope's declaration text first.
  if (source !== undefined) {
    const sourceOwner = swiftExtensionOwner(source, scope, lineStarts);
    // Do not last-dot-guess: member qualified names are trailing-only, so
    // `Inner.make` would key `Inner` instead of `Outer.Inner`.
    if (sourceOwner === undefined) return undefined;
    const representative = firstBoundDefinition(scope);
    return logicalOwnerKey({
      ...(representative ?? {
        nodeId: sourceOwner,
        filePath: scope.filePath,
        type: 'Class',
        qualifiedName: sourceOwner,
      }),
      qualifiedName: sourceOwner,
    });
  }

  // Hand-built fixtures and old cached shapes may have no source text. Keep
  // the conservative member-prefix fallback, rejecting inconsistent owners.
  let inferredOwner: string | undefined;
  for (const refs of scope.bindings.values()) {
    for (const { def } of refs) {
      const qualifiedName = def.qualifiedName;
      if (qualifiedName === undefined) continue;
      const separator = qualifiedName.lastIndexOf('.');
      if (separator <= 0) continue;
      const candidate = logicalOwnerKey({
        ...def,
        qualifiedName: qualifiedName.slice(0, separator),
      });
      if (inferredOwner !== undefined && inferredOwner !== candidate) return undefined;
      inferredOwner = candidate;
    }
  }
  return inferredOwner;
}

function firstBoundDefinition(scope: Scope): SymbolDefinition | undefined {
  for (const refs of scope.bindings.values()) {
    const first = refs[0]?.def;
    if (first !== undefined) return first;
  }
  return undefined;
}

/**
 * Read `extension Outer.Inner` from the class-scope source range.
 * Access modifiers and attributes (`public`, `@MainActor`, `@available`)
 * may precede the keyword, so the match is not start-anchored. Attribute
 * message strings and comments must not supply a false `extension Type`.
 * Owner segments use Unicode identifier characters so `Café.Container`
 * is not truncated to `Caf`.
 */
const SWIFT_TYPE_IDENT = String.raw`[\p{ID_Start}_][\p{ID_Continue}]*`;
const EXTENSION_OWNER = new RegExp(
  String.raw`\bextension\s+(${SWIFT_TYPE_IDENT}(?:\s*\.\s*${SWIFT_TYPE_IDENT})*)`,
  'u',
);

function swiftExtensionOwner(
  source: string,
  scope: Scope,
  lineStarts?: readonly number[],
): string | undefined {
  const declaration = sliceScopeRange(source, scope.range, lineStarts ?? lineStartsOf(source));
  if (declaration === undefined) return undefined;
  const cleaned = cleanExtensionHeader(declaration);
  return EXTENSION_OWNER.exec(cleaned)?.[1]?.replace(/\s+/g, '');
}

/** `Scope.range` is 1-based on lines. Columns are Tree-sitter UTF-8 bytes. */
function lineStartsOf(source: string): number[] {
  const starts = [0, 0];
  for (let index = 0; index < source.length; index += 1) {
    if (source[index] === '\n') starts.push(index + 1);
  }
  return starts;
}

function sliceScopeRange(
  source: string,
  range: Scope['range'],
  starts: readonly number[],
): string | undefined {
  const start = starts[range.startLine];
  const end = starts[range.endLine];
  if (start === undefined || end === undefined) return undefined;
  return source.slice(
    start + jsOffsetForUtf8Column(source, start, range.startCol),
    end + jsOffsetForUtf8Column(source, end, range.endCol),
  );
}

/** Convert a Tree-sitter UTF-8 column into a JS string offset on that line. */
function jsOffsetForUtf8Column(source: string, lineStart: number, utf8Column: number): number {
  let bytes = 0;
  let index = lineStart;
  while (index < source.length && bytes < utf8Column) {
    if (source[index] === '\n') break;
    const codePoint = source.codePointAt(index);
    if (codePoint === undefined) break;
    bytes += utf8ByteLength(codePoint);
    index += codePoint > 0xffff ? 2 : 1;
  }
  return index - lineStart;
}

function utf8ByteLength(codePoint: number): number {
  if (codePoint <= 0x7f) return 1;
  if (codePoint <= 0x7ff) return 2;
  if (codePoint <= 0xffff) return 3;
  return 4;
}

/** Header through the first unquoted `{`, with strings and comments blanked. */
function cleanExtensionHeader(declaration: string): string {
  let index = 0;
  let cleaned = '';
  const blank = (from: number, to: number): void => {
    for (let cursor = from; cursor < to; cursor += 1) {
      cleaned += declaration[cursor] === '\n' ? '\n' : ' ';
    }
  };
  while (index < declaration.length) {
    const current = declaration[index];
    if (current === '/' && declaration[index + 1] === '/') {
      const end = skipLineComment(declaration, index);
      blank(index, end);
      index = end;
      continue;
    }
    if (current === '/' && declaration[index + 1] === '*') {
      const end = skipBlockComment(declaration, index);
      blank(index, end);
      index = end;
      continue;
    }
    const pounds = current === '#' ? leadingPounds(declaration, index) : 0;
    const quoteAt = index + pounds;
    if (declaration.startsWith('"""', quoteAt) || declaration[quoteAt] === '"') {
      const end = skipSwiftString(declaration, index);
      blank(index, end);
      index = end;
      continue;
    }
    if (current === "'") {
      const end = skipQuoted(declaration, index, current);
      blank(index, end);
      index = end;
      continue;
    }
    if (current === '{') break;
    cleaned += current;
    index += 1;
  }
  return cleaned;
}

function skipLineComment(text: string, start: number): number {
  const newline = text.indexOf('\n', start);
  return newline === -1 ? text.length : newline + 1;
}

function skipBlockComment(text: string, start: number): number {
  let index = start + 2;
  let depth = 1;
  while (index < text.length && depth > 0) {
    if (text.startsWith('/*', index)) {
      depth += 1;
      index += 2;
      continue;
    }
    if (text.startsWith('*/', index)) {
      depth -= 1;
      index += 2;
      continue;
    }
    index += 1;
  }
  return index;
}

function leadingPounds(text: string, start: number): number {
  let count = 0;
  while (text[start + count] === '#') count += 1;
  return count;
}

function skipSwiftString(text: string, start: number): number {
  const pounds = leadingPounds(text, start);
  const quoteAt = start + pounds;
  if (text.startsWith('"""', quoteAt)) {
    return skipDelimitedString(text, quoteAt + 3, `"""${'#'.repeat(pounds)}`, pounds === 0);
  }
  if (text[quoteAt] === '"') {
    return skipDelimitedString(text, quoteAt + 1, `"${'#'.repeat(pounds)}`, pounds === 0);
  }
  return start + Math.max(pounds, 1);
}

function skipDelimitedString(
  text: string,
  bodyStart: number,
  closer: string,
  escapes: boolean,
): number {
  let index = bodyStart;
  while (index < text.length) {
    if (escapes && text[index] === '\\') {
      index += 2;
      continue;
    }
    if (text.startsWith(closer, index)) return index + closer.length;
    index += 1;
  }
  return text.length;
}

function skipQuoted(text: string, start: number, quote: string): number {
  let index = start + 1;
  while (index < text.length) {
    if (text[index] === '\\') {
      index += 2;
      continue;
    }
    if (text[index] === quote) return index + 1;
    index += 1;
  }
  return text.length;
}

function logicalOwnerKey(def: SymbolDefinition): string {
  const qualifiedName = def.qualifiedName ?? def.nodeId;
  const namespacePrefix = def.namespacePrefix ?? '';
  return `${namespacePrefix.length}:${namespacePrefix}:${qualifiedName}`;
}

function simpleName(def: SymbolDefinition): string {
  return def.qualifiedName?.split('.').pop() ?? def.qualifiedName ?? '';
}

function addNamespaceBinding(
  augmentations: Map<ScopeId, Map<string, BindingRef[]>>,
  scopeId: ScopeId,
  def: SymbolDefinition,
): void {
  const name = simpleName(def);
  if (name === '') return;
  const bucket = getAugmentationBucket(augmentations, scopeId, name);
  if (bucket.some((binding) => binding.def.nodeId === def.nodeId)) return;
  bucket.push({ def, origin: 'namespace' });
}

function getAugmentationBucket(
  augmentations: Map<ScopeId, Map<string, BindingRef[]>>,
  scopeId: ScopeId,
  name: string,
): BindingRef[] {
  let scopeBindings = augmentations.get(scopeId);
  if (scopeBindings === undefined) {
    scopeBindings = new Map<string, BindingRef[]>();
    augmentations.set(scopeId, scopeBindings);
  }
  let bucketArr = scopeBindings.get(name);
  if (bucketArr === undefined) {
    bucketArr = [];
    scopeBindings.set(name, bucketArr);
  }
  return bucketArr;
}

import type { ScopeResolver } from './scope-resolution/contract/scope-resolver.js';
import type { SymbolDefinition } from 'gitnexus-shared';
import { heritageTypeArgumentsKey } from './scope-resolution/utils/generic-instantiation.js';
import { syntaxOffsets } from './utils/type-parameters.js';

type Bindings = ReadonlyMap<string, string | null>;
// Budget each expanded spelling independently so unrelated signatures still resolve.
const maxExpandedTypeLength = 32 * 1024;

// Restrict textual substitution to named types and their type constructors.
// Structural types and nested signatures may introduce new names of their own.
const compositeType = /^[\p{ID_Continue}$\s.<>,[\]()|&]+$/u;
const nullableOperand =
  /^[$_\p{ID_Start}][$\p{ID_Continue}]*(?:\.[$_\p{ID_Start}][$\p{ID_Continue}]*)*\??$/u;

/** A function's trailing ? may apply to its return type. Only lift a named operand here. */
export function specializeNamedNullableOperand(actual: string): string | null {
  if (!nullableOperand.test(actual)) return null;
  return actual.endsWith('?') ? actual : `${actual}?`;
}

export function needsScopedHeritageArguments(
  args: readonly string[] | undefined,
  provider: ScopeResolver | undefined,
): boolean {
  return (
    provider?.specializeNullableHeritageFormal !== undefined &&
    args?.some((arg) => arg.includes('?') || provider.needsHeritageTypeNormalization?.(arg)) ===
      true
  );
}

interface NullableOwner {
  declaration: SymbolDefinition;
  specialize?: ScopeResolver['specializeNullableHeritageFormal'];
  qualifiedPattern?: ScopeResolver['qualifiedHeritageTypePattern'];
  operands?: ScopeResolver['heritageTypeOperands'];
  normalize?: ScopeResolver['normalizeNullableHeritageSignature'];
  needsNormalization?: ScopeResolver['needsHeritageTypeNormalization'];
}

const namedType =
  /[$_\p{ID_Start}][$\p{ID_Continue}]*(?:\s*\.\s*[$_\p{ID_Start}][$\p{ID_Continue}]*)*/gu;

/** A prefix type operator needs parentheses around a compound operand at the outermost level. */
function needsPrefixGrouping(type: string): boolean {
  if (!/[|&]|=>/.test(type)) return false;
  let depth = 0;
  for (const i of syntaxOffsets(type)) {
    const token = type[i]!;
    if ('<([{'.includes(token)) depth++;
    else if ('>)]}'.includes(token)) {
      depth--;
      if (depth === 0 && token === ')' && /^\s*=>/.test(type.slice(i + 1))) return true;
    } else if (depth === 0 && (token === '|' || token === '&')) return true;
  }
  return false;
}

function resolveOperand(
  name: string,
  bindings: Bindings,
  local?: ReadonlySet<string>,
  nullableOwner?: NullableOwner,
): string | null | undefined {
  if (local?.has(name)) return undefined;
  const direct = bindings.get(name);
  if (direct !== undefined || !nullableOwner?.specialize || !name.endsWith('?')) return direct;
  const formal = name.slice(0, -1).trimEnd();
  if (local?.has(formal)) return undefined;
  const actual = bindings.get(formal);
  if (actual === undefined || actual === null) return actual;
  return nullableOwner.specialize(nullableOwner.declaration, formal, actual);
}

/** Preserve precedence when an argument is spliced into a larger type. */
function needsOperandGrouping(type: string, offset: number, name: string, actual: string): boolean {
  let left = offset - 1;
  let right = offset + name.length;
  while (left >= 0 && /\s/u.test(type[left])) left--;
  while (right < type.length && /\s/u.test(type[right])) right++;
  const prefix = left >= 0 && /[\p{ID_Continue}$]/u.test(type[left]);
  const postfix = type[right] === '[';
  const intersection = type[left] === '&' || type[right] === '&';
  const union = type[left] === '|' || type[right] === '|';
  return (
    (prefix && needsPrefixGrouping(actual)) ||
    (postfix && /[|&]|=>/.test(actual)) ||
    (intersection && /\||=>/.test(actual)) ||
    (union && actual.includes('=>'))
  );
}

function substituteOperands(
  type: string,
  sites: Iterable<RegExpExecArray>,
  bindings: Bindings,
  local?: ReadonlySet<string>,
  nullableOwner?: NullableOwner,
): string | null {
  let length = type.length;
  let end = 0;
  const parts: string[] = [];
  for (const match of sites) {
    const name = match[0];
    const offset = match.index;
    const actual = resolveOperand(name, bindings, local, nullableOwner);
    if (actual === undefined) continue;
    if (actual === null) return null;
    const group = needsOperandGrouping(type, offset, name, actual);
    length += actual.length - name.length + (group ? 2 : 0);
    if (length > maxExpandedTypeLength) return null;
    parts.push(type.slice(end, offset), group ? `(${actual})` : actual);
    end = offset + name.length;
  }
  if (!parts.length) return type;
  parts.push(type.slice(end));
  return parts.join('');
}

function specializeType(
  type: string,
  bindings?: Bindings,
  local?: ReadonlySet<string>,
  nullableOwner?: NullableOwner,
  qualifiedPattern?: ScopeResolver['qualifiedHeritageTypePattern'],
  operands?: ScopeResolver['heritageTypeOperands'],
): string | null {
  if (type.length > maxExpandedTypeLength) return null;
  if (!bindings?.size || local?.has(type)) return type;
  const direct = resolveOperand(type, bindings, local, nullableOwner);
  if (direct !== undefined)
    return direct !== null && direct.length <= maxExpandedTypeLength ? direct : null;
  let sites = operands?.(type, bindings, local);
  if (sites === undefined) {
    const pattern = compositeType.test(type)
      ? namedType
      : qualifiedPattern?.(type, bindings, local);
    if (!pattern) return type;
    sites = type.matchAll(pattern);
  }
  return substituteOperands(type, sites, bindings, local, nullableOwner);
}

interface ClassBindings {
  bindingsByOwner: Map<string, Bindings>;
  nullablePaths?: Map<string, NullableOwner>;
}

function specializeBaseArguments(
  args: Bindings | undefined,
  outer: Bindings | undefined,
  metadata: NullableOwner | undefined,
  context: NullableOwner | undefined,
): Map<string, string | null> {
  const next = new Map<string, string | null>();
  for (const [formal, actual] of args ?? []) {
    next.set(
      formal,
      actual === null
        ? null
        : specializeType(
            actual,
            outer,
            undefined,
            context,
            metadata?.qualifiedPattern,
            metadata?.operands,
          ),
    );
  }
  return next;
}

function mergeBaseBindings(
  composed: ClassBindings,
  base: string,
  next: Map<string, string | null>,
  path: NullableOwner | undefined,
): boolean {
  const addedPath = path !== undefined && !composed.nullablePaths?.has(base);
  if (addedPath) {
    composed.nullablePaths ??= new Map();
    composed.nullablePaths.set(base, path);
  }
  const prior = composed.bindingsByOwner.get(base);
  if (prior) {
    // Only substitutions supported by every path can select a method.
    for (const [formal, actual] of next) {
      if (prior.get(formal) !== actual) next.delete(formal);
    }
    if (next.size === prior.size && !addedPath) return false;
  }
  composed.bindingsByOwner.set(base, next);
  return true;
}

/** Type arguments retained between scope resolution and method override matching. */
export class HeritageSubstitutions {
  private readonly edges = new Map<string, Bindings>();
  private readonly normalizedEdges = new Map<string, Bindings>();
  private readonly nullableEdges = new Set<string>();
  private readonly nullableOwners = new Map<string, NullableOwner>();
  private readonly declaredMethodTypes = new Map<string, string[] | null>();
  private scopedOverrides?: Map<string, { parameters?: string[] | null; result?: string[] | null }>;
  private readonly methodParameters = new Map<string, ReadonlySet<string>>();

  get hasBindings(): boolean {
    return this.edges.size > 0;
  }

  get hasOverrideTypes(): boolean {
    return (
      this.hasBindings || Boolean(this.scopedOverrides?.size) || this.methodParameters.size > 0
    );
  }

  methodTypeParameters(id: string): ReadonlySet<string> | undefined {
    return this.methodParameters.get(id);
  }

  get hasNullableBindings(): boolean {
    return this.nullableEdges.size > 0;
  }

  registerBase(
    child: string,
    base: string,
    def: SymbolDefinition,
    args: readonly string[] | undefined,
    childDef?: SymbolDefinition,
    provider?: ScopeResolver,
    needsScope = needsScopedHeritageArguments(args, provider),
  ) {
    const parameters = def.typeParameters;
    if (!parameters?.length || !args || args.length > parameters.length) return;
    const key = heritageTypeArgumentsKey(child, base);
    if (this.edges.has(key)) return;
    if (provider?.specializeNullableHeritageFormal || provider?.qualifiedHeritageTypePattern) {
      this.registerNullableOwner(base, def, provider);
      if (childDef) this.registerNullableOwner(child, childDef, provider);
      if (childDef && provider.specializeNullableHeritageFormal && needsScope) {
        this.nullableEdges.add(key);
      }
    }
    const bindings = new Map<string, string | null>();
    for (const [index, parameter] of parameters.entries()) {
      const fallback = parameter.defaultType;
      const written = args[index];
      if (written !== undefined) bindings.set(parameter.name, specializeType(written));
      else if (fallback)
        bindings.set(
          parameter.name,
          specializeType(
            fallback,
            bindings,
            undefined,
            undefined,
            provider?.qualifiedHeritageTypePattern,
            provider?.heritageTypeOperands,
          ),
        );
    }
    if (bindings.size) this.edges.set(key, bindings);
  }

  /** Resolve source spellings after the language has installed its namespace bindings. */
  normalizeBase(child: string, base: string, normalize: (type: string) => string | null) {
    const key = heritageTypeArgumentsKey(child, base);
    const bindings = this.edges.get(key);
    if (!bindings) return;
    let normalized: Map<string, string | null> | undefined;
    for (const [formal, actual] of bindings) {
      if (actual === null) continue;
      const scoped = normalize(actual);
      if (scoped !== actual) {
        normalized ??= new Map(bindings);
        normalized.set(formal, scoped);
      }
    }
    if (normalized) this.normalizedEdges.set(key, normalized);
  }

  private registerNullableOwner(
    id: string,
    declaration: SymbolDefinition,
    provider: ScopeResolver,
  ) {
    if (this.nullableOwners.has(id)) return;
    this.nullableOwners.set(id, {
      declaration,
      specialize: provider.specializeNullableHeritageFormal,
      normalize: provider.normalizeNullableHeritageSignature,
      needsNormalization: provider.needsHeritageTypeNormalization,
      qualifiedPattern: provider.qualifiedHeritageTypePattern,
      operands: provider.heritageTypeOperands,
    });
  }

  registerMethod(
    id: string,
    def: SymbolDefinition,
    useDeclaredTypes = false,
    scopedTypes?: string[] | null,
    scopedOverride = false,
    result?: string | null,
  ) {
    if (scopedOverride) {
      this.scopedOverrides ??= new Map();
      this.scopedOverrides.set(id, {
        parameters: scopedTypes,
        result: typeof result === 'string' ? [result] : result,
      });
    } else if (scopedTypes !== undefined) this.declaredMethodTypes.set(id, scopedTypes);
    if (scopedTypes === undefined && useDeclaredTypes && def.declaredParameterTypes) {
      this.declaredMethodTypes.set(id, def.declaredParameterTypes);
    }
    if (def.typeParameters?.length) {
      this.methodParameters.set(id, new Set(def.typeParameters.map((p) => p.name)));
    }
  }

  private composeBindings(
    child: string,
    parents: ReadonlyMap<string, readonly string[]>,
    scoped: boolean,
  ): ClassBindings {
    const composed: ClassBindings = { bindingsByOwner: new Map() };
    if (!this.edges.size) return composed;

    const queue = [child];
    composed.bindingsByOwner.set(child, new Map());
    // The array iterator also visits bases appended when a binding or path changes.
    for (const owner of queue) {
      const outer = composed.bindingsByOwner.get(owner);
      const metadata = this.nullableOwners.get(owner);
      for (const base of parents.get(owner) ?? []) {
        const key = heritageTypeArgumentsKey(owner, base);
        const args = (scoped && this.normalizedEdges.get(key)) || this.edges.get(key);
        const context = this.nullableEdges.has(key) ? metadata : undefined;
        const next = specializeBaseArguments(args, outer, metadata, context);
        const path = context ?? composed.nullablePaths?.get(owner);
        if (mergeBaseBindings(composed, base, next, path)) queue.push(base);
      }
    }
    return composed;
  }

  private specializeMethodTypes(
    method: string,
    types: string[],
    bindings: Bindings | undefined,
    metadata: NullableOwner | undefined,
    path: NullableOwner | undefined,
  ): string[] | null {
    const normalize = path?.normalize;
    const completed = metadata?.needsNormalization;
    if (!types.length || (!bindings?.size && !normalize && (!completed || !types.some(completed))))
      return types;

    const local = this.methodParameters.get(method);
    const context = path ? metadata : undefined;
    const specialized: string[] = [];
    for (const type of types) {
      const result = specializeType(
        type,
        bindings,
        local,
        context,
        metadata?.qualifiedPattern,
        metadata?.operands,
      );
      if (result === null) return null;
      // Direct generic methods can contain a completed type even when the
      // base arguments themselves need no declaration-scoped normalization.
      const canonical = normalize ?? (completed?.(result) ? metadata.normalize : undefined);
      const normalized = canonical ? canonical(result) : result;
      if (normalized === null) return null;
      specialized.push(normalized);
    }
    return specialized;
  }

  /** Express every ancestor's formal parameters in the child's lexical context. */
  forClass(child: string, parents: ReadonlyMap<string, readonly string[]>) {
    const composed = this.composeBindings(child, parents, false);
    let normalized: ClassBindings | undefined;
    return (
      owner: string,
      method: string,
      types: string[],
      contract = owner,
      useDeclaredParameters = true,
    ): string[] | null => {
      // A nullable base on another branch supplies no evidence about this method.
      const path = composed.nullablePaths?.get(contract) ?? composed.nullablePaths?.get(owner);
      let byOwner = composed.bindingsByOwner;
      if (path && this.normalizedEdges.size) {
        normalized ??= this.composeBindings(child, parents, true);
        byOwner = normalized.bindingsByOwner;
      }

      const scoped = this.scopedOverrides?.get(method);
      const ownTypes = useDeclaredParameters ? scoped?.parameters : scoped?.result;
      const declared =
        ownTypes === undefined && path && useDeclaredParameters
          ? this.declaredMethodTypes.get(method)
          : ownTypes;
      if (declared === null) return null;
      return this.specializeMethodTypes(
        method,
        declared ?? types,
        byOwner.get(owner),
        this.nullableOwners.get(owner),
        path,
      );
    };
  }
}

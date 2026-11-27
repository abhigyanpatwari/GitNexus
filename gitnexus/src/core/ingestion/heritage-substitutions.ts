import type { ScopeResolver } from './scope-resolution/contract/scope-resolver.js';
import type { SymbolDefinition } from 'gitnexus-shared';
import { heritageTypeArgumentsKey } from './scope-resolution/utils/generic-instantiation.js';
import { syntaxOffsets } from './utils/type-parameters.js';

type Bindings = ReadonlyMap<string, string | null>;
// Budget each expanded spelling independently so unrelated signatures still resolve.
const maxExpandedTypeLength = 32 * 1024;

// Restrict textual substitution to named types and their type constructors.
// Structural types and nested signatures may introduce new names of their own.
const compositeType = /^[\p{ID_Continue}$\s.<>,\[\]()|&]+$/u;
const nullableOperand =
  /^[$_\p{ID_Start}][$\p{ID_Continue}]*(?:\.[$_\p{ID_Start}][$\p{ID_Continue}]*)*\??$/u;

/** A function's trailing ? may apply to its return type. Only lift a named operand here. */
export function specializeNamedNullableOperand(actual: string): string | null {
  if (!nullableOperand.test(actual)) return null;
  return actual.endsWith('?') ? actual : `${actual}?`;
}

interface NullableOwner {
  declaration: SymbolDefinition;
  specialize: NonNullable<ScopeResolver['specializeNullableHeritageFormal']>;
  normalize?: ScopeResolver['normalizeNullableHeritageSignature'];
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

function specializeType(
  type: string,
  bindings?: Bindings,
  local?: ReadonlySet<string>,
  nullableOwner?: NullableOwner,
): string | null {
  if (type.length > maxExpandedTypeLength) return null;
  if (!bindings?.size || local?.has(type)) return type;
  const direct = bindings.get(type);
  if (direct !== undefined) return direct;
  if (nullableOwner && type.endsWith('?')) {
    const formal = type.slice(0, -1);
    const actual = local?.has(formal) ? undefined : bindings.get(formal);
    if (actual !== undefined) {
      if (actual === null) return null;
      const result = nullableOwner.specialize(nullableOwner.declaration, formal, actual);
      return result !== null && result.length <= maxExpandedTypeLength ? result : null;
    }
  }
  if (!compositeType.test(type)) return type;
  let length = type.length;
  let end = 0;
  const parts: string[] = [];
  for (const match of type.matchAll(namedType)) {
    const name = match[0];
    const offset = match.index;
    const actual = local?.has(name) ? undefined : bindings.get(name);
    if (actual === undefined) continue;
    if (actual === null) return null;
    // Preserve precedence when an argument is spliced into a larger type.
    let left = offset - 1;
    let right = offset + name.length;
    while (left >= 0 && /\s/u.test(type[left]!)) left--;
    while (right < type.length && /\s/u.test(type[right]!)) right++;
    const prefix = left >= 0 && /[\p{ID_Continue}$]/u.test(type[left]!);
    const postfix = type[right] === '[';
    const intersection = type[left] === '&' || type[right] === '&';
    const union = type[left] === '|' || type[right] === '|';
    const group =
      (prefix && needsPrefixGrouping(actual)) ||
      (postfix && /[|&]|=>/.test(actual)) ||
      (intersection && /\||=>/.test(actual)) ||
      (union && actual.includes('=>'));
    length += actual.length - name.length + (group ? 2 : 0);
    if (length > maxExpandedTypeLength) return null;
    parts.push(type.slice(end, offset), group ? `(${actual})` : actual);
    end = offset + name.length;
  }
  if (!parts.length) return type;
  parts.push(type.slice(end));
  return parts.join('');
}

/** Type arguments retained between scope resolution and method override matching. */
export class HeritageSubstitutions {
  private readonly edges = new Map<string, Bindings>();
  private readonly nullableEdges = new Set<string>();
  private readonly nullableOwners = new Map<string, NullableOwner>();
  private readonly declaredMethodTypes = new Map<string, string[]>();
  private readonly methodParameters = new Map<string, ReadonlySet<string>>();

  get hasBindings(): boolean {
    return this.edges.size > 0;
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
  ) {
    const parameters = def.typeParameters;
    if (!parameters?.length || !args || args.length > parameters.length) return;
    const key = heritageTypeArgumentsKey(child, base);
    if (this.edges.has(key)) return;
    if (provider?.specializeNullableHeritageFormal) {
      this.registerNullableOwner(base, def, provider);
      if (childDef && args.some((arg) => arg.includes('?'))) {
        this.registerNullableOwner(child, childDef, provider);
        this.nullableEdges.add(key);
      }
    }
    const bindings = new Map<string, string | null>();
    for (const [index, parameter] of parameters.entries()) {
      const fallback = parameter.defaultType;
      const written = args[index];
      if (written !== undefined) bindings.set(parameter.name, specializeType(written));
      else if (fallback) bindings.set(parameter.name, specializeType(fallback, bindings));
    }
    if (bindings.size) this.edges.set(key, bindings);
  }

  private registerNullableOwner(
    id: string,
    declaration: SymbolDefinition,
    provider: ScopeResolver,
  ) {
    if (this.nullableOwners.has(id) || !provider.specializeNullableHeritageFormal) return;
    this.nullableOwners.set(id, {
      declaration,
      specialize: provider.specializeNullableHeritageFormal,
      normalize: provider.normalizeNullableHeritageSignature,
    });
  }

  registerMethod(id: string, def: SymbolDefinition, useDeclaredTypes = false) {
    if (useDeclaredTypes && def.declaredParameterTypes) {
      this.declaredMethodTypes.set(id, def.declaredParameterTypes);
    }
    if (def.typeParameters?.length) {
      this.methodParameters.set(id, new Set(def.typeParameters.map((p) => p.name)));
    }
  }

  /** Express every ancestor's formal parameters in the child's lexical context. */
  forClass(child: string, parents: ReadonlyMap<string, readonly string[]>) {
    const bindingsByOwner = new Map<string, Bindings>();
    let nullablePaths: Map<string, NullableOwner> | undefined;
    if (this.edges.size) {
      const queue = [child];
      bindingsByOwner.set(child, new Map());
      for (let i = 0; i < queue.length; i++) {
        const owner = queue[i]!;
        const outer = bindingsByOwner.get(owner);
        for (const base of parents.get(owner) ?? []) {
          const key = heritageTypeArgumentsKey(owner, base);
          const args = this.edges.get(key);
          const next = new Map<string, string | null>();
          const context = this.nullableEdges.has(key) ? this.nullableOwners.get(owner) : undefined;
          const path = context ?? nullablePaths?.get(owner);
          for (const [formal, actual] of args ?? []) {
            next.set(
              formal,
              actual === null ? null : specializeType(actual, outer, undefined, context),
            );
          }
          const addedPath = path !== undefined && !nullablePaths?.has(base);
          if (addedPath) (nullablePaths ??= new Map()).set(base, path);
          const prior = bindingsByOwner.get(base);
          if (prior) {
            // Distinct paths can instantiate the same ancestor differently. Only
            // substitutions supported by every path can select a method.
            for (const [formal, actual] of next) {
              if (prior.get(formal) !== actual) next.delete(formal);
            }
            if (next.size === prior.size && !addedPath) continue;
          }
          bindingsByOwner.set(base, next);
          queue.push(base);
        }
      }
    }
    return (owner: string, method: string, types: string[], contract = owner): string[] | null => {
      const bindings = bindingsByOwner.get(owner);
      // A nullable base on another branch supplies no evidence about this method.
      const path = nullablePaths?.get(contract) ?? nullablePaths?.get(owner);
      const exact = path ? (this.declaredMethodTypes.get(method) ?? types) : types;
      const context = path ? this.nullableOwners.get(owner) : undefined;
      const normalize = path?.normalize;
      if (!exact.length || (!bindings?.size && !normalize)) return exact;
      const local = this.methodParameters.get(method);
      const specialized: string[] = [];
      for (const type of exact) {
        const result = specializeType(type, bindings, local, context);
        if (result === null) return null;
        specialized.push(normalize?.(result) ?? result);
      }
      return specialized;
    };
  }
}

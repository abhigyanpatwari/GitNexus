import type { SymbolDefinition } from 'gitnexus-shared';
import { heritageTypeArgumentsKey } from './scope-resolution/utils/generic-instantiation.js';

type Bindings = ReadonlyMap<string, string | null>;
// Budget each expanded spelling independently so unrelated signatures still resolve.
const maxExpandedTypeLength = 32 * 1024;

// Restrict textual substitution to named types and their type constructors.
// Structural types and nested signatures may introduce new names of their own.
const compositeType = /^[\p{ID_Continue}$\s.<>,\[\]()|&]+$/u;
const namedType =
  /[$_\p{ID_Start}][$\p{ID_Continue}]*(?:\s*\.\s*[$_\p{ID_Start}][$\p{ID_Continue}]*)*/gu;

function specializeType(
  type: string,
  bindings?: Bindings,
  local?: ReadonlySet<string>,
): string | null {
  if (type.length > maxExpandedTypeLength) return null;
  if (!bindings?.size || local?.has(type)) return type;
  const direct = bindings.get(type);
  if (direct !== undefined) return direct;
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
    const postfix = type[right] === '[';
    const intersection = type[left] === '&' || type[right] === '&';
    const union = type[left] === '|' || type[right] === '|';
    const group =
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
  private readonly methodParameters = new Map<string, ReadonlySet<string>>();

  get hasBindings(): boolean {
    return this.edges.size > 0;
  }

  registerBase(
    child: string,
    base: string,
    def: SymbolDefinition,
    args: readonly string[] | undefined,
  ) {
    const parameters = def.typeParameters;
    if (!parameters?.length || !args || args.length > parameters.length) return;
    const key = heritageTypeArgumentsKey(child, base);
    if (this.edges.has(key)) return;
    const bindings = new Map<string, string | null>();
    for (const [index, parameter] of parameters.entries()) {
      const fallback = parameter.defaultType;
      const written = args[index];
      if (written !== undefined) bindings.set(parameter.name, specializeType(written));
      else if (fallback) bindings.set(parameter.name, specializeType(fallback, bindings));
    }
    if (bindings.size) this.edges.set(key, bindings);
  }

  registerMethod(id: string, def: SymbolDefinition) {
    if (def.typeParameters?.length) {
      this.methodParameters.set(id, new Set(def.typeParameters.map((p) => p.name)));
    }
  }

  /** Express every ancestor's formal parameters in the child's lexical context. */
  forClass(child: string, parents: ReadonlyMap<string, readonly string[]>) {
    const bindingsByOwner = new Map<string, Bindings>();
    if (this.edges.size) {
      const queue = [child];
      bindingsByOwner.set(child, new Map());
      for (let i = 0; i < queue.length; i++) {
        const owner = queue[i]!;
        const outer = bindingsByOwner.get(owner);
        for (const base of parents.get(owner) ?? []) {
          const args = this.edges.get(heritageTypeArgumentsKey(owner, base));
          const next = new Map<string, string | null>();
          for (const [formal, actual] of args ?? [])
            next.set(formal, actual === null ? null : specializeType(actual, outer));
          const prior = bindingsByOwner.get(base);
          if (prior) {
            // Distinct paths can instantiate the same ancestor differently. Only
            // substitutions supported by every path can select a method.
            for (const [formal, actual] of next) {
              if (prior.get(formal) !== actual) next.delete(formal);
            }
            if (next.size === prior.size) continue;
          }
          bindingsByOwner.set(base, next);
          queue.push(base);
        }
      }
    }
    return (owner: string, method: string, types: string[]): string[] | null => {
      const bindings = bindingsByOwner.get(owner);
      if (!bindings?.size || !types.length) return types;
      const local = this.methodParameters.get(method);
      const specialized: string[] = [];
      for (const type of types) {
        const result = specializeType(type, bindings, local);
        if (result === null) return null;
        specialized.push(result);
      }
      return specialized;
    };
  }
}

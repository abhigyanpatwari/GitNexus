import type { SymbolDefinition } from 'gitnexus-shared';
import { heritageTypeArgumentsKey } from './scope-resolution/utils/generic-instantiation.js';

type Bindings = ReadonlyMap<string, string>;

/** Type arguments retained between scope resolution and method override matching. */
export class HeritageSubstitutions {
  private readonly edges = new Map<string, Bindings>();
  private readonly methodParameters = new Map<string, ReadonlySet<string>>();

  get hasBindings(): boolean {
    return this.edges.size > 0;
  }

  registerBase(child: string, base: string, def: SymbolDefinition, args: readonly string[] = []) {
    const parameters = def.typeParameters;
    if (!parameters?.length || args.length > parameters.length) return;
    const key = heritageTypeArgumentsKey(child, base);
    if (this.edges.has(key)) return;
    const bindings = new Map<string, string>();
    for (const [index, parameter] of parameters.entries()) {
      const fallback = parameter.defaultType;
      const type = args[index] ?? (fallback && (bindings.get(fallback) ?? fallback));
      if (type) bindings.set(parameter.name, type);
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
          const next = new Map<string, string>();
          for (const [formal, actual] of args ?? []) next.set(formal, outer?.get(actual) ?? actual);
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
    return (owner: string, method: string, types: string[]): string[] => {
      const bindings = bindingsByOwner.get(owner);
      if (!bindings || !types.length) return types;
      const local = this.methodParameters.get(method);
      return types.map((type) => (local?.has(type) ? type : (bindings.get(type) ?? type)));
    };
  }
}

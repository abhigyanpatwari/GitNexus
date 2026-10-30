/**
 * PL/SQL name resolution shared by the graph processor and the scope resolver,
 * so structural CALLS edges and rename's source bindings make the same decision.
 *
 * Oracle resolves a subprogram name innermost-first:
 *   NAME        → nested/sibling subprograms up the enclosing chain, then a
 *                 standalone procedure/function.
 *   A.NAME      → member NAME of package A; else standalone NAME in schema A.
 *   S.A.NAME    → member NAME of package A in schema S.
 * Overloads are narrowed by arity (counting defaulted parameters) and named
 * arguments; what remains is returned as-is so callers can report ambiguity.
 */

import type { PlSqlCallSite, PlSqlDefinition } from './extract.js';

export interface PlSqlIndexEntry {
  readonly def: PlSqlDefinition;
  readonly filePath: string;
}

const pathKey = (path: readonly string[]) => path.join('.');

/** Owner path + name + parameter signature: identifies a spec declaration with its body. */
export function plsqlSignatureKey(
  def: Pick<PlSqlDefinition, 'ownerPath' | 'name' | 'parameters'>,
): string {
  return `${[...def.ownerPath, def.name].join('.')}(${def.parameters.map((p) => `${p.name} ${p.type}`.trim()).join(',')})`;
}

export class PlSqlNameIndex<E extends PlSqlIndexEntry> {
  private readonly members = new Map<string, Map<string, E[]>>();
  private readonly packageNames = new Set<string>();

  add(entry: E): void {
    if (entry.def.kind === 'package') this.packageNames.add(entry.def.name);
    const owner = pathKey(entry.def.ownerPath);
    let byName = this.members.get(owner);
    if (!byName) this.members.set(owner, (byName = new Map()));
    const list = byName.get(entry.def.name);
    if (list) list.push(entry);
    else byName.set(entry.def.name, [entry]);
  }

  hasPackage(name: string): boolean {
    return this.packageNames.has(name);
  }

  lookup(ownerPath: readonly string[], name: string): E[] {
    return this.members.get(pathKey(ownerPath))?.get(name) ?? [];
  }

  /** Candidate definitions for a call, before overload narrowing. */
  candidates(call: Pick<PlSqlCallSite, 'nameParts' | 'ownerPath'>): E[] {
    const parts = call.nameParts;
    const callable = (e: E) => e.def.kind === 'procedure' || e.def.kind === 'function';
    if (parts.length === 1) {
      const name = parts[0]!;
      for (let depth = call.ownerPath.length; depth >= 0; depth--) {
        const found = this.lookup(call.ownerPath.slice(0, depth), name).filter(callable);
        if (found.length > 0) return found;
      }
      return [];
    }
    const name = parts[parts.length - 1]!;
    const qualifier = parts[parts.length - 2]!;
    const member = this.lookup([qualifier], name).filter(callable);
    if (member.length > 0) return member;
    if (parts.length === 2) return this.lookup([], name).filter(callable);
    return [];
  }

  /** Resolve a call to its implementation(s); empty when nothing in the repository matches. */
  resolve(call: Pick<PlSqlCallSite, 'nameParts' | 'ownerPath' | 'arity' | 'namedArguments'>): E[] {
    return preferImplementations(narrowOverloads(this.candidates(call), call));
  }
}

function narrowOverloads<E extends PlSqlIndexEntry>(
  candidates: E[],
  call: Pick<PlSqlCallSite, 'arity' | 'namedArguments'>,
): E[] {
  if (candidates.length <= 1 || call.arity === undefined) return candidates;
  const arity = call.arity;
  const fits = candidates.filter((c) => {
    if (c.def.fromFallback) return true; // parameters unknown
    const required = c.def.parameters.filter((p) => !p.hasDefault).length;
    if (arity < required || arity > c.def.parameters.length) return false;
    const names = new Set(c.def.parameters.map((p) => p.name));
    return call.namedArguments.every((n) => names.has(n));
  });
  return fits.length > 0 ? fits : candidates;
}

/**
 * A spec declaration and its body describe one subprogram; prefer the body.
 * Spec-only entries remain when no body is indexed.
 */
function preferImplementations<E extends PlSqlIndexEntry>(defs: E[]): E[] {
  const bodies = new Set(defs.filter((d) => !d.def.isSpec).map((d) => plsqlSignatureKey(d.def)));
  return defs.filter((d) => !d.def.isSpec || !bodies.has(plsqlSignatureKey(d.def)));
}

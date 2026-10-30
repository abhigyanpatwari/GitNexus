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
 *
 * Names are global in a database schema but not in a repository: the same
 * package often exists several times (release folders, rollback scripts,
 * fixtures). Ties between same-named definitions in different files are
 * therefore broken by path proximity to the caller, and a package spec is
 * paired with the nearest body (`PlSqlPackageInstances`).
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

/** Number of leading directory segments two repository paths share. */
export function sharedDirectoryDepth(a: string, b: string): number {
  const da = a.split('/').slice(0, -1);
  const db = b.split('/').slice(0, -1);
  let depth = 0;
  while (depth < da.length && depth < db.length && da[depth] === db[depth]) depth++;
  return depth;
}

/** Keep only the candidates whose file is nearest to `fromFile`. */
export function nearestByPath<E extends { readonly filePath: string }>(
  candidates: readonly E[],
  fromFile: string,
): E[] {
  if (candidates.length <= 1) return [...candidates];
  const depths = candidates.map((c) =>
    c.filePath === fromFile ? Number.MAX_SAFE_INTEGER : sharedDirectoryDepth(c.filePath, fromFile),
  );
  const best = Math.max(...depths);
  return candidates.filter((_, i) => depths[i] === best);
}

export class PlSqlNameIndex<E extends PlSqlIndexEntry> {
  private readonly members = new Map<string, Map<string, E[]>>();

  add(entry: E): void {
    const owner = pathKey(entry.def.ownerPath);
    let byName = this.members.get(owner);
    if (!byName) this.members.set(owner, (byName = new Map()));
    const list = byName.get(entry.def.name);
    if (list) list.push(entry);
    else byName.set(entry.def.name, [entry]);
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

  /**
   * Resolve a call written in `fromFile` to its implementation(s): overloads,
   * then path proximity, then spec/forward declaration vs body. Empty when
   * nothing in the repository matches.
   */
  resolve(
    call: Pick<PlSqlCallSite, 'nameParts' | 'ownerPath' | 'arity' | 'namedArguments'>,
    fromFile: string,
  ): E[] {
    return preferImplementations(
      nearestByPath(narrowOverloads(this.candidates(call), call), fromFile),
    );
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
 * A spec (or forward) declaration and its body describe one subprogram; prefer
 * the body. Declaration-only entries remain when no body is a candidate.
 */
function preferImplementations<E extends PlSqlIndexEntry>(defs: E[]): E[] {
  const bodies = new Set(
    defs.filter((d) => !d.def.declarationOnly).map((d) => plsqlSignatureKey(d.def)),
  );
  return defs.filter((d) => !d.def.declarationOnly || !bodies.has(plsqlSignatureKey(d.def)));
}

/**
 * Pairs every package spec/body file with one package instance, keyed by its
 * home file: a spec is its own home; a body joins the nearest spec of the
 * same name (shared directory depth, then path order), or is its own home when
 * no spec is indexed. Copies of a package in unrelated folders stay separate.
 */
export class PlSqlPackageInstances {
  private readonly home = new Map<string, string>();

  constructor(
    packages: ReadonlyArray<{
      readonly name: string;
      readonly filePath: string;
      readonly isSpec: boolean;
    }>,
  ) {
    const specFiles = new Map<string, string[]>();
    for (const p of packages) {
      if (!p.isSpec) continue;
      const list = specFiles.get(p.name) ?? [];
      list.push(p.filePath);
      specFiles.set(p.name, list);
    }
    for (const files of specFiles.values()) files.sort();
    for (const p of packages) {
      const key = `${p.name}\0${p.filePath}`;
      if (p.isSpec || this.home.has(key)) {
        if (p.isSpec) this.home.set(key, p.filePath);
        continue;
      }
      const specs = specFiles.get(p.name);
      this.home.set(
        key,
        specs
          ? nearestByPath(
              specs.map((filePath) => ({ filePath })),
              p.filePath,
            )[0]!.filePath
          : p.filePath,
      );
    }
  }

  /** Home file of the instance of package `name` defined (spec or body) in `filePath`. */
  homeOf(name: string, filePath: string): string | undefined {
    return this.home.get(`${name}\0${filePath}`);
  }
}

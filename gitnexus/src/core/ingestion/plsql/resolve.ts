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
  /** Schema written on the enclosing package (`CREATE PACKAGE loan.pkg`), if any. */
  readonly packageSchema?: string;
  /**
   * Package instance (`PlSqlPackageInstances.instanceOf`) of a package member,
   * so a spec declaration and its body — often in different folders — are
   * weighed as one entity when proximity picks between copies.
   */
  instance?: string;
}

/**
 * The package a definition belongs to: the root of its `ownerIndex` chain,
 * or — for fallback definitions without an index — the first package of that
 * name among `fileDefs`.
 *
 * `fileDefs` must be the definitions of the file `def` was extracted from (one
 * `PlSqlFileFacts.definitions` array): `ownerIndex` indexes into it, and the
 * fallback lookup is then same-file by construction.
 */
export function rootPackageOf(
  def: PlSqlDefinition,
  fileDefs: readonly PlSqlDefinition[],
): PlSqlDefinition | undefined {
  if (def.kind === 'package') return def;
  let current: PlSqlDefinition | undefined = def;
  while (current?.ownerIndex !== undefined) current = fileDefs[current.ownerIndex];
  if (current && current !== def && current.kind === 'package') return current;
  const pkg = def.ownerPath[0];
  return pkg === undefined
    ? undefined
    : fileDefs.find((d) => d.kind === 'package' && d.name === pkg);
}

/** NUL-separated: a quoted identifier may itself contain `.` (`"A.B"` ≠ `A`.`B`). */
const pathKey = (path: readonly string[]) => path.join('\0');

/** Join name parts with `.`, re-quoting any part that itself contains a dot. */
export function dottedName(parts: readonly string[]): string {
  return parts.map((p) => (p.includes('.') ? `"${p}"` : p)).join('.');
}

/** Owner path + name + parameter signature: identifies a spec declaration with its body. */
export function plsqlSignatureKey(
  def: Pick<PlSqlDefinition, 'ownerPath' | 'name' | 'parameters'>,
): string {
  return `${dottedName([...def.ownerPath, def.name])}(${def.parameters.map((p) => `${p.name} ${p.type}`.trim()).join(',')})`;
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
    if (parts.length === 2) {
      // `S.NAME`: a standalone subprogram in schema S. Definitions that wrote
      // another schema are excluded; ones that wrote none (current schema) stay
      // candidates, behind any that name S explicitly.
      const standalone = this.lookup([], name).filter(callable);
      const exact = standalone.filter((e) => e.def.schema === qualifier);
      return exact.length > 0 ? exact : standalone.filter((e) => e.def.schema === undefined);
    }
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
    const narrowed = preferWrittenSchema(narrowOverloads(this.candidates(call), call), call);
    return preferImplementations(nearestEntities(narrowed, fromFile));
  }
}

/**
 * Proximity over entities, not entries: a spec declaration and its body (same
 * package instance and signature) form one entity whose distance is that of
 * its nearest member, so a body in another folder is not discarded because
 * the caller sits next to the spec. Standalone subprograms are one entity per
 * file.
 */
function nearestEntities<E extends PlSqlIndexEntry>(candidates: E[], fromFile: string): E[] {
  return nearestGroups<E>(candidates, fromFile, entityKey);
}

/** One subprogram of one package instance (or of one standalone file). */
function entityKey(e: PlSqlIndexEntry): string {
  return `${e.instance ?? e.filePath}\0${plsqlSignatureKey(e.def)}`;
}

/**
 * Keep the candidates of the nearest group(s), where a group (all entries
 * sharing `keyOf`) is as near to `fromFile` as its nearest member.
 */
export function nearestGroups<E extends { readonly filePath: string }>(
  candidates: readonly E[],
  fromFile: string,
  keyOf: (candidate: E) => string,
): E[] {
  if (candidates.length <= 1) return [...candidates];
  const groups = new Map<string, E[]>();
  for (const c of candidates) {
    const key = keyOf(c);
    const group = groups.get(key);
    if (group) group.push(c);
    else groups.set(key, [c]);
  }
  const distance = (group: E[]) =>
    Math.max(
      ...group.map((c) =>
        c.filePath === fromFile
          ? Number.MAX_SAFE_INTEGER
          : sharedDirectoryDepth(c.filePath, fromFile),
      ),
    );
  const scored = [...groups.values()].map((g) => ({ g, d: distance(g) }));
  const best = Math.max(...scored.map((s) => s.d));
  return scored.filter((s) => s.d === best).flatMap((s) => s.g);
}

/** In `S.A.N`, keep members of packages declared in schema `S` when any are indexed. */
function preferWrittenSchema<E extends PlSqlIndexEntry>(
  candidates: E[],
  call: Pick<PlSqlCallSite, 'nameParts'>,
): E[] {
  if (call.nameParts.length !== 3) return candidates;
  const schema = call.nameParts[0];
  const inSchema = candidates.filter((c) => c.packageSchema === schema);
  return inSchema.length > 0 ? inSchema : candidates;
}

/**
 * Keep the candidates a call can bind to. With a known argument list, a
 * candidate fits when the positional arguments fill its leading parameters,
 * every named argument names one of the remaining parameters, and every
 * parameter left unfilled has a default. A known mismatch is dropped — even a
 * sole candidate — so it yields no edge rather than a wrong one. Candidates
 * with unknown parameters (regex fallback) always fit.
 */
function narrowOverloads<E extends PlSqlIndexEntry>(
  candidates: E[],
  call: Pick<PlSqlCallSite, 'arity' | 'namedArguments'>,
): E[] {
  if (call.arity === undefined) return candidates;
  const positional = call.arity - call.namedArguments.length;
  return candidates.filter((c) => {
    if (c.def.fromFallback) return true; // parameters unknown
    const params = c.def.parameters;
    if (positional < 0 || positional > params.length) return false;
    const named = new Set(call.namedArguments);
    if (named.size !== call.namedArguments.length) return false; // duplicate name
    const supplied = new Set(params.slice(0, positional).map((p) => p.name));
    for (const name of named) {
      const param = params.find((p) => p.name === name);
      if (!param || supplied.has(name)) return false;
      supplied.add(name);
    }
    return params.every((p) => p.hasDefault || supplied.has(p.name));
  });
}

/**
 * A spec (or forward) declaration and its body describe one subprogram; prefer
 * the body. Pairing is per package instance, so a body in one copy of a
 * package never hides the declaration of another copy. Declaration-only
 * entries remain when their own instance has no body among the candidates.
 */
function preferImplementations<E extends PlSqlIndexEntry>(defs: E[]): E[] {
  const bodies = new Set(defs.filter((d) => !d.def.declarationOnly).map(entityKey));
  return defs.filter((d) => !d.def.declarationOnly || !bodies.has(entityKey(d)));
}

/**
 * Pairs every package spec/body definition with one package instance: a spec
 * is its own instance; a body joins the nearest spec of the same name whose
 * schema is compatible (equal, or unwritten on either side), or is its own
 * instance when no such spec is indexed. Copies of a package in unrelated
 * folders, and same-named packages of different schemas, stay separate.
 */
export class PlSqlPackageInstances {
  private readonly instance = new Map<string, string>();
  private readonly home = new Map<string, string>();

  constructor(
    packages: ReadonlyArray<{
      readonly name: string;
      readonly schema?: string;
      readonly filePath: string;
      readonly isSpec: boolean;
    }>,
  ) {
    const specs = packages.filter((p) => p.isSpec);
    for (const p of [...specs, ...packages.filter((q) => !q.isSpec)]) {
      const key = entryKey(p.name, p.schema, p.filePath);
      if (this.instance.has(key)) continue;
      const spec = p.isSpec
        ? p
        : pickSpec(
            specs.filter(
              (s) =>
                s.name === p.name &&
                (s.schema === undefined || p.schema === undefined || s.schema === p.schema),
            ),
            p.filePath,
            p.schema,
          );
      const owner = spec ?? p;
      const id = entryKey(owner.name, owner.schema, owner.filePath);
      this.instance.set(key, id);
      this.home.set(id, owner.filePath);
    }
  }

  /** Opaque instance id of package `name` (written schema `schema`) defined in `filePath`. */
  instanceOf(name: string, schema: string | undefined, filePath: string): string {
    return this.instance.get(entryKey(name, schema, filePath)) ?? entryKey(name, schema, filePath);
  }

  /** File that anchors an instance (its spec when indexed). */
  homeOf(instanceId: string): string | undefined {
    return this.home.get(instanceId);
  }
}

function entryKey(name: string, schema: string | undefined, filePath: string): string {
  return `${name}\0${schema ?? ''}\0${filePath}`;
}

/** Nearest compatible spec; an exact schema match wins a distance tie, then path order. */
function pickSpec<S extends { filePath: string; schema?: string }>(
  specs: readonly S[],
  fromFile: string,
  schema: string | undefined,
): S | undefined {
  const nearest = nearestByPath(specs, fromFile);
  const exact = nearest.filter((s) => s.schema === schema);
  return [...(exact.length > 0 ? exact : nearest)].sort((a, b) =>
    a.filePath < b.filePath ? -1 : a.filePath > b.filePath ? 1 : 0,
  )[0];
}

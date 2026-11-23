/** Compute each module's public names from its local and forwarded declarations. */
import type { SymbolDefinition } from './symbol-definition.js';
import type { ImportEdge, ParsedImport } from './types.js';

export interface PublishedExport {
  readonly def: SymbolDefinition;
  readonly via: readonly string[];
  readonly typeOnly?: true;
  readonly namespaceTargetFile?: string;
}

interface AmbiguousExport {
  readonly candidates: readonly [string, string];
  readonly typeOnly?: true;
}

type ExportState = PublishedExport | AmbiguousExport;
type Exports = ReadonlyMap<string, SymbolDefinition>;

export interface ExclusiveModuleExports {
  get(file: string, name: string): PublishedExport | undefined;
  isReexported(file: string, name: string): boolean;
  values(file: string): Exports;
  readonly ambiguities: ReadonlyArray<{
    readonly filePath: string;
    readonly name: string;
    /** Two lexicographically smallest conflicting declaration IDs. */
    readonly candidateDefIds: readonly string[];
  }>;
}

interface ExportDraft {
  readonly source: ParsedImport;
  readonly targetFile: string | null;
  readonly base: Pick<ImportEdge, 'kind' | 'typeOnly'>;
}

interface Forwarding {
  readonly file: string;
  readonly exported?: string;
  readonly typeOnly?: true;
}

const EMPTY_VIA: readonly string[] = Object.freeze([]);
const EMPTY_EXPORTS: Exports = new Map();
const compareCodeUnits = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

function identity(exported: PublishedExport): string {
  return exported.namespaceTargetFile === undefined
    ? exported.def.nodeId
    : `namespace:${exported.namespaceTargetFile}`;
}

/** A deterministic refusal needs two witnesses, regardless of how many paths repeat them. */
function merge(previous: ExportState | undefined, next: ExportState): ExportState {
  if (previous === undefined) return next;
  if (!!previous.typeOnly !== !!next.typeOnly) return previous.typeOnly ? next : previous;
  if (
    !('candidates' in previous) &&
    !('candidates' in next) &&
    identity(previous) === identity(next)
  )
    return previous;

  // An unmarked variable (including an ambient declaration) is weaker than a
  // marked export. Equal weak claims use a stable owner across file orders.
  const weakPrevious =
    !('candidates' in previous) &&
    previous.def.type === 'Variable' &&
    previous.def.isExported === undefined;
  const weakNext =
    !('candidates' in next) && next.def.type === 'Variable' && next.def.isExported === undefined;
  if (weakPrevious && weakNext)
    return compareCodeUnits(previous.def.nodeId, next.def.nodeId) <= 0 ? previous : next;
  if (weakPrevious || weakNext) return weakPrevious ? next : previous;

  const witnesses = new Set('candidates' in previous ? previous.candidates : [previous.def.nodeId]);
  for (const id of 'candidates' in next ? next.candidates : [next.def.nodeId]) witnesses.add(id);
  const [first, second] = [...witnesses].sort(compareCodeUnits);
  if (
    'candidates' in previous &&
    previous.candidates[0] === first &&
    previous.candidates[1] === second
  )
    return previous;
  return { candidates: [first, second], typeOnly: previous.typeOnly };
}

/**
 * Compute the export surface for providers with exclusive wildcard exports.
 * Named exports reserve their names before any stars are followed. Resolve a
 * name to its terminal declaration or module object, so diamonds agree and
 * ambiguous origins propagate through cycles without selecting a winner.
 *
 * The queue sends changes only to directives that consume the name. A known
 * export can gain a value route or more precise ambiguity witnesses. Path construction is bounded by the caller's provenance limit.
 */
export function buildExclusiveModuleExports(
  locals: ReadonlyMap<string, Exports>,
  draftsByFile: ReadonlyMap<string, readonly ExportDraft[]>,
  excluded: ReadonlySet<string> | undefined,
  extendVia: (head: string, tail: readonly string[]) => readonly string[],
): ExclusiveModuleExports {
  const explicit = new Map<string, Set<string>>();
  const byStar = new Map<string, Forwarding[]>();
  const byName = new Map<string, Map<string, Forwarding[]>>();
  const states = new Map<string, Map<string, ExportState>>();
  const changes: Array<readonly [string, string]> = [];

  const read = (file: string, name: string): ExportState | undefined => {
    const state = states.get(file)?.get(name);
    if (state !== undefined || explicit.get(file)?.has(name)) return state;
    const def = locals.get(file)?.get(name);
    return def === undefined ? undefined : { def, via: EMPTY_VIA };
  };
  const publish = (file: string, name: string, next: ExportState) => {
    let names = states.get(file);
    if (!names) states.set(file, (names = new Map()));
    const previous = names.get(name);
    const picked = merge(previous, next);
    if (picked === previous) return;
    names.set(name, picked);
    if (byStar.has(file) || byName.get(file)?.has(name)) changes.push([file, name]);
  };

  const namespaceSeeds: Array<readonly [string, string, PublishedExport]> = [];
  for (const [file, drafts] of draftsByFile) {
    for (const { source, targetFile, base } of drafts) {
      const typeOnly = base.typeOnly === true ? true : undefined;
      if (source.kind === 'wildcard' && source.reexportsName !== false) {
        if (targetFile === null || !locals.has(targetFile) || targetFile === file) continue;
        let readers = byStar.get(targetFile);
        if (!readers) byStar.set(targetFile, (readers = []));
        readers.push({ file, typeOnly });
        continue;
      }
      const namespace = source.kind === 'namespace' && source.exportsOnly === true;
      const named =
        base.kind !== 'namespace' &&
        (source.kind === 'reexport' ||
          ((source.kind === 'named' || source.kind === 'alias') && source.reexportsName === true));
      if (!namespace && !named) continue;
      const exported = source.localName;
      let reserved = explicit.get(file);
      if (!reserved) explicit.set(file, (reserved = new Set()));
      reserved.add(exported);
      if (targetFile === null || !locals.has(targetFile)) continue;
      if (namespace) {
        const def = locals.get(file)?.get(exported);
        if (def?.type === 'Namespace') {
          namespaceSeeds.push([
            file,
            exported,
            { def, via: [targetFile], namespaceTargetFile: targetFile, typeOnly },
          ]);
        }
        continue;
      }
      let names = byName.get(targetFile);
      if (!names) byName.set(targetFile, (names = new Map()));
      let readers = names.get(source.importedName);
      if (!readers) names.set(source.importedName, (readers = []));
      readers.push({ file, exported, typeOnly });
    }
  }

  // A type-only local reserves its public spelling and propagates the same
  // erasure evidence as an explicit type-only forward.
  for (const [file, definitions] of locals) {
    for (const [name, def] of definitions) {
      if (!def.typeOnlyExports?.includes(name)) continue;
      let reserved = explicit.get(file);
      if (!reserved) explicit.set(file, (reserved = new Set()));
      reserved.add(name);
      publish(file, name, { def, via: EMPTY_VIA, typeOnly: true });
    }
  }
  for (const [file, name, seed] of namespaceSeeds) publish(file, name, seed);
  for (const file of new Set([...byStar.keys(), ...byName.keys()])) {
    const namedReads = byName.get(file);
    for (const name of byStar.has(file)
      ? (locals.get(file)?.keys() ?? [])
      : (namedReads?.keys() ?? [])) {
      if (locals.get(file)?.has(name) && !explicit.get(file)?.has(name)) changes.push([file, name]);
    }
  }
  for (let i = 0; i < changes.length; i++) {
    const [source, name] = changes[i];
    const state = read(source, name);
    if (state === undefined) continue;
    // Routes with the same erasure fact all share the same terminal evidence.
    const via = 'candidates' in state ? undefined : extendVia(source, state.via);
    const deliver = (reader: Forwarding, exported: string) =>
      publish(
        reader.file,
        exported,
        'candidates' in state
          ? reader.typeOnly && !state.typeOnly
            ? { ...state, typeOnly: true }
            : state
          : { ...state, via: via!, typeOnly: reader.typeOnly || state.typeOnly },
      );
    for (const reader of byName.get(source)?.get(name) ?? []) deliver(reader, reader.exported!);
    if (excluded?.has(name)) continue;
    for (const reader of byStar.get(source) ?? []) {
      if (explicit.get(reader.file)?.has(name) || locals.get(reader.file)?.has(name)) continue;
      deliver(reader, name);
    }
  }

  const ambiguities: ExclusiveModuleExports['ambiguities'][number][] = [];
  for (const [filePath, names] of states) {
    for (const [name, state] of names) {
      if ('candidates' in state && !explicit.get(filePath)?.has(name)) {
        ambiguities.push({
          filePath,
          name,
          candidateDefIds: state.candidates,
        });
      }
    }
  }
  ambiguities.sort(
    (a, b) => compareCodeUnits(a.filePath, b.filePath) || compareCodeUnits(a.name, b.name),
  );

  const values = new Map<string, Exports>();
  const valuesFor = (file: string): Exports => {
    const own = locals.get(file) ?? EMPTY_EXPORTS;
    const forwarded = states.get(file);
    const reserved = explicit.get(file);
    if (forwarded === undefined && reserved === undefined) return own;
    let exports = values.get(file);
    if (exports !== undefined) return exports;
    const published = new Map(own);
    for (const name of reserved ?? []) published.delete(name);
    for (const [name, state] of forwarded ?? []) {
      if ('candidates' in state || state.typeOnly) continue;
      published.set(name, state.def);
    }
    values.set(file, (exports = published));
    return exports;
  };

  return {
    get(file, name) {
      const state = read(file, name);
      return state === undefined || 'candidates' in state ? undefined : state;
    },
    values: valuesFor,
    isReexported(file, name) {
      return explicit.get(file)?.has(name) === true || states.get(file)?.has(name) === true;
    },
    ambiguities,
  };
}

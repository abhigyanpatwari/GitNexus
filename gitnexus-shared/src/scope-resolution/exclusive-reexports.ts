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
function compareCodeUnits(a: string, b: string): number {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

function getOrCreate<K, V>(map: Map<K, V>, key: K, create: () => V): V {
  const existing = map.get(key);
  if (existing !== undefined) return existing;
  const value = create();
  map.set(key, value);
  return value;
}

function isWeakVariable(state: ExportState): state is PublishedExport {
  return (
    !('candidates' in state) && state.def.type === 'Variable' && state.def.isExported === undefined
  );
}

function witnessesOf(state: ExportState): readonly string[] {
  return 'candidates' in state ? state.candidates : [state.def.nodeId];
}

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
  const weakPrevious = isWeakVariable(previous);
  const weakNext = isWeakVariable(next);
  if (weakPrevious && weakNext)
    return compareCodeUnits(previous.def.nodeId, next.def.nodeId) <= 0 ? previous : next;
  if (weakPrevious || weakNext) return weakPrevious ? next : previous;

  return mergeAmbiguity(previous, next);
}

function mergeAmbiguity(previous: ExportState, next: ExportState): ExportState {
  const witnesses = new Set([...witnessesOf(previous), ...witnessesOf(next)]);
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
    const names = getOrCreate(states, file, () => new Map<string, ExportState>());
    const previous = names.get(name);
    const picked = merge(previous, next);
    if (picked === previous) return;
    names.set(name, picked);
    if (byStar.has(file) || byName.get(file)?.has(name)) changes.push([file, name]);
  };

  const namespaceSeeds: Array<readonly [string, string, PublishedExport]> = [];
  function registerDraft(file: string, { source, targetFile, base }: ExportDraft): void {
    const typeOnly = base.typeOnly === true ? true : undefined;
    if (source.kind === 'wildcard' && source.reexportsName !== false) {
      if (targetFile !== null && targetFile !== file && locals.has(targetFile)) {
        getOrCreate(byStar, targetFile, () => []).push({ file, typeOnly });
      }
      return;
    }
    const namespace = source.kind === 'namespace' && source.exportsOnly === true;
    const named =
      base.kind !== 'namespace' &&
      (source.kind === 'reexport' ||
        ((source.kind === 'named' || source.kind === 'alias') && source.reexportsName === true));
    if (!namespace && !named) return;
    const exported = source.localName;
    getOrCreate(explicit, file, () => new Set<string>()).add(exported);
    if (targetFile === null || !locals.has(targetFile)) return;
    if (namespace) {
      const def = locals.get(file)?.get(exported);
      if (def?.type === 'Namespace') {
        namespaceSeeds.push([
          file,
          exported,
          { def, via: [targetFile], namespaceTargetFile: targetFile, typeOnly },
        ]);
      }
      return;
    }
    const names = getOrCreate(byName, targetFile, () => new Map<string, Forwarding[]>());
    getOrCreate(names, source.importedName, () => []).push({ file, exported, typeOnly });
  }

  for (const [file, drafts] of draftsByFile) {
    for (const draft of drafts) registerDraft(file, draft);
  }

  function seedExplicitExports(): void {
    // A type-only local reserves its public spelling and propagates the same
    // erasure evidence as an explicit type-only forward.
    for (const [file, definitions] of locals) {
      for (const [name, def] of definitions) {
        if (!def.typeOnlyExports?.includes(name)) continue;
        getOrCreate(explicit, file, () => new Set<string>()).add(name);
        publish(file, name, { def, via: EMPTY_VIA, typeOnly: true });
      }
    }
    for (const [file, name, seed] of namespaceSeeds) publish(file, name, seed);
  }

  function queueLocalExports(): void {
    for (const file of new Set([...byStar.keys(), ...byName.keys()])) {
      const namedReads = byName.get(file);
      for (const name of byStar.has(file)
        ? (locals.get(file)?.keys() ?? [])
        : (namedReads?.keys() ?? [])) {
        if (locals.get(file)?.has(name) && !explicit.get(file)?.has(name))
          changes.push([file, name]);
      }
    }
  }

  seedExplicitExports();
  queueLocalExports();
  function forwardName(source: string, name: string): void {
    const state = read(source, name);
    if (state === undefined) return;
    // All readers share the same terminal declaration and provenance.
    const forwarded =
      'candidates' in state
        ? state
        : { ...state, via: extendVia(source, state.via), typeOnly: state.typeOnly };
    const deliver = (reader: Forwarding, exported: string) => {
      const next =
        reader.typeOnly && !forwarded.typeOnly
          ? { ...forwarded, typeOnly: true as const }
          : forwarded;
      publish(reader.file, exported, next);
    };
    for (const reader of byName.get(source)?.get(name) ?? []) deliver(reader, reader.exported!);
    if (excluded?.has(name)) return;
    for (const reader of byStar.get(source) ?? []) {
      if (explicit.get(reader.file)?.has(name) || locals.get(reader.file)?.has(name)) continue;
      deliver(reader, name);
    }
  }

  // Publishing can append more names to the live queue during iteration.
  for (const [source, name] of changes) forwardName(source, name);

  const values = new Map<string, Exports>();
  const valuesFor = (file: string): Exports => {
    const own = locals.get(file) ?? EMPTY_EXPORTS;
    const forwarded = states.get(file);
    const reserved = explicit.get(file);
    if (forwarded === undefined && reserved === undefined) return own;
    const exports = values.get(file);
    if (exports !== undefined) return exports;
    const published = new Map(own);
    for (const name of reserved ?? []) published.delete(name);
    for (const [name, state] of forwarded ?? []) {
      if ('candidates' in state || state.typeOnly) continue;
      published.set(name, state.def);
    }
    values.set(file, published);
    return published;
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
    ambiguities: collectAmbiguities(states, explicit),
  };
}

function collectAmbiguities(
  states: ReadonlyMap<string, ReadonlyMap<string, ExportState>>,
  explicit: ReadonlyMap<string, ReadonlySet<string>>,
): ExclusiveModuleExports['ambiguities'] {
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

  return ambiguities;
}

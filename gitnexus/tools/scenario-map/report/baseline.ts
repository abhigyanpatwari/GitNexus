/**
 * Week-over-week change of the scenario map report (U13, R12, KTD13, design §5.5).
 *
 * A report carries a continuity section ({@link ContinuitySection}): the anchor of every test it
 * names and one {@link ContinuityItem} per pair verdict (kept pairs included), per test and per
 * production file with gaps, each with its evidence hash. {@link compareWithBaseline} compares the
 * current section with the previous complete run's report (the `scenario-map-baseline` artifact):
 *  - tests continue through identity.ts `matchAnchors`: the same anchor key, or else a body and
 *    row fingerprint that are unique on both sides (a moved or renamed test); identical bodies
 *    never match by body alone;
 *  - a pair continues the previous pair of its members' previous anchors, a test its previous
 *    anchor, a gap item the same production file;
 *  - a continued item is `unchanged` when its evidence hash is equal, else `changed`; anything
 *    else is `new`; previous items no current item continues are `resolved`.
 * No previous report: every item is new under the "first run, no baseline" banner. A previous
 * report with another schema version, or without a readable continuity section, gets the
 * "incompatible baseline" banner and no delta: no statuses and no counts.
 *
 * Library only; pure. The report (report.ts) embeds the comparison, and the markdown and issue
 * body render it.
 */
import { SCENARIO_MAP_SCHEMA_VERSION, type TestAnchor } from '../types.js';
import { matchAnchors } from '../inventory/identity.js';

export type ItemKind = 'pair' | 'test' | 'gap';

/** One report item as continuity sees it. */
export interface ContinuityItem {
  kind: ItemKind;
  /** {@link itemKey} of the kind and members (gap items: of the file). */
  key: string;
  /** Anchor keys: two for a pair (sorted), one for a test, none for a gap item. */
  members: string[];
  evidenceHash: string;
  /** Human label: the test ids of a pair or test, the file of a gap item. */
  label: string;
}

export interface ContinuitySection {
  /** Every anchor the items name, sorted by key. */
  anchors: TestAnchor[];
  items: ContinuityItem[];
}

export type ChangeStatus = 'new' | 'changed' | 'unchanged';
export type BaselineState = 'compared' | 'first-run' | 'incompatible';

export const BANNERS: Readonly<Record<Exclude<BaselineState, 'compared'>, string>> = Object.freeze({
  'first-run': 'first run, no baseline',
  incompatible: 'incompatible baseline',
});

export interface ItemChange {
  kind: ItemKind;
  key: string;
  status: ChangeStatus;
  /** The previous item's key; null for a new item. */
  previous: string | null;
}

export interface ResolvedItem {
  kind: ItemKind;
  key: string;
  label: string;
  evidenceHash: string;
}

export interface ChangeCounts {
  new: number;
  changed: number;
  unchanged: number;
  resolved: number;
}

export interface BaselineComparison {
  state: BaselineState;
  /** {@link BANNERS} text; null when compared. */
  banner: string | null;
  /** Why the baseline is incompatible; null otherwise. */
  reason: string | null;
  /** The baseline's run id and schema version; null without a baseline. */
  baseline: { runId: string | null; schemaVersion: number | null } | null;
  /** Null when incompatible (no delta). */
  counts: ChangeCounts | null;
  /** One per current item, in item order; empty when incompatible. */
  changes: ItemChange[];
  /** Sorted by kind and key; empty when incompatible. */
  resolved: ResolvedItem[];
}

/** The key of an item: `pair:<a>|<b>` (sorted), `test:<anchor>`, `gap:<file>`. */
export function itemKey(kind: ItemKind, members: readonly string[], file = ''): string {
  if (kind === 'gap') return `gap:${file}`;
  return `${kind}:${[...members].sort().join('|')}`;
}

// ── Reading a previous report ──────────────────────────────────────────────

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const isStringArray = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((entry) => typeof entry === 'string');
const ITEM_KINDS: readonly string[] = ['pair', 'test', 'gap'] satisfies ItemKind[];
const isItemKind = (value: unknown): value is ItemKind =>
  typeof value === 'string' && ITEM_KINDS.includes(value);
const isNullableString = (value: unknown): value is string | null =>
  value === null || typeof value === 'string';
const isPresent = <T>(value: T | null): value is T => value !== null;

function readAnchor(value: unknown): TestAnchor | null {
  if (!isRecord(value)) return null;
  const { key, file, describePath, title, rowFingerprint, bodyFingerprint } = value;
  if (
    typeof key !== 'string' ||
    typeof file !== 'string' ||
    !isStringArray(describePath) ||
    typeof title !== 'string' ||
    !isNullableString(rowFingerprint) ||
    typeof bodyFingerprint !== 'string'
  ) {
    return null;
  }
  return { key, file, describePath: [...describePath], title, rowFingerprint, bodyFingerprint };
}

function readItem(value: unknown): ContinuityItem | null {
  if (!isRecord(value)) return null;
  const { kind, key, members, evidenceHash, label } = value;
  if (
    !isItemKind(kind) ||
    typeof key !== 'string' ||
    !isStringArray(members) ||
    typeof evidenceHash !== 'string' ||
    typeof label !== 'string'
  ) {
    return null;
  }
  return { kind, key, members: [...members], evidenceHash, label };
}

interface Baseline {
  runId: string | null;
  schemaVersion: number | null;
  continuity: ContinuitySection | null;
}

function readBaseline(previous: unknown): Baseline {
  if (!isRecord(previous)) return { runId: null, schemaVersion: null, continuity: null };
  const schemaVersion = typeof previous.schemaVersion === 'number' ? previous.schemaVersion : null;
  const run = previous.run;
  const runId = isRecord(run) && typeof run.id === 'string' ? run.id : null;
  const section = previous.continuity;
  if (!isRecord(section) || !Array.isArray(section.anchors) || !Array.isArray(section.items)) {
    return { runId, schemaVersion, continuity: null };
  }
  const anchors = section.anchors.map(readAnchor);
  const items = section.items.map(readItem);
  if (!anchors.every(isPresent) || !items.every(isPresent)) {
    return { runId, schemaVersion, continuity: null };
  }
  return { runId, schemaVersion, continuity: { anchors, items } };
}

// ── Comparison ─────────────────────────────────────────────────────────────

/** Compares `current` with a previous report (parsed JSON, or null when there is none). */
export function compareWithBaseline(
  current: ContinuitySection,
  previous: unknown,
  schemaVersion: number = SCENARIO_MAP_SCHEMA_VERSION,
): BaselineComparison {
  if (previous === null || previous === undefined) {
    const changes = current.items.map(
      (item): ItemChange => ({ kind: item.kind, key: item.key, status: 'new', previous: null }),
    );
    return {
      state: 'first-run',
      banner: BANNERS['first-run'],
      reason: null,
      baseline: null,
      counts: { new: changes.length, changed: 0, unchanged: 0, resolved: 0 },
      changes,
      resolved: [],
    };
  }
  const baseline = readBaseline(previous);
  const incompatible = (reason: string): BaselineComparison => ({
    state: 'incompatible',
    banner: BANNERS.incompatible,
    reason,
    baseline: { runId: baseline.runId, schemaVersion: baseline.schemaVersion },
    counts: null,
    changes: [],
    resolved: [],
  });
  if (baseline.schemaVersion !== schemaVersion) {
    return incompatible(
      `baseline schema version ${baseline.schemaVersion ?? 'missing'}, this report ${schemaVersion}`,
    );
  }
  if (baseline.continuity === null) return incompatible('baseline has no readable continuity');

  const before = baseline.continuity;
  const continued = new Map(
    matchAnchors(before.anchors, current.anchors).map((match) => [match.current, match.previous]),
  );
  const previousItems = new Map(before.items.map((item) => [item.key, item]));
  const claimed = new Set<string>();
  const changes = current.items.map((item): ItemChange => {
    const members = item.members.map((member) => continued.get(member) ?? null);
    const key =
      item.kind === 'gap'
        ? item.key
        : members.every((member) => member !== null)
          ? itemKey(item.kind, members)
          : null;
    const match = key === null ? undefined : previousItems.get(key);
    if (match === undefined || match.kind !== item.kind || claimed.has(match.key)) {
      return { kind: item.kind, key: item.key, status: 'new', previous: null };
    }
    claimed.add(match.key);
    return {
      kind: item.kind,
      key: item.key,
      status: match.evidenceHash === item.evidenceHash ? 'unchanged' : 'changed',
      previous: match.key,
    };
  });
  const resolved = before.items
    .filter((item) => !claimed.has(item.key))
    .map(
      (item): ResolvedItem => ({
        kind: item.kind,
        key: item.key,
        label: item.label,
        evidenceHash: item.evidenceHash,
      }),
    )
    .sort((a, b) => (a.kind === b.kind ? (a.key < b.key ? -1 : 1) : a.kind < b.kind ? -1 : 1));
  const count = (status: ChangeStatus): number =>
    changes.filter((change) => change.status === status).length;
  return {
    state: 'compared',
    banner: null,
    reason: null,
    baseline: { runId: baseline.runId, schemaVersion: baseline.schemaVersion },
    counts: {
      new: count('new'),
      changed: count('changed'),
      unchanged: count('unchanged'),
      resolved: resolved.length,
    },
    changes,
    resolved,
  };
}

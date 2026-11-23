import type { Range } from 'gitnexus-shared';
import type { ResolutionOutcome } from './resolution-outcome.js';

/** Bound persisted diagnostics independently of repository size. */
export const MAX_UNRESOLVED_OVERLOAD_SITES = 2_000;
export const MAX_OVERLOAD_IDENTITIES_PER_SITE = 256;
export const MAX_OVERLOAD_SUMMARY_BYTES = 2 * 1024 * 1024;

export interface UnresolvedOverloadSite {
  readonly id: string;
  readonly filePath: string;
  readonly name: string;
  readonly range: Range;
  /** Public graph identities, never scope-resolution definition IDs. */
  readonly candidateIds: readonly string[];
  readonly candidateOwnerIds: readonly string[];
  readonly callerIds: readonly string[];
  readonly reasons: readonly string[];
}

export interface UnresolvedOverloadSummary {
  readonly schemaVersion: 1;
  /** False for incomplete attribution, missing input, or a capped summary. */
  readonly complete: boolean;
  /** Unique unresolved call sites before the persistence cap. */
  readonly totalSites: number;
  readonly omittedSites: number;
  /** Kept once per site; queries union matching identities, not per-target counts. */
  readonly sites: readonly UnresolvedOverloadSite[];
}

export interface OverloadBoundary {
  readonly notes: readonly string[];
  readonly sites: number;
}

const overloadReasons = new Set<string>([
  'overload-ambiguous',
  'overload-ambiguous-normalization',
  'conversion-rank-tied',
  'member-lookup-ambiguous',
  'overload-unknown',
]);

type Suppressed = Extract<ResolutionOutcome, { kind: 'suppressed' }>;

function siteId(outcome: { filePath: string; range: Range }): string {
  const { range } = outcome;
  return JSON.stringify([
    outcome.filePath,
    range.startLine,
    range.startCol,
    range.endLine,
    range.endCol,
  ]);
}

const ordered = (items: Iterable<string>): string[] => [...new Set(items)].sort();

/**
 * Summarize final decisions, including an explicit receipt for a clean run.
 * A replay may resolve an earlier suppression. Reconcile within its phase:
 * resolving a primary call does not resolve an unknown implementation dispatch.
 */
export function summarizeUnresolvedOverloads(
  outcomes: readonly ResolutionOutcome[],
  inputComplete = true,
): UnresolvedOverloadSummary {
  const pending = new Map<string, Map<string, Suppressed>>();
  let complete = inputComplete;
  for (const outcome of outcomes) {
    if (outcome.kind !== 'resolved' && outcome.kind !== 'suppressed') continue;
    const id = siteId(outcome);
    if (outcome.kind === 'resolved' || outcome.reason === 'overload-inapplicable') {
      const phases = pending.get(id);
      phases?.delete(outcome.phase);
      if (phases?.size === 0) pending.delete(id);
      continue;
    }
    if (!overloadReasons.has(outcome.reason)) continue;
    if (outcome.siteKind !== undefined && outcome.siteKind !== 'call') continue;
    // Old member-lookup records also described property reads and writes.
    // Without their kind we cannot count them as call sites or certify coverage.
    if (outcome.reason === 'member-lookup-ambiguous' && outcome.siteKind === undefined) {
      complete = false;
      continue;
    }
    let phases = pending.get(id);
    if (phases === undefined) pending.set(id, (phases = new Map()));
    phases.set(outcome.phase, outcome);
  }

  const sites: UnresolvedOverloadSite[] = [];
  let bytes = 256; // Header and punctuation, conservatively above their maximum.
  for (const id of [...pending.keys()].sort()) {
    const phases = [...pending.get(id)!.values()];
    const first = phases[0];
    const candidates = ordered(phases.flatMap((outcome) => outcome.candidateGraphIds ?? []));
    const owners = ordered(phases.flatMap((outcome) => outcome.candidateOwnerIds ?? []));
    const callers = ordered(
      phases.flatMap((outcome) => (outcome.callerId ? [outcome.callerId] : [])),
    );
    if (
      phases.some((outcome) => outcome.candidateSetComplete !== true) ||
      candidates.length === 0 ||
      callers.length !== 1 ||
      phases.some((outcome) => !outcome.callerId)
    ) {
      complete = false;
    }
    if (
      candidates.length > MAX_OVERLOAD_IDENTITIES_PER_SITE ||
      owners.length > MAX_OVERLOAD_IDENTITIES_PER_SITE ||
      callers.length > MAX_OVERLOAD_IDENTITIES_PER_SITE
    ) {
      complete = false;
    }
    const site: UnresolvedOverloadSite = {
      id,
      filePath: first.filePath,
      name: ordered(phases.map((outcome) => outcome.name))[0],
      range: first.range,
      candidateIds: candidates.slice(0, MAX_OVERLOAD_IDENTITIES_PER_SITE),
      candidateOwnerIds: owners.slice(0, MAX_OVERLOAD_IDENTITIES_PER_SITE),
      callerIds: callers.slice(0, MAX_OVERLOAD_IDENTITIES_PER_SITE),
      reasons: ordered(phases.map((outcome) => outcome.reason)),
    };
    const siteBytes = Buffer.byteLength(JSON.stringify(site), 'utf8') + 1;
    if (
      sites.length >= MAX_UNRESOLVED_OVERLOAD_SITES ||
      bytes + siteBytes > MAX_OVERLOAD_SUMMARY_BYTES
    ) {
      complete = false;
      continue;
    }
    sites.push(site);
    bytes += siteBytes;
  }
  return {
    schemaVersion: 1,
    complete,
    totalSites: pending.size,
    omittedSites: pending.size - sites.length,
    sites,
  };
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function integer(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function identities(value: unknown): value is string[] {
  return (
    Array.isArray(value) &&
    value.length <= MAX_OVERLOAD_IDENTITIES_PER_SITE &&
    value.every((id) => typeof id === 'string' && id.length > 0) &&
    new Set(value).size === value.length
  );
}

function isRange(value: unknown): value is Range {
  return (
    record(value) &&
    ['startLine', 'startCol', 'endLine', 'endCol'].every(
      (key) => Object.hasOwn(value, key) && integer(value[key]),
    ) &&
    (value.endLine as number) >= (value.startLine as number) &&
    (value.endLine !== value.startLine || (value.endCol as number) >= (value.startCol as number))
  );
}

/** Metadata comes from JSON: validate the receipt, bounds and every measured count. */
function readSummary(value: unknown): UnresolvedOverloadSummary | undefined {
  if (
    !record(value) ||
    !['schemaVersion', 'complete', 'totalSites', 'omittedSites', 'sites'].every((key) =>
      Object.hasOwn(value, key),
    ) ||
    value.schemaVersion !== 1 ||
    typeof value.complete !== 'boolean' ||
    !integer(value.totalSites) ||
    !integer(value.omittedSites) ||
    !Array.isArray(value.sites) ||
    value.sites.length > MAX_UNRESOLVED_OVERLOAD_SITES ||
    value.totalSites !== value.sites.length + value.omittedSites ||
    (value.complete && value.omittedSites !== 0)
  ) {
    return undefined;
  }
  const seen = new Set<string>();
  const sites: UnresolvedOverloadSite[] = [];
  for (const site of value.sites) {
    if (
      !record(site) ||
      ![
        'id',
        'filePath',
        'name',
        'range',
        'candidateIds',
        'candidateOwnerIds',
        'callerIds',
        'reasons',
      ].every((key) => Object.hasOwn(site, key)) ||
      typeof site.id !== 'string' ||
      typeof site.filePath !== 'string' ||
      typeof site.name !== 'string' ||
      !isRange(site.range) ||
      !identities(site.candidateIds) ||
      !identities(site.candidateOwnerIds) ||
      !identities(site.callerIds) ||
      !identities(site.reasons) ||
      site.reasons.length === 0 ||
      site.reasons.some((reason) => !overloadReasons.has(reason)) ||
      (value.complete && (site.candidateIds.length === 0 || site.callerIds.length !== 1))
    ) {
      return undefined;
    }
    if (site.id !== siteId({ filePath: site.filePath, range: site.range }) || seen.has(site.id)) {
      return undefined;
    }
    seen.add(site.id);
    sites.push({
      id: site.id,
      filePath: site.filePath,
      name: site.name,
      range: site.range,
      candidateIds: site.candidateIds,
      candidateOwnerIds: site.candidateOwnerIds,
      callerIds: site.callerIds,
      reasons: site.reasons,
    });
  }
  try {
    if (Buffer.byteLength(JSON.stringify(value), 'utf8') > MAX_OVERLOAD_SUMMARY_BYTES) {
      return undefined;
    }
  } catch {
    return undefined;
  }
  return {
    schemaVersion: 1,
    complete: value.complete,
    totalSites: value.totalSites,
    omittedSites: value.omittedSites,
    sites,
  };
}

/**
 * Match a whole expanded traversal in one bounded pass. A site touching several
 * visited candidates is counted once. Owner IDs handle type queries without
 * attributing every method in the owning file to every class in that file.
 */
export function probeOverloadBoundaries(
  value: unknown,
  symbolIds: ReadonlySet<string>,
  direction: 'upstream' | 'downstream' | 'both',
  includeSite: (site: UnresolvedOverloadSite) => boolean = () => true,
  traversalComplete = true,
): OverloadBoundary {
  if (symbolIds.size === 0) return { notes: [], sites: 0 };
  const summary = readSummary(value);
  if (summary === undefined) {
    return {
      notes: [
        'Overload-resolution completeness was not recorded or its metadata is invalid. ' +
          'Run analyze --force with the current analyzer before trusting zero callers; actual impact may be higher.',
      ],
      sites: 0,
    };
  }
  let sites = 0;
  let eligibleSites = 0;
  for (const site of summary.sites) {
    if (!includeSite(site)) continue;
    eligibleSites++;
    const incoming =
      direction !== 'downstream' &&
      (site.candidateIds.some((id) => symbolIds.has(id)) ||
        site.candidateOwnerIds.some((id) => symbolIds.has(id)));
    const outgoing = direction !== 'upstream' && site.callerIds.some((id) => symbolIds.has(id));
    if (incoming || outgoing) sites++;
  }
  const notes: string[] = [];
  if (sites > 0) {
    notes.push(
      `${sites} call ${sites === 1 ? 'site has' : 'sites have'} unresolved overload or implementation ` +
        'targets in this query. Those call edges were not recorded, so actual impact may be higher.',
    );
  }
  if (!summary.complete) {
    notes.push(
      'Overload-resolution coverage is partial: candidate/caller identities or retained call-site ' +
        'details are incomplete. The reported unresolved-site count is a lower bound; ' +
        'absence from this summary does not establish complete coverage.',
    );
  }
  if (!traversalComplete && eligibleSites > 0) {
    notes.push(
      'The impact traversal was incomplete, so unresolved overload sites outside the examined ' +
        'frontier may also affect this result.',
    );
  }
  return { notes, sites };
}

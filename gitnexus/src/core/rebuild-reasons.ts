/**
 * Rebuild-reason collector (#3137, PR #3385).
 *
 * Every path in analyze that forces a full rebuild — and the #2409 escalated
 * full write, which is announced but does not force — contributes one
 * `{ key, text }` reason here. The rebuild decision (`forced`) and all
 * operator-facing output come from this one collector: a single summary
 * before the pipeline and at most one follow-up line for reasons added after
 * it. Reasons are persisted on the crash-recovery marker as the flattened
 * `StoredRebuildReason[]` from `toStored()`, and an interrupted rebuild comes
 * back as one `interrupted-rebuild` entry via `recordInterruptedRebuild`.
 *
 * Pure: no I/O, no logging, no dependency on run-analyze.
 */

/** One value per distinct cause; paths testing the same predicate share a key. */
export const REBUILD_REASON_KEYS = [
  'user-force',
  'skills',
  'parse-cache-bypass',
  'drop-embeddings',
  'interrupted-rebuild',
  'private-graph-unavailable',
  'shared-store-missing-graph',
  'content-retention',
  'pdg-mode',
  'schema-fingerprint',
  'graph-write-collapse',
  'analysis-features',
  'spring-vendor-prefixes',
  'runner-identity',
  'cjk-segmentation',
  'embedding-dims',
  'spring-actuator',
  'asyncapi',
  'escalated-full-write',
] as const;

export type RebuildReasonKey = (typeof REBUILD_REASON_KEYS)[number];

export interface RebuildReason {
  readonly key: RebuildReasonKey;
  readonly text: string;
  /** `false` marks a reason that is announced but does not force a rebuild. */
  readonly forcing?: false;
}

/**
 * Serializable shape persisted on the crash-recovery marker. `key` is a plain
 * string so reasons written by a newer build survive a read by an older one.
 */
export interface StoredRebuildReason {
  readonly key: string;
  readonly text: string;
}

const INTERRUPTED_KEY: RebuildReasonKey = 'interrupted-rebuild';

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

/**
 * A non-forcing reason (the escalated DB write) changes how a run writes, not
 * whether it rebuilds, so a block of only non-forcing reasons must not claim a
 * full rebuild.
 */
function leadFor(reasons: readonly RebuildReason[], forcingLead: string): string {
  return reasons.some((reason) => reason.forcing !== false) ? forcingLead : 'Write plan changed';
}

/**
 * Validate reasons read back from metadata. Entries with string `key` and
 * `text` are kept (unknown keys included); anything else is dropped, and a
 * non-array value reads as no reasons recorded.
 */
export const readStoredRebuildReasons = (value: unknown): StoredRebuildReason[] => {
  if (!Array.isArray(value)) return [];
  const stored: StoredRebuildReason[] = [];
  for (const entry of value) {
    if (isRecord(entry) && typeof entry.key === 'string' && typeof entry.text === 'string') {
      stored.push({ key: entry.key, text: entry.text });
    }
  }
  return stored;
};

const singleLine = (text: string): string => text.replace(/\s*\n\s*/g, ' ');

export class RebuildReasonCollector {
  private readonly entries = new Map<string, RebuildReason>();
  private readonly announced = new Set<string>();
  /** Stored reasons of an interrupted rebuild, keyed for merge; `undefined` when none. */
  private interrupted: { stored: Map<string, string>; details?: string } | undefined;

  /** Add a reason; a key already present keeps its position and takes the newest text. */
  add(reason: RebuildReason): void {
    if (reason.key === INTERRUPTED_KEY) {
      this.entries.set(reason.key, reason);
      return;
    }
    if (this.interrupted?.stored.has(reason.key)) {
      this.interrupted.stored.set(reason.key, reason.text);
      this.refreshInterruptedEntry();
      return;
    }
    this.entries.set(reason.key, reason);
  }

  /**
   * Contribute the recovery entry for a crashed run. `stored` is flattened
   * (nested `interrupted-rebuild` entries are dropped) and any reason already
   * collected with a matching key is merged into it — the current run's text
   * wins, since it is newer than the stored one.
   */
  recordInterruptedRebuild(stored: readonly StoredRebuildReason[], dirtyDetails?: string): void {
    const merged = new Map<string, string>();
    for (const { key, text } of stored) {
      if (key !== INTERRUPTED_KEY) merged.set(key, text);
    }
    for (const key of merged.keys()) {
      const current = this.entries.get(key);
      if (current) {
        merged.set(key, current.text);
        this.entries.delete(key);
      }
    }
    this.interrupted = { stored: merged, details: dirtyDetails };
    this.refreshInterruptedEntry();
  }

  /** True when any forcing reason is present. */
  get forced(): boolean {
    for (const reason of this.entries.values()) {
      if (reason.forcing !== false) return true;
    }
    return false;
  }

  keys(): RebuildReasonKey[] {
    return [...this.entries.values()].map((reason) => reason.key);
  }

  reasons(): RebuildReason[] {
    return [...this.entries.values()];
  }

  /**
   * The pre-pipeline summary: inline for one reason, numbered for several,
   * `undefined` when empty. Marks every current reason as announced.
   */
  formatSummary(): string | undefined {
    const reasons = this.takeUnannounced();
    if (reasons.length === 0) return undefined;
    const lead = leadFor(reasons, 'Full rebuild required');
    if (reasons.length === 1) return `${lead}: ${reasons[0].text}`;
    const numbered = reasons.map((reason, i) => `  ${i + 1}. ${reason.text}`).join('\n');
    return `${lead} (${reasons.length} reasons):\n${numbered}`;
  }

  /**
   * One line covering only the reasons added since the last summary or
   * follow-up; `undefined` when there are none.
   */
  formatFollowUp(): string | undefined {
    const reasons = this.takeUnannounced();
    if (reasons.length === 0) return undefined;
    const lead = leadFor(reasons, 'Full rebuild also required');
    return `${lead}: ${reasons.map((reason) => singleLine(reason.text)).join('; ')}`;
  }

  /**
   * The flattened reasons to persist on the crash-recovery marker: the
   * interrupted rebuild's (merged) stored reasons first, then every other
   * collected reason. Never contains an `interrupted-rebuild` entry.
   */
  toStored(): StoredRebuildReason[] {
    const stored: StoredRebuildReason[] = [...(this.interrupted?.stored ?? [])].map(
      ([key, text]) => ({ key, text }),
    );
    for (const reason of this.entries.values()) {
      if (reason.key !== INTERRUPTED_KEY) stored.push({ key: reason.key, text: reason.text });
    }
    return stored;
  }

  private takeUnannounced(): RebuildReason[] {
    const fresh = [...this.entries.values()].filter((reason) => !this.announced.has(reason.key));
    for (const reason of fresh) this.announced.add(reason.key);
    return fresh;
  }

  private refreshInterruptedEntry(): void {
    if (!this.interrupted) return;
    const { stored, details } = this.interrupted;
    const texts = [...stored.values()];
    const recorded =
      texts.length === 0
        ? 'no reasons recorded'
        : texts.length === 1
          ? `interrupted rebuild was for: ${texts[0]}`
          : `interrupted rebuild was for: ${texts.map((text, i) => `(${i + 1}) ${text}`).join('; ')}`;
    const dirtyState = details === undefined ? '' : `; last dirty state: ${details}`;
    this.entries.set(INTERRUPTED_KEY, {
      key: INTERRUPTED_KEY,
      text:
        'Previous analyze run did not complete cleanly (incrementalInProgress flag set)' +
        `${dirtyState}; ${recorded}; forcing full rebuild to restore a known-good index.`,
    });
  }
}

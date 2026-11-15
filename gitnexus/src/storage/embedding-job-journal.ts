/** Compact scheduling journal. The caller owns the checkout's exclusive job lock. */
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import type {
  EmbeddingManifestCursor,
  EmbeddingManifestReceipt,
} from '../core/embeddings/embedding-work-manifest.js';
import {
  embeddingJobDirectory,
  readEmbeddingJobRecord,
  syncEmbeddingJobDirectory,
  writeEmbeddingJobRecord,
} from './embedding-job.js';

export interface EmbeddingUnitIntent {
  start: EmbeddingManifestCursor;
  next: EmbeddingManifestCursor;
  nodes: number;
  origin: 'manifest' | 'failed';
  /** Bounded by the unit's 64 nodes; three deterministic rejections exclude a node. */
  inputFailures?: Record<string, number>;
  /** Older receipts use raw node IDs. New receipts bound keys independently of ID length. */
  inputFailureKeyFormat?: 'sha256';
}

export interface EmbeddingJobState {
  version: 1;
  identity: string;
  manifestDigest: string;
  totalUnits: number;
  totalNodes: number;
  manifestBytes: number;
  cursor: EmbeddingManifestCursor;
  completedUnits: number;
  completedNodes: number;
  reusedUnits: number;
  reusedNodes: number;
  failedUnits: number;
  failedNodes: number;
  excludedNodes?: number;
  chunks: number;
  active: EmbeddingUnitIntent | null;
  phase: 'embedding' | 'indexing' | 'ready';
}

export type EmbeddingFailureCause = 'provider' | 'input' | 'cancelled';
interface FailedUnit {
  version: 1;
  identity: string;
  manifestDigest: string;
  intent: EmbeddingUnitIntent;
  cause: EmbeddingFailureCause;
  attempt: string;
}

const DIGEST = /^[a-f0-9]{64}$/;
const FAILED = /^failed-(\d{16})\.json$/;
const integer = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
const filename = (unit: number): string => `failed-${String(unit).padStart(16, '0')}.json`;
const clone = <T>(value: T): T => structuredClone(value);

export const embeddingInputFailureKey = (nodeId: string): string =>
  createHash('sha256').update(nodeId).digest('hex');

/** Operational failures (permissions, I/O) must not be treated as lost state. */
function damagedRecord(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException).code;
  if (code) return code === 'ENOENT' || code === 'ERR_ENCODING_INVALID_ENCODED_DATA';
  return (
    error instanceof SyntaxError ||
    /checksum|Malformed|Invalid|UTF-8|receipt exceeds/i.test(String(error))
  );
}

function validateIntent(intent: EmbeddingUnitIntent, state: EmbeddingJobState): void {
  if (
    !intent ||
    !intent.start ||
    !intent.next ||
    !integer(intent.start.unit) ||
    intent.start.unit >= state.totalUnits ||
    !integer(intent.start.offset) ||
    !integer(intent.next.offset) ||
    intent.next.offset <= intent.start.offset ||
    intent.next.offset > state.manifestBytes ||
    intent.next.unit !== intent.start.unit + 1 ||
    !integer(intent.nodes) ||
    intent.nodes < 1 ||
    intent.nodes > 64 ||
    !['manifest', 'failed'].includes(intent.origin) ||
    (intent.inputFailureKeyFormat !== undefined && intent.inputFailureKeyFormat !== 'sha256')
  )
    throw new Error('Invalid embedding unit intent');
  if (
    intent.inputFailures !== undefined &&
    (!intent.inputFailures ||
      typeof intent.inputFailures !== 'object' ||
      Array.isArray(intent.inputFailures) ||
      Object.keys(intent.inputFailures).length > intent.nodes ||
      Object.entries(intent.inputFailures).some(
        ([id, attempts]) =>
          !id.length ||
          id.length > 1024 * 1024 ||
          (intent.inputFailureKeyFormat === 'sha256' && !DIGEST.test(id)) ||
          !integer(attempts) ||
          attempts < 1 ||
          attempts > 3,
      ))
  )
    throw new Error('Invalid embedding input rejection history');
}

function validateState(
  value: unknown,
  identity: string,
  manifest: EmbeddingManifestReceipt,
): asserts value is EmbeddingJobState {
  const s = value as EmbeddingJobState;
  if (
    !s ||
    s.version !== 1 ||
    s.identity !== identity ||
    s.manifestDigest !== manifest.digest ||
    s.totalNodes !== manifest.totalNodes ||
    s.totalUnits !== manifest.totalUnits ||
    s.manifestBytes !== manifest.bytes ||
    !s.cursor ||
    !integer(s.cursor.unit) ||
    s.cursor.unit > s.totalUnits ||
    !integer(s.cursor.offset) ||
    s.cursor.offset > manifest.bytes ||
    (s.cursor.unit === 0 && s.cursor.offset !== 0) ||
    (s.cursor.unit === s.totalUnits && s.cursor.offset !== manifest.bytes) ||
    ![
      s.completedUnits,
      s.completedNodes,
      s.reusedUnits,
      s.reusedNodes,
      s.failedUnits,
      s.failedNodes,
      s.chunks,
      s.excludedNodes ?? 0,
    ].every(integer) ||
    s.completedUnits + s.reusedUnits + s.failedUnits > s.totalUnits ||
    s.completedNodes + s.reusedNodes + s.failedNodes + (s.excludedNodes ?? 0) > s.totalNodes ||
    !['embedding', 'indexing', 'ready'].includes(s.phase) ||
    s.active === undefined
  )
    throw new Error('Embedding job identity or coverage is invalid; artifacts retained');
  if (s.active) {
    validateIntent(s.active, s);
    const active = s.active;
    if (
      active.origin === 'manifest'
        ? active.start.unit !== s.cursor.unit || active.start.offset !== s.cursor.offset
        : active.next.unit > s.cursor.unit
    )
      throw new Error('Embedding job active cursor is inconsistent');
  }
  const settled = s.completedUnits + s.reusedUnits + s.failedUnits;
  if (
    settled + (s.active?.origin === 'failed' ? 1 : 0) !== s.cursor.unit ||
    (s.phase !== 'embedding' &&
      (s.active !== null ||
        s.failedUnits !== 0 ||
        settled !== s.totalUnits ||
        s.completedNodes + s.reusedNodes + (s.excludedNodes ?? 0) !== s.totalNodes))
  )
    throw new Error('Embedding job accounting is inconsistent');
}

/** No model, DB, source text, or growing pending-ID list is retained here. */
export class EmbeddingJobJournal {
  private busy = false;
  private uncertain = false;
  /** Failed units are attempted at most once per invocation, even if readdir sees a replacement. */
  readonly attempt = randomUUID();

  private constructor(
    readonly directory: string,
    private state: EmbeddingJobState,
    private readonly manifest: EmbeddingManifestReceipt,
  ) {}

  static async create(
    directory: string,
    identity: string,
    manifest: EmbeddingManifestReceipt,
  ): Promise<EmbeddingJobJournal> {
    if (!DIGEST.test(identity) || !DIGEST.test(manifest.digest))
      throw new Error('Invalid embedding job identity');
    const canonical = await embeddingJobDirectory(directory);
    try {
      await fs.lstat(path.join(canonical, 'job.json'));
      throw new Error('Embedding job already exists');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    const state: EmbeddingJobState = {
      version: 1,
      identity,
      manifestDigest: manifest.digest,
      totalUnits: manifest.totalUnits,
      totalNodes: manifest.totalNodes,
      manifestBytes: manifest.bytes,
      cursor: { unit: 0, offset: 0 },
      completedUnits: 0,
      completedNodes: 0,
      reusedUnits: 0,
      reusedNodes: 0,
      failedUnits: 0,
      failedNodes: 0,
      chunks: 0,
      active: null,
      phase: 'embedding',
    };
    validateState(state, identity, manifest);
    await writeEmbeddingJobRecord(canonical, 'job.json', state);
    return new EmbeddingJobJournal(canonical, state, clone(manifest));
  }

  static async open(
    directory: string,
    identity: string,
    manifest: EmbeddingManifestReceipt,
  ): Promise<EmbeddingJobJournal> {
    if (!DIGEST.test(identity)) throw new Error('Invalid embedding job identity');
    const canonical = await embeddingJobDirectory(directory);
    const state = await readEmbeddingJobRecord(canonical, 'job.json');
    validateState(state, identity, manifest);
    return new EmbeddingJobJournal(canonical, state, clone(manifest));
  }

  snapshot(): EmbeddingJobState {
    return clone(this.state);
  }

  /** Recovery requires an independently verified manifest and vector identity.
   * Preserve damaged receipts; the runner reconstructs coverage only from native
   * complete groups. A valid receipt for another identity is never discarded.
   * This also resumes an interruption between preserving and replacing job.json.
   */
  static async recover(
    directory: string,
    identity: string,
    manifest: EmbeddingManifestReceipt,
  ): Promise<EmbeddingJobJournal> {
    const canonical = await embeddingJobDirectory(directory);
    let value: unknown;
    try {
      value = await readEmbeddingJobRecord(canonical, 'job.json');
    } catch (error) {
      if (!damagedRecord(error)) throw error;
    }
    if (value && typeof value === 'object') {
      const state = value as Partial<EmbeddingJobState>;
      if (
        (state.version !== undefined && state.version !== 1) ||
        (state.identity && state.identity !== identity) ||
        (state.manifestDigest && state.manifestDigest !== manifest.digest)
      )
        throw new Error('Embedding job identity mismatch; recovery refused');
      let journal: EmbeddingJobJournal | undefined;
      try {
        validateState(value, identity, manifest);
        journal = new EmbeddingJobJournal(canonical, value, clone(manifest));
      } catch {
        /* Matching identity but damaged accounting requires reconstruction. */
      }
      if (journal) {
        try {
          await journal.verifyFailedRecords();
          return journal;
        } catch (error) {
          if (!damagedRecord(error)) throw error;
          // Complete native node groups survive this scheduling reset. The
          // runner verifies them before acknowledging without provider calls.
        }
      }
    }
    const suffix = `.preserved-${randomUUID()}`;
    try {
      await fs.rename(path.join(canonical, 'job.json'), path.join(canonical, `job.json${suffix}`));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    await syncEmbeddingJobDirectory(canonical);
    const entries = await fs.opendir(canonical);
    for await (const entry of entries) {
      if (FAILED.test(entry.name))
        await fs.rename(
          path.join(canonical, entry.name),
          path.join(canonical, entry.name + suffix),
        );
    }
    await syncEmbeddingJobDirectory(canonical);
    return this.create(canonical, identity, manifest);
  }

  private async mutate(action: (next: EmbeddingJobState) => Promise<void>): Promise<void> {
    if (this.busy) throw new Error('Concurrent embedding journal mutation');
    if (this.uncertain)
      throw new Error('Embedding journal durability uncertain; reopen before retry');
    this.busy = true;
    try {
      const next = clone(this.state);
      await action(next);
      validateState(next, next.identity, this.manifest);
      // A rejected rename/fsync may already have changed durable state. Pure
      // validation failures before the first write leave the journal usable.
      this.uncertain = true;
      await writeEmbeddingJobRecord(this.directory, 'job.json', next);
      this.state = next;
      this.uncertain = false;
    } finally {
      this.busy = false;
    }
  }

  async begin(intent: EmbeddingUnitIntent): Promise<void> {
    const requested = clone(intent);
    await this.mutate(async (next) => {
      if (next.active || next.phase !== 'embedding')
        throw new Error('Embedding job already active or complete');
      validateIntent(requested, next);
      if (requested.origin === 'failed') {
        const record = await this.readFailed(filename(requested.start.unit));
        if (
          record.intent.start.unit !== requested.start.unit ||
          record.intent.start.offset !== requested.start.offset ||
          record.intent.next.unit !== requested.next.unit ||
          record.intent.next.offset !== requested.next.offset ||
          record.intent.nodes !== requested.nodes
        )
          throw new Error('Failed embedding unit cursor mismatch');
        next.failedUnits--;
        next.failedNodes -= requested.nodes;
        requested.inputFailures = record.intent.inputFailures;
        requested.inputFailureKeyFormat = record.intent.inputFailureKeyFormat;
      }
      next.active = requested;
    });
  }

  /** Call only after the vector store has verified this unit's committed receipts. */
  async acknowledge(result: { reusedNodes: number; chunks: number }): Promise<void> {
    await this.mutate(async (next) => {
      const active = next.active;
      const excluded = Object.values(active?.inputFailures ?? {}).filter(
        (attempts) => attempts >= 3,
      ).length;
      if (
        !active ||
        !integer(result.reusedNodes) ||
        result.reusedNodes > active.nodes - excluded ||
        !integer(result.chunks)
      )
        throw new Error('Invalid embedding unit acknowledgement');
      // If the process dies after unlink, the still-active intent owns replay.
      this.uncertain = true;
      await fs.rm(path.join(this.directory, filename(active.start.unit)), { force: true });
      await syncEmbeddingJobDirectory(this.directory);
      if (result.reusedNodes === active.nodes) next.reusedUnits++;
      else next.completedUnits++;
      next.reusedNodes += result.reusedNodes;
      next.completedNodes += active.nodes - result.reusedNodes - excluded;
      if (excluded) next.excludedNodes = (next.excludedNodes ?? 0) + excluded;
      next.chunks += result.chunks;
      if (active.origin === 'manifest') next.cursor = active.next;
      next.active = null;
    });
  }

  /** Input/provider failures stay durable; storage/durability failures must abort. */
  async fail(cause: EmbeddingFailureCause): Promise<void> {
    await this.mutate(async (next) => {
      const active = next.active;
      if (!active || !['provider', 'input', 'cancelled'].includes(cause))
        throw new Error('Invalid embedding failure');
      const record: FailedUnit = {
        version: 1,
        identity: next.identity,
        manifestDigest: next.manifestDigest,
        intent: { ...active, origin: 'failed' },
        cause,
        attempt: this.attempt,
      };
      this.uncertain = true;
      await writeEmbeddingJobRecord(this.directory, filename(active.start.unit), record);
      next.failedUnits++;
      next.failedNodes += active.nodes;
      if (active.origin === 'manifest') next.cursor = active.next;
      next.active = null;
    });
  }

  /** Persist input-only failures before discarding partial rows; return counts for these IDs. */
  async recordInputRejections(ids: readonly string[]): Promise<Readonly<Record<string, number>>> {
    if (!ids.length) return {};
    await this.mutate(async (next) => {
      const active = next.active;
      if (!active || new Set(ids).size !== ids.length || ids.length > active.nodes)
        throw new Error('Invalid embedding input rejections');
      const history = Object.fromEntries(
        Object.entries(active.inputFailures ?? {}).map(([key, attempts]) => [
          active.inputFailureKeyFormat === 'sha256' ? key : embeddingInputFailureKey(key),
          attempts,
        ]),
      );
      for (const id of ids) {
        if (!id.length || id.length > 1024 * 1024 || id === '__proto__')
          throw new Error('Invalid rejected node identity');
        const key = embeddingInputFailureKey(id);
        history[key] = Math.min(3, (history[key] ?? 0) + 1);
      }
      active.inputFailures = history;
      active.inputFailureKeyFormat = 'sha256';
    });
    const history = this.state.active!.inputFailures!;
    return Object.fromEntries(ids.map((id) => [id, history[embeddingInputFailureKey(id)]]));
  }

  private async readFailed(name: string): Promise<FailedUnit> {
    const record = (await readEmbeddingJobRecord(this.directory, name)) as FailedUnit;
    if (
      record &&
      typeof record === 'object' &&
      ((record.version !== undefined && record.version !== 1) ||
        (record.identity && record.identity !== this.state.identity) ||
        (record.manifestDigest && record.manifestDigest !== this.state.manifestDigest))
    )
      throw new Error('Embedding failure identity mismatch; recovery refused');
    if (
      !record ||
      record.version !== 1 ||
      record.identity !== this.state.identity ||
      record.manifestDigest !== this.state.manifestDigest ||
      !['provider', 'input', 'cancelled'].includes(record.cause) ||
      typeof record.attempt !== 'string'
    )
      throw new Error('Invalid failed embedding unit');
    validateIntent(record.intent, this.state);
    if (record.intent.origin !== 'failed' || name !== filename(record.intent.start.unit))
      throw new Error('Failed embedding unit identity mismatch');
    return record;
  }

  /** Constant memory; failed records are the only growing scheduling data. */
  private async verifyFailedRecords(): Promise<void> {
    let units = 0;
    let nodes = 0;
    const entries = await fs.opendir(this.directory);
    for await (const entry of entries) {
      if (!FAILED.test(entry.name)) continue;
      const record = await this.readFailed(entry.name);
      // An active retry owns this unit even if its failure file was already
      // removed, or a crash left the previous failed record beside it.
      if (this.state.active && entry.name === filename(this.state.active.start.unit)) continue;
      units++;
      nodes += record.intent.nodes;
      if (
        record.intent.next.unit > this.state.cursor.unit ||
        units > this.state.failedUnits ||
        nodes > this.state.failedNodes
      )
        throw new Error('Invalid failed embedding accounting');
    }
    if (units !== this.state.failedUnits || nodes !== this.state.failedNodes)
      throw new Error('Invalid failed embedding accounting');
  }

  async *failed(): AsyncGenerator<EmbeddingUnitIntent> {
    const directory = await fs.opendir(this.directory);
    for await (const entry of directory) {
      if (!FAILED.test(entry.name)) continue;
      const record = await this.readFailed(entry.name);
      if (
        record.attempt === this.attempt ||
        record.intent.start.unit === this.state.active?.start.unit
      )
        continue;
      if (record.intent.next.unit > this.state.cursor.unit)
        throw new Error('Orphan failed unit has no active intent');
      yield clone(record.intent);
    }
  }

  async indexing(): Promise<void> {
    await this.mutate(async (next) => {
      next.phase = 'indexing';
    });
  }

  /** The completed vector artifact must be closed and published before this call. */
  async ready(): Promise<void> {
    await this.mutate(async (next) => {
      if (next.phase !== 'indexing') throw new Error('Embedding index has not been finalized');
      next.phase = 'ready';
    });
  }
}

/**
 * Relationship per-label-pair routing (#2203 U2).
 *
 * LadybugDB's bulk `COPY` into the single `CodeRelation` rel table requires a
 * separate CSV per FROM→TO node-label pair (the `from=`/`to=` COPY params).
 * Historically the emit pass wrote one monolithic `relations.csv`, which
 * `loadGraphToLbug` then RE-READ line-by-line (regex per edge) and re-split
 * into per-pair files — writing and reading the entire ~1M-edge set twice.
 *
 * This router lets the single emit pass route each edge to its per-pair file
 * directly, so the monolithic write + re-read + per-edge regex are all gone.
 * The label-derivation + validTables filtering + per-pair-file format here match
 * the legacy `splitRelCsvByLabelPair`, so the per-pair files are byte-identical
 * for all quote-free ids — see the differential test in
 * `test/integration/csv-pipeline.test.ts`. ONE intentional divergence: this
 * router derives the label from the RAW id, while the oracle re-derives it via a
 * regex over the ESCAPED row — so for an id containing a `"` the router is the
 * more-correct path (it routes the edge to the right pair; the oracle's regex
 * mis-buckets or drops it). `splitRelCsvByLabelPair` is retained as the
 * differential oracle (the quote-in-id divergence is asserted explicitly).
 *
 * Backpressure: at most one stream is awaited at a time (the caller routes
 * edges sequentially and awaits the returned drain promise before the next),
 * mirroring the legacy split's `for await` invariant. The hot path (existing
 * pair, no backpressure) returns `void` — no microtask per edge.
 */
import path from 'path';
import { createWriteStream, type WriteStream } from 'fs';
import { once } from 'events';
import { finished } from 'stream/promises';

/** Injectable for tests (backpressure/error simulation), mirroring split. */
export type WriteStreamFactory = (filePath: string) => WriteStream;

/**
 * Derive a node's table label from its graph id. Matches the legacy
 * `getNodeLabel` that lived inline in `loadGraphToLbug`:
 *   - `comm_*`  → Community
 *   - `proc_*`  → Process
 *   - otherwise the prefix before the first `:` (e.g. `Function:…` → Function)
 */
export const getNodeLabel = (nodeId: string): string => {
  if (nodeId.startsWith('comm_')) return 'Community';
  if (nodeId.startsWith('proc_')) return 'Process';
  return nodeId.split(':')[0];
};

export interface RelPairMeta {
  csvPath: string;
  rows: number;
}

/**
 * Routes already-escaped relationship CSV rows to per-FROM→TO-label-pair
 * files. Filters edges whose endpoint labels are not valid node tables
 * (counted as `skipped`), exactly as the legacy split did.
 */
export class RelPairRouter {
  /** pairKey (`From|To`) → { csvPath, rows } */
  readonly byPair = new Map<string, RelPairMeta>();
  private readonly streams = new Map<string, WriteStream>();
  skipped = 0;
  total = 0;

  private streamError: Error | null = null;
  private readonly abort = new AbortController();

  constructor(
    private readonly csvDir: string,
    private readonly header: string,
    private readonly validTables: Set<string>,
    private readonly wsFactory: WriteStreamFactory = (p) => createWriteStream(p, 'utf-8'),
  ) {}

  private markError = (err: Error): void => {
    this.streamError ??= err;
    this.abort.abort(err);
  };

  /**
   * The first stream error observed, if any. Lets the emit caller rethrow the
   * real error (EMFILE / disk-full) instead of the generic `AbortError` that a
   * pending `once(ws,'drain',{signal})` rejects with when the abort fires —
   * mirroring the retained `splitRelCsvByLabelPair`'s `throw streamError ?? err`.
   */
  get lastError(): Error | null {
    return this.streamError;
  }

  /**
   * Route one already-escaped CSV row (no trailing newline) to its pair file.
   * Returns `void` on the synchronous hot path; a `Promise<void>` only when a
   * stream signals backpressure (or a new pair's header does) — the caller
   * awaits the promise before routing the next edge.
   */
  route(fromId: string, toId: string, row: string): void | Promise<void> {
    if (this.streamError) throw this.streamError;

    const fromLabel = getNodeLabel(fromId);
    const toLabel = getNodeLabel(toId);
    if (!this.validTables.has(fromLabel) || !this.validTables.has(toLabel)) {
      this.skipped++;
      return;
    }

    const pairKey = `${fromLabel}|${toLabel}`;
    const ws = this.streams.get(pairKey);
    if (ws === undefined) {
      // First edge for this pair: open the stream, write header + row.
      return this.openAndWrite(pairKey, fromLabel, toLabel, row);
    }

    this.byPair.get(pairKey)!.rows++;
    this.total++;
    if (!ws.write(row + '\n')) {
      return once(ws, 'drain', { signal: this.abort.signal }).then(() => undefined);
    }
  }

  private async openAndWrite(
    pairKey: string,
    fromLabel: string,
    toLabel: string,
    row: string,
  ): Promise<void> {
    const csvPath = path.join(this.csvDir, `rel_${fromLabel}_${toLabel}.csv`);
    const ws = this.wsFactory(csvPath);
    ws.on('error', this.markError);
    this.streams.set(pairKey, ws);
    this.byPair.set(pairKey, { csvPath, rows: 1 });
    this.total++;
    if (!ws.write(this.header + '\n')) {
      await once(ws, 'drain', { signal: this.abort.signal });
    }
    if (!ws.write(row + '\n')) {
      await once(ws, 'drain', { signal: this.abort.signal });
    }
  }

  /** Flush + close every pair stream. Rejects if any stream errored. */
  async close(): Promise<void> {
    if (this.streamError) {
      this.destroy();
      throw this.streamError;
    }
    await Promise.all(
      Array.from(this.streams.values()).map(async (ws) => {
        ws.end();
        await finished(ws);
      }),
    );
    if (this.streamError) throw this.streamError;
  }

  /** Tear down all streams (no flush) — used on the error path. */
  destroy(): void {
    for (const ws of this.streams.values()) ws.destroy();
  }
}

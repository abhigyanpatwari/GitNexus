/**
 * Synchronous buffered CSV writer, shared by the streaming emit sinks.
 *
 * Extracted verbatim from `pdg-emit-sink.ts` (issue #2202) so the structural
 * `GraphEmitSink` (#2680) reuses the same buffering and IO-fault discipline
 * instead of duplicating ~90 lines of it. No behaviour change: `PdgEmitSink`
 * imports this class and is otherwise untouched.
 *
 * Why synchronous? The emit loops these sinks sit under are synchronous — there
 * is no `await` point to drain an async stream, so a `WriteStream` would
 * accumulate unwritten chunks in process memory across millions of rows,
 * defeating the RSS bound this exists to provide. `fs.writeSync` goes straight
 * to the OS; resident memory is bounded to one `chunkRows` buffer. This mirrors
 * the sync-shard pattern in `storage/parsedfile-store.ts`.
 */

import fs from 'fs';

/** Default streamed-write buffer (rows), shared by both sinks. */
export const DEFAULT_EMIT_CHUNK_ROWS = 500;

export class SyncCsvWriter {
  private fd: number;
  private buf: string[] = [];
  private readonly chunkRows: number;
  rows = 0;
  /**
   * First IO error this writer hit (a `fs.writeSync` short-write loop throwing
   * on e.g. disk-full). Once poisoned the writer refuses further rows and
   * skips its final flush; the owning sink surfaces it from its `finalize()`
   * so a truncated CSV is never handed to the bulk COPY (#2202 review #4). A
   * streamed-write failure is an IO fault, not the logic error that the emit
   * loops' per-file try/catch is built to swallow — poisoning routes it past
   * that catch to a loud failure.
   */
  poison: unknown | undefined = undefined;

  constructor(
    readonly csvPath: string,
    header: string,
    chunkRows: number,
  ) {
    // Guard a 0/negative buffer: the flush modulo would never fire and `buf`
    // would grow unbounded, defeating the whole point of streaming.
    this.chunkRows = Math.max(1, chunkRows);
    // Exclusive create (O_EXCL): the streamed-CSV dir is wiped + recreated fresh
    // by the owning sink's constructor before any writer opens a file, so the
    // path never pre-exists — 'wx' both matches that invariant and refuses to
    // follow a pre-planted symlink at the path (CWE-377 / CodeQL
    // js/insecure-temporary-file).
    this.fd = fs.openSync(csvPath, 'wx');
    this.buf.push(header);
  }

  addRow(row: string): void {
    // A poisoned writer is dead — stop buffering so memory can't grow on a
    // writer whose fd is already in a bad state; finalize will report the fault.
    if (this.poison !== undefined) return;
    this.buf.push(row);
    this.rows++;
    // Flush on DATA-row count, not buffer length: the header occupies buf[0]
    // until the first flush, so a `buf.length >= chunkRows` test would fire one
    // row early on the first chunk. Counting rows makes every flush exactly
    // `chunkRows` rows.
    if (this.rows % this.chunkRows === 0) this.flushOrPoison();
  }

  /** Flush, recording (and re-throwing) any IO error as poison. Re-throwing
   *  lets the immediate caller log the per-file failure; the persisted `poison`
   *  is the backstop that makes finalize fail loudly even when that throw is
   *  swallowed by an emit loop's try/catch. */
  private flushOrPoison(): void {
    try {
      this.flush();
    } catch (e) {
      this.poison ??= e;
      throw e;
    }
  }

  private flush(): void {
    if (this.buf.length === 0) return;
    const data = Buffer.from(this.buf.join('\n') + '\n', 'utf8');
    // fs.writeSync can return a short byte count; loop until the whole buffer
    // lands so a partial write never truncates a CSV row mid-field.
    let offset = 0;
    while (offset < data.length) {
      offset += fs.writeSync(this.fd, data, offset, data.length - offset);
    }
    this.buf.length = 0;
  }

  /** Flush remaining rows (unless already poisoned) and close the fd. Never
   *  throws: a final-flush IO error is recorded as poison and the fd is still
   *  closed, so a write error neither leaks an fd nor escapes here — the owning
   *  sink reads {@link poison} after closing every writer and fails loudly then. */
  close(): void {
    try {
      if (this.poison === undefined) this.flush();
    } catch (e) {
      this.poison ??= e;
    } finally {
      try {
        fs.closeSync(this.fd);
      } catch {
        /* fd may already be invalid after an IO fault — nothing to recover */
      }
    }
  }
}

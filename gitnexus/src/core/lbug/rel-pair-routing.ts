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
 * mis-buckets or drops it). Unlike the legacy oracle, the router also rejects a
 * valid node-label pair absent from the relationship DDL. That distinction is
 * load-bearing: silently writing such a CSV lets COPY fail late and can drop an
 * otherwise valid edge during fallback. `splitRelCsvByLabelPair` is retained as
 * the differential oracle (the quote-in-id divergence is asserted explicitly).
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
import { NODE_TABLES } from 'gitnexus-shared';
import { findInCauseChain } from '../../lib/utils.js';

/** Injectable for tests (backpressure/error simulation), mirroring split. */
export type WriteStreamFactory = (filePath: string) => WriteStream;

/**
 * Every label LadybugDB has a node table for — the filter that decides whether
 * an edge is routable at all.
 *
 * ONE shared instance, deliberately. `RelPairRouter`, `GraphEmitSink` and
 * `PdgEmitSink` each used to build their own `new Set(NODE_TABLES)`; three
 * copies of the same immutable set are three chances to seed one of them from
 * a different source. Typed `ReadonlySet` because that — not `Object.freeze`,
 * which does not touch a Set's internal slots — is what actually stops a
 * consumer mutating the shared instance.
 *
 * Imported straight from `gitnexus-shared` rather than `./schema.js`: schema.ts
 * imports `parseRelationSchemaPairs` from this module, so the reverse import
 * would close a cycle.
 */
export const VALID_NODE_TABLES: ReadonlySet<string> = new Set<string>(NODE_TABLES);

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

/**
 * Classify one edge into its `From|To` pair key, or `undefined` when the edge
 * must be SKIPPED because an endpoint's label is not a real node table.
 *
 * THE single definition of "which pair does this edge belong to, and is it
 * routable at all". `RelPairRouter.route`, `GraphEmitSink.addRelationship`,
 * `PdgEmitSink.addRelationship` and the `structural-pair-coverage` corpus guard
 * each used to inline the same three lines (label both ends → drop if either
 * label is not a node table → join with `|`). The corpus guard's docblock said
 * it "mirrors `RelPairRouter.route`" — a mirror is a drift marker: change the
 * skip rule here and the guard would keep classifying by the old one, report
 * green, and let `analyze` abort on a pair it had already declared covered.
 *
 * HOT PATH — called once per edge (~1M on a large repo). Returns the key
 * string (which every caller needs anyway for its own Map lookup) rather than
 * a `{ pairKey, fromLabel, toLabel }` object or a tuple, so the success path
 * allocates nothing beyond what `getNodeLabel` already did. Callers that need
 * the two labels back — only when opening a new pair's CSV, once per pair —
 * decode the key with {@link splitRelPairKey}.
 */
export const relPairKeyFor = (
  fromId: string,
  toId: string,
  validTables: ReadonlySet<string>,
): string | undefined => {
  const fromLabel = getNodeLabel(fromId);
  const toLabel = getNodeLabel(toId);
  if (!validTables.has(fromLabel) || !validTables.has(toLabel)) return undefined;
  return `${fromLabel}|${toLabel}`;
};

/**
 * Decode a `From|To` pair key back into its two labels.
 *
 * Safe because `|` cannot occur inside a node label: every label is a
 * `NODE_TABLES` identifier (`[A-Za-z][A-Za-z0-9_]*`), so the FIRST `|` is
 * always the separator. That invariant was documented in one comment and
 * enforced nowhere while every consumer re-derived it with a bare
 * `key.split('|')`.
 *
 * DECODE ONLY — there is deliberately no matching `encode` helper. The key is
 * built once per edge inside {@link relPairKeyFor} (~1M edges on a large
 * repo), where a function call is a real regression risk; every decode site is
 * cold by construction (once per pair when its CSV is opened, or on the
 * throw path of {@link assertDeclaredPair}).
 */
export const splitRelPairKey = (key: string): readonly [from: string, to: string] => {
  const sep = key.indexOf('|');
  return sep < 0 ? [key, ''] : [key.slice(0, sep), key.slice(sep + 1)];
};

/**
 * Build a fresh matcher for the `FROM <label> TO <label>` clauses of a
 * relationship DDL. Capture group 1 is the FROM label, group 2 the TO label;
 * backticks quote schema labels and are not part of the graph label.
 *
 * THE SINGLE SOURCE OF TRUTH for that pattern. `parseRelationSchemaPairs`
 * below builds its pair set from it, and `test/unit/schema-pair-coverage.test.ts`
 * counts raw `FROM…TO` occurrences with it to catch a pair DUPLICATED in the
 * DDL (a duplicate makes LadybugDB reject `CREATE REL TABLE`, killing every
 * `analyze` — strictly worse than one missing pair). That guard used to inline
 * its own copy of the regex: the two matched identically, so it worked, but any
 * widening here (dotted identifiers, `IF NOT EXISTS`, a multi-target
 * `FROM x TO y, z` form) would have silently degraded it to the tautology
 * `declared.size === declared.size`. Consume this factory instead of
 * re-inlining a copy.
 *
 * A FACTORY, not a shared `RegExp`: a module-level `/g` regex carries
 * `lastIndex` between calls, so one consumer's `exec`/`test` would corrupt
 * everyone else's next match. Each call returns a private instance.
 */
export const createRelationPairMatcher = (): RegExp =>
  /\bFROM\s+`?([A-Za-z][A-Za-z0-9_]*)`?\s+TO\s+`?([A-Za-z][A-Za-z0-9_]*)`?/g;

/**
 * Extract the FROM→TO pairs accepted by a relationship DDL.
 *
 * This belongs at the routing boundary: schema.ts owns the DDL, while the CSV
 * router owns the fail-fast check that prevents writing a pair LadybugDB cannot
 * COPY.
 */
export const parseRelationSchemaPairs = (relationSchema: string): ReadonlySet<string> =>
  new Set(
    [...relationSchema.matchAll(createRelationPairMatcher())].map(
      (match) => `${match[1]}|${match[2]}`,
    ),
  );

export interface RelPairMeta {
  csvPath: string;
  rows: number;
}

/**
 * Best-effort source file for a graph node id.
 *
 * Node ids are `<Label>:<repo-relative path>:…` (`comm_*` / `proc_*` synthetic
 * ids carry no file). Repo-relative paths are POSIX-normalized and never carry
 * a drive letter, so the segment after the label is the file path. Returns
 * `undefined` rather than guessing when the id has no path segment — a wrong
 * file in a crash message is worse than none.
 */
const deriveNodeFilePath = (nodeId: string): string | undefined => {
  if (nodeId.startsWith('comm_') || nodeId.startsWith('proc_')) return undefined;
  const filePath = nodeId.split(':')[1];
  return filePath === undefined || filePath === '' ? undefined : filePath;
};

/** Where a user files the missing pair. Part of the message — see below. */
const UNDECLARED_PAIR_ISSUE_URL = 'https://github.com/abhigyanpatwari/GitNexus/issues/new';

/**
 * An edge whose endpoint-label pair is absent from the relationship DDL.
 *
 * Carries the context the emit call site already has — relationship type, both
 * node ids, and the source file derived from them — so a user whose `analyze`
 * just died mid-run can see WHICH of their files produced the edge and file a
 * bug report that names the missing pair. The abstract label pair alone is
 * unactionable outside GitNexus's own source (#2789).
 *
 * Classify by TYPE (`err instanceof UndeclaredRelationPairError`, or
 * {@link findUndeclaredRelationPairError} when the error may be wrapped in a
 * phase `cause` chain) — the repo norm from #2385 — never by message text.
 *
 * THE MESSAGE IS THE ONLY RENDERING. It carries the five context fields AND
 * the two actionable next steps (report the pair; `.gitnexusignore` the file to
 * finish the rest of the index), because `gitnexus serve` forwards nothing but
 * `err.message` over worker IPC — anything a consumer re-renders from the
 * structured fields instead is invisible to a serve-hosted user. The CLI
 * branch in `cli/analyze.ts` therefore prints this message indented and adds
 * only the machine-readable `cliError` fields, the same idiom `LbugWipeError`
 * uses there. It used to re-render the five fields with its own wording; the
 * two copies had already drifted on the pair separator, the no-file text and
 * the closing sentence within a single PR, and each had its own pinning test.
 */
export class UndeclaredRelationPairError extends Error {
  /** `From|To` label pair, exactly as keyed against the declared-pair set. */
  readonly pairKey: string;
  /** Relationship type of the edge that could not be routed (e.g. `CALLS`). */
  readonly relationType: string;
  readonly fromId: string;
  readonly toId: string;
  /** Source file derived from the node ids; `undefined` for synthetic ids. */
  readonly sourceFile: string | undefined;

  constructor(pairKey: string, relationType: string, fromId: string, toId: string) {
    const sourceFile = deriveNodeFilePath(fromId) ?? deriveNodeFilePath(toId);
    const [fromLabel, toLabel] = splitRelPairKey(pairKey);
    super(
      `GitNexus extracted a relationship its own database schema cannot store.\n` +
        `Relationship label pair ${fromLabel} → ${toLabel} is not declared in the ` +
        `LadybugDB relation schema.\n` +
        `  relationship type: ${relationType}\n` +
        `  from node:         ${fromId}\n` +
        `  to node:           ${toId}\n` +
        `  source file:       ${sourceFile ?? '(none — synthetic node id)'}\n` +
        `This is a gap in GitNexus's own relation schema, not a problem with the ` +
        `analyzed code, and re-running the analysis will fail in exactly the same place.\n` +
        `Suggestions:\n` +
        `  1. Report the missing pair so it can be declared:\n` +
        `       ${UNDECLARED_PAIR_ISSUE_URL}\n` +
        `     Include the label pair, the relationship type, and the source file above.\n` +
        `  2. To finish indexing the rest meanwhile, add that file (or its directory)\n` +
        `     to .gitnexusignore and re-run.`,
    );
    this.name = 'UndeclaredRelationPairError';
    this.pairKey = pairKey;
    this.relationType = relationType;
    this.fromId = fromId;
    this.toId = toId;
    this.sourceFile = sourceFile;
  }
}

/**
 * Find an {@link UndeclaredRelationPairError} in `err` or its `cause` chain.
 *
 * The guard throws deep inside an ingestion phase, and the phase runner rewraps
 * every phase failure as `new Error("Phase 'X' failed: …", { cause })` — so a
 * bare `instanceof` at the CLI boundary would miss it and fall through to the
 * generic stack dump.
 *
 * The traversal and its depth bound come from `lib/utils.ts` rather than being
 * re-rolled here: this was the fourth hand-written copy in the repo and the
 * only one that used `depth <= MAX` (six levels) while claiming to mirror
 * `cli/analyze.ts`'s `depth < 5`.
 */
export const findUndeclaredRelationPairError = (
  err: unknown,
): UndeclaredRelationPairError | undefined =>
  findInCauseChain(
    err,
    (e): e is UndeclaredRelationPairError => e instanceof UndeclaredRelationPairError,
  );

/**
 * Fail fast on an endpoint-label pair absent from the relationship DDL, the
 * same guard `RelPairRouter.route` applies to the whole-graph emit. Exported
 * so the streamed sinks (`GraphEmitSink`, `PdgEmitSink`) can apply it too —
 * without this, an undeclared pair on a streaming run reaches `COPY`, fails
 * the bulk insert, and is silently dropped by the per-edge fallback instead
 * of failing loudly like the non-streaming path does.
 *
 * Takes the already-built `From|To` pairKey (from {@link relPairKeyFor})
 * rather than the two labels — every caller needs that same key immediately
 * after for its own Map/stream lookup, and this is on the per-edge hot path,
 * so building it twice would be a needless allocation per edge. The error
 * splits it back apart with {@link splitRelPairKey}, which only the throw path
 * reaches. The edge context is passed POSITIONALLY for the same reason: a
 * `{ relationType, fromId, toId }` context object would allocate on every
 * edge, including the ~1M that never fail.
 *
 * The success path must stay allocation-free: no object literal, no template
 * string, no closure, no `Error` constructed before the failure branch.
 */
export const assertDeclaredPair = (
  pairKey: string,
  declaredPairs: ReadonlySet<string>,
  relationType: string,
  fromId: string,
  toId: string,
): void => {
  if (!declaredPairs.has(pairKey)) {
    throw new UndeclaredRelationPairError(pairKey, relationType, fromId, toId);
  }
};

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
    private readonly validTables: ReadonlySet<string>,
    private readonly declaredPairs: ReadonlySet<string>,
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
   *
   * `relType` is not used for routing — it is carried purely so an undeclared
   * pair can name the offending relationship in its error (the row is already
   * CSV-escaped by then, so the type is not recoverable from it).
   */
  route(fromId: string, toId: string, row: string, relType: string): void | Promise<void> {
    if (this.streamError) throw this.streamError;

    const pairKey = relPairKeyFor(fromId, toId, this.validTables);
    if (pairKey === undefined) {
      this.skipped++;
      return;
    }

    assertDeclaredPair(pairKey, this.declaredPairs, relType, fromId, toId);
    const ws = this.streams.get(pairKey);
    if (ws === undefined) {
      // First edge for this pair: open the stream, write header + row.
      return this.openAndWrite(pairKey, row);
    }

    this.byPair.get(pairKey)!.rows++;
    this.total++;
    if (!ws.write(row + '\n')) {
      return once(ws, 'drain', { signal: this.abort.signal }).then(() => undefined);
    }
  }

  /** Cold: runs once per pair, so decoding the key back is free here. */
  private async openAndWrite(pairKey: string, row: string): Promise<void> {
    const [fromLabel, toLabel] = splitRelPairKey(pairKey);
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

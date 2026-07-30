/**
 * Receiver-resolution measurement harness.
 *
 * Answers one question — "how many method calls does GitNexus lose because it
 * could not establish the receiver's type, and which source shapes are they?" —
 * and answers it in a way that can gate a decision.
 *
 * TWO ARMS, because neither one alone is trustworthy:
 *
 *  1. SHAPE ARM (`--shapes`, default). A fixed corpus of receiver spellings,
 *     each classified by what the graph actually contains:
 *
 *       RESOLVES       edge emitted. A test written against this shape starts
 *                      green and proves nothing. Note this states only that an
 *                      edge EXISTS — not that it points at the right target. A
 *                      name-keyed fallback onto a same-named member reads as
 *                      RESOLVES here, so a shape whose receiver has no
 *                      well-defined type is not a usable control.
 *       VISIBLE-GAP    no edge, and a `receiver-unresolved` drop was recorded.
 *                      Measurable by the count arm below.
 *       INVISIBLE-GAP  no edge, and NO drop was recorded. The call is lost and
 *                      the instrument cannot see it.
 *
 *     The third state is why this arm exists. Case 0's recorder is reached only
 *     when the receiver text contains `.` or `(` AND the capture layer produced
 *     a reference site at all. Measured on this corpus, `svc?.getUser().save()`,
 *     `svc.getTyped<User>().save()` and `repos[0].save()` are all INVISIBLE —
 *     so fixing them moves the count arm by exactly zero. Gating solely on a
 *     drop count would read a working fix as "no improvement".
 *
 *  2. COUNT ARM (`--corpus <repoPath>`). Runs the real pipeline over a repo and
 *     reports drops SPLIT BY SITE KIND. The gate number is `call` only: the
 *     recorder's gate tests the receiver's punctuation, not the site's kind, so
 *     property reads (`d.source.kind`) and writes (`x.argtypes = [...]`) land in
 *     the same bucket as lost method calls and would inflate it.
 *
 * KNOWN BLIND SPOTS — reported in every run, deliberately, because the number
 * is a lower bound on a KNOWN-BIASED population and any delta measured later
 * must be read against the same bias:
 *
 *   - Case 0's gate is a C-family punctuation test, so PHP `$this->repo->save()`
 *     and `::` receivers never record a drop.
 *   - `repos[0].save()` has neither `.` nor `(` in its receiver, same result.
 *   - `?.` and explicit type arguments produce no reference site to begin with.
 *
 * MEASUREMENT HYGIENE — a run that skips this is void:
 *
 *   npm run build                       # the parse worker runs from dist/
 *   rm -rf .gitnexus/parse-cache .gitnexus/parsedfile-cache
 *   node --import tsx bench/receiver-resolution/measure.mjs --corpus <repo>
 *
 * `analyze --force` clears NEITHER cache, so a stale shard will happily serve
 * the previous capture set and produce a confident, wrong number.
 *
 * Usage:
 *   node --import tsx bench/receiver-resolution/measure.mjs
 *   node --import tsx bench/receiver-resolution/measure.mjs --corpus /path/to/repo
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { runPipelineFromRepo } from '../../src/core/ingestion/pipeline.ts';
import { emitTsScopeCaptures } from '../../src/core/ingestion/languages/typescript/index.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BASELINE_PATH = path.resolve(__dirname, 'baseline.json');
/** The `--check` corpus. Committed and multi-language, so the gate is
 *  deterministic and does not depend on anything outside the repo. */
const DEFAULT_CORPUS = path.resolve(__dirname, '..', '..', 'test', 'fixtures', 'lang-resolution');

// ---------------------------------------------------------------------------
// Shape corpus
// ---------------------------------------------------------------------------

/**
 * Each entry is one receiver spelling. `entry` is the function that contains
 * it; `member` is the method it should reach. Classification asks only two
 * questions of the result — is there a CALLS edge from `entry` to `member`,
 * and was a drop recorded on that line — so it never guesses from an id shape.
 */
const CORPORA = [
  {
    lang: 'typescript',
    ext: '.ts',
    support: {
      'models.ts': `export class Address {
  save(): void {}
}

export class User {
  name: string = '';
  address: Address = new Address();
  save(): void {}
}

export class Service {
  getUser(): User {
    return new User();
  }
  async getUserAsync(): Promise<User> {
    return new User();
  }
  getTyped<T>(): User {
    return new User();
  }
}
`,
    },
    header: `import { Service, User } from './models';\n`,
    wrap: (entry, body) =>
      `export async function ${entry}(svc: Service, repos: User[]): Promise<void> {\n  ${body}\n}\n`,
    shapes: [
      { id: 'plainChain', member: 'save', body: 'svc.getUser().save();', note: 'control' },
      {
        id: 'plainDeepChain',
        member: 'save',
        body: 'svc.getUser().address.save();',
        note: 'control',
      },
      { id: 'optionalChain', member: 'save', body: 'svc?.getUser().save();', note: 'PF1' },
      { id: 'nonNullAssert', member: 'save', body: 'svc!.getUser().save();', note: 'PF2' },
      {
        id: 'awaitParen',
        member: 'save',
        body: '(await svc.getUserAsync()).save();',
        note: 'PF3',
      },
      { id: 'explicitTypeArgs', member: 'save', body: 'svc.getTyped<User>().save();', note: 'PF4' },
      { id: 'indexElement', member: 'save', body: 'repos[0].save();', note: 'PF5' },
    ],
  },
  {
    lang: 'php',
    ext: '.php',
    support: {
      'models.php': `<?php
class User {
    public function save() {}
}

class Service {
    public function getUser() {
        return new User();
    }
}
`,
    },
    header: `<?php\nrequire_once 'models.php';\n`,
    // TYPED parameter. An untyped `$svc` has no type binding to resolve the
    // chain's base against, which would make this row report a language gap
    // that is really a fixture defect.
    wrap: (entry, body) => `function ${entry}(Service $svc) {\n    ${body}\n}\n`,
    shapes: [
      {
        id: 'arrowCallChain',
        member: 'save',
        body: '$svc->getUser()->save();',
        note: 'PF6 — recorded, because the receiver text contains `(`',
      },
      {
        // The discriminating control for KTD6 defect 2. This receiver
        // (`$this->repo`) contains neither `.` nor `(`, so Case 0's gate never
        // fires and the drop is never recorded — while the call chain above IS
        // recorded. "PHP records no drops" is too coarse: it is the
        // property-path receiver that is invisible, not the language.
        id: 'arrowPropertyPath',
        member: 'save',
        body: '$this->repo->save();',
        raw: `class Holder {
    public User $repo;
    public function arrowPropertyPath() {
        $this->repo->save();
    }
}
`,
        note: 'PF6-control — property-path receiver, no `.` and no `(`',
      },
    ],
  },
  {
    lang: 'cpp',
    ext: '.cpp',
    support: {
      'models.h': `#pragma once

class User {
public:
    void save();
};

class Service {
public:
    User* getUser();
};
`,
    },
    header: `#include "models.h"\n`,
    wrap: (entry, body) => `void ${entry}(Service* svc, Service svc2) {\n    ${body}\n}\n`,
    shapes: [
      {
        id: 'pointerArrowChain',
        member: 'save',
        body: 'svc->getUser()->save();',
        note: 'PF7 — no fixture exists today; cpp-chain-call/ uses value `.`',
      },
      {
        // The discriminating control for PF7. Same chain, same `->save()` tail,
        // but a value `.` on the BASE receiver — and it resolves. So the defect
        // is the `->` base specifically, not C++ chaining, and the existing
        // `cpp-chain-call/` fixture cannot catch it because it uses this form.
        id: 'valueDotChain',
        member: 'save',
        body: 'svc2.getUser()->save();',
        note: 'PF7-control — value `.` base resolves',
      },
    ],
  },
];

function classify(corpus, result) {
  const calls = [];
  for (const rel of result.graph.iterRelationships()) {
    if (rel.type !== 'CALLS') continue;
    calls.push({
      from: result.graph.getNode(rel.sourceId)?.properties.name ?? '',
      to: result.graph.getNode(rel.targetId)?.properties.name ?? '',
    });
  }
  const drops = (result.resolutionOutcomes ?? []).filter(
    (outcome) => outcome.kind === 'suppressed' && outcome.reason === 'receiver-unresolved',
  );

  return corpus.shapes.map((shape) => {
    const hasEdge = calls.some((call) => call.from === shape.id && call.to === shape.member);
    // A drop belongs to this shape when it names the shape's member and sits on
    // the shape's own line — matched on the generated source, not on an id.
    const drop = drops.find(
      (candidate) => candidate.name === shape.member && candidate.shapeId === shape.id,
    );
    return {
      shape: shape.body,
      id: shape.id,
      note: shape.note,
      state: hasEdge ? 'RESOLVES' : drop ? 'VISIBLE-GAP' : 'INVISIBLE-GAP',
      siteKind: drop?.siteKind ?? null,
    };
  });
}

async function runShapeArm() {
  const results = [];
  for (const corpus of CORPORA) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), `gn-recv-${corpus.lang}-`));
    try {
      for (const [rel, content] of Object.entries(corpus.support)) {
        fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
        fs.writeFileSync(path.join(root, rel), content, 'utf8');
      }
      // Each shape's statement gets its own line, so a recorded drop's line
      // identifies which shape produced it without matching on an id.
      const lineOfShape = new Map();
      let text = corpus.header;
      for (const shape of corpus.shapes) {
        // A shape whose receiver needs surrounding structure (a class with a
        // property, say) supplies `raw`; everything else is wrapped in a plain
        // function. Either way the statement itself is `body`, and its offset
        // is found by locating it in the generated block.
        const block = shape.raw ?? corpus.wrap(shape.id, shape.body);
        const blockStartLine = text.split('\n').length;
        const offset = block.split('\n').findIndex((line) => line.includes(shape.body));
        lineOfShape.set(shape.id, blockStartLine + offset);
        text += block;
      }
      fs.writeFileSync(path.join(root, `main${corpus.ext}`), text, 'utf8');

      const result = await runPipelineFromRepo(root, () => {});
      // Attach the owning shape to each drop by line before classifying.
      for (const outcome of result.resolutionOutcomes ?? []) {
        for (const [id, line] of lineOfShape) {
          if (outcome.range?.startLine === line) outcome.shapeId = id;
        }
      }
      results.push({ language: corpus.lang, shapes: classify(corpus, result) });
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }
  return results;
}

// ---------------------------------------------------------------------------
// Count arm
// ---------------------------------------------------------------------------

async function runCountArm(repoPath) {
  const result = await runPipelineFromRepo(repoPath, () => {});
  const drops = (result.resolutionOutcomes ?? []).filter(
    (outcome) => outcome.kind === 'suppressed' && outcome.reason === 'receiver-unresolved',
  );

  const byKind = new Map();
  const byExtension = new Map();
  const callDropsByExtension = new Map();
  for (const drop of drops) {
    const kind = drop.siteKind ?? '<<unset>>';
    byKind.set(kind, (byKind.get(kind) ?? 0) + 1);
    const ext = path.extname(drop.filePath);
    byExtension.set(ext, (byExtension.get(ext) ?? 0) + 1);
    if (kind === 'call') callDropsByExtension.set(ext, (callDropsByExtension.get(ext) ?? 0) + 1);
  }

  const sortDesc = (map) => Object.fromEntries([...map.entries()].sort((a, b) => b[1] - a[1]));
  return {
    repo: repoPath,
    // THE gate number. Property reads and writes are excluded deliberately.
    callDrops: byKind.get('call') ?? 0,
    totalDropsAllKinds: drops.length,
    bySiteKind: sortDesc(byKind),
    callDropsByExtension: sortDesc(callDropsByExtension),
    allDropsByExtension: sortDesc(byExtension),
  };
}

// ---------------------------------------------------------------------------
// Perf arm — the U7 thresholds
// ---------------------------------------------------------------------------

/**
 * Wall-clock, peak RSS, persisted chain bytes and cache-dir growth for one
 * pipeline run over a corpus.
 *
 * The A/B control is produced by reverting ONLY the fold wiring
 * (`compound-receiver.ts` + `receiver-bound-calls.ts`) to the pre-U10 commit and
 * rebuilding, so the capture emission — and therefore the persisted bytes — is
 * identical in both arms and the delta isolates the fold itself.
 */
/** Every file under `root` with one of `exts`. */
function walkFiles(root, exts) {
  const out = [];
  const stack = [root];
  while (stack.length > 0) {
    const dir = stack.pop();
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) stack.push(full);
      else if (exts.some((e) => entry.name.endsWith(e))) out.push(full);
    }
  }
  return out;
}

async function runPerfArm(repoPath, reps) {
  const timings = [];
  let peakRss = 0;
  let chainSites = 0;
  let chainBytes = 0;
  let referenceSites = 0;

  for (let i = 0; i < reps; i++) {
    const started = process.hrtime.bigint();
    const result = await runPipelineFromRepo(repoPath, () => {});
    timings.push(Number(process.hrtime.bigint() - started) / 1e6);
    peakRss = Math.max(peakRss, process.memoryUsage().rss);

    void result;
  }

  // Persisted chain payload, counted from the emitter rather than from the
  // pipeline result: `PipelineResult` exposes no ParsedFiles, and the emitter is
  // the side that decides what gets written, so this is the authoritative count.
  for (const file of walkFiles(repoPath, ['.ts', '.tsx'])) {
    const src = fs.readFileSync(file, 'utf8');
    for (const match of emitTsScopeCaptures(src, path.relative(repoPath, file))) {
      if (match['@reference.name'] === undefined) continue;
      referenceSites++;
      const chain = match['@reference.receiver-chain'];
      if (chain === undefined) continue;
      chainSites++;
      chainBytes += Buffer.byteLength(chain.text, 'utf8');
    }
  }

  timings.sort((a, b) => a - b);
  const median = timings[Math.floor(timings.length / 2)];
  return {
    reps,
    wallClockMsMedian: +median.toFixed(1),
    wallClockMsAll: timings.map((t) => +t.toFixed(1)),
    peakRssBytes: peakRss,
    referenceSites,
    chainSites,
    chainBytes,
    bytesPerChainSite: chainSites === 0 ? 0 : +(chainBytes / chainSites).toFixed(1),
  };
}

// ---------------------------------------------------------------------------

const KNOWN_BLIND = [
  "Case 0's gate is a C-family punctuation test (`.` or `(`), so PHP `->` and `::` receivers record no drop.",
  '`repos[0].save()` has neither `.` nor `(` in its receiver — same result.',
  '`?.` and explicit type arguments produce no reference site at all, so no drop is recorded.',
  'Every count is therefore a LOWER BOUND on a known-biased population. A later delta must be read against the same bias.',
];

/**
 * The gated projection: shape states per language, plus the call-drop counts.
 * Deliberately EXACT rather than budgeted — two consecutive runs are
 * byte-identical, so a range would only hide real movement. Adding fixtures
 * moves these numbers and requires a rebaseline; that treadmill is the accepted
 * cost of the guard, the same trade the scope-capture bench already makes.
 */
/**
 * NOTE ON SCOPE: this is the GATED projection — shape states plus call-drop
 * counts. The perf arm (`--perf N`: wall-clock, RSS, bytes/site) is deliberately
 * NOT part of it: those measurements need an A/B against a control build, which
 * `--check` has no way to construct, so asserting them here would compare against
 * numbers from a different machine and fail on noise. The perf figures recorded in
 * BASELINE.md are therefore a POINT-IN-TIME MEASUREMENT, not a CI guard — do not
 * read a green `--check` as evidence that performance has not regressed.
 */
function projection(output) {
  return {
    shapeArm: Object.fromEntries(
      output.shapeArm.map((corpus) => [
        corpus.language,
        Object.fromEntries(corpus.shapes.map((shape) => [shape.id, shape.state])),
      ]),
    ),
    countArm: {
      callDrops: output.countArm.callDrops,
      totalDropsAllKinds: output.countArm.totalDropsAllKinds,
      bySiteKind: output.countArm.bySiteKind,
      callDropsByExtension: output.countArm.callDropsByExtension,
    },
  };
}

/** Every leaf whose value differs, as `dotted.path: expected -> actual`. */
function drift(expected, actual, prefix = '') {
  const out = [];
  const keys = new Set([...Object.keys(expected ?? {}), ...Object.keys(actual ?? {})]);
  for (const key of keys) {
    const want = expected?.[key];
    const got = actual?.[key];
    const at = prefix === '' ? key : `${prefix}.${key}`;
    if (want !== null && typeof want === 'object') out.push(...drift(want, got ?? {}, at));
    else if (want !== got) out.push(`${at}: ${JSON.stringify(want)} -> ${JSON.stringify(got)}`);
  }
  return out;
}

const args = process.argv.slice(2);
const corpusIndex = args.indexOf('--corpus');
const check = args.includes('--check');
const corpusPath =
  corpusIndex === -1 ? (check ? DEFAULT_CORPUS : undefined) : path.resolve(args[corpusIndex + 1]);

const output = { knownBlind: KNOWN_BLIND };
if (corpusPath === undefined || check || args.includes('--shapes')) {
  output.shapeArm = await runShapeArm();
}
if (corpusPath !== undefined) {
  output.countArm = await runCountArm(corpusPath);
}
const perfIndex = args.indexOf('--perf');
if (perfIndex !== -1) {
  const reps = Number(args[perfIndex + 1] ?? '3');
  output.perfArm = await runPerfArm(corpusPath ?? DEFAULT_CORPUS, Number.isFinite(reps) ? reps : 3);
}

if (args.includes('--update-baseline')) {
  fs.writeFileSync(BASELINE_PATH, `${JSON.stringify(projection(output), null, 2)}\n`, 'utf8');
  console.error(`[receiver-resolution] wrote ${BASELINE_PATH}`);
} else if (check) {
  const expected = JSON.parse(fs.readFileSync(BASELINE_PATH, 'utf8'));
  const diffs = drift(expected, projection(output));
  if (diffs.length > 0) {
    console.error('[receiver-resolution] FAIL — drift against the committed baseline:');
    for (const line of diffs) console.error(`  ${line}`);
    console.error(
      '\nIf this is intended (a fixture was added, or a shape genuinely changed state),' +
        '\nre-run with --update-baseline and explain the movement in the commit message.',
    );
    process.exit(1);
  }
  console.error('[receiver-resolution] OK — shape states and call-drop counts match baseline.');
} else {
  console.log(JSON.stringify(output, null, 2));
}

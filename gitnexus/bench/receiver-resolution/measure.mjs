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

import { runPipelineFromRepo } from '../../src/core/ingestion/pipeline.ts';

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
    wrap: (entry, body) => `function ${entry}($svc) {\n    ${body}\n}\n`,
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

const KNOWN_BLIND = [
  "Case 0's gate is a C-family punctuation test (`.` or `(`), so PHP `->` and `::` receivers record no drop.",
  '`repos[0].save()` has neither `.` nor `(` in its receiver — same result.',
  '`?.` and explicit type arguments produce no reference site at all, so no drop is recorded.',
  'Every count is therefore a LOWER BOUND on a known-biased population. A later delta must be read against the same bias.',
];

const args = process.argv.slice(2);
const corpusIndex = args.indexOf('--corpus');
const corpusPath = corpusIndex === -1 ? undefined : args[corpusIndex + 1];

const output = { knownBlind: KNOWN_BLIND };
if (corpusPath === undefined || args.includes('--shapes')) {
  output.shapeArm = await runShapeArm();
}
if (corpusPath !== undefined) {
  output.countArm = await runCountArm(path.resolve(corpusPath));
}
console.log(JSON.stringify(output, null, 2));

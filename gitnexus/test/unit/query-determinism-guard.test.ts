/**
 * #2787 structural guard — a Cypher `LIMIT` must DECLARE its determinism.
 *
 * LadybugDB/Kuzu returns an ARBITRARY, per-process-varying row subset when a
 * query carries `LIMIT` without `ORDER BY`. #2787 swept ~20 such queries, but a
 * sweep does not stop the 21st: the only surviving guard was one runtime test
 * that captured emitted SQL on a single tool path.
 *
 * "Is this `LIMIT` a sampling window or a probe?" cannot be INFERRED from the
 * text — a `LIMIT 1` on a primary-key anchor is provably single-row, and a
 * `LIMIT 30` on a fan-out is a silent lottery, and they look identical. So this
 * gate does not infer. It makes the author DECLARE, once, at the call site:
 *
 *   1. ORDER the query — the literal contains `ORDER BY`, or interpolates a
 *      constant/helper that does (e.g. `${DETERMINISTIC_RELATIONSHIP_ORDER}` in
 *      `mcp/local/aop-metadata.ts`, which a naive text scan would miss); or
 *   2. DECLARE it a probe — an adjacent comment in the canonical form
 *
 *        // determinism: probe — <why row identity cannot vary>
 *
 *      The reason is mandatory and validated (>= 20 chars, >= 3 words): an
 *      empty or one-word marker fails exactly like an undeclared query.
 *
 * There is deliberately NO allowlist file. A hand-maintained list drifts from
 * the code and puts the justification somewhere the next author will not read;
 * the declaration lives beside the query it defends.
 *
 * ── How the two known false verdicts are avoided ──────────────────────────
 *
 * FALSE NEGATIVE (interpolated ordering): the scan is AST-based, so a
 * `TemplateExpression` is taken WHOLE (`${...}` included) and every interpolated
 * identifier is resolved against the file's own string constants / helper
 * functions, transitively. `${DETERMINISTIC_RELATIONSHIP_ORDER}` counts as
 * ordered without the constant's text appearing in the query literal.
 *
 * FALSE POSITIVE (prose): comments and JSDoc are not literal nodes, so prose
 * like "the page is `LIMIT`-bounded" (several places in `mcp/local/`) is never
 * a query. Same for `LIMIT` inside a regex literal (`cobol-preprocessor.ts`)
 * and inside identifiers (`LIST_REPOS_MAX_LIMIT` — `\bLIMIT\b` needs a word
 * boundary, and `_` is a word character).
 *
 * Also handled: interpolated limits (`LIMIT ${rowCap}`), multi-line template
 * literals, and `+`-concatenated queries (the concatenation is one unit, so an
 * `ORDER BY` in an earlier fragment still counts).
 *
 * Prior art for this source-scanning shape: `local-backend-maxbuffer.test.ts`
 * and `detect-changes-local-id-stability.test.ts`.
 */
import { describe, expect, it } from 'vitest';
import ts from 'typescript';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC_DIR = fileURLToPath(new URL('../../src/', import.meta.url));

/**
 * Subtrees skipped by the scan. `core/ingestion/**` is 574 of `src/`'s 786
 * files (6.3 of 9.8 MB) and issues NO Cypher at all — it builds an in-memory
 * `KnowledgeGraph` and hands it to the persistence layer; its single `MATCH (`
 * hit (`mro-processor.ts`) is a doc comment. Reading it would roughly quadruple
 * this gate's cost for zero coverage. If a Cypher call site is ever added under
 * `core/ingestion/`, delete its entry here.
 */
const SKIPPED_SUBTREES = ['core/ingestion'];

/** The canonical marker, quoted back to the author in every failure message. */
const MARKER_TEMPLATE = '// determinism: probe — <why row identity cannot vary>';

/**
 * `determinism: probe` + a separator + a reason. The separator is permissive
 * (em dash / en dash / hyphen / colon) so the gate never fails on punctuation;
 * the REASON is what is actually enforced.
 */
const MARKER_RE = /determinism:\s*probe\s*(?:[—–:-]\s*)?(.*)$/;
const MIN_REASON_CHARS = 20;
const MIN_REASON_WORDS = 3;

const LIMIT_RE = /\bLIMIT\b/;
const ORDER_BY_RE = /\bORDER\s+BY\b/;
/**
 * A literal counts as Cypher when it carries a clause keyword alongside the
 * `LIMIT`, or when it IS a bare `LIMIT` clause fragment (the shape a query
 * assembled from pieces would take).
 */
const CYPHER_CLAUSE_RE =
  /\b(?:MATCH|RETURN|UNWIND|MERGE|CREATE|DELETE|DETACH|REMOVE|CALL|WHERE|SKIP|ORDER\s+BY)\b/;
const BARE_LIMIT_FRAGMENT_RE = /^[`'"\s]*LIMIT\b/;

type Verdict =
  | 'ordered'
  | 'ordered-via-interpolation'
  | 'declared-probe'
  | 'marker-without-reason'
  | 'marker-already-claimed'
  | 'undeclared';

interface QueryFinding {
  file: string;
  line: number;
  verdict: Verdict;
  /** Whitespace-collapsed excerpt of the query, for the failure message. */
  excerpt: string;
  /** The declared reason, when a marker was found (valid or not). */
  reason?: string;
  /** Ordering constants/helpers the query interpolates, when ordered that way. */
  orderedVia?: string[];
}

// ---------------------------------------------------------------------------
// Scan surface
// ---------------------------------------------------------------------------
function walkTs(dir: string, relBase: string, out: string[]): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const rel = relBase === '' ? entry.name : `${relBase}/${entry.name}`;
    if (entry.isDirectory()) {
      if (!SKIPPED_SUBTREES.includes(rel)) walkTs(path.join(dir, entry.name), rel, out);
      continue;
    }
    const isSource =
      entry.name.endsWith('.ts') &&
      !entry.name.endsWith('.d.ts') &&
      !entry.name.endsWith('.test.ts');
    if (isSource) out.push(rel);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Ordering constants — the interpolated-`ORDER BY` false negative
// ---------------------------------------------------------------------------
/**
 * Names bound, in THIS file, to something whose source text contains `ORDER BY`
 * — string constants (`DETERMINISTIC_RELATIONSHIP_ORDER`), query-builder
 * helpers (`seedBlockQuery`, `buildFtsQueryCypher`), and anything built from
 * those. Resolved to a fixpoint so an ordering constant can be composed.
 */
function collectOrderingNames(sf: ts.SourceFile): Set<string> {
  const initializers = new Map<string, string>();
  const visit = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
      initializers.set(node.name.text, node.initializer.getText(sf));
    }
    if (ts.isFunctionDeclaration(node) && node.name !== undefined) {
      initializers.set(node.name.text, node.getText(sf));
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);

  const ordering = new Set<string>();
  const referencesOrdering = (text: string): boolean =>
    [...ordering].some((name) => new RegExp(`\\b${name}\\b`).test(text));

  // Bounded fixpoint: each pass can only add names, so it settles in <= size.
  for (let pass = 0; pass <= initializers.size; pass++) {
    const grown = [...initializers].filter(
      ([name, text]) => !ordering.has(name) && (ORDER_BY_RE.test(text) || referencesOrdering(text)),
    );
    grown.forEach(([name]) => ordering.add(name));
    if (grown.length === 0) break;
  }
  return ordering;
}

// ---------------------------------------------------------------------------
// Query units
// ---------------------------------------------------------------------------
const isLiteralUnit = (node: ts.Node): boolean =>
  ts.isStringLiteralLike(node) || ts.isTemplateExpression(node);

/** Climb `+` concatenation so a query split across fragments is ONE unit. */
function concatenationRoot(node: ts.Node): ts.Node {
  let current = node;
  while (
    current.parent !== undefined &&
    ts.isBinaryExpression(current.parent) &&
    current.parent.operatorToken.kind === ts.SyntaxKind.PlusToken
  ) {
    current = current.parent;
  }
  return current;
}

function collectQueryUnits(sf: ts.SourceFile): ts.Node[] {
  const byPosition = new Map<number, ts.Node>();
  const visit = (node: ts.Node): void => {
    if (!isLiteralUnit(node)) {
      ts.forEachChild(node, visit);
      return;
    }
    // Never descend INTO a literal: a nested template inside `${...}` is
    // already covered by the outer unit's text.
    const unit = concatenationRoot(node);
    const text = unit.getText(sf);
    if (LIMIT_RE.test(text) && (CYPHER_CLAUSE_RE.test(text) || BARE_LIMIT_FRAGMENT_RE.test(text))) {
      byPosition.set(unit.getStart(sf), unit);
    }
  };
  visit(sf);
  return [...byPosition.entries()].sort((a, b) => a[0] - b[0]).map(([, node]) => node);
}

/** Identifiers appearing inside `${ ... }` holes of the unit's text. */
function interpolatedIdentifiers(text: string): string[] {
  return [...text.matchAll(/\$\{([^}]*)\}/g)].flatMap((hole) =>
    [...hole[1].matchAll(/[A-Za-z_$][A-Za-z0-9_$]*/g)].map((id) => id[0]),
  );
}

// ---------------------------------------------------------------------------
// Marker lookup
// ---------------------------------------------------------------------------
interface CommentBlock {
  pos: number;
  end: number;
}

const isFunctionLike = (node: ts.Node): boolean =>
  ts.isFunctionDeclaration(node) ||
  ts.isFunctionExpression(node) ||
  ts.isArrowFunction(node) ||
  ts.isMethodDeclaration(node) ||
  ts.isConstructorDeclaration(node) ||
  ts.isGetAccessorDeclaration(node) ||
  ts.isSetAccessorDeclaration(node);

/**
 * Comment blocks a marker for `node` may live in, NEAREST FIRST: the query's
 * own leading/trailing comments, then those of every ancestor out to the
 * enclosing function (exclusive) or the file top. That covers a comment above
 * the `const`, a trailing comment on the query's own line, a comment above a
 * multi-line call whose query argument starts several lines down, and a comment
 * above a wrapping `try`/`if`. It stops at the function boundary so a marker
 * cannot be read from a neighbouring declaration's docblock, and a block can
 * only ever satisfy ONE query (see `claimed`), so widening the search here
 * cannot make one marker cover several queries.
 *
 * Consecutive `//` lines arrive as one range EACH, so they are merged back into
 * a block: a reason may then wrap across lines and still fit `printWidth: 100`.
 */
function markerBlocks(source: string, node: ts.Node): CommentBlock[] {
  const nearestFirst: ts.CommentRange[] = [];
  const seen = new Set<number>();
  let current: ts.Node | undefined = node;
  for (let depth = 0; current !== undefined && depth < 20; depth++) {
    for (const range of [
      ...(ts.getLeadingCommentRanges(source, current.getFullStart()) ?? []),
      ...(ts.getTrailingCommentRanges(source, current.getEnd()) ?? []),
    ]) {
      if (!seen.has(range.pos)) {
        seen.add(range.pos);
        nearestFirst.push(range);
      }
    }
    const parent: ts.Node | undefined = current.parent;
    if (parent === undefined || isFunctionLike(parent) || ts.isSourceFile(parent)) break;
    current = parent;
  }

  // Merge runs of comments separated only by a single newline's worth of
  // whitespace, so `pos -> enclosing block` is well defined.
  const ordered = [...nearestFirst].sort((a, b) => a.pos - b.pos);
  const blockOf = new Map<number, CommentBlock>();
  let open: CommentBlock | undefined;
  for (const range of ordered) {
    const gap = open === undefined ? '' : source.slice(open.end, range.pos);
    if (open !== undefined && /^\s*$/.test(gap) && (gap.match(/\n/g) ?? []).length <= 1) {
      open.end = range.end;
    } else {
      open = { pos: range.pos, end: range.end };
    }
    blockOf.set(range.pos, open);
  }

  const blocks: CommentBlock[] = [];
  const emitted = new Set<number>();
  for (const range of nearestFirst) {
    const block = blockOf.get(range.pos);
    if (block !== undefined && !emitted.has(block.pos)) {
      emitted.add(block.pos);
      blocks.push(block);
    }
  }
  return blocks;
}

const stripCommentSyntax = (line: string): string =>
  line
    .replace(/^\s*(?:\/\/+|\/\*+|\*+)\s?/, '')
    .replace(/\*\/\s*$/, '')
    .trim();

/**
 * The declared reason inside a comment block, or null when it carries no
 * marker. The reason continues onto following comment lines and stops at the
 * first blank line or the next marker, so it can wrap.
 */
function readMarker(source: string, block: CommentBlock): string | null {
  const lines = source.slice(block.pos, block.end).split('\n').map(stripCommentSyntax);
  const index = lines.findIndex((line) => MARKER_RE.test(line));
  if (index === -1) return null;
  const head = MARKER_RE.exec(lines[index])?.[1] ?? '';
  const tail: string[] = [];
  for (const line of lines.slice(index + 1)) {
    if (line.length === 0 || MARKER_RE.test(line)) break;
    tail.push(line);
  }
  return [head, ...tail].join(' ').trim();
}

const reasonIsSubstantive = (reason: string): boolean =>
  reason.length >= MIN_REASON_CHARS &&
  reason.split(/\s+/).filter((word) => word.length > 0).length >= MIN_REASON_WORDS;

// ---------------------------------------------------------------------------
// Analysis
// ---------------------------------------------------------------------------
export function analyzeSource(file: string, source: string): QueryFinding[] {
  if (!LIMIT_RE.test(source)) return [];
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  const ordering = collectOrderingNames(sf);
  /** A marker declares ONE query: a claimed range cannot also cover the next. */
  const claimed = new Map<number, number>();

  return collectQueryUnits(sf).map((unit) => {
    const text = unit.getText(sf);
    const limitOffset = Math.max(text.search(LIMIT_RE), 0);
    const line = sf.getLineAndCharacterOfPosition(unit.getStart(sf) + limitOffset).line + 1;
    const excerpt = text.replace(/\s+/g, ' ').slice(0, 160);
    const base = { file, line, excerpt };

    if (ORDER_BY_RE.test(text)) return { ...base, verdict: 'ordered' as const };

    const orderedVia = interpolatedIdentifiers(text).filter((id) => ordering.has(id));
    if (orderedVia.length > 0) {
      return { ...base, verdict: 'ordered-via-interpolation' as const, orderedVia };
    }

    const withMarker = markerBlocks(source, unit)
      .map((block) => ({ block, reason: readMarker(source, block) }))
      .filter((candidate): candidate is { block: CommentBlock; reason: string } =>
        Boolean(candidate.reason !== null),
      );
    const free = withMarker.find((candidate) => !claimed.has(candidate.block.pos));
    if (free === undefined) {
      const stolen = withMarker[0];
      return stolen === undefined
        ? { ...base, verdict: 'undeclared' as const }
        : {
            ...base,
            verdict: 'marker-already-claimed' as const,
            reason: `already declares the query at line ${claimed.get(stolen.block.pos)}`,
          };
    }
    claimed.set(free.block.pos, line);
    return {
      ...base,
      verdict: reasonIsSubstantive(free.reason)
        ? ('declared-probe' as const)
        : ('marker-without-reason' as const),
      reason: free.reason,
    };
  });
}

const FAILING_VERDICTS: readonly Verdict[] = [
  'undeclared',
  'marker-without-reason',
  'marker-already-claimed',
];

const explain = (finding: QueryFinding): string =>
  [
    `${finding.file}:${finding.line}  [${finding.verdict}]`,
    `    ${finding.excerpt}`,
    finding.reason === undefined ? '' : `    declared reason: "${finding.reason}"`,
    `    fix A — add a deterministic ORDER BY (a total order: end with a primary key)`,
    `    fix B — declare it a probe:  ${MARKER_TEMPLATE}`,
  ]
    .filter((part) => part.length > 0)
    .join('\n');

// ---------------------------------------------------------------------------
// The scan
// ---------------------------------------------------------------------------
const SCANNED_FILES = walkTs(SRC_DIR, '', []).sort();
const FINDINGS = SCANNED_FILES.flatMap((rel) =>
  analyzeSource(`src/${rel}`, readFileSync(path.join(SRC_DIR, rel), 'utf8')),
);
const by = (verdict: Verdict): QueryFinding[] => FINDINGS.filter((f) => f.verdict === verdict);

describe('#2787 — every Cypher LIMIT in src/ is ordered or declared a probe', () => {
  it('has no LIMIT query that is neither ordered nor declared', () => {
    const offenders = FINDINGS.filter((f) => FAILING_VERDICTS.includes(f.verdict));
    expect(
      offenders.map(explain),
      'A `LIMIT` without `ORDER BY` lets LadybugDB return a different row subset ' +
        'per process (#2787). Either order the query, or declare why its row ' +
        'identity cannot vary.',
    ).toEqual([]);
  });

  it('scans a non-vacuous surface (a broken glob cannot make this gate pass)', () => {
    expect({
      files: SCANNED_FILES.length > 100,
      queries: FINDINGS.length > 40,
      ordered: by('ordered').length > 20,
    }).toEqual({ files: true, queries: true, ordered: true });
  });

  it('recognises ordering supplied by an interpolated constant', () => {
    // aop-metadata.ts builds four queries whose ORDER BY arrives via
    // `${DETERMINISTIC_RELATIONSHIP_ORDER}`; a text scan of the literal alone
    // reports them as unordered. This is the guard's first failure mode.
    expect(by('ordered-via-interpolation').length).toBeGreaterThan(0);
  });

  it('still requires every declared probe to carry a reason', () => {
    expect(by('marker-without-reason')).toEqual([]);
    expect(by('declared-probe').every((f) => reasonIsSubstantive(f.reason ?? ''))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// The guard's own behaviour, on synthetic sources
// ---------------------------------------------------------------------------
const verdictsOf = (source: string): Verdict[] =>
  analyzeSource('synthetic.ts', source).map((f) => f.verdict);

describe('#2787 guard behaviour', () => {
  it('flags an unordered LIMIT', () => {
    expect(verdictsOf('const q = `MATCH (n:Function) RETURN n.name LIMIT 10`;')).toEqual([
      'undeclared',
    ]);
  });

  it('flags an unordered interpolated LIMIT across a multi-line template', () => {
    expect(
      verdictsOf(
        'const q = `\n  MATCH (n)-[r:CodeRelation]->(m)\n  RETURN m.id AS id\n  LIMIT ${rowCap}\n`;',
      ),
    ).toEqual(['undeclared']);
  });

  it('accepts an inline ORDER BY', () => {
    expect(
      verdictsOf('const q = `MATCH (n) RETURN n.id AS id ORDER BY n.id LIMIT ${cap}`;'),
    ).toEqual(['ordered']);
  });

  it('accepts ordering that arrives through an interpolated constant', () => {
    expect(
      verdictsOf(
        [
          "const ORDER = 'ORDER BY sourceId, targetId';",
          'const q = `MATCH (a)-[r]->(b) RETURN a.id AS sourceId, b.id AS targetId ${ORDER} LIMIT 1001`;',
        ].join('\n'),
      ),
    ).toEqual(['ordered-via-interpolation']);
  });

  it('accepts ordering composed through a chain of constants', () => {
    expect(
      verdictsOf(
        [
          "const TIEBREAK = 'ORDER BY n.id';",
          'const TAIL = `${TIEBREAK} SKIP 0`;',
          'const q = `MATCH (n) RETURN n.id ${TAIL} LIMIT 5`;',
        ].join('\n'),
      ),
    ).toEqual(['ordered-via-interpolation']);
  });

  it('accepts a probe declared with a reason', () => {
    expect(
      verdictsOf(
        [
          '// determinism: probe — PK-anchored singleton: at most one node carries $uid.',
          'const q = `MATCH (n {id: $uid}) RETURN n.name AS name LIMIT 1`;',
        ].join('\n'),
      ),
    ).toEqual(['declared-probe']);
  });

  it('accepts a probe declared on the query line itself', () => {
    expect(
      verdictsOf(
        'const q = `MATCH (n) RETURN n LIMIT 1`; // determinism: probe — rows are drained and discarded; only throw-vs-return is read.',
      ),
    ).toEqual(['declared-probe']);
  });

  it('accepts a probe declared in a block comment', () => {
    expect(
      verdictsOf(
        [
          '/**',
          ' * determinism: probe — existence only; the projected value is discarded.',
          ' */',
          'const q = `MATCH (n:BasicBlock) RETURN n.id AS id LIMIT 1`;',
        ].join('\n'),
      ),
    ).toEqual(['declared-probe']);
  });

  it('accepts a reason that wraps across comment lines', () => {
    // `printWidth: 100` means a real reason rarely fits on the marker line.
    expect(
      verdictsOf(
        [
          '// determinism: probe — uniqueness',
          '// discriminator: row 0 is read only when exactly one row came back.',
          'const q = `MATCH (n) WHERE n.name = $name RETURN n.id AS uid LIMIT 2`;',
        ].join('\n'),
      ),
    ).toEqual(['declared-probe']);
  });

  it('stops the reason at a blank comment line, so padding cannot be borrowed', () => {
    expect(
      verdictsOf(
        [
          '// determinism: probe —',
          '//',
          '// Unrelated prose that must not be mistaken for the declared reason.',
          'const q = `MATCH (n) RETURN n.id LIMIT 1`;',
        ].join('\n'),
      ),
    ).toEqual(['marker-without-reason']);
  });

  it('does not let one marker cover two queries in the same statement', () => {
    expect(
      verdictsOf(
        [
          '// determinism: probe — PK-anchored singleton: at most one node carries $uid.',
          'const [a, b] = await Promise.all([',
          '  run(`MATCH (n {id: $uid}) RETURN n.name AS name LIMIT 1`),',
          '  run(`MATCH (m) RETURN m.name AS name LIMIT 30`),',
          ']);',
        ].join('\n'),
      ),
    ).toEqual(['declared-probe', 'marker-already-claimed']);
  });

  it('reads a marker above a wrapping try, but not one on a sibling statement', () => {
    const aboveTry = [
      'async function probe() {',
      '  // determinism: probe — existence only; the row is drained and discarded.',
      '  try {',
      '    const rows = await exec(`MATCH (n) RETURN n.id AS id LIMIT 1`);',
      '  } catch {}',
      '}',
    ].join('\n');
    const onSibling = [
      'async function probe() {',
      '  // determinism: probe — existence only; the row is drained and discarded.',
      '  let seen = false;',
      '  try {',
      '    const rows = await exec(`MATCH (n) RETURN n.id AS id LIMIT 1`);',
      '  } catch {}',
      '}',
    ].join('\n');
    expect({ aboveTry: verdictsOf(aboveTry), onSibling: verdictsOf(onSibling) }).toEqual({
      aboveTry: ['declared-probe'],
      onSibling: ['undeclared'],
    });
  });

  it('rejects an empty marker', () => {
    expect(
      verdictsOf(
        ['// determinism: probe —', 'const q = `MATCH (n) RETURN n.id LIMIT 1`;'].join('\n'),
      ),
    ).toEqual(['marker-without-reason']);
  });

  it('rejects a one-word marker', () => {
    expect(
      verdictsOf(
        ['// determinism: probe — probe', 'const q = `MATCH (n) RETURN n.id LIMIT 1`;'].join('\n'),
      ),
    ).toEqual(['marker-without-reason']);
  });

  it('does not let one marker cover two queries', () => {
    expect(
      verdictsOf(
        [
          '// determinism: probe — PK-anchored singleton: at most one node carries $uid.',
          'const a = `MATCH (n {id: $uid}) RETURN n.name AS name LIMIT 1`;',
          'const b = `MATCH (m) RETURN m.name AS name LIMIT 30`;',
        ].join('\n'),
      ),
    ).toEqual(['declared-probe', 'undeclared']);
  });

  it('never trips on `LIMIT` in prose, JSDoc, or a regex literal', () => {
    expect(
      verdictsOf(
        [
          '/** The page is `LIMIT`-bounded, so MATCH ... RETURN ... LIMIT 30 is safe. */',
          '// A bare LIMIT with no ORDER BY: MATCH (n) RETURN n LIMIT 3',
          'const SQL_CLAUSE_RE = /\\b(?:WHERE|ORDER|HAVING|LIMIT|OFFSET)\\b/;',
          'const MAX_LIMIT = 200;',
        ].join('\n'),
      ),
    ).toEqual([]);
  });

  it('treats a `+`-concatenated query as one unit', () => {
    expect(
      verdictsOf("const q = 'MATCH (n) RETURN n.id AS id ' + 'ORDER BY id ' + `LIMIT ${cap}`;"),
    ).toEqual(['ordered']);
  });
});

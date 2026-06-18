/**
 * Realized name-collision probe for the PDG-impact statement-precise bridge.
 *
 * The bridge labels a callgraph-reached callee "proven" (callgraph-bridge) iff its
 * LEAF NAME appears in the changed line's dependence-slice block callees
 * (`pdgBridgeEvidenceForImpact`, pdg-impact.ts). Because the match is by name, two
 * distinct reached symbols that share a leaf name (e.g. two `get`s) are BOTH proven
 * whenever that name is in the slice — but the slice's call site(s) resolve to a
 * specific subset, so the extras are over-attribution (false-proven). This is the
 * documented "conservative SUPERSET" caveat (pdg-impact.ts:1352).
 *
 * This probe QUANTIFIES that over-attribution on real code, to decide whether a
 * sound resolved-symbol-id bridge is worth building.
 *
 * Key property that makes an index-only measurement rigorous: a collision
 * false-positive is ALWAYS a name-ambiguous proven label. To be proven a symbol
 * must first be reached, so every same-name over-attribution surfaces as >=2
 * DISTINCT proven symbol-ids sharing one leaf name. Counting those is therefore
 * COMPLETE for collision-FP. It is an UPPER BOUND (a slice could legitimately call
 * two same-named callees on different lines, in which case both proven labels are
 * correct), so the realized FP is in [0, ambiguous]. A near-zero result is a
 * decisive no-go; a material result motivates the exact line-join confirmation
 * (which needs a re-run that captures per-call-site resolved ids — the persisted
 * CALLS edge has no call-site line, BasicBlock.callees is a deduped leaf-name set).
 *
 * Focus is DEPTH 1: name-matching only fires at the first hop; deeper proven labels
 * are inherited from their depth-1 ancestor (betterBridgeEvidence), a different
 * (transitive) imprecision, not name collision.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { median, parseMarkdownRows } from './blast-radius.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');

function round(value, digits = 3) {
  if (value === null || value === undefined || Number.isNaN(value)) return null;
  const scale = 10 ** digits;
  return Math.round(value * scale) / scale;
}

function readOption(argv, name, fallback = undefined) {
  const eq = argv.find((arg) => arg.startsWith(`--${name}=`));
  if (eq) return eq.slice(name.length + 3);
  const idx = argv.indexOf(`--${name}`);
  if (idx >= 0 && idx + 1 < argv.length) return argv[idx + 1];
  return fallback;
}

function hasFlag(argv, name) {
  return argv.includes(`--${name}`);
}

function fmt(value, digits = 2) {
  return value === null || value === undefined ? 'n/a' : Number(value).toFixed(digits);
}

/**
 * Proven (callgraph-bridge) items at a given depth from a `statementPreciseByDepth`
 * record. Items carry { id, name, ... }; the projection already dropped
 * unproven-bridge, so every item here is a proven label.
 */
function provenItemsAtDepth(byDepth, depth) {
  const items = byDepth?.[depth] ?? byDepth?.[String(depth)] ?? [];
  return Array.isArray(items) ? items : [];
}

/** Full depth-1 inter-procedural reach (proven + unproven) — the direct callees. */
function provGetReachedD1(pdg) {
  const byDepth = pdg?.interproceduralByDepth ?? pdg?.pdgInterprocedural?.byDepth ?? {};
  return provenItemsAtDepth(byDepth, 1);
}

/**
 * Group proven items by leaf name, counting DISTINCT symbol ids per name. A name
 * mapping to >=2 distinct ids is an ambiguous (non-discriminating) proven group:
 * the name-match proved all of them, but the slice resolves to a subset.
 */
function nameCollisionStats(provenItems) {
  const idsByName = new Map();
  for (const it of provenItems) {
    if (!it || typeof it !== 'object') continue;
    const name = typeof it.name === 'string' ? it.name : '';
    if (!name) continue;
    const id =
      typeof it.id === 'string' && it.id
        ? it.id
        : `${name}@${typeof it.filePath === 'string' ? it.filePath : '?'}`;
    let set = idsByName.get(name);
    if (!set) {
      set = new Set();
      idsByName.set(name, set);
    }
    set.add(id);
  }
  let provenLabels = 0;
  let ambiguousLabels = 0; // proven labels whose name is shared by >=2 distinct ids
  let excessLabels = 0; //   sum(count - 1) over ambiguous names = central FP estimate
  const ambiguousNames = [];
  for (const [name, ids] of idsByName) {
    const c = ids.size;
    provenLabels += c;
    if (c >= 2) {
      ambiguousLabels += c;
      excessLabels += c - 1;
      ambiguousNames.push({ name, count: c });
    }
  }
  ambiguousNames.sort((a, b) => b.count - a.count);
  return { provenLabels, ambiguousLabels, excessLabels, ambiguousNames };
}

export function summarize(cases) {
  const withProven = cases.filter((c) => c.provenLabels > 0);
  const sum = (sel) => cases.reduce((a, c) => a + sel(c), 0);
  const totalProven = sum((c) => c.provenLabels);
  const totalAmbiguous = sum((c) => c.ambiguousLabels);
  const totalExcess = sum((c) => c.excessLabels);
  const totalReachedD1 = sum((c) => c.reachedD1);
  const totalDivergent = sum((c) => c.divergentReached);
  return {
    n: cases.length,
    functionsWithProvenLabels: withProven.length,
    functionsWithAmbiguity: cases.filter((c) => c.ambiguousLabels > 0).length,
    totalProvenLabels: totalProven,
    totalAmbiguousLabels: totalAmbiguous,
    totalExcessLabels: totalExcess,
    // Upper bound on collision-FP as a fraction of all proven labels.
    ambiguityRate: totalProven > 0 ? round(totalAmbiguous / totalProven) : null,
    // Central FP estimate (assumes ~1 distinct resolved symbol per slice leaf name).
    excessRate: totalProven > 0 ? round(totalExcess / totalProven) : null,
    medianProvenPerFn: median(withProven.map((c) => c.provenLabels)),
    // FN / aliasing axis: depth-1 reached callees whose resolved name is in NO
    // block leaf of the owning function (alias/rename/dynamic) — the surface where
    // a truly-on-slice callee can never be name-proven.
    totalReachedD1,
    totalDivergentReached: totalDivergent,
    divergenceRate: totalReachedD1 > 0 ? round(totalDivergent / totalReachedD1) : null,
    functionsWithDivergence: cases.filter((c) => c.divergentReached > 0).length,
  };
}

async function cypherRows(backend, repo, query) {
  const res = await backend.callTool('cypher', { repo, query });
  return parseMarkdownRows(res?.markdown);
}

async function run() {
  const argv = process.argv.slice(2);
  const repo = readOption(argv, 'repo', 'GitNexus');
  const sample = Math.max(1, Number(readOption(argv, 'sample', '120')));
  const minBlocks = Math.max(2, Number(readOption(argv, 'min-blocks', '6')));
  const src = readOption(argv, 'src', 'gitnexus/src/');
  const depth = Math.max(1, Number(readOption(argv, 'depth', '3')));
  const limit = Math.max(1, Number(readOption(argv, 'limit', '200')));
  const json = hasFlag(argv, 'json');

  const { LocalBackend } = await import(
    path.join(REPO_ROOT, 'src', 'mcp', 'local', 'local-backend.ts')
  );
  const backend = new LocalBackend();
  const initialized = await backend.init();
  if (!initialized)
    throw new Error('no indexed repositories found; run gitnexus analyze --pdg first');

  try {
    const candidateQuery = (label) =>
      `MATCH (f:${label}) WHERE f.filePath STARTS WITH '${src}' AND f.endLine > f.startLine + 18 ` +
      `RETURN f.name AS name, f.filePath AS filePath, f.startLine AS startLine, ` +
      `f.endLine AS endLine, '${label}' AS kind`;
    let candidates = [
      ...(await cypherRows(backend, repo, candidateQuery('Function'))),
      ...(await cypherRows(backend, repo, candidateQuery('Method'))),
    ].filter((c) => c.name && /^[A-Za-z_$][\w$]*$/.test(c.name));
    const stride = Math.max(1, Math.floor(candidates.length / (sample * 3)));
    candidates = candidates.filter((_, i) => i % stride === 0);

    const cases = [];
    let degraded = 0;
    for (const c of candidates) {
      if (cases.length >= sample) break;
      const lo = Number(c.startLine);
      const hi = Number(c.endLine);
      if (!Number.isFinite(lo) || !Number.isFinite(hi)) continue;

      const blockRows = await cypherRows(
        backend,
        repo,
        `MATCH (b:BasicBlock) WHERE b.filePath = '${c.filePath}' AND b.startLine >= ${lo} ` +
          `AND b.startLine <= ${hi + 1} RETURN b.id AS id, b.startLine AS startLine, ` +
          `b.callees AS callees ORDER BY b.startLine`,
      );
      const fnLine1b = String(lo + 1);
      const own = blockRows.filter((r) => {
        const parts = r.id.split(':');
        return parts[parts.length - 3] === fnLine1b;
      });
      // Union of all leaf call names across the function's own blocks — the
      // complete set name-matching could ever prove. A reached direct callee whose
      // resolved (definition) name is NOT in here can NEVER be name-proven: it is
      // called via an alias/rename, dynamically, or as a filtered member-read —
      // the false-negative (import-alias) surface.
      const blockLeafUnion = new Set();
      for (const r of own) {
        for (const n of String(r.callees ?? '').split(' '))
          if (n && n !== '*') blockLeafUnion.add(n);
      }
      const bodyBlocks = own.length;
      if (bodyBlocks < minBlocks) continue;
      const startLines = own
        .map((r) => Number(r.startLine))
        .filter(Number.isFinite)
        .sort((a, b) => a - b);
      const anchor = startLines[Math.max(1, Math.floor(bodyBlocks / 3))];
      if (!Number.isFinite(anchor)) continue;

      const pdg = await backend.callTool('impact', {
        repo,
        target: c.name,
        file_path: c.filePath,
        kind: c.kind,
        direction: 'downstream',
        maxDepth: depth,
        limit,
        includeTests: true,
        mode: 'pdg',
        line: anchor,
      });
      if (pdg?.error) continue;
      if (pdg?.pdgLayer && pdg.pdgLayer !== 'ready') {
        degraded++;
        continue;
      }
      if (pdg?.epistemic === 'pdg-no-block-at-line') continue;

      const spByDepth = pdg?.pdgInterprocedural?.statementPreciseByDepth ?? {};
      const d1 = nameCollisionStats(provenItemsAtDepth(spByDepth, 1));
      // All-depth (depth-1 firing + inherited deeper) for context only.
      const allProven = Object.keys(spByDepth).flatMap((d) =>
        provenItemsAtDepth(spByDepth, Number(d)),
      );
      const all = nameCollisionStats(allProven);

      // FN / aliasing axis: depth-1 reached direct callees (proven + unproven)
      // whose resolved name is absent from EVERY block leaf of the function — so
      // name-matching can never prove them even if they are on the slice.
      const reachedD1 = provGetReachedD1(pdg);
      let reachedD1Names = 0;
      let divergentReached = 0;
      const seenReached = new Set();
      for (const it of reachedD1) {
        const nm = it && typeof it.name === 'string' ? it.name : '';
        const id = it && typeof it.id === 'string' ? it.id : `${nm}@?`;
        if (!nm || seenReached.has(id)) continue;
        seenReached.add(id);
        reachedD1Names += 1;
        if (!blockLeafUnion.has(nm)) divergentReached += 1;
      }

      cases.push({
        name: c.name,
        kind: c.kind,
        file: c.filePath,
        anchor,
        sliceBlocks: pdg?.affectedStatementCount ?? 0,
        statementPrecision:
          typeof pdg?.pdgInterprocedural?.statementPrecision === 'number'
            ? round(pdg.pdgInterprocedural.statementPrecision)
            : null,
        // headline = depth 1 (where name-matching actually fires)
        provenLabels: d1.provenLabels,
        ambiguousLabels: d1.ambiguousLabels,
        excessLabels: d1.excessLabels,
        topAmbiguous: d1.ambiguousNames.slice(0, 4),
        allDepthProven: all.provenLabels,
        allDepthAmbiguous: all.ambiguousLabels,
        reachedD1: reachedD1Names,
        divergentReached,
      });
    }

    const summary = summarize(cases);
    const report = {
      repo,
      direction: 'downstream',
      sample: cases.length,
      minBlocks,
      degradedSkipped: degraded,
      generatedAt: new Date().toISOString(),
      note:
        'Realized name-collision probe (depth 1). ambiguousLabels = proven labels whose ' +
        'leaf name is shared by >=2 distinct reached symbol-ids — an UPPER BOUND on ' +
        'collision false-positives (complete: every collision-FP is such a label). ' +
        'excessLabels = sum(count-1) per ambiguous name = central FP estimate. Exact ' +
        'realized FP needs a re-run capturing per-call-site resolved ids.',
      summary,
      cases,
    };

    if (json) {
      process.stdout.write(JSON.stringify(report, null, 2) + '\n');
      return;
    }

    const s = summary;
    const lines = [];
    lines.push('=== impact-PDG realized name-collision probe (depth 1) ===');
    lines.push(`repo ${repo} | downstream | functions ${cases.length} | minBlocks ${minBlocks}`);
    lines.push('');
    lines.push(
      `Proven labels: ${s.totalProvenLabels} across ${s.functionsWithProvenLabels} functions ` +
        `(median ${s.medianProvenPerFn}/fn).`,
    );
    lines.push(
      `Name-ambiguous proven labels (UPPER BOUND on collision-FP): ${s.totalAmbiguousLabels} ` +
        `(${fmt((s.ambiguityRate ?? 0) * 100, 1)}% of proven), in ${s.functionsWithAmbiguity}/` +
        `${cases.length} functions.`,
    );
    lines.push(
      `Excess proven labels (central FP estimate, sum(count-1)): ${s.totalExcessLabels} ` +
        `(${fmt((s.excessRate ?? 0) * 100, 1)}% of proven).`,
    );
    lines.push(
      `FN / aliasing surface: ${s.totalDivergentReached}/${s.totalReachedD1} depth-1 reached ` +
        `callees (${fmt((s.divergenceRate ?? 0) * 100, 1)}%) have a resolved name absent from ` +
        `every block leaf (alias/rename/dynamic), in ${s.functionsWithDivergence}/${cases.length} ` +
        `functions — name-matching can never prove these.`,
    );
    lines.push('');
    lines.push(
      'Interpretation: ambiguityRate is the fraction of statement-precise proven labels the ' +
        'NAME match cannot disambiguate (>=2 reached callees share the leaf name). Realized ' +
        'collision-FP lies in [0, ambiguityRate]; a resolved-symbol-id bridge would drive it ' +
        'to 0. Near-zero here = no-go; material here = build + confirm with the exact line-join.',
    );
    process.stdout.write(lines.join('\n') + '\n');
  } finally {
    await backend.dispose().catch(() => {});
  }
}

if (path.resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) {
  run().catch((err) => {
    process.stderr.write(`[impact-pdg-name-collision] ERROR: ${err?.stack || err}\n`);
    process.exit(1);
  });
}

/**
 * Real-code blast-radius / localization probe — the "is PDG-mode impact actually
 * better than callgraph-only?" evidence harness.
 *
 * `real-code.mjs` checks that unified `mode:'pdg'` PRESERVES callgraph symbol
 * reach and how much it costs. This script answers the sharper question: when you
 * change a single statement inside a real function, how much does PDG NARROW the
 * impact set versus the pre-PDG answer ("you changed something in F → inspect all
 * of F")? It samples real functions from an already-indexed repo and, per
 * function, compares:
 *
 *   - intra axis (the localization win): |PDG statement slice| vs |whole function
 *     body| (block units). A ratio < 1 means PDG points at a subset of the body
 *     instead of the whole thing. Correctness of that subset is NOT proven here —
 *     it is anchored by the AIS-backed `measure.mjs` gate, which shows the
 *     line-seeded slice is exact (intra/mixed PDG F1 = 1.0, FPIS = FNIS = 0). So
 *     a smaller slice is a genuine over-approximation cut, not a dropped-truth
 *     risk.
 *   - inter axis (the honest non-win): the PDG interprocedural symbol set vs the
 *     callgraph symbol set for the same target. They are equal by design (PDG
 *     bridges interprocedural reach through the call graph), so this probe
 *     surfaces any divergence rather than assuming it.
 *   - cost: callgraph vs PDG latency.
 *
 * This is a quality proxy on real code (no curated AIS), exactly like
 * `real-code.mjs`. Read magnitudes as directional; the correctness claim lives in
 * `measure.mjs`.
 *
 * Methodology note: the seed anchor is an EARLY-interior block (index
 * floor(M/3)). For a downstream/forward slice that is a conservative,
 * slice-maximizing choice — it understates rather than inflates the localization
 * win — so the measured cut is a lower bound on a typical interior edit.
 */
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');

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

export function median(xs) {
  if (xs.length === 0) return null;
  const sorted = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function round(value, digits = 3) {
  if (value === null || value === undefined || Number.isNaN(value)) return null;
  const scale = 10 ** digits;
  return Math.round(value * scale) / scale;
}

function fmt(value, digits = 2) {
  return value === null || value === undefined ? 'n/a' : Number(value).toFixed(digits);
}

/**
 * Parse a GitNexus `cypher` markdown table into row objects. Only used on columns
 * that cannot contain a `|` (ids, identifiers, integers) so the split is safe.
 */
export function parseMarkdownRows(markdown) {
  if (!markdown) return [];
  const lines = markdown.split('\n').filter((l) => l.trim().startsWith('|'));
  if (lines.length < 2) return [];
  const head = lines[0]
    .split('|')
    .slice(1, -1)
    .map((s) => s.trim());
  return lines.slice(2).map((l) => {
    const cells = l
      .split('|')
      .slice(1, -1)
      .map((s) => s.trim());
    const o = {};
    head.forEach((h, i) => (o[h] = cells[i]));
    return o;
  });
}

/** Stable symbol-id set from an impact `byDepth` record (mirrors real-code.mjs). */
export function symbolSetFromByDepth(byDepth) {
  const out = new Set();
  for (const items of Object.values(byDepth ?? {})) {
    for (const item of items ?? []) {
      if (!item || typeof item !== 'object') continue;
      if (typeof item.id === 'string' && item.id.length > 0) {
        out.add(item.id);
        continue;
      }
      const name = typeof item.name === 'string' ? item.name : '(unknown)';
      const filePath = typeof item.filePath === 'string' ? item.filePath : '(unknown)';
      out.add(`${name}@${filePath}`);
    }
  }
  return out;
}

/**
 * Pure aggregation over the per-function measurements. Kept dependency-free so the
 * deterministic unit test can assert the arithmetic without analyze/DB.
 */
export function summarizeBlastRadius(cases) {
  const ratios = cases.map((c) => c.ratio).filter((v) => v !== null && v !== undefined);
  return {
    n: cases.length,
    localization: {
      medianSliceOverBody: round(median(ratios)),
      meanSliceOverBody: ratios.length
        ? round(ratios.reduce((a, b) => a + b, 0) / ratios.length)
        : null,
      medianBodyBlocks: median(cases.map((c) => c.bodyBlocks)),
      medianSliceBlocks: median(cases.map((c) => c.sliceBlocks)),
      casesSliceSmallerThanBody: cases.filter((c) => c.sliceBlocks < c.bodyBlocks).length,
    },
    interSymbol: {
      casesPdgFindsMore: cases.filter((c) => c.pdgOnly > 0).length,
      casesPdgFindsFewer: cases.filter((c) => c.cgOnly > 0).length,
      casesIdentical: cases.filter((c) => c.pdgOnly === 0 && c.cgOnly === 0).length,
      totalPdgOnlySymbols: cases.reduce((a, c) => a + c.pdgOnly, 0),
      totalCgOnlySymbols: cases.reduce((a, c) => a + c.cgOnly, 0),
    },
    // Statement-precise inter-procedural reach (the axis-3 precision win): the
    // proven subset invoked from the changed line's slice, vs the full callgraph
    // reach. Only the with-slice cases can discriminate; empty-slice/upstream
    // cases preserve full reach (precision 1) and are reported separately.
    statementPrecise: {
      casesWithSlice: cases.filter((c) => c.sliceBlocks > 0).length,
      casesTighterThanCallgraph: cases.filter((c) => c.statementPreciseSymbols < c.callgraphSymbols)
        .length,
      medianStatementPrecision: round(
        median(cases.map((c) => c.statementPrecision).filter((v) => v !== null && v !== undefined)),
      ),
      medianPreciseSymbols: median(cases.map((c) => c.statementPreciseSymbols)),
      medianCallgraphSymbols: median(cases.map((c) => c.callgraphSymbols)),
    },
    latency: {
      medianCallgraphMs: round(median(cases.map((c) => c.callgraphMs))),
      medianPdgMs: round(median(cases.map((c) => c.pdgMs))),
      medianPdgOverCallgraph: round(
        median(
          cases
            .map((c) => (c.callgraphMs > 0 ? c.pdgMs / c.callgraphMs : null))
            .filter((v) => v !== null),
        ),
      ),
    },
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
  const direction = readOption(argv, 'direction', 'downstream');
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
    // Candidate functions + methods with a body worth localizing.
    const candidateQuery = (label) =>
      `MATCH (f:${label}) WHERE f.filePath STARTS WITH '${src}' AND f.endLine > f.startLine + 18 ` +
      `RETURN f.name AS name, f.filePath AS filePath, f.startLine AS startLine, ` +
      `f.endLine AS endLine, '${label}' AS kind`;
    let candidates = [
      ...(await cypherRows(backend, repo, candidateQuery('Function'))),
      ...(await cypherRows(backend, repo, candidateQuery('Method'))),
    ].filter((c) => c.name && /^[A-Za-z_$][\w$]*$/.test(c.name));
    // Stride-sample for file diversity instead of taking the first N.
    const stride = Math.max(1, Math.floor(candidates.length / (sample * 3)));
    candidates = candidates.filter((_, i) => i % stride === 0);

    const cases = [];
    let degraded = 0;
    for (const c of candidates) {
      if (cases.length >= sample) break;
      const lo = Number(c.startLine);
      const hi = Number(c.endLine);
      if (!Number.isFinite(lo) || !Number.isFinite(hi)) continue;

      // The function's OWN blocks (id prefix fnStartLine == lo+1, 1-based) — the
      // line range alone would also capture nested closures.
      const blockRows = await cypherRows(
        backend,
        repo,
        `MATCH (b:BasicBlock) WHERE b.filePath = '${c.filePath}' AND b.startLine >= ${lo} ` +
          `AND b.startLine <= ${hi + 1} RETURN b.id AS id, b.startLine AS startLine ORDER BY b.startLine`,
      );
      const fnLine1b = String(lo + 1);
      const own = blockRows.filter((r) => {
        const parts = r.id.split(':');
        return parts[parts.length - 3] === fnLine1b;
      });
      const bodyBlocks = own.length;
      if (bodyBlocks < minBlocks) continue;
      const startLines = own
        .map((r) => Number(r.startLine))
        .filter(Number.isFinite)
        .sort((a, b) => a - b);
      const anchor = startLines[Math.max(1, Math.floor(bodyBlocks / 3))];
      if (!Number.isFinite(anchor)) continue;

      const base = {
        repo,
        target: c.name,
        file_path: c.filePath,
        kind: c.kind,
        direction,
        maxDepth: depth,
        limit,
        includeTests: true,
      };

      let t = performance.now();
      const cg = await backend.callTool('impact', { ...base, mode: 'callgraph' });
      const callgraphMs = performance.now() - t;
      if (cg?.error) continue;

      t = performance.now();
      const pdg = await backend.callTool('impact', { ...base, mode: 'pdg', line: anchor });
      const pdgMs = performance.now() - t;
      if (pdg?.error) continue;
      if (pdg?.pdgLayer && pdg.pdgLayer !== 'ready') {
        degraded++;
        continue;
      }
      if (pdg?.epistemic === 'pdg-no-block-at-line') continue;

      const sliceBlocks = pdg?.affectedStatementCount ?? 0;
      const cgSyms = symbolSetFromByDepth(cg?.byDepth ?? {});
      const pdgSyms = symbolSetFromByDepth(
        pdg?.interproceduralByDepth ?? pdg?.pdgInterprocedural?.byDepth ?? {},
      );
      // Statement-precise (proven) inter-procedural reach: the subset invoked
      // from the criterion's dependence slice. Tighter than callgraph when the
      // changed line reaches only some of the function's callees.
      const preciseSyms = symbolSetFromByDepth(
        pdg?.pdgInterprocedural?.statementPreciseByDepth ?? {},
      );
      const pdgOnly = [...pdgSyms].filter((x) => !cgSyms.has(x)).length;
      const cgOnly = [...cgSyms].filter((x) => !pdgSyms.has(x)).length;

      cases.push({
        name: c.name,
        kind: c.kind,
        file: c.filePath,
        anchor,
        bodyBlocks,
        sliceBlocks,
        ratio: bodyBlocks ? round(sliceBlocks / bodyBlocks) : null,
        callgraphSymbols: cgSyms.size,
        pdgSymbols: pdgSyms.size,
        statementPreciseSymbols: preciseSyms.size,
        statementPrecision:
          typeof pdg?.pdgInterprocedural?.statementPrecision === 'number'
            ? round(pdg.pdgInterprocedural.statementPrecision)
            : null,
        pdgOnly,
        cgOnly,
        epistemic: pdg?.epistemic ?? null,
        callgraphMs: round(callgraphMs, 1),
        pdgMs: round(pdgMs, 1),
      });
    }

    const summary = summarizeBlastRadius(cases);
    const report = {
      repo,
      direction,
      sample: cases.length,
      minBlocks,
      degradedSkipped: degraded,
      generatedAt: new Date().toISOString(),
      note: 'Real-code localization proxy: slice-vs-body magnitude only. Correctness is anchored by measure.mjs (AIS-backed).',
      summary,
      cases,
    };

    if (json) {
      process.stdout.write(JSON.stringify(report, null, 2) + '\n');
      return;
    }

    const loc = summary.localization;
    const inter = summary.interSymbol;
    const prec = summary.statementPrecise;
    const lat = summary.latency;
    const lines = [];
    lines.push('=== impact-PDG real-code blast-radius / localization probe ===');
    lines.push(
      `repo ${repo} | direction ${direction} | functions ${cases.length} | minBlocks ${minBlocks}`,
    );
    lines.push('');
    lines.push(
      `Localization (axis: tighter): PDG slice is a median ${fmt(loc.medianSliceOverBody)} of the ` +
        `whole function body (mean ${fmt(loc.meanSliceOverBody)}); median body ${loc.medianBodyBlocks} ` +
        `blocks -> slice ${loc.medianSliceBlocks}; ${loc.casesSliceSmallerThanBody}/${cases.length} ` +
        `functions localized below whole-body.`,
    );
    lines.push(
      `Inter-symbol reach (axis: more callers/callees): full reach identical to callgraph on ` +
        `${inter.casesIdentical}/${cases.length} functions ` +
        `(pdg-only ${inter.totalPdgOnlySymbols}, callgraph-only ${inter.totalCgOnlySymbols}).`,
    );
    lines.push(
      `Statement-precise reach (axis: tighter cross-function): ${prec.casesTighterThanCallgraph}/` +
        `${prec.casesWithSlice} with-slice functions narrow below full callgraph reach; median ` +
        `statement-precision ${fmt(prec.medianStatementPrecision)} (proven median ` +
        `${prec.medianPreciseSymbols} vs callgraph ${prec.medianCallgraphSymbols} symbols).`,
    );
    lines.push(
      `Latency (axis: faster): callgraph median ${fmt(lat.medianCallgraphMs, 1)}ms, ` +
        `pdg median ${fmt(lat.medianPdgMs, 1)}ms, pdg/cg ${fmt(lat.medianPdgOverCallgraph)}x.`,
    );
    lines.push('');
    lines.push(
      'Interpretation: PDG narrows the intra-procedural impact set (the slice is a ' +
        'fraction of the body); its correctness — that the narrowed set drops no real ' +
        'dependency — is the AIS-backed measure.mjs result (intra/mixed PDG F1 = 1.0). PDG ' +
        'does NOT widen cross-function reach (equal to callgraph by design) and is NOT faster.',
    );
    process.stdout.write(lines.join('\n') + '\n');
  } finally {
    await backend.dispose().catch(() => {});
  }
}

if (path.resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) {
  run().catch((err) => {
    process.stderr.write(`[impact-pdg-blast-radius] ERROR: ${err?.stack || err}\n`);
    process.exit(1);
  });
}

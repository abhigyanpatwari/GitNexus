/**
 * Real-code performance and quality proxy probe for impact modes.
 *
 * This complements `measure.mjs`, which is the ground-truth accuracy gate over
 * curated fixtures. A real repository does not have an AIS annotation set, so
 * this probe does NOT claim accuracy. It checks whether unified `mode:'pdg'`
 * preserves the established callgraph symbol reach on a real index, how much it
 * costs, and how honest its PDG evidence/degraded signals are.
 */
import fs from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');

export const DEFAULT_REAL_CODE_CASES = [
  {
    name: 'cli-format-impact-upstream',
    target: 'formatImpactResult',
    file_path: 'gitnexus/src/cli/eval-server.ts',
    kind: 'Function',
    direction: 'upstream',
    line: 208,
  },
  {
    name: 'cli-impact-command-downstream',
    target: 'impactCommand',
    file_path: 'gitnexus/src/cli/tool.ts',
    kind: 'Function',
    direction: 'downstream',
    // Block-start line of the coalesced backend-call statement group. The CFG
    // coalesces lines 162-192 into one BasicBlock, so an anchor mid-block (e.g.
    // 173) lands on no block start and degrades to pdg-no-block-at-line. Seed the
    // block's start line so the intra slice is exercised on a real statement.
    line: 162,
  },
  {
    name: 'pdg-engine-downstream',
    target: 'runImpactPDG',
    file_path: 'gitnexus/src/mcp/local/pdg-impact.ts',
    kind: 'Function',
    direction: 'downstream',
    // Block-start line of the function's opening coalesced statement group
    // (the destructure + budget setup spanning 912+). Mid-block lines like 952
    // resolve to no block start; 912 seeds a real, statement-rich intra slice.
    line: 912,
  },
  {
    name: 'pdg-dispatch-upstream',
    target: '_impactImpl',
    file_path: 'gitnexus/src/mcp/local/local-backend.ts',
    kind: 'Method',
    direction: 'upstream',
    line: 4427,
  },
  {
    name: 'pdg-compose-downstream',
    target: 'composeUnifiedPdgImpactResult',
    file_path: 'gitnexus/src/mcp/local/local-backend.ts',
    kind: 'Method',
    direction: 'downstream',
    line: 4850,
  },
];

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

export function percentile(xs, pct) {
  if (xs.length === 0) return null;
  const sorted = [...xs].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((pct / 100) * sorted.length) - 1));
  return sorted[idx];
}

function round(value, digits = 3) {
  if (value === null || value === undefined || Number.isNaN(value)) return null;
  const scale = 10 ** digits;
  return Math.round(value * scale) / scale;
}

function fmt(value, digits = 1) {
  return value === null || value === undefined ? 'n/a' : Number(value).toFixed(digits);
}

export function symbolKeysFromByDepth(byDepth) {
  const keys = new Set();
  for (const items of Object.values(byDepth ?? {})) {
    for (const item of items ?? []) {
      if (!item || typeof item !== 'object') continue;
      if (typeof item.id === 'string' && item.id.length > 0) {
        keys.add(item.id);
        continue;
      }
      const name = typeof item.name === 'string' ? item.name : '(unknown)';
      const filePath = typeof item.filePath === 'string' ? item.filePath : '(unknown)';
      keys.add(`${name}@${filePath}`);
    }
  }
  return keys;
}

export function compareSymbolSets(reference, candidate) {
  const ref = new Set(reference);
  const cand = new Set(candidate);
  const overlap = [...ref].filter((key) => cand.has(key));
  const referenceOnly = [...ref].filter((key) => !cand.has(key)).sort();
  const candidateOnly = [...cand].filter((key) => !ref.has(key)).sort();
  const unionSize = new Set([...ref, ...cand]).size;
  return {
    referenceSize: ref.size,
    candidateSize: cand.size,
    overlapSize: overlap.length,
    recallVsReference: ref.size === 0 ? null : overlap.length / ref.size,
    precisionVsReference: cand.size === 0 ? null : overlap.length / cand.size,
    jaccard: unionSize === 0 ? null : overlap.length / unionSize,
    referenceOnly,
    candidateOnly,
  };
}

function sumEvidenceCounts(results) {
  const counts = {};
  for (const result of results) {
    const evidenceCounts =
      result?.pdgInterprocedural?.evidenceCounts ??
      result?.pdgEvidence?.interproceduralEvidenceCounts ??
      {};
    for (const [key, value] of Object.entries(evidenceCounts)) {
      counts[key] = (counts[key] ?? 0) + Number(value ?? 0);
    }
  }
  return counts;
}

function readCases(caseFile) {
  if (!caseFile) return DEFAULT_REAL_CODE_CASES;
  const resolved = path.resolve(process.cwd(), caseFile);
  const parsed = JSON.parse(fs.readFileSync(resolved, 'utf8'));
  const cases = Array.isArray(parsed) ? parsed : parsed.cases;
  if (!Array.isArray(cases) || cases.length === 0) {
    throw new Error(`case file ${resolved} must contain a non-empty array or { "cases": [...] }`);
  }
  return cases;
}

async function timedImpact(backend, params) {
  const started = performance.now();
  const result = await backend.callTool('impact', params);
  return { result, ms: performance.now() - started };
}

async function measureCase(backend, testCase, options) {
  const baseParams = {
    repo: options.repo,
    target: testCase.target,
    file_path: testCase.file_path,
    kind: testCase.kind,
    direction: testCase.direction ?? 'upstream',
    maxDepth: options.depth,
    includeTests: options.includeTests,
    limit: options.limit,
  };
  const callgraphTimes = [];
  const pdgTimes = [];
  let callgraphResult = null;
  let pdgResult = null;

  for (let i = 0; i < options.repeat; i++) {
    const callgraph = await timedImpact(backend, { ...baseParams, mode: 'callgraph' });
    callgraphTimes.push(callgraph.ms);
    callgraphResult = callgraph.result;

    const pdg = await timedImpact(backend, {
      ...baseParams,
      mode: 'pdg',
      ...(Number.isInteger(testCase.line) ? { line: testCase.line } : {}),
    });
    pdgTimes.push(pdg.ms);
    pdgResult = pdg.result;
  }

  const callgraphKeys = symbolKeysFromByDepth(callgraphResult?.byDepth ?? {});
  const pdgInterByDepth =
    pdgResult?.interproceduralByDepth ?? pdgResult?.pdgInterprocedural?.byDepth ?? {};
  const pdgInterKeys = symbolKeysFromByDepth(pdgInterByDepth);
  const symbolAgreement = compareSymbolSets(callgraphKeys, pdgInterKeys);
  const evidenceCounts =
    pdgResult?.pdgInterprocedural?.evidenceCounts ??
    pdgResult?.pdgEvidence?.interproceduralEvidenceCounts ??
    {};

  return {
    name: testCase.name ?? testCase.target,
    target: testCase.target,
    filePath: testCase.file_path,
    kind: testCase.kind,
    direction: baseParams.direction,
    line: Number.isInteger(testCase.line) ? testCase.line : null,
    latencyMs: {
      callgraph: {
        median: round(median(callgraphTimes)),
        p95: round(percentile(callgraphTimes, 95)),
        samples: callgraphTimes.map((v) => round(v)),
      },
      pdg: {
        median: round(median(pdgTimes)),
        p95: round(percentile(pdgTimes, 95)),
        samples: pdgTimes.map((v) => round(v)),
      },
      pdgOverCallgraphMedian:
        median(callgraphTimes) && median(callgraphTimes) > 0
          ? round(median(pdgTimes) / median(callgraphTimes))
          : null,
    },
    callgraph: {
      error: callgraphResult?.error ?? null,
      impactedCount: callgraphResult?.impactedCount ?? 0,
      risk: callgraphResult?.risk ?? null,
      epistemic: callgraphResult?.epistemic ?? null,
      partial: Boolean(callgraphResult?.partial),
      symbolCount: callgraphKeys.size,
    },
    pdg: {
      error: pdgResult?.error ?? null,
      pdgLayer: pdgResult?.pdgLayer ?? 'ready',
      epistemic: pdgResult?.epistemic ?? null,
      partial: Boolean(pdgResult?.partial || pdgResult?.pdgInterprocedural?.partial),
      impactedCount: pdgResult?.impactedCount ?? 0,
      affectedStatementCount: pdgResult?.affectedStatementCount ?? 0,
      blockCount: pdgResult?.blockCount ?? 0,
      interproceduralSymbolCount: pdgInterKeys.size,
      evidence: pdgResult?.pdgInterprocedural?.evidence ?? pdgResult?.pdgEvidence?.interprocedural,
      evidenceCounts,
    },
    symbolAgreement,
  };
}

export function summarizeCases(cases) {
  const ratios = cases
    .map((c) => c.latencyMs.pdgOverCallgraphMedian)
    .filter((v) => v !== null && v !== undefined);
  const callgraphMedians = cases
    .map((c) => c.latencyMs.callgraph.median)
    .filter((v) => v !== null && v !== undefined);
  const pdgMedians = cases
    .map((c) => c.latencyMs.pdg.median)
    .filter((v) => v !== null && v !== undefined);
  const comparable = cases.filter((c) => c.symbolAgreement.recallVsReference !== null);
  const recalls = comparable.map((c) => c.symbolAgreement.recallVsReference);
  const precisions = comparable
    .map((c) => c.symbolAgreement.precisionVsReference)
    .filter((v) => v !== null && v !== undefined);
  const degradedCases = cases.filter((c) => c.pdg.pdgLayer !== 'ready');
  const errorCases = cases.filter((c) => c.callgraph.error || c.pdg.error);
  const partialCases = cases.filter((c) => c.callgraph.partial || c.pdg.partial);
  const noBlockAtLineCases = cases.filter((c) => c.pdg.epistemic === 'pdg-no-block-at-line');
  const evidenceCounts = sumEvidenceCounts(cases.map((c) => ({ pdgInterprocedural: c.pdg })));
  const totalBridgeSymbols = Object.values(evidenceCounts).reduce((a, b) => a + Number(b ?? 0), 0);

  return {
    performance: {
      callgraphMedianMs: round(median(callgraphMedians)),
      pdgMedianMs: round(median(pdgMedians)),
      pdgP95Ms: round(percentile(cases.map((c) => c.latencyMs.pdg.p95).filter(Boolean), 95)),
      pdgOverCallgraphMedian: round(median(ratios)),
    },
    qualityProxy: {
      comparableCases: comparable.length,
      meanSymbolRecallVsCallgraph: recalls.length
        ? round(recalls.reduce((a, b) => a + b, 0) / recalls.length)
        : null,
      minSymbolRecallVsCallgraph: recalls.length ? round(Math.min(...recalls)) : null,
      meanSymbolPrecisionVsCallgraph: precisions.length
        ? round(precisions.reduce((a, b) => a + b, 0) / precisions.length)
        : null,
      degradedCaseCount: degradedCases.length,
      errorCaseCount: errorCases.length,
      partialCaseCount: partialCases.length,
      noBlockAtLineCaseCount: noBlockAtLineCases.length,
      evidenceCounts,
      unprovenBridgeRatio:
        totalBridgeSymbols > 0
          ? round((evidenceCounts['unproven-bridge'] ?? 0) / totalBridgeSymbols)
          : null,
    },
  };
}

export function evaluateCheckGates(report, env = process.env) {
  const failures = [];
  const minRecall = Number(env.GN_REAL_CODE_PDG_MIN_SYMBOL_RECALL ?? 0.95);
  const maxMedianMs = Number(env.GN_REAL_CODE_PDG_MAX_MEDIAN_MS ?? 5000);
  const quality = report.summary.qualityProxy;
  const perf = report.summary.performance;

  if (report.cases.length === 0) failures.push('no real-code cases were measured');
  if (quality.errorCaseCount > 0)
    failures.push(`${quality.errorCaseCount} case(s) returned errors`);
  if (quality.degradedCaseCount > 0) {
    failures.push(`${quality.degradedCaseCount} case(s) reported a degraded PDG layer`);
  }
  if (
    quality.minSymbolRecallVsCallgraph !== null &&
    quality.minSymbolRecallVsCallgraph < minRecall
  ) {
    failures.push(
      `min PDG symbol recall vs callgraph ${quality.minSymbolRecallVsCallgraph} < ${minRecall}`,
    );
  }
  if (perf.pdgMedianMs !== null && perf.pdgMedianMs > maxMedianMs) {
    failures.push(`PDG median latency ${perf.pdgMedianMs}ms > ${maxMedianMs}ms`);
  }
  return failures;
}

function renderText(report, failures) {
  const lines = [];
  const perf = report.summary.performance;
  const quality = report.summary.qualityProxy;
  lines.push('=== impact-PDG real-code performance/quality probe ===');
  lines.push(
    `repo ${report.repo} | cases ${report.cases.length} | repeat ${report.repeat} | includeTests=${report.includeTests}`,
  );
  lines.push('');
  lines.push(
    `Latency: callgraph median ${fmt(perf.callgraphMedianMs)}ms, ` +
      `pdg median ${fmt(perf.pdgMedianMs)}ms, pdg p95 ${fmt(perf.pdgP95Ms)}ms, ` +
      `median overhead ${fmt(perf.pdgOverCallgraphMedian, 2)}x`,
  );
  lines.push(
    `Quality proxy: min PDG symbol recall vs callgraph ${fmt(
      quality.minSymbolRecallVsCallgraph,
      3,
    )}, mean recall ${fmt(quality.meanSymbolRecallVsCallgraph, 3)}, ` +
      `mean precision ${fmt(quality.meanSymbolPrecisionVsCallgraph, 3)}`,
  );
  lines.push(
    `Signals: degraded=${quality.degradedCaseCount}, errors=${quality.errorCaseCount}, ` +
      `partial=${quality.partialCaseCount}, no-block-at-line=${quality.noBlockAtLineCaseCount}, ` +
      `unprovenBridgeRatio=${fmt(quality.unprovenBridgeRatio, 3)}`,
  );
  lines.push(`Evidence counts: ${JSON.stringify(quality.evidenceCounts)}`);
  lines.push('');
  lines.push('Per case:');
  for (const c of report.cases) {
    lines.push(
      `  ${c.name}: cg ${fmt(c.latencyMs.callgraph.median)}ms/${c.callgraph.symbolCount} symbols, ` +
        `pdg ${fmt(c.latencyMs.pdg.median)}ms/${c.pdg.interproceduralSymbolCount} inter-symbols, ` +
        `statements=${c.pdg.affectedStatementCount}, recall=${fmt(
          c.symbolAgreement.recallVsReference,
          3,
        )}, precision=${fmt(c.symbolAgreement.precisionVsReference, 3)}, ` +
        `evidence=${c.pdg.evidence ?? 'n/a'}`,
    );
    if (c.callgraph.error || c.pdg.error || c.pdg.pdgLayer !== 'ready') {
      lines.push(
        `    status: callgraphError=${c.callgraph.error ?? 'none'} pdgError=${
          c.pdg.error ?? 'none'
        } pdgLayer=${c.pdg.pdgLayer}`,
      );
    }
    if (c.symbolAgreement.referenceOnly.length > 0) {
      lines.push(
        `    callgraph-only symbols: ${c.symbolAgreement.referenceOnly.slice(0, 5).join(', ')}`,
      );
    }
  }
  lines.push('');
  lines.push(
    'Interpretation: this real-code probe measures latency and quality proxies, not accuracy. ' +
      'The curated fixture harness remains the AIS-backed accuracy gate.',
  );
  if (failures.length > 0) {
    lines.push('');
    for (const failure of failures) lines.push(`[impact-pdg-real-code --check] FAIL: ${failure}`);
  }
  return lines.join('\n');
}

async function run() {
  const argv = process.argv.slice(2);
  const repo = readOption(argv, 'repo', 'GitNexus');
  const repeat = Math.max(1, Number(readOption(argv, 'repeat', '3')));
  const depth = Math.max(1, Number(readOption(argv, 'depth', '3')));
  const limit = Math.max(1, Number(readOption(argv, 'limit', '100')));
  const includeTests = readOption(argv, 'include-tests', 'true') !== 'false';
  const caseFile = readOption(argv, 'case-file');
  const json = hasFlag(argv, 'json');
  const check = hasFlag(argv, 'check');
  const cases = readCases(caseFile);

  const { LocalBackend } = await import(
    path.join(REPO_ROOT, 'src', 'mcp', 'local', 'local-backend.ts')
  );
  const backend = new LocalBackend();
  const initialized = await backend.init();
  if (!initialized)
    throw new Error('no indexed repositories found; run gitnexus analyze --pdg first');

  try {
    const measured = [];
    for (const testCase of cases) {
      measured.push(
        await measureCase(backend, testCase, { repo, repeat, depth, limit, includeTests }),
      );
    }
    const report = {
      repo,
      repeat,
      depth,
      limit,
      includeTests,
      generatedAt: new Date().toISOString(),
      note: 'Real-code probe: latency plus quality proxies only. Accuracy requires AIS-backed fixtures.',
      cases: measured,
      summary: summarizeCases(measured),
    };
    const failures = evaluateCheckGates(report);

    if (json) {
      process.stdout.write(JSON.stringify({ ...report, checkFailures: failures }, null, 2) + '\n');
    } else {
      process.stdout.write(renderText(report, failures) + '\n');
    }

    if (check && failures.length > 0) process.exit(1);
  } finally {
    await backend.dispose().catch(() => {});
  }
}

if (path.resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) {
  run().catch((err) => {
    process.stderr.write(`[impact-pdg-real-code] ERROR: ${err?.stack || err}\n`);
    process.exit(1);
  });
}

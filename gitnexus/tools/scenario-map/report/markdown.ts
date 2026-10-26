/**
 * Markdown rendering of the scenario map report (U13, R12): the full report (report.ts
 * `ScenarioMapReport`) for humans, written next to the JSON artifact. The scenario fingerprint
 * first (verdict/fingerprint.ts: duplicates, possible duplicates, same scenario with different
 * checks, table-row candidates; distinct pairs are only counted), then the mutation evidence when
 * the run gathered it: every verdict category, every pair with its evidence, the per-test
 * properties, the gaps; then Layer 0, eligibility and provenance. The tracking issue body
 * (issue-body.ts) is a shorter view built from the same helpers.
 *
 * Style follows the Layer 0 rendering of test-dupes findings (ci-report.yml "Possible duplicate
 * tests"): a heading, one sentence saying what the list is, then a table whose data cells are
 * inline code. Every string that comes from the repo (test ids, files, details) goes through
 * {@link mdCode}, so a title cannot break a table or inject markup.
 *
 * Library only; pure. The scenario-map CLI (U14) writes the result.
 */
import { BANNERS } from './baseline.js';
import { parseGlobalMutantId } from './anchors.js';
import type {
  ReportFingerprintPair,
  ReportPair,
  ReportTest,
  RunInfo,
  ScenarioMapReport,
} from './report.js';
import { FINGERPRINT_VERDICTS, type FingerprintVerdict } from '../verdict/fingerprint.js';
import { VERDICT_PRECEDENCE, WORDING, type Verdict } from '../verdict/verdict.js';
import type { MutationScope } from '../types.js';
import type { DegradedFlag } from '../value-flow/pdg-walk.js';

/** What each value-flow degraded flag costs (U10, KTD11). */
export const DEGRADED_TEXT: Readonly<Record<DegradedFlag, string>> = Object.freeze({
  'no-pdg-layer':
    'no PDG layer: the static value-flow check vetoes every pair with differing discarded values (Review)',
  'checker-version':
    'TypeScript checker is not the pinned version: static value-flow results are unknown (Review)',
  'checker-unavailable':
    'TypeScript checker did not open: static value-flow results are unknown (Review)',
});

const VERDICT_TITLES: Readonly<Record<Verdict, string>> = Object.freeze({
  inconclusive: 'Inconclusive pairs',
  'out-of-scope': 'Out-of-scope pairs',
  weak: 'Weak pairs',
  'repeat-strong': 'Strong repeat candidates',
  'repeat-weak': 'Weak-evidence repeat candidates',
  row: 'Row pairs',
  review: 'Review pairs',
  distinct: 'Distinct pairs',
});

const VERDICT_ACTIONS: Readonly<Record<Verdict, string>> = Object.freeze({
  inconclusive: 'Rerun or investigate; no other verdict applies.',
  'out-of-scope': 'Not judged: a test is not eligible or covers no evaluated mutant.',
  weak: 'A test kills no evaluated mutant, so the pair can never be a repeat.',
  'repeat-strong':
    'Every strong condition holds. Human scenario review only; removal only through a cleanup PR ' +
    'with the removal check.',
  'repeat-weak': 'A repeat with at least one weak disqualifier. Review queue only.',
  row: 'Same path, checks, context and facet, but the kill sets differ or row deletion is asymmetric. Fold into `it.each`; keep every row.',
  review:
    'Same path, checks, context and kills, but the facet differs or the value-flow check vetoed or could not decide. A human decides.',
  distinct: 'Keep.',
});

export const FINGERPRINT_TITLES: Readonly<Record<FingerprintVerdict, string>> = Object.freeze({
  duplicate: 'Duplicates',
  'possible-duplicate': 'Possible duplicates',
  'different-checks': 'Same scenario, different checks',
  'table-row': 'Table-row candidates',
  distinct: 'Distinct pairs',
  inconclusive: 'Inconclusive fingerprints',
  'out-of-scope': 'Out-of-scope pairs',
});

export const FINGERPRINT_ACTIONS: Readonly<Record<FingerprintVerdict, string>> = Object.freeze({
  duplicate:
    'Same execution path, same input data, same expectation; every input resolved and the ' +
    'runtime trace clean. Keep one, or mark the other `// dupe-ok: <reason>`.',
  'possible-duplicate':
    'Nothing known differs, but an input, a check or the runtime trace could not be resolved. ' +
    'A human decides; mutation evidence (dispatch) can add kill sets.',
  'different-checks':
    'Same path and input, other assertions. Consider merging the checks into one test.',
  'table-row':
    'Same path and checks, other input values. Consider folding into `it.each`; keep every row.',
  distinct: 'Keep.',
  inconclusive: 'A test ran concurrently: its path cannot be attributed.',
  'out-of-scope': 'Not judged: a test is not eligible.',
});

/** What each mutation scope means, for the report header. */
export const MUTATION_SCOPE_TEXT: Readonly<Record<MutationScope, string>> = Object.freeze({
  none: 'not gathered (scope `none`): fingerprint verdicts only',
  'possible-duplicates': 'gathered for the possible duplicates only (scope `possible-duplicates`)',
  all: 'gathered for every candidate group (scope `all`)',
});

// ── Cells ──────────────────────────────────────────────────────────────────

/**
 * Inline code for a table cell: line breaks become spaces, `|` is escaped, and a text holding
 * backticks gets a longer fence (GFM code spans).
 */
export function mdCode(text: string): string {
  const flat = text.replace(/[\r\n\t\u2028\u2029]+/g, ' ').replace(/\|/g, '\\|');
  const runs = flat.match(/`+/g);
  if (runs === null) return `\`${flat}\``;
  const fence = '`'.repeat(Math.max(...runs.map((run) => run.length)) + 1);
  return `${fence} ${flat} ${fence}`;
}

const codes = (texts: readonly string[], empty = '—'): string =>
  texts.length === 0 ? empty : texts.map(mdCode).join('<br>');
const codeList = (texts: readonly string[], empty = 'none'): string =>
  texts.length === 0 ? empty : texts.map(mdCode).join(', ');
const change = (status: string | null): string => status ?? '—';
const plural = (count: number, one: string, many = `${one}s`): string =>
  `${count} ${count === 1 ? one : many}`;
/** Thousands separators, without locale data. */
export const formatCount = (value: number): string =>
  String(value).replace(/\B(?=(\d{3})+(?!\d))/g, ',');

/** `[run <id>](url)`; the url only when it is an https link. */
export function runLink(run: RunInfo): string {
  const label = `run ${run.id}${run.attempt > 1 ? ` (attempt ${run.attempt})` : ''}`;
  return run.url !== null && /^https:\/\/[^\s()<>]+$/.test(run.url)
    ? `[${label}](${run.url})`
    : label;
}

export function completenessLine(report: ScenarioMapReport): string {
  const { shards, complete } = report.completeness;
  const counted = `${shards.complete} of ${shards.planned} shards complete`;
  if (complete) return `**Complete run**: ${counted}.`;
  const missing = shards.incomplete.map((entry) => `shard ${mdCode(entry.shard)}: ${entry.reason}`);
  return `**Partial run**: ${counted}${missing.length > 0 ? `; ${missing.join('; ')}` : ''}.`;
}

export function degradedLine(report: ScenarioMapReport): string {
  const flags = report.completeness.degraded;
  if (flags.length === 0) return '**Degraded**: none.';
  return `**Degraded**: ${flags.map((flag) => `${mdCode(flag)} (${DEGRADED_TEXT[flag]})`).join('; ')}.`;
}

export function baselineLine(report: ScenarioMapReport): string {
  const { changes } = report;
  if (changes.state === 'first-run') return `**Baseline**: ${BANNERS['first-run']}.`;
  if (changes.state === 'incompatible') {
    return `**Baseline**: ${BANNERS.incompatible} (${changes.reason ?? 'unknown'}); no change is shown.`;
  }
  const counts = changes.counts;
  const since = changes.baseline?.runId ?? 'unknown';
  return (
    `**Since run ${mdCode(since)}**: ${counts?.new ?? 0} new, ${counts?.changed ?? 0} changed, ` +
    `${counts?.unchanged ?? 0} unchanged, ${counts?.resolved ?? 0} resolved.`
  );
}

/** One line naming the run, its ref, revision and versions. */
export function runLine(report: ScenarioMapReport): string {
  const revision = report.provenance.sourceRevision;
  return [
    `${runLink(report.run)}${report.run.ref === null ? '' : ` on ${mdCode(report.run.ref)}`}`,
    ...(revision === null ? [] : [`revision ${mdCode(revision.slice(0, 12))}`]),
    `${report.eligibility.mode} mode`,
    `schema ${report.schemaVersion}`,
    `verdict engine ${report.engineVersion}`,
    `fingerprint engine ${report.fingerprint.engineVersion}`,
    `seed ${mdCode(report.seed)}`,
  ].join(' · ');
}

export const pairTests = (pair: Pick<ReportPair, 'a' | 'b'>): string =>
  `${mdCode(pair.a)}<br>${mdCode(pair.b)}`;

/** The stage results behind a pair, in one line. */
export function evidenceSummary(pair: ReportPair): string {
  const e = pair.evidence;
  const values = e.discardedValues === null ? '' : `, values ${e.discardedValues}`;
  const unknown = e.unknown > 0 ? `, ${e.unknown} unknown` : '';
  return [
    `path ${e.path ?? 'unknown'}`,
    `checks ${e.checksContext}`,
    `facet ${e.facet}${values}`,
    `kills ${e.killSets} (${e.killsA}/${e.killsB} of ${e.universe}${unknown})`,
    `row ${e.rowDeletion}`,
    `trace ${e.trace}`,
    `static ${e.staticValueFlow}`,
    `isolation ${e.isolation}`,
  ].join(' · ');
}

const mutantLabel = (id: string): string => {
  const parsed = parseGlobalMutantId(id);
  return parsed === null
    ? id
    : `${parsed.location.start.line}:${parsed.location.start.column} ${parsed.mutator}`;
};

// ── Sections ───────────────────────────────────────────────────────────────

export function mutationLine(report: ScenarioMapReport): string {
  return `**Mutation evidence**: ${MUTATION_SCOPE_TEXT[report.mutation]}.`;
}

/** A fingerprint's three parts and the trace, in one line. */
export function fingerprintEvidence(pair: ReportFingerprintPair): string {
  const e = pair.evidence;
  const values = e.values === null ? '' : `, values ${e.values}`;
  const unresolved = e.unresolved.length === 0 ? '' : `, ${e.unresolved.length} unresolved`;
  return `path ${e.path}, checks ${e.checks}, input ${e.facet}${values}, trace ${e.trace}${unresolved}`;
}

function fingerprintSummarySection(report: ScenarioMapReport): string[] {
  const { byVerdict } = report.fingerprint;
  return [
    '## Scenario fingerprint',
    '',
    'Two tests are duplicates when they run the same execution path on the same input data and ' +
      'check the same expectation.',
    '',
    '| Fingerprint verdict | Pairs |',
    '|---------------------|-------|',
    ...FINGERPRINT_VERDICTS.map((verdict) => `| ${verdict} | ${byVerdict[verdict]} |`),
  ];
}

function fingerprintSection(
  verdict: FingerprintVerdict,
  pairs: readonly ReportFingerprintPair[],
): string[] {
  if (pairs.length === 0) return [];
  return [
    '',
    `## ${FINGERPRINT_TITLES[verdict]} (${pairs.length})`,
    '',
    FINGERPRINT_ACTIONS[verdict],
    '',
    '| Tests | Rule | Details | Evidence |',
    '|-------|------|---------|----------|',
    ...pairs.map(
      (pair) =>
        `| ${pairTests(pair)} | ${mdCode(pair.rule)} | ${codes(pair.details)} | ` +
        `${mdCode(fingerprintEvidence(pair))} |`,
    ),
  ];
}

function fingerprintKeptSection(kept: readonly ReportFingerprintPair[]): string[] {
  if (kept.length === 0) return [];
  return [
    '',
    `## Fingerprint pairs kept by \`// dupe-ok:\` (${kept.length})`,
    '',
    'A human keep on either test (R15); the verdict and evidence are still recorded.',
    '',
    '| Tests | Keep | Verdict | Rule |',
    '|-------|------|---------|------|',
    ...kept.map(
      (pair) =>
        `| ${pairTests(pair)} | ${codes(pair.keep.map((mark) => mark.reason))} | ` +
        `${pair.verdict} | ${mdCode(pair.rule)} |`,
    ),
  ];
}

function summarySection(report: ScenarioMapReport): string[] {
  const s = report.summary;
  return [
    '## Summary',
    '',
    `${plural(s.pairs, 'candidate pair')} judged, ${s.kept} kept by \`// dupe-ok:\`.`,
    '',
    '| Verdict | Pairs |',
    '|---------|-------|',
    ...VERDICT_PRECEDENCE.map((verdict) => `| ${verdict} | ${s.byVerdict[verdict]} |`),
    '',
    '| Test status | Tests |',
    '|-------------|-------|',
    ...Object.entries(s.testsByStatus).map(([status, count]) => `| ${status} | ${count} |`),
    `| subsumed | ${s.subsumed} |`,
    `| subsumption unknown | ${s.subsumptionUnknown} |`,
    '',
    `Gaps: ${plural(s.gapFiles, 'production file')} with a survived or uncovered mutant; ` +
      `${s.survived} ${WORDING.survived}, ${s.uncovered} ${WORDING.uncovered}, ` +
      `${s.inconclusiveMutants} inconclusive.`,
  ];
}

function changesSection(report: ScenarioMapReport): string[] {
  const { changes } = report;
  const lines = ['## Changes since the last complete run', '', baselineLine(report)];
  if (changes.state === 'first-run') return [...lines, '', 'Every item is new.'];
  if (changes.state === 'incompatible') return lines;
  const labels = new Map(report.continuity.items.map((item) => [item.key, item.label]));
  const shown = changes.changes.filter((entry) => entry.status !== 'unchanged');
  if (shown.length === 0 && changes.resolved.length === 0) {
    return [...lines, '', 'Nothing is new, changed or resolved.'];
  }
  return [
    ...lines,
    '',
    '| Change | Kind | Item |',
    '|--------|------|------|',
    ...shown.map(
      (entry) =>
        `| ${entry.status} | ${entry.kind} | ${mdCode(labels.get(entry.key) ?? entry.key)} |`,
    ),
    ...changes.resolved.map((entry) => `| resolved | ${entry.kind} | ${mdCode(entry.label)} |`),
  ];
}

function strongSection(pairs: readonly ReportPair[]): string[] {
  return [
    `## ${VERDICT_TITLES['repeat-strong']} (${pairs.length})`,
    '',
    VERDICT_ACTIONS['repeat-strong'],
    ...(pairs.length === 0
      ? []
      : [
          '',
          '| Tests | Kills | Universe | Evidence | Evidence hash | Change |',
          '|-------|-------|----------|----------|---------------|--------|',
          ...pairs.map(
            (pair) =>
              `| ${pairTests(pair)} | ${pair.evidence.killsA} of ${pair.universe.size} | ` +
              `${mdCode(pair.universe.id ?? '-')} | ${mdCode(evidenceSummary(pair))} | ` +
              `${mdCode(pair.evidenceHash)} | ${change(pair.change)} |`,
          ),
        ]),
  ];
}

function spotAuditSection(report: ScenarioMapReport): string[] {
  const audit = report.spotAudit;
  return [
    `## Spot audit (seed ${mdCode(audit.seed)}, ${audit.picks.length} of ${audit.candidates} duplicates)`,
    '',
    `For human verification (design §8): up to ${audit.size} fingerprint duplicates, ` +
      `ordered by ${audit.method}.`,
    ...(audit.picks.length === 0
      ? []
      : ['', ...audit.picks.map((pick, i) => `${i + 1}. ${mdCode(pick.a)} + ${mdCode(pick.b)}`)]),
  ];
}

function verdictSection(verdict: Verdict, pairs: readonly ReportPair[]): string[] {
  if (pairs.length === 0) return [];
  const disqualifiers = (pair: ReportPair): string =>
    codes(pair.disqualifiers.map((entry) => entry.kind));
  return [
    '',
    `## ${VERDICT_TITLES[verdict]} (${pairs.length})`,
    '',
    VERDICT_ACTIONS[verdict],
    '',
    '| Tests | Rule | Details | Disqualifiers | Evidence | Change |',
    '|-------|------|---------|---------------|----------|--------|',
    ...pairs.map(
      (pair) =>
        `| ${pairTests(pair)} | ${mdCode(pair.rule)} | ${codes(pair.details)} | ` +
        `${disqualifiers(pair)} | ${mdCode(evidenceSummary(pair))} | ${change(pair.change)} |`,
    ),
  ];
}

function keptSection(kept: readonly ReportPair[]): string[] {
  if (kept.length === 0) return [];
  return [
    '',
    `## Kept by \`// dupe-ok:\` (${kept.length})`,
    '',
    'A human keep on either test (R15); the verdict and evidence are still recorded.',
    '',
    '| Tests | Keep | Verdict | Rule | Change |',
    '|-------|------|---------|------|--------|',
    ...kept.map(
      (pair) =>
        `| ${pairTests(pair)} | ${codes(pair.keep.map((mark) => mark.reason))} | ` +
        `${pair.verdict} | ${mdCode(pair.rule)} | ${change(pair.change)} |`,
    ),
  ];
}

function testSections(tests: readonly ReportTest[]): string[] {
  const weak = tests.filter((test) => test.status === 'weak');
  const subsumed = tests.filter((test) => test.subsumption.status === 'subsumed');
  const unknown = tests.filter((test) => test.subsumption.status === 'unknown');
  const inconclusive = tests.filter((test) => test.status === 'inconclusive');
  const outOfScope = tests.filter((test) => test.status === 'out-of-scope');
  const table = (
    title: string,
    intro: string,
    head: string,
    rows: readonly ReportTest[],
    row: (test: ReportTest) => string,
  ): string[] =>
    rows.length === 0
      ? []
      : [
          '',
          `## ${title} (${rows.length})`,
          '',
          intro,
          '',
          head,
          head.replace(/[^|]/g, '-'),
          ...rows.map(row),
        ];
  return [
    ...table(
      'Weak tests',
      `Each covers evaluated mutants but ${WORDING.weak}. Strengthen or delete (human).`,
      '| Test | Covered mutants | Change |',
      weak,
      (test) => `| ${mdCode(test.id)} | ${test.covered} | ${change(test.change)} |`,
    ),
    ...table(
      'Subsumed tests',
      `Reported as "${WORDING.subsumed}"; never a removal suggestion on its own.`,
      '| Test | Kills | Subsumed by | Change |',
      subsumed,
      (test) =>
        `| ${mdCode(test.id)} | ${test.kills} | ${codes(test.subsumption.by)} | ${change(test.change)} |`,
    ),
    ...table(
      'Subsumption unknown',
      'A test that might subsume it was not evaluated on its whole universe.',
      '| Test | Might be subsumed by |',
      unknown,
      (test) => `| ${mdCode(test.id)} | ${codes(test.subsumption.by)} |`,
    ),
    ...table(
      'Inconclusive tests',
      'Not evaluated, or an exposed result is invalid or not an assertion outcome.',
      '| Test | Reasons |',
      inconclusive,
      (test) => `| ${mdCode(test.id)} | ${codes(test.reasons)} |`,
    ),
    ...table(
      'Out-of-scope tests',
      'Not eligible, or covering no evaluated mutant.',
      '| Test | Reasons |',
      outOfScope,
      (test) => `| ${mdCode(test.id)} | ${codes(test.reasons)} |`,
    ),
  ];
}

function gapsSection(report: ScenarioMapReport): string[] {
  const files = report.gaps.filter((gap) => gap.survived.length > 0 || gap.uncovered.length > 0);
  return [
    '',
    `## Gaps per production file (${files.length})`,
    '',
    `Mutants that ${WORDING.survived} (equivalent mutants included) or are ` +
      `${WORDING.uncovered}, per production file.`,
    ...(files.length === 0
      ? []
      : [
          '',
          '| File | Mutants | Killed | Survived the selected tests | Uncovered by selected tests | Inconclusive | Change |',
          '|------|---------|--------|-----------------------------|-----------------------------|--------------|--------|',
          ...files.map(
            (gap) =>
              `| ${mdCode(gap.file)} | ${gap.mutants} | ${gap.killed} | ${gap.survived.length} | ` +
              `${gap.uncovered.length} | ${gap.inconclusive.length} | ${change(gap.change)} |`,
          ),
          '',
          ...files.map(
            (gap) =>
              `- ${mdCode(gap.file)}: survived ${codeList(gap.survived.map(mutantLabel))}; ` +
              `uncovered ${codeList(gap.uncovered.map(mutantLabel))}`,
          ),
        ]),
  ];
}

function layer0Lines(report: ScenarioMapReport): string[] {
  const { layer0 } = report;
  const lines = ['', `## Layer 0 findings on eligible files (${layer0.findings.length})`, ''];
  if (!layer0.available) return [...lines, 'No Layer 0 scan output was given.'];
  const at = (location: { file: string; line: number }): string =>
    mdCode(`${location.file}:${location.line}`);
  return [
    ...lines,
    `The PR-time structural scan (\`npm run test:dupes -- --all\`) over ${layer0.scanned ?? '?'} ` +
      'files, kept to the eligible ones. Advisory only.',
    ...(layer0.findings.length === 0
      ? []
      : [
          '',
          '| Kind | At | Already at |',
          '|------|----|------------|',
          ...layer0.findings.map(
            (finding) =>
              `| ${mdCode(finding.kind)} | ${at(finding)} | ` +
              `${finding.matches.length === 0 ? '—' : finding.matches.map(at).join('<br>')} |`,
          ),
        ]),
    ...(layer0.skipped.length === 0 ? [] : ['', `Unparseable: ${codes(layer0.skipped)}.`]),
  ];
}

function eligibilitySection(report: ScenarioMapReport): string[] {
  const { eligibility } = report;
  const lines = [
    '',
    '## Eligibility',
    '',
    `${eligibility.mode} mode: the fingerprint covers ${plural(eligibility.fingerprintFiles, 'test file')}; ` +
      `${plural(eligibility.files.length, 'test file')} are mutation-eligible.`,
    ...(eligibility.changedFiles === null
      ? []
      : [
          `Diff scope: only pairs with a test in the ${plural(eligibility.changedFiles.length, 'changed test file')} ` +
            'were looked for' +
            (eligibility.changedFiles.length === 0
              ? '.'
              : `: ${eligibility.changedFiles.map((file) => `\`${file}\``).join(', ')}.`),
        ]),
    ...(eligibility.layer1Files === eligibility.fingerprintFiles
      ? []
      : [
          eligibility.changedFiles === null
            ? `Layer 1 ran ${eligibility.layer1Files} of them; every test of the other ` +
              `${eligibility.fingerprintFiles - eligibility.layer1Files} has a checks-and-context ` +
              'key no other test shares, so none of their pairs can be a duplicate, a possible ' +
              'duplicate or a table row.'
            : `Layer 1 ran ${eligibility.layer1Files} of them: the changed files and the files ` +
              "sharing their tests' checks-and-context keys; no test of another file can be a " +
              "changed test's duplicate, possible duplicate or table row.",
        ]),
    ...(eligibility.notRun.skipped + eligibility.notRun.unfinished === 0
      ? []
      : [
          `No fingerprint for ${plural(eligibility.notRun.skipped, 'test')} skipped at run time ` +
            '(`skip`, `skipIf` or `todo`, such as the `GITNEXUS_BENCH` benchmark suites) and ' +
            `${plural(eligibility.notRun.unfinished, 'test')} that never finished (their file's ` +
            'run ended first).',
        ]),
  ];
  const delta = eligibility.delta;
  if (delta === null) return [...lines, 'The Phase 0 envelope is not consulted in this mode.'];
  return [
    ...lines,
    '',
    `Accepted by the classifier but not validated by gate 1 (${delta.notValidated.length}): ` +
      `${codeList(delta.notValidated)}.`,
    '',
    `In the envelope but rejected now (${delta.rejected.length}): ` +
      `${
        delta.rejected.length === 0
          ? 'none'
          : delta.rejected
              .map((entry) => `${mdCode(entry.file)} (${entry.reasons.join(', ')})`)
              .join(', ')
      }.`,
  ];
}

function provenanceSection(report: ScenarioMapReport): string[] {
  const p = report.provenance;
  const hashes = (record: Record<string, string>): string =>
    codes(Object.entries(record).map(([file, hash]) => `${file} ${hash.slice(0, 12)}`));
  const fallbacks = Object.values(p.mutants.fallbacks).reduce((sum, count) => sum + count, 0);
  return [
    '',
    '## Provenance',
    '',
    'The design §7 cache-key inputs (KTD15). Full hashes are in the JSON report.',
    '',
    '| Input | Value |',
    '|-------|-------|',
    `| Source revision | ${mdCode(p.sourceRevision ?? 'unknown')} |`,
    `| Vitest · Stryker · TypeScript | ${mdCode(
      [p.versions.vitest, p.versions.stryker, p.versions.typescript]
        .map((version) => version ?? 'not installed')
        .join(' · '),
    )} |`,
    `| Runner (module hash) | ${mdCode(p.versions.runner.slice(0, 12))} |`,
    `| Operators | Stryker default set; observed ${codeList(p.operators.names)} |`,
    `| Node · OS | ${mdCode(`${p.runtime.node} · ${p.runtime.os}`)} |`,
    `| GITNEXUS_* | ${codes(Object.entries(p.runtime.env).map(([name, value]) => `${name}=${value}`))} |`,
    `| Lockfiles | ${hashes(p.lockfiles)} |`,
    `| Configs | ${hashes(p.configs)} |`,
    `| Files hashed | ${Object.keys(p.files.tests).length} test, ${Object.keys(p.files.production).length} production, ${Object.keys(p.files.fixtures).length} fixture |`,
    `| Universes | ${p.universes.length} |`,
    `| Mutants | ${p.mutants.total}, ${fallbacks} named by their revision-pinned id |`,
  ];
}

/** The full report as markdown; see the module comment. */
function mutationSections(report: ScenarioMapReport): string[] {
  if (report.mutation === 'none') {
    return [
      '',
      '## Mutation evidence',
      '',
      `${mutationLine(report)} Kill sets, weak tests and gaps need a run with mutation (workflow ` +
        'dispatch input `mutation`, or the `scenario-map` label on a pull request).',
    ];
  }
  const byVerdict = (verdict: Verdict): ReportPair[] =>
    report.pairs.filter((pair) => pair.verdict === verdict);
  return [
    '',
    '## Mutation evidence',
    '',
    `${mutationLine(report)} **${report.summary.evaluated}.**`,
    '',
    ...summarySection(report),
    '',
    ...changesSection(report),
    '',
    ...strongSection(byVerdict('repeat-strong')),
    ...VERDICT_PRECEDENCE.filter((verdict) => verdict !== 'repeat-strong').flatMap((verdict) =>
      verdictSection(verdict, byVerdict(verdict)),
    ),
    ...keptSection(report.kept),
    ...testSections(report.tests),
    ...gapsSection(report),
  ];
}

export function renderMarkdown(report: ScenarioMapReport): string {
  const fingerprints = (verdict: FingerprintVerdict): ReportFingerprintPair[] =>
    report.fingerprint.pairs.filter((pair) => pair.verdict === verdict);
  const lines = [
    '# Test scenario map',
    '',
    runLine(report),
    '',
    `- ${mutationLine(report)}`,
    `- ${completenessLine(report)}`,
    `- ${degradedLine(report)}`,
    `- ${baselineLine(report)}`,
    '',
    '## Limits',
    '',
    ...report.limits.map((limit) => `- ${limit}`),
    '',
    ...fingerprintSummarySection(report),
    ...fingerprintSection('duplicate', fingerprints('duplicate')),
    '',
    ...spotAuditSection(report),
    ...FINGERPRINT_VERDICTS.filter(
      (verdict) => verdict !== 'duplicate' && verdict !== 'distinct',
    ).flatMap((verdict) => fingerprintSection(verdict, fingerprints(verdict))),
    ...fingerprintKeptSection(report.fingerprint.kept),
    ...mutationSections(report),
    ...layer0Lines(report),
    ...eligibilitySection(report),
    ...provenanceSection(report),
  ];
  return `${lines.join('\n')}\n`;
}

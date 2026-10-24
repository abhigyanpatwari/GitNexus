/**
 * Tracking issue body of the scenario map (U13, R13, KTD13, design §5.5): one issue holds the
 * strong repeat candidates, the weak tests and the per-file gaps. Weak-evidence repeats, Row,
 * Review and Inconclusive pairs live in the report artifact only.
 *
 * Body ({@link renderIssueBody}):
 *  1. a run marker, alone on the first line ({@link runMarker}): an HTML comment with the run id
 *     and attempt that a later upsert reads back ({@link parseRunMarker}) to skip the update when
 *     the issue already records a newer run (KTD13). Only the first line is read, so a marker-like
 *     string inside a test title cannot forge it;
 *  2. the header: run link, completeness, every degraded flag, "N of M eligible tests evaluated",
 *     the baseline line and the precision-not-measured statement;
 *  3. strong repeat candidates, then weak tests, then per-file gaps; a complete run without any
 *     says "no strong repeat candidates, weak tests or gaps found".
 * Truncation: the body stays below {@link ISSUE_BODY_LIMIT} characters (GitHub caps a body at
 * 65,536). Rows are kept in order (strong, weak, gaps) until the next one would not fit; the rest
 * are dropped, and a count line, the body's last line, says how many of each are not shown.
 *
 * {@link shouldUpdateIssue} is the R13 rule an upsert applies: only a complete run from the default
 * branch updates the body, and never over a newer run (a later attempt of the same run is newer).
 * A partial run leaves the body alone (the workflow comments instead, KTD14).
 *
 * Library only; pure. The upsert job (U15) posts the body.
 */
import { WORDING } from '../verdict/verdict.js';
import {
  baselineLine,
  completenessLine,
  degradedLine,
  formatCount,
  mdCode,
  pairTests,
  runLink,
} from './markdown.js';
import { PRECISION_NOT_MEASURED, type RunInfo, type ScenarioMapReport } from './report.js';

/** Upper bound of the body's length, below GitHub's 65,536-character cap. */
export const ISSUE_BODY_LIMIT = 60_000;
export const NO_FINDINGS = 'no strong repeat candidates, weak tests or gaps found';

export interface RunMarker {
  runId: string;
  attempt: number;
}

const MARKER = /^<!-- scenario-map run-id=([A-Za-z0-9._-]+) attempt=(\d+) -->$/;
const DECIMAL = /^\d+$/;

/** The first line of a body: `<!-- scenario-map run-id=<id> attempt=<n> -->`. */
export function runMarker(run: Pick<RunInfo, 'id' | 'attempt'>): string {
  const id = run.id.replace(/[^A-Za-z0-9._-]/g, '_') || '_';
  return `<!-- scenario-map run-id=${id} attempt=${Math.max(0, Math.trunc(run.attempt))} -->`;
}

/** The marker on a body's first line; null when the first line is not one. */
export function parseRunMarker(body: string): RunMarker | null {
  const match = MARKER.exec(body.split('\n', 1)[0].trimEnd());
  return match === null ? null : { runId: match[1], attempt: Number(match[2]) };
}

/**
 * R13 and KTD13: whether `report` may replace `existingBody` (null when the issue does not exist
 * yet). Run ids must be decimal to be ordered; anything else never overwrites a marked body.
 */
export function shouldUpdateIssue(report: ScenarioMapReport, existingBody: string | null): boolean {
  if (!report.completeness.complete || !report.run.defaultBranch) return false;
  const recorded = existingBody === null ? null : parseRunMarker(existingBody);
  if (recorded === null) return true;
  if (!DECIMAL.test(report.run.id) || !DECIMAL.test(recorded.runId)) return false;
  const [current, previous] = [BigInt(report.run.id), BigInt(recorded.runId)];
  if (current !== previous) return current > previous;
  return report.run.attempt >= recorded.attempt;
}

interface Section {
  noun: string;
  title: string;
  intro: string;
  head: string;
  rows: string[];
}

function sectionsOf(report: ScenarioMapReport): Section[] {
  const strong = report.pairs.filter((pair) => pair.verdict === 'repeat-strong');
  const weak = report.tests.filter((test) => test.status === 'weak');
  const gaps = report.gaps.filter((gap) => gap.survived.length > 0 || gap.uncovered.length > 0);
  const change = (status: string | null): string => status ?? '—';
  return [
    {
      noun: 'strong repeat candidates',
      title: `### Strong repeat candidates (${strong.length})`,
      intro:
        'Same canonical path, checks, context, input facet and kill set, with every strong ' +
        'condition met. Human scenario review only; never a removal suggestion on its own.',
      head: '| Tests | Kills | Universe | Change |',
      rows: strong.map(
        (pair) =>
          `| ${pairTests(pair)} | ${pair.evidence.killsA} of ${pair.universe.size} | ` +
          `${mdCode(pair.universe.id ?? '-')} | ${change(pair.change)} |`,
      ),
    },
    {
      noun: 'weak tests',
      title: `### Weak tests (${weak.length})`,
      intro: `Each covers evaluated mutants but ${WORDING.weak}. Strengthen or delete (human).`,
      head: '| Test | Covered mutants | Change |',
      rows: weak.map((test) => `| ${mdCode(test.id)} | ${test.covered} | ${change(test.change)} |`),
    },
    {
      noun: 'gap files',
      title: `### Gaps per production file (${gaps.length})`,
      intro:
        `Mutants that ${WORDING.survived} (equivalent mutants included) or are ` +
        `${WORDING.uncovered}.`,
      head: '| File | Survived | Uncovered | Inconclusive | Killed | Change |',
      rows: gaps.map(
        (gap) =>
          `| ${mdCode(gap.file)} | ${gap.survived.length} | ${gap.uncovered.length} | ` +
          `${gap.inconclusive.length} | ${gap.killed} of ${gap.mutants} | ${change(gap.change)} |`,
      ),
    },
  ];
}

function headerOf(report: ScenarioMapReport): string[] {
  const revision = report.provenance.sourceRevision;
  return [
    runMarker(report.run),
    '## Test scenario map',
    '',
    `Report of ${runLink(report.run)}` +
      (report.run.ref === null ? '' : ` on ${mdCode(report.run.ref)}`) +
      (revision === null ? '' : ` at ${mdCode(revision.slice(0, 12))}`) +
      '. Weak-evidence repeats, Row, Review and Inconclusive pairs are in the report artifact.',
    '',
    `- ${completenessLine(report)}`,
    `- ${degradedLine(report)}`,
    `- **${report.summary.evaluated}.**`,
    `- ${baselineLine(report)}`,
    `- ${PRECISION_NOT_MEASURED}`,
  ];
}

const countLine = (limit: number, omitted: readonly number[], nouns: readonly string[]): string =>
  `Truncated below ${formatCount(limit)} characters: ` +
  `${omitted.reduce((sum, count) => sum + count, 0)} more rows not shown ` +
  `(${omitted.map((count, i) => `${count} ${nouns[i]}`).join(', ')}); ` +
  'the report artifact has every row.';

/** The issue body; see the module comment. */
export function renderIssueBody(
  report: ScenarioMapReport,
  limit: number = ISSUE_BODY_LIMIT,
): string {
  const header = headerOf(report).join('\n');
  const sections = sectionsOf(report);
  const nouns = sections.map((section) => section.noun);
  if (sections.every((section) => section.rows.length === 0)) {
    const run = report.completeness.complete ? 'Complete run' : 'Partial run';
    const scope = report.completeness.complete ? '' : ' in the shards that completed';
    return `${header}\n\n${run}: ${NO_FINDINGS}${scope}.\n`;
  }
  // Room for the worst-case count line, its blank line and the final newline.
  const reserve =
    countLine(
      limit,
      sections.map((section) => section.rows.length),
      nouns,
    ).length + 3;
  const budget = limit - 1 - reserve;
  let body = header;
  const omitted = sections.map(() => 0);
  let full = false;
  sections.forEach((section, i) => {
    if (section.rows.length === 0) return;
    const opening = [
      '',
      section.title,
      '',
      section.intro,
      '',
      section.head,
      section.head.replace(/[^|]/g, '-'),
    ].join('\n');
    if (full || body.length + opening.length + 1 + section.rows[0].length > budget) {
      full = true;
      omitted[i] = section.rows.length;
      return;
    }
    body += `\n${opening}`;
    for (const [shown, row] of section.rows.entries()) {
      if (body.length + 1 + row.length > budget) {
        full = true;
        omitted[i] = section.rows.length - shown;
        return;
      }
      body += `\n${row}`;
    }
  });
  return full ? `${body}\n\n${countLine(limit, omitted, nouns)}\n` : `${body}\n`;
}

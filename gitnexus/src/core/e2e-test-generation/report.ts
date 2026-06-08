import type {
  ImpactForRangesReport,
  ImpactForRangesSymbol,
} from '../pr-impact/impact-for-ranges-report.js';
import type { PrImpactReport, PrImpactRisk } from '../pr-impact/report.js';
import type { RegressionForensicsReport } from '../regression-forensics/report.js';

export const E2E_TEST_PLAN_SCHEMA_VERSION = 'e2e-test-plan.v1alpha1' as const;

export type E2ETestPlanConfidence = 'LOW' | 'MEDIUM' | 'HIGH';
export type E2ETestPlanPriority = 'LOW' | 'MEDIUM' | 'HIGH';
export type E2ETestPlanStatus = 'new_proposal' | 'covered_by_existing_spec';
export type E2ETestPlanImpactEvidenceMode = 'pr-impact' | 'impact-for-ranges';

export interface E2ETestTargetContract {
  app: string;
  framework: string;
  browser: string;
  backendUrl: string;
  frontendUrl: string;
  fixturePolicy: string;
}

export interface E2ERouteEvidence {
  route: string;
  consumers: number;
  mismatches: number;
  evidence?: string;
}

export interface E2EExistingScenario {
  name: string;
  filePath: string;
  covers: string[];
}

interface E2ETestPlanInputBase {
  target: E2ETestTargetContract;
  regressionForensicsReport?: RegressionForensicsReport;
  routeEvidence: E2ERouteEvidence[];
  existingScenarios: E2EExistingScenario[];
}

type E2ETestPlanPrImpactInput = E2ETestPlanInputBase & {
  prImpactReport: PrImpactReport;
  impactForRangesReport?: never;
};

type E2ETestPlanImpactForRangesInput = E2ETestPlanInputBase & {
  prImpactReport?: never;
  impactForRangesReport: ImpactForRangesReport;
};

export type E2ETestPlanInput = E2ETestPlanPrImpactInput | E2ETestPlanImpactForRangesInput;

export interface E2ETestPlanProposal {
  id: string;
  title: string;
  priority: E2ETestPlanPriority;
  status: E2ETestPlanStatus;
  target_spec: string;
  existing_spec?: string;
  evidence: string[];
}

export interface E2ETestPlanReport {
  schema_version: typeof E2E_TEST_PLAN_SCHEMA_VERSION;
  confidence: E2ETestPlanConfidence;
  target: E2ETestTargetContract;
  summary: {
    proposed_scenarios: number;
    covered_by_existing_spec: number;
    new_proposals: number;
    high_priority: number;
  };
  source_reports: {
    impact_evidence_mode: E2ETestPlanImpactEvidenceMode;
    impact_schema_version: string;
    impact_verdict?: string;
    impact_indexed_commit?: string;
    regression_forensics_schema_version?: string;
    regression_forensics_confidence?: string;
  };
  proposals: E2ETestPlanProposal[];
  caveats: string[];
}

const riskRank: Record<PrImpactRisk, number> = {
  LOW: 1,
  MEDIUM: 2,
  HIGH: 3,
  CRITICAL: 4,
  UNKNOWN: 0,
};

const priorityForRisk = (risk: PrImpactRisk): E2ETestPlanPriority => {
  if (risk === 'CRITICAL' || risk === 'HIGH') return 'HIGH';
  if (risk === 'MEDIUM') return 'MEDIUM';
  return 'LOW';
};

const priorityRank: Record<E2ETestPlanPriority, number> = {
  LOW: 1,
  MEDIUM: 2,
  HIGH: 3,
};

const slugify = (value: string): string =>
  value
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .replace(/[^a-zA-Z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase();

const routeSlug = (route: string): string => slugify(route.replace(/^\/+/, '') || 'root');

const findExistingScenario = (
  existingScenarios: E2EExistingScenario[],
  target: string,
): E2EExistingScenario | undefined =>
  existingScenarios.find((scenario) => scenario.covers.includes(target));

const proposalStatusFor = (
  existingScenario: E2EExistingScenario | undefined,
): E2ETestPlanStatus => (existingScenario ? 'covered_by_existing_spec' : 'new_proposal');

const routeEvidenceFor = (
  routeEvidence: E2ERouteEvidence[],
  route: string,
): E2ERouteEvidence | undefined => routeEvidence.find((candidate) => candidate.route === route);

const isPrImpactInput = (input: E2ETestPlanInput): input is E2ETestPlanPrImpactInput =>
  'prImpactReport' in input && input.prImpactReport !== undefined;

const symbolFileFor = (report: PrImpactReport, symbolId: string, symbolName: string): string =>
  report.mapped_symbols.find(
    (symbol) => symbol.id === symbolId || symbol.name === symbolName,
  )?.filePath ?? '';

const shouldSkipSymbolProposal = (filePath: string): boolean => {
  const normalized = filePath.replace(/\\/g, '/');
  if (!normalized) return false;
  return (
    /(^|\/)app\/api\/.+\/route\.[tj]sx?$/.test(normalized) ||
    /(^|\/)api\/.*\/route\.[tj]sx?$/.test(normalized) ||
    /(^|\/)src\/server\/api\.[tj]sx?$/.test(normalized)
  );
};

const shouldSkipPrImpactSymbolProposal = (
  report: PrImpactReport,
  symbolId: string,
  symbolName: string,
): boolean => shouldSkipSymbolProposal(symbolFileFor(report, symbolId, symbolName));

const routeProposal = (
  input: E2ETestPlanPrImpactInput,
  apiImpact: PrImpactReport['api_impacts'][number],
): E2ETestPlanProposal => {
  const existingScenario = findExistingScenario(input.existingScenarios, apiImpact.route);
  const routeEvidence = routeEvidenceFor(input.routeEvidence, apiImpact.route);
  const evidence = [
    `Route ${apiImpact.route} has risk ${apiImpact.risk}`,
    `Consumers: ${routeEvidence?.consumers ?? apiImpact.consumers}`,
    `Mismatches: ${routeEvidence?.mismatches ?? apiImpact.mismatches}`,
  ];
  if (routeEvidence?.evidence) evidence.push(routeEvidence.evidence);

  return {
    id: `route-${routeSlug(apiImpact.route)}`,
    title: `Exercise route ${apiImpact.route} after impacted API change`,
    priority: priorityForRisk(apiImpact.risk),
    status: proposalStatusFor(existingScenario),
    target_spec: existingScenario?.filePath ?? `gitnexus-web/e2e/${routeSlug(apiImpact.route)}.spec.ts`,
    existing_spec: existingScenario?.filePath,
    evidence,
  };
};

const symbolProposal = (
  input: E2ETestPlanPrImpactInput,
  impact: PrImpactReport['impacts'][number],
): E2ETestPlanProposal => {
  const existingScenario = findExistingScenario(input.existingScenarios, impact.symbolName);
  return {
    id: `symbol-${slugify(impact.symbolName)}`,
    title: `Add E2E scenario for changed surface ${impact.symbolName}`,
    priority: priorityForRisk(impact.risk),
    status: proposalStatusFor(existingScenario),
    target_spec: existingScenario?.filePath ?? `gitnexus-web/e2e/${slugify(impact.symbolName)}.spec.ts`,
    existing_spec: existingScenario?.filePath,
    evidence: [
      `Risk: ${impact.risk}`,
      `Direct dependents: ${impact.direct}`,
      `Processes affected: ${impact.processesAffected}`,
      `Test reference: ${impact.testReference}`,
    ],
  };
};

const impactForRangesPriority = (symbol: ImpactForRangesSymbol): E2ETestPlanPriority => {
  if (symbol.change_types.includes('deleted')) return 'HIGH';
  if ((symbol.processes?.length ?? 0) > 0) return 'MEDIUM';
  return 'LOW';
};

const routePriorityFromEvidence = (
  route: E2ERouteEvidence,
  input: E2ETestPlanImpactForRangesInput,
): E2ETestPlanPriority => {
  if (route.mismatches > 0) return 'HIGH';
  if (route.consumers > 0 || input.impactForRangesReport.summary.symbols_with_processes > 0) {
    return 'MEDIUM';
  }
  return 'LOW';
};

const explicitRangeRouteProposal = (
  input: E2ETestPlanImpactForRangesInput,
  route: E2ERouteEvidence,
): E2ETestPlanProposal => {
  const existingScenario = findExistingScenario(input.existingScenarios, route.route);
  const evidence = [
    'Impact evidence mode: impact-for-ranges',
    'Route/API prioritization derived from supplied route evidence rather than classic PR-impact api_impacts',
    `Consumers: ${route.consumers}`,
    `Mismatches: ${route.mismatches}`,
  ];
  if (route.evidence) evidence.push(route.evidence);

  return {
    id: `route-${routeSlug(route.route)}`,
    title: `Exercise route ${route.route} after impacted API change`,
    priority: routePriorityFromEvidence(route, input),
    status: proposalStatusFor(existingScenario),
    target_spec: existingScenario?.filePath ?? `gitnexus-web/e2e/${routeSlug(route.route)}.spec.ts`,
    existing_spec: existingScenario?.filePath,
    evidence,
  };
};

const explicitRangeSymbolProposal = (
  input: E2ETestPlanImpactForRangesInput,
  symbol: ImpactForRangesSymbol,
): E2ETestPlanProposal => {
  const existingScenario = findExistingScenario(input.existingScenarios, symbol.name);
  return {
    id: `symbol-${slugify(symbol.name)}`,
    title: `Add E2E scenario for changed surface ${symbol.name}`,
    priority: impactForRangesPriority(symbol),
    status: proposalStatusFor(existingScenario),
    target_spec: existingScenario?.filePath ?? `gitnexus-web/e2e/${slugify(symbol.name)}.spec.ts`,
    existing_spec: existingScenario?.filePath,
    evidence: [
      'Impact evidence mode: impact-for-ranges',
      `Change types: ${symbol.change_types.join(', ') || 'modified'}`,
      `Matched ranges: ${symbol.matched_ranges.length}`,
      `Direct processes: ${symbol.processes?.length ?? 0}`,
      symbol.reason ?? 'Explicit-range evidence provided direct symbol-level change evidence.',
    ],
  };
};

const buildPrImpactProposals = (input: E2ETestPlanPrImpactInput): E2ETestPlanProposal[] => [
  ...input.prImpactReport.api_impacts.map((apiImpact) => routeProposal(input, apiImpact)),
  ...input.prImpactReport.impacts
    .filter(
      (impact) =>
        impact.testReference === 'unknown_or_unreferenced' &&
        riskRank[impact.risk] >= riskRank.MEDIUM &&
        !shouldSkipPrImpactSymbolProposal(input.prImpactReport, impact.symbolId, impact.symbolName),
    )
    .map((impact) => symbolProposal(input, impact)),
];

const buildExplicitRangeProposals = (
  input: E2ETestPlanImpactForRangesInput,
): E2ETestPlanProposal[] => [
  ...input.routeEvidence.map((route) => explicitRangeRouteProposal(input, route)),
  ...[...input.impactForRangesReport.symbols, ...input.impactForRangesReport.unmapped_symbols]
    .filter((symbol) => !shouldSkipSymbolProposal(symbol.filePath ?? ''))
    .map((symbol) => explicitRangeSymbolProposal(input, symbol)),
];

const buildProposals = (input: E2ETestPlanInput): E2ETestPlanProposal[] => {
  const proposals = isPrImpactInput(input)
    ? buildPrImpactProposals(input)
    : buildExplicitRangeProposals(input);

  return proposals.sort((a, b) => {
    const priorityDelta = priorityRank[b.priority] - priorityRank[a.priority];
    if (priorityDelta !== 0) return priorityDelta;
    if (a.status !== b.status) return a.status === 'new_proposal' ? -1 : 1;
    return a.title.localeCompare(b.title);
  });
};

const computeConfidence = (input: E2ETestPlanInput): E2ETestPlanConfidence => {
  if (!input.target.app || !input.target.framework || !input.target.backendUrl) return 'LOW';

  if (isPrImpactInput(input)) {
    if (input.prImpactReport.graph.freshness !== 'fresh') return 'LOW';
    if (input.prImpactReport.verdict === 'BLOCK' || input.regressionForensicsReport) return 'MEDIUM';
    return 'LOW';
  }

  if (!input.impactForRangesReport.repo.indexed_commit) return 'LOW';
  if (
    input.impactForRangesReport.summary.symbols_with_processes > 0 ||
    input.routeEvidence.length > 0 ||
    input.regressionForensicsReport
  ) {
    return 'MEDIUM';
  }
  return 'LOW';
};

const buildCaveats = (input: E2ETestPlanInput): string[] => {
  const caveats: string[] = [];

  if (isPrImpactInput(input)) {
    if (input.prImpactReport.graph.freshness !== 'fresh') {
      caveats.push('PR Impact graph evidence is stale; generated-test planning is advisory only.');
    }
    caveats.push(...input.prImpactReport.caveats);
  } else {
    if (!input.impactForRangesReport.repo.indexed_commit) {
      caveats.push(
        'Impact-for-ranges input did not report an indexed commit; generated-test planning is advisory only.',
      );
    }
    if (input.impactForRangesReport.summary.unmatched_ranges > 0) {
      caveats.push(
        `Explicit-range evidence left ${input.impactForRangesReport.summary.unmatched_ranges} input range(s) unmatched.`,
      );
    }
    if (input.impactForRangesReport.summary.unknown_symbols > 0) {
      caveats.push(
        `Explicit-range evidence reported ${input.impactForRangesReport.summary.unknown_symbols} unknown symbol(s).`,
      );
    }
    if (input.impactForRangesReport.summary.unmapped_symbols > 0) {
      caveats.push(
        `Explicit-range evidence reported ${input.impactForRangesReport.summary.unmapped_symbols} symbol(s) without direct process evidence.`,
      );
    }
    caveats.push(
      'Impact-for-ranges evidence mode does not include classic PR-impact verdicts, api_impacts, or graph-derived test signal.',
    );
    if (input.routeEvidence.length > 0) {
      caveats.push(
        'Route/API prioritization in impact-for-ranges mode is inferred from supplied route evidence rather than classic PR-impact api_impacts.',
      );
    } else {
      caveats.push(
        'No route/API evidence was supplied, so impact-for-ranges mode can only propose symbol-driven scenarios.',
      );
    }
    caveats.push(...input.impactForRangesReport.caveats);
  }

  caveats.push('V1 proposes scenarios only; it does not generate executable test files.');
  caveats.push(
    'Browser execution, generated Playwright files, CI mutation, and GitHub automation are out of scope.',
  );
  return Array.from(new Set(caveats));
};

export const buildE2ETestPlanReport = (input: E2ETestPlanInput): E2ETestPlanReport => {
  const proposals = buildProposals(input);
  return {
    schema_version: E2E_TEST_PLAN_SCHEMA_VERSION,
    confidence: computeConfidence(input),
    target: input.target,
    summary: {
      proposed_scenarios: proposals.length,
      covered_by_existing_spec: proposals.filter(
        (proposal) => proposal.status === 'covered_by_existing_spec',
      ).length,
      new_proposals: proposals.filter((proposal) => proposal.status === 'new_proposal').length,
      high_priority: proposals.filter((proposal) => proposal.priority === 'HIGH').length,
    },
    source_reports: {
      impact_evidence_mode: isPrImpactInput(input) ? 'pr-impact' : 'impact-for-ranges',
      impact_schema_version: isPrImpactInput(input)
        ? input.prImpactReport.schema_version
        : input.impactForRangesReport.schema_version,
      impact_verdict: isPrImpactInput(input) ? input.prImpactReport.verdict : undefined,
      impact_indexed_commit: isPrImpactInput(input)
        ? input.prImpactReport.graph.indexedCommit
        : input.impactForRangesReport.repo.indexed_commit,
      regression_forensics_schema_version: input.regressionForensicsReport?.schema_version,
      regression_forensics_confidence: input.regressionForensicsReport?.confidence,
    },
    proposals,
    caveats: buildCaveats(input),
  };
};

const tableCell = (value: string): string => value.replace(/\|/g, '\\|');

const pushTable = (lines: string[], headers: string[], rows: string[][]): void => {
  lines.push(`| ${headers.join(' | ')} |`);
  lines.push(`| ${headers.map(() => '---').join(' | ')} |`);
  for (const row of rows) lines.push(`| ${row.map(tableCell).join(' | ')} |`);
};

export const renderE2ETestPlanMarkdown = (report: E2ETestPlanReport): string => {
  const lines: string[] = [
    '# GitNexus E2E Test Plan Report',
    '',
    `Confidence: ${report.confidence}`,
    '',
    `Schema: ${report.schema_version}`,
    '',
    '## Target Contract',
    '',
    `- App: ${report.target.app}`,
    `- Framework: ${report.target.framework}`,
    `- Browser: ${report.target.browser}`,
    `- Backend: ${report.target.backendUrl}`,
    `- Frontend: ${report.target.frontendUrl}`,
    `- Fixture policy: ${report.target.fixturePolicy}`,
    '',
    '## Summary',
    '',
    `- Proposed scenarios: ${report.summary.proposed_scenarios}`,
    `- Covered by existing spec: ${report.summary.covered_by_existing_spec}`,
    `- New proposals: ${report.summary.new_proposals}`,
    `- High priority: ${report.summary.high_priority}`,
    `- Impact evidence mode: ${report.source_reports.impact_evidence_mode}`,
    `- Source impact verdict: ${report.source_reports.impact_verdict ?? 'not available in impact-for-ranges mode'}`,
    `- Regression Forensics confidence: ${
      report.source_reports.regression_forensics_confidence ?? 'not provided'
    }`,
  ];

  if (report.proposals.length > 0) {
    lines.push('', '## Proposed Scenarios', '');
    pushTable(
      lines,
      ['Scenario', 'Priority', 'Status', 'Target Spec', 'Evidence'],
      report.proposals.map((proposal) => [
        proposal.title,
        proposal.priority,
        proposal.status,
        proposal.target_spec,
        proposal.evidence.join('; '),
      ]),
    );
  }

  if (report.caveats.length > 0) {
    lines.push('', '## Caveats', '');
    for (const caveat of report.caveats) lines.push(`- ${caveat}`);
  }

  return lines.join('\n');
};

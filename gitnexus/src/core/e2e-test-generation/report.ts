import type { PrImpactReport, PrImpactRisk } from '../pr-impact/report.js';
import type { RegressionForensicsReport } from '../regression-forensics/report.js';

export const E2E_TEST_PLAN_SCHEMA_VERSION = 'e2e-test-plan.v1alpha1' as const;

export type E2ETestPlanConfidence = 'LOW' | 'MEDIUM' | 'HIGH';
export type E2ETestPlanPriority = 'LOW' | 'MEDIUM' | 'HIGH';
export type E2ETestPlanStatus = 'new_proposal' | 'covered_by_existing_spec';

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

export interface E2ETestPlanInput {
  target: E2ETestTargetContract;
  prImpactReport: PrImpactReport;
  regressionForensicsReport?: RegressionForensicsReport;
  routeEvidence: E2ERouteEvidence[];
  existingScenarios: E2EExistingScenario[];
}

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
    pr_impact_schema_version: string;
    pr_impact_verdict: string;
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

const symbolFileFor = (report: PrImpactReport, symbolId: string, symbolName: string): string =>
  report.mapped_symbols.find(
    (symbol) => symbol.id === symbolId || symbol.name === symbolName,
  )?.filePath ?? '';

const shouldSkipSymbolProposal = (
  report: PrImpactReport,
  symbolId: string,
  symbolName: string,
): boolean => {
  const filePath = symbolFileFor(report, symbolId, symbolName).replace(/\\/g, '/');
  return /(^|\/)api\/.*\/route\.[tj]sx?$/.test(filePath);
};

const routeProposal = (
  input: E2ETestPlanInput,
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
  input: E2ETestPlanInput,
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

const buildProposals = (input: E2ETestPlanInput): E2ETestPlanProposal[] => {
  const proposals = [
    ...input.prImpactReport.api_impacts.map((apiImpact) => routeProposal(input, apiImpact)),
    ...input.prImpactReport.impacts
      .filter(
        (impact) =>
          impact.testReference === 'unknown_or_unreferenced' &&
          riskRank[impact.risk] >= riskRank.MEDIUM &&
          !shouldSkipSymbolProposal(input.prImpactReport, impact.symbolId, impact.symbolName),
      )
      .map((impact) => symbolProposal(input, impact)),
  ];

  return proposals.sort((a, b) => {
    const priorityDelta = priorityRank[b.priority] - priorityRank[a.priority];
    if (priorityDelta !== 0) return priorityDelta;
    if (a.status !== b.status) return a.status === 'new_proposal' ? -1 : 1;
    return a.title.localeCompare(b.title);
  });
};

const computeConfidence = (input: E2ETestPlanInput): E2ETestPlanConfidence => {
  if (input.prImpactReport.graph.freshness !== 'fresh') return 'LOW';
  if (!input.target.app || !input.target.framework || !input.target.backendUrl) return 'LOW';
  if (input.prImpactReport.verdict === 'BLOCK' || input.regressionForensicsReport) return 'MEDIUM';
  return 'LOW';
};

const buildCaveats = (input: E2ETestPlanInput): string[] => {
  const caveats: string[] = [];
  if (input.prImpactReport.graph.freshness !== 'fresh') {
    caveats.push('PR Impact graph evidence is stale; generated-test planning is advisory only.');
  }
  caveats.push(...input.prImpactReport.caveats);
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
      pr_impact_schema_version: input.prImpactReport.schema_version,
      pr_impact_verdict: input.prImpactReport.verdict,
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
    `- Source PR Impact verdict: ${report.source_reports.pr_impact_verdict}`,
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

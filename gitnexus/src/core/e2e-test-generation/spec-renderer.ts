import type { E2ETestPlanProposal, E2ETestPlanReport } from './report.js';

export interface ExistingGeneratedSpec {
  path: string;
  generated: boolean;
}

export interface GeneratedE2ESpec {
  proposalId: string;
  path: string;
  text: string;
}

export interface BlockedE2EGeneratedSpec {
  proposalId: string;
  reason: string;
}

export interface E2EGeneratedSpecRenderOptions {
  outputDir?: string;
  existingSpecs?: ExistingGeneratedSpec[];
  force?: boolean;
}

export interface E2EGeneratedSpecRenderResult {
  specs: GeneratedE2ESpec[];
  blocked: BlockedE2EGeneratedSpec[];
}

const DEFAULT_OUTPUT_DIR = 'gitnexus-web/e2e/generated';

const normalizePath = (value: string): string => value.replace(/\\/g, '/');

const isAbsoluteOrPersonalPath = (value: string): boolean => {
  const normalized = normalizePath(value);
  return /^[A-Za-z]:\//.test(normalized) || normalized.startsWith('/Users/');
};

const referencesSecret = (proposal: E2ETestPlanProposal): boolean => {
  const haystack = [proposal.id, proposal.title, proposal.target_spec, ...proposal.evidence].join('\n');
  return /\b(token|credential|password|secret)\b/i.test(haystack);
};

const routeFromProposal = (proposal: E2ETestPlanProposal): string | null => {
  const text = [proposal.title, ...proposal.evidence].join('\n');
  return text.match(/route\s+(\/[^\s;]+)/i)?.[1] ?? null;
};

const safeSlug = (value: string): string =>
  value
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .replace(/[^a-zA-Z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase();

const singleQuoted = (value: string): string => value.replace(/\\/g, '\\\\').replace(/'/g, "\\'");

const outputPathFor = (
  proposal: E2ETestPlanProposal,
  options: E2EGeneratedSpecRenderOptions,
): string => `${options.outputDir ?? DEFAULT_OUTPUT_DIR}/${safeSlug(proposal.id)}.generated.spec.ts`;

const existingSpecFor = (
  path: string,
  existingSpecs: ExistingGeneratedSpec[] = [],
): ExistingGeneratedSpec | undefined => {
  const normalized = normalizePath(path).toLowerCase();
  return existingSpecs.find((candidate) => normalizePath(candidate.path).toLowerCase() === normalized);
};

const block = (proposalId: string, reason: string): BlockedE2EGeneratedSpec => ({
  proposalId,
  reason,
});

const renderReposRouteSpec = (proposal: E2ETestPlanProposal): string => {
  const title = singleQuoted(proposal.title);
  return [
    "import { test, expect } from '@playwright/test';",
    '',
    "const BACKEND_URL = process.env.BACKEND_URL ?? 'http://localhost:4747';",
    '',
    `test.describe('Generated E2E plan: ${title}', () => {`,
    "  test('route /api/repos remains visible through mocked backend data', async ({ page }) => {",
    "    await page.route(`${BACKEND_URL}/api/repos`, (route) =>",
    '      route.fulfill({',
    "        contentType: 'application/json',",
    "        body: JSON.stringify([{ name: 'generated-fixture-repo', path: '/tmp/generated-fixture-repo' }]),",
    '      }),',
    '    );',
    '',
    "    await page.route(`${BACKEND_URL}/api/repo`, (route) =>",
    '      route.fulfill({',
    "        contentType: 'application/json',",
    '        body: JSON.stringify({',
    "          name: 'generated-fixture-repo',",
    "          path: '/tmp/generated-fixture-repo',",
    "          repoPath: '/tmp/generated-fixture-repo',",
    '        }),',
    '      }),',
    '    );',
    '',
    "    await page.route(`${BACKEND_URL}/api/graph**`, (route) =>",
    '      route.fulfill({',
    "        contentType: 'application/json',",
    '        body: JSON.stringify({ nodes: [], relationships: [] }),',
    '      }),',
    '    );',
    '',
    "    await page.route(`${BACKEND_URL}/api/heartbeat`, (route) =>",
    '      route.fulfill({',
    '        status: 200,',
    "        headers: { 'Content-Type': 'text/event-stream' },",
    "        body: ':ok\\n\\n',",
    '      }),',
    '    );',
    '',
    "    await page.goto('/');",
    '',
    "    await expect(page.getByText('generated-fixture-repo')).toBeVisible({ timeout: 20_000 });",
    '  });',
    '});',
  ].join('\n');
};

const renderProposal = (
  proposal: E2ETestPlanProposal,
  options: E2EGeneratedSpecRenderOptions,
): GeneratedE2ESpec | BlockedE2EGeneratedSpec => {
  if (referencesSecret(proposal)) {
    return block(proposal.id, 'Proposal evidence references credentials or secrets.');
  }

  if (isAbsoluteOrPersonalPath(proposal.target_spec)) {
    return block(proposal.id, 'Proposal target spec uses an absolute or personal path.');
  }

  const route = routeFromProposal(proposal);
  if (!proposal.id.startsWith('route-') || !route) {
    return block(
      proposal.id,
      'Only route proposals are supported by the generated-spec V1 renderer.',
    );
  }

  if (route !== '/api/repos') {
    return block(
      proposal.id,
      'Only /api/repos route proposals have a deterministic generated fixture in V1.',
    );
  }

  const outputPath = outputPathFor(proposal, options);
  const existing = existingSpecFor(outputPath, options.existingSpecs);
  if (existing && !existing.generated) {
    return block(proposal.id, 'Refusing to overwrite an existing hand-written spec.');
  }

  if (existing && !options.force) {
    return block(proposal.id, 'Generated spec already exists; pass force to overwrite.');
  }

  return {
    proposalId: proposal.id,
    path: outputPath,
    text: renderReposRouteSpec(proposal),
  };
};

export const renderE2EGeneratedSpecs = (
  report: E2ETestPlanReport,
  options: E2EGeneratedSpecRenderOptions = {},
): E2EGeneratedSpecRenderResult => {
  const specs: GeneratedE2ESpec[] = [];
  const blocked: BlockedE2EGeneratedSpec[] = [];

  for (const proposal of report.proposals) {
    const rendered = renderProposal(proposal, options);
    if ('text' in rendered) specs.push(rendered);
    else blocked.push(rendered);
  }

  return { specs, blocked };
};

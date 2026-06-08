import type { E2ETestPlanProposal, E2ETestPlanReport } from './report.js';

export interface ExistingGeneratedApiSmokeSpec {
  path: string;
  generated: boolean;
}

export interface GeneratedApiSmokeSpec {
  proposalId: string;
  path: string;
  text: string;
}

export interface BlockedApiSmokeSpec {
  proposalId: string;
  reason: string;
}

export interface ApiSmokeSpecRenderOptions {
  outputDir?: string;
  existingSpecs?: ExistingGeneratedApiSmokeSpec[];
  force?: boolean;
}

export interface ApiSmokeSpecRenderResult {
  specs: GeneratedApiSmokeSpec[];
  blocked: BlockedApiSmokeSpec[];
}

const DEFAULT_OUTPUT_DIR = 'gitnexus/test/api-smoke/generated';

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
  options: ApiSmokeSpecRenderOptions,
): string => `${options.outputDir ?? DEFAULT_OUTPUT_DIR}/${safeSlug(proposal.id)}.generated.api.spec.ts`;

const existingSpecFor = (
  path: string,
  existingSpecs: ExistingGeneratedApiSmokeSpec[] = [],
): ExistingGeneratedApiSmokeSpec | undefined => {
  const normalized = normalizePath(path).toLowerCase();
  return existingSpecs.find((candidate) => normalizePath(candidate.path).toLowerCase() === normalized);
};

const block = (proposalId: string, reason: string): BlockedApiSmokeSpec => ({
  proposalId,
  reason,
});

const renderProcessesRouteSpec = (proposal: E2ETestPlanProposal): string => {
  const title = singleQuoted(proposal.title);
  return [
    "import { test, expect } from '@playwright/test';",
    '',
    "const BACKEND_URL = process.env.BACKEND_URL ?? 'http://localhost:4747';",
    'const REPO = process.env.GITNEXUS_REPO;',
    '',
    'const apiUrl = (path: string): string => {',
    '  const url = new URL(path, BACKEND_URL);',
    "  if (REPO) url.searchParams.set('repo', REPO);",
    '  return url.toString();',
    '};',
    '',
    `test.describe('Generated GitNexus API smoke plan: ${title}', () => {`,
    "  test('route /api/processes returns a JSON process list', async ({ request }) => {",
    "    const response = await request.get(apiUrl('/api/processes'));",
    '',
    '    expect(response.ok()).toBeTruthy();',
    '',
    '    const body: unknown = await response.json();',
    '    expect(body).toEqual(',
    '      expect.objectContaining({',
    '        processes: expect.any(Array),',
    '      }),',
    '    );',
    '',
    '    const payload = body as { processes: unknown[] };',
    '    for (const process of payload.processes) {',
    '      expect(process).toEqual(',
    '        expect.objectContaining({',
    '          id: expect.any(String),',
    '          label: expect.any(String),',
    '          heuristicLabel: expect.any(String),',
    '          processType: expect.any(String),',
    '          stepCount: expect.any(Number),',
    '        }),',
    '      );',
    '    }',
    '  });',
    '});',
  ].join('\n');
};

const renderProcessDetailRouteSpec = (proposal: E2ETestPlanProposal): string => {
  const title = singleQuoted(proposal.title);
  return [
    "import { test, expect } from '@playwright/test';",
    '',
    "const BACKEND_URL = process.env.BACKEND_URL ?? 'http://localhost:4747';",
    'const REPO = process.env.GITNEXUS_REPO;',
    '',
    'const apiUrl = (path: string): string => {',
    '  const url = new URL(path, BACKEND_URL);',
    "  if (REPO) url.searchParams.set('repo', REPO);",
    '  return url.toString();',
    '};',
    '',
    `test.describe('Generated GitNexus API smoke plan: ${title}', () => {`,
    "  test('route /api/process uses an explicit list-to-detail strategy and returns the stable process-detail JSON shape', async ({ request }) => {",
    "    const listResponse = await request.get(apiUrl('/api/processes'));",
    '',
    '    expect(listResponse.ok()).toBeTruthy();',
    '',
    '    const listBody: unknown = await listResponse.json();',
    '    expect(listBody).toEqual(',
    '      expect.objectContaining({',
    '        processes: expect.any(Array),',
    '      }),',
    '    );',
    '',
    '    const processes = (listBody as { processes: Array<Record<string, unknown>> }).processes;',
    '    const firstProcess = processes[0];',
    '    expect(firstProcess).toBeDefined();',
    '',
    "    const selectedName = String(firstProcess.heuristicLabel ?? firstProcess.label ?? '').trim();",
    '    expect(selectedName).not.toBe(\'\');',
    '',
    "    const detailResponse = await request.get(apiUrl(`/api/process?name=${encodeURIComponent(selectedName)}`));",
    '',
    '    expect(detailResponse.ok()).toBeTruthy();',
    '',
    '    const detailBody: unknown = await detailResponse.json();',
    '    expect(detailBody).toEqual(',
    '      expect.objectContaining({',
    '        process: expect.objectContaining({',
    '          id: expect.any(String),',
    '          label: expect.any(String),',
    '          heuristicLabel: expect.any(String),',
    '          processType: expect.any(String),',
    '          stepCount: expect.any(Number),',
    '        }),',
    '        steps: expect.any(Array),',
    '      }),',
    '    );',
    '',
    '    const payload = detailBody as { steps: unknown[] };',
    '    for (const step of payload.steps) {',
    '      expect(step).toEqual(',
    '        expect.objectContaining({',
    '          step: expect.any(Number),',
    '          name: expect.any(String),',
    '          type: expect.any(String),',
    '        }),',
    '      );',
    '    }',
    '  });',
    '});',
  ].join('\n');
};

const renderHealthRouteSpec = (proposal: E2ETestPlanProposal): string => {
  const title = singleQuoted(proposal.title);
  return [
    "import { test, expect } from '@playwright/test';",
    '',
    "const BACKEND_URL = process.env.BACKEND_URL ?? 'http://localhost:4747';",
    '',
    'const apiUrl = (path: string): string => new URL(path, BACKEND_URL).toString();',
    '',
    `test.describe('Generated GitNexus API smoke plan: ${title}', () => {`,
    "  test('route /api/health returns the stable healthcheck JSON contract', async ({ request }) => {",
    "    const response = await request.get(apiUrl('/api/health'));",
    '',
    '    expect(response.ok()).toBeTruthy();',
    '',
    '    const body: unknown = await response.json();',
    '    expect(body).toEqual(',
    '      expect.objectContaining({',
    "        status: 'ok',",
    '      }),',
    '    );',
    '  });',
    '});',
  ].join('\n');
};

const renderInfoRouteSpec = (proposal: E2ETestPlanProposal): string => {
  const title = singleQuoted(proposal.title);
  return [
    "import { test, expect } from '@playwright/test';",
    '',
    "const BACKEND_URL = process.env.BACKEND_URL ?? 'http://localhost:4747';",
    '',
    'const apiUrl = (path: string): string => new URL(path, BACKEND_URL).toString();',
    '',
    `test.describe('Generated GitNexus API smoke plan: ${title}', () => {`,
    "  test('route /api/info returns the stable server-info JSON shape', async ({ request }) => {",
    "    const response = await request.get(apiUrl('/api/info'));",
    '',
    '    expect(response.ok()).toBeTruthy();',
    '',
    '    const body: unknown = await response.json();',
    "    expect(typeof body).toBe('object');",
    '    expect(body).not.toBeNull();',
    '',
    '    const info = body as Record<string, unknown>;',
    '    expect(info.version).toEqual(expect.any(String));',
    "    expect(['npx', 'global', 'local']).toContain(info.launchContext);",
    '    expect(String(info.nodeVersion)).toMatch(/^v\\d+\\.\\d+\\.\\d+/);',
    '  });',
    '});',
  ].join('\n');
};

const renderClustersRouteSpec = (proposal: E2ETestPlanProposal): string => {
  const title = singleQuoted(proposal.title);
  return [
    "import { test, expect } from '@playwright/test';",
    '',
    "const BACKEND_URL = process.env.BACKEND_URL ?? 'http://localhost:4747';",
    'const REPO = process.env.GITNEXUS_REPO;',
    '',
    'const apiUrl = (path: string): string => {',
    '  const url = new URL(path, BACKEND_URL);',
    "  if (REPO) url.searchParams.set('repo', REPO);",
    '  return url.toString();',
    '};',
    '',
    `test.describe('Generated GitNexus API smoke plan: ${title}', () => {`,
    "  test('route /api/clusters returns the stable clusters JSON shape', async ({ request }) => {",
    "    const response = await request.get(apiUrl('/api/clusters'));",
    '',
    '    expect(response.ok()).toBeTruthy();',
    '',
    '    const body: unknown = await response.json();',
    '    expect(body).toEqual(',
    '      expect.objectContaining({',
    '        clusters: expect.any(Array),',
    '      }),',
    '    );',
    '',
    '    const payload = body as { clusters: unknown[] };',
    '    for (const cluster of payload.clusters) {',
    '      expect(cluster).toEqual(',
    '        expect.objectContaining({',
    '          id: expect.any(String),',
    '          heuristicLabel: expect.any(String),',
    '          symbolCount: expect.any(Number),',
    '        }),',
    '      );',
    '    }',
    '  });',
    '});',
  ].join('\n');
};

const renderClusterDetailRouteSpec = (proposal: E2ETestPlanProposal): string => {
  const title = singleQuoted(proposal.title);
  return [
    "import { test, expect } from '@playwright/test';",
    '',
    "const BACKEND_URL = process.env.BACKEND_URL ?? 'http://localhost:4747';",
    'const REPO = process.env.GITNEXUS_REPO;',
    '',
    'const apiUrl = (path: string): string => {',
    '  const url = new URL(path, BACKEND_URL);',
    "  if (REPO) url.searchParams.set('repo', REPO);",
    '  return url.toString();',
    '};',
    '',
    `test.describe('Generated GitNexus API smoke plan: ${title}', () => {`,
    "  test('route /api/cluster uses an explicit list-to-detail strategy and returns the stable cluster-detail JSON shape', async ({ request }) => {",
    "    const listResponse = await request.get(apiUrl('/api/clusters'));",
    '',
    '    expect(listResponse.ok()).toBeTruthy();',
    '',
    '    const listBody: unknown = await listResponse.json();',
    '    expect(listBody).toEqual(',
    '      expect.objectContaining({',
    '        clusters: expect.any(Array),',
    '      }),',
    '    );',
    '',
    '    const clusters = (listBody as { clusters: Array<Record<string, unknown>> }).clusters;',
    '    const firstCluster = clusters[0];',
    '    expect(firstCluster).toBeDefined();',
    '',
    "    const selectedName = String(firstCluster.heuristicLabel ?? firstCluster.label ?? '').trim();",
    '    expect(selectedName).not.toBe(\'\');',
    '',
    "    const detailResponse = await request.get(apiUrl(`/api/cluster?name=${encodeURIComponent(selectedName)}`));",
    '',
    '    expect(detailResponse.ok()).toBeTruthy();',
    '',
    '    const detailBody: unknown = await detailResponse.json();',
    '    expect(detailBody).toEqual(',
    '      expect.objectContaining({',
    '        cluster: expect.objectContaining({',
    '          id: expect.any(String),',
    '          label: expect.any(String),',
    '          heuristicLabel: expect.any(String),',
    '          cohesion: expect.any(Number),',
    '          symbolCount: expect.any(Number),',
    '          subCommunities: expect.any(Number),',
    '        }),',
    '        members: expect.any(Array),',
    '      }),',
    '    );',
    '',
    '    const payload = detailBody as { members: unknown[] };',
    '    for (const member of payload.members) {',
    '      expect(member).toEqual(',
    '        expect.objectContaining({',
    '          name: expect.any(String),',
    '          type: expect.any(String),',
    '          filePath: expect.any(String),',
    '        }),',
    '      );',
    '    }',
    '  });',
    '});',
  ].join('\n');
};

const renderProposal = (
  proposal: E2ETestPlanProposal,
  options: ApiSmokeSpecRenderOptions,
): GeneratedApiSmokeSpec | BlockedApiSmokeSpec => {
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
      'Only route proposals are supported by the generated API-smoke V1 renderer.',
    );
  }

  if (
    route !== '/api/processes' &&
    route !== '/api/process' &&
    route !== '/api/health' &&
    route !== '/api/info' &&
    route !== '/api/clusters' &&
    route !== '/api/cluster'
  ) {
    return block(
      proposal.id,
      'Only /api/processes, /api/process, /api/health, /api/info, /api/clusters, and /api/cluster route proposals have deterministic API-smoke fixtures in V1.',
    );
  }

  const outputPath = outputPathFor(proposal, options);
  const existing = existingSpecFor(outputPath, options.existingSpecs);
  if (existing && !existing.generated) {
    return block(proposal.id, 'Refusing to overwrite an existing hand-written API-smoke spec.');
  }

  if (existing && !options.force) {
    return block(proposal.id, 'Generated API-smoke spec already exists; pass force to overwrite.');
  }

  return {
    proposalId: proposal.id,
    path: outputPath,
    text:
      route === '/api/health'
        ? renderHealthRouteSpec(proposal)
        : route === '/api/process'
          ? renderProcessDetailRouteSpec(proposal)
        : route === '/api/info'
          ? renderInfoRouteSpec(proposal)
          : route === '/api/cluster'
            ? renderClusterDetailRouteSpec(proposal)
          : route === '/api/clusters'
            ? renderClustersRouteSpec(proposal)
          : renderProcessesRouteSpec(proposal),
  };
};

export const renderE2EGeneratedApiSmokeSpecs = (
  report: E2ETestPlanReport,
  options: ApiSmokeSpecRenderOptions = {},
): ApiSmokeSpecRenderResult => {
  const specs: GeneratedApiSmokeSpec[] = [];
  const blocked: BlockedApiSmokeSpec[] = [];

  for (const proposal of report.proposals) {
    const rendered = renderProposal(proposal, options);
    if ('text' in rendered) specs.push(rendered);
    else blocked.push(rendered);
  }

  return { specs, blocked };
};

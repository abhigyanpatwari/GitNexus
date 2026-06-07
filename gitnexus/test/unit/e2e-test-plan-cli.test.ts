import { beforeEach, describe, expect, it, vi } from 'vitest';

const readFileSyncMock = vi.fn();
const writeSyncMock = vi.fn();
const existsSyncMock = vi.fn();
const mkdirSyncMock = vi.fn();
const writeFileSyncMock = vi.fn();

vi.mock('node:fs', () => ({
  existsSync: existsSyncMock,
  mkdirSync: mkdirSyncMock,
  readFileSync: readFileSyncMock,
  writeFileSync: writeFileSyncMock,
  writeSync: writeSyncMock,
}));

const targetJson = {
  app: 'gitnexus-web',
  framework: 'playwright',
  browser: 'chromium',
  backendUrl: 'http://localhost:4747',
  frontendUrl: 'http://localhost:5173',
  fixturePolicy: 'CI mini fixture repo indexed before E2E run',
};

const prImpactJson = {
  schema_version: 'pr-impact.v1alpha1',
  verdict: 'BLOCK',
  diff: { scope: 'compare', baseRef: 'main', headRef: 'HEAD', filesChanged: 1 },
  graph: { freshness: 'fresh' },
  summary: {
    files_changed: 1,
    mapped_symbols: 1,
    unmatched_ranges: 0,
    deleted_symbols: 0,
    new_symbols: 0,
    impact_entries: 1,
    api_impact_entries: 1,
  },
  mapped_symbols: [
    {
      id: 'Function:src/components/GraphCanvas.tsx:renderGraph',
      name: 'renderGraph',
      kind: 'Function',
      filePath: 'src/components/GraphCanvas.tsx',
      changeType: 'modified',
    },
  ],
  unmatched_ranges: [],
  new_symbols: [],
  deleted_symbols: [],
  impacts: [
    {
      symbolId: 'Function:src/components/GraphCanvas.tsx:renderGraph',
      symbolName: 'renderGraph',
      risk: 'MEDIUM',
      direct: 2,
      processesAffected: 1,
      testReference: 'unknown_or_unreferenced',
    },
  ],
  api_impacts: [
    {
      route: '/api/repos',
      risk: 'HIGH',
      consumers: 2,
      mismatches: 0,
    },
  ],
  test_signal: { status: 'unknown_or_unreferenced' },
  caveats: ['High-risk impact has no known graph-derived test reference.'],
};

const existingScenariosJson = [
  {
    name: 'Server Connection & Graph Loading > selects a repo from landing',
    filePath: 'gitnexus-web/e2e/server-connect.spec.ts',
    covers: ['/api/repos'],
  },
];

const routeEvidenceJson = [
  {
    route: '/api/repos',
    consumers: 2,
    mismatches: 0,
    evidence: 'route_map shows repo list consumers',
  },
];

const processesPrImpactJson = {
  ...prImpactJson,
  api_impacts: [
    {
      route: '/api/processes',
      risk: 'HIGH',
      consumers: 0,
      mismatches: 0,
    },
  ],
};

const processesRouteEvidenceJson = [
  {
    route: '/api/processes',
    consumers: 0,
    mismatches: 0,
    evidence: 'backend route exists without current frontend consumer',
  },
];

describe('e2e-test-plan CLI command', () => {
  beforeEach(() => {
    vi.resetModules();
    existsSyncMock.mockReset();
    mkdirSyncMock.mockReset();
    readFileSyncMock.mockReset();
    writeFileSyncMock.mockReset();
    writeSyncMock.mockReset();
  });

  it('reads local JSON inputs and writes Markdown', async () => {
    readFileSyncMock.mockImplementation((filePath: string) => {
      if (filePath === 'target.json') return JSON.stringify(targetJson);
      if (filePath === 'pr-impact.json') return JSON.stringify(prImpactJson);
      if (filePath === 'existing.json') return JSON.stringify(existingScenariosJson);
      if (filePath === 'routes.json') return JSON.stringify(routeEvidenceJson);
      throw new Error(`unexpected path ${filePath}`);
    });

    const { e2eTestPlanCommand } = await import('../../src/cli/e2e-test-plan.js');

    await e2eTestPlanCommand({
      targetJson: 'target.json',
      prImpactJson: 'pr-impact.json',
      existingScenariosJson: 'existing.json',
      routeEvidenceJson: 'routes.json',
      format: 'markdown',
    });

    expect(readFileSyncMock).toHaveBeenNthCalledWith(1, 'target.json', 'utf-8');
    expect(readFileSyncMock).toHaveBeenNthCalledWith(2, 'pr-impact.json', 'utf-8');
    expect(readFileSyncMock).toHaveBeenNthCalledWith(3, 'existing.json', 'utf-8');
    expect(readFileSyncMock).toHaveBeenNthCalledWith(4, 'routes.json', 'utf-8');

    const output: string = writeSyncMock.mock.calls[0][1];
    expect(output).toContain('# GitNexus E2E Test Plan Report');
    expect(output).toContain('Schema: e2e-test-plan.v1alpha1');
    expect(output).toContain('Add E2E scenario for changed surface renderGraph');
  });

  it('writes JSON when requested', async () => {
    readFileSyncMock.mockImplementation((filePath: string) => {
      if (filePath === 'target.json') return JSON.stringify(targetJson);
      if (filePath === 'pr-impact.json') return JSON.stringify(prImpactJson);
      if (filePath === 'existing.json') return JSON.stringify(existingScenariosJson);
      if (filePath === 'routes.json') return JSON.stringify(routeEvidenceJson);
      throw new Error(`unexpected path ${filePath}`);
    });

    const { e2eTestPlanCommand } = await import('../../src/cli/e2e-test-plan.js');

    await e2eTestPlanCommand({
      targetJson: 'target.json',
      prImpactJson: 'pr-impact.json',
      existingScenariosJson: 'existing.json',
      routeEvidenceJson: 'routes.json',
      format: 'json',
    });

    const output: string = writeSyncMock.mock.calls[0][1];
    const parsed = JSON.parse(output);
    expect(parsed.schema_version).toBe('e2e-test-plan.v1alpha1');
    expect(parsed.source_reports.pr_impact_schema_version).toBe('pr-impact.v1alpha1');
  });

  it('writes generated Playwright specs only when explicitly requested', async () => {
    existsSyncMock.mockReturnValue(false);
    readFileSyncMock.mockImplementation((filePath: string) => {
      if (filePath === 'target.json') return JSON.stringify(targetJson);
      if (filePath === 'pr-impact.json') return JSON.stringify(prImpactJson);
      if (filePath === 'existing.json') return JSON.stringify([]);
      if (filePath === 'routes.json') return JSON.stringify(routeEvidenceJson);
      throw new Error(`unexpected path ${filePath}`);
    });

    const { e2eTestPlanCommand } = await import('../../src/cli/e2e-test-plan.js');

    await e2eTestPlanCommand({
      targetJson: 'target.json',
      prImpactJson: 'pr-impact.json',
      existingScenariosJson: 'existing.json',
      routeEvidenceJson: 'routes.json',
      writeSpecs: true,
      specOutputDir: 'gitnexus-web/e2e/generated',
      format: 'markdown',
    });

    expect(mkdirSyncMock).toHaveBeenCalledWith('gitnexus-web/e2e/generated', {
      recursive: true,
    });
    expect(writeFileSyncMock).toHaveBeenCalledWith(
      'gitnexus-web/e2e/generated/route-api-repos.generated.spec.ts',
      expect.stringContaining('Generated E2E plan: Exercise route /api/repos'),
      'utf-8',
    );

    const output: string = writeSyncMock.mock.calls[0][1];
    expect(output).toContain('Generated specs written: 1');
    expect(output).toContain('Blocked proposals: 1');
  });

  it('writes generated API-smoke specs only when explicitly requested', async () => {
    existsSyncMock.mockReturnValue(false);
    readFileSyncMock.mockImplementation((filePath: string) => {
      if (filePath === 'target.json') return JSON.stringify(targetJson);
      if (filePath === 'pr-impact.json') return JSON.stringify(processesPrImpactJson);
      if (filePath === 'existing.json') return JSON.stringify([]);
      if (filePath === 'routes.json') return JSON.stringify(processesRouteEvidenceJson);
      throw new Error(`unexpected path ${filePath}`);
    });

    const { e2eTestPlanCommand } = await import('../../src/cli/e2e-test-plan.js');

    await e2eTestPlanCommand({
      targetJson: 'target.json',
      prImpactJson: 'pr-impact.json',
      existingScenariosJson: 'existing.json',
      routeEvidenceJson: 'routes.json',
      writeApiSmokeSpecs: true,
      apiSmokeOutputDir: 'gitnexus/test/api-smoke/generated',
      format: 'markdown',
    });

    expect(mkdirSyncMock).toHaveBeenCalledWith('gitnexus/test/api-smoke/generated', {
      recursive: true,
    });
    expect(writeFileSyncMock).toHaveBeenCalledWith(
      'gitnexus/test/api-smoke/generated/route-api-processes.generated.api.spec.ts',
      expect.stringContaining('Generated GitNexus API smoke plan: Exercise route /api/processes'),
      'utf-8',
    );
    expect(writeFileSyncMock.mock.calls[0][1]).toContain('request.get(apiUrl');
    expect(writeFileSyncMock.mock.calls[0][1]).not.toContain('page.goto');

    const output: string = writeSyncMock.mock.calls[0][1];
    expect(output).toContain('Generated API-smoke specs written: 1');
    expect(output).toContain('Blocked API-smoke proposals: 1');
  });

  it('keeps browser UI and API-smoke generated outputs on separate paths when both modes are requested', async () => {
    existsSyncMock.mockReturnValue(false);
    readFileSyncMock.mockImplementation((filePath: string) => {
      if (filePath === 'target.json') return JSON.stringify(targetJson);
      if (filePath === 'pr-impact.json') return JSON.stringify(processesPrImpactJson);
      if (filePath === 'existing.json') return JSON.stringify([]);
      if (filePath === 'routes.json') return JSON.stringify(processesRouteEvidenceJson);
      throw new Error(`unexpected path ${filePath}`);
    });

    const { e2eTestPlanCommand } = await import('../../src/cli/e2e-test-plan.js');

    await e2eTestPlanCommand({
      targetJson: 'target.json',
      prImpactJson: 'pr-impact.json',
      existingScenariosJson: 'existing.json',
      routeEvidenceJson: 'routes.json',
      writeSpecs: true,
      writeApiSmokeSpecs: true,
      specOutputDir: 'gitnexus-web/e2e/generated',
      apiSmokeOutputDir: 'gitnexus/test/api-smoke/generated',
      format: 'markdown',
    });

    const writtenPaths = writeFileSyncMock.mock.calls.map((call) => call[0]);
    expect(writtenPaths).not.toContain('gitnexus-web/e2e/generated/route-api-processes.generated.spec.ts');
    expect(writtenPaths).toContain(
      'gitnexus/test/api-smoke/generated/route-api-processes.generated.api.spec.ts',
    );

    const output: string = writeSyncMock.mock.calls[0][1];
    expect(output).toContain('Generated specs written: 0');
    expect(output).toContain('Generated API-smoke specs written: 1');
  });
});

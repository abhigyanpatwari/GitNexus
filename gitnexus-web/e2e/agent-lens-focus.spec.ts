import { test, expect } from '@playwright/test';

const BACKEND_URL = process.env.BACKEND_URL ?? 'http://localhost:4747';
const FRONTEND_URL = process.env.FRONTEND_URL ?? 'http://localhost:5173';

type GraphCanvasState = {
  selectedNodeId: string | null;
  agentLensFocusNodeId: string | null;
  agentLensFocusSource: 'impact' | 'tool' | 'citation' | null;
  agentLensSignature: string | null;
  graphViewMode: '2d' | '3d';
  availableNodeIds: string[];
  isAIHighlightsEnabled: boolean;
  impactNodeIds: string[];
  toolNodeIds: string[];
  citationNodeIds: string[];
  agentActivityTotal: number;
  sigmaCamera: {
    x: number;
    y: number;
    ratio: number;
  } | null;
};

type AgentActivityState = {
  currentToolCalls: Array<{ id: string; name: string; status: string }>;
  aiToolHighlightCount: number;
  blastRadiusCount: number;
};

test.beforeAll(async () => {
  if (process.env.E2E) return;

  try {
    const [backendRes, frontendRes] = await Promise.allSettled([
      fetch(`${BACKEND_URL}/api/repos`),
      fetch(FRONTEND_URL),
    ]);
    if (
      backendRes.status === 'rejected' ||
      (backendRes.status === 'fulfilled' && !backendRes.value.ok)
    ) {
      test.skip(true, 'gitnexus serve not available on :4747');
      return;
    }
    if (
      frontendRes.status === 'rejected' ||
      (frontendRes.status === 'fulfilled' && !frontendRes.value.ok)
    ) {
      test.skip(true, 'Vite dev server not available on :5173');
      return;
    }
    if (backendRes.status === 'fulfilled') {
      const repos = (await backendRes.value.json()) as Array<{ name: string }>;
      if (!repos.length) {
        test.skip(true, 'No indexed repos — run gitnexus analyze first');
      }
    }
  } catch {
    test.skip(true, 'servers not available');
  }
});

const readGraphCanvasState = async (
  page: import('@playwright/test').Page,
): Promise<GraphCanvasState> =>
  page.evaluate(() =>
    (window as Window & { __gitnexusE2EGetGraphCanvasState?: () => GraphCanvasState })
      .__gitnexusE2EGetGraphCanvasState!(),
  );

const readAgentActivityState = async (
  page: import('@playwright/test').Page,
): Promise<AgentActivityState> =>
  page.evaluate(() =>
    (window as Window & { __gitnexusE2EGetAgentActivity?: () => AgentActivityState })
      .__gitnexusE2EGetAgentActivity!(),
  );

const ensureAIHighlightsEnabled = async (page: import('@playwright/test').Page): Promise<void> => {
  const state = await readGraphCanvasState(page);
  if (state.isAIHighlightsEnabled) {
    return;
  }

  await page.evaluate(() => {
    const button = document.querySelector('[data-testid="ai-highlights-toggle"]');
    if (!(button instanceof HTMLButtonElement)) {
      throw new Error('AI highlights toggle missing');
    }
    button.click();
  });

  await page.waitForFunction(
    () => window.__gitnexusE2EGetGraphCanvasState?.().isAIHighlightsEnabled === true,
    null,
    { timeout: 5_000 },
  );
};

const enterExploringView = async (page: import('@playwright/test').Page): Promise<string> => {
  await page.goto('/');

  const landingCards = page.locator('[data-testid="landing-repo-card"]');
  try {
    await landingCards.first().waitFor({ state: 'visible', timeout: 15_000 });
    const preferredCard = landingCards.filter({ hasText: /GitNexus|local-integration/ }).first();
    if ((await preferredCard.count()) > 0) {
      await preferredCard.click();
    } else {
      await landingCards.first().click();
    }
  } catch {
    // Landing screen may be skipped when already connected.
  }

  await expect(page.locator('[data-testid="graph-view-2d-toggle"]')).toBeVisible({
    timeout: 45_000,
  });
  await page.evaluate(() => {
    const button = document.querySelector('[data-testid="graph-view-2d-toggle"]');
    if (!(button instanceof HTMLButtonElement)) {
      throw new Error('2D graph toggle missing');
    }
    button.click();
  });
  await page.waitForFunction(() => typeof window.__gitnexusE2EGetGraphCanvasState === 'function');
  await page.waitForFunction(() => typeof window.__gitnexusE2EGetAgentActivity === 'function');
  await ensureAIHighlightsEnabled(page);
  await page.waitForFunction(
    () => (window.__gitnexusE2EGetGraphCanvasState?.().availableNodeIds.length ?? 0) > 0,
    null,
    { timeout: 45_000 },
  );

  return 'graph-ready';
};

test('Agent Lens focuses fresh activity once and preserves later manual selection', async ({
  page,
}, testInfo) => {
  test.slow();

  const loadedRepo = await enterExploringView(page);
  const beforeGraphState = await readGraphCanvasState(page);
  const beforeAgentState = await readAgentActivityState(page);

  test.skip(
    beforeGraphState.availableNodeIds.length < 4,
    'Need at least four visible node IDs to verify Agent Lens focus behavior',
  );

  const [impactNodeId, toolNodeId, extraToolNodeId, manualNodeId] =
    beforeGraphState.availableNodeIds;
  const toolCallId = 'e2e-agent-lens-focus';
  const resultText = [
    'Agent Lens focus proof',
    `[IMPACT:${encodeURIComponent(impactNodeId!)}]`,
    `[HIGHLIGHT_NODES:${encodeURIComponent(toolNodeId!)},${encodeURIComponent(extraToolNodeId!)}]`,
  ].join('\n');

  await page.evaluate(
    ({ injectedToolCallId, result }) => {
      window.dispatchEvent(
        new CustomEvent('gitnexus:e2e-tool-result', {
          detail: {
            toolCall: {
              id: injectedToolCallId,
              name: 'impact',
              status: 'success',
              result,
            },
          },
        }),
      );
    },
    { injectedToolCallId: toolCallId, result: resultText },
  );

  await page.waitForFunction(
    (expectedNodeId) =>
      window.__gitnexusE2EGetGraphCanvasState?.().selectedNodeId === expectedNodeId,
    impactNodeId,
    { timeout: 10_000 },
  );

  const afterGraphState = await readGraphCanvasState(page);
  const afterAgentState = await readAgentActivityState(page);

  await page.screenshot({ path: testInfo.outputPath('agent-lens-focus.png') });

  expect(beforeAgentState.aiToolHighlightCount).toBe(0);
  expect(beforeAgentState.blastRadiusCount).toBe(0);
  expect(beforeGraphState.isAIHighlightsEnabled).toBe(true);
  expect(afterAgentState.aiToolHighlightCount).toBe(2);
  expect(afterAgentState.blastRadiusCount).toBe(1);
  expect(afterAgentState.currentToolCalls).toEqual([
    { id: toolCallId, name: 'impact', status: 'success' },
  ]);
  expect(afterGraphState.isAIHighlightsEnabled).toBe(true);
  expect(afterGraphState.agentLensFocusNodeId).toBe(impactNodeId);
  expect(afterGraphState.agentLensFocusSource).toBe('impact');
  expect(afterGraphState.impactNodeIds).toEqual([impactNodeId!]);
  expect(afterGraphState.toolNodeIds.slice().sort()).toEqual(
    [toolNodeId!, extraToolNodeId!].sort(),
  );
  expect(afterGraphState.citationNodeIds).toEqual([]);
  expect(afterGraphState.agentActivityTotal).toBe(3);
  expect(afterGraphState.agentLensSignature).toContain(`impact=${impactNodeId}`);
  expect(afterGraphState.graphViewMode).toBe('2d');
  expect(beforeGraphState.sigmaCamera).not.toBeNull();
  expect(afterGraphState.sigmaCamera).not.toBeNull();
  expect(afterGraphState.sigmaCamera!.ratio).toBeLessThan(beforeGraphState.sigmaCamera!.ratio);
  expect(
    Math.abs(afterGraphState.sigmaCamera!.x - beforeGraphState.sigmaCamera!.x) > 0.01 ||
      Math.abs(afterGraphState.sigmaCamera!.y - beforeGraphState.sigmaCamera!.y) > 0.01,
  ).toBe(true);

  const manualSelectionApplied = await page.evaluate(
    (nodeId) =>
      (
        window as Window & { __gitnexusE2ESelectGraphNode?: (nextNodeId: string) => boolean }
      ).__gitnexusE2ESelectGraphNode?.(nodeId) ?? false,
    manualNodeId!,
  );
  expect(manualSelectionApplied).toBe(true);

  await page.waitForFunction(
    (expectedNodeId) =>
      window.__gitnexusE2EGetGraphCanvasState?.().selectedNodeId === expectedNodeId,
    manualNodeId,
    { timeout: 5_000 },
  );

  await page.evaluate(
    ({ injectedToolCallId, result }) => {
      window.dispatchEvent(
        new CustomEvent('gitnexus:e2e-tool-result', {
          detail: {
            toolCall: {
              id: injectedToolCallId,
              name: 'impact',
              status: 'running',
              result,
            },
          },
        }),
      );
    },
    { injectedToolCallId: toolCallId, result: resultText },
  );

  await page.waitForFunction(
    (expectedNodeId) =>
      window.__gitnexusE2EGetGraphCanvasState?.().selectedNodeId === expectedNodeId,
    manualNodeId,
    { timeout: 5_000 },
  );

  expect(loadedRepo.length).toBeGreaterThan(0);
});

import { render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ExecutionDashboard } from '../../src/components/ExecutionDashboard';
import {
  connectHeartbeat,
  fetchOpsSnapshot,
  probeBackendStatus,
  streamOpsSnapshot,
  type OpsSnapshot,
} from '../../src/services/backend-client';

vi.mock('../../src/services/backend-client', () => ({
  connectHeartbeat: vi.fn(() => () => {}),
  fetchOpsSnapshot: vi.fn(),
  getBackendUrl: vi.fn(() => 'http://127.0.0.1:4747'),
  normalizeServerUrl: vi.fn((url: string) => url),
  probeBackendStatus: vi.fn(),
  setBackendUrl: vi.fn(),
  streamOpsSnapshot: vi.fn(),
}));

const emptyMetrics = {
  total: 0,
  active: 0,
  queued: 0,
  complete: 0,
  failed: 0,
  byStatus: {
    queued: 0,
    cloning: 0,
    analyzing: 0,
    loading: 0,
    complete: 0,
    failed: 0,
  },
  avgDurationMs: null,
  maxDurationMs: null,
  activeProgressSum: 0,
};

const emptySnap = (): OpsSnapshot => ({
  generatedAt: 1,
  uptimeMs: 1,
  health: 'ok',
  server: { version: '1', launchContext: 'local', nodeVersion: 'v22' },
  analyze: { jobs: [], metrics: emptyMetrics },
  embed: { jobs: [], metrics: emptyMetrics },
  totals: { jobs: 0, active: 0, failed: 0, complete: 0 },
});

describe('ExecutionDashboard safety poll', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(probeBackendStatus).mockResolvedValue('ok');
    vi.mocked(connectHeartbeat).mockReturnValue(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('stops the safety poll once the SSE stream delivers a frame', async () => {
    let onFrame: ((snapshot: OpsSnapshot) => void) | undefined;
    vi.mocked(streamOpsSnapshot).mockImplementation((onSnapshot) => {
      onFrame = onSnapshot;
      return { abort: vi.fn() } as unknown as AbortController;
    });
    vi.mocked(fetchOpsSnapshot).mockRejectedValue(new Error('rest down'));

    const setIntervalSpy = vi.spyOn(window, 'setInterval');
    const clearIntervalSpy = vi.spyOn(window, 'clearInterval');

    const { getByText } = render(<ExecutionDashboard />);

    await waitFor(() => expect(setIntervalSpy).toHaveBeenCalled());
    const timerId = setIntervalSpy.mock.results[0]?.value;
    expect(onFrame).toBeTypeOf('function');

    onFrame!(emptySnap());

    await waitFor(() => expect(clearIntervalSpy).toHaveBeenCalledWith(timerId));
    expect(getByText(/· sse/)).toBeInTheDocument();
  });
});

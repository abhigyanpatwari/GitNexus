import { fireEvent, render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ExecutionDashboard } from '../../src/components/ExecutionDashboard';
import {
  connectHeartbeat,
  fetchOpsSnapshot,
  getAuthToken,
  normalizeServerUrl,
  probeBackendStatus,
  setBackendUrl,
  streamOpsSnapshot,
  type OpsSnapshot,
} from '../../src/services/backend-client';

vi.mock('../../src/services/backend-client', () => ({
  connectHeartbeat: vi.fn(() => () => {}),
  fetchOpsSnapshot: vi.fn(),
  getAuthToken: vi.fn(() => ''),
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

  it('polls /api/ops at 2s so the fallback stays under the 60/min route limit', async () => {
    vi.mocked(streamOpsSnapshot).mockImplementation(
      () => ({ abort: vi.fn() }) as unknown as AbortController,
    );
    vi.mocked(fetchOpsSnapshot).mockRejectedValue(new Error('rest down'));
    const setIntervalSpy = vi.spyOn(window, 'setInterval');

    render(<ExecutionDashboard />);

    await waitFor(() => expect(setIntervalSpy).toHaveBeenCalled());
    expect(setIntervalSpy).toHaveBeenCalledWith(expect.any(Function), 2_000);
  });

  it('clears the prior snapshot when connecting to an unreachable server', async () => {
    const first = emptySnap();
    first.server = { ...first.server, version: 'old-server' };

    vi.mocked(streamOpsSnapshot).mockImplementation((onSnapshot) => {
      onSnapshot(first);
      return { abort: vi.fn() } as unknown as AbortController;
    });
    vi.mocked(fetchOpsSnapshot).mockResolvedValue(first);

    const { getByText, getByPlaceholderText, queryByText } = render(<ExecutionDashboard />);
    await waitFor(() => expect(getByText('old-server')).toBeInTheDocument());

    vi.mocked(probeBackendStatus).mockResolvedValue('unreachable');
    vi.mocked(fetchOpsSnapshot).mockRejectedValue(new Error('down'));
    vi.mocked(streamOpsSnapshot).mockImplementation(
      () => ({ abort: vi.fn() }) as unknown as AbortController,
    );

    const input = getByPlaceholderText('http://localhost:4747');
    fireEvent.change(input, { target: { value: 'http://127.0.0.1:9999' } });
    fireEvent.submit(input.closest('form')!);

    await waitFor(() => {
      expect(queryByText('old-server')).not.toBeInTheDocument();
    });
  });

  it('keeps an invalid-server error when the prior stream delivers a snapshot', async () => {
    let onFrame: ((snapshot: OpsSnapshot) => void) | undefined;
    vi.mocked(streamOpsSnapshot).mockImplementation((onSnapshot) => {
      onFrame = onSnapshot;
      return { abort: vi.fn() } as unknown as AbortController;
    });
    vi.mocked(fetchOpsSnapshot).mockResolvedValue(emptySnap());
    vi.mocked(normalizeServerUrl).mockImplementation((url: string) => {
      if (url.includes('bad')) throw new Error('Invalid backend URL');
      return url;
    });

    const { getByText, getByPlaceholderText } = render(<ExecutionDashboard />);
    await waitFor(() => expect(onFrame).toBeTypeOf('function'));

    const input = getByPlaceholderText('http://localhost:4747');
    fireEvent.change(input, { target: { value: 'http://bad' } });
    fireEvent.submit(input.closest('form')!);

    await waitFor(() => expect(getByText('Invalid backend URL')).toBeInTheDocument());
    onFrame!(emptySnap());
    await waitFor(() => expect(getByText('Invalid backend URL')).toBeInTheDocument());
  });
});

describe('ExecutionDashboard ?server= link', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(probeBackendStatus).mockResolvedValue('ok');
    vi.mocked(fetchOpsSnapshot).mockResolvedValue(emptySnap());
    vi.mocked(streamOpsSnapshot).mockReturnValue({ abort: vi.fn() } as unknown as AbortController);
    window.history.replaceState({}, '', '/?view=ops&server=https://other.example');
  });

  afterEach(() => {
    window.history.replaceState({}, '', '/');
    vi.mocked(getAuthToken).mockReturnValue('');
  });

  it('does not auto-connect a foreign server while a deploy token is held', async () => {
    vi.mocked(getAuthToken).mockReturnValue('deploy-token');
    const { getByDisplayValue } = render(<ExecutionDashboard />);

    expect(getByDisplayValue('https://other.example')).toBeInTheDocument();
    expect(setBackendUrl).not.toHaveBeenCalled();
    expect(streamOpsSnapshot).not.toHaveBeenCalled();
  });

  it('auto-connects the linked server when no token is held', async () => {
    render(<ExecutionDashboard />);

    await waitFor(() => expect(setBackendUrl).toHaveBeenCalledWith('https://other.example'));
  });
});

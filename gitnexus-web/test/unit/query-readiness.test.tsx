import { act, fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { QueryFAB } from '../../src/components/QueryFAB';
import { StatusBar } from '../../src/components/StatusBar';
import { createKnowledgeGraph } from '../../src/core/graph/graph';
import { AppStateProvider, useAppState } from '../../src/hooks/useAppState';
import i18n, { i18nReady } from '../../src/i18n';
import {
  probeBackendStatus,
  probeQueryService,
  runQuery,
  type BackendProbeStatus,
} from '../../src/services/backend-client';

vi.mock('../../src/services/backend-client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/services/backend-client')>()),
  probeBackendStatus: vi.fn(),
  probeQueryService: vi.fn(),
  runQuery: vi.fn(),
}));

const Harness = () => {
  const { setCurrentRepo, setGraph, setServerBaseUrl, setViewMode, setQueryServerConnected } =
    useAppState();

  return (
    <>
      <button
        onClick={() => {
          setServerBaseUrl('http://localhost:4747');
          setCurrentRepo('repo-a');
          setGraph(createKnowledgeGraph());
          setViewMode('exploring');
        }}
      >
        Load repo
      </button>
      <button onClick={() => setCurrentRepo('repo-b')}>Switch repo</button>
      <button onClick={() => setQueryServerConnected(false)}>Disconnect</button>
      <button onClick={() => setQueryServerConnected(true)}>Reconnect</button>
      <StatusBar />
      <QueryFAB />
    </>
  );
};

const start = () => {
  render(
    <AppStateProvider>
      <Harness />
    </AppStateProvider>,
  );
  fireEvent.click(screen.getByRole('button', { name: 'Load repo' }));
};

const openQuery = (query = 'RETURN 1') => {
  fireEvent.click(screen.getByRole('button', { name: 'Query', exact: true }));
  const input = screen.getByRole('textbox');
  fireEvent.change(input, { target: { value: query } });
  return { input, run: screen.getByRole('button', { name: /^Run/ }) };
};

beforeEach(async () => {
  vi.mocked(probeBackendStatus).mockReset().mockResolvedValue('ok');
  vi.mocked(probeQueryService).mockReset().mockResolvedValue(true);
  vi.mocked(runQuery).mockReset().mockResolvedValue([]);
  await i18nReady;
  await i18n.changeLanguage('en');
});

describe('query readiness', () => {
  it('shows checking and disables both submission paths until the backend is available', async () => {
    const probe = Promise.withResolvers<BackendProbeStatus>();
    vi.mocked(probeBackendStatus).mockReturnValueOnce(probe.promise);
    start();
    const { input, run } = openQuery();

    expect(screen.getByTestId('status-query-checking')).toBeInTheDocument();
    expect(screen.queryByTestId('status-ready')).not.toBeInTheDocument();
    expect(run).toBeDisabled();
    await act(async () => probe.resolve('unreachable'));
    expect(screen.getByTestId('status-query-unavailable')).toHaveTextContent('Query unavailable');
    expect(run).toHaveAccessibleDescription(/check the backend connection/i);
    fireEvent.click(run);
    fireEvent.keyDown(input, { key: 'Enter', metaKey: true });
    expect(runQuery).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Check again' }));
    expect(await screen.findByTestId('status-ready')).toBeInTheDocument();
    expect(run).toBeEnabled();
    await act(async () => fireEvent.keyDown(input, { key: 'Enter', ctrlKey: true }));
    expect(runQuery).toHaveBeenCalledWith('RETURN 1', 'repo-a');
  });

  it('drops a stale successful check after losing the heartbeat and recovers on reconnect', async () => {
    start();
    expect(await screen.findByTestId('status-ready')).toBeInTheDocument();
    const { run } = openQuery();
    expect(await screen.findByTestId('status-ready')).toBeInTheDocument();
    const probe = Promise.withResolvers<BackendProbeStatus>();
    vi.mocked(probeBackendStatus).mockReturnValueOnce(probe.promise);
    fireEvent.click(run);
    fireEvent.click(screen.getByRole('button', { name: 'Disconnect' }));
    await act(async () => probe.resolve('ok'));

    expect(screen.getByTestId('status-query-unavailable')).toBeInTheDocument();
    expect(run).toBeDisabled();
    expect(runQuery).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Reconnect' }));
    expect(await screen.findByTestId('status-ready')).toBeInTheDocument();
    expect(run).toBeEnabled();
  });

  it('disables empty submissions and reports when the preflight health check fails', async () => {
    start();
    expect(await screen.findByTestId('status-ready')).toBeInTheDocument();
    const probesBeforeOpen = vi.mocked(probeBackendStatus).mock.calls.length;
    const { input, run } = openQuery(' ');
    expect(screen.getByTestId('status-ready')).toBeInTheDocument();
    expect(probeBackendStatus).toHaveBeenCalledTimes(probesBeforeOpen);
    expect(run).toBeDisabled();
    fireEvent.keyDown(input, { key: 'Enter', ctrlKey: true });
    expect(runQuery).not.toHaveBeenCalled();

    fireEvent.change(input, { target: { value: 'RETURN 1' } });
    expect(run).toBeEnabled();
    vi.mocked(probeBackendStatus).mockResolvedValueOnce('unreachable');
    fireEvent.click(run);
    expect(await screen.findByTestId('status-query-unavailable')).toBeInTheDocument();
    expect(run).toBeDisabled();
    expect(runQuery).not.toHaveBeenCalled();

    fireEvent.keyDown(input, { key: 'Escape' });
    const reopened = openQuery();
    expect(await screen.findByTestId('status-ready')).toBeInTheDocument();
    expect(reopened.run).toBeEnabled();
  });

  it('checks again on a repo switch instead of displaying the previous repo as ready', async () => {
    start();
    expect(await screen.findByTestId('status-ready')).toBeInTheDocument();
    const probe = Promise.withResolvers<BackendProbeStatus>();
    vi.mocked(probeBackendStatus).mockReturnValueOnce(probe.promise);
    fireEvent.click(screen.getByRole('button', { name: 'Switch repo' }));
    expect(screen.getByTestId('status-query-checking')).toBeInTheDocument();
    await act(async () => probe.resolve('unauthorized'));
    expect(screen.getByTestId('status-query-unavailable')).toBeInTheDocument();
  });

  it('stays unavailable when the server is live but the repo cannot be queried', async () => {
    vi.mocked(probeQueryService).mockResolvedValue(false);
    start();
    const { run } = openQuery();
    expect(await screen.findByTestId('status-query-unavailable')).toBeInTheDocument();
    expect(probeQueryService).toHaveBeenCalledWith('repo-a');
    expect(run).toBeDisabled();

    vi.mocked(probeQueryService).mockResolvedValue(true);
    fireEvent.click(screen.getByRole('button', { name: 'Check again' }));
    expect(await screen.findByTestId('status-ready')).toBeInTheDocument();
    expect(run).toBeEnabled();
  });
});

import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import App from '../../src/App';
import i18n, { i18nReady } from '../../src/i18n';
import type { ConnectResult, ServerInfo } from '../../src/services/backend-client';

const UPDATE_DISMISSED_VERSION_KEY = 'gitnexus.updateDismissedVersion';

const appStateConfig = vi.hoisted(() => ({
  initialViewMode: 'onboarding' as 'onboarding' | 'loading' | 'exploring',
}));

const backendMocks = vi.hoisted(() => ({
  fetchServerInfo: vi.fn<() => Promise<ServerInfo>>(),
  fetchRepos: vi.fn(async () => []),
  connectHeartbeat: vi.fn(),
}));

vi.mock('../../src/hooks/useAppState', async () => {
  const React = await import('react');
  const AppStateContext = React.createContext<Record<string, unknown> | null>(null);

  return {
    AppStateProvider: ({ children }: { children: React.ReactNode }) => {
      const [viewMode, setViewMode] = React.useState(appStateConfig.initialViewMode);
      const [serverBaseUrl, setServerBaseUrl] = React.useState<string | null>(null);
      const stable = React.useRef({
        setGraph: vi.fn(),
        setGraphMode: vi.fn(),
        setChatOnlyNodeCount: vi.fn(),
        setProgress: vi.fn(),
        setProjectName: vi.fn(),
        setSettingsPanelOpen: vi.fn(),
        refreshLLMSettings: vi.fn(),
        initializeAgent: vi.fn(async () => {}),
        startEmbeddingsWithFallback: vi.fn(),
        setAvailableRepos: vi.fn(),
        switchRepo: vi.fn(async () => {}),
        setCurrentRepo: vi.fn(),
      }).current;

      return (
        <AppStateContext.Provider
          value={{
            ...stable,
            viewMode,
            setViewMode,
            progress:
              viewMode === 'loading'
                ? { phase: 'extracting', percent: 1, message: 'Loading' }
                : null,
            isRightPanelOpen: false,
            isSettingsPanelOpen: false,
            codeReferences: [],
            selectedNode: null,
            isCodePanelOpen: false,
            serverBaseUrl,
            setServerBaseUrl,
            availableRepos: [],
          }}
        >
          {children}
        </AppStateContext.Provider>
      );
    },
    useAppState: () => {
      const value = React.useContext(AppStateContext);
      if (!value) throw new Error('Missing test AppStateProvider');
      return value;
    },
  };
});

const connectResult: ConnectResult = {
  nodes: [],
  relationships: [],
  repoInfo: {
    name: 'demo',
    path: '/workspace/demo',
    repoPath: '/workspace/demo',
    indexedAt: '2026-09-04T00:00:00.000Z',
  },
  graphSkipped: false,
};

vi.mock('../../src/components/DropZone', () => ({
  DropZone: ({
    onServerConnect,
  }: {
    onServerConnect: (result: ConnectResult, serverUrl: string) => Promise<void>;
  }) => (
    <button onClick={() => void onServerConnect(connectResult, 'http://localhost:4747')}>
      Connect test backend
    </button>
  ),
}));
vi.mock('../../src/components/LoadingOverlay', () => ({
  LoadingOverlay: () => <div>Loading view</div>,
}));
vi.mock('../../src/components/Header', () => ({ Header: () => <header>Header</header> }));
vi.mock('../../src/components/GraphCanvas', async () => {
  const React = await import('react');
  return { GraphCanvas: React.forwardRef(() => <div>Graph</div>) };
});
vi.mock('../../src/components/RightPanel', () => ({ RightPanel: () => null }));
vi.mock('../../src/components/SettingsPanel', () => ({ SettingsPanel: () => null }));
vi.mock('../../src/components/StatusBar', () => ({ StatusBar: () => null }));
vi.mock('../../src/components/FileTreePanel', () => ({ FileTreePanel: () => null }));
vi.mock('../../src/components/CodeReferencesPanel', () => ({
  CodeReferencesPanel: () => null,
}));
vi.mock('../../src/core/llm/settings-service', () => ({
  getActiveProviderConfig: () => null,
}));

vi.mock('../../src/services/backend-client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/services/backend-client')>();
  return {
    ...actual,
    fetchServerInfo: backendMocks.fetchServerInfo,
    fetchRepos: backendMocks.fetchRepos,
    connectHeartbeat: backendMocks.connectHeartbeat,
  };
});

const updateInfo = (latestVersion = '2.0.0'): ServerInfo => ({
  version: '1.0.0',
  launchContext: 'global',
  nodeVersion: 'v22.0.0',
  latestVersion,
  updateAvailable: true,
});

async function connectBackend() {
  await userEvent.click(screen.getByRole('button', { name: 'Connect test backend' }));
}

describe('update banner', () => {
  beforeEach(async () => {
    await i18nReady;
    await i18n.changeLanguage('en');
    appStateConfig.initialViewMode = 'onboarding';
    localStorage.removeItem(UPDATE_DISMISSED_VERSION_KEY);
    backendMocks.fetchServerInfo.mockReset();
    backendMocks.fetchRepos.mockClear();
    backendMocks.connectHeartbeat.mockReset();
    backendMocks.connectHeartbeat.mockReturnValue(() => {});
  });

  afterEach(() => {
    cleanup();
    window.history.replaceState(null, '', '/');
  });

  it('fetches only after a backend is selected and renders interpolated update copy', async () => {
    backendMocks.fetchServerInfo.mockResolvedValue(updateInfo());
    render(<App />);

    expect(backendMocks.fetchServerInfo).not.toHaveBeenCalled();
    expect(screen.queryByRole('status')).not.toBeInTheDocument();

    await connectBackend();

    expect(await screen.findByRole('status')).toHaveTextContent(
      'GitNexus 2.0.0 is available — this server runs 1.0.0.',
    );
    expect(backendMocks.fetchServerInfo).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['false', { ...updateInfo(), updateAvailable: false }],
    ['absent', { version: '1.0.0', launchContext: 'global', nodeVersion: 'v22.0.0' }],
  ])('stays hidden when update state is %s', async (_label, info) => {
    backendMocks.fetchServerInfo.mockResolvedValue(info as ServerInfo);
    render(<App />);

    await connectBackend();
    await waitFor(() => expect(backendMocks.fetchServerInfo).toHaveBeenCalledTimes(1));

    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });

  it('gives the reconnect banner priority and refetches after reconnect', async () => {
    backendMocks.fetchServerInfo.mockResolvedValue(updateInfo());
    render(<App />);
    await connectBackend();
    expect(await screen.findByRole('status')).toBeInTheDocument();

    const [onConnect, onReconnecting] = backendMocks.connectHeartbeat.mock.calls[0];
    act(() => onReconnecting());
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
    expect(screen.getByText(/reconnect/i)).toBeInTheDocument();

    await act(async () => onConnect());
    await waitFor(() => expect(backendMocks.fetchServerInfo).toHaveBeenCalledTimes(2));
    expect(screen.getByRole('status')).toBeInTheDocument();
  });

  it('persists dismissal across remounts', async () => {
    backendMocks.fetchServerInfo.mockResolvedValue(updateInfo());
    const first = render(<App />);
    await connectBackend();

    await userEvent.click(
      await screen.findByRole('button', { name: 'Dismiss update notification' }),
    );
    expect(localStorage.getItem(UPDATE_DISMISSED_VERSION_KEY)).toBe('2.0.0');
    expect(screen.queryByRole('status')).not.toBeInTheDocument();

    first.unmount();
    window.history.replaceState(null, '', '/');
    render(<App />);
    await connectBackend();
    await waitFor(() => expect(backendMocks.fetchServerInfo).toHaveBeenCalledTimes(2));
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });

  it('re-shows after a newer version than the dismissed one appears', async () => {
    localStorage.setItem(UPDATE_DISMISSED_VERSION_KEY, '2.0.0');
    backendMocks.fetchServerInfo.mockResolvedValue(updateInfo('2.1.0'));
    render(<App />);

    await connectBackend();

    expect(await screen.findByRole('status')).toHaveTextContent('GitNexus 2.1.0 is available');
  });

  it('fails open without rendering an error UI', async () => {
    backendMocks.fetchServerInfo.mockRejectedValue(new Error('offline'));
    render(<App />);

    await connectBackend();
    await waitFor(() => expect(backendMocks.fetchServerInfo).toHaveBeenCalledTimes(1));

    expect(screen.queryByRole('status')).not.toBeInTheDocument();
    expect(screen.queryByText(/offline/i)).not.toBeInTheDocument();
  });

  it('never mounts on onboarding or loading views', () => {
    backendMocks.fetchServerInfo.mockResolvedValue(updateInfo());
    const onboarding = render(<App />);
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
    expect(backendMocks.fetchServerInfo).not.toHaveBeenCalled();

    onboarding.unmount();
    appStateConfig.initialViewMode = 'loading';
    render(<App />);
    expect(screen.getByText('Loading view')).toBeInTheDocument();
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
    expect(backendMocks.fetchServerInfo).not.toHaveBeenCalled();
  });

  it('has a keyboard-focusable dismiss control with an accessible label', async () => {
    backendMocks.fetchServerInfo.mockResolvedValue(updateInfo());
    render(<App />);
    await connectBackend();

    const dismiss = await screen.findByRole('button', { name: 'Dismiss update notification' });
    dismiss.focus();
    expect(dismiss).toHaveFocus();
    await userEvent.keyboard('{Enter}');

    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });

  it('renders translated copy in zh-CN', async () => {
    await i18n.changeLanguage('zh-CN');
    backendMocks.fetchServerInfo.mockResolvedValue(updateInfo());
    render(<App />);

    await connectBackend();

    expect(await screen.findByRole('status')).toHaveTextContent(
      'GitNexus 2.0.0 已发布 — 此服务器运行 1.0.0。',
    );
  });
});

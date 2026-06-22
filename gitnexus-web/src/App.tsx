import { useCallback, useEffect, useRef, useState } from 'react';
import { AppStateProvider, useAppState } from './hooks/useAppState';
import { DropZone } from './components/DropZone';
import { LoadingOverlay } from './components/LoadingOverlay';
import { Header } from './components/Header';
import { GraphCanvas, GraphCanvasHandle } from './components/GraphCanvas';
import { RightPanel } from './components/RightPanel';
import { SettingsPanel } from './components/SettingsPanel';
import { StatusBar } from './components/StatusBar';
import { FileTreePanel } from './components/FileTreePanel';
import { CodeReferencesPanel } from './components/CodeReferencesPanel';
import { getActiveProviderConfig } from './core/llm/settings-service';
import { buildGraphFromConnectResult } from './lib/apply-connect-result';
import {
  connectToServer,
  fetchRepos,
  normalizeServerUrl,
  connectHeartbeat,
  BackendError,
  type ConnectResult,
  type BackendRepo,
} from './services/backend-client';
import { ERROR_RESET_DELAY_MS } from './config/ui-constants';
import { parseSkipGraphParam } from './lib/graph-load-decision';
import { formatBackendError } from './i18n/error-messages';
import { useTranslation } from 'react-i18next';

const AppContent = () => {
  const { t } = useTranslation(['common', 'errors']);
  const {
    viewMode,
    setViewMode,
    setGraph,
    setGraphMode,
    setChatOnlyNodeCount,
    setProgress,
    setProjectName,
    progress,
    isRightPanelOpen,
    isSettingsPanelOpen,
    setSettingsPanelOpen,
    refreshLLMSettings,
    initializeAgent,
    startEmbeddingsWithFallback,
    codeReferences,
    selectedNode,
    isCodePanelOpen,
    serverBaseUrl,
    setServerBaseUrl,
    availableRepos,
    setAvailableRepos,
    switchRepo,
    setCurrentRepo,
  } = useAppState();

  const graphCanvasRef = useRef<GraphCanvasHandle>(null);
  const [serverDisconnected, setServerDisconnected] = useState(false);

  const handleServerConnect = useCallback(
    async (result: ConnectResult): Promise<void> => {
      // Use the canonical repo name from the server response so all subsequent
      // backend calls (queries, search, grep, readFile) scope to this repo.
      const repoPath = result.repoInfo.repoPath ?? result.repoInfo.path;
      // Normalize both Windows (\) and Unix (/) path separators before splitting
      const projectName =
        result.repoInfo.name ||
        (repoPath || '').replace(/\\/g, '/').split('/').filter(Boolean).pop() ||
        'server-project';
      setProjectName(projectName);
      setCurrentRepo(projectName);

      // Build KnowledgeGraph from server data for visualization. In chat-only
      // mode the graph download was skipped, so the shared builder keeps an
      // empty (but non-null) graph and flags the mode so the UI shows the
      // chat-only empty state, with the node count captured for its notice.
      const built = buildGraphFromConnectResult(result);
      setGraph(built.graph);
      setGraphMode(built.graphMode);
      setChatOnlyNodeCount(built.graphMode === 'chatOnly' ? built.nodeCount : null);

      // Persist the active project in the URL for bookmarkability and F5 refresh resilience
      const urlObj = new URL(window.location.href);
      urlObj.searchParams.set('project', projectName);
      window.history.replaceState(null, '', urlObj.toString());

      // Transition directly to exploring view
      setViewMode('exploring');

      // Initialize agent with backend queries, then start embeddings. Pass the
      // chat-only flag so the agent's prompt matches the loaded/skipped graph (#2178).
      try {
        if (getActiveProviderConfig()) {
          await initializeAgent(projectName, { chatOnly: result.graphSkipped });
        }
        startEmbeddingsWithFallback();
      } catch (err) {
        console.warn('Failed to initialize agent:', err);
      }
    },
    [
      setViewMode,
      setGraph,
      setGraphMode,
      setChatOnlyNodeCount,
      setProjectName,
      setCurrentRepo,
      initializeAgent,
      startEmbeddingsWithFallback,
    ],
  );

  // Auto-connect when ?server or ?project query param is present (bookmarkable shortcut)
  const autoConnectRan = useRef(false);
  const tRef = useRef(t);
  useEffect(() => {
    tRef.current = t;
  }, [t]);

  useEffect(() => {
    if (autoConnectRan.current) return;
    const params = new URLSearchParams(window.location.search);
    const serverUrlParam = params.get('server');
    const projectParam = params.get('project');
    // `?skipGraph=1` forces chat-only, `?skipGraph=0` forces a full graph;
    // absent → auto-detect by node count. Bookmarkable / survives F5 (#2178).
    const skipGraphParam = parseSkipGraphParam(params.get('skipGraph'));

    if (!serverUrlParam && !projectParam) return;
    autoConnectRan.current = true;

    setProgress({
      phase: 'extracting',
      percent: 0,
      message: tRef.current('common:progress.connecting'),
      detail: tRef.current('common:progress.validatingServer'),
    });
    setViewMode('loading');

    const serverUrl = serverUrlParam || window.location.origin;
    const baseUrl = normalizeServerUrl(serverUrl);

    const tryConnect = async () => {
      return await connectToServer(
        serverUrl,
        (phase, downloaded, total) => {
          if (phase === 'validating') {
            setProgress({
              phase: 'extracting',
              percent: 5,
              message: tRef.current('common:progress.connecting'),
              detail: tRef.current('common:progress.validatingServer'),
            });
          } else if (phase === 'downloading') {
            const pct = total ? Math.round((downloaded / total) * 90) + 5 : 50;
            const mb = (downloaded / (1024 * 1024)).toFixed(1);
            setProgress({
              phase: 'extracting',
              percent: pct,
              message: tRef.current('common:progress.downloadingGraph'),
              detail: tRef.current('common:progress.downloadedMb', { mb }),
            });
          } else if (phase === 'extracting') {
            setProgress({
              phase: 'extracting',
              percent: 97,
              message: tRef.current('common:progress.processing'),
              detail: tRef.current('common:progress.extractingFileContents'),
            });
          }
        },
        undefined,
        projectParam || undefined,
        { awaitAnalysis: true, skipGraph: skipGraphParam }, // hold-queue + chat-only control (#2178)
      );
    };

    tryConnect()
      .then(async (result) => {
        // Set serverBaseUrl BEFORE handleServerConnect: the latter transitions
        // to 'exploring' (rendering the chat-only overlay + its "Load graph
        // anyway" button) and then awaits agent init, leaving a window where
        // loadGraphAnyway would silently no-op on a still-null serverBaseUrl.
        setServerBaseUrl(baseUrl);
        await handleServerConnect(result);
        setProgress(null);
        fetchRepos()
          .then((repos) => setAvailableRepos(repos))
          .catch((e) => console.warn('Failed to fetch repo list:', e));
      })
      .catch((err) => {
        console.error('Auto-connect failed:', err);
        setProgress({
          phase: 'error',
          percent: 0,
          message: tRef.current('errors:connectFailed'),
          detail: formatBackendError(err, tRef.current),
        });
        setTimeout(() => {
          setViewMode('onboarding');
          setProgress(null);
        }, ERROR_RESET_DELAY_MS);
      });
  }, [handleServerConnect, setProgress, setViewMode, setServerBaseUrl, setAvailableRepos]);

  const handleFocusNode = useCallback((nodeId: string) => {
    graphCanvasRef.current?.focusNode(nodeId);
  }, []);

  // Handle settings saved - refresh and reinitialize agent
  // NOTE: Must be defined BEFORE any conditional returns (React hooks rule)
  const handleSettingsSaved = useCallback(() => {
    refreshLLMSettings();
    initializeAgent();
  }, [refreshLLMSettings, initializeAgent]);

  // ── Server heartbeat: detect when server goes down while exploring ────────
  // Uses SSE (EventSource) for instant detection — no polling delay.
  // On disconnect: show a reconnecting banner instead of resetting to onboarding.
  // The heartbeat retries indefinitely with capped backoff and recovers automatically.
  useEffect(() => {
    if (viewMode !== 'exploring') return;

    const cleanup = connectHeartbeat(
      () => setServerDisconnected(false),
      () => setServerDisconnected(true),
    );

    return cleanup;
  }, [viewMode]);

  // Render based on view mode
  if (viewMode === 'onboarding') {
    return (
      <DropZone
        onServerConnect={async (result, serverUrl) => {
          // Refresh repo list before transitioning so it's ready in the header
          const repos = await fetchRepos().catch(() => [] as BackendRepo[]);
          setAvailableRepos(repos);
          await handleServerConnect(result);
          setProgress(null);
          if (serverUrl) {
            const base = normalizeServerUrl(serverUrl);
            setServerBaseUrl(base);
            // Add ?server= so F5 reconnects to this server
            const url = new URL(window.location.href);
            url.searchParams.set('server', base);
            window.history.replaceState(null, '', url.toString());
          }
        }}
      />
    );
  }

  if (viewMode === 'loading' && progress) {
    return <LoadingOverlay progress={progress} />;
  }

  // Exploring view
  return (
    <div className="flex h-screen flex-col overflow-hidden bg-void">
      <Header
        onFocusNode={handleFocusNode}
        availableRepos={availableRepos}
        onSwitchRepo={switchRepo}
        onReposChanged={(repos) => setAvailableRepos(repos)}
        onAnalyzeComplete={async (repoName) => {
          // A new repo was just indexed via the header dropdown.
          // Refresh the repo list, connect to the new repo, and switch to it.
          // Retry once after 1s if the repo isn't found yet (server may still
          // be reinitializing after the worker completed).
          const url = serverBaseUrl ?? 'http://localhost:4747';
          for (let attempt = 0; attempt < 2; attempt++) {
            try {
              const repos = await fetchRepos();
              setAvailableRepos(repos);
              // Auto-detect by size for a freshly-analyzed repo (#2178). A stale
              // ?skipGraph from a previously-viewed repo must NOT leak in here —
              // that would bypass the size guard and could re-trigger the hang.
              const result = await connectToServer(url, undefined, undefined, repoName);
              await handleServerConnect(result);
              setServerBaseUrl(normalizeServerUrl(url));
              setProgress(null);
              return;
            } catch (err: unknown) {
              if (attempt === 0 && err instanceof BackendError && err.status === 404) {
                // Server may still be reinitializing — wait and retry
                await new Promise((r) => setTimeout(r, 1500));
                continue;
              }
              console.error('Failed to connect after analyze:', err);
              fetchRepos()
                .then((repos) => setAvailableRepos(repos))
                .catch(() => {});
              return;
            }
          }
        }}
      />

      <main className="flex min-h-0 flex-1">
        {/* Left Panel - File Tree */}
        <FileTreePanel onFocusNode={handleFocusNode} />

        {/* Graph area - takes remaining space */}
        <div className="relative min-w-0 flex-1">
          <GraphCanvas ref={graphCanvasRef} />

          {/* Code References Panel (overlay) - does NOT resize the graph, it overlaps on top */}
          {isCodePanelOpen && (codeReferences.length > 0 || !!selectedNode) && (
            <div className="pointer-events-auto absolute inset-y-0 left-0 z-30">
              <CodeReferencesPanel onFocusNode={handleFocusNode} />
            </div>
          )}
        </div>

        {/* Right Panel - Code & Chat (tabbed) */}
        {isRightPanelOpen && <RightPanel />}
      </main>

      <StatusBar />

      {serverDisconnected && (
        <div className="fixed bottom-12 left-1/2 z-50 -translate-x-1/2 rounded-lg border border-yellow-500/30 bg-yellow-900/80 px-4 py-2 text-sm text-yellow-200 shadow-lg backdrop-blur">
          {t('errors:backend.reconnecting')}
        </div>
      )}

      {/* Settings Panel (modal) */}
      <SettingsPanel
        isOpen={isSettingsPanelOpen}
        onClose={() => setSettingsPanelOpen(false)}
        onSettingsSaved={handleSettingsSaved}
      />
    </div>
  );
};

function App() {
  return (
    <AppStateProvider>
      <AppContent />
    </AppStateProvider>
  );
}

export default App;

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
import { RefreshCw } from './lib/lucide-icons';
import { getActiveProviderConfig } from './core/llm/settings-service';
import { createKnowledgeGraph } from './core/graph/graph';
import {
  connectToServer,
  fetchGroupStatuses,
  fetchRepos,
  normalizeServerUrl,
  connectHeartbeat,
  connectIndexEvents,
  BackendError,
  type ConnectResult,
  type BackendRepo,
  type IndexEventsSnapshot,
} from './services/backend-client';
import { ERROR_RESET_DELAY_MS } from './config/ui-constants';

const AppContent = () => {
  const {
    viewMode,
    setViewMode,
    setGraph,
    setProgress,
    setProjectName,
    projectName,
    progress,
    isRightPanelOpen,
    isSettingsPanelOpen,
    setSettingsPanelOpen,
    refreshLLMSettings,
    initializeAgent,
    codeReferences,
    selectedNode,
    setSelectedNode,
    isCodePanelOpen,
    serverBaseUrl,
    setServerBaseUrl,
    availableRepos,
    setAvailableRepos,
    switchRepo,
    setCurrentRepo,
  } = useAppState();

  const graphCanvasRef = useRef<GraphCanvasHandle>(null);
  const activeRepoRef = useRef<string | null>(null);
  const indexedAtRef = useRef<string | null>(null);
  const refreshInFlightRef = useRef(false);
  const selectedNodeRef = useRef(selectedNode);
  const isCodePanelOpenRef = useRef(isCodePanelOpen);
  const graphInteractionRef = useRef(false);
  const graphInteractionTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [serverDisconnected, setServerDisconnected] = useState(false);
  const [graphSyncStatus, setGraphSyncStatus] = useState<'stale' | 'syncing' | 'synced' | 'failed'>(
    'synced',
  );
  const [graphSyncMessage, setGraphSyncMessage] = useState<string | undefined>();
  const [indexSnapshot, setIndexSnapshot] = useState<IndexEventsSnapshot | null>(null);
  const [pendingGraphUpdate, setPendingGraphUpdate] = useState<{
    repoName: string;
    indexedAt: string;
  } | null>(null);
  const [autoApplyGraphUpdates, setAutoApplyGraphUpdates] = useState(true);
  const [groupStatuses, setGroupStatuses] = useState<
    Awaited<ReturnType<typeof fetchGroupStatuses>>
  >([]);

  useEffect(() => {
    selectedNodeRef.current = selectedNode;
  }, [selectedNode]);

  useEffect(() => {
    isCodePanelOpenRef.current = isCodePanelOpen;
  }, [isCodePanelOpen]);

  useEffect(
    () => () => {
      if (graphInteractionTimerRef.current) clearTimeout(graphInteractionTimerRef.current);
    },
    [],
  );

  const isGraphBusy = useCallback(
    () => graphInteractionRef.current || !!selectedNodeRef.current || isCodePanelOpenRef.current,
    [],
  );

  const refreshGroupStatuses = useCallback(async (repoName?: string): Promise<void> => {
    try {
      setGroupStatuses(await fetchGroupStatuses(repoName));
    } catch (err) {
      console.warn('Failed to fetch group statuses:', err);
      setGroupStatuses([]);
    }
  }, []);

  const handleServerConnect = useCallback(
    async (result: ConnectResult): Promise<void> => {
      // Use the canonical repo name from the server response so all subsequent
      // backend calls (queries, search, grep, readFile) scope to this repo.
      const repoName = result.repoInfo.name;
      const repoPath = result.repoInfo.repoPath ?? result.repoInfo.path;
      activeRepoRef.current = repoName;
      indexedAtRef.current = result.repoInfo.indexedAt ?? null;
      setGraphSyncStatus('synced');
      setGraphSyncMessage(undefined);
      // Normalize both Windows (\) and Unix (/) path separators before splitting
      const projectName =
        result.repoInfo.name ||
        (repoPath || '').replace(/\\/g, '/').split('/').filter(Boolean).pop() ||
        'server-project';
      setProjectName(projectName);
      setCurrentRepo(projectName);
      void refreshGroupStatuses(projectName);

      // Build KnowledgeGraph from server data for visualization
      const graph = createKnowledgeGraph();
      for (const node of result.nodes) {
        graph.addNode(node);
      }
      for (const rel of result.relationships) {
        graph.addRelationship(rel);
      }
      setGraph(graph);
      if (selectedNodeRef.current) {
        const refreshedSelection = result.nodes.find((node) => node.id === selectedNodeRef.current?.id);
        setSelectedNode(refreshedSelection ?? null);
      }
      setPendingGraphUpdate(null);

      // Persist the active project in the URL for bookmarkability and F5 refresh resilience
      const urlObj = new URL(window.location.href);
      urlObj.searchParams.set('project', projectName);
      window.history.replaceState(null, '', urlObj.toString());

      // Transition directly to exploring view
      setViewMode('exploring');

      // Initialize agent with backend queries. Embeddings remain a manual action
      // from the header so opening the graph does not take the local DB lock.
      try {
        if (getActiveProviderConfig()) {
          await initializeAgent(projectName);
        }
      } catch (err) {
        console.warn('Failed to initialize agent:', err);
      }
    },
    [
      setViewMode,
      setGraph,
      setSelectedNode,
      setProjectName,
      setCurrentRepo,
      refreshGroupStatuses,
      initializeAgent,
    ],
  );

  const refreshActiveGraph = useCallback(
    async (repoName: string, indexedAt: string): Promise<void> => {
      if (refreshInFlightRef.current) return;
      refreshInFlightRef.current = true;
      setGraphSyncStatus('syncing');
      setGraphSyncMessage('Refreshing UI');

      try {
        const url = serverBaseUrl ?? window.location.origin;
        const result = await connectToServer(url, undefined, undefined, repoName, {
          awaitAnalysis: true,
        });
        await handleServerConnect(result);
        indexedAtRef.current = result.repoInfo.indexedAt ?? indexedAt;
        setGraphSyncStatus('synced');
        setGraphSyncMessage(undefined);
      } catch (err) {
        console.error('Graph refresh failed:', err);
        setGraphSyncStatus('failed');
        setGraphSyncMessage('Refresh failed');
      } finally {
        refreshInFlightRef.current = false;
      }
    },
    [handleServerConnect, serverBaseUrl],
  );

  const applyPendingGraphUpdate = useCallback(() => {
    const pending = pendingGraphUpdate;
    if (!pending) return;
    setPendingGraphUpdate(null);
    void refreshActiveGraph(pending.repoName, pending.indexedAt);
  }, [pendingGraphUpdate, refreshActiveGraph]);

  useEffect(() => {
    if (!pendingGraphUpdate || !autoApplyGraphUpdates || isGraphBusy()) return;
    applyPendingGraphUpdate();
  }, [
    applyPendingGraphUpdate,
    autoApplyGraphUpdates,
    isCodePanelOpen,
    isGraphBusy,
    pendingGraphUpdate,
    selectedNode,
  ]);

  // Auto-connect when ?server or ?project query param is present (bookmarkable shortcut)
  const autoConnectRan = useRef(false);
  useEffect(() => {
    if (autoConnectRan.current) return;
    const params = new URLSearchParams(window.location.search);
    const serverUrlParam = params.get('server');
    const projectParam = params.get('project');

    if (!serverUrlParam && !projectParam) return;
    autoConnectRan.current = true;

    setProgress({
      phase: 'extracting',
      percent: 0,
      message: 'Connecting to server...',
      detail: 'Validating server',
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
              message: 'Connecting to server...',
              detail: 'Validating server',
            });
          } else if (phase === 'downloading') {
            const pct = total ? Math.round((downloaded / total) * 90) + 5 : 50;
            const mb = (downloaded / (1024 * 1024)).toFixed(1);
            setProgress({
              phase: 'extracting',
              percent: pct,
              message: 'Downloading graph...',
              detail: `${mb} MB downloaded`,
            });
          } else if (phase === 'extracting') {
            setProgress({
              phase: 'extracting',
              percent: 97,
              message: 'Processing...',
              detail: 'Extracting file contents',
            });
          }
        },
        undefined,
        projectParam || undefined,
        { awaitAnalysis: true }, // enable backend hold-queue for repos still being analyzed
      );
    };

    tryConnect()
      .then(async (result) => {
        await handleServerConnect(result);
        setProgress(null);
        setServerBaseUrl(baseUrl);
        fetchRepos()
          .then((repos) => setAvailableRepos(repos))
          .catch((e) => console.warn('Failed to fetch repo list:', e));
      })
      .catch((err) => {
        console.error('Auto-connect failed:', err);
        setProgress({
          phase: 'error',
          percent: 0,
          message: 'Failed to connect to server',
          detail: err instanceof Error ? err.message : 'Unknown error',
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

  const markGraphInteraction = useCallback(() => {
    graphInteractionRef.current = true;
    if (graphInteractionTimerRef.current) clearTimeout(graphInteractionTimerRef.current);
    graphInteractionTimerRef.current = setTimeout(() => {
      graphInteractionRef.current = false;
    }, 900);
  }, []);

  const handleSwitchRepo = useCallback(
    async (repoName: string) => {
      setGroupStatuses([]);
      setGraphSyncStatus('syncing');
      setGraphSyncMessage('Switching repo');
      await switchRepo(repoName);
      activeRepoRef.current = repoName;
      indexedAtRef.current = null;
      setGraphSyncStatus('synced');
      setGraphSyncMessage(undefined);
      await refreshGroupStatuses(repoName);
    },
    [switchRepo, refreshGroupStatuses],
  );

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

  useEffect(() => {
    if (viewMode !== 'exploring') return;

    const cleanup = connectIndexEvents(
      (snapshot) => {
        setIndexSnapshot(snapshot);
        setAvailableRepos(snapshot.repos);
        const activeRepo = activeRepoRef.current || projectName;
        if (!activeRepo) return;

        const repo = snapshot.repos.find((candidate) => candidate.name === activeRepo);
        if (!repo) return;

        const activeJob = snapshot.activeJobs?.find((job) => {
          const jobRepoName = job.repoName || (job.repoPath || '').split(/[/\\]/).filter(Boolean).pop();
          return jobRepoName?.toLowerCase() === activeRepo.toLowerCase();
        });
        if (activeJob) {
          setGraphSyncStatus('syncing');
          setGraphSyncMessage(activeJob.progress.message || 'Currently indexing');
        }

        const lastIndexedAt = indexedAtRef.current;
        if (!lastIndexedAt) {
          indexedAtRef.current = repo.indexedAt;
          if (!activeJob) {
            setGraphSyncStatus('synced');
            setGraphSyncMessage(undefined);
          }
          return;
        }

        if (repo.indexedAt !== lastIndexedAt) {
          setGraphSyncStatus('stale');
          setGraphSyncMessage('Graph changed');
          if (autoApplyGraphUpdates && !isGraphBusy()) {
            void refreshActiveGraph(repo.name, repo.indexedAt);
          } else {
            setPendingGraphUpdate({ repoName: repo.name, indexedAt: repo.indexedAt });
          }
        }
      },
      (error) => {
        if (!activeRepoRef.current && !projectName) return;
        console.warn('Index update stream error:', error);
        setGraphSyncStatus('failed');
        setGraphSyncMessage('Sync interrupted');
      },
    );

    return cleanup;
  }, [
    autoApplyGraphUpdates,
    isGraphBusy,
    projectName,
    refreshActiveGraph,
    setAvailableRepos,
    viewMode,
  ]);

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
        groupStatuses={groupStatuses}
        onSwitchRepo={handleSwitchRepo}
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
        <div
          className="relative min-w-0 flex-1"
          onPointerDown={markGraphInteraction}
          onPointerMove={markGraphInteraction}
          onWheel={markGraphInteraction}
        >
          <GraphCanvas ref={graphCanvasRef} />

          {pendingGraphUpdate && (
            <div className="absolute top-4 right-16 z-30 flex items-center gap-2 rounded-lg border border-yellow-400/30 bg-yellow-500/15 px-3 py-2 text-xs text-yellow-100 shadow-xl backdrop-blur">
              <RefreshCw className="h-3.5 w-3.5" />
              <span className="font-medium">Graph changed</span>
              <button
                onClick={applyPendingGraphUpdate}
                className="rounded-md border border-yellow-300/30 bg-yellow-300/10 px-2 py-1 text-yellow-50 transition-colors hover:bg-yellow-300/20"
              >
                Apply now
              </button>
              <label className="flex items-center gap-1.5 text-yellow-100/80">
                <input
                  type="checkbox"
                  checked={autoApplyGraphUpdates}
                  onChange={(event) => setAutoApplyGraphUpdates(event.target.checked)}
                  className="h-3 w-3 accent-yellow-300"
                />
                Auto apply
              </label>
            </div>
          )}

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

      <StatusBar
        activeRepoName={projectName}
        groupStatuses={groupStatuses}
        graphSyncStatus={graphSyncStatus}
        graphSyncMessage={graphSyncMessage}
        indexSnapshot={indexSnapshot}
      />

      {serverDisconnected && (
        <div className="fixed bottom-12 left-1/2 z-50 -translate-x-1/2 rounded-lg border border-yellow-500/30 bg-yellow-900/80 px-4 py-2 text-sm text-yellow-200 shadow-lg backdrop-blur">
          Server connection lost — reconnecting&hellip;
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

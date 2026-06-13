import {
  createContext,
  useContext,
  useState,
  useCallback,
  useRef,
  useEffect,
  useMemo,
  ReactNode,
} from 'react';
import type { GraphNode, NodeLabel, PipelineProgress } from 'gitnexus-shared';
import type { KnowledgeGraph } from '../core/graph/types';
import { buildGraphFromConnectResult } from '../lib/apply-connect-result';
import type {
  LLMSettings,
  AgentStreamChunk,
  ChatMessage,
  ToolCallInfo,
  MessageStep,
} from '../core/llm/types';
import {
  loadSettings,
  getActiveProviderConfig,
  getProviderCapabilities,
  saveSettings,
} from '../core/llm/settings-service';
import type { AgentMessage } from '../core/llm/agent';
import { type EdgeType } from '../lib/constants';
import {
  connectToServer,
  runQuery as backendRunQuery,
  search as backendSearch,
  grep as backendGrep,
  readFile as backendReadFile,
  startEmbeddings as backendStartEmbeddings,
  streamEmbeddingProgress,
  probeBackend,
  type BackendRepo,
  type ConnectResult,
  type JobProgress,
} from '../services/backend-client';
import { ERROR_RESET_DELAY_MS } from '../config/ui-constants';
import i18n from '../i18n';
import { normalizePath } from '../lib/path-resolution';
import { FILE_REF_REGEX, NODE_REF_REGEX } from '../lib/grounding-patterns';
import { GraphStateProvider, useGraphState, type GraphMode } from './app-state/graph';

export const AUTO_START_EMBEDDINGS_STORAGE_KEY = 'gitnexus.autoStartEmbeddings';

export const shouldAutoStartEmbeddings = (): boolean => {
  if (typeof window === 'undefined' || !window.localStorage) return false;
  return window.localStorage.getItem(AUTO_START_EMBEDDINGS_STORAGE_KEY) === 'true';
};

export type ViewMode = 'onboarding' | 'loading' | 'exploring';
export type RightPanelTab = 'code' | 'chat';
export type EmbeddingStatus = 'idle' | 'loading' | 'embedding' | 'indexing' | 'ready' | 'error';

export interface QueryResult {
  rows: Record<string, any>[];
  nodeIds: string[];
  executionTime: number;
}

// Animation types for graph nodes
export type AnimationType = 'pulse' | 'ripple' | 'glow';

export interface NodeAnimation {
  type: AnimationType;
  startTime: number;
  duration: number;
}

// Code reference from AI grounding or user selection
export interface CodeReference {
  id: string;
  filePath: string;
  startLine?: number;
  endLine?: number;
  nodeId?: string; // Associated graph node ID
  label?: string; // File, Function, Class, etc.
  name?: string; // Display name
  source: 'ai' | 'user'; // How it was added
}

export interface CodeReferenceFocus {
  filePath: string;
  startLine?: number;
  endLine?: number;
  ts: number;
}

interface AppState {
  // View state
  viewMode: ViewMode;
  setViewMode: (mode: ViewMode) => void;

  // Graph data
  graph: KnowledgeGraph | null;
  setGraph: (graph: KnowledgeGraph | null) => void;

  // Selection
  selectedNode: GraphNode | null;
  setSelectedNode: (node: GraphNode | null) => void;

  // Right Panel (unified Code + Chat)
  isRightPanelOpen: boolean;
  setRightPanelOpen: (open: boolean) => void;
  rightPanelTab: RightPanelTab;
  setRightPanelTab: (tab: RightPanelTab) => void;
  openCodePanel: () => void;
  openChatPanel: () => void;
  helpDialogBoxOpen: boolean;
  setHelpDialogBoxOpen: (open: boolean) => void;

  // Filters
  visibleLabels: NodeLabel[];
  toggleLabelVisibility: (label: NodeLabel) => void;
  visibleEdgeTypes: EdgeType[];
  toggleEdgeVisibility: (edgeType: EdgeType) => void;

  // Depth filter (N hops from selection)
  depthFilter: number | null;
  setDepthFilter: (depth: number | null) => void;

  // Graph view mode
  graphViewMode: 'force' | 'tree' | 'circles';
  setGraphViewMode: (mode: 'force' | 'tree' | 'circles') => void;

  // Graph load mode (full download vs chat-only / skipped graph)
  graphMode: GraphMode;
  setGraphMode: (mode: GraphMode) => void;
  // Connected repo's node count while in chat-only mode (null when unknown)
  chatOnlyNodeCount: number | null;
  setChatOnlyNodeCount: (count: number | null) => void;

  // Query state
  highlightedNodeIds: Set<string>;
  setHighlightedNodeIds: (ids: Set<string>) => void;
  // AI highlights (toggable)
  aiCitationHighlightedNodeIds: Set<string>;
  aiToolHighlightedNodeIds: Set<string>;
  blastRadiusNodeIds: Set<string>;
  isAIHighlightsEnabled: boolean;
  toggleAIHighlights: () => void;
  clearAIToolHighlights: () => void;
  clearAICitationHighlights: () => void;
  clearBlastRadius: () => void;
  queryResult: QueryResult | null;
  setQueryResult: (result: QueryResult | null) => void;
  clearQueryHighlights: () => void;

  // Node animations (for MCP tool visual feedback)
  animatedNodes: Map<string, NodeAnimation>;
  triggerNodeAnimation: (nodeIds: string[], type: AnimationType) => void;
  clearAnimations: () => void;

  // Progress
  progress: PipelineProgress | null;
  setProgress: (progress: PipelineProgress | null) => void;

  // Project info
  projectName: string;
  setProjectName: (name: string) => void;

  // Multi-repo switching
  serverBaseUrl: string | null;
  setServerBaseUrl: (url: string | null) => void;
  availableRepos: BackendRepo[];
  setAvailableRepos: (repos: BackendRepo[]) => void;
  switchRepo: (repoName: string) => Promise<void>;
  setCurrentRepo: (repoName: string) => void;
  /** Download the full graph for the current repo after a chat-only connect (#2178). */
  loadGraphAnyway: () => Promise<void>;

  // Worker API (shared across app)
  runQuery: (cypher: string) => Promise<any[]>;
  isDatabaseReady: () => Promise<boolean>;

  // Embedding state
  embeddingStatus: EmbeddingStatus;
  embeddingProgress: { phase: string; percent: number } | null;

  // Embedding methods
  startEmbeddings: () => Promise<void>;
  startEmbeddingsWithFallback: () => void;
  semanticSearch: (query: string, k?: number) => Promise<any[]>;
  semanticSearchWithContext: (query: string, k?: number, hops?: number) => Promise<any[]>;
  isEmbeddingReady: boolean;

  // LLM/Agent state
  llmSettings: LLMSettings;
  updateLLMSettings: (updates: Partial<LLMSettings>) => void;
  isSettingsPanelOpen: boolean;
  setSettingsPanelOpen: (open: boolean) => void;
  isAgentReady: boolean;
  isAgentInitializing: boolean;
  agentError: string | null;

  // Chat state
  chatMessages: ChatMessage[];
  isChatLoading: boolean;
  currentToolCalls: ToolCallInfo[];

  // LLM methods
  refreshLLMSettings: () => void;
  initializeAgent: (overrideProjectName?: string, opts?: { chatOnly?: boolean }) => Promise<void>;
  sendChatMessage: (message: string) => Promise<void>;
  stopChatResponse: () => void;
  clearChat: () => void;

  // Code References Panel
  codeReferences: CodeReference[];
  isCodePanelOpen: boolean;
  setCodePanelOpen: (open: boolean) => void;
  addCodeReference: (ref: Omit<CodeReference, 'id'>) => void;
  removeCodeReference: (id: string) => void;
  clearAICodeReferences: () => void;
  clearCodeReferences: () => void;
  codeReferenceFocus: CodeReferenceFocus | null;
}

const AppStateContext = createContext<AppState | null>(null);

export const AppStateProvider = ({ children }: { children: ReactNode }) => (
  <GraphStateProvider>
    <AppStateProviderInner>{children}</AppStateProviderInner>
  </GraphStateProvider>
);

const AppStateProviderInner = ({ children }: { children: ReactNode }) => {
  // View state
  const [viewMode, setViewMode] = useState<ViewMode>('onboarding');

  const {
    graph,
    setGraph,
    selectedNode,
    setSelectedNode,
    visibleLabels,
    toggleLabelVisibility,
    visibleEdgeTypes,
    toggleEdgeVisibility,
    depthFilter,
    setDepthFilter,
    highlightedNodeIds,
    setHighlightedNodeIds,
    graphViewMode,
    setGraphViewMode,
    graphMode,
    setGraphMode,
    chatOnlyNodeCount,
    setChatOnlyNodeCount,
  } = useGraphState();

  // Right Panel
  const [isRightPanelOpen, setRightPanelOpen] = useState(false);
  const [rightPanelTab, setRightPanelTab] = useState<RightPanelTab>('code');
  const [helpDialogBoxOpen, setHelpDialogBoxOpen] = useState(false);

  const openCodePanel = useCallback(() => {
    // Legacy API: used by graph/tree selection.
    // Code is now shown in the Code References Panel (left of the graph),
    // so "openCodePanel" just ensures that panel becomes visible when needed.
    setCodePanelOpen(true);
  }, []);

  const openChatPanel = useCallback(() => {
    setRightPanelOpen(true);
    setRightPanelTab('chat');
  }, []);

  // Query state
  const [queryResult, setQueryResult] = useState<QueryResult | null>(null);

  // AI highlights (separate from user/query highlights)
  const [aiCitationHighlightedNodeIds, setAICitationHighlightedNodeIds] = useState<Set<string>>(
    new Set(),
  );
  const [aiToolHighlightedNodeIds, setAIToolHighlightedNodeIds] = useState<Set<string>>(new Set());
  const [blastRadiusNodeIds, setBlastRadiusNodeIds] = useState<Set<string>>(new Set());
  const [isAIHighlightsEnabled, setAIHighlightsEnabled] = useState(true);

  const toggleAIHighlights = useCallback(() => {
    setAIHighlightsEnabled((prev) => !prev);
  }, []);

  const clearAIToolHighlights = useCallback(() => {
    setAIToolHighlightedNodeIds(new Set());
  }, []);

  const clearAICitationHighlights = useCallback(() => {
    setAICitationHighlightedNodeIds(new Set());
  }, []);

  const clearBlastRadius = useCallback(() => {
    setBlastRadiusNodeIds(new Set());
  }, []);

  const clearQueryHighlights = useCallback(() => {
    setHighlightedNodeIds(new Set());
    setQueryResult(null);
  }, []);

  // Node animations (for MCP tool visual feedback)
  const [animatedNodes, setAnimatedNodes] = useState<Map<string, NodeAnimation>>(new Map());
  const animationTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const triggerNodeAnimation = useCallback((nodeIds: string[], type: AnimationType) => {
    const now = Date.now();
    const duration = type === 'pulse' ? 2000 : type === 'ripple' ? 3000 : 4000;

    setAnimatedNodes((prev) => {
      const next = new Map(prev);
      for (const id of nodeIds) {
        next.set(id, { type, startTime: now, duration });
      }
      return next;
    });

    // Auto-cleanup after duration
    setTimeout(() => {
      setAnimatedNodes((prev) => {
        const next = new Map(prev);
        for (const id of nodeIds) {
          const anim = next.get(id);
          if (anim && anim.startTime === now) {
            next.delete(id);
          }
        }
        return next;
      });
    }, duration + 100);
  }, []);

  const clearAnimations = useCallback(() => {
    setAnimatedNodes(new Map());
    if (animationTimerRef.current) {
      clearInterval(animationTimerRef.current);
      animationTimerRef.current = null;
    }
  }, []);

  // Progress
  const [progress, setProgress] = useState<PipelineProgress | null>(null);

  // Project info
  const [projectName, setProjectName] = useState<string>('');

  // Multi-repo switching
  const [serverBaseUrl, setServerBaseUrl] = useState<string | null>(null);
  const [availableRepos, setAvailableRepos] = useState<BackendRepo[]>([]);

  // Embedding state
  const [embeddingStatus, setEmbeddingStatus] = useState<EmbeddingStatus>('idle');
  const [embeddingProgress, setEmbeddingProgress] = useState<{
    phase: string;
    percent: number;
  } | null>(null);

  // LLM/Agent state
  const [llmSettings, setLLMSettings] = useState<LLMSettings>(loadSettings);
  const [isSettingsPanelOpen, setSettingsPanelOpen] = useState(false);
  const [isAgentReady, setIsAgentReady] = useState(false);
  const [isAgentInitializing, setIsAgentInitializing] = useState(false);
  const [agentError, setAgentError] = useState<string | null>(null);

  // Chat state
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>([]);
  const [isChatLoading, setIsChatLoading] = useState(false);
  const [currentToolCalls, setCurrentToolCalls] = useState<ToolCallInfo[]>([]);

  // Code References Panel state
  const [codeReferences, setCodeReferences] = useState<CodeReference[]>([]);
  const [isCodePanelOpen, setCodePanelOpen] = useState(false);
  const [codeReferenceFocus, setCodeReferenceFocus] = useState<CodeReferenceFocus | null>(null);

  // Map of normalized file path → node ID for graph-based lookups
  const fileNodeByPath = useMemo(() => {
    if (!graph) return new Map<string, string>();
    const map = new Map<string, string>();
    for (const n of graph.nodes) {
      if (n.label === 'File') {
        map.set(normalizePath(n.properties.filePath), n.id);
      }
    }
    return map;
  }, [graph]);

  // Map of normalized path → original path for resolving partial paths
  const filePathIndex = useMemo(() => {
    if (!graph) return new Map<string, string>();
    const map = new Map<string, string>();
    for (const n of graph.nodes) {
      if (n.label === 'File' && n.properties.filePath) {
        map.set(normalizePath(n.properties.filePath), n.properties.filePath);
      }
    }
    return map;
  }, [graph]);

  const resolveFilePath = useCallback(
    (requestedPath: string): string | null => {
      const normalized = normalizePath(requestedPath);
      // Exact match
      if (filePathIndex.has(normalized)) return filePathIndex.get(normalized)!;
      // Suffix match (partial paths like "src/utils.ts")
      for (const [key, value] of filePathIndex) {
        if (key.endsWith(normalized)) return value;
      }
      return null;
    },
    [filePathIndex],
  );

  const findFileNodeId = useCallback(
    (filePath: string): string | undefined => {
      return fileNodeByPath.get(normalizePath(filePath));
    },
    [fileNodeByPath],
  );

  // Code References methods
  const addCodeReference = useCallback((ref: Omit<CodeReference, 'id'>) => {
    const id = `ref-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const newRef: CodeReference = { ...ref, id };

    setCodeReferences((prev) => {
      // Don't add duplicates (same file + line range)
      const isDuplicate = prev.some(
        (r) =>
          r.filePath === ref.filePath && r.startLine === ref.startLine && r.endLine === ref.endLine,
      );
      if (isDuplicate) return prev;
      return [...prev, newRef];
    });

    // Auto-open panel when references are added
    setCodePanelOpen(true);

    // Signal the Code Inspector to focus (scroll + glow) this reference.
    // This should happen even if the reference already exists (duplicates are ignored),
    // so it must be separate from the add-to-list behavior.
    setCodeReferenceFocus({
      filePath: ref.filePath,
      startLine: ref.startLine,
      endLine: ref.endLine,
      ts: Date.now(),
    });

    // Track AI highlights separately so they can be toggled off in the UI
    if (ref.nodeId && ref.source === 'ai') {
      setAICitationHighlightedNodeIds((prev) => new Set([...prev, ref.nodeId!]));
    }
  }, []);

  // Remove ONLY AI-provided refs so each new chat response refreshes the Code panel
  const clearAICodeReferences = useCallback(() => {
    setCodeReferences((prev) => {
      const removed = prev.filter((r) => r.source === 'ai');
      const kept = prev.filter((r) => r.source !== 'ai');

      // Remove citation-based AI highlights for removed refs
      const removedNodeIds = new Set(removed.map((r) => r.nodeId).filter(Boolean) as string[]);
      if (removedNodeIds.size > 0) {
        setAICitationHighlightedNodeIds((prevIds) => {
          const next = new Set(prevIds);
          for (const id of removedNodeIds) next.delete(id);
          return next;
        });
      }

      // Don't auto-close if the user has something selected (top viewer)
      if (kept.length === 0 && !selectedNode) {
        setCodePanelOpen(false);
      }
      return kept;
    });
  }, [selectedNode]);

  // Auto-add a code reference when the user selects a node in the graph/tree
  useEffect(() => {
    if (!selectedNode) return;
    // User selection should show in the top "Selected file" viewer,
    // not be appended to the AI citations list.
    setCodePanelOpen(true);
  }, [selectedNode]);

  // Backend client — direct HTTP calls (no Worker/Comlink)
  const repoRef = useRef<string | undefined>(undefined);

  const setCurrentRepo = useCallback((repoName: string) => {
    repoRef.current = repoName;
  }, []);

  const runQuery = useCallback(async (cypher: string): Promise<any[]> => {
    return backendRunQuery(cypher, repoRef.current);
  }, []);

  const isDatabaseReady = useCallback(async (): Promise<boolean> => {
    return probeBackend();
  }, []);

  // Embedding methods — now trigger server-side via /api/embed
  const embedAbortRef = useRef<AbortController | null>(null);

  const startEmbeddings = useCallback(async (): Promise<void> => {
    const repo = repoRef.current;
    if (!repo) throw new Error('No repository loaded');

    setEmbeddingStatus('loading');
    setEmbeddingProgress(null);

    try {
      const { jobId } = await backendStartEmbeddings(repo);

      // Stream progress via SSE
      await new Promise<void>((resolve, reject) => {
        embedAbortRef.current = streamEmbeddingProgress(
          jobId,
          (progress: JobProgress) => {
            setEmbeddingProgress({ phase: progress.phase as any, percent: progress.percent });
            if (progress.phase === 'loading-model' || progress.phase === 'loading') {
              setEmbeddingStatus('loading');
            } else if (progress.phase === 'embedding') {
              setEmbeddingStatus('embedding');
            } else if (progress.phase === 'indexing') {
              setEmbeddingStatus('indexing');
            }
          },
          () => {
            setEmbeddingStatus('ready');
            setEmbeddingProgress({ phase: 'ready' as any, percent: 100 });
            resolve();
          },
          (error: string) => {
            setEmbeddingStatus('error');
            reject(new Error(error));
          },
        );
      });
    } catch (error: any) {
      if (error?.message?.includes('already in progress')) {
        // Dedup — embeddings already running, just wait
        setEmbeddingStatus('embedding');
        return;
      }
      setEmbeddingStatus('error');
      throw error;
    }
  }, []);

  const startEmbeddingsWithFallback = useCallback(() => {
    const isPlaywright =
      (typeof navigator !== 'undefined' && navigator.webdriver) ||
      (typeof import.meta !== 'undefined' &&
        typeof import.meta.env !== 'undefined' &&
        import.meta.env.VITE_PLAYWRIGHT_TEST) ||
      (typeof process !== 'undefined' && process.env.PLAYWRIGHT_TEST);
    if (isPlaywright) {
      setEmbeddingStatus('idle');
      return;
    }
    if (!shouldAutoStartEmbeddings()) {
      setEmbeddingStatus('idle');
      return;
    }
    startEmbeddings().catch((err) => {
      console.warn('Embeddings auto-start failed:', err);
    });
  }, [startEmbeddings]);

  const semanticSearch = useCallback(async (query: string, k: number = 10): Promise<any[]> => {
    return backendSearch(query, { limit: k, mode: 'semantic', repo: repoRef.current });
  }, []);

  const semanticSearchWithContext = useCallback(
    async (query: string, k: number = 5, _hops: number = 2): Promise<any[]> => {
      return backendSearch(query, {
        limit: k,
        mode: 'semantic',
        enrich: true,
        repo: repoRef.current,
      });
    },
    [],
  );

  // LLM methods
  const updateLLMSettings = useCallback((updates: Partial<LLMSettings>) => {
    setLLMSettings((prev) => {
      const next = { ...prev, ...updates };
      saveSettings(next);
      return next;
    });
  }, []);

  const refreshLLMSettings = useCallback(() => {
    setLLMSettings(loadSettings());
  }, []);

  // Agent state — agent runs on main thread now (I/O-bound, not CPU-bound)
  const agentRef = useRef<any>(null);
  const chatAbortRef = useRef<AbortController | null>(null);
  const chatStateRef = useRef<'idle' | 'streaming' | 'aborting'>('idle');

  // Mirror graphMode into a ref so initializeAgent's deferred callers (lazy chat
  // init, settings-driven re-init) can read the current mode without re-creating
  // the callback; connect-flow callers pass an explicit chatOnly flag. (#2178)
  const graphModeRef = useRef(graphMode);
  useEffect(() => {
    graphModeRef.current = graphMode;
  }, [graphMode]);

  const initializeAgent = useCallback(
    async (overrideProjectName?: string, opts?: { chatOnly?: boolean }): Promise<void> => {
      const config = getActiveProviderConfig();
      if (!config) {
        setAgentError('Please configure an LLM provider in settings');
        return;
      }
      // Explicit flag from connect-flow callers (race-safe); otherwise fall back
      // to live mode via the ref so deferred callers stay correct too. (#2178)
      const chatOnly = opts?.chatOnly ?? graphModeRef.current === 'chatOnly';

      setIsAgentInitializing(true);
      setAgentError(null);

      try {
        const effectiveProjectName = overrideProjectName || projectName || 'project';

        // Sync repoRef so all agent backend calls target the correct repo.
        // initializeAgent can be called from App.tsx (handleServerConnect) which
        // never sets repoRef.current directly — without this, queries default to repo[0].
        if (overrideProjectName) {
          repoRef.current = overrideProjectName;
        }
        const repo = repoRef.current;

        // Build backend interface for Graph RAG tools
        const { createGraphRAGAgent } = await import('../core/llm/agent');
        const { buildCodebaseContext } = await import('../core/llm/context-builder');

        const executeQuery = (cypher: string) => backendRunQuery(cypher, repo);
        const codebaseContext = await buildCodebaseContext(executeQuery, effectiveProjectName);

        const backend = {
          executeQuery,
          search: (query: string, opts?: any) => backendSearch(query, { ...opts, repo }),
          grep: (pattern: string, limit?: number) => backendGrep(pattern, repo, limit),
          readFile: (filePath: string) =>
            backendReadFile(filePath, { repo }).then((r) => r.content),
        };

        agentRef.current = createGraphRAGAgent(config, backend, codebaseContext, chatOnly);
        setIsAgentReady(true);
        setAgentError(null);
        if (import.meta.env.DEV) {
          console.log('✅ Agent initialized successfully');
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        setAgentError(message);
        setIsAgentReady(false);
      } finally {
        setIsAgentInitializing(false);
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [], // repoRef is a stable ref — we sync it explicitly on entry; no state deps needed
  );

  const sendChatMessage = useCallback(
    async (message: string): Promise<void> => {
      if (chatStateRef.current !== 'idle') return;

      // Refresh Code panel for the new question: keep user-pinned refs, clear old AI citations
      clearAICodeReferences();
      // Also clear previous tool-driven AI highlights (highlight_in_graph)
      clearAIToolHighlights();

      if (!isAgentReady) {
        // Try to initialize first
        await initializeAgent();
        if (!agentRef.current) return;
      }

      // Add user message
      const userMessage: ChatMessage = {
        id: `user-${Date.now()}`,
        role: 'user',
        content: message,
        timestamp: Date.now(),
      };
      setChatMessages((prev) => [...prev, userMessage]);

      // If embeddings are running and we're currently creating the vector index,
      // avoid a confusing "Embeddings not ready" error and give a clear wait message.
      if (embeddingStatus === 'indexing') {
        const assistantMessage: ChatMessage = {
          id: `assistant-${Date.now()}`,
          role: 'assistant',
          content: i18n.t('common:chat.waitForVectorIndex'),
          timestamp: Date.now(),
        };
        setChatMessages((prev) => [...prev, assistantMessage]);
        setAgentError(null);
        setIsChatLoading(false);
        setCurrentToolCalls([]);
        return;
      }

      setIsChatLoading(true);
      chatStateRef.current = 'streaming';
      setCurrentToolCalls([]);

      chatAbortRef.current?.abort();
      const chatAbortController = new AbortController();
      chatAbortRef.current = chatAbortController;

      const providerCapabilities = getProviderCapabilities(llmSettings.activeProvider);

      // Prepare message history for agent (convert our format to AgentMessage format)
      const history: AgentMessage[] = [...chatMessages, userMessage].flatMap<AgentMessage>((m) => {
        if (m.role === 'user') {
          return [{ role: 'user', content: m.content }];
        }
        if (m.role === 'tool') {
          return m.toolCallId
            ? [{ role: 'tool', content: m.content, toolCallId: m.toolCallId }]
            : [];
        }
        if (providerCapabilities.preserveAssistantTranscript && m.historyMessages?.length) {
          return m.historyMessages;
        }
        return [{ role: 'assistant', content: m.content }];
      });

      // Create placeholder for assistant response
      const assistantMessageId = `assistant-${Date.now()}`;
      // Use an ordered steps array to preserve execution order (reasoning → tool → reasoning → tool → answer)
      const stepsForMessage: MessageStep[] = [];
      // Keep toolCalls for backwards compat and currentToolCalls state
      const toolCallsForMessage: ToolCallInfo[] = [];
      let stepCounter = 0;
      let assistantHistoryMessages: ChatMessage['historyMessages'];

      // Helper to update the message with current steps
      const updateMessage = () => {
        // Build content from steps for backwards compatibility
        const contentParts = stepsForMessage
          .filter((s) => s.type === 'reasoning' || s.type === 'content')
          .map((s) => s.content)
          .filter(Boolean);
        const content = contentParts.join('\n\n');

        setChatMessages((prev) => {
          const existing = prev.find((m) => m.id === assistantMessageId);
          const newMessage: ChatMessage = {
            id: assistantMessageId,
            role: 'assistant' as const,
            content,
            historyMessages: assistantHistoryMessages,
            steps: [...stepsForMessage],
            toolCalls: [...toolCallsForMessage],
            timestamp: existing?.timestamp ?? Date.now(),
          };
          if (existing) {
            return prev.map((m) => (m.id === assistantMessageId ? newMessage : m));
          } else {
            return [...prev, newMessage];
          }
        });
      };
      let pendingUpdate = false;
      let rafHandle: number | null = null;
      const scheduleMessageUpdate = () => {
        if (pendingUpdate) return;
        pendingUpdate = true;
        rafHandle = requestAnimationFrame(() => {
          pendingUpdate = false;
          rafHandle = null;
          updateMessage();
        });
      };

      try {
        const onChunk = (chunk: AgentStreamChunk) => {
          switch (chunk.type) {
            case 'reasoning':
              // LLM's thinking/reasoning - accumulate contiguous reasoning
              if (chunk.reasoning) {
                const lastStep = stepsForMessage[stepsForMessage.length - 1];
                if (lastStep && lastStep.type === 'reasoning') {
                  // Append to existing reasoning step
                  stepsForMessage[stepsForMessage.length - 1] = {
                    ...lastStep,
                    content: (lastStep.content || '') + chunk.reasoning,
                  };
                } else {
                  // Create new reasoning step (after tool calls or at start)
                  stepsForMessage.push({
                    id: `step-${stepCounter++}`,
                    type: 'reasoning',
                    content: chunk.reasoning,
                  });
                }
                scheduleMessageUpdate();
              }
              break;

            case 'content':
              // Final answer content - accumulate into contiguous content step
              if (chunk.content) {
                // Only append if the LAST step is a content step (contiguous streaming)
                const lastStep = stepsForMessage[stepsForMessage.length - 1];
                if (lastStep && lastStep.type === 'content') {
                  // Append to existing content step
                  stepsForMessage[stepsForMessage.length - 1] = {
                    ...lastStep,
                    content: (lastStep.content || '') + chunk.content,
                  };
                } else {
                  // Create new content step (after tool calls or at start)
                  stepsForMessage.push({
                    id: `step-${stepCounter++}`,
                    type: 'content',
                    content: chunk.content,
                  });
                }
                scheduleMessageUpdate();

                // Parse inline grounding references and add them to the Code References panel.
                // Supports: [[file.ts:10-25]] (file refs) and [[Class:View]] (node refs)
                const currentContentStep = stepsForMessage[stepsForMessage.length - 1];
                const fullText =
                  currentContentStep && currentContentStep.type === 'content'
                    ? currentContentStep.content || ''
                    : '';

                // Pattern 1: File refs - [[path/file.ext]] or [[path/file.ext:line]] or [[path/file.ext:line-line]]
                // Line numbers are optional
                const fileRefRegex = new RegExp(FILE_REF_REGEX.source, FILE_REF_REGEX.flags);
                let fileMatch: RegExpExecArray | null;
                while ((fileMatch = fileRefRegex.exec(fullText)) !== null) {
                  const rawPath = fileMatch[1].trim();
                  const startLine1 = fileMatch[2] ? parseInt(fileMatch[2], 10) : undefined;
                  const endLine1 = fileMatch[3] ? parseInt(fileMatch[3], 10) : startLine1;

                  const resolvedPath = resolveFilePath(rawPath);
                  if (!resolvedPath) continue;

                  const startLine0 =
                    startLine1 !== undefined ? Math.max(0, startLine1 - 1) : undefined;
                  const endLine0 = endLine1 !== undefined ? Math.max(0, endLine1 - 1) : startLine0;
                  const nodeId = findFileNodeId(resolvedPath);

                  addCodeReference({
                    filePath: resolvedPath,
                    startLine: startLine0,
                    endLine: endLine0,
                    nodeId,
                    label: 'File',
                    name: resolvedPath.split('/').pop() ?? resolvedPath,
                    source: 'ai',
                  });
                }

                // Pattern 2: Node refs - [[Type:Name]] or [[graph:Type:Name]]
                const nodeRefRegex = new RegExp(NODE_REF_REGEX.source, NODE_REF_REGEX.flags);
                let nodeMatch: RegExpExecArray | null;
                while ((nodeMatch = nodeRefRegex.exec(fullText)) !== null) {
                  const nodeType = nodeMatch[1];
                  const nodeName = nodeMatch[2].trim();

                  // Find node in graph
                  if (!graph) continue;
                  const node = graph.nodes.find(
                    (n) => n.label === nodeType && n.properties.name === nodeName,
                  );
                  if (!node || !node.properties.filePath) continue;

                  const resolvedPath = resolveFilePath(node.properties.filePath);
                  if (!resolvedPath) continue;

                  addCodeReference({
                    filePath: resolvedPath,
                    startLine: node.properties.startLine
                      ? node.properties.startLine - 1
                      : undefined,
                    endLine: node.properties.endLine ? node.properties.endLine - 1 : undefined,
                    nodeId: node.id,
                    label: node.label,
                    name: node.properties.name,
                    source: 'ai',
                  });
                }
              }
              break;

            case 'tool_call':
              if (chunk.toolCall) {
                const tc = chunk.toolCall;
                toolCallsForMessage.push(tc);
                // Add tool call as a step (in order with reasoning)
                stepsForMessage.push({
                  id: `step-${stepCounter++}`,
                  type: 'tool_call',
                  toolCall: tc,
                });
                setCurrentToolCalls((prev) => [...prev, tc]);
                scheduleMessageUpdate();
              }
              break;

            case 'tool_result':
              if (chunk.toolCall) {
                const tc = chunk.toolCall;
                // Update the tool call status in toolCallsForMessage
                let idx = toolCallsForMessage.findIndex((t) => t.id === tc.id);
                if (idx < 0) {
                  idx = toolCallsForMessage.findIndex(
                    (t) => t.name === tc.name && t.status === 'running',
                  );
                }
                if (idx < 0) {
                  idx = toolCallsForMessage.findIndex((t) => t.name === tc.name && !t.result);
                }
                if (idx >= 0 && toolCallsForMessage[idx].status !== 'stopped') {
                  toolCallsForMessage[idx] = {
                    ...toolCallsForMessage[idx],
                    result: tc.result,
                    status: 'completed',
                  };
                }

                // Also update the tool call in steps
                const stepIdx = stepsForMessage.findIndex(
                  (s) =>
                    s.type === 'tool_call' &&
                    s.toolCall &&
                    (s.toolCall.id === tc.id ||
                      (s.toolCall.name === tc.name && s.toolCall.status === 'running')),
                );
                if (
                  stepIdx >= 0 &&
                  stepsForMessage[stepIdx].toolCall &&
                  stepsForMessage[stepIdx].toolCall!.status !== 'stopped'
                ) {
                  stepsForMessage[stepIdx] = {
                    ...stepsForMessage[stepIdx],
                    toolCall: {
                      ...stepsForMessage[stepIdx].toolCall!,
                      result: tc.result,
                      status: 'completed',
                    },
                  };
                }

                // Update currentToolCalls
                setCurrentToolCalls((prev) => {
                  let targetIdx = prev.findIndex((t) => t.id === tc.id);
                  if (targetIdx < 0) {
                    targetIdx = prev.findIndex((t) => t.name === tc.name && t.status === 'running');
                  }
                  if (targetIdx < 0) {
                    targetIdx = prev.findIndex((t) => t.name === tc.name && !t.result);
                  }
                  if (targetIdx >= 0) {
                    const target = prev[targetIdx];
                    if (target.status === 'stopped') return prev;
                    return prev.map((t, i) =>
                      i === targetIdx ? { ...t, result: tc.result, status: 'completed' } : t,
                    );
                  }
                  return prev;
                });

                scheduleMessageUpdate();

                // Parse highlight marker from tool results
                if (tc.result) {
                  const highlightMatch = tc.result.match(/\[HIGHLIGHT_NODES:([^\]]+)\]/);
                  if (highlightMatch) {
                    const rawIds = highlightMatch[1]
                      .split(',')
                      .map((id: string) => id.trim())
                      .filter(Boolean);
                    if (rawIds.length > 0 && graph) {
                      const matchedIds = new Set<string>();
                      const graphNodeIdSet = new Set(graph.nodes.map((n) => n.id));

                      for (const rawId of rawIds) {
                        if (graphNodeIdSet.has(rawId)) {
                          matchedIds.add(rawId);
                        } else {
                          const found = graph.nodes.find(
                            (n) => n.id.endsWith(rawId) || n.id.endsWith(':' + rawId),
                          )?.id;
                          if (found) {
                            matchedIds.add(found);
                          }
                        }
                      }

                      if (matchedIds.size > 0) {
                        setAIToolHighlightedNodeIds(matchedIds);
                      }
                    } else if (rawIds.length > 0) {
                      setAIToolHighlightedNodeIds(new Set(rawIds));
                    }
                  }

                  // Parse impact marker from tool results
                  const impactMatch = tc.result.match(/\[IMPACT:([^\]]+)\]/);
                  if (impactMatch) {
                    const rawIds = impactMatch[1]
                      .split(',')
                      .map((id: string) => id.trim())
                      .filter(Boolean);
                    if (rawIds.length > 0 && graph) {
                      const matchedIds = new Set<string>();
                      const graphNodeIdSet = new Set(graph.nodes.map((n) => n.id));

                      for (const rawId of rawIds) {
                        if (graphNodeIdSet.has(rawId)) {
                          matchedIds.add(rawId);
                        } else {
                          const found = graph.nodes.find(
                            (n) => n.id.endsWith(rawId) || n.id.endsWith(':' + rawId),
                          )?.id;
                          if (found) {
                            matchedIds.add(found);
                          }
                        }
                      }

                      if (matchedIds.size > 0) {
                        setBlastRadiusNodeIds(matchedIds);
                      }
                    } else if (rawIds.length > 0) {
                      setBlastRadiusNodeIds(new Set(rawIds));
                    }
                  }
                }
              }
              break;

            case 'error':
              setAgentError(chunk.error ?? 'Unknown error');
              break;

            case 'done':
              assistantHistoryMessages = providerCapabilities.preserveAssistantTranscript
                ? chunk.historyMessages
                : undefined;
              // Finalize the assistant message - just call updateMessage one more time
              scheduleMessageUpdate();
              break;
          }
        };

        // Stream agent response using the full streaming generator
        // (handles reasoning, tool_call, tool_result, content, and done events)
        const agent = agentRef.current;
        if (!agent) throw new Error('Agent not initialized');
        const { streamAgentResponse } = await import('../core/llm/agent');
        for await (const chunk of streamAgentResponse(agent, history, {
          captureHistory: providerCapabilities.preserveAssistantTranscript,
          signal: chatAbortController.signal,
        })) {
          if (chunk.type === 'cancelled') {
            break;
          }
          onChunk(chunk);
        }
      } catch (error) {
        if (!chatAbortController.signal.aborted) {
          const message = error instanceof Error ? error.message : String(error);
          setAgentError(message);
        }
      } finally {
        if (rafHandle != null) {
          cancelAnimationFrame(rafHandle);
          rafHandle = null;
        }
        chatStateRef.current = 'idle';
        setIsChatLoading(false);
        setCurrentToolCalls([]);
      }
    },
    [
      chatMessages,
      isAgentReady,
      initializeAgent,
      resolveFilePath,
      findFileNodeId,
      addCodeReference,
      clearAICodeReferences,
      clearAIToolHighlights,
      graph,
      embeddingStatus,
    ],
  );

  const stopChatResponse = useCallback(() => {
    if (!chatAbortRef.current) return;

    chatStateRef.current = 'aborting';
    chatAbortRef.current.abort();
    chatAbortRef.current = null;

    const stoppedLabel = i18n.t('chat:stopped');
    const markStoppedToolCall = (tc: ToolCallInfo): ToolCallInfo =>
      tc.status === 'running' || tc.status === 'pending'
        ? { ...tc, status: 'stopped', result: stoppedLabel }
        : tc;

    setCurrentToolCalls((prev) => prev.map(markStoppedToolCall));

    setChatMessages((prev) => {
      const lastAssistantIdx = [...prev]
        .map((m, i) => (m.role === 'assistant' ? i : -1))
        .filter((i) => i >= 0)
        .pop();
      if (lastAssistantIdx === undefined) return prev;

      const message = prev[lastAssistantIdx];

      const updated: ChatMessage = {
        ...message,
        toolCalls: message.toolCalls?.map(markStoppedToolCall),
        steps: message.steps?.map((step) =>
          step.type === 'tool_call' && step.toolCall
            ? { ...step, toolCall: markStoppedToolCall(step.toolCall) }
            : step,
        ),
      };
      return prev.map((m, i) => (i === lastAssistantIdx ? updated : m));
    });

    setIsChatLoading(false);
  }, []);

  const clearChat = useCallback(() => {
    chatAbortRef.current?.abort();
    chatAbortRef.current = null;
    chatStateRef.current = 'idle';
    setChatMessages([]);
    setCurrentToolCalls([]);
    setAgentError(null);
    setIsChatLoading(false);
  }, []);

  // Switch to a different repo on the connected server
  const switchRepo = useCallback(
    async (repoName: string) => {
      if (!serverBaseUrl) return;

      setProgress({
        phase: 'extracting',
        percent: 0,
        message: i18n.t('common:progress.switchingRepository'),
        detail: i18n.t('common:progress.loadingRepository', { repo: repoName }),
      });
      setViewMode('loading');
      setIsAgentReady(false);

      // Clear stale graph state from previous repo (highlights, selections, blast radius)
      // Without this, sigma reducers dim ALL nodes/edges because old node IDs don't match
      setHighlightedNodeIds(new Set());
      clearAIToolHighlights();
      clearAICitationHighlights();
      clearBlastRadius();
      setSelectedNode(null);
      setQueryResult(null);
      setCodeReferences([]);
      setCodePanelOpen(false);
      setCodeReferenceFocus(null);
      // Reset graph-load mode up front so a FAILED switch can't leave the
      // previous repo's stale chat-only overlay showing (#2178). The success
      // path re-derives the mode from the connect result below.
      setGraphMode('full');
      setChatOnlyNodeCount(null);

      let connectedRepo: BackendRepo | undefined;
      let pNameStr = repoName || 'server-project';
      let connectedChatOnly = false;

      try {
        const result: ConnectResult = await connectToServer(
          serverBaseUrl,
          (phase, downloaded, total) => {
            if (phase === 'validating') {
              setProgress({
                phase: 'extracting',
                percent: 5,
                message: i18n.t('common:progress.switchingRepository'),
                detail: i18n.t('common:progress.validating'),
              });
            } else if (phase === 'downloading') {
              const pct = total ? Math.round((downloaded / total) * 90) + 5 : 50;
              const mb = (downloaded / (1024 * 1024)).toFixed(1);
              setProgress({
                phase: 'extracting',
                percent: pct,
                message: i18n.t('common:progress.downloadingGraph'),
                detail: i18n.t('common:progress.downloadedMb', { mb }),
              });
            } else if (phase === 'extracting') {
              setProgress({
                phase: 'extracting',
                percent: 97,
                message: i18n.t('common:progress.processing'),
                detail: i18n.t('common:progress.extractingFileContents'),
              });
            }
          },
          undefined,
          repoName,
          { awaitAnalysis: true }, // enable backend hold-queue for repos still being analyzed
        );

        // Build graph for visualization
        const repoPath = result.repoInfo.repoPath ?? result.repoInfo.path;
        // Prefer the registry name, then normalize Windows \ and Unix / paths
        const pName =
          repoName ||
          result.repoInfo.name ||
          (repoPath || '').replace(/\\/g, '/').split('/').filter(Boolean).pop() ||
          'server-project';
        setProjectName(pName);
        repoRef.current = pName;

        connectedRepo = result.repoInfo;
        pNameStr = pName;

        // In chat-only mode the graph download was skipped; the shared builder
        // keeps an empty (but non-null) graph so existing `graph?.` consumers
        // stay happy, and reports the mode + node count in lockstep.
        const built = buildGraphFromConnectResult(result);
        setGraph(built.graph);
        setGraphMode(built.graphMode);
        setChatOnlyNodeCount(built.graphMode === 'chatOnly' ? built.nodeCount : null);
        connectedChatOnly = built.graphMode === 'chatOnly';
      } catch (err: unknown) {
        console.error('Repo switch failed:', err);
        setProgress({
          phase: 'error',
          percent: 0,
          message: i18n.t('common:progress.failedSwitchRepository'),
          detail: err instanceof Error ? err.message : i18n.t('common:progress.unknownError'),
        });
        setIsAgentReady(false);
        agentRef.current = null;
        setTimeout(() => {
          setViewMode('exploring');
          setProgress(null);
        }, ERROR_RESET_DELAY_MS);
        return; // Abort the whole switchRepo process
      }

      if (pNameStr) {
        // Persist the selected project in the URL so a refresh re-opens it.
        // Drop any `?skipGraph` override: a deliberate repo switch should make a
        // fresh per-repo decision (auto-detect) on the next refresh rather than
        // carry the previous repo's forced mode (#2178).
        const urlObj = new URL(window.location.href);
        urlObj.searchParams.set('project', pNameStr);
        urlObj.searchParams.delete('skipGraph');
        window.history.replaceState(null, '', urlObj.toString());
      }

      // Reset the agent and clear chat history so the AI starts fresh for the new repo
      agentRef.current = null;
      setIsAgentReady(false);
      setChatMessages([]);

      // Re-initialize agent with the new repo's graph context
      try {
        if (getActiveProviderConfig()) {
          await initializeAgent(pNameStr, { chatOnly: connectedChatOnly });
        }
        setViewMode('exploring');
        startEmbeddingsWithFallback();
        setProgress(null);
      } catch (err) {
        console.warn('Failed to initialize agent:', err);
        setIsAgentReady(false);
        agentRef.current = null;
        setAgentError('Failed to initialize agent');
        setViewMode('exploring');
        setProgress(null);
      }
    },
    [
      serverBaseUrl,
      setProgress,
      setViewMode,
      setProjectName,
      setGraph,
      setGraphMode,
      setChatOnlyNodeCount,
      initializeAgent,
      startEmbeddingsWithFallback,
      setHighlightedNodeIds,
      clearAIToolHighlights,
      clearAICitationHighlights,
      clearBlastRadius,
      setSelectedNode,
      setQueryResult,
      setCodeReferences,
      setCodePanelOpen,
      setCodeReferenceFocus,
      setChatMessages,
    ],
  );

  // Load the full graph for the current repo after a chat-only connection.
  // This is the escape hatch behind the chat-only empty state (#2178). It
  // forces `skipGraph: false` so the size-based auto-detect cannot re-skip it.
  // The override is session-scoped (deliberately NOT persisted to the URL): a
  // persisted `?skipGraph=0` would leak onto a different repo via the other
  // connect entry points and could silently re-trigger the hang on refresh.
  const loadGraphInFlightRef = useRef(false);
  // Cancels the in-flight load-anyway download; mountedRef gates post-await
  // state writes so an unmount mid-download can't setState on a dead instance.
  const loadGraphAbortRef = useRef<AbortController | null>(null);
  const loadGraphMountedRef = useRef(true);
  useEffect(() => {
    return () => {
      loadGraphMountedRef.current = false;
      loadGraphAbortRef.current?.abort();
    };
  }, []);
  const loadGraphAnyway = useCallback(async (): Promise<void> => {
    if (!serverBaseUrl) return;
    // Guard against a double-trigger (rapid double-click or a racing
    // programmatic call) starting two concurrent full-graph downloads.
    if (loadGraphInFlightRef.current) return;
    loadGraphInFlightRef.current = true;
    const repo = repoRef.current;
    const controller = new AbortController();
    loadGraphAbortRef.current = controller;

    setProgress({
      phase: 'extracting',
      percent: 0,
      message: i18n.t('common:progress.downloadingGraph'),
      detail: i18n.t('common:progress.validating'),
    });
    setViewMode('loading');

    try {
      const result = await connectToServer(
        serverBaseUrl,
        (phase, downloaded, total) => {
          if (phase === 'downloading') {
            const pct = total ? Math.round((downloaded / total) * 90) + 5 : 50;
            const mb = (downloaded / (1024 * 1024)).toFixed(1);
            setProgress({
              phase: 'extracting',
              percent: pct,
              message: i18n.t('common:progress.downloadingGraph'),
              detail: i18n.t('common:progress.downloadedMb', { mb }),
            });
          }
        },
        controller.signal,
        repo,
        { awaitAnalysis: true, skipGraph: false },
      );

      // Bail if we unmounted, or if a concurrent switchRepo changed the active
      // repo while this load was in flight (the late result must not clobber the
      // new repo's state). Guard keyed on the ref — an abort surfaces as a
      // BackendError, not a DOMException AbortError.
      if (!loadGraphMountedRef.current || repoRef.current !== repo) return;

      const built = buildGraphFromConnectResult(result);
      setGraph(built.graph);
      setGraphMode(built.graphMode);
      // Full download succeeded → leave chat-only mode; clear the cached count.
      setChatOnlyNodeCount(built.graphMode === 'chatOnly' ? built.nodeCount : null);

      setProgress(null);
      setViewMode('exploring');

      // The graph is now loaded — re-init the agent so its system prompt drops
      // the chat-only note (#2178, KTD2). Guarded on a configured provider, like
      // switchRepo; runs inside the mounted/stale guard above.
      if (getActiveProviderConfig()) {
        await initializeAgent(repo, { chatOnly: false });
      }
    } catch (err) {
      if (!loadGraphMountedRef.current || repoRef.current !== repo) return;
      console.error('Load graph anyway failed:', err);
      // Stay in chat-only mode (the overlay reappears) and return to the view.
      setProgress(null);
      setViewMode('exploring');
    } finally {
      if (loadGraphAbortRef.current === controller) loadGraphAbortRef.current = null;
      loadGraphInFlightRef.current = false;
    }
  }, [
    serverBaseUrl,
    setProgress,
    setViewMode,
    setGraph,
    setGraphMode,
    setChatOnlyNodeCount,
    initializeAgent,
  ]);

  const removeCodeReference = useCallback(
    (id: string) => {
      setCodeReferences((prev) => {
        const ref = prev.find((r) => r.id === id);
        const newRefs = prev.filter((r) => r.id !== id);

        // Remove AI citation highlight if this was the only AI reference to that node
        if (ref?.nodeId && ref.source === 'ai') {
          const stillReferenced = newRefs.some((r) => r.nodeId === ref.nodeId && r.source === 'ai');
          if (!stillReferenced) {
            setAICitationHighlightedNodeIds((prev) => {
              const next = new Set(prev);
              next.delete(ref.nodeId!);
              return next;
            });
          }
        }

        // Auto-close panel if no references left AND no selection in top viewer
        if (newRefs.length === 0 && !selectedNode) {
          setCodePanelOpen(false);
        }

        return newRefs;
      });
    },
    [selectedNode],
  );

  const clearCodeReferences = useCallback(() => {
    setCodeReferences([]);
    setCodePanelOpen(false);
    setCodeReferenceFocus(null);
  }, []);

  const value: AppState = {
    viewMode,
    setViewMode,
    graph,
    setGraph,
    selectedNode,
    setSelectedNode,
    isRightPanelOpen,
    setRightPanelOpen,
    rightPanelTab,
    setRightPanelTab,
    openCodePanel,
    openChatPanel,
    helpDialogBoxOpen,
    setHelpDialogBoxOpen,
    visibleLabels,
    toggleLabelVisibility,
    visibleEdgeTypes,
    toggleEdgeVisibility,
    depthFilter,
    setDepthFilter,
    graphViewMode,
    setGraphViewMode,
    graphMode,
    setGraphMode,
    chatOnlyNodeCount,
    setChatOnlyNodeCount,
    highlightedNodeIds,
    setHighlightedNodeIds,
    aiCitationHighlightedNodeIds,
    aiToolHighlightedNodeIds,
    blastRadiusNodeIds,
    isAIHighlightsEnabled,
    toggleAIHighlights,
    clearAIToolHighlights,
    clearAICitationHighlights,
    clearBlastRadius,
    queryResult,
    setQueryResult,
    clearQueryHighlights,
    // Node animations
    animatedNodes,
    triggerNodeAnimation,
    clearAnimations,
    progress,
    setProgress,
    projectName,
    setProjectName,
    // Multi-repo switching
    serverBaseUrl,
    setServerBaseUrl,
    availableRepos,
    setAvailableRepos,
    switchRepo,
    setCurrentRepo,
    loadGraphAnyway,
    runQuery,
    isDatabaseReady,
    // Embedding state and methods
    embeddingStatus,
    embeddingProgress,
    startEmbeddings,
    startEmbeddingsWithFallback,
    semanticSearch,
    semanticSearchWithContext,
    isEmbeddingReady: embeddingStatus === 'ready',
    // LLM/Agent state
    llmSettings,
    updateLLMSettings,
    isSettingsPanelOpen,
    setSettingsPanelOpen,
    isAgentReady,
    isAgentInitializing,
    agentError,
    // Chat state
    chatMessages,
    isChatLoading,
    currentToolCalls,
    // LLM methods
    refreshLLMSettings,
    initializeAgent,
    sendChatMessage,
    stopChatResponse,
    clearChat,
    // Code References Panel
    codeReferences,
    isCodePanelOpen,
    setCodePanelOpen,
    addCodeReference,
    removeCodeReference,
    clearAICodeReferences,
    clearCodeReferences,
    codeReferenceFocus,
  };

  return <AppStateContext.Provider value={value}>{children}</AppStateContext.Provider>;
};

export const useAppState = (): AppState => {
  const context = useContext(AppStateContext);
  if (!context) {
    throw new Error('useAppState must be used within AppStateProvider');
  }
  return context;
};

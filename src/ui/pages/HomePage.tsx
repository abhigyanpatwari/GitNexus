import React, { useState, useCallback, useEffect } from 'react';
import ErrorBoundary from '../components/ErrorBoundary.tsx';
import { GraphExplorer } from '../components/graph/index.ts';
import { ChatInterface } from '../components/chat/index.ts';
import SourceViewer from '../components/graph/SourceViewer.tsx';
import type { KnowledgeGraph } from '../../core/graph/types.ts';
import { IngestionService } from '../../services/ingestion.service.ts';
import { LLMService, type LLMProvider } from '../../ai/llm-service.ts';

interface AppState {
  // Data
  graph: KnowledgeGraph | null;
  fileContents: Map<string, string>;
  
  // UI State
  selectedNodeId: string | null;
  showWelcome: boolean;
  
  // Input State
  githubUrl: string;
  directoryFilter: string;
  fileExtensions: string;
  
  // Processing State
  isProcessing: boolean;
  progress: string;
  error: string;
  
  // Settings
  llmProvider: LLMProvider;
  llmApiKey: string;
  showSettings: boolean;
}

const initialState: AppState = {
  graph: null,
  fileContents: new Map(),
  selectedNodeId: null,
  showWelcome: true,
  githubUrl: '',
  directoryFilter: 'src,lib,components,pages,utils',
  fileExtensions: '.ts,.tsx,.js,.jsx,.py,.java,.cpp,.c,.cs,.php,.rb,.go,.rs,.swift,.kt,.scala,.clj,.hs,.ml,.fs,.elm,.dart,.lua,.r,.m,.sh,.sql,.html,.css,.scss,.less,.vue,.svelte',
  isProcessing: false,
  progress: '',
  error: '',
  llmProvider: 'openai',
  llmApiKey: localStorage.getItem('llm_api_key') || '',
  showSettings: false
};

const HomePage: React.FC = () => {
  const [state, setState] = useState<AppState>(initialState);
  const [services] = useState(() => ({
    ingestion: new IngestionService(),
    llm: new LLMService()
  }));

  const updateState = useCallback((updates: Partial<AppState>) => {
    setState(prev => ({ ...prev, ...updates }));
  }, []);

  // Save API key to localStorage
  useEffect(() => {
    if (state.llmApiKey) {
      localStorage.setItem('llm_api_key', state.llmApiKey);
    }
  }, [state.llmApiKey]);

  const handleFileUpload = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file || !file.name.endsWith('.zip')) {
      updateState({ error: 'Please select a valid ZIP file' });
      return;
    }

    try {
      updateState({ 
        isProcessing: true, 
        error: '', 
        progress: 'Reading ZIP file...',
        showWelcome: false
      });

      console.log('Starting ZIP processing...', file.name);

      const result = await services.ingestion.processZipFile(file, {
        directoryFilter: state.directoryFilter,
        fileExtensions: state.fileExtensions
      });

      console.log('ZIP processing completed:', {
        nodeCount: result.graph?.nodes?.length || 0,
        relationshipCount: result.graph?.relationships?.length || 0,
        fileCount: result.fileContents?.size || 0
      });

      updateState({
        graph: result.graph,
        fileContents: result.fileContents,
        isProcessing: false,
        progress: '',
        showWelcome: false // Ensure we stay in main interface
      });
    } catch (error) {
      console.error('ZIP processing error:', error);
      updateState({
        error: error instanceof Error ? error.message : 'Failed to process ZIP file',
        isProcessing: false,
        progress: '',
        showWelcome: true // Return to welcome screen on error
      });
    }
  };

  const handleGitHubProcess = async () => {
    if (!state.githubUrl.trim()) {
      updateState({ error: 'Please enter a GitHub repository URL' });
      return;
    }

    try {
      updateState({ 
        isProcessing: true, 
        error: '', 
        progress: 'Fetching repository...',
        showWelcome: false
      });

      console.log('Starting GitHub processing...', state.githubUrl);

      const result = await services.ingestion.processGitHubRepo(state.githubUrl, {
        directoryFilter: state.directoryFilter,
        fileExtensions: state.fileExtensions,
        onProgress: (progress) => {
          console.log('Progress:', progress);
          updateState({ progress });
        }
      });

      console.log('GitHub processing completed:', {
        nodeCount: result.graph?.nodes?.length || 0,
        relationshipCount: result.graph?.relationships?.length || 0,
        fileCount: result.fileContents?.size || 0
      });

      updateState({
        graph: result.graph,
        fileContents: result.fileContents,
        isProcessing: false,
        progress: '',
        showWelcome: false // Ensure we stay in main interface
      });
    } catch (error) {
      console.error('GitHub processing error:', error);
      updateState({
        error: error instanceof Error ? error.message : 'Failed to process repository',
        isProcessing: false,
        progress: '',
        showWelcome: true // Return to welcome screen on error
      });
    }
  };

  const handleNewProject = () => {
    updateState({
      graph: null,
      fileContents: new Map(),
      selectedNodeId: null,
      showWelcome: true,
      githubUrl: '',
      error: '',
      progress: ''
    });
  };

  const handleNodeSelect = (nodeId: string | null) => {
    console.log('HomePage - Node selected:', {
      nodeId,
      fileContentsSize: state.fileContents.size,
      fileContentsKeys: Array.from(state.fileContents.keys()).slice(0, 10),
      graphNodeCount: state.graph?.nodes?.length || 0
    });
    updateState({ selectedNodeId: nodeId });
  };

  const isApiKeyValid = services.llm.validateApiKey(state.llmProvider, state.llmApiKey);
  const isGraphValid = state.graph && state.graph.nodes && Array.isArray(state.graph.nodes) && state.graph.relationships && Array.isArray(state.graph.relationships);

  // Warm tone color palette
  const colors = {
    background: '#FDF6E3', // Warm cream
    surface: '#FFFFFF',
    surfaceWarm: '#FEF9F0', // Slightly warm white
    primary: '#D97706', // Warm orange
    primaryLight: '#F59E0B', // Light orange
    secondary: '#92400E', // Dark orange
    accent: '#DC2626', // Warm red
    text: '#451A03', // Dark brown
    textSecondary: '#78350F', // Medium brown
    textMuted: '#A16207', // Light brown
    border: '#FED7AA', // Light orange
    borderLight: '#FEF3C7', // Very light orange
    success: '#059669', // Warm green
    warning: '#D97706', // Orange
    error: '#DC2626' // Red
  };

  // Modern styles with warm theme
  const styles = {
    container: {
      display: 'flex',
      flexDirection: 'column' as const,
      height: '100vh',
      width: '100vw',
      backgroundColor: colors.background,
      fontFamily: "'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
      overflow: 'hidden'
    },

    // Top navbar (only visible when project is loaded)
    navbar: {
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      padding: '12px 24px',
      backgroundColor: colors.surface,
      borderBottom: `1px solid ${colors.borderLight}`,
      boxShadow: '0 1px 3px rgba(0,0,0,0.05)',
      position: 'relative' as const
    },

    navbarContent: {
      display: 'flex',
      alignItems: 'center',
      gap: '16px',
      fontSize: '14px',
      fontWeight: '500',
      color: colors.textSecondary
    },

    navbarButton: {
      padding: '8px 16px',
      backgroundColor: colors.surfaceWarm,
      border: `1px solid ${colors.border}`,
      borderRadius: '8px',
      color: colors.text,
      fontSize: '14px',
      fontWeight: '500',
      cursor: 'pointer',
      transition: 'all 0.2s ease',
      display: 'flex',
      alignItems: 'center',
      gap: '8px'
    },

    // Welcome screen (center overlay)
    welcomeOverlay: {
      position: 'fixed' as const,
      top: 0,
      left: 0,
      right: 0,
      bottom: 0,
      backgroundColor: colors.background,
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      zIndex: 1000
    },

    welcomeCard: {
      backgroundColor: colors.surface,
      borderRadius: '20px',
      padding: '48px',
      boxShadow: '0 20px 40px rgba(0,0,0,0.1)',
      border: `1px solid ${colors.borderLight}`,
      maxWidth: '600px',
      width: '90%',
      textAlign: 'center' as const
    },

    welcomeTitle: {
      fontSize: '32px',
      fontWeight: '700',
      color: colors.text,
      marginBottom: '16px',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      gap: '12px'
    },

    welcomeSubtitle: {
      fontSize: '18px',
      color: colors.textSecondary,
      marginBottom: '40px',
      lineHeight: '1.6'
    },

    inputSection: {
      display: 'flex',
      flexDirection: 'column' as const,
      gap: '24px',
      marginBottom: '32px'
    },

    inputGroup: {
      display: 'flex',
      flexDirection: 'column' as const,
      gap: '8px',
      textAlign: 'left' as const
    },

    label: {
      fontSize: '14px',
      fontWeight: '600',
      color: colors.text
    },

    input: {
      padding: '16px',
      border: `2px solid ${colors.border}`,
      borderRadius: '12px',
      fontSize: '16px',
      backgroundColor: colors.surfaceWarm,
      color: colors.text,
      transition: 'all 0.2s ease',
      outline: 'none'
    },

    primaryButton: {
      padding: '16px 32px',
      backgroundColor: colors.primary,
      border: 'none',
      borderRadius: '12px',
      color: 'white',
      fontSize: '16px',
      fontWeight: '600',
      cursor: 'pointer',
      transition: 'all 0.2s ease',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      gap: '8px'
    },

    secondaryButton: {
      padding: '12px 24px',
      backgroundColor: colors.surfaceWarm,
      border: `2px solid ${colors.border}`,
      borderRadius: '12px',
      color: colors.text,
      fontSize: '14px',
      fontWeight: '500',
      cursor: 'pointer',
      transition: 'all 0.2s ease'
    },

    orDivider: {
      display: 'flex',
      alignItems: 'center',
      gap: '16px',
      margin: '20px 0',
      color: colors.textMuted,
      fontSize: '14px',
      fontWeight: '500'
    },

    orLine: {
      flex: 1,
      height: '1px',
      backgroundColor: colors.border
    },

    // Main layout (when project is loaded)
    mainLayout: {
      display: 'flex',
      flex: 1,
      overflow: 'hidden'
    },

    // Left side - Knowledge Graph (70% width)
    leftPanel: {
      flex: '0 0 70%',
      backgroundColor: colors.surface,
      borderRight: `1px solid ${colors.borderLight}`,
      overflow: 'hidden'
    },

    // Right side - Chat and Source (30% width)
    rightPanel: {
      flex: '0 0 30%',
      display: 'flex',
      flexDirection: 'column' as const,
      backgroundColor: colors.surfaceWarm
    },

    // Right panel sections
    chatSection: {
      flex: '0 0 60%',
      borderBottom: `1px solid ${colors.borderLight}`,
      overflow: 'hidden'
    },

    sourceSection: {
      flex: '0 0 40%',
      overflow: 'hidden'
    },

    // Error and progress styles
    errorBanner: {
      backgroundColor: '#FEF2F2',
      border: `1px solid #FECACA`,
      color: colors.error,
      padding: '16px',
      borderRadius: '12px',
      margin: '16px 0',
      fontSize: '14px'
    },

    progressBanner: {
      backgroundColor: '#FEF3C7',
      border: `1px solid ${colors.border}`,
      color: colors.secondary,
      padding: '16px',
      borderRadius: '12px',
      margin: '16px 0',
      fontSize: '14px',
      display: 'flex',
      alignItems: 'center',
      gap: '12px'
    },

    spinner: {
      width: '20px',
      height: '20px',
      border: `2px solid ${colors.border}`,
      borderTop: `2px solid ${colors.primary}`,
      borderRadius: '50%',
      animation: 'spin 1s linear infinite'
    }
  };

  const renderWelcomeScreen = () => (
    <div style={styles.welcomeOverlay}>
      <div style={styles.welcomeCard}>
        <div style={styles.welcomeTitle}>
          <span>🔍</span>
          <span>GitNexus</span>
        </div>
        <div style={styles.welcomeSubtitle}>
          Transform your codebase into an interactive knowledge graph
        </div>

        {state.error && (
          <div style={styles.errorBanner}>
            {state.error}
          </div>
        )}

        {state.isProcessing && (
          <div style={styles.progressBanner}>
            <div style={styles.spinner}></div>
            {state.progress}
          </div>
        )}

        <div style={styles.inputSection}>
          <div style={styles.inputGroup}>
            <label style={styles.label}>GitHub Repository URL</label>
            <input
              type="text"
              value={state.githubUrl}
              onChange={(e) => updateState({ githubUrl: e.target.value })}
              placeholder="https://github.com/owner/repo"
              style={styles.input}
              disabled={state.isProcessing}
            />
            <button
              onClick={handleGitHubProcess}
              disabled={state.isProcessing || !state.githubUrl.trim()}
              style={{
                ...styles.primaryButton,
                opacity: state.isProcessing || !state.githubUrl.trim() ? 0.5 : 1
              }}
            >
              <span>📊</span>
              Analyze Repository
            </button>
          </div>

          <div style={styles.orDivider}>
            <div style={styles.orLine}></div>
            <span>OR</span>
            <div style={styles.orLine}></div>
          </div>

          <div style={styles.inputGroup}>
            <label style={styles.label}>Upload ZIP File</label>
            <input
              type="file"
              accept=".zip"
              onChange={handleFileUpload}
              disabled={state.isProcessing}
              style={styles.input}
            />
          </div>
        </div>

        <button
          onClick={() => updateState({ showSettings: true })}
          style={styles.secondaryButton}
        >
          ⚙️ Settings
        </button>
      </div>
    </div>
  );

  const renderMainInterface = () => {
    // Double-check graph validity before rendering
    if (!isGraphValid) {
      console.warn('Attempted to render main interface with invalid graph:', state.graph);
      return renderWelcomeScreen();
    }

    return (
      <>
        {/* Top Navbar */}
        <div style={styles.navbar}>
          <div style={styles.navbarContent}>
            <span>🔍 GitNexus</span>
            <span>•</span>
            <span>{state.graph?.nodes.length || 0} nodes</span>
            <span>•</span>
            <span>{state.graph?.relationships.length || 0} relationships</span>
          </div>
          <button
            onClick={handleNewProject}
            style={{
              ...styles.navbarButton,
              position: 'absolute',
              right: '24px'
            }}
          >
            <span>🔄</span>
            New Project
          </button>
        </div>

        {/* Main Layout */}
        <div style={styles.mainLayout}>
          {/* Left Panel - Knowledge Graph */}
          <div style={styles.leftPanel}>
            <GraphExplorer
              graph={state.graph!}
              fileContents={state.fileContents}
              onNodeSelect={handleNodeSelect}
              selectedNodeId={state.selectedNodeId}
              style={{ height: '100%' }}
            />
          </div>

          {/* Right Panel - Chat and Source */}
          <div style={styles.rightPanel}>
            {/* Chat Section */}
            <div style={styles.chatSection}>
              {isApiKeyValid ? (
                <ChatInterface
                  graph={state.graph!}
                  fileContents={state.fileContents}
                  style={{ height: '100%' }}
                />
              ) : (
                <div style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  height: '100%',
                  flexDirection: 'column',
                  gap: '16px',
                  padding: '24px',
                  textAlign: 'center',
                  color: colors.textMuted
                }}>
                  <div style={{ fontSize: '48px', opacity: 0.3 }}>🔑</div>
                  <div>Configure your API key to use the chat interface</div>
                  <button
                    onClick={() => updateState({ showSettings: true })}
                    style={styles.secondaryButton}
                  >
                    Open Settings
                  </button>
                </div>
              )}
            </div>

            {/* Source Section */}
            <div style={styles.sourceSection}>
              <SourceViewer
                graph={state.graph!}
                selectedNodeId={state.selectedNodeId}
                fileContents={state.fileContents}
                style={{ height: '100%' }}
              />
            </div>
          </div>
        </div>
      </>
    );
  };

  return (
    <ErrorBoundary>
      <div style={styles.container}>
        <style>{`
          @keyframes spin {
            0% { transform: rotate(0deg); }
            100% { transform: rotate(360deg); }
          }
          
          input:focus, textarea:focus {
            border-color: ${colors.primary} !important;
            box-shadow: 0 0 0 3px ${colors.primary}20 !important;
          }
          
          button:hover:not(:disabled) {
            transform: translateY(-1px);
            box-shadow: 0 4px 12px rgba(0,0,0,0.15);
          }
          
          button:active:not(:disabled) {
            transform: translateY(0);
          }
        `}</style>

        {state.showWelcome || !isGraphValid ? renderWelcomeScreen() : renderMainInterface()}

        {/* Settings Modal - TODO: Implement */}
        {state.showSettings && (
          <div style={{
            position: 'fixed',
            top: 0,
            left: 0,
            right: 0,
            bottom: 0,
            backgroundColor: 'rgba(0,0,0,0.5)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            zIndex: 2000
          }}>
            <div style={{
              backgroundColor: colors.surface,
              borderRadius: '16px',
              padding: '32px',
              maxWidth: '500px',
              width: '90%'
            }}>
              <h2 style={{ color: colors.text, marginBottom: '24px' }}>Settings</h2>
              <div style={styles.inputGroup}>
                <label style={styles.label}>OpenAI API Key</label>
                <input
                  type="password"
                  value={state.llmApiKey}
                  onChange={(e) => updateState({ llmApiKey: e.target.value })}
                  placeholder="sk-..."
                  style={styles.input}
                />
              </div>
              <div style={{ display: 'flex', gap: '12px', marginTop: '24px' }}>
                <button
                  onClick={() => updateState({ showSettings: false })}
                  style={styles.primaryButton}
                >
                  Save
                </button>
                <button
                  onClick={() => updateState({ showSettings: false })}
                  style={styles.secondaryButton}
                >
                  Cancel
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </ErrorBoundary>
  );
};

export default HomePage; 

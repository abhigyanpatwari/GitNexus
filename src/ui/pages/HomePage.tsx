import React, { useState, useCallback, useEffect, useMemo } from 'react';
import { GitHubService } from '../../services/github.ts';
import { ZipService } from '../../services/zip.ts';
import { getIngestionWorker, type IngestionProgress } from '../../lib/workerUtils.ts';
import { GraphExplorer } from '../components/graph/index.ts';
import { ChatInterface } from '../components/chat/index.ts';
import ErrorBoundary from '../components/ErrorBoundary.tsx';
import { LLMService, CypherGenerator, LangChainRAGOrchestrator } from '../../ai/index.ts';
import { exportAndDownloadGraph, calculateExportSize } from '../../lib/export.ts';
import type { KnowledgeGraph } from '../../core/graph/types.ts';
import type { LLMProvider, LLMConfig } from '../../ai/llm-service.ts';

interface AppState {
  // Data
  graph: KnowledgeGraph | null;
  fileContents: Map<string, string>;
  selectedNodeId: string | null;
  
  // UI State
  isProcessing: boolean;
  progress: IngestionProgress | null;
  error: string | null;
  
  // Input State
  githubUrl: string;
  uploadedFile: File | null;
  
  // Settings
  githubToken: string;
  llmProvider: LLMProvider;
  llmApiKey: string;
  llmModel: string;

  // Performance settings
  maxFiles: number;
  directoryFilter: string;
  filePatternFilter: string;
}

interface ProcessingStats {
  totalFiles: number;
  processedFiles: number;
  duration: number;
  nodeCount: number;
  relationshipCount: number;
  projectName?: string;
}

interface ConfirmationDialogProps {
  isOpen: boolean;
  title: string;
  message: string;
  details?: string[];
  onConfirm: () => void;
  onCancel: () => void;
  confirmText?: string;
  cancelText?: string;
}

const ConfirmationDialog: React.FC<ConfirmationDialogProps> = ({
  isOpen,
  title,
  message,
  details,
  onConfirm,
  onCancel,
  confirmText = 'Continue',
  cancelText = 'Cancel'
}) => {
  if (!isOpen) return null;

  return (
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
      zIndex: 1001
    }}>
      <div style={{
        backgroundColor: '#fff',
        borderRadius: '8px',
        padding: '24px',
        maxWidth: '500px',
        width: '90%',
        boxShadow: '0 4px 12px rgba(0,0,0,0.15)'
      }}>
        <h3 style={{ margin: '0 0 16px 0', color: '#dc3545' }}>{title}</h3>
        <p style={{ margin: '0 0 16px 0', lineHeight: '1.5' }}>{message}</p>
        
        {details && details.length > 0 && (
          <ul style={{ margin: '0 0 16px 0', paddingLeft: '20px', fontSize: '14px', color: '#666' }}>
            {details.map((detail, index) => (
              <li key={index}>{detail}</li>
            ))}
          </ul>
        )}

        <div style={{ display: 'flex', gap: '12px', justifyContent: 'flex-end' }}>
          <button
            onClick={onCancel}
            style={{
              padding: '8px 16px',
              border: '1px solid #ddd',
              borderRadius: '4px',
              backgroundColor: '#fff',
              color: '#666',
              cursor: 'pointer'
            }}
          >
            {cancelText}
          </button>
          <button
            onClick={onConfirm}
            style={{
              padding: '8px 16px',
              border: 'none',
              borderRadius: '4px',
              backgroundColor: '#dc3545',
              color: '#fff',
              cursor: 'pointer'
            }}
          >
            {confirmText}
          </button>
        </div>
      </div>
    </div>
  );
};

const HomePage: React.FC = () => {
  // Main application state
  const [state, setState] = useState<AppState>({
    graph: null,
    fileContents: new Map(),
    selectedNodeId: null,
    isProcessing: false,
    progress: null,
    error: null,
    githubUrl: '',
    uploadedFile: null,
    githubToken: '',
    llmProvider: 'openai',
    llmApiKey: '',
    llmModel: 'gpt-4o-mini',
    maxFiles: 500,
    directoryFilter: '',
    filePatternFilter: ''
  });

  const [processingStats, setProcessingStats] = useState<ProcessingStats | null>(null);
  const [showSettings, setShowSettings] = useState(false);
  const [showConfirmation, setShowConfirmation] = useState(false);
  const [confirmationData, setConfirmationData] = useState<{
    files: any[];
    projectName: string;
  } | null>(null);

  // Initialize services
  const services = useMemo(() => {
    const llmService = new LLMService();
    const cypherGenerator = new CypherGenerator(llmService);
    const ragOrchestrator = new LangChainRAGOrchestrator(llmService, cypherGenerator);
    
    return {
      github: new GitHubService(state.githubToken || undefined),
      zip: new ZipService(),
      llm: llmService,
      cypher: cypherGenerator,
      rag: ragOrchestrator
    };
  }, [state.githubToken]);

  // Initialize RAG context when graph changes
  useEffect(() => {
    if (state.graph && state.fileContents.size > 0 && state.llmApiKey) {
      const llmConfig: LLMConfig = {
        provider: state.llmProvider,
        apiKey: state.llmApiKey,
        model: state.llmModel,
        temperature: 0.1,
        maxTokens: 4000
      };

      services.rag.setContext({
        graph: state.graph,
        fileContents: state.fileContents
      }, llmConfig).catch(error => {
        console.error('Failed to initialize RAG context:', error);
      });
    }
  }, [state.graph, state.fileContents, state.llmApiKey, state.llmProvider, state.llmModel, services.rag]);

  // Update state helper
  const updateState = useCallback((updates: Partial<AppState>) => {
    setState(prev => ({ ...prev, ...updates }));
  }, []);

  // Validate GitHub URL
  const validateGitHubUrl = useCallback((url: string): { isValid: boolean; error?: string } => {
    if (!url.trim()) {
      return { isValid: false, error: 'Please enter a GitHub repository URL' };
    }

    const githubUrlPattern = /^https:\/\/github\.com\/([^\/]+)\/([^\/]+)(?:\/.*)?$/;
    const match = url.match(githubUrlPattern);
    
    if (!match) {
      return { isValid: false, error: 'Please enter a valid GitHub repository URL (e.g., https://github.com/owner/repo)' };
    }

    return { isValid: true };
  }, []);

  // Extract owner and repo from GitHub URL
  const parseGitHubUrl = useCallback((url: string): { owner: string; repo: string } | null => {
    const githubUrlPattern = /^https:\/\/github\.com\/([^\/]+)\/([^\/]+)(?:\/.*)?$/;
    const match = url.match(githubUrlPattern);
    
    if (match) {
      return { owner: match[1], repo: match[2] };
    }
    
    return null;
  }, []);

  // Filter files based on directory and pattern filters
  const filterFiles = useCallback((files: any[]): any[] => {
    let filtered = files;

    // Filter by directory
    if (state.directoryFilter.trim()) {
      const dirPattern = state.directoryFilter.toLowerCase();
      filtered = filtered.filter(file => 
        file.path.toLowerCase().includes(dirPattern)
      );
    }

    // Filter by file pattern
    if (state.filePatternFilter.trim()) {
      const patterns = state.filePatternFilter.split(',').map(p => p.trim().toLowerCase());
      filtered = filtered.filter(file => 
        patterns.some(pattern => {
          if (pattern.includes('*')) {
            const regex = new RegExp(pattern.replace(/\*/g, '.*'));
            return regex.test(file.path.toLowerCase());
          }
          return file.path.toLowerCase().includes(pattern);
        })
      );
    }

    return filtered;
  }, [state.directoryFilter, state.filePatternFilter]);

  // Process GitHub repository
  const processGitHubRepository = useCallback(async () => {
    const validation = validateGitHubUrl(state.githubUrl);
    if (!validation.isValid) {
      updateState({ error: validation.error });
      return;
    }

    const parsed = parseGitHubUrl(state.githubUrl);
    if (!parsed) {
      updateState({ error: 'Invalid GitHub URL format' });
      return;
    }

    updateState({ 
      isProcessing: true, 
      error: null, 
      progress: { phase: 'structure', message: 'Fetching repository...', progress: 0 }
    });

    try {
      // Fetch repository contents
      updateState({ 
        progress: { phase: 'structure', message: 'Fetching repository structure...', progress: 10 }
      });

      const allFiles = await services.github.getAllFilesRecursively(parsed.owner, parsed.repo);
      const filteredFiles = filterFiles(allFiles);

      // Check if repository exceeds file limit
      if (filteredFiles.length > state.maxFiles) {
        setConfirmationData({
          files: filteredFiles,
          projectName: `${parsed.owner}/${parsed.repo}`
        });
        setShowConfirmation(true);
        updateState({ isProcessing: false, progress: null });
        return;
      }

      await processFilesFromGitHub(filteredFiles, `${parsed.owner}/${parsed.repo}`);

    } catch (error) {
      console.error('GitHub processing error:', error);
      updateState({ 
        error: error instanceof Error ? error.message : 'Failed to process GitHub repository',
        isProcessing: false,
        progress: null
      });
    }
  }, [state.githubUrl, state.githubToken, state.maxFiles, services.github, validateGitHubUrl, parseGitHubUrl, filterFiles, updateState]);

  // Process files from GitHub (used by both normal processing and confirmation)
  const processFilesFromGitHub = useCallback(async (files: any[], projectName: string) => {
    const fileContents = new Map<string, string>();

    updateState({ 
      isProcessing: true,
      progress: { phase: 'structure', message: `Found ${files.length} files. Downloading...`, progress: 20 }
    });

    // Download file contents
    let processedFiles = 0;
    for (const file of files) {
      try {
        const parsed = parseGitHubUrl(state.githubUrl);
        if (!parsed) break;

        const content = await services.github.getFileContent(parsed.owner, parsed.repo, file.path);
        if (content) {
          fileContents.set(file.path, content);
        }
        processedFiles++;
        
        const progress = 20 + (processedFiles / files.length) * 30;
        updateState({ 
          progress: { 
            phase: 'structure', 
            message: `Downloaded ${processedFiles}/${files.length} files...`, 
            progress 
          }
        });
      } catch (error) {
        console.warn(`Failed to download ${file.path}:`, error);
      }
    }

    // Process with ingestion worker
    await processWithWorker(fileContents, projectName, files.map(f => f.path));
  }, [state.githubUrl, services.github, parseGitHubUrl, updateState]);

  // Handle confirmation dialog
  const handleConfirmLargeRepository = useCallback(async () => {
    if (!confirmationData) return;

    setShowConfirmation(false);
    
    // Limit to maxFiles
    const limitedFiles = confirmationData.files.slice(0, state.maxFiles);
    await processFilesFromGitHub(limitedFiles, confirmationData.projectName);
    
    setConfirmationData(null);
  }, [confirmationData, state.maxFiles, processFilesFromGitHub]);

  const handleCancelLargeRepository = useCallback(() => {
    setShowConfirmation(false);
    setConfirmationData(null);
    updateState({ isProcessing: false, progress: null });
  }, [updateState]);

  // Process ZIP file
  const processZipFile = useCallback(async () => {
    if (!state.uploadedFile) {
      updateState({ error: 'Please select a ZIP file to upload' });
      return;
    }

    updateState({ 
      isProcessing: true, 
      error: null,
      progress: { phase: 'structure', message: 'Extracting ZIP file...', progress: 0 }
    });

    try {
      // Extract ZIP contents
      updateState({ 
        progress: { phase: 'structure', message: 'Reading ZIP file...', progress: 10 }
      });

      const allFileContents = await services.zip.extractTextFiles(state.uploadedFile);
      let fileContents = allFileContents;
      let filePaths = Array.from(allFileContents.keys());

      // Apply filters
      if (state.directoryFilter.trim() || state.filePatternFilter.trim()) {
        const filteredPaths = filePaths.filter(path => {
          let matches = true;

          if (state.directoryFilter.trim()) {
            matches = matches && path.toLowerCase().includes(state.directoryFilter.toLowerCase());
          }

          if (state.filePatternFilter.trim()) {
            const patterns = state.filePatternFilter.split(',').map(p => p.trim().toLowerCase());
            matches = matches && patterns.some(pattern => {
              if (pattern.includes('*')) {
                const regex = new RegExp(pattern.replace(/\*/g, '.*'));
                return regex.test(path.toLowerCase());
              }
              return path.toLowerCase().includes(pattern);
            });
          }

          return matches;
        });

        // Create filtered file contents map
        fileContents = new Map();
        filteredPaths.forEach(path => {
          const content = allFileContents.get(path);
          if (content) {
            fileContents.set(path, content);
          }
        });
        filePaths = filteredPaths;
      }

      // Check file limit
      if (filePaths.length > state.maxFiles) {
        const projectName = state.uploadedFile.name.replace(/\.zip$/i, '');
        setConfirmationData({
          files: filePaths.map(path => ({ path })),
          projectName
        });
        setShowConfirmation(true);
        updateState({ isProcessing: false, progress: null });
        return;
      }

      updateState({ 
        progress: { 
          phase: 'structure', 
          message: `Extracted ${filePaths.length} text files...`, 
          progress: 30 
        }
      });

      // Process with ingestion worker
      const projectName = state.uploadedFile.name.replace(/\.zip$/i, '');
      await processWithWorker(fileContents, projectName, filePaths);

    } catch (error) {
      console.error('ZIP processing error:', error);
      updateState({ 
        error: error instanceof Error ? error.message : 'Failed to process ZIP file',
        isProcessing: false,
        progress: null
      });
    }
  }, [state.uploadedFile, state.maxFiles, state.directoryFilter, state.filePatternFilter, services.zip, updateState]);

  // Process with ingestion worker
  const processWithWorker = useCallback(async (
    fileContents: Map<string, string>,
    projectName: string,
    filePaths: string[]
  ) => {
    try {
      const worker = getIngestionWorker();
      await worker.initialize();

      // Set up progress callback
      await worker.setProgressCallback((progress: IngestionProgress) => {
        updateState({ progress });
      });

      updateState({ 
        progress: { phase: 'parsing', message: 'Starting knowledge graph construction...', progress: 50 }
      });

      // Process repository
      const result = await worker.processRepository({
        projectRoot: '/',
        projectName,
        filePaths,
        fileContents
      });

      if (result.success && result.graph) {
        // Calculate stats
        const stats: ProcessingStats = {
          totalFiles: filePaths.length,
          processedFiles: fileContents.size,
          duration: result.duration || 0,
          nodeCount: result.graph.nodes.length,
          relationshipCount: result.graph.relationships.length,
          projectName
        };

        updateState({
          graph: result.graph,
          fileContents,
          isProcessing: false,
          progress: null,
          error: null
        });

        setProcessingStats(stats);

        // Show success message briefly
        setTimeout(() => {
          updateState({ 
            progress: { 
              phase: 'complete', 
              message: `Successfully processed ${stats.nodeCount} nodes and ${stats.relationshipCount} relationships!`, 
              progress: 100 
            }
          });
          setTimeout(() => updateState({ progress: null }), 3000);
        }, 500);

      } else {
        throw new Error(result.error || 'Processing failed');
      }

    } catch (error) {
      console.error('Worker processing error:', error);
      updateState({ 
        error: error instanceof Error ? error.message : 'Failed to process with worker',
        isProcessing: false,
        progress: null
      });
    }
  }, [updateState]);

  // Export graph
  const handleExportGraph = useCallback(() => {
    if (!state.graph) return;

    try {
      exportAndDownloadGraph(
        state.graph,
        {
          projectName: processingStats?.projectName,
          includeMetadata: true,
          prettyPrint: true
        },
        state.fileContents,
        processingStats ? { duration: processingStats.duration } : undefined
      );
    } catch (error) {
      updateState({ 
        error: error instanceof Error ? error.message : 'Failed to export graph' 
      });
    }
  }, [state.graph, state.fileContents, processingStats, updateState]);

  // Calculate export size
  const exportSize = useMemo(() => {
    if (!state.graph) return null;
    return calculateExportSize(state.graph, true, state.fileContents);
  }, [state.graph, state.fileContents]);

  // Handle file upload
  const handleFileUpload = useCallback((event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (file) {
      if (!file.name.toLowerCase().endsWith('.zip')) {
        updateState({ error: 'Please select a ZIP file' });
        return;
      }
      updateState({ uploadedFile: file, error: null });
    }
  }, [updateState]);

  // Handle node selection
  const handleNodeSelect = useCallback((nodeId: string | null) => {
    updateState({ selectedNodeId: nodeId });
  }, [updateState]);

  // Clear all data
  const clearData = useCallback(() => {
    setState(prev => ({
      ...prev,
      graph: null,
      fileContents: new Map(),
      selectedNodeId: null,
      isProcessing: false,
      progress: null,
      error: null,
      githubUrl: '',
      uploadedFile: null
    }));
    setProcessingStats(null);
  }, []);

  // Get available models for current provider
  const getAvailableModels = useCallback(() => {
    return services.llm.getAvailableModels(state.llmProvider);
  }, [services.llm, state.llmProvider]);

  // Validate API key
  const isApiKeyValid = useMemo(() => {
    if (!state.llmApiKey.trim()) return false;
    return services.llm.validateApiKey(state.llmProvider, state.llmApiKey);
  }, [services.llm, state.llmProvider, state.llmApiKey]);

  // Styles
  const containerStyle: React.CSSProperties = {
    display: 'flex',
    flexDirection: 'column',
    height: '100vh',
    backgroundColor: '#f5f5f5',
    fontFamily: 'system-ui, -apple-system, sans-serif'
  };

  const headerStyle: React.CSSProperties = {
    backgroundColor: '#fff',
    borderBottom: '1px solid #ddd',
    padding: '16px 24px',
    boxShadow: '0 2px 4px rgba(0,0,0,0.1)'
  };

  const titleStyle: React.CSSProperties = {
    fontSize: '24px',
    fontWeight: '600',
    color: '#333',
    margin: '0 0 16px 0',
    display: 'flex',
    alignItems: 'center',
    gap: '8px'
  };

  const inputRowStyle: React.CSSProperties = {
    display: 'flex',
    gap: '12px',
    alignItems: 'center',
    flexWrap: 'wrap'
  };

  const inputGroupStyle: React.CSSProperties = {
    display: 'flex',
    flexDirection: 'column',
    gap: '4px'
  };

  const labelStyle: React.CSSProperties = {
    fontSize: '12px',
    color: '#666',
    fontWeight: '500'
  };

  const inputStyle: React.CSSProperties = {
    padding: '8px 12px',
    border: '1px solid #ddd',
    borderRadius: '4px',
    fontSize: '14px',
    minWidth: '200px'
  };

  const smallInputStyle: React.CSSProperties = {
    ...inputStyle,
    minWidth: '150px'
  };

  const buttonStyle = (variant: 'primary' | 'secondary' | 'danger' = 'primary'): React.CSSProperties => ({
    padding: '8px 16px',
    border: 'none',
    borderRadius: '4px',
    fontSize: '14px',
    fontWeight: '500',
    cursor: 'pointer',
    backgroundColor: variant === 'primary' ? '#007bff' : variant === 'danger' ? '#dc3545' : '#6c757d',
    color: '#fff',
    opacity: state.isProcessing ? 0.6 : 1,
    transition: 'all 0.2s ease'
  });

  const mainContentStyle: React.CSSProperties = {
    flex: 1,
    display: 'flex',
    gap: '16px',
    padding: '16px',
    overflow: 'hidden'
  };

  const leftPaneStyle: React.CSSProperties = {
    flex: '1 1 60%',
    display: 'flex',
    flexDirection: 'column',
    backgroundColor: '#fff',
    borderRadius: '8px',
    boxShadow: '0 2px 8px rgba(0,0,0,0.1)',
    overflow: 'hidden'
  };

  const rightPaneStyle: React.CSSProperties = {
    flex: '1 1 40%',
    display: 'flex',
    flexDirection: 'column',
    gap: '16px'
  };

  const panelStyle: React.CSSProperties = {
    backgroundColor: '#fff',
    borderRadius: '8px',
    boxShadow: '0 2px 8px rgba(0,0,0,0.1)',
    overflow: 'hidden'
  };

  const errorStyle: React.CSSProperties = {
    backgroundColor: '#f8d7da',
    color: '#721c24',
    padding: '12px 16px',
    borderRadius: '4px',
    margin: '8px 0',
    fontSize: '14px'
  };

  const progressStyle: React.CSSProperties = {
    backgroundColor: '#d1ecf1',
    color: '#0c5460',
    padding: '12px 16px',
    borderRadius: '4px',
    margin: '8px 0',
    fontSize: '14px'
  };

  const statsStyle: React.CSSProperties = {
    display: 'flex',
    gap: '16px',
    fontSize: '12px',
    color: '#666',
    marginTop: '8px',
    flexWrap: 'wrap'
  };

  const emptyStateStyle: React.CSSProperties = {
    flex: 1,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    flexDirection: 'column',
    color: '#666',
    fontSize: '16px'
  };

  const settingsModalStyle: React.CSSProperties = {
    position: 'fixed',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: 'rgba(0,0,0,0.5)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: 1000
  };

  const settingsContentStyle: React.CSSProperties = {
    backgroundColor: '#fff',
    borderRadius: '8px',
    padding: '24px',
    maxWidth: '600px',
    width: '90%',
    maxHeight: '80vh',
    overflow: 'auto'
  };

  const settingsGridStyle: React.CSSProperties = {
    display: 'grid',
    gridTemplateColumns: '1fr 1fr',
    gap: '16px',
    marginBottom: '16px'
  };

  return (
    <ErrorBoundary>
      <div style={containerStyle}>
        {/* Header */}
        <div style={headerStyle}>
          <div style={titleStyle}>
            <span>🔍</span>
            <span>GitNexus - Code Knowledge Graph Explorer</span>
          </div>
          
          <div style={inputRowStyle}>
            {/* GitHub URL Input */}
            <div style={inputGroupStyle}>
              <label style={labelStyle}>GitHub Repository URL</label>
              <input
                type="text"
                value={state.githubUrl}
                onChange={(e) => updateState({ githubUrl: e.target.value })}
                placeholder="https://github.com/owner/repo"
                style={inputStyle}
                disabled={state.isProcessing}
              />
            </div>

            <span style={{ color: '#ccc', fontSize: '14px' }}>OR</span>

            {/* ZIP File Upload */}
            <div style={inputGroupStyle}>
              <label style={labelStyle}>Upload ZIP File</label>
              <input
                type="file"
                accept=".zip"
                onChange={handleFileUpload}
                style={inputStyle}
                disabled={state.isProcessing}
              />
            </div>

            {/* Filters */}
            <div style={inputGroupStyle}>
              <label style={labelStyle}>Directory Filter</label>
              <input
                type="text"
                value={state.directoryFilter}
                onChange={(e) => updateState({ directoryFilter: e.target.value })}
                placeholder="src, lib, etc."
                style={smallInputStyle}
                disabled={state.isProcessing}
              />
            </div>

            <div style={inputGroupStyle}>
              <label style={labelStyle}>File Pattern</label>
              <input
                type="text"
                value={state.filePatternFilter}
                onChange={(e) => updateState({ filePatternFilter: e.target.value })}
                placeholder="*.py, *.js"
                style={smallInputStyle}
                disabled={state.isProcessing}
              />
            </div>

            {/* Action Buttons */}
            <div style={{ display: 'flex', gap: '8px', alignItems: 'flex-end' }}>
              <button
                onClick={state.githubUrl ? processGitHubRepository : processZipFile}
                disabled={state.isProcessing || (!state.githubUrl && !state.uploadedFile)}
                style={buttonStyle('primary')}
              >
                {state.isProcessing ? 'Processing...' : 'Analyze'}
              </button>
              
              <button
                onClick={() => setShowSettings(true)}
                style={buttonStyle('secondary')}
                title="Settings"
              >
                ⚙️
              </button>
              
              {state.graph && (
                <>
                  <button
                    onClick={handleExportGraph}
                    style={buttonStyle('secondary')}
                    title={`Export Graph${exportSize ? ` (${exportSize.sizeFormatted})` : ''}`}
                  >
                    📥
                  </button>
                  
                  <button
                    onClick={clearData}
                    style={buttonStyle('danger')}
                    title="Clear Data"
                  >
                    🗑️
                  </button>
                </>
              )}
            </div>
          </div>

          {/* Progress/Error Display */}
          {state.error && (
            <div style={errorStyle}>
              <strong>Error:</strong> {state.error}
            </div>
          )}
          
          {state.progress && (
            <div style={progressStyle}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <span>{state.progress.message}</span>
                <span>{Math.round(state.progress.progress)}%</span>
              </div>
              <div style={{
                width: '100%',
                height: '4px',
                backgroundColor: 'rgba(0,0,0,0.1)',
                borderRadius: '2px',
                marginTop: '8px',
                overflow: 'hidden'
              }}>
                <div style={{
                  width: `${state.progress.progress}%`,
                  height: '100%',
                  backgroundColor: '#007bff',
                  transition: 'width 0.3s ease'
                }} />
              </div>
            </div>
          )}

          {/* Processing Stats */}
          {processingStats && (
            <div style={statsStyle}>
              <span>📁 {processingStats.processedFiles}/{processingStats.totalFiles} files</span>
              <span>🔗 {processingStats.nodeCount} nodes</span>
              <span>📊 {processingStats.relationshipCount} relationships</span>
              <span>⏱️ {(processingStats.duration / 1000).toFixed(1)}s</span>
              {exportSize && <span>💾 Export: {exportSize.sizeFormatted}</span>}
            </div>
          )}
        </div>

        {/* Main Content */}
        <div style={mainContentStyle}>
          {state.graph ? (
            <>
              {/* Left Pane - Graph Visualization */}
              <div style={leftPaneStyle}>
                <GraphExplorer
                  graph={state.graph}
                  style={{ height: '100%' }}
                />
              </div>

              {/* Right Pane - Chat Interface */}
              <div style={rightPaneStyle}>
                <div style={{ ...panelStyle, flex: 1 }}>
                  {isApiKeyValid ? (
                    <ChatInterface
                      graph={state.graph}
                      fileContents={state.fileContents}
                      style={{ height: '100%' }}
                    />
                  ) : (
                    <div style={emptyStateStyle}>
                      <div style={{ fontSize: '48px', marginBottom: '16px', opacity: 0.3 }}>
                        🔑
                      </div>
                      <div>Configure your API key in settings to use the chat interface</div>
                      <button
                        onClick={() => setShowSettings(true)}
                        style={{ ...buttonStyle('primary'), marginTop: '16px' }}
                      >
                        Open Settings
                      </button>
                    </div>
                  )}
                </div>
              </div>
            </>
          ) : (
            /* Empty State */
            <div style={emptyStateStyle}>
              <div style={{ fontSize: '64px', marginBottom: '24px', opacity: 0.3 }}>
                🔍
              </div>
              <div style={{ fontSize: '18px', marginBottom: '8px' }}>
                Welcome to GitNexus
              </div>
              <div style={{ fontSize: '14px', color: '#999', textAlign: 'center', maxWidth: '400px' }}>
                Analyze GitHub repositories or upload ZIP files to explore code structure, 
                relationships, and get AI-powered insights about your codebase.
              </div>
              <div style={{ marginTop: '24px', fontSize: '14px', color: '#666' }}>
                Enter a GitHub URL or upload a ZIP file to get started
              </div>
              <div style={{ marginTop: '16px', fontSize: '12px', color: '#999', textAlign: 'center' }}>
                <div><strong>Performance Tips:</strong></div>
                <div>• Use directory filters to focus on specific parts of the codebase</div>
                <div>• File patterns like "*.py" or "*.js" help limit analysis scope</div>
                <div>• Large repositories ({state.maxFiles}+ files) will show a confirmation dialog</div>
              </div>
            </div>
          )}
        </div>

        {/* Settings Modal */}
        {showSettings && (
          <div style={settingsModalStyle} onClick={() => setShowSettings(false)}>
            <div style={settingsContentStyle} onClick={(e) => e.stopPropagation()}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '20px' }}>
                <h3 style={{ margin: 0 }}>Settings</h3>
                <button
                  onClick={() => setShowSettings(false)}
                  style={{ background: 'none', border: 'none', fontSize: '20px', cursor: 'pointer' }}
                >
                  ×
                </button>
              </div>

              {/* Performance Settings */}
              <div style={{ marginBottom: '24px' }}>
                <h4 style={{ margin: '0 0 12px 0', fontSize: '16px' }}>Performance Settings</h4>
                <div style={inputGroupStyle}>
                  <label style={labelStyle}>Maximum Files to Process</label>
                  <input
                    type="number"
                    min="50"
                    max="2000"
                    value={state.maxFiles}
                    onChange={(e) => updateState({ maxFiles: parseInt(e.target.value) || 500 })}
                    style={inputStyle}
                  />
                  <div style={{ fontSize: '12px', color: '#666', marginTop: '4px' }}>
                    Large repositories will show a confirmation dialog if they exceed this limit
                  </div>
                </div>
              </div>

              {/* GitHub Settings */}
              <div style={{ marginBottom: '24px' }}>
                <h4 style={{ margin: '0 0 12px 0', fontSize: '16px' }}>GitHub Settings</h4>
                <div style={inputGroupStyle}>
                  <label style={labelStyle}>Personal Access Token (Optional)</label>
                  <input
                    type="password"
                    value={state.githubToken}
                    onChange={(e) => updateState({ githubToken: e.target.value })}
                    placeholder="ghp_xxxxxxxxxxxx"
                    style={inputStyle}
                  />
                  <div style={{ fontSize: '12px', color: '#666', marginTop: '4px' }}>
                    Increases rate limit from 60 to 5,000 requests per hour
                  </div>
                </div>
              </div>

              {/* LLM Settings */}
              <div>
                <h4 style={{ margin: '0 0 12px 0', fontSize: '16px' }}>AI Chat Settings</h4>
                
                <div style={settingsGridStyle}>
                  <div style={inputGroupStyle}>
                    <label style={labelStyle}>Provider</label>
                    <select
                      value={state.llmProvider}
                      onChange={(e) => updateState({ 
                        llmProvider: e.target.value as LLMProvider,
                        llmModel: services.llm.getAvailableModels(e.target.value as LLMProvider)[0]
                      })}
                      style={inputStyle}
                    >
                      <option value="openai">OpenAI</option>
                      <option value="anthropic">Anthropic</option>
                      <option value="gemini">Google Gemini</option>
                    </select>
                  </div>
                  
                  <div style={inputGroupStyle}>
                    <label style={labelStyle}>Model</label>
                    <select
                      value={state.llmModel}
                      onChange={(e) => updateState({ llmModel: e.target.value })}
                      style={inputStyle}
                    >
                      {getAvailableModels().map(model => (
                        <option key={model} value={model}>{model}</option>
                      ))}
                    </select>
                  </div>
                </div>

                <div style={{ ...inputGroupStyle, marginTop: '12px' }}>
                  <label style={labelStyle}>
                    API Key
                    {!isApiKeyValid && state.llmApiKey && (
                      <span style={{ color: '#dc3545', marginLeft: '8px' }}>
                        (Invalid format)
                      </span>
                    )}
                    {isApiKeyValid && (
                      <span style={{ color: '#28a745', marginLeft: '8px' }}>
                        ✓ Valid
                      </span>
                    )}
                  </label>
                  <input
                    type="password"
                    value={state.llmApiKey}
                    onChange={(e) => updateState({ llmApiKey: e.target.value })}
                    placeholder={`Enter your ${services.llm.getProviderDisplayName(state.llmProvider)} API key`}
                    style={inputStyle}
                  />
                  <div style={{ fontSize: '12px', color: '#666', marginTop: '4px' }}>
                    Your API key is stored locally and never sent to our servers
                  </div>
                </div>
              </div>

              <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: '24px' }}>
                <button
                  onClick={() => setShowSettings(false)}
                  style={buttonStyle('primary')}
                >
                  Save Settings
                </button>
              </div>
            </div>
          </div>
        )}

        {/* Large Repository Confirmation Dialog */}
        <ConfirmationDialog
          isOpen={showConfirmation}
          title="Large Repository Detected"
          message={`This repository contains ${confirmationData?.files.length || 0} files, which exceeds your limit of ${state.maxFiles} files. Processing all files may impact performance.`}
          details={[
            `Only the first ${state.maxFiles} files will be processed`,
            'Consider using directory or file pattern filters to focus on specific parts',
            'You can adjust the file limit in settings',
            'Processing may take longer and use more memory'
          ]}
          onConfirm={handleConfirmLargeRepository}
          onCancel={handleCancelLargeRepository}
          confirmText={`Process ${state.maxFiles} Files`}
          cancelText="Cancel"
        />
      </div>
    </ErrorBoundary>
  );
};

export default HomePage; 

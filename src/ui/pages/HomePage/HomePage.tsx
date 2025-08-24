import React from 'react';
import ErrorBoundary from '../../components/ErrorBoundary';
import { GraphExplorer } from '../../components/graph';
import { ChatInterface } from '../../components/chat';
import ExportFormatModal from '../../components/ExportFormatModal';
import EngineSelector from '../../components/engine/EngineSelector';
import ProcessingStatus from '../../components/engine/ProcessingStatus';
import RepositoryInput from '../../components/repository/RepositoryInput';
import { useGitNexus } from '../../hooks/useGitNexus';
import { exportAndDownloadGraph, exportAndDownloadGraphAsCSV } from '../../../lib/export';
import { getFeatureFlags } from '../../../config/feature-flags';
import type { ExportFormat } from '../../components/ExportFormatModal';

/**
 * HomePage - Simplified and focused main application page
 * Uses custom hooks and focused components for better maintainability
 */
const HomePage: React.FC = () => {
  const featureFlags = getFeatureFlags();
  const {
    state,
    engine,
    processing,
    settings,
    handleNodeSelect,
    handleGitHubProcess,
    handleZipProcess,
    toggleStats,
    toggleExportModal,
    setShowWelcome
  } = useGitNexus();

  const handleGitHubUrlChange = (url: string) => {
    // URL changes are handled locally in the component
    // Could be extracted to settings if needed for persistence
  };

  const handleEngineChange = async (engineType: any, reason?: string) => {
    await engine.switchEngine(engineType, reason);
  };

  const handleExport = async (format: ExportFormat) => {
    if (!state.graph) return;

    try {
      if (format === 'json') {
        await exportAndDownloadGraph(state.graph, state.fileContents);
      } else if (format === 'csv') {
        await exportAndDownloadGraphAsCSV(state.graph, state.fileContents);
      }
      toggleExportModal();
    } catch (error) {
      console.error('Export failed:', error);
      alert('Export failed. Please try again.');
    }
  };

  const handleClearResults = () => {
    processing.clearResult();
    setShowWelcome(true);
  };

  // Show welcome screen if no graph and not processing
  if (state.showWelcome && !state.graph && !processing.state.isProcessing) {
    return (
      <div className="app">
        <header className="app-header">
          <h1>🌐 GitNexus</h1>
          <p>Analyze and explore your codebase as a knowledge graph</p>
        </header>

        <main className="welcome-content">
          <div className="welcome-intro">
            <h2>Welcome to GitNexus</h2>
            <p>Transform your code repository into an interactive knowledge graph. Analyze dependencies, explore relationships, and gain deep insights into your codebase structure.</p>
          </div>

          <RepositoryInput
            onGitHubSubmit={handleGitHubProcess}
            onZipFileSubmit={handleZipProcess}
            disabled={processing.state.isProcessing}
            githubUrl="" // Local state in component
            onGitHubUrlChange={handleGitHubUrlChange}
          />

          {featureFlags.showEngineSelector && (
            <EngineSelector
              currentEngine={engine.currentEngine}
              availableEngines={engine.availableEngines}
              onEngineChange={handleEngineChange}
              showPerformanceInfo={featureFlags.showEnginePerformanceInfo}
            />
          )}

          {featureFlags.showEngineCapabilities && (
            <div className="engine-info-panel">
              <h3>🚀 Engine Capabilities</h3>
              <div className="capabilities-grid">
                {engine.availableEngines.map((eng) => (
                  <div 
                    key={eng.type} 
                    className={`capability-item ${eng.type === engine.currentEngine ? 'active' : ''}`}
                  >
                    <div className="capability-header">
                      <span className="capability-name">{eng.name}</span>
                      <span className="capability-status">
                        {eng.healthy ? '✅' : '⚠️'}
                      </span>
                    </div>
                    <div className="capability-list">
                      {eng.capabilities.map((cap) => (
                        <span key={cap} className="capability-tag">
                          {cap}
                        </span>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {featureFlags.showEnginePerformanceInfo && engine.performanceComparison && (
            <div className="performance-panel">
              <h3>📊 Performance Comparison</h3>
              <div className="performance-stats">
                <div className="stat-item">
                  <span className="stat-label">Legacy Engine:</span>
                  <span className="stat-value">
                    {(engine.performanceComparison.legacy.processingTime / 1000).toFixed(1)}s
                  </span>
                </div>
                <div className="stat-item">
                  <span className="stat-label">Next-Gen Engine:</span>
                  <span className="stat-value">
                    {(engine.performanceComparison.nextgen.processingTime / 1000).toFixed(1)}s
                  </span>
                </div>
                <div className="stat-item highlight">
                  <span className="stat-label">Speedup:</span>
                  <span className="stat-value">
                    {engine.performanceComparison.comparison.speedupFactor.toFixed(1)}x
                  </span>
                </div>
              </div>
            </div>
          )}
        </main>

        <style>{`
          .app {
            min-height: 100vh;
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            padding: 2rem;
          }
          
          .app-header {
            text-align: center;
            color: white;
            margin-bottom: 3rem;
          }
          
          .app-header h1 {
            font-size: 2.5rem;
            margin-bottom: 0.5rem;
            font-weight: 300;
          }
          
          .app-header p {
            font-size: 1.1rem;
            opacity: 0.9;
            margin: 0;
          }
          
          .welcome-content {
            max-width: 600px;
            margin: 0 auto;
            background: white;
            border-radius: 12px;
            padding: 2.5rem;
            box-shadow: 0 10px 30px rgba(0,0,0,0.2);
          }
          
          .welcome-intro {
            text-align: center;
            margin-bottom: 2rem;
          }
          
          .welcome-intro h2 {
            color: #333;
            font-size: 1.8rem;
            margin-bottom: 1rem;
            font-weight: 400;
          }
          
          .welcome-intro p {
            color: #666;
            font-size: 1rem;
            line-height: 1.6;
            margin: 0;
          }
          
          .engine-info-panel {
            margin-top: 2rem;
            padding: 1rem;
            background: #f8f9fa;
            border-radius: 8px;
          }
          
          .capabilities-grid {
            display: grid;
            grid-template-columns: 1fr 1fr;
            gap: 1rem;
            margin-top: 1rem;
          }
          
          .capability-item {
            padding: 1rem;
            border: 1px solid #e0e0e0;
            border-radius: 8px;
            background: white;
          }
          
          .capability-item.active {
            border-color: #007bff;
            background: #e7f3ff;
          }
          
          .capability-header {
            display: flex;
            justify-content: space-between;
            align-items: center;
            margin-bottom: 0.5rem;
          }
          
          .capability-name {
            font-weight: 600;
          }
          
          .capability-list {
            display: flex;
            flex-wrap: wrap;
            gap: 0.25rem;
          }
          
          .capability-tag {
            font-size: 0.7rem;
            padding: 0.2rem 0.4rem;
            background: #e9ecef;
            border-radius: 12px;
            color: #495057;
          }
          
          .performance-panel {
            margin-top: 2rem;
            padding: 1rem;
            background: #f0f8ff;
            border-radius: 8px;
            border: 1px solid #b3d9ff;
          }
          
          .performance-stats {
            display: grid;
            grid-template-columns: 1fr 1fr 1fr;
            gap: 1rem;
            margin-top: 1rem;
          }
          
          .stat-item {
            text-align: center;
            padding: 0.5rem;
            background: white;
            border-radius: 4px;
          }
          
          .stat-item.highlight {
            background: #e8f5e8;
            border: 1px solid #66bb6a;
          }
          
          .stat-label {
            display: block;
            font-size: 0.8rem;
            color: #666;
          }
          
          .stat-value {
            display: block;
            font-size: 1.2rem;
            font-weight: 600;
            color: #333;
          }
        `}</style>
      </div>
    );
  }

  // Main application interface
  return (
    <ErrorBoundary>
      <div className="app">
        <header className="app-header">
          <div className="header-content">
            <h1>🌐 GitNexus</h1>
            <div className="header-actions">
              <button onClick={handleClearResults} className="clear-button">
                🏠 New Analysis
              </button>
              <button onClick={settings.showSettings} className="settings-button">
                ⚙️ Settings
              </button>
            </div>
          </div>
        </header>

        <div className="main-layout">
          <aside className="sidebar">
            {featureFlags.showEngineSelector && (
              <EngineSelector
                currentEngine={engine.currentEngine}
                availableEngines={engine.availableEngines}
                onEngineChange={handleEngineChange}
                disabled={processing.state.isProcessing}
              />
            )}

            <ProcessingStatus
              isProcessing={processing.state.isProcessing}
              progress={processing.state.progress}
              error={processing.state.error}
              currentEngine={engine.currentEngine}
              hadFallback={processing.state.hadFallback}
              fallbackEngine={processing.state.fallbackEngine}
              processingTime={processing.state.result?.processingTime}
              nodeCount={processing.state.result?.nodeCount}
              relationshipCount={processing.state.result?.relationshipCount}
            />

            {state.graph && (
              <div className="graph-actions">
                <button onClick={toggleStats} className="action-button">
                  📊 {state.showStats ? 'Hide' : 'Show'} Stats
                </button>
                <button onClick={toggleExportModal} className="action-button">
                  💾 Export Graph
                </button>
              </div>
            )}

            {state.graph && (
              <div className="chat-container">
                <ChatInterface
                  graph={state.graph}
                  fileContents={state.fileContents}
                  selectedNodeId={state.selectedNodeId}
                  llmProvider={settings.settings.llmProvider}
                  llmApiKey={settings.settings.llmApiKey}
                  azureConfig={{
                    endpoint: settings.settings.azureOpenAIEndpoint,
                    deploymentName: settings.settings.azureOpenAIDeploymentName,
                    apiVersion: settings.settings.azureOpenAIApiVersion
                  }}
                />
              </div>
            )}
          </aside>

          <main className="main-content">
            {state.graph && (
              <GraphExplorer
                graph={state.graph}
                fileContents={state.fileContents}
                selectedNodeId={state.selectedNodeId}
                onNodeSelect={handleNodeSelect}
                showStats={state.showStats}
              />
            )}
          </main>
        </div>

        {state.showExportModal && state.graph && (
          <ExportFormatModal
            onExport={handleExport}
            onClose={toggleExportModal}
            nodeCount={state.graph.nodes.length}
            relationshipCount={state.graph.relationships.length}
          />
        )}

        <style>{`
          .app {
            min-height: 100vh;
            display: flex;
            flex-direction: column;
            background: #f8f9fa;
          }
          
          .app-header {
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            color: white;
            padding: 1rem 2rem;
            box-shadow: 0 2px 10px rgba(0,0,0,0.1);
          }
          
          .header-content {
            display: flex;
            justify-content: space-between;
            align-items: center;
            max-width: 1400px;
            margin: 0 auto;
          }
          
          .header-content h1 {
            margin: 0;
            font-size: 1.8rem;
          }
          
          .header-actions {
            display: flex;
            gap: 0.5rem;
          }
          
          .clear-button, .settings-button {
            padding: 0.5rem 1rem;
            background: rgba(255,255,255,0.2);
            border: 1px solid rgba(255,255,255,0.3);
            border-radius: 4px;
            color: white;
            cursor: pointer;
            font-size: 0.9rem;
            transition: background 0.2s ease;
          }
          
          .clear-button:hover, .settings-button:hover {
            background: rgba(255,255,255,0.3);
          }
          
          .main-layout {
            flex: 1;
            display: grid;
            grid-template-columns: 400px 1fr;
            gap: 1rem;
            padding: 1rem;
            max-width: none;
            margin: 0;
            width: 100%;
            height: calc(100vh - 80px);
          }
          
          .sidebar {
            background: white;
            border-radius: 8px;
            padding: 1rem;
            box-shadow: 0 2px 10px rgba(0,0,0,0.1);
            display: flex;
            flex-direction: column;
            overflow: hidden;
          }
          
          .main-content {
            background: white;
            border-radius: 8px;
            overflow: hidden;
            box-shadow: 0 2px 10px rgba(0,0,0,0.1);
          }
          
          .chat-container {
            flex: 1;
            margin-top: 1rem;
            overflow: hidden;
            border-radius: 4px;
            border: 1px solid #e0e0e0;
          }
          
          .graph-actions {
            margin-top: 1rem;
            display: flex;
            flex-direction: column;
            gap: 0.5rem;
          }
          
          .action-button {
            padding: 0.5rem;
            background: #007bff;
            color: white;
            border: none;
            border-radius: 4px;
            cursor: pointer;
            font-size: 0.9rem;
            transition: background 0.2s ease;
          }
          
          .action-button:hover {
            background: #0056b3;
          }
          
          @media (max-width: 1200px) {
            .main-layout {
              grid-template-columns: 1fr;
              grid-template-rows: auto 1fr;
              height: auto;
            }
            
            .chat-container {
              height: 400px;
            }
          }
        `}</style>
      </div>
    </ErrorBoundary>
  );
};

export default HomePage;
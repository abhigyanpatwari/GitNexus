import React, { useState, useEffect } from 'react';
import GraphVisualization from './Visualization.tsx';
import SourceViewer from './SourceViewer.tsx';
import type { KnowledgeGraph } from '../../../core/graph/types.ts';

interface GraphExplorerProps {
  graph: KnowledgeGraph;
  fileContents?: Map<string, string>;
  className?: string;
  style?: React.CSSProperties;
}

const GraphExplorer: React.FC<GraphExplorerProps> = ({
  graph,
  fileContents,
  className = '',
  style = {}
}) => {
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);

  // Debug: Log when component receives graph data
  useEffect(() => {
    console.log('=== GRAPH EXPLORER RECEIVED GRAPH ===');
    console.log('Graph nodes:', graph?.nodes?.length || 0);
    console.log('Graph relationships:', graph?.relationships?.length || 0);
    console.log('Graph object:', graph);
    console.log('=====================================');
  }, [graph]);

  const handleNodeSelect = (nodeId: string | null) => {
    setSelectedNodeId(nodeId);
  };

  const containerStyle: React.CSSProperties = {
    display: 'flex',
    flexDirection: 'column',
    gap: '16px',
    padding: '16px',
    backgroundColor: '#f5f5f5',
    borderRadius: '8px',
    width: '100%',
    height: '100%',
    overflow: 'hidden',
    ...style
  };

  const graphContainerStyle: React.CSSProperties = {
    flex: '1 1 60%',
    minHeight: '400px'
  };

  const sourceContainerStyle: React.CSSProperties = {
    flex: '1 1 40%',
    minHeight: '300px'
  };

  const headerStyle: React.CSSProperties = {
    fontSize: '18px',
    fontWeight: '600',
    color: '#333',
    marginBottom: '8px',
    display: 'flex',
    alignItems: 'center',
    gap: '8px'
  };

  const statsStyle: React.CSSProperties = {
    display: 'flex',
    gap: '24px',
    fontSize: '14px',
    color: '#666',
    marginBottom: '16px',
    padding: '12px',
    backgroundColor: '#fff',
    borderRadius: '4px',
    border: '1px solid #ddd'
  };

  const statItemStyle: React.CSSProperties = {
    display: 'flex',
    alignItems: 'center',
    gap: '4px'
  };

  // Calculate graph statistics
  const nodeStats = graph.nodes.reduce((acc, node) => {
    acc[node.label] = (acc[node.label] || 0) + 1;
    return acc;
  }, {} as Record<string, number>);

  function getSelectedNodeName(): string {
    if (!selectedNodeId) return '';
    const node = graph.nodes.find(n => n.id === selectedNodeId);
    return node?.properties.name as string || node?.id || '';
  }

  function getNodeTypeIcon(nodeType: string): string {
    switch (nodeType.toLowerCase()) {
      case 'project': return '📁';
      case 'folder': return '📂';
      case 'file': return '📄';
      case 'module': return '📦';
      case 'function': return '⚡';
      case 'method': return '🔧';
      case 'class': return '🏗️';
      case 'variable': return '📊';
      default: return '📄';
    }
  }

  return (
    <div className={`graph-explorer ${className}`} style={containerStyle}>
      {/* Header */}
      <div>
        <div style={headerStyle}>
          <span>🔍</span>
          <span>Code Knowledge Graph Explorer</span>
        </div>
        
        {/* Statistics */}
        <div style={statsStyle}>
          <div style={statItemStyle}>
            <span>📊</span>
            <span><strong>{graph.nodes.length}</strong> nodes</span>
          </div>
          <div style={statItemStyle}>
            <span>🔗</span>
            <span><strong>{graph.relationships.length}</strong> relationships</span>
          </div>
          {Object.entries(nodeStats).map(([type, count]) => (
            <div key={type} style={statItemStyle}>
              <span>{getNodeTypeIcon(type)}</span>
              <span><strong>{count}</strong> {type.toLowerCase()}s</span>
            </div>
          ))}
        </div>
      </div>

      {/* Graph Visualization */}
      <div style={graphContainerStyle}>
        <div style={{ ...headerStyle, fontSize: '16px', marginBottom: '8px' }}>
          <span>🕸️</span>
          <span>Interactive Graph</span>
          {selectedNodeId && (
            <span style={{ 
              fontSize: '14px', 
              fontWeight: 'normal', 
              color: '#666',
              marginLeft: '8px'
            }}>
              • Selected: {getSelectedNodeName()}
            </span>
          )}
        </div>
        <GraphVisualization
          graph={graph}
          selectedNodeId={selectedNodeId}
          onNodeSelect={handleNodeSelect}
          style={{ height: '100%' }}
        />
      </div>

      {/* Source Viewer */}
      <div style={sourceContainerStyle}>
        <div style={{ ...headerStyle, fontSize: '16px', marginBottom: '8px' }}>
          <span>📝</span>
          <span>Source Code</span>
        </div>
        <SourceViewer
          graph={graph}
          selectedNodeId={selectedNodeId}
          fileContents={fileContents}
          style={{ height: '100%' }}
        />
      </div>
    </div>
  );
};

export default GraphExplorer; 

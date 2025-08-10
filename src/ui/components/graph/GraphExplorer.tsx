import { useState } from 'react';
import GraphVisualization from './Visualization.tsx';
import type { KnowledgeGraph } from '../../../core/graph/types.ts';

interface GraphExplorerProps {
  graph: KnowledgeGraph | null;
  isLoading: boolean;
}

export default function GraphExplorer({ graph, isLoading }: GraphExplorerProps) {
  const [selectedNode, setSelectedNode] = useState<string | null>(null);

  const containerStyle: React.CSSProperties = {
    width: '100%',
    height: '100%',
    display: 'flex',
    flexDirection: 'column',
    overflow: 'hidden'
  };

  const loadingStyle: React.CSSProperties = {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    height: '100%',
    fontSize: '16px',
    color: '#666'
  };

  if (isLoading) {
    return <div style={containerStyle}><div style={loadingStyle}>Loading graph...</div></div>;
  }

  if (!graph) {
    return <div style={containerStyle}><div style={loadingStyle}>No graph data available</div></div>;
  }

  return (
    <div style={containerStyle}>
      <GraphVisualization 
        graph={graph}
        onNodeSelect={setSelectedNode}
        selectedNodeId={selectedNode}
      />
    </div>
  );
} 

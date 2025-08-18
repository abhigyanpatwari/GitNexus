import React, { useState, useMemo, useRef } from 'react';
import GraphVisualization from './Visualization.tsx';
import FloatingSourceViewer from './FloatingSourceViewer.tsx';
import type { KnowledgeGraph } from '../../../core/graph/types.ts';

interface GraphExplorerProps {
  graph: KnowledgeGraph | null;
  isLoading: boolean;
  onNodeSelect?: (nodeId: string | null) => void;
  fileContents?: Map<string, string>;
}

export default function GraphExplorer({ graph, isLoading, onNodeSelect, fileContents }: GraphExplorerProps) {
  const [selectedNode, setSelectedNode] = useState<string | null>(null);
  const [hideExternalNodes, setHideExternalNodes] = useState(false);
  const [hideAllIsolatedNodes, setHideAllIsolatedNodes] = useState(false);
  const [floatingViewerOpen, setFloatingViewerOpen] = useState(false);
  const [floatingViewerPosition, setFloatingViewerPosition] = useState({ x: 0, y: 0 });
  const [floatingViewerPinned, setFloatingViewerPinned] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  const handleNodeSelect = (nodeId: string | null, event?: MouseEvent) => {
    setSelectedNode(nodeId);
    onNodeSelect?.(nodeId);
    
    if (nodeId && event) {
      // Calculate position for floating viewer
      const rect = containerRef.current?.getBoundingClientRect();
      if (rect) {
        const x = event.clientX - rect.left;
        const y = event.clientY - rect.top;
        
        // Adjust position to keep viewer within bounds
        const adjustedX = Math.min(x, window.innerWidth - 520); // 500px width + 20px margin
        const adjustedY = Math.min(y, window.innerHeight - 420); // 400px height + 20px margin
        
        setFloatingViewerPosition({ x: adjustedX, y: adjustedY });
        setFloatingViewerOpen(true);
      }
    } else if (!nodeId) {
      // Close floating viewer when deselecting (unless pinned)
      if (!floatingViewerPinned) {
        setFloatingViewerOpen(false);
      }
    }
  };

  // Filter out isolated external nodes if toggle is enabled
  const filteredGraph = useMemo(() => {
    if (!graph || (!hideExternalNodes && !hideAllIsolatedNodes)) return graph;

    // Find nodes that have no relationships (isolated nodes)
    const connectedNodeIds = new Set<string>();
    graph.relationships.forEach(rel => {
      connectedNodeIds.add(rel.source);
      connectedNodeIds.add(rel.target);
    });

    // Get all isolated nodes
    const isolatedNodes = graph.nodes.filter(node => !connectedNodeIds.has(node.id));
    
    // Debug: Log what we're filtering
    console.log('🔍 GraphExplorer Filtering Debug:', {
      totalNodes: graph.nodes.length,
      connectedNodes: connectedNodeIds.size,
      isolatedNodes: isolatedNodes.length,
      hideExternal: hideExternalNodes,
      hideAll: hideAllIsolatedNodes,
      allNodeTypes: [...new Set(graph.nodes.map(n => n.label))],
      isolatedNodeDetails: isolatedNodes.map(n => ({
        id: n.id,
        label: n.label,
        name: n.properties.name || n.properties.functionName || 'unnamed',
        allProperties: Object.keys(n.properties)
      }))
    });

    let nodesToHide: typeof graph.nodes = [];

    if (hideAllIsolatedNodes) {
      // Hide ALL isolated nodes
      nodesToHide = isolatedNodes;
      console.log('🔍 Hiding ALL isolated nodes:', nodesToHide.length);
    } else if (hideExternalNodes) {
      // Hide external library nodes (regardless of whether they're isolated)
      nodesToHide = graph.nodes.filter(node => {
        const nodeName = (node.properties.name || node.properties.functionName || '') as string;
        
        console.log('🔍 Checking node for external patterns:', {
          id: node.id,
          label: node.label,
          name: nodeName,
          allProps: node.properties
        });
        
        // Check for external library patterns
        const isExternalLibrary = (
          // Specific external library names
          nodeName.includes('when_all') ||
          nodeName.includes('ruleset') ||
          nodeName.includes('APIRouter') ||
          nodeName.includes('StateGraph') ||
          nodeName.includes('AsyncAzureOpenAI') ||
          nodeName.includes('FastAPI') ||
          nodeName.includes('HTTPException') ||
          nodeName.includes('assert_fact') ||
          nodeName.includes('get_facts') ||
          nodeName.includes('delete_state') ||
          nodeName.includes('anyItem') ||
          nodeName.includes('allItems') ||
          nodeName.includes('matches') ||
          // Common external patterns
          /^[A-Z][a-zA-Z]*Model$/.test(nodeName) || // Models ending in 'Model'
          /^[A-Z][a-zA-Z]*Client$/.test(nodeName) || // Clients
          /^[A-Z][a-zA-Z]*Router$/.test(nodeName) || // Routers
          /^[A-Z][a-zA-Z]*Exception$/.test(nodeName) || // Exceptions
          // CamelCase starting with uppercase (often external classes)
          (/^[A-Z][a-zA-Z]*$/.test(nodeName) && nodeName.length > 3)
        );
        
        // Check for decorators and functions that are likely external
        const isLikelyExternal = (
          (node.label === 'Decorator' || node.label === 'Function') &&
          isExternalLibrary
        );
        
        console.log('🔍 External check result:', {
          name: nodeName,
          label: node.label,
          isExternalLibrary,
          isLikelyExternal
        });
        
        return isLikelyExternal;
      });
      console.log('🔍 Hiding external library nodes:', nodesToHide.length);
    }
    
    console.log('🔍 Final nodes to hide:', nodesToHide.map(n => ({
      id: n.id,
      label: n.label,
      name: n.properties.name || n.properties.functionName || 'unnamed'
    })));

    const nodeIdsToHide = new Set(nodesToHide.map(n => n.id));
    
    // Filter out the nodes we want to hide
    const filteredNodes = graph.nodes.filter(node => !nodeIdsToHide.has(node.id));
    
    // Filter out relationships involving hidden nodes
    const filteredRelationships = graph.relationships.filter(rel => 
      !nodeIdsToHide.has(rel.source) && !nodeIdsToHide.has(rel.target)
    );

    console.log('🔍 Filtering result:', {
      originalNodes: graph.nodes.length,
      filteredNodes: filteredNodes.length,
      hiddenNodes: nodeIdsToHide.size,
      originalRels: graph.relationships.length,
      filteredRels: filteredRelationships.length
    });

    return {
      nodes: filteredNodes,
      relationships: filteredRelationships
    };
  }, [graph, hideExternalNodes, hideAllIsolatedNodes]);

  const containerStyle: React.CSSProperties = {
    width: '100%',
    height: '100%',
    display: 'flex',
    flexDirection: 'column',
    overflow: 'hidden'
  };

  const controlsStyle: React.CSSProperties = {
    padding: '8px 12px',
    borderBottom: '1px solid #e0e0e0',
    backgroundColor: '#f8f9fa',
    display: 'flex',
    alignItems: 'center',
    gap: '12px',
    fontSize: '14px'
  };

  const loadingStyle: React.CSSProperties = {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    height: '100%',
    fontSize: '16px',
    color: '#666'
  };

  const graphContainerStyle: React.CSSProperties = {
    flex: 1,
    overflow: 'hidden'
  };

  if (isLoading) {
    return <div style={containerStyle}><div style={loadingStyle}>Loading graph...</div></div>;
  }

  if (!graph) {
    return <div style={containerStyle}><div style={loadingStyle}>No graph data available</div></div>;
  }

  // Count isolated nodes for display
  const connectedNodeIds = new Set<string>();
  graph.relationships.forEach(rel => {
    connectedNodeIds.add(rel.source);
    connectedNodeIds.add(rel.target);
  });
  const isolatedCount = graph.nodes.filter(node => !connectedNodeIds.has(node.id)).length;
  
  // Count external nodes (not just isolated ones)
  const externalCount = useMemo(() => {
    if (!graph) return 0;
    
    return graph.nodes.filter(node => {
      const nodeName = (node.properties.name || node.properties.functionName || '') as string;
      const isExternalLibrary = (
        nodeName.includes('when_all') ||
        nodeName.includes('ruleset') ||
        nodeName.includes('APIRouter') ||
        nodeName.includes('StateGraph') ||
        nodeName.includes('AsyncAzureOpenAI') ||
        nodeName.includes('FastAPI') ||
        nodeName.includes('HTTPException') ||
        nodeName.includes('assert_fact') ||
        nodeName.includes('get_facts') ||
        nodeName.includes('delete_state') ||
        nodeName.includes('anyItem') ||
        nodeName.includes('allItems') ||
        nodeName.includes('matches') ||
        /^[A-Z][a-zA-Z]*Model$/.test(nodeName) ||
        /^[A-Z][a-zA-Z]*Client$/.test(nodeName) ||
        /^[A-Z][a-zA-Z]*Router$/.test(nodeName) ||
        /^[A-Z][a-zA-Z]*Exception$/.test(nodeName) ||
        (/^[A-Z][a-zA-Z]*$/.test(nodeName) && nodeName.length > 3)
      );
      return (node.label === 'Decorator' || node.label === 'Function') && isExternalLibrary;
    }).length;
  }, [graph]);
  
  // Count what's actually being hidden
  const hiddenCount = useMemo(() => {
    if (!graph) return 0;
    
    if (hideAllIsolatedNodes) {
      return isolatedCount;
    } else if (hideExternalNodes) {
      return externalCount;
    }
    return 0;
  }, [graph, hideExternalNodes, hideAllIsolatedNodes, isolatedCount, externalCount]);

  return (
    <div style={containerStyle} ref={containerRef}>
      <div style={controlsStyle}>
        <label style={{ display: 'flex', alignItems: 'center', gap: '6px', cursor: 'pointer' }}>
          <input
            type="checkbox"
            checked={hideExternalNodes}
            onChange={(e) => setHideExternalNodes(e.target.checked)}
            style={{ cursor: 'pointer' }}
          />
          <span>Hide external libraries</span>
        </label>
        <label style={{ display: 'flex', alignItems: 'center', gap: '6px', cursor: 'pointer' }}>
          <input
            type="checkbox"
            checked={hideAllIsolatedNodes}
            onChange={(e) => setHideAllIsolatedNodes(e.target.checked)}
            style={{ cursor: 'pointer' }}
          />
          <span>Hide all isolated nodes</span>
        </label>
        <span style={{ color: '#666', fontSize: '12px' }}>
          ({isolatedCount} isolated, {externalCount} external, {hiddenCount} hidden)
        </span>
      </div>
      <div style={graphContainerStyle}>
        <GraphVisualization 
          graph={filteredGraph || graph}
          onNodeSelect={handleNodeSelect}
          selectedNodeId={selectedNode}
        />
      </div>

      {/* Floating Source Viewer */}
      {graph && fileContents && (
        <FloatingSourceViewer
          isOpen={floatingViewerOpen}
          position={floatingViewerPosition}
          nodeId={selectedNode}
          graph={graph}
          fileContents={fileContents}
          onClose={() => setFloatingViewerOpen(false)}
          onPin={setFloatingViewerPinned}
          isPinned={floatingViewerPinned}
        />
      )}
    </div>
  );
} 

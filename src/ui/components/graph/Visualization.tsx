import React, { useEffect, useRef, useState } from 'react';
// @ts-expect-error - npm: imports are resolved at runtime in Deno
import cytoscape from 'npm:cytoscape';
// @ts-expect-error - npm: imports are resolved at runtime in Deno
import dagre from 'npm:cytoscape-dagre';
import type { KnowledgeGraph, GraphNode, GraphRelationship } from '../../../core/graph/types.ts';

// Register the dagre layout extension
cytoscape.use(dagre);

interface GraphVisualizationProps {
  graph: KnowledgeGraph;
  onNodeSelect?: (nodeId: string | null) => void;
  selectedNodeId?: string | null;
  className?: string;
  style?: React.CSSProperties;
}

interface CytoscapeElement {
  data: {
    id: string;
    label?: string;
    source?: string;
    target?: string;
    nodeType?: string;
    [key: string]: unknown;
  };
  classes?: string;
}

const GraphVisualization: React.FC<GraphVisualizationProps> = ({
  graph,
  onNodeSelect,
  selectedNodeId,
  className = '',
  style = {}
}) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const cyRef = useRef<any>(null);
  const [isReady, setIsReady] = useState(false);

  // Convert KnowledgeGraph to Cytoscape elements
  const convertToElements = (graph: KnowledgeGraph): CytoscapeElement[] => {
    const elements: CytoscapeElement[] = [];

    // Add nodes
    graph.nodes.forEach((node: GraphNode) => {
      elements.push({
        data: {
          id: node.id,
          label: node.properties.name as string || node.id,
          nodeType: node.label.toLowerCase(),
          ...node.properties
        },
        classes: `node-${node.label.toLowerCase()}`
      });
    });

    // Add edges
    graph.relationships.forEach((rel: GraphRelationship) => {
      elements.push({
        data: {
          id: rel.id,
          source: rel.source,
          target: rel.target,
          label: rel.type,
          relationshipType: rel.type.toLowerCase(),
          ...rel.properties
        },
        classes: `edge-${rel.type.toLowerCase()}`
      });
    });

    return elements;
  };

  // Define styles for different node types
  const getStylesheet = () => [
    // Base node styles
    {
      selector: 'node',
      style: {
        'label': 'data(label)',
        'text-valign': 'center',
        'text-halign': 'center',
        'font-size': '12px',
        'font-family': 'system-ui, -apple-system, sans-serif',
        'color': '#333',
        'text-wrap': 'wrap',
        'text-max-width': '80px',
        'width': '60px',
        'height': '60px',
        'border-width': '2px',
        'border-style': 'solid',
        'border-color': '#ccc'
      }
    },
    // Project nodes
    {
      selector: '.node-project',
      style: {
        'background-color': '#4CAF50',
        'border-color': '#388E3C',
        'shape': 'round-rectangle',
        'width': '80px',
        'height': '40px'
      }
    },
    // Folder nodes
    {
      selector: '.node-folder',
      style: {
        'background-color': '#FF9800',
        'border-color': '#F57C00',
        'shape': 'round-rectangle',
        'width': '70px',
        'height': '35px'
      }
    },
    // File nodes
    {
      selector: '.node-file',
      style: {
        'background-color': '#2196F3',
        'border-color': '#1976D2',
        'shape': 'rectangle'
      }
    },
    // Module nodes
    {
      selector: '.node-module',
      style: {
        'background-color': '#9C27B0',
        'border-color': '#7B1FA2',
        'shape': 'round-rectangle'
      }
    },
    // Function nodes
    {
      selector: '.node-function',
      style: {
        'background-color': '#00BCD4',
        'border-color': '#0097A7',
        'shape': 'ellipse'
      }
    },
    // Method nodes
    {
      selector: '.node-method',
      style: {
        'background-color': '#00BCD4',
        'border-color': '#0097A7',
        'shape': 'ellipse',
        'width': '50px',
        'height': '50px'
      }
    },
    // Class nodes
    {
      selector: '.node-class',
      style: {
        'background-color': '#E91E63',
        'border-color': '#C2185B',
        'shape': 'diamond'
      }
    },
    // Variable nodes
    {
      selector: '.node-variable',
      style: {
        'background-color': '#607D8B',
        'border-color': '#455A64',
        'shape': 'triangle',
        'width': '40px',
        'height': '40px'
      }
    },
    // Selected node
    {
      selector: '.selected',
      style: {
        'border-width': '4px',
        'border-color': '#FF5722',
        'box-shadow': '0 0 20px rgba(255, 87, 34, 0.6)'
      }
    },
    // Base edge styles
    {
      selector: 'edge',
      style: {
        'width': '2px',
        'line-color': '#666',
        'target-arrow-color': '#666',
        'target-arrow-shape': 'triangle',
        'curve-style': 'bezier',
        'arrow-scale': '1.2'
      }
    },
    // CONTAINS relationships
    {
      selector: '.edge-contains',
      style: {
        'line-color': '#4CAF50',
        'target-arrow-color': '#4CAF50'
      }
    },
    // CALLS relationships
    {
      selector: '.edge-calls',
      style: {
        'line-color': '#FF5722',
        'target-arrow-color': '#FF5722',
        'line-style': 'dashed'
      }
    },
    // IMPORTS relationships
    {
      selector: '.edge-imports',
      style: {
        'line-color': '#9C27B0',
        'target-arrow-color': '#9C27B0',
        'line-style': 'dotted'
      }
    },
    // INHERITS relationships
    {
      selector: '.edge-inherits',
      style: {
        'line-color': '#2196F3',
        'target-arrow-color': '#2196F3'
      }
    },
    // OVERRIDES relationships
    {
      selector: '.edge-overrides',
      style: {
        'line-color': '#FF9800',
        'target-arrow-color': '#FF9800'
      }
    }
  ];

  // Initialize Cytoscape
  useEffect(() => {
    if (!containerRef.current || !graph) return;

    const elements = convertToElements(graph);
    const stylesheet = getStylesheet();

    cyRef.current = cytoscape({
      container: containerRef.current,
      elements,
      style: stylesheet,
      layout: {
        name: 'dagre',
        rankDir: 'TB', // Top to bottom
        spacingFactor: 1.2,
        nodeSep: 50,
        edgeSep: 10,
        rankSep: 100
      },
      // Interaction options
      minZoom: 0.1,
      maxZoom: 3,
      wheelSensitivity: 0.5,
      boxSelectionEnabled: false,
      autounselectify: false
    });

    // Handle node click events
    cyRef.current.on('tap', 'node', (event: any) => {
      const node = event.target;
      const nodeId = node.id();
      
      // Remove previous selection
      cyRef.current.elements('.selected').removeClass('selected');
      
      // Add selection to clicked node
      node.addClass('selected');
      
      // Notify parent component
      if (onNodeSelect) {
        onNodeSelect(nodeId);
      }
    });

    // Handle background click (deselect)
    cyRef.current.on('tap', (event: any) => {
      if (event.target === cyRef.current) {
        cyRef.current.elements('.selected').removeClass('selected');
        if (onNodeSelect) {
          onNodeSelect(null);
        }
      }
    });

    setIsReady(true);

    // Cleanup function
    return () => {
      if (cyRef.current) {
        cyRef.current.destroy();
        cyRef.current = null;
      }
      setIsReady(false);
    };
  }, [graph, onNodeSelect]);

  // Update selection when selectedNodeId prop changes
  useEffect(() => {
    if (!cyRef.current || !isReady) return;

    // Remove all selections
    cyRef.current.elements('.selected').removeClass('selected');

    // Add selection to specified node
    if (selectedNodeId) {
      const node = cyRef.current.getElementById(selectedNodeId);
      if (node.length > 0) {
        node.addClass('selected');
        // Center the view on the selected node
        cyRef.current.center(node);
      }
    }
  }, [selectedNodeId, isReady]);

  // Fit graph to container when graph changes
  useEffect(() => {
    if (!cyRef.current || !isReady) return;

    // Fit the graph to the container with some padding
    setTimeout(() => {
      cyRef.current.fit(undefined, 50);
    }, 100);
  }, [graph, isReady]);

  const defaultStyle: React.CSSProperties = {
    width: '100%',
    height: '600px',
    border: '1px solid #ddd',
    borderRadius: '4px',
    backgroundColor: '#fafafa',
    ...style
  };

  return (
    <div className={`graph-visualization ${className}`}>
      <div
        ref={containerRef}
        style={defaultStyle}
        className="cytoscape-container"
      />
      {!isReady && (
        <div
          style={{
            position: 'absolute',
            top: '50%',
            left: '50%',
            transform: 'translate(-50%, -50%)',
            color: '#666',
            fontSize: '14px'
          }}
        >
          Loading graph...
        </div>
      )}
    </div>
  );
};

export default GraphVisualization; 
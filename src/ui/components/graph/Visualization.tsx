import React, { useEffect, useRef, useState } from 'react';
import * as d3 from 'd3';
import type { KnowledgeGraph, GraphNode, GraphRelationship } from '../../../core/graph/types.ts';

interface GraphVisualizationProps {
  graph: KnowledgeGraph;
  onNodeSelect?: (nodeId: string | null) => void;
  selectedNodeId?: string | null;
  className?: string;
  style?: React.CSSProperties;
}

interface D3Node extends d3.SimulationNodeDatum {
  id: string;
  label: string;
  nodeType: string;
  properties: Record<string, unknown>;
  color: string;
  size: number;
}

interface D3Link extends d3.SimulationLinkDatum<D3Node> {
  id: string;
  source: string | D3Node;
  target: string | D3Node;
  relationshipType: string;
  color: string;
  width: number;
}

const GraphVisualization: React.FC<GraphVisualizationProps> = ({
  graph,
  onNodeSelect,
  selectedNodeId,
  className = '',
  style = {}
}) => {
  const svgRef = useRef<SVGSVGElement>(null);
  const simulationRef = useRef<d3.Simulation<D3Node, D3Link> | null>(null);
  const onNodeSelectRef = useRef(onNodeSelect);
  const [isReady, setIsReady] = useState(false);

  // Update the ref whenever onNodeSelect changes
  onNodeSelectRef.current = onNodeSelect;

  // Convert KnowledgeGraph to D3 format
  const convertToD3Format = (graph: KnowledgeGraph) => {
    const nodeIds = new Set<string>();
    
    // Convert nodes
    const nodes: D3Node[] = graph.nodes.map((node: GraphNode) => {
      nodeIds.add(node.id);
      
      // Determine node color and size based on type
      let color = '#69b3a2';
      let size = 8;
      
      switch (node.label.toLowerCase()) {
        case 'project':
          color = '#2E7D32';
          size = 20;
          break;
        case 'folder':
          color = '#F57C00';
          size = 12;
          break;
        case 'file':
          color = '#1976D2';
          size = 10;
          break;
        case 'function':
          color = '#00796B';
          size = 8;
          break;
        case 'method':
          color = '#00695C';
          size = 7;
          break;
        case 'class':
          color = '#C2185B';
          size = 10;
          break;
        case 'variable':
          color = '#546E7A';
          size = 6;
          break;
        default:
          color = '#69b3a2';
          size = 8;
      }
      
      return {
        id: node.id,
        label: node.properties.name as string || node.id,
        nodeType: node.label.toLowerCase(),
        properties: node.properties,
        color,
        size
      };
    });

    // Convert links with validation
    const links: D3Link[] = [];
    graph.relationships.forEach((rel: GraphRelationship) => {
      // Validate that both source and target nodes exist
      if (!nodeIds.has(rel.source) || !nodeIds.has(rel.target)) {
        console.warn(`Skipping invalid relationship: ${rel.source} -> ${rel.target}`);
        return;
      }
      
      // Skip self-loops
      if (rel.source === rel.target) {
        return;
      }

      // Determine link color and width based on type
      let color = '#999';
      let width = 1;
      
      switch (rel.type.toLowerCase()) {
        case 'contains':
          color = '#4CAF50';
          width = 2;
          break;
        case 'calls':
          color = '#F44336';
          width = 1;
          break;
        case 'imports':
          color = '#9C27B0';
          width = 1.5;
          break;
        case 'inherits':
          color = '#2196F3';
          width = 2;
          break;
        default:
          color = '#999';
          width = 1;
      }

      links.push({
        id: rel.id,
        source: rel.source,
        target: rel.target,
        relationshipType: rel.type.toLowerCase(),
        color,
        width
      });
    });

    return { nodes, links };
  };

  // Initialize D3 visualization
  useEffect(() => {
    if (!svgRef.current || !graph) return;

    const svg = d3.select(svgRef.current);
    const container = svg.select('.graph-container');
    
    // Clear previous content
    container.selectAll('*').remove();

    const { nodes, links } = convertToD3Format(graph);

    // Get SVG dimensions
    const rect = svgRef.current.getBoundingClientRect();
    const width = rect.width || 800;
    const height = rect.height || 600;

    // Set up zoom behavior
    const zoom = d3.zoom<SVGSVGElement, unknown>()
      .scaleExtent([0.1, 4])
      .on('zoom', (event) => {
        container.attr('transform', event.transform);
      });

    // Apply zoom behavior to SVG
    svg.call(zoom);

    // Reset zoom on double-click
    svg.on('dblclick.zoom', null);
    svg.on('dblclick', () => {
      svg.transition().duration(750).call(
        zoom.transform,
        d3.zoomIdentity
      );
    });

    // Create force simulation
    const simulation = d3.forceSimulation<D3Node>(nodes)
      .force('link', d3.forceLink<D3Node, D3Link>(links)
        .id((d: D3Node) => d.id)
        .distance((d: D3Link) => {
          switch (d.relationshipType) {
            case 'contains': return 60;
            case 'imports': return 100;
            case 'calls': return 80;
            default: return 90;
          }
        })
        .strength(0.7)
      )
      .force('charge', d3.forceManyBody()
        .strength((d: d3.SimulationNodeDatum) => {
          const node = d as D3Node;
          switch (node.nodeType) {
            case 'project': return -800;
            case 'folder': return -400;
            case 'file': return -300;
            default: return -200;
          }
        })
      )
      .force('center', d3.forceCenter(width / 2, height / 2))
      .force('collision', d3.forceCollide()
        .radius((node: d3.SimulationNodeDatum) => {
          const d = node as D3Node;
          return d.size + 5;
        })
        .strength(0.7)
      )
      .alphaTarget(0.05)
      .alphaDecay(0.005);

    simulationRef.current = simulation;

    // Create links
    const link = container.append('g')
      .attr('class', 'links')
      .selectAll('line')
      .data(links)
      .enter().append('line')
      .attr('stroke', (d) => d.color)
      .attr('stroke-width', (d) => d.width)
      .attr('stroke-opacity', 0.8)
      .style('stroke-dasharray', (d) => {
        switch (d.relationshipType) {
          case 'calls': return '5,5';
          case 'imports': return '3,3';
          default: return 'none';
        }
      });

    // Create nodes
    const node = container.append('g')
      .attr('class', 'nodes')
      .selectAll('circle')
      .data(nodes)
      .enter().append('circle')
      .attr('r', (d) => d.size)
      .attr('fill', (d) => d.color)
      .attr('stroke', '#fff')
      .attr('stroke-width', 2)
      .style('cursor', 'pointer');

    // Use D3 drag with proper click distance to prevent sticking
    node.call(d3.drag<SVGCircleElement, D3Node>()
      .clickDistance(10) // Larger threshold to better distinguish clicks from drags
      .on('start', function(event) {
        // Only fix position if this is actually a drag (not a click)
        if (event.sourceEvent.type === 'mousedown') {
          // Don't fix position immediately - wait for actual drag
        }
      })
      .on('drag', function(event, d) {
        // This only fires on actual drags (beyond clickDistance)
        if (!d.fx && !d.fy) {
          // First drag event - fix position and restart simulation
          d.fx = d.x;
          d.fy = d.y;
          if (!event.active) simulation.alphaTarget(0.3).restart();
        }
        d.fx = event.x;
        d.fy = event.y;
      })
      .on('end', function(event, d) {
        if (!event.active) simulation.alphaTarget(0.05);
        // Release the node
        d.fx = null;
        d.fy = null;
      })
    );

    // Create labels
    const label = container.append('g')
      .attr('class', 'labels')
      .selectAll('text')
      .data(nodes)
      .enter().append('text')
      .text((d) => d.label)
      .attr('font-size', (d) => Math.max(8, d.size - 2))
      .attr('font-family', 'Inter, system-ui, sans-serif')
      .attr('font-weight', '500')
      .attr('fill', '#fff')
      .attr('text-anchor', 'middle')
      .attr('dy', '0.35em')
      .style('pointer-events', 'none')
      .style('text-shadow', '1px 1px 2px rgba(0,0,0,0.8)');

    // Node click handler
    node.on('click', (event, d) => {
      
      // Ignore clicks if we're dragging or just finished dragging
      if (d.fx || d.fy) return; // Check if node is being dragged
      
      event.stopPropagation();
      
      // Remove previous selection
      node.classed('selected', false);
      node.attr('stroke-width', 2);
      
      // Add selection to clicked node
      d3.select(event.currentTarget)
        .classed('selected', true)
        .attr('stroke-width', 4)
        .attr('stroke', '#FFD54F');
      
      // Highlight connected elements
      const connectedNodeIds = new Set<string>();
      link.attr('stroke-opacity', 0.1);
      node.attr('opacity', 0.3);
      label.attr('opacity', 0.3);
      
      links.forEach(linkData => {
        const sourceId = typeof linkData.source === 'object' ? linkData.source.id : linkData.source;
        const targetId = typeof linkData.target === 'object' ? linkData.target.id : linkData.target;
        
        if (sourceId === d.id || targetId === d.id) {
          connectedNodeIds.add(sourceId);
          connectedNodeIds.add(targetId);
        }
      });
      
      // Highlight connected nodes and links
      link.filter(linkData => {
        const sourceId = typeof linkData.source === 'object' ? linkData.source.id : linkData.source;
        const targetId = typeof linkData.target === 'object' ? linkData.target.id : linkData.target;
        return sourceId === d.id || targetId === d.id;
      }).attr('stroke-opacity', 1);
      
      node.filter(nodeData => connectedNodeIds.has(nodeData.id))
        .attr('opacity', 1);
      
      label.filter(nodeData => connectedNodeIds.has(nodeData.id))
        .attr('opacity', 1);
      
      // Keep selected node fully visible
      d3.select(event.currentTarget).attr('opacity', 1);
      label.filter(nodeData => nodeData.id === d.id).attr('opacity', 1);
      
      if (onNodeSelectRef.current) {
        onNodeSelectRef.current(d.id);
      }
    });

    // Background click handler - clear selection when clicking empty space
    svg.on('click', (event) => {
      // Only handle clicks on the SVG background (not on nodes or other elements)
      if (event.target === event.currentTarget) {
        // Remove all selections and highlighting
        node.classed('selected', false);
        node.attr('stroke-width', 2).attr('stroke', '#fff').attr('opacity', 1);
        link.attr('stroke-opacity', 0.8);
        label.attr('opacity', 1);
        
        if (onNodeSelectRef.current) {
          onNodeSelectRef.current(null);
        }
      }
    });

    // Hover effects
    node.on('mouseover', (event, d) => {
      d3.select(event.currentTarget)
        .transition()
        .duration(200)
        .attr('r', d.size * 1.3);
    });

    node.on('mouseout', (event, d) => {
      d3.select(event.currentTarget)
        .transition()
        .duration(200)
        .attr('r', d.size);
    });

    // Update positions on each tick
    simulation.on('tick', () => {
      link
        .attr('x1', (d) => (d.source as D3Node).x!)
        .attr('y1', (d) => (d.source as D3Node).y!)
        .attr('x2', (d) => (d.target as D3Node).x!)
        .attr('y2', (d) => (d.target as D3Node).y!);

      node
        .attr('cx', (d) => d.x!)
        .attr('cy', (d) => d.y!);

      label
        .attr('x', (d) => d.x!)
        .attr('y', (d) => d.y!);
    });

    setIsReady(true);

    // Cleanup function
    return () => {
      if (simulationRef.current) {
        simulationRef.current.stop();
        simulationRef.current = null;
      }
      setIsReady(false);
    };
  }, [graph]); // Removed onNodeSelect from dependencies to prevent re-renders

  // Handle selected node changes
  useEffect(() => {
    if (!svgRef.current || !isReady || !selectedNodeId) return;

    const svg = d3.select(svgRef.current);
    const nodes = svg.selectAll('.nodes circle');
    
    // Remove previous selection
    nodes.classed('selected', false);
    nodes.attr('stroke-width', 2).attr('stroke', '#fff');
    
    // Select the specified node
    nodes.filter(function(d) { return (d as D3Node).id === selectedNodeId; })
      .classed('selected', true)
      .attr('stroke-width', 4)
      .attr('stroke', '#FFD54F');
  }, [selectedNodeId, isReady]);

  const defaultStyle: React.CSSProperties = {
    width: '100%',
    height: style.height || '700px',
    minHeight: '600px',
    border: '1px solid #37474F',
    borderRadius: '8px',
    backgroundColor: '#263238',
    position: 'relative',
    boxShadow: '0 4px 20px rgba(0,0,0,0.1)',
    ...style
  };

  return (
    <div className={`graph-visualization ${className}`} style={{ position: 'relative', width: '100%', minHeight: '600px' }}>
      <svg
        ref={svgRef}
        style={defaultStyle}
        className="d3-graph-container"
      >
        <g className="graph-container" />
      </svg>
      {!isReady && (
        <div
          style={{
            position: 'absolute',
            top: '50%',
            left: '50%',
            transform: 'translate(-50%, -50%)',
            color: '#90A4AE',
            fontSize: '16px',
            fontFamily: 'Inter, system-ui, sans-serif',
            fontWeight: '500',
            zIndex: 10,
            display: 'flex',
            alignItems: 'center',
            gap: '12px'
          }}
        >
          <div
            style={{
              width: '20px',
              height: '20px',
              border: '2px solid #90A4AE',
              borderTop: '2px solid transparent',
              borderRadius: '50%',
              animation: 'spin 1s linear infinite'
            }}
          />
          Loading knowledge graph...
        </div>
      )}
      
      {/* Add navigation instructions */}
      <div
        style={{
          position: 'absolute',
          top: '10px',
          right: '16px',
          backgroundColor: 'rgba(0, 0, 0, 0.7)',
          color: '#fff',
          padding: '8px 12px',
          borderRadius: '4px',
          fontSize: '12px',
          fontFamily: 'Inter, system-ui, sans-serif',
          zIndex: 10,
          lineHeight: '1.4'
        }}
      >
        <div>🖱️ <strong>Navigation:</strong></div>
        <div>• Drag to pan</div>
        <div>• Scroll to zoom</div>
        <div>• Double-click to reset view</div>
        <div>• Drag nodes to reposition</div>
      </div>

      <style>{`
        @keyframes spin {
          0% { transform: rotate(0deg); }
          100% { transform: rotate(360deg); }
        }
        
        .d3-graph-container {
          font-family: 'Inter', system-ui, sans-serif;
          cursor: grab;
        }
        
        .d3-graph-container:active {
          cursor: grabbing;
        }
        
        .nodes circle.selected {
          filter: drop-shadow(0 0 10px rgba(255, 213, 79, 0.8));
        }
        
        .links line {
          transition: stroke-opacity 0.3s ease;
        }
        
        .nodes circle {
          transition: opacity 0.3s ease, r 0.2s ease;
        }
        
        .labels text {
          transition: opacity 0.3s ease;
        }
      `}</style>
    </div>
  );
};

export default GraphVisualization; 

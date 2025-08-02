import React, { useMemo } from 'react';
import type { KnowledgeGraph, GraphNode } from '../../../core/graph/types.ts';

interface SourceViewerProps {
  graph: KnowledgeGraph;
  selectedNodeId: string | null;
  className?: string;
  style?: React.CSSProperties;
}

interface SourceInfo {
  fileName: string;
  filePath: string;
  content: string;
  startLine?: number;
  endLine?: number;
  nodeType: string;
  nodeName: string;
}

const SourceViewer: React.FC<SourceViewerProps> = ({
  graph,
  selectedNodeId,
  className = '',
  style = {}
}) => {
  // Find the selected node and extract source information
  const sourceInfo = useMemo((): SourceInfo | null => {
    if (!selectedNodeId || !graph) return null;

    const selectedNode = graph.nodes.find(node => node.id === selectedNodeId);
    if (!selectedNode) return null;

    // Extract file path from node properties
    const filePath = selectedNode.properties.filePath as string || 
                    selectedNode.properties.path as string;
    
    if (!filePath) return null;

    // Get file name from path
    const pathParts = filePath.split('/');
    const fileName = pathParts[pathParts.length - 1];

    // For demonstration purposes, we'll create mock content
    // In a real implementation, this would come from the file contents
    const content = generateMockContent(selectedNode);

    return {
      fileName,
      filePath,
      content,
      startLine: selectedNode.properties.startLine as number,
      endLine: selectedNode.properties.endLine as number,
      nodeType: selectedNode.label,
      nodeName: selectedNode.properties.name as string || selectedNode.id
    };
  }, [selectedNodeId, graph]);

  // Generate mock source content based on node type
  const generateMockContent = (node: GraphNode): string => {
    const name = node.properties.name as string || 'unknown';
    
    switch (node.label) {
      case 'Function':
        return `def ${name}():
    """
    Function: ${name}
    """
    # Implementation here
    pass`;

      case 'Method':
        const parentClass = node.properties.parentClass as string || 'UnknownClass';
        return `class ${parentClass}:
    def ${name}(self):
        """
        Method: ${name}
        Class: ${parentClass}
        """
        # Implementation here
        pass`;

      case 'Class':
        return `class ${name}:
    """
    Class: ${name}
    """
    
    def __init__(self):
        # Constructor
        pass`;

      case 'Module':
        return `"""
Module: ${name}

This module contains various functions and classes.
"""

# Module-level imports and code here`;

      case 'File':
        const extension = node.properties.extension as string || '';
        if (extension === '.py') {
          return `# Python file: ${name}

"""
File: ${name}
"""

# File contents would be displayed here`;
        }
        return `// File: ${name}
// Content of the file would be displayed here`;

      case 'Project':
        return `# Project: ${name}

This is the root of the project structure.
Contains modules, packages, and other project files.`;

      case 'Folder':
        return `# Folder: ${name}

Directory containing:
- Subfolders
- Source files
- Other project assets`;

      default:
        return `# ${node.label}: ${name}

Details about this ${node.label.toLowerCase()} would be shown here.`;
    }
  };

  // Format line numbers
  const formatLineNumbers = (content: string, startLine?: number): string => {
    const lines = content.split('\n');
    const lineStart = startLine || 1;
    
    return lines
      .map((line, index) => {
        const lineNumber = (lineStart + index).toString().padStart(3, ' ');
        return `${lineNumber}│ ${line}`;
      })
      .join('\n');
  };

  const defaultStyle: React.CSSProperties = {
    width: '100%',
    height: '400px',
    border: '1px solid #ddd',
    borderRadius: '4px',
    backgroundColor: '#f8f9fa',
    display: 'flex',
    flexDirection: 'column',
    ...style
  };

  const headerStyle: React.CSSProperties = {
    padding: '12px 16px',
    borderBottom: '1px solid #ddd',
    backgroundColor: '#fff',
    borderRadius: '4px 4px 0 0',
    fontSize: '14px',
    fontWeight: '600',
    color: '#333'
  };

  const contentStyle: React.CSSProperties = {
    flex: 1,
    padding: '16px',
    overflow: 'auto',
    fontFamily: 'Monaco, Menlo, "Ubuntu Mono", Consolas, source-code-pro, monospace',
    fontSize: '13px',
    lineHeight: '1.5',
    backgroundColor: '#fafafa',
    color: '#333',
    whiteSpace: 'pre',
    tabSize: 2
  };

  const placeholderStyle: React.CSSProperties = {
    flex: 1,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    color: '#666',
    fontSize: '14px',
    fontStyle: 'italic'
  };

  const getNodeTypeColor = (nodeType: string): string => {
    switch (nodeType.toLowerCase()) {
      case 'project': return '#4CAF50';
      case 'folder': return '#FF9800';
      case 'file': return '#2196F3';
      case 'module': return '#9C27B0';
      case 'function': return '#00BCD4';
      case 'method': return '#00BCD4';
      case 'class': return '#E91E63';
      case 'variable': return '#607D8B';
      default: return '#666';
    }
  };

  const getNodeTypeIcon = (nodeType: string): string => {
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
  };

  return (
    <div className={`source-viewer ${className}`} style={defaultStyle}>
      {sourceInfo ? (
        <>
          <div style={headerStyle}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
              <span style={{ fontSize: '16px' }}>
                {getNodeTypeIcon(sourceInfo.nodeType)}
              </span>
              <span 
                style={{ 
                  color: getNodeTypeColor(sourceInfo.nodeType),
                  fontWeight: 'bold'
                }}
              >
                {sourceInfo.nodeType}
              </span>
              <span style={{ color: '#666' }}>•</span>
              <span>{sourceInfo.nodeName}</span>
            </div>
            <div style={{ 
              fontSize: '12px', 
              color: '#666', 
              marginTop: '4px',
              display: 'flex',
              alignItems: 'center',
              gap: '16px'
            }}>
              <span>📁 {sourceInfo.fileName}</span>
              {sourceInfo.startLine && sourceInfo.endLine && (
                <span>📍 Lines {sourceInfo.startLine}-{sourceInfo.endLine}</span>
              )}
            </div>
          </div>
          <div style={contentStyle}>
            {formatLineNumbers(sourceInfo.content, sourceInfo.startLine)}
          </div>
        </>
      ) : (
        <>
          <div style={headerStyle}>
            <span style={{ color: '#666' }}>Source Code Viewer</span>
          </div>
          <div style={placeholderStyle}>
            <div style={{ textAlign: 'center' }}>
              <div style={{ fontSize: '48px', marginBottom: '16px', opacity: 0.3 }}>
                📄
              </div>
              <div>Select a node to view its source code</div>
              <div style={{ 
                fontSize: '12px', 
                color: '#999', 
                marginTop: '8px' 
              }}>
                Click on any node in the graph to see its details
              </div>
            </div>
          </div>
        </>
      )}
    </div>
  );
};

export default SourceViewer; 
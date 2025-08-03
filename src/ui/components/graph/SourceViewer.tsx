import React, { useMemo } from 'react';
import type { KnowledgeGraph, GraphNode } from '../../../core/graph/types.ts';

interface SourceViewerProps {
  graph: KnowledgeGraph;
  selectedNodeId: string | null;
  fileContents?: Map<string, string>;
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
  language?: string;
}

const SourceViewer: React.FC<SourceViewerProps> = ({
  graph,
  selectedNodeId,
  fileContents,
  className = '',
  style = {}
}) => {
  // Generate mock source content based on node type
  const generateMockContent = (node: GraphNode): string => {
    try {
      const name = node.properties.name as string || 'unknown';
      
      switch (node.label) {
        case 'Function':
          return `def ${name}():
    """
    Function: ${name}
    """
    # Implementation here
    pass`;

        case 'Method': {
          const parentClass = node.properties.parentClass as string || 'UnknownClass';
          return `class ${parentClass}:
    def ${name}(self):
        """
        Method: ${name}
        Class: ${parentClass}
        """
        # Implementation here
        pass`;
        }

        case 'Class':
          return `class ${name}:
    """
    Class: ${name}
    """
    def __init__(self):
        # Constructor implementation
        pass`;

        case 'File': {
          const extension = node.properties.extension as string || '';
          const language = node.properties.language as string || 'unknown';
          
          // Handle different file types
          if (extension === '.js' || extension === '.ts' || extension === '.tsx' || extension === '.jsx') {
            return `// File: ${name}
// Path: ${node.properties.filePath || node.properties.path || 'unknown'}
// Language: JavaScript/TypeScript

// This is a ${language} file in the project
// Click on specific functions or classes to see their details

export default function() {
  // Implementation here
}`;
          } else {
            return `# File: ${name}
# Path: ${node.properties.filePath || node.properties.path || 'unknown'}

# This is a Python file in the project
# Click on specific functions or classes to see their details`;
          }
        }

        case 'Folder':
          return `# Folder: ${name}
# Path: ${node.properties.path || 'unknown'}

# This folder contains:
# - Python files (.py)
# - Other project files
# 
# Navigate through the graph to explore the contents`;

        case 'Project':
          return `# Project: ${name}

# This is the root of your project
# Explore the graph to see:
# - Project structure
# - Files and folders
# - Functions and classes
# - Code relationships`;

        default: {
          // Safe JSON stringify for default case
          const safeStringify = (obj: unknown) => {
            try {
              return JSON.stringify(obj, null, 2);
            } catch {
              const seen = new WeakSet();
              return JSON.stringify(obj, (key, val) => {
                if (val != null && typeof val === "object") {
                  if (seen.has(val)) {
                    return "[Circular Reference]";
                  }
                  seen.add(val);
                }
                if (typeof val === 'function') return "[Function]";
                if (val instanceof Date) return val.toISOString();
                if (val instanceof RegExp) return val.toString();
                return val;
              }, 2);
            }
          };

          return `# ${node.label}: ${name}

# Node ID: ${node.id}
# Properties: ${safeStringify(node.properties)}

# This node represents a ${node.label.toLowerCase()} in your codebase`;
        }
      }
    } catch (error) {
      console.error('Error generating mock content:', error);
      return `# Error generating content for ${node.label}: ${node.properties.name || node.id}

Error: ${error instanceof Error ? error.message : 'Unknown error'}

Node type: ${node.label}
Node ID: ${node.id}

# This error occurred while trying to generate mock content for display`;
    }
  };

  // Get source information for the selected node
  const sourceInfo = useMemo((): SourceInfo | null => {
    if (!selectedNodeId) return null;

    const selectedNode = graph.nodes.find(n => n.id === selectedNodeId);
    if (!selectedNode) return null;

    try {
      // Get file path from node properties
      const filePath = selectedNode.properties.filePath as string || selectedNode.properties.path as string || '/unknown';
      
      // Get file name from path
      const pathParts = filePath.split('/');
      const fileName = pathParts[pathParts.length - 1];

      let content: string = '';
      
      // Try to get real file contents first
      if (fileContents && selectedNode.label === 'File') {
        const realContent = fileContents.get(filePath);
        if (realContent) {
          content = realContent;
        } else {
          // Try alternative path formats
          const alternativePaths = [
            selectedNode.properties.name as string,
            fileName,
            filePath.replace(/^\/+/, ''), // Remove leading slashes
            filePath.replace(/\\/g, '/'), // Normalize path separators
          ].filter(Boolean);
          
          let found = false;
          for (const altPath of alternativePaths) {
            const altContent = fileContents.get(altPath);
            if (altContent) {
              content = altContent;
              found = true;
              break;
            }
          }
          
          if (!found) {
            // Fall back to mock content if real content not found
            content = generateMockContent(selectedNode);
          }
        }
      } else {
        // For non-file nodes or when fileContents not available, use mock content
        try {
          content = generateMockContent(selectedNode);
        } catch (mockError) {
          console.error('Error in generateMockContent:', mockError);
          // If mock content generation fails, create a basic display
          const extension = selectedNode.properties.extension as string || '';
          const name = selectedNode.properties.name as string || 'unknown';
          
          if (extension === '.js' || extension === '.ts' || extension === '.tsx' || extension === '.jsx') {
            content = `// File: ${name}
// Path: ${filePath}
// Type: JavaScript/TypeScript Build Artifact

// This is a compiled JavaScript file
// It's part of the build output and contains bundled code

console.log('This is a Next.js build chunk');

// Original source files would show actual code here
// Build artifacts like this contain minified/compiled code`;
          } else {
            content = `# File: ${name}
# Path: ${filePath}

# This file could not be processed for display
# Error: ${mockError instanceof Error ? mockError.message : 'Unknown error'}`;
          }
        }
      }

      // Determine language from file extension
      const extension = selectedNode.properties.extension as string || '';
      let language = selectedNode.properties.language as string;
      
      if (!language) {
        if (extension === '.js' || extension === '.jsx') {
          language = 'javascript';
        } else if (extension === '.ts' || extension === '.tsx') {
          language = 'typescript';
        } else if (extension === '.py') {
          language = 'python';
        } else if (extension === '.sol') {
          language = 'solidity';
        } else {
          language = 'text';
        }
      }

      return {
        fileName,
        filePath,
        content,
        language,
        nodeType: selectedNode.label,
        nodeName: selectedNode.properties.name as string || selectedNode.id
      };
    } catch (error) {
      console.error('Error generating source info:', error);
      
      // Safe JSON stringify that handles circular references
      const safeStringify = (obj: unknown) => {
        try {
          return JSON.stringify(obj, null, 2);
        } catch {
          // Handle circular references and non-serializable values
          const seen = new WeakSet();
          return JSON.stringify(obj, (key, val) => {
            if (val != null && typeof val === "object") {
              if (seen.has(val)) {
                return "[Circular Reference]";
              }
              seen.add(val);
            }
            // Handle functions and other non-serializable types
            if (typeof val === 'function') {
              return "[Function]";
            }
            if (val instanceof Date) {
              return val.toISOString();
            }
            if (val instanceof RegExp) {
              return val.toString();
            }
            return val;
          }, 2);
        }
      };

      return {
        fileName: 'error.txt',
        filePath: '/error',
        content: `Error loading source for node: ${selectedNode.id}\n\nNode properties: ${safeStringify(selectedNode.properties)}`,
        language: 'text',
        nodeType: selectedNode.label,
        nodeName: selectedNode.properties.name as string || selectedNode.id
      };
    }
  }, [selectedNodeId, graph, fileContents]);

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

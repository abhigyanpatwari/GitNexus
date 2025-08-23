import React, { useState, useRef, useEffect, useCallback, useMemo } from 'react';
import type { KnowledgeGraph, GraphNode } from '../../../core/graph/types.ts';

interface FloatingSourceViewerProps {
  isOpen: boolean;
  position: { x: number; y: number };
  nodeId: string | null;
  graph: KnowledgeGraph;
  fileContents: Map<string, string>;
  onClose: () => void;
  onPin: (pinned: boolean) => void;
  isPinned: boolean;
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

const FloatingSourceViewer: React.FC<FloatingSourceViewerProps> = ({
  isOpen,
  position,
  nodeId,
  graph,
  fileContents,
  onClose,
  onPin,
  isPinned
}) => {
  const [isDragging, setIsDragging] = useState(false);
  const [dragOffset, setDragOffset] = useState({ x: 0, y: 0 });
  const [currentPosition, setCurrentPosition] = useState(position);
  const containerRef = useRef<HTMLDivElement>(null);
  const headerRef = useRef<HTMLDivElement>(null);

  // Warm tone colors to match the theme
  const colors = {
    background: '#FEF9F0',
    surface: '#FFFFFF',
    text: '#451A03',
    textSecondary: '#78350F',
    textMuted: '#A16207',
    border: '#FED7AA',
    borderLight: '#FEF3C7',
    primary: '#D97706',
    codeBackground: '#FDF6E3',
    lineNumbers: '#92400E',
    shadow: 'rgba(0, 0, 0, 0.1)',
    backdrop: 'rgba(0, 0, 0, 0.3)'
  };

  // Update position when prop changes
  useEffect(() => {
    if (!isDragging) {
      setCurrentPosition(position);
    }
  }, [position, isDragging]);

  // Extract relevant content from a file for a specific function/class/method
  const extractRelevantContent = (fileContent: string, targetName: string, nodeType: string): string | null => {
    const lines = fileContent.split('\n');
    
    try {
      if (nodeType === 'Function') {
        const patterns = [
          new RegExp(`^\\s*def\\s+${targetName}\\s*\\(`),
          new RegExp(`^\\s*function\\s+${targetName}\\s*\\(`),
          new RegExp(`^\\s*const\\s+${targetName}\\s*=`),
          new RegExp(`^\\s*let\\s+${targetName}\\s*=`),
          new RegExp(`^\\s*export\\s+function\\s+${targetName}\\s*\\(`),
          new RegExp(`^\\s*(public|private|protected)?\\s*\\w*\\s*${targetName}\\s*\\(`)
        ];
        
        for (let i = 0; i < lines.length; i++) {
          if (patterns.some(pattern => pattern.test(lines[i]))) {
            const startLine = Math.max(0, i - 2);
            let endLine = i + 1;
            
            let braceCount = 0;
            const indentLevel = lines[i].match(/^\s*/)?.[0].length || 0;
            
            for (let j = i + 1; j < lines.length; j++) {
              const line = lines[j];
              const currentIndent = line.match(/^\s*/)?.[0].length || 0;
              
              if (lines[i].includes('def ')) {
                if (line.trim() && currentIndent <= indentLevel && !line.startsWith(' ')) {
                  break;
                }
                endLine = j;
              } else {
                braceCount += (line.match(/\{/g) || []).length;
                braceCount -= (line.match(/\}/g) || []).length;
                endLine = j;
                if (braceCount === 0 && j > i) {
                  break;
                }
              }
              
              if (j - i > 100) break;
            }
            
            return lines.slice(startLine, endLine + 3).join('\n');
          }
        }
      }
      
      if (nodeType === 'Class') {
        const patterns = [
          new RegExp(`^\\s*class\\s+${targetName}\\s*`),
          new RegExp(`^\\s*export\\s+class\\s+${targetName}\\s*`),
          new RegExp(`^\\s*public\\s+class\\s+${targetName}\\s*`)
        ];
        
        for (let i = 0; i < lines.length; i++) {
          if (patterns.some(pattern => pattern.test(lines[i]))) {
            const startLine = Math.max(0, i - 2);
            let endLine = i + 1;
            let braceCount = 0;
            
            for (let j = i + 1; j < lines.length; j++) {
              const line = lines[j];
              braceCount += (line.match(/\{/g) || []).length;
              braceCount -= (line.match(/\}/g) || []).length;
              endLine = j;
              if (braceCount === 0 && j > i) {
                break;
              }
              if (j - i > 200) break;
            }
            
            return lines.slice(startLine, endLine + 3).join('\n');
          }
        }
      }
      
      if (nodeType === 'Method') {
        const patterns = [
          new RegExp(`^\\s*def\\s+${targetName}\\s*\\(`),
          new RegExp(`^\\s*${targetName}\\s*\\(`),
          new RegExp(`^\\s*(public|private|protected)?\\s*\\w*\\s*${targetName}\\s*\\(`)
        ];
        
        for (let i = 0; i < lines.length; i++) {
          if (patterns.some(pattern => pattern.test(lines[i]))) {
            const startLine = Math.max(0, i - 2);
            let endLine = i + 1;
            let braceCount = 0;
            const indentLevel = lines[i].match(/^\s*/)?.[0].length || 0;
            
            for (let j = i + 1; j < lines.length; j++) {
              const line = lines[j];
              const currentIndent = line.match(/^\s*/)?.[0].length || 0;
              
              if (lines[i].includes('def ')) {
                if (line.trim() && currentIndent <= indentLevel && !line.startsWith(' ')) {
                  break;
                }
                endLine = j;
              } else {
                braceCount += (line.match(/\{/g) || []).length;
                braceCount -= (line.match(/\}/g) || []).length;
                endLine = j;
                if (braceCount === 0 && j > i) {
                  break;
                }
              }
              
              if (j - i > 100) break;
            }
            
            return lines.slice(startLine, endLine + 3).join('\n');
          }
        }
      }
      
      // For other types, try to find the name in the file
      const namePattern = new RegExp(`\\b${targetName}\\b`, 'i');
      for (let i = 0; i < lines.length; i++) {
        if (namePattern.test(lines[i])) {
          const startLine = Math.max(0, i - 5);
          const endLine = Math.min(lines.length - 1, i + 10);
          return lines.slice(startLine, endLine + 1).join('\n');
        }
      }
      
    } catch (error) {
      console.error('Error extracting content:', error);
    }
    
    return null;
  };

  // Helper function to determine if a file should be skipped during search
  const shouldSkipFileForSearch = (filePath: string): boolean => {
    const pathLower = filePath.toLowerCase();
    
    // Skip .git files and directories
    if (pathLower.includes('/.git/') || pathLower.startsWith('.git/')) {
      return true;
    }
    
    // Skip other unwanted directories
    const skipPatterns = [
      'node_modules/',
      '__pycache__/',
      '.venv/',
      'venv/',
      'env/',
      'build/',
      'dist/',
      'coverage/',
      '.cache/',
      '.tmp/',
      'tmp/',
      'logs/',
      '.vs/',
      '.vscode/',
      '.idea/'
    ];
    
    return skipPatterns.some(pattern => pathLower.includes(pattern));
  };

  // Get source information for the selected node
  const sourceInfo = useMemo((): SourceInfo | null => {
    if (!nodeId || !graph) return null;

    const node = graph.nodes.find(n => n.id === nodeId);
    if (!node) return null;

    const nodeName = (node.properties.name || node.properties.functionName || node.properties.className || '') as string;
    const nodeType = node.label;

    // Try to find the file through CONTAINS relationships
    let filePath: string | null = null;
    const containsRel = graph.relationships.find(rel => 
      rel.type === 'CONTAINS' && rel.target === nodeId
    );
    
    if (containsRel) {
      const sourceNode = graph.nodes.find(n => n.id === containsRel.source);
      if (sourceNode && sourceNode.properties.filePath) {
        filePath = sourceNode.properties.filePath as string;
      }
    }

    // If not found through relationships, search through file contents
    if (!filePath && fileContents) {
      for (const [path, content] of fileContents) {
        // Skip .git files, node_modules, and other unwanted directories
        if (shouldSkipFileForSearch(path)) {
          continue;
        }
        
        if (content.includes(nodeName)) {
          filePath = path;
          break;
        }
      }
    }

    if (!filePath) {
      // Return mock content for nodes without file association
      const mockContent = `// ${nodeType}: ${nodeName}
// This ${nodeType.toLowerCase()} is part of the knowledge graph
// File path not available in the current context

${nodeType === 'Function' ? `function ${nodeName}() {
  // Implementation details would be here
  return true;
}` : nodeType === 'Class' ? `class ${nodeName} {
  constructor() {
    // Constructor implementation
  }
  
  // Class methods would be here
}` : `// ${nodeType} definition for ${nodeName}`}`;

      return {
        fileName: `${nodeName}.${nodeType.toLowerCase()}`,
        filePath: 'graph-node',
        content: mockContent,
        nodeType,
        nodeName,
        language: 'javascript'
      };
    }

    const content = fileContents.get(filePath);
    if (!content) return null;

    const extractedContent = extractRelevantContent(content, nodeName, nodeType);
    const language = filePath.split('.').pop() || 'text';

    return {
      fileName: filePath.split('/').pop() || filePath,
      filePath,
      content: extractedContent || content.substring(0, 500) + '...',
      nodeType,
      nodeName,
      language
    };
  }, [nodeId, graph, fileContents]);

  // Dragging functionality
  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    if (e.target !== headerRef.current && !headerRef.current?.contains(e.target as Node)) {
      return;
    }
    
    setIsDragging(true);
    const rect = containerRef.current?.getBoundingClientRect();
    if (rect) {
      setDragOffset({
        x: e.clientX - rect.left,
        y: e.clientY - rect.top
      });
    }
  }, []);

  const handleMouseMove = useCallback((e: MouseEvent) => {
    if (!isDragging) return;
    
    const newX = e.clientX - dragOffset.x;
    const newY = e.clientY - dragOffset.y;
    
    // Keep within viewport bounds
    const maxX = window.innerWidth - 500;
    const maxY = window.innerHeight - 400;
    
    setCurrentPosition({
      x: Math.max(0, Math.min(newX, maxX)),
      y: Math.max(0, Math.min(newY, maxY))
    });
  }, [isDragging, dragOffset]);

  const handleMouseUp = useCallback(() => {
    setIsDragging(false);
  }, []);

  useEffect(() => {
    if (isDragging) {
      document.addEventListener('mousemove', handleMouseMove);
      document.addEventListener('mouseup', handleMouseUp);
      return () => {
        document.removeEventListener('mousemove', handleMouseMove);
        document.removeEventListener('mouseup', handleMouseUp);
      };
    }
  }, [isDragging, handleMouseMove, handleMouseUp]);

  // Click outside to close (unless pinned)
  const handleBackdropClick = useCallback((e: React.MouseEvent) => {
    if (e.target === e.currentTarget && !isPinned) {
      onClose();
    }
  }, [isPinned, onClose]);

  if (!isOpen || !sourceInfo) return null;

  return (
    <>
      {/* Backdrop */}
      <div
        style={{
          position: 'fixed',
          top: 0,
          left: 0,
          right: 0,
          bottom: 0,
          backgroundColor: colors.backdrop,
          zIndex: 1000,
          animation: 'fadeIn 0.2s ease-out'
        }}
        onClick={handleBackdropClick}
      />
      
      {/* Floating Window */}
      <div
        ref={containerRef}
        style={{
          position: 'fixed',
          left: currentPosition.x,
          top: currentPosition.y,
          width: '500px',
          height: '400px',
          backgroundColor: colors.surface,
          borderRadius: '12px',
          boxShadow: `0 8px 32px ${colors.shadow}`,
          border: `1px solid ${colors.border}`,
          zIndex: 1001,
          display: 'flex',
          flexDirection: 'column',
          overflow: 'hidden',
          animation: 'slideIn 0.3s ease-out'
        }}
      >
        {/* Header */}
        <div
          ref={headerRef}
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            padding: '12px 16px',
            backgroundColor: colors.background,
            borderBottom: `1px solid ${colors.borderLight}`,
            cursor: 'move',
            userSelect: 'none'
          }}
          onMouseDown={handleMouseDown}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <span style={{ fontSize: '16px' }}>🔍</span>
            <span style={{ 
              fontSize: '14px', 
              fontWeight: '600', 
              color: colors.text 
            }}>
              Source Viewer
            </span>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <button
              onClick={() => onPin(!isPinned)}
              style={{
                background: 'none',
                border: 'none',
                cursor: 'pointer',
                padding: '4px',
                borderRadius: '4px',
                color: isPinned ? colors.primary : colors.textMuted,
                fontSize: '14px',
                transition: 'all 0.2s ease'
              }}
              title={isPinned ? 'Unpin' : 'Pin'}
            >
              📌
            </button>
            <button
              onClick={onClose}
              style={{
                background: 'none',
                border: 'none',
                cursor: 'pointer',
                padding: '4px',
                borderRadius: '4px',
                color: colors.textMuted,
                fontSize: '16px',
                fontWeight: 'bold',
                transition: 'all 0.2s ease'
              }}
              title="Close"
            >
              ×
            </button>
          </div>
        </div>

        {/* File Path Bar */}
        <div style={{
          padding: '8px 16px',
          backgroundColor: colors.codeBackground,
          borderBottom: `1px solid ${colors.borderLight}`,
          fontSize: '12px',
          color: colors.textSecondary,
          fontFamily: 'monospace',
          whiteSpace: 'nowrap',
          overflow: 'hidden',
          textOverflow: 'ellipsis'
        }}>
          📁 {sourceInfo.filePath}
        </div>

        {/* Content Area */}
        <div style={{
          flex: 1,
          overflow: 'auto',
          backgroundColor: colors.codeBackground,
          position: 'relative'
        }}>
          <pre style={{
            margin: 0,
            padding: '16px',
            fontSize: '13px',
            lineHeight: '1.5',
            color: colors.text,
            fontFamily: 'monospace',
            whiteSpace: 'pre-wrap',
            wordBreak: 'break-word'
          }}>
            {sourceInfo.content}
          </pre>
        </div>
      </div>

      <style>{`
        @keyframes fadeIn {
          from { opacity: 0; }
          to { opacity: 1; }
        }
        
        @keyframes slideIn {
          from { 
            opacity: 0;
            transform: scale(0.9) translateY(-10px);
          }
          to { 
            opacity: 1;
            transform: scale(1) translateY(0);
          }
        }
      `}</style>
    </>
  );
};

export default FloatingSourceViewer;

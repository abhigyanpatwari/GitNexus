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
  // Warm tone colors to match the new theme
  const colors = {
    background: '#FEF9F0', // Slightly warm white
    surface: '#FFFFFF',
    text: '#451A03', // Dark brown
    textSecondary: '#78350F', // Medium brown
    textMuted: '#A16207', // Light brown
    border: '#FED7AA', // Light orange
    borderLight: '#FEF3C7', // Very light orange
    primary: '#D97706', // Warm orange
    codeBackground: '#FDF6E3', // Warm cream for code
    lineNumbers: '#92400E' // Dark orange for line numbers
  };

  // Extract relevant content from a file for a specific function/class/method
  const extractRelevantContent = (fileContent: string, targetName: string, nodeType: string): string | null => {
    const lines = fileContent.split('\n');
    
    try {
      if (nodeType === 'Function') {
        // Look for function definition patterns
        const patterns = [
          new RegExp(`^\\s*def\\s+${targetName}\\s*\\(`),     // Python
          new RegExp(`^\\s*function\\s+${targetName}\\s*\\(`), // JavaScript
          new RegExp(`^\\s*const\\s+${targetName}\\s*=`),     // JavaScript const
          new RegExp(`^\\s*let\\s+${targetName}\\s*=`),       // JavaScript let
          new RegExp(`^\\s*export\\s+function\\s+${targetName}\\s*\\(`), // ES6 export
          new RegExp(`^\\s*(public|private|protected)?\\s*\\w*\\s*${targetName}\\s*\\(`) // Java/C#
        ];
        
        for (let i = 0; i < lines.length; i++) {
          if (patterns.some(pattern => pattern.test(lines[i]))) {
            // Found the function, now extract it with context
            const startLine = Math.max(0, i - 2); // Include 2 lines before for context
            let endLine = i + 1;
            
            // Find the end of the function (simple heuristic)
            let braceCount = 0;
            const indentLevel = lines[i].match(/^\s*/)?.[0].length || 0;
            
            for (let j = i + 1; j < lines.length; j++) {
              const line = lines[j];
              const currentIndent = line.match(/^\s*/)?.[0].length || 0;
              
              // For Python, use indentation
              if (lines[i].includes('def ')) {
                if (line.trim() && currentIndent <= indentLevel && !line.startsWith(' ')) {
                  break;
                }
                endLine = j;
              } 
              // For JavaScript/Java, use braces
              else {
                braceCount += (line.match(/\{/g) || []).length;
                braceCount -= (line.match(/\}/g) || []).length;
                endLine = j;
                if (braceCount === 0 && j > i) {
                  break;
                }
              }
              
              // Safety limit
              if (j - i > 100) break;
            }
            
            return lines.slice(startLine, endLine + 3).join('\n'); // Include 3 lines after
          }
        }
      }
      
      if (nodeType === 'Class') {
        const patterns = [
          new RegExp(`^\\s*class\\s+${targetName}\\b`),
          new RegExp(`^\\s*(public|private)?\\s*class\\s+${targetName}\\b`)
        ];
        
        for (let i = 0; i < lines.length; i++) {
          if (patterns.some(pattern => pattern.test(lines[i]))) {
            const startLine = Math.max(0, i - 2);
            const endLine = i + 20; // Show first 20 lines of class
            
            return lines.slice(startLine, Math.min(endLine, lines.length)).join('\n');
          }
        }
      }
      
      // If we can't extract specifically, return null to use full file
      return null;
    } catch (error) {
      console.warn('Error extracting content:', error);
      return null;
    }
  };

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
        # Constructor
        pass`;

        case 'Variable':
          return `# Variable: ${name}
${name} = None  # Initialize variable`;

        case 'File': {
          const path = node.properties.path as string || name;
          const extension = path.split('.').pop()?.toLowerCase() || 'txt';
          
          switch (extension) {
            case 'py':
              return `# File: ${path}
"""
Python module: ${name}
"""

def main():
    print("Hello from ${name}")

if __name__ == "__main__":
    main()`;
            
            case 'js':
            case 'ts':
              return `// File: ${path}
/**
 * JavaScript/TypeScript module: ${name}
 */

function main() {
    console.log("Hello from ${name}");
}

export default main;`;
            
            case 'java':
              return `// File: ${path}
/**
 * Java class: ${name}
 */
public class ${name.replace(/\.[^/.]+$/, "")} {
    public static void main(String[] args) {
        System.out.println("Hello from ${name}");
    }
}`;
            
            default:
              return `// File: ${path}
// Content of ${name}`;
          }
        }

        case 'Folder':
          return `# Directory: ${name}
# This is a folder containing other files and directories`;

        case 'Project':
          return `# Project: ${name}
# Root directory of the project`;

        default:
          return `# ${node.label}: ${name}
# No specific content available`;
      }
    } catch (error) {
      return `# Error generating content for ${node.label}
# ${error instanceof Error ? error.message : 'Unknown error'}`;
    }
  };

  // Generate content for built-in functions
  const generateBuiltinFunctionContent = (functionName: string): string => {
    switch (functionName) {
      case 'round':
        return `# Built-in Function: ${functionName}
"""
Rounds a number to the nearest integer.
"""

def round(number: float, ndigits: int = 0) -> float:
    """
    Rounds a number to the nearest integer.
    Args:
        number (float): The number to round.
        ndigits (int, optional): The number of decimal places to round to. Defaults to 0.
    Returns:
        float: The rounded number.
    """
    # Implementation here
    pass`;
      case 'len':
        return `# Built-in Function: ${functionName}
"""
Returns the number of items in an object.
"""

def len(obj: Any) -> int:
    """
    Returns the number of items in an object.
    Args:
        obj (Any): The object to get the length of.
    Returns:
        int: The number of items.
    """
    # Implementation here
    pass`;
      case 'print':
        return `# Built-in Function: ${functionName}
"""
Prints the given arguments to the standard output.
"""

def print(*args, sep: str = " ", end: str = "\\n") -> None:
    """
    Prints the given arguments to the standard output.
    Args:
        *args: The arguments to print.
        sep (str, optional): The separator between arguments. Defaults to " ".
        end (str, optional): The string to print at the end. Defaults to "\\n".
    """
    # Implementation here
    pass`;
      case 'input':
        return `# Built-in Function: ${functionName}
"""
Reads a line from the standard input.
"""

def input(prompt: str = "") -> str:
    """
    Reads a line from the standard input.
    Args:
        prompt (str, optional): The prompt to display. Defaults to "".
    Returns:
        str: The input string.
    """
    # Implementation here
    pass`;
      case 'open':
        return `# Built-in Function: ${functionName}
"""
Opens a file and returns a file object.
"""

def open(file: str, mode: str = "r", buffering: int = -1, encoding: str | None = None, errors: str | None = None, newline: str | None = None) -> Any:
    """
    Opens a file and returns a file object.
    Args:
        file (str): The path to the file.
        mode (str, optional): The mode in which the file is opened. Defaults to "r".
        buffering (int, optional): The buffering strategy. Defaults to -1.
        encoding (str | None, optional): The encoding to use. Defaults to None.
        errors (str | None, optional): How to handle encoding errors. Defaults to None.
        newline (str | None, optional): How to handle newlines. Defaults to None.
    Returns:
        Any: The file object.
    """
    # Implementation here
    pass`;
      case 'type':
        return `# Built-in Function: ${functionName}
"""
Returns the type of an object.
"""

def type(obj: Any) -> type:
    """
    Returns the type of an object.
    Args:
        obj (Any): The object to get the type of.
    Returns:
        type: The type of the object.
    """
    # Implementation here
    pass`;
      case 'isinstance':
        return `# Built-in Function: ${functionName}
"""
Checks if an object is an instance of a class or a tuple of classes.
"""

def isinstance(obj: Any, classinfo: type | tuple[type, ...]) -> bool:
    """
    Checks if an object is an instance of a class or a tuple of classes.
    Args:
        obj (Any): The object to check.
        classinfo (type | tuple[type, ...]): The class or tuple of classes to check against.
    Returns:
        bool: True if the object is an instance of the class or one of the classes in the tuple.
    """
    # Implementation here
    pass`;
      case 'hasattr':
        return `# Built-in Function: ${functionName}
"""
Checks if an object has an attribute.
"""

def hasattr(obj: Any, name: str) -> bool:
    """
    Checks if an object has an attribute.
    Args:
        obj (Any): The object to check.
        name (str): The name of the attribute to check for.
    Returns:
        bool: True if the object has the attribute, False otherwise.
    """
    # Implementation here
    pass`;
      default:
        return `# Built-in Function: ${functionName}
# No specific content available`;
    }
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

  // Get source info for selected node
  const sourceInfo = useMemo((): SourceInfo | null => {
    if (!selectedNodeId || !graph?.nodes) return null;

    const node = graph.nodes.find(n => n.id === selectedNodeId);
    if (!node) return null;

    const nodeName = node.properties.name as string || node.id;
    
    // First, try to get the file path from the node's properties
    let filePath = node.properties.path as string || node.properties.filePath as string;
    
    // If the node doesn't have a direct file path, find it through graph relationships
    if (!filePath || filePath === nodeName) {
      console.log('SourceViewer - Finding file through graph relationships for:', nodeName);
      
      // Find the file that CONTAINS this node
      const containsRelationship = graph.relationships?.find(rel => 
        rel.type === 'CONTAINS' && rel.target === selectedNodeId
      );
      
      if (containsRelationship) {
        const fileNode = graph.nodes.find(n => n.id === containsRelationship.source);
        if (fileNode && fileNode.label === 'File') {
          filePath = fileNode.properties.path as string || fileNode.properties.filePath as string;
          console.log('SourceViewer - Found file through CONTAINS relationship:', filePath);
        }
      }
      
      // If still no file path, try reverse lookup by searching for the node name in file contents
      if (!filePath && fileContents) {
        console.log('SourceViewer - Searching file contents for node:', nodeName);
        
        // Try multiple search patterns for the function
        const searchPatterns = [
          `def ${nodeName}(`,           // Python function
          `def ${nodeName} (`,          // Python function with space
          `function ${nodeName}(`,      // JavaScript function
          `function ${nodeName} (`,     // JavaScript function with space
          `const ${nodeName} =`,        // JavaScript const
          `let ${nodeName} =`,          // JavaScript let
          `var ${nodeName} =`,          // JavaScript var
          `class ${nodeName}`,          // Class definition
          `${nodeName}:`,               // Object property or TypeScript type
          `export const ${nodeName}`,   // ES6 export
          `export function ${nodeName}`, // ES6 export function
          `public ${nodeName}(`,        // Java/C# method
          `private ${nodeName}(`,       // Java/C# method
          `protected ${nodeName}(`,     // Java/C# method
          // Also try with underscores and variations
          `def ${nodeName}_`,           // Python with underscore
          `function ${nodeName}_`,      // JavaScript with underscore
        ];
        
        for (const [path, content] of fileContents) {
          // Skip .git files, node_modules, and other unwanted directories
          if (shouldSkipFileForSearch(path)) {
            continue;
          }
          
          console.log(`SourceViewer - Checking file: ${path}`);
          
          // Check if any pattern matches
          const foundPattern = searchPatterns.find(pattern => {
            const found = content.includes(pattern);
            if (found) {
              console.log(`SourceViewer - Found pattern "${pattern}" in ${path}`);
            }
            return found;
          });
          
          if (foundPattern) {
            filePath = path;
            console.log('SourceViewer - Found file through content search:', filePath);
            break;
          }
        }
        
        // If still not found, try a more lenient search (case-insensitive)
        if (!filePath) {
          console.log('SourceViewer - Trying case-insensitive search for:', nodeName);
          for (const [path, content] of fileContents) {
            // Skip .git files, node_modules, and other unwanted directories
            if (shouldSkipFileForSearch(path)) {
              continue;
            }
            
            const lowerContent = content.toLowerCase();
            const lowerNodeName = nodeName.toLowerCase();
            
            if (lowerContent.includes(`def ${lowerNodeName}(`) || 
                lowerContent.includes(`function ${lowerNodeName}(`) ||
                lowerContent.includes(`const ${lowerNodeName} =`) ||
                lowerContent.includes(`class ${lowerNodeName}`)) {
              filePath = path;
              console.log('SourceViewer - Found file through case-insensitive search:', filePath);
              break;
            }
          }
        }
      }
    }

    const fileName = filePath ? filePath.split('/').pop() || filePath : nodeName;

    console.log('SourceViewer - Final node details:', {
      nodeId: selectedNodeId,
      nodeName,
      filePath,
      fileName,
      nodeLabel: node.label,
      nodeProperties: node.properties,
      fileContentsSize: fileContents?.size || 0,
      // Add detailed relationship debugging
      allRelationships: graph?.relationships?.length || 0,
      containsRelationships: graph?.relationships?.filter(rel => rel.type === 'CONTAINS').length || 0,
      relationshipsForThisNode: graph?.relationships?.filter(rel => rel.target === selectedNodeId || rel.source === selectedNodeId) || [],
      fileNodesInGraph: graph?.nodes?.filter(n => n.label === 'File').map(n => ({
        id: n.id,
        path: n.properties.path,
        filePath: n.properties.filePath,
        name: n.properties.name
      })) || [],
      availableFileContents: fileContents ? Array.from(fileContents.entries()).map(([path, content]) => ({
        path,
        size: content.length,
        firstLines: content.split('\n').slice(0, 3).join('\\n'),
        containsSub: content.includes('def sub(') || content.includes('function sub(')
      })) : []
    });

    // Try to get actual file content
    let content = '';
    
    if (filePath && fileContents && fileContents.has(filePath)) {
      content = fileContents.get(filePath)!;
      console.log('SourceViewer - Found file content for:', filePath);
      
      // For function/method/class nodes, try to extract just the relevant part
      if (node.label === 'Function' || node.label === 'Method' || node.label === 'Class') {
        const extractedContent = extractRelevantContent(content, nodeName, node.label);
        if (extractedContent) {
          content = extractedContent;
          console.log('SourceViewer - Extracted relevant content for:', nodeName);
        }
      }
    } else {
      console.log('SourceViewer - No file content found, checking if this is a built-in function');
      
      // Check if this is a built-in function
      if (node.id.includes('builtin_') || nodeName === 'round' || nodeName === 'len' || nodeName === 'print' || 
          ['round', 'len', 'str', 'int', 'float', 'bool', 'list', 'dict', 'tuple', 'set',
           'range', 'enumerate', 'zip', 'map', 'filter', 'sum', 'max', 'min', 'abs',
           'print', 'input', 'open', 'type', 'isinstance', 'hasattr'].includes(nodeName)) {
        
        content = generateBuiltinFunctionContent(nodeName);
        console.log('SourceViewer - Using built-in function content for:', nodeName);
      } else {
        console.log('SourceViewer - Using mock content for user-defined node:', nodeName);
        content = generateMockContent(node);
      }
    }

    // Detect language from file extension
    const extension = fileName.split('.').pop()?.toLowerCase();
    let language = 'text';
    switch (extension) {
      case 'js':
      case 'jsx':
        language = 'javascript';
        break;
      case 'ts':
      case 'tsx':
        language = 'typescript';
        break;
      case 'py':
        language = 'python';
        break;
      case 'java':
        language = 'java';
        break;
      case 'cpp':
      case 'cc':
      case 'cxx':
        language = 'cpp';
        break;
      case 'c':
        language = 'c';
        break;
      case 'cs':
        language = 'csharp';
        break;
      case 'php':
        language = 'php';
        break;
      case 'rb':
        language = 'ruby';
        break;
      case 'go':
        language = 'go';
        break;
      case 'rs':
        language = 'rust';
        break;
      case 'swift':
        language = 'swift';
        break;
      case 'kt':
        language = 'kotlin';
        break;
      case 'scala':
        language = 'scala';
        break;
      case 'html':
        language = 'html';
        break;
      case 'css':
        language = 'css';
        break;
      case 'scss':
        language = 'scss';
        break;
      case 'json':
        language = 'json';
        break;
      case 'xml':
        language = 'xml';
        break;
      case 'yaml':
      case 'yml':
        language = 'yaml';
        break;
      case 'md':
        language = 'markdown';
        break;
      case 'sh':
        language = 'bash';
        break;
      case 'sql':
        language = 'sql';
        break;
    }

    return {
      fileName,
      filePath: filePath || nodeName,
      content,
      nodeType: node.label,
      nodeName,
      language,
      startLine: node.properties.startLine as number,
      endLine: node.properties.endLine as number
    };
  }, [selectedNodeId, graph?.nodes, graph?.relationships, fileContents]);

  const containerStyle: React.CSSProperties = {
    display: 'flex',
    flexDirection: 'column',
    height: '100%',
    width: '100%',
    backgroundColor: colors.background,
    overflow: 'hidden',
    ...style
  };

  const headerStyle: React.CSSProperties = {
    padding: '16px 20px',
    backgroundColor: colors.surface,
    borderBottom: `1px solid ${colors.borderLight}`,
    flexShrink: 0
  };

  const titleStyle: React.CSSProperties = {
    fontSize: '16px',
    fontWeight: '600',
    color: colors.text,
    marginBottom: '8px',
    display: 'flex',
    alignItems: 'center',
    gap: '8px'
  };

  const infoStyle: React.CSSProperties = {
    fontSize: '12px',
    color: colors.textMuted,
    display: 'flex',
    alignItems: 'center',
    gap: '16px',
    flexWrap: 'wrap'
  };

  const codeContainerStyle: React.CSSProperties = {
    flex: 1,
    overflow: 'auto',
    backgroundColor: colors.codeBackground,
    position: 'relative'
  };

  const codeStyle: React.CSSProperties = {
    fontFamily: "'Fira Code', 'Monaco', 'Menlo', 'Ubuntu Mono', monospace",
    fontSize: '13px',
    lineHeight: '1.5',
    padding: '16px',
    margin: 0,
    backgroundColor: 'transparent',
    color: colors.text,
    whiteSpace: 'pre-wrap',
    wordBreak: 'break-word',
    border: 'none',
    outline: 'none',
    resize: 'none',
    width: '100%',
    minHeight: '100%',
    boxSizing: 'border-box'
  };

  const emptyStateStyle: React.CSSProperties = {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    flexDirection: 'column',
    height: '100%',
    color: colors.textMuted,
    fontSize: '14px',
    gap: '12px',
    padding: '32px'
  };

  const renderEmptyState = () => (
    <div style={emptyStateStyle}>
      <div style={{ fontSize: '48px', opacity: 0.3 }}>📝</div>
      <div style={{ textAlign: 'center' }}>
        Select a node in the graph to view its source code
      </div>
    </div>
  );

  const renderSourceContent = (info: SourceInfo) => {
    const lines = info.content.split('\n');

    return (
      <>
        <div style={headerStyle}>
          <div style={titleStyle}>
            <span>📝</span>
            <span>{info.fileName}</span>
          </div>
          <div style={infoStyle}>
            <span>📄 {info.nodeType}</span>
            <span>🏷️ {info.nodeName}</span>
            {info.language && <span>💻 {info.language}</span>}
            <span>📏 {lines.length} lines</span>
          </div>
        </div>
        
        <div style={codeContainerStyle}>
          <pre style={codeStyle}>
            {info.content}
          </pre>
        </div>
      </>
    );
  };

  return (
    <div className={`source-viewer ${className}`} style={containerStyle}>
      {sourceInfo ? renderSourceContent(sourceInfo) : renderEmptyState()}
    </div>
  );
};

export default SourceViewer; 

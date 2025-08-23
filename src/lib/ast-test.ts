// Simple test to debug AST generation and structure
export async function testASTGeneration() {
  console.log('🧪 Testing AST Generation...');
  
  // Simple Python code for testing
  const testPythonCode = `
import os
import sys

def test_function():
    print("Hello, World!")
    return True

class TestClass:
    def __init__(self):
        self.value = 42
    
    def test_method(self):
        return self.value

if __name__ == "__main__":
    test_function()
`;
  
  console.log('📝 Test Python Code:');
  console.log(testPythonCode);
  
  // Create a mock AST structure similar to what tree-sitter would generate
  const mockAST = {
    tree: {
      type: "module",
      text: testPythonCode,
      startPosition: { row: 0, column: 0 },
      endPosition: { row: 15, column: 0 },
      childCount: 3,
      children: [
        {
          type: "import_statement",
          text: "import os",
          startPosition: { row: 1, column: 0 },
          endPosition: { row: 1, column: 8 },
          childCount: 1,
          children: [
            {
              type: "dotted_name",
              text: "os",
              startPosition: { row: 1, column: 7 },
              endPosition: { row: 1, column: 8 },
              childCount: 0,
              children: []
            }
          ]
        },
        {
          type: "function_definition",
          text: "def test_function():\n    print(\"Hello, World!\")\n    return True",
          startPosition: { row: 3, column: 0 },
          endPosition: { row: 6, column: 0 },
          childCount: 2,
          children: [
            {
              type: "identifier",
              text: "test_function",
              startPosition: { row: 3, column: 4 },
              endPosition: { row: 3, column: 16 },
              childCount: 0,
              children: []
            },
            {
              type: "block",
              text: "\n    print(\"Hello, World!\")\n    return True",
              startPosition: { row: 3, column: 18 },
              endPosition: { row: 6, column: 0 },
              childCount: 2,
              children: [
                {
                  type: "call",
                  text: "print(\"Hello, World!\")",
                  startPosition: { row: 4, column: 4 },
                  endPosition: { row: 4, column: 25 },
                  childCount: 1,
                  children: [
                    {
                      type: "identifier",
                      text: "print",
                      startPosition: { row: 4, column: 4 },
                      endPosition: { row: 4, column: 9 },
                      childCount: 0,
                      children: []
                    }
                  ]
                }
              ]
            }
          ]
        }
      ]
    }
  };
  
  console.log('🔍 Mock AST Structure:');
  console.log(JSON.stringify(mockAST, null, 2));
  
  // Test the AST check logic
  console.log('🧪 Testing AST Check Logic:');
  console.log('ast.tree exists:', !!mockAST.tree);
  console.log('ast.tree.type:', mockAST.tree?.type);
  console.log('ast.tree.childCount:', mockAST.tree?.childCount);
  console.log('ast.tree.rootNode exists:', !!mockAST.tree?.rootNode);
  
  // The issue might be that we're checking for rootNode but the tree itself is the root
  console.log('🔍 AST Check Result:', !mockAST.tree || !mockAST.tree.rootNode ? 'FAILED' : 'PASSED');
  
  return mockAST;
}

// Test function call extraction logic
export function testFunctionCallExtraction(ast: any) {
  console.log('🧪 Testing Function Call Extraction...');
  
  function extractCalls(node: any, calls: any[] = []): any[] {
    if (!node || !node.type) return calls;
    
    if (node.type === 'call') {
      console.log('📞 Found call node:', node);
      calls.push({
        type: 'call',
        functionName: node.children?.[0]?.text || 'unknown',
        startLine: node.startPosition.row + 1,
        endLine: node.endPosition.row + 1
      });
    }
    
    if (node.children) {
      for (const child of node.children) {
        extractCalls(child, calls);
      }
    }
    
    return calls;
  }
  
  const calls = extractCalls(ast.tree);
  console.log('📞 Extracted calls:', calls);
  
  return calls;
}


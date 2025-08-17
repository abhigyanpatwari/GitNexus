import { exportGraphToCSV } from './export.js';
import type { KnowledgeGraph } from '../core/graph/types.js';

// Mock knowledge graph for testing
const mockGraph: KnowledgeGraph = {
  nodes: [
    {
      id: 'func_123',
      label: 'Function',
      properties: {
        name: 'validateInput',
        filePath: 'src/utils/validation.ts',
        startLine: 15,
        endLine: 25,
        type: 'function',
        language: 'typescript',
        qualifiedName: 'utils.validation.validateInput'
      }
    },
    {
      id: 'class_456',
      label: 'Class',
      properties: {
        name: 'UserService',
        filePath: 'src/services/user.ts',
        startLine: 1,
        endLine: 50,
        type: 'class',
        language: 'typescript',
        qualifiedName: 'services.user.UserService'
      }
    }
  ],
  relationships: [
    {
      id: 'rel_789',
      type: 'CALLS',
      source: 'func_123',
      target: 'func_456',
      properties: {}
    },
    {
      id: 'rel_101',
      type: 'CONTAINS',
      source: 'class_456',
      target: 'func_123',
      properties: {}
    }
  ]
};

describe('CSV Export', () => {
  test('should generate valid CSV for nodes', () => {
    const csvData = exportGraphToCSV(mockGraph);
    
    expect(csvData.nodes).toContain(':ID,name,filePath,startLine,endLine,type,language,qualifiedName,:LABEL');
    expect(csvData.nodes).toContain('func_123,validateInput,src/utils/validation.ts,15,25,function,typescript,utils.validation.validateInput,Function');
    expect(csvData.nodes).toContain('class_456,UserService,src/services/user.ts,1,50,class,typescript,services.user.UserService,Class');
  });

  test('should generate valid CSV for relationships', () => {
    const csvData = exportGraphToCSV(mockGraph);
    
    expect(csvData.relationships).toContain(':START_ID,:TYPE,:END_ID,source,target');
    expect(csvData.relationships).toContain('func_123,CALLS,func_456,func_123,func_456');
    expect(csvData.relationships).toContain('class_456,CONTAINS,func_123,class_456,func_123');
  });

  test('should generate proper filename', () => {
    const csvData = exportGraphToCSV(mockGraph, { projectName: 'test-project' });
    
    expect(csvData.filename).toMatch(/gitnexus-test-project_\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}/);
  });

  test('should handle empty graph', () => {
    const emptyGraph: KnowledgeGraph = { nodes: [], relationships: [] };
    const csvData = exportGraphToCSV(emptyGraph);
    
    expect(csvData.nodes).toBe(':ID,name,filePath,startLine,endLine,type,language,qualifiedName,:LABEL\n');
    expect(csvData.relationships).toBe(':START_ID,:TYPE,:END_ID,source,target\n');
  });

  test('should escape CSV values with commas and quotes', () => {
    const graphWithSpecialChars: KnowledgeGraph = {
      nodes: [
        {
          id: 'func_123',
          label: 'Function',
          properties: {
            name: 'validateInput, "special" function',
            filePath: 'src/utils/validation.ts',
            startLine: 15,
            endLine: 25,
            type: 'function',
            language: 'typescript',
            qualifiedName: 'utils.validation.validateInput'
          }
        }
      ],
      relationships: []
    };
    
    const csvData = exportGraphToCSV(graphWithSpecialChars);
    
    // Should properly escape the name with quotes and double quotes
    expect(csvData.nodes).toContain('func_123,"validateInput, ""special"" function",src/utils/validation.ts,15,25,function,typescript,utils.validation.validateInput,Function');
  });
});

console.log('CSV Export tests completed successfully!');

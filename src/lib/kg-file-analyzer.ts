/**
 * Knowledge Graph File Analysis Utility
 * Helps identify if unnecessary files are being included in the KG
 */

import type { KnowledgeGraph } from '../core/graph/types';

export interface FileAnalysisResult {
  totalFiles: number;
  filesByType: Record<string, number>;
  suspiciousFiles: Array<{
    path: string;
    reason: string;
    hasDefinitions: boolean;
  }>;
  recommendations: string[];
}

export function analyzeKnowledgeGraphFiles(
  graph: KnowledgeGraph,
  fileContents?: Map<string, string>
): FileAnalysisResult {
  const fileNodes = graph.nodes.filter(node => node.label === 'File');
  const filesByType: Record<string, number> = {};
  const suspiciousFiles: Array<{ path: string; reason: string; hasDefinitions: boolean }> = [];
  const recommendations: string[] = [];

  // Analyze each file node
  fileNodes.forEach(fileNode => {
    const filePath = (fileNode.properties.filePath || fileNode.properties.path) as string;
    const fileName = filePath.split('/').pop()?.toLowerCase() || '';
    const extension = fileName.split('.').pop()?.toLowerCase() || 'no-extension';
    
    // Count by extension
    filesByType[`.${extension}`] = (filesByType[`.${extension}`] || 0) + 1;
    
    // Check if file has any definitions
    const hasDefinitions = graph.relationships.some(rel => 
      rel.source === fileNode.id && 
      rel.type === 'DEFINES' &&
      graph.nodes.some(targetNode => 
        targetNode.id === rel.target && 
        ['Function', 'Class', 'Method', 'Variable', 'Interface', 'Type'].includes(targetNode.label)
      )
    );

    // Check for suspicious files
    const suspiciousPatterns = [
      { pattern: fileName.includes('readme'), reason: 'Documentation file (README)' },
      { pattern: fileName.includes('license'), reason: 'License file' },
      { pattern: fileName.includes('changelog'), reason: 'Changelog file' },
      { pattern: fileName.includes('dockerfile'), reason: 'Docker configuration' },
      { pattern: fileName.includes('docker-compose'), reason: 'Docker Compose file' },
      { pattern: fileName.includes('.gitignore'), reason: 'Git ignore file' },
      { pattern: fileName.includes('.gitattributes'), reason: 'Git attributes file' },
      { pattern: fileName.endsWith('.md'), reason: 'Markdown documentation' },
      { pattern: fileName.endsWith('.txt'), reason: 'Text file' },
      { pattern: fileName.endsWith('.log'), reason: 'Log file' },
      { pattern: fileName.endsWith('.lock'), reason: 'Lock file' },
      { pattern: fileName.includes('package-lock'), reason: 'Package lock file' },
      { pattern: fileName.includes('yarn.lock'), reason: 'Yarn lock file' },
      { pattern: filePath.includes('/test/') || filePath.includes('/tests/'), reason: 'Test directory file' },
      { pattern: filePath.includes('/__tests__/'), reason: 'Jest test file' },
      { pattern: fileName.includes('.test.') || fileName.includes('.spec.'), reason: 'Test/spec file' },
      { pattern: fileName.includes('mock'), reason: 'Mock file' },
      { pattern: fileName.includes('fixture'), reason: 'Test fixture' },
      { pattern: !hasDefinitions && fileName.endsWith('.js'), reason: 'JavaScript file with no definitions' },
      { pattern: !hasDefinitions && fileName.endsWith('.ts'), reason: 'TypeScript file with no definitions' },
      { pattern: !hasDefinitions && fileName.endsWith('.py'), reason: 'Python file with no definitions' },
    ];

    for (const { pattern, reason } of suspiciousPatterns) {
      if (pattern) {
        suspiciousFiles.push({
          path: filePath,
          reason,
          hasDefinitions
        });
        break; // Only add one reason per file
      }
    }
  });

  // Generate recommendations
  const suspiciousCount = suspiciousFiles.length;
  const totalFiles = fileNodes.length;
  
  if (suspiciousCount > totalFiles * 0.2) {
    recommendations.push(`⚠️ ${suspiciousCount} out of ${totalFiles} files (${Math.round(suspiciousCount/totalFiles*100)}%) seem suspicious. Consider tightening file filtering.`);
  }

  const documentationFiles = suspiciousFiles.filter(f => 
    f.reason.includes('Documentation') || 
    f.reason.includes('Markdown') || 
    f.reason.includes('README') ||
    f.reason.includes('License')
  );
  
  if (documentationFiles.length > 0) {
    recommendations.push(`📚 ${documentationFiles.length} documentation files found. These typically don't contain code definitions and could be excluded.`);
  }

  const testFiles = suspiciousFiles.filter(f => 
    f.reason.includes('Test') || 
    f.reason.includes('Mock') || 
    f.reason.includes('fixture')
  );
  
  if (testFiles.length > 0) {
    recommendations.push(`🧪 ${testFiles.length} test-related files found. Consider if test files should be included in your knowledge graph.`);
  }

  const noDefinitionFiles = suspiciousFiles.filter(f => 
    !f.hasDefinitions && 
    (f.reason.includes('no definitions'))
  );
  
  if (noDefinitionFiles.length > 0) {
    recommendations.push(`📄 ${noDefinitionFiles.length} source files have no extracted definitions. These might be empty, have parsing issues, or contain only comments.`);
  }

  return {
    totalFiles,
    filesByType,
    suspiciousFiles,
    recommendations
  };
}

/**
 * Print a formatted analysis report to console
 */
export function printFileAnalysisReport(analysis: FileAnalysisResult): void {
  console.log('\n🔍 KNOWLEDGE GRAPH FILE ANALYSIS REPORT');
  console.log('=====================================');
  
  console.log(`\n📊 Overview:`);
  console.log(`Total files in KG: ${analysis.totalFiles}`);
  console.log(`Suspicious files: ${analysis.suspiciousFiles.length} (${Math.round(analysis.suspiciousFiles.length/analysis.totalFiles*100)}%)`);
  
  console.log(`\n📋 Files by type:`);
  Object.entries(analysis.filesByType)
    .sort(([,a], [,b]) => b - a)
    .forEach(([type, count]) => {
      console.log(`  ${type}: ${count} files`);
    });

  if (analysis.suspiciousFiles.length > 0) {
    console.log(`\n⚠️ Suspicious files (first 10):`);
    analysis.suspiciousFiles.slice(0, 10).forEach(file => {
      const fileName = file.path.split('/').pop();
      const definitionStatus = file.hasDefinitions ? '✅' : '❌';
      console.log(`  ${definitionStatus} ${fileName} - ${file.reason}`);
    });
    
    if (analysis.suspiciousFiles.length > 10) {
      console.log(`  ... and ${analysis.suspiciousFiles.length - 10} more`);
    }
  }

  if (analysis.recommendations.length > 0) {
    console.log(`\n💡 Recommendations:`);
    analysis.recommendations.forEach((rec, index) => {
      console.log(`  ${index + 1}. ${rec}`);
    });
  }

  console.log('\n=====================================\n');
}

// Make it available globally for browser console use
if (typeof window !== 'undefined') {
  (window as any).analyzeKGFiles = (graph: any, fileContents?: Map<string, string>) => {
    const analysis = analyzeKnowledgeGraphFiles(graph, fileContents);
    printFileAnalysisReport(analysis);
    return analysis;
  };
}
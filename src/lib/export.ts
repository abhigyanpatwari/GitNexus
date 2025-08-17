import type { KnowledgeGraph } from '../core/graph/types.ts';

export interface ExportOptions {
  filename?: string;
  includeMetadata?: boolean;
  prettyPrint?: boolean;
  includeTimestamp?: boolean;
}

export interface ExportMetadata {
  exportedAt: string;
  version: string;
  nodeCount: number;
  relationshipCount: number;
  fileCount?: number;
  processingDuration?: number;
}

export interface ExportedGraph {
  metadata: ExportMetadata;
  graph: KnowledgeGraph;
  fileContents?: Record<string, string>;
}

export interface CSVExportData {
  nodes: string;
  relationships: string;
  filename: string;
}

/**
 * Export a KnowledgeGraph to JSON format
 */
export function exportGraphToJSON(
  graph: KnowledgeGraph,
  options: ExportOptions = {},
  fileContents?: Map<string, string>,
  processingStats?: { duration: number }
): string {
  const {
    includeMetadata = true,
    prettyPrint = true,
    includeTimestamp = true
  } = options;

  let exportData: ExportedGraph | KnowledgeGraph;

  if (includeMetadata) {
    const metadata: ExportMetadata = {
      exportedAt: includeTimestamp ? new Date().toISOString() : '',
      version: '1.0.0',
      nodeCount: graph.nodes.length,
      relationshipCount: graph.relationships.length,
      fileCount: fileContents?.size,
      processingDuration: processingStats?.duration
    };

    exportData = {
      metadata,
      graph,
      ...(fileContents && { fileContents: Object.fromEntries(fileContents) })
    };
  } else {
    exportData = graph;
  }

  return JSON.stringify(exportData, null, prettyPrint ? 2 : 0);
}

/**
 * Export a KnowledgeGraph to CSV format
 */
export function exportGraphToCSV(
  graph: KnowledgeGraph,
  options: ExportOptions & { projectName?: string } = {}
): CSVExportData {
  const { projectName, includeTimestamp = true } = options;

  // Generate CSV content for nodes
  const nodesCSV = generateNodesCSV(graph.nodes);
  
  // Generate CSV content for relationships
  const relationshipsCSV = generateRelationshipsCSV(graph.relationships);
  
  // Generate filename
  const filename = generateCSVFilename(projectName, includeTimestamp);

  return {
    nodes: nodesCSV,
    relationships: relationshipsCSV,
    filename
  };
}

/**
 * Generate CSV content for nodes
 */
function generateNodesCSV(nodes: KnowledgeGraph['nodes']): string {
  if (nodes.length === 0) {
    return ':ID,name,filePath,startLine,endLine,type,language,qualifiedName,:LABEL\n';
  }

  const headers = ':ID,name,filePath,startLine,endLine,type,language,qualifiedName,:LABEL';
  const rows = nodes.map(node => {
    const properties = node.properties;
    const values = [
      escapeCSVValue(node.id),
      escapeCSVValue(properties.name || ''),
      escapeCSVValue(properties.filePath || ''),
      properties.startLine || '',
      properties.endLine || '',
      escapeCSVValue(properties.type || ''),
      escapeCSVValue(properties.language || ''),
      escapeCSVValue(properties.qualifiedName || ''),
      node.label
    ];
    return values.join(',');
  });

  return [headers, ...rows].join('\n');
}

/**
 * Generate CSV content for relationships
 */
function generateRelationshipsCSV(relationships: KnowledgeGraph['relationships']): string {
  if (relationships.length === 0) {
    return ':START_ID,:TYPE,:END_ID,source,target\n';
  }

  const headers = ':START_ID,:TYPE,:END_ID,source,target';
  const rows = relationships.map(rel => {
    const values = [
      escapeCSVValue(rel.source),
      rel.type,
      escapeCSVValue(rel.target),
      escapeCSVValue(rel.source),
      escapeCSVValue(rel.target)
    ];
    return values.join(',');
  });

  return [headers, ...rows].join('\n');
}

/**
 * Escape CSV values (handle commas, quotes, newlines)
 */
function escapeCSVValue(value: string): string {
  if (!value) return '';
  
  // If value contains comma, quote, or newline, wrap in quotes and escape internal quotes
  if (value.includes(',') || value.includes('"') || value.includes('\n')) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  
  return value;
}

/**
 * Generate filename for CSV export
 */
function generateCSVFilename(projectName?: string, includeTimestamp: boolean = true): string {
  const baseName = projectName 
    ? `gitnexus-${projectName.replace(/[^a-zA-Z0-9-_]/g, '-')}`
    : 'gitnexus-graph';
  
  if (includeTimestamp) {
    const timestamp = new Date().toISOString()
      .replace(/[:.]/g, '-')
      .replace('T', '_')
      .split('.')[0];
    return `${baseName}_${timestamp}`;
  }
  
  return baseName;
}

/**
 * Trigger download of a JSON file
 */
export function downloadJSON(content: string, filename: string): void {
  try {
    // Create blob with JSON content
    const blob = new Blob([content], { type: 'application/json' });
    
    // Create download URL
    const url = URL.createObjectURL(blob);
    
    // Create temporary download link
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    link.style.display = 'none';
    
    // Add to DOM, click, and remove
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    
    // Clean up URL
    URL.revokeObjectURL(url);
  } catch (error) {
    console.error('Failed to download JSON file:', error);
    throw new Error('Failed to download file. Please check your browser permissions.');
  }
}

/**
 * Trigger download of CSV files
 */
export function downloadCSV(content: string, filename: string): void {
  try {
    // Create blob with CSV content
    const blob = new Blob([content], { type: 'text/csv' });
    
    // Create download URL
    const url = URL.createObjectURL(blob);
    
    // Create temporary download link
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    link.style.display = 'none';
    
    // Add to DOM, click, and remove
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    
    // Clean up URL
    URL.revokeObjectURL(url);
  } catch (error) {
    console.error('Failed to download CSV file:', error);
    throw new Error('Failed to download file. Please check your browser permissions.');
  }
}

/**
 * Generate a default filename for the export
 */
export function generateExportFilename(
  projectName?: string,
  includeTimestamp: boolean = true
): string {
  const baseName = projectName 
    ? `gitnexus-${projectName.replace(/[^a-zA-Z0-9-_]/g, '-')}`
    : 'gitnexus-graph';
  
  if (includeTimestamp) {
    const timestamp = new Date().toISOString()
      .replace(/[:.]/g, '-')
      .replace('T', '_')
      .split('.')[0]; // Remove milliseconds
    return `${baseName}_${timestamp}.json`;
  }
  
  return `${baseName}.json`;
}

/**
 * Export and download a KnowledgeGraph
 */
export function exportAndDownloadGraph(
  graph: KnowledgeGraph,
  options: ExportOptions & { projectName?: string } = {},
  fileContents?: Map<string, string>,
  processingStats?: { duration: number }
): void {
  const {
    filename,
    projectName,
    includeTimestamp = true,
    ...exportOptions
  } = options;

  try {
    // Generate filename if not provided
    const finalFilename = filename || generateExportFilename(projectName, includeTimestamp);
    
    // Export to JSON
    const jsonContent = exportGraphToJSON(graph, exportOptions, fileContents, processingStats);
    
    // Trigger download
    downloadJSON(jsonContent, finalFilename);
    
    console.log(`Successfully exported graph to ${finalFilename}`);
  } catch (error) {
    console.error('Export failed:', error);
    throw error;
  }
}

/**
 * Export and download a KnowledgeGraph as CSV
 */
export function exportAndDownloadGraphAsCSV(
  graph: KnowledgeGraph,
  options: ExportOptions & { projectName?: string } = {}
): void {
  try {
    // Export to CSV
    const csvData = exportGraphToCSV(graph, options);
    
    // Download nodes CSV
    downloadCSV(csvData.nodes, `${csvData.filename}_nodes.csv`);
    
    // Download relationships CSV
    downloadCSV(csvData.relationships, `${csvData.filename}_relationships.csv`);
    
    console.log(`Successfully exported graph to CSV files: ${csvData.filename}_nodes.csv, ${csvData.filename}_relationships.csv`);
  } catch (error) {
    console.error('CSV export failed:', error);
    throw error;
  }
}

/**
 * Calculate export file size (approximate)
 */
export function calculateExportSize(
  graph: KnowledgeGraph,
  includeFileContents: boolean = false,
  fileContents?: Map<string, string>
): { sizeBytes: number; sizeFormatted: string } {
  // Create a sample export to measure size
  const sampleExport = exportGraphToJSON(
    graph,
    { includeMetadata: true, prettyPrint: false },
    includeFileContents ? fileContents : undefined
  );
  
  const sizeBytes = new Blob([sampleExport]).size;
  const sizeFormatted = formatFileSize(sizeBytes);
  
  return { sizeBytes, sizeFormatted };
}

/**
 * Format file size in human-readable format
 */
export function formatFileSize(bytes: number): string {
  if (bytes === 0) return '0 Bytes';
  
  const k = 1024;
  const sizes = ['Bytes', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

/**
 * Validate if a graph can be exported
 */
export function validateGraphForExport(graph: KnowledgeGraph): {
  isValid: boolean;
  errors: string[];
  warnings: string[];
} {
  const errors: string[] = [];
  const warnings: string[] = [];
  
  // Check if graph exists
  if (!graph) {
    errors.push('Graph is null or undefined');
    return { isValid: false, errors, warnings };
  }
  
  // Check if graph has nodes
  if (!graph.nodes || graph.nodes.length === 0) {
    warnings.push('Graph has no nodes');
  }
  
  // Check if graph has relationships
  if (!graph.relationships || graph.relationships.length === 0) {
    warnings.push('Graph has no relationships');
  }
  
  // Check for invalid node IDs
  const nodeIds = new Set(graph.nodes.map(n => n.id));
  if (nodeIds.size !== graph.nodes.length) {
    errors.push('Graph contains duplicate node IDs');
  }
  
  // Check for invalid relationships
  graph.relationships.forEach((rel, index) => {
    if (!nodeIds.has(rel.source)) {
      errors.push(`Relationship ${index} has invalid source node ID: ${rel.source}`);
    }
    if (!nodeIds.has(rel.target)) {
      errors.push(`Relationship ${index} has invalid target node ID: ${rel.target}`);
    }
  });
  
  // Check for very large exports
  const approximateSize = JSON.stringify(graph).length;
  if (approximateSize > 50 * 1024 * 1024) { // 50MB
    warnings.push('Export file will be very large (>50MB). Consider filtering the data.');
  }
  
  return {
    isValid: errors.length === 0,
    errors,
    warnings
  };
}

/**
 * Import a KnowledgeGraph from JSON string
 */
export function importGraphFromJSON(jsonString: string): {
  graph: KnowledgeGraph;
  metadata?: ExportMetadata;
  fileContents?: Map<string, string>;
} {
  try {
    const parsed = JSON.parse(jsonString);
    
    // Check if it's an exported graph with metadata
    if (parsed.metadata && parsed.graph) {
      const result: {
        graph: KnowledgeGraph;
        metadata: ExportMetadata;
        fileContents?: Map<string, string>;
      } = {
        graph: parsed.graph,
        metadata: parsed.metadata
      };
      
      // Convert file contents back to Map if present
      if (parsed.fileContents) {
        result.fileContents = new Map(Object.entries(parsed.fileContents));
      }
      
      return result;
    }
    
    // Assume it's a raw graph
    return { graph: parsed };
  } catch (error) {
    throw new Error(`Failed to import graph: ${error instanceof Error ? error.message : 'Invalid JSON'}`);
  }
}

/**
 * Create a filtered export of the graph
 */
export function createFilteredExport(
  graph: KnowledgeGraph,
  filters: {
    nodeTypes?: string[];
    relationshipTypes?: string[];
    filePatterns?: string[];
    maxNodes?: number;
  }
): KnowledgeGraph {
  const { nodeTypes, relationshipTypes, filePatterns, maxNodes } = filters;
  
  let filteredNodes = graph.nodes;
  let filteredRelationships = graph.relationships;
  
  // Filter by node types
  if (nodeTypes && nodeTypes.length > 0) {
    filteredNodes = filteredNodes.filter(node => nodeTypes.includes(node.label));
  }
  
  // Filter by file patterns
  if (filePatterns && filePatterns.length > 0) {
    filteredNodes = filteredNodes.filter(node => {
      const filePath = node.properties.filePath as string;
      if (!filePath) return true; // Keep nodes without file paths
      
      return filePatterns.some(pattern => {
        const regex = new RegExp(pattern.replace(/\*/g, '.*'), 'i');
        return regex.test(filePath);
      });
    });
  }
  
  // Limit number of nodes
  if (maxNodes && filteredNodes.length > maxNodes) {
    filteredNodes = filteredNodes.slice(0, maxNodes);
  }
  
  // Get filtered node IDs
  const filteredNodeIds = new Set(filteredNodes.map(n => n.id));
  
  // Filter relationships to only include those between filtered nodes
  filteredRelationships = filteredRelationships.filter(rel => 
    filteredNodeIds.has(rel.source) && filteredNodeIds.has(rel.target)
  );
  
  // Filter by relationship types
  if (relationshipTypes && relationshipTypes.length > 0) {
    filteredRelationships = filteredRelationships.filter(rel => 
      relationshipTypes.includes(rel.type)
    );
  }
  
  return {
    nodes: filteredNodes,
    relationships: filteredRelationships
  };
} 

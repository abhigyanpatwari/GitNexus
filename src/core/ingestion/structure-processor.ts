import type { KnowledgeGraph, GraphNode, GraphRelationship } from '../graph/types.ts';
import { generateId } from '../../lib/utils.ts';

export interface StructureInput {
  projectRoot: string;
  projectName: string;
  filePaths: string[];
}

export class StructureProcessor {
  private nodeIdMap: Map<string, string> = new Map();

  public async process(graph: KnowledgeGraph, input: StructureInput): Promise<void> {
    const { projectRoot, projectName, filePaths } = input;
    
    // Create project root node
    const projectNode = this.createProjectNode(projectName, projectRoot);
    graph.nodes.push(projectNode);
    
    // Extract unique folder paths from file paths
    const folderPaths = this.extractFolderPaths(filePaths);
    
    // Create folder nodes and establish hierarchy
    const folderNodes = this.createFolderNodes(folderPaths);
    graph.nodes.push(...folderNodes);
    
    // Create file nodes
    const fileNodes = this.createFileNodes(filePaths);
    graph.nodes.push(...fileNodes);
    
    // Establish CONTAINS relationships
    this.createContainsRelationships(graph, projectNode.id, folderPaths, filePaths);
  }

  private createProjectNode(projectName: string, projectRoot: string): GraphNode {
    const id = generateId('project', projectName);
    this.nodeIdMap.set('', id); // Empty path represents project root
    
    return {
      id,
      label: 'Project',
      properties: {
        name: projectName,
        path: projectRoot,
        createdAt: new Date().toISOString()
      }
    };
  }

  private extractFolderPaths(filePaths: string[]): string[] {
    const folderSet = new Set<string>();
    
    for (const filePath of filePaths) {
      const pathParts = filePath.split('/');
      
      // Generate all parent folder paths
      for (let i = 1; i < pathParts.length; i++) {
        const folderPath = pathParts.slice(0, i).join('/');
        if (folderPath) {
          folderSet.add(folderPath);
        }
      }
    }
    
    return Array.from(folderSet).sort();
  }

  private createFolderNodes(folderPaths: string[]): GraphNode[] {
    const nodes: GraphNode[] = [];
    
    for (const folderPath of folderPaths) {
      const pathParts = folderPath.split('/');
      const folderName = pathParts[pathParts.length - 1];
      const id = generateId('folder', folderPath);
      
      this.nodeIdMap.set(folderPath, id);
      
      nodes.push({
        id,
        label: 'Folder',
        properties: {
          name: folderName,
          path: folderPath,
          depth: pathParts.length
        }
      });
    }
    
    return nodes;
  }

  private createFileNodes(filePaths: string[]): GraphNode[] {
    const nodes: GraphNode[] = [];
    
    for (const filePath of filePaths) {
      const pathParts = filePath.split('/');
      const fileName = pathParts[pathParts.length - 1];
      const fileExtension = this.getFileExtension(fileName);
      const id = generateId('file', filePath);
      
      this.nodeIdMap.set(filePath, id);
      
      nodes.push({
        id,
        label: 'File',
        properties: {
          name: fileName,
          path: filePath,
          extension: fileExtension,
          isSourceFile: this.isSourceFile(fileExtension)
        }
      });
    }
    
    return nodes;
  }

  private createContainsRelationships(
    graph: KnowledgeGraph, 
    projectId: string, 
    folderPaths: string[], 
    filePaths: string[]
  ): void {
    const relationships: GraphRelationship[] = [];
    
    // Project contains root folders
    const rootFolders = folderPaths.filter(path => !path.includes('/'));
    for (const rootFolder of rootFolders) {
      const folderId = this.nodeIdMap.get(rootFolder);
      if (folderId) {
        relationships.push({
          id: generateId('relationship', `${projectId}-contains-${folderId}`),
          type: 'CONTAINS',
          source: projectId,
          target: folderId
        });
      }
    }
    
    // Folders contain subfolders
    for (const folderPath of folderPaths) {
      const parentPath = this.getParentPath(folderPath);
      const parentId = this.nodeIdMap.get(parentPath);
      const folderId = this.nodeIdMap.get(folderPath);
      
      if (parentId && folderId && parentPath !== folderPath) {
        relationships.push({
          id: generateId('relationship', `${parentId}-contains-${folderId}`),
          type: 'CONTAINS',
          source: parentId,
          target: folderId
        });
      }
    }
    
    // Folders and project contain files
    for (const filePath of filePaths) {
      const parentPath = this.getParentPath(filePath);
      const parentId = this.nodeIdMap.get(parentPath);
      const fileId = this.nodeIdMap.get(filePath);
      
      if (parentId && fileId) {
        relationships.push({
          id: generateId('relationship', `${parentId}-contains-${fileId}`),
          type: 'CONTAINS',
          source: parentId,
          target: fileId
        });
      }
    }
    
    graph.relationships.push(...relationships);
  }

  private getParentPath(path: string): string {
    const pathParts = path.split('/');
    if (pathParts.length <= 1) return '';
    return pathParts.slice(0, -1).join('/');
  }

  private getFileExtension(fileName: string): string {
    const lastDotIndex = fileName.lastIndexOf('.');
    return lastDotIndex !== -1 ? fileName.substring(lastDotIndex) : '';
  }

  private isSourceFile(extension: string): boolean {
    const sourceExtensions = new Set([
      '.py', '.js', '.ts', '.tsx', '.jsx', '.java', '.cpp', '.c', '.h', '.hpp',
      '.cs', '.php', '.rb', '.go', '.rs', '.swift', '.kt', '.scala'
    ]);
    return sourceExtensions.has(extension);
  }

  public getNodeId(path: string): string | undefined {
    return this.nodeIdMap.get(path);
  }
} 
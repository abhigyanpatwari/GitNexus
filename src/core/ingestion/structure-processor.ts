import type { KnowledgeGraph, GraphNode, GraphRelationship } from '../graph/types.ts';
import { generateId } from '../../lib/utils.ts';

export interface StructureInput {
  projectRoot: string;
  projectName: string;
  filePaths: string[];  // Now includes ALL paths: files AND directories
}

export class StructureProcessor {
  private nodeIdMap: Map<string, string> = new Map();

  // Import ignore patterns from ParsingProcessor
  private static readonly IGNORE_PATTERNS = new Set([
    // Version Control
    '.git', '.svn', '.hg',
    
    // Package Managers & Dependencies
    'node_modules', 'bower_components', 'jspm_packages', 'vendor', 'deps',
    
    // Python Virtual Environments & Cache
    'venv', 'env', '.venv', '.env', 'envs', 'virtualenv', '__pycache__',
    '.pytest_cache', '.mypy_cache', '.tox',
    
    // Build & Distribution Directories
    'build', 'dist', 'out', 'target', 'bin', 'obj', '.gradle', '_build',
    
    // IDE & Editor Directories
    '.vs', '.vscode', '.idea', '.eclipse', '.settings',
    
    // Temporary & Log Directories
    'tmp', '.tmp', 'temp', 'logs', 'log',
    
    // Coverage & Testing
    'coverage', '.coverage', 'htmlcov', '.nyc_output',
    
    // OS & System
    '.DS_Store', 'Thumbs.db',
    
    // Documentation Build Output
    '_site', '.docusaurus',
    
    // Cache Directories
    '.cache', '.parcel-cache', '.next', '.nuxt'
  ]);

  /**
   * Process complete repository structure directly from discovered paths
   * This is the new robust approach that doesn't infer structure
   */
  public async process(graph: KnowledgeGraph, input: StructureInput): Promise<void> {
    const { projectRoot, projectName, filePaths } = input;
    
    console.log(`StructureProcessor: Processing ${filePaths.length} complete paths`);
    
    // Create project root node
    const projectNode = this.createProjectNode(projectName, projectRoot);
    graph.addNode(projectNode);
    
    // Separate files and directories from the complete path list
    const { directories, files } = this.categorizePaths(filePaths);
    
    console.log(`StructureProcessor: Found ${directories.length} directories and ${files.length} files`);
    
    // Filter out ignored directories from KG display (but keep for internal structure)
    const visibleDirectories = directories.filter(dir => !this.shouldHideDirectory(dir));
    const hiddenDirectoriesCount = directories.length - visibleDirectories.length;
    
    if (hiddenDirectoriesCount > 0) {
      console.log(`StructureProcessor: Hiding ${hiddenDirectoriesCount} ignored directories from KG`);
    }
    
    // Create directory nodes only for visible directories
    const directoryNodes = this.createDirectoryNodes(visibleDirectories);
    directoryNodes.forEach(node => graph.addNode(node));
    
    // Filter out files that are inside ignored directories
    const visibleFiles = files.filter(file => !this.shouldHideFile(file));
    const hiddenFilesCount = files.length - visibleFiles.length;
    
    if (hiddenFilesCount > 0) {
      console.log(`StructureProcessor: Hiding ${hiddenFilesCount} files in ignored directories from KG`);
    }
    
    // Create file nodes only for visible files
    const fileNodes = this.createFileNodes(visibleFiles);
    fileNodes.forEach(node => graph.addNode(node));
    
    // Establish CONTAINS relationships for visible structure only
    this.createContainsRelationships(graph, projectNode.id, visibleDirectories, visibleFiles);
    
    const totalHidden = hiddenDirectoriesCount + hiddenFilesCount;
    console.log(`StructureProcessor: Created ${graph.nodes.length} nodes total (${totalHidden} items hidden)`);
  }

  /**
   * Categorize paths into files and directories
   * Since we now receive the complete structure, we need to distinguish between them
   */
  private categorizePaths(allPaths: string[]): { directories: string[], files: string[] } {
    const directories: string[] = [];
    const files: string[] = [];
    const pathSet = new Set(allPaths);
    
    for (const path of allPaths) {
      // A path is a directory if:
      // 1. Other paths exist that start with this path + "/"
      // 2. OR it doesn't have a file extension and other paths are nested under it
      const isDirectory = allPaths.some(otherPath => 
        otherPath !== path && otherPath.startsWith(path + '/')
      );
      
      if (isDirectory) {
        directories.push(path);
      } else {
        // It's a file if it's not identified as a directory
        files.push(path);
      }
    }
    
    // Also add intermediate directories that might not be explicitly listed
    const allIntermediateDirs = new Set<string>();
    for (const path of allPaths) {
      const parts = path.split('/');
      for (let i = 1; i < parts.length; i++) {
        const intermediatePath = parts.slice(0, i).join('/');
        if (intermediatePath && !pathSet.has(intermediatePath)) {
          allIntermediateDirs.add(intermediatePath);
        }
      }
    }
    
    // Add intermediate directories that weren't explicitly listed
    directories.push(...Array.from(allIntermediateDirs));
    
    return { 
      directories: [...new Set(directories)].sort(),  // Remove duplicates and sort
      files: files.sort() 
    };
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

  /**
   * Create nodes for directories directly from discovered directory paths
   */
  private createDirectoryNodes(directoryPaths: string[]): GraphNode[] {
    const nodes: GraphNode[] = [];
    
    for (const dirPath of directoryPaths) {
      if (!dirPath) continue;
      
      const id = generateId('folder', dirPath);
      this.nodeIdMap.set(dirPath, id);
      
      const pathParts = dirPath.split('/');
      const dirName = pathParts[pathParts.length - 1];
      
      const node: GraphNode = {
        id,
        label: 'Folder',
        properties: {
          name: dirName,
          path: dirPath,
          fullPath: dirPath,
          depth: pathParts.length
        }
      };
      
      nodes.push(node);
    }
    
    return nodes;
  }

  /**
   * Create nodes for files directly from discovered file paths
   */
  private createFileNodes(filePaths: string[]): GraphNode[] {
    const nodes: GraphNode[] = [];
    
    for (const filePath of filePaths) {
      if (!filePath) continue;
      
      const id = generateId('file', filePath);
      this.nodeIdMap.set(filePath, id);
      
      const fileName = filePath.split('/').pop() || filePath;
      const extension = this.getFileExtension(fileName);
      
      const node: GraphNode = {
        id,
        label: 'File',
        properties: {
          name: fileName,
          path: filePath,
          filePath: filePath,  // For compatibility with existing code
          extension,
          // Note: definitionCount will be set later by ParsingProcessor
          // language will be determined later by ParsingProcessor
        }
      };
      
      nodes.push(node);
    }
    
    return nodes;
  }

  /**
   * Create CONTAINS relationships for the complete discovered structure
   */
  private createContainsRelationships(
    graph: KnowledgeGraph, 
    projectId: string, 
    directories: string[], 
    files: string[]
  ): void {
    // Create relationships: directories contain subdirectories and files
    const allPaths = [...directories, ...files];
    
    for (const path of allPaths) {
      const parentPath = this.getParentPath(path);
      const parentId = parentPath === '' ? projectId : this.nodeIdMap.get(parentPath);
      const childId = this.nodeIdMap.get(path);
      
      // Only create relationships if both parent and child nodes exist in the graph
      if (parentId && childId && parentId !== childId) {
        const relationship: GraphRelationship = {
          id: generateId('contains', `${parentId}-${childId}`),
          type: 'CONTAINS',
          source: parentId,
          target: childId,
          properties: {}
        };
        
        graph.addRelationship(relationship);
      } else if (!parentId && parentPath !== '') {
        // If parent directory was hidden, connect directly to project or nearest visible parent
        const visibleParentId = this.findVisibleParent(parentPath, projectId);
        if (visibleParentId && childId && visibleParentId !== childId) {
          const relationship: GraphRelationship = {
            id: generateId('contains', `${visibleParentId}-${childId}`),
            type: 'CONTAINS',
            source: visibleParentId,
            target: childId,
            properties: {}
          };
          
          graph.addRelationship(relationship);
        }
      }
    }
    
    console.log(`StructureProcessor: Created ${graph.relationships.length} CONTAINS relationships`);
  }

  /**
   * Find the nearest visible parent directory or project root
   */
  private findVisibleParent(path: string, projectId: string): string {
    if (path === '') return projectId;
    
    const parentPath = this.getParentPath(path);
    const parentId = this.nodeIdMap.get(parentPath);
    
    if (parentId) {
      return parentId; // Found visible parent
    }
    
    // Recursively look for visible parent
    return this.findVisibleParent(parentPath, projectId);
  }

  private getParentPath(path: string): string {
    if (!path || !path.includes('/')) {
      return ''; // Root level
    }
    
    const lastSlashIndex = path.lastIndexOf('/');
    return path.substring(0, lastSlashIndex);
  }

  private getFileExtension(fileName: string): string {
    const lastDotIndex = fileName.lastIndexOf('.');
    if (lastDotIndex === -1 || lastDotIndex === 0) {
      return '';
    }
    return fileName.substring(lastDotIndex);
  }

  public getNodeId(path: string): string | undefined {
    return this.nodeIdMap.get(path);
  }

  public clear(): void {
    this.nodeIdMap.clear();
  }

  /**
   * Check if a directory should be hidden from the KG visualization
   * This matches the ignore patterns used in ParsingProcessor
   */
  private shouldHideDirectory(dirPath: string): boolean {
    const pathSegments = dirPath.split('/');
    
    // Check if any segment of the path matches an ignore pattern
    const hasIgnoredSegment = pathSegments.some(segment => 
      StructureProcessor.IGNORE_PATTERNS.has(segment.toLowerCase())
    );
    
    if (hasIgnoredSegment) {
      return true;
    }
    
    // Additional pattern matching
    const lowerPath = dirPath.toLowerCase();
    
    // Hide Python egg-info directories
    if (lowerPath.includes('.egg-info')) {
      return true;
    }
    
    // Hide site-packages directories
    if (lowerPath.includes('site-packages')) {
      return true;
    }
    
    // Hide most hidden directories (except important ones like .github)
    for (const segment of pathSegments) {
      if (segment.startsWith('.') && segment !== '.github') {
        return true;
      }
    }
    
    return false;
  }

  /**
   * Check if a file should be hidden from the KG visualization
   * This matches the ignore patterns used in ParsingProcessor
   */
  private shouldHideFile(filePath: string): boolean {
    const pathSegments = filePath.split('/');
    
    // Check if any segment of the path matches an ignore pattern
    const hasIgnoredSegment = pathSegments.some(segment => 
      StructureProcessor.IGNORE_PATTERNS.has(segment.toLowerCase())
    );
    
    if (hasIgnoredSegment) {
      return true;
    }
    
    // Additional pattern matching
    const lowerPath = filePath.toLowerCase();
    
    // Hide Python egg-info directories
    if (lowerPath.includes('.egg-info')) {
      return true;
    }
    
    // Hide site-packages directories
    if (lowerPath.includes('site-packages')) {
      return true;
    }
    
    // Hide most hidden directories (except important ones like .github)
    for (const segment of pathSegments) {
      if (segment.startsWith('.') && segment !== '.github') {
        return true;
      }
    }
    
    return false;
  }
}
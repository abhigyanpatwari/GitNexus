/**
 * Nebular - Multi-Repository Knowledge Graph
 * 
 * Enables cross-repository knowledge graphs for monorepos and
 * multi-repo projects. Connects relationships across repositories.
 */

import fs from 'fs/promises';
import path from 'path';
import { loadRepo, listRegisteredRepos, getStoragePaths, type IndexedRepo } from '../storage/repo-manager.js';
import type { KnowledgeGraph, GraphNode, GraphRelationship, NodeLabel, RelationshipType } from '../core/graph/types.js';

/**
 * Configuration for Nebular multi-repo graph
 */
export interface NebularConfig {
  /** List of repo paths to include in the unified graph */
  repos: string[];
  /** Cross-repo relationship types to detect */
  detectPatterns: CrossRepoPattern[];
}

/**
 * Patterns for detecting cross-repo relationships
 */
export interface CrossRepoPattern {
  /** Pattern name */
  name: string;
  /** File patterns to look for (package.json, go.mod, Cargo.toml, etc.) */
  files: string[];
  /** How to extract the relationship */
  extractor: (content: string) => CrossRepoLink[];
}

export interface CrossRepoLink {
  /** Type of link */
  type: 'dependency' | 'workspace' | 'import' | 'reference';
  /** The linked repo/package name */
  target: string;
  /** Version or path if applicable */
  version?: string;
}

/**
 * Load a graph from a single repo's storage
 */
async function loadRepoGraph(repoPath: string): Promise<{ nodes: GraphNode[], relationships: GraphRelationship[] } | null> {
  const { storagePath } = getStoragePaths(repoPath);
  const graphPath = path.join(storagePath, 'graph.json');
  
  try {
    const content = await fs.readFile(graphPath, 'utf-8');
    return JSON.parse(content);
  } catch {
    return null;
  }
}

/**
 * Detect cross-repo relationships from package manifest files
 */
function detectCrossRepoLinks(repoPath: string): CrossRepoLink[] {
  const links: CrossRepoLink[] = [];
  
  // Check package.json for workspace dependencies
  try {
    const pkgPath = path.join(repoPath, 'package.json');
    const content = require('fs').readFileSync(pkgPath, 'utf-8');
    const pkg = JSON.parse(content);
    
    // Workspace packages
    if (pkg.workspaces) {
      const ws = Array.isArray(pkg.workspaces) ? pkg.workspaces : pkg.workspaces.packages || [];
      for (const wsPkg of ws) {
        links.push({ type: 'workspace', target: wsPkg });
      }
    }
    
    // Dependencies
    for (const [dep, version] of Object.entries(pkg.dependencies || {})) {
      links.push({ type: 'dependency', target: dep, version });
    }
  } catch {
    // package.json not found or invalid
  }
  
  return links;
}

/**
 * Nebular - Multi-Repository Knowledge Graph
 * 
 * Creates a unified knowledge graph across multiple repositories,
 * enabling cross-repo search, dependency visualization, and knowledge discovery.
 */
export class NebularGraph {
  private repos: Map<string, IndexedRepo> = new Map();
  private unifiedNodes: GraphNode[] = [];
  private unifiedRelationships: GraphRelationship[] = [];
  private crossRepoRelationships: GraphRelationship[] = [];
  
  /**
   * Initialize Nebular with a list of repository paths
   */
  async initialize(repoPaths: string[]): Promise<void> {
    console.log('🌌 Initializing Nebular multi-repo graph...');
    
    for (const repoPath of repoPaths) {
      const repo = await loadRepo(repoPath);
      if (repo) {
        this.repos.set(repoPath, repo);
        console.log(`  ✅ Loaded: ${repo.meta.repoPath}`);
        
        // Load graph data
        const graphData = await loadRepoGraph(repoPath);
        if (graphData) {
          // Prefix node IDs with repo name to avoid collisions
          const repoName = path.basename(repoPath);
          for (const node of graphData.nodes) {
            const prefixedNode = {
              ...node,
              id: `${repoName}:${node.id}`,
              properties: {
                ...node.properties,
                _repo: repoName,
                _repoPath: repoPath,
              }
            };
            this.unifiedNodes.push(prefixedNode);
          }
          
          for (const rel of graphData.relationships) {
            const prefixedRel = {
              ...rel,
              id: `${repoName}:${rel.id}`,
              sourceId: `${repoName}:${rel.sourceId}`,
              targetId: `${repoName}:${rel.targetId}`,
              properties: {
                ...rel,
                _repo: repoName,
              }
            };
            this.unifiedRelationships.push(prefixedRel);
          }
        }
      } else {
        console.log(`  ⚠️  Not indexed: ${repoPath}`);
      }
    }
    
    // Detect and add cross-repo relationships
    await this.detectCrossRepoRelationships();
    
    console.log(`🌌 Nebular ready: ${this.unifiedNodes.length} nodes, ${this.crossRepoRelationships.length} cross-repo links`);
  }
  
  /**
   * Detect relationships between repositories
   */
  private async detectCrossRepoRelationships(): Promise<void> {
    const repoNames = Array.from(this.repos.keys()).map(p => path.basename(p));
    
    for (const [repoPath, repo] of this.repos) {
      const links = detectCrossRepoLinks(repoPath);
      const repoName = path.basename(repoPath);
      
      for (const link of links) {
        // Check if the link points to another repo in our graph
        for (const otherRepoPath of this.repos.keys()) {
          const otherRepoName = path.basename(otherRepoPath);
          
          if (otherRepoName !== repoName) {
            // Check if this is a workspace or direct match
            const isWorkspace = link.target.includes(otherRepoName) || 
                              link.target === otherRepoName;
            
            if (isWorkspace) {
              // Create a CROSS_REPO relationship
              const crossRel: GraphRelationship = {
                id: `${repoName}->${otherRepoName}:${link.type}`,
                sourceId: `${repoName}:root`,
                targetId: `${otherRepoName}:root`,
                type: link.type === 'workspace' ? 'CONTAINS' : 'IMPORTS',
                confidence: 1.0,
                reason: `nebular:${link.type}`,
              };
              this.crossRepoRelationships.push(crossRel);
            }
          }
        }
      }
    }
  }
  
  /**
   * Search across all repos
   */
  search(query: string): GraphNode[] {
    const q = query.toLowerCase();
    return this.unifiedNodes.filter(node => 
      node.properties.name.toLowerCase().includes(q) ||
      node.properties.filePath.toLowerCase().includes(q)
    );
  }
  
  /**
   * Get all nodes
   */
  getNodes(): GraphNode[] {
    return this.unifiedNodes;
  }
  
  /**
   * Get all relationships
   */
  getRelationships(): GraphRelationship[] {
    return [...this.unifiedRelationships, ...this.crossRepoRelationships];
  }
  
  /**
   * Get cross-repo relationships only
   */
  getCrossRepoRelationships(): GraphRelationship[] {
    return this.crossRepoRelationships;
  }
  
  /**
   * Get stats
   */
  getStats() {
    return {
      repoCount: this.repos.size,
      nodeCount: this.unifiedNodes.length,
      relationshipCount: this.unifiedRelationships.length,
      crossRepoLinks: this.crossRepoRelationships.length,
    };
  }
}

/**
 * Convenience function to create a Nebular graph from registered repos
 */
export async function createNebularFromRegistry(): Promise<NebularGraph> {
  const registered = await listRegisteredRepos({ validate: true });
  const nebular = new NebularGraph();
  
  await nebular.initialize(registered.map(r => r.path));
  
  return nebular;
}

export default NebularGraph;

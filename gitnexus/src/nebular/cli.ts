#!/usr/bin/env node

/**
 * GitNexus Nebular CLI
 * 
 * Multi-repository knowledge graph CLI
 * 
 * Usage:
 *   gitnexus nebular init          # Initialize nebular from registered repos
 *   gitnexus nebular scan <path>   # Scan folder for GitNexus-indexed repos
 *   gitnexus nebular search <query> # Search across all repos
 *   gitnexus nebular graph         # Output unified graph
 */

import { createNebularFromRegistry, NebularGraph } from '../src/nebular/index.js';
import { listRegisteredRepos, hasIndex } from '../src/storage/repo-manager.js';
import fs from 'fs/promises';
import path from 'path';

const command = process.argv[2];

/**
 * Scan a directory for GitNexus-indexed repositories
 */
async function scanForIndexedRepos(scanPath: string): Promise<string[]> {
  const indexedRepos: string[] = [];
  
  try {
    const entries = await fs.readdir(scanPath, { withFileTypes: true });
    
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      
      const fullPath = path.join(scanPath, entry.name);
      
      // Check if this directory has a GitNexus index
      try {
        const hasGitNexus = await hasIndex(fullPath);
        if (hasGitNexus) {
          indexedRepos.push(fullPath);
          console.log(`  ✅ Found indexed: ${entry.name}`);
        }
      } catch {
        // Skip errors for individual repos
      }
      
      // Recursively scan subdirectories (max 2 levels deep)
      if (entry.name !== 'node_modules' && entry.name !== '.git') {
        try {
          const subEntries = await fs.readdir(fullPath, { withFileTypes: true });
          for (const subEntry of subEntries) {
            if (!subEntry.isDirectory()) continue;
            if (subEntry.name === 'node_modules' || subEntry.name === '.git') continue;
            
            const subPath = path.join(fullPath, subEntry.name);
            try {
              const hasSubGitNexus = await hasIndex(subPath);
              if (hasSubGitNexus) {
                indexedRepos.push(subPath);
                console.log(`  ✅ Found indexed: ${entry.name}/${subEntry.name}`);
              }
            } catch {
              // Skip
            }
          }
        } catch {
          // Skip inaccessible directories
        }
      }
    }
  } catch (err) {
    console.error(`Error scanning ${scanPath}:`, err);
  }
  
  return indexedRepos;
}

async function main() {
  switch (command) {
    case 'init': {
      console.log('🌌 Initializing GitNexus Nebular...');
      const nebular = await createNebularFromRegistry();
      const stats = nebular.getStats();
      console.log(`\n📊 Nebular Stats:`);
      console.log(`   Repositories: ${stats.repoCount}`);
      console.log(`   Total Nodes: ${stats.nodeCount}`);
      console.log(`   Cross-repo Links: ${stats.crossRepoLinks}`);
      break;
    }
    
    case 'scan': {
      const scanPath = process.argv[3] || process.cwd();
      console.log(`\n🔍 Scanning for GitNexus-indexed repos in: ${scanPath}`);
      
      const indexedRepos = await scanForIndexedRepos(scanPath);
      
      if (indexedRepos.length === 0) {
        console.log('\n⚠️  No GitNexus-indexed repositories found.');
        console.log('   Run "gitnexus analyze" in each repo first.');
      } else {
        console.log(`\n✅ Found ${indexedRepos.length} indexed repos:`);
        for (const repo of indexedRepos) {
          console.log(`   - ${repo}`);
        }
        
        console.log('\n💡 To create a Nebular graph from these repos:');
        console.log('   gitnexus nebular init');
      }
      break;
    }
    
    case 'search': {
      const query = process.argv[3];
      if (!query) {
        console.error('Usage: gitnexus nebular search <query>');
        process.exit(1);
      }
      
      const nebular = await createNebularFromRegistry();
      const results = nebular.search(query);
      
      console.log(`\n🔍 Search results for "${query}":`);
      for (const node of results.slice(0, 20)) {
        const repo = node.properties._repo || 'unknown';
        console.log(`   [${repo}] ${node.properties.name} (${node.label})`);
        console.log(`      ${node.properties.filePath}`);
      }
      console.log(`\n   Found ${results.length} total matches`);
      break;
    }
    
    case 'graph': {
      const nebular = await createNebularFromRegistry();
      const nodes = nebular.getNodes();
      const relationships = nebular.getRelationships();
      
      const output = {
        nodes: nodes.map(n => ({
          id: n.id,
          label: n.label,
          name: n.properties.name,
          repo: n.properties._repo,
        })),
        relationships: relationships.map(r => ({
          id: r.id,
          source: r.sourceId,
          target: r.targetId,
          type: r.type,
          crossRepo: r.reason?.startsWith('nebular:') || false,
        })),
        stats: nebular.getStats(),
      };
      
      console.log(JSON.stringify(output, null, 2));
      break;
    }
    
    case 'repos': {
      const repos = await listRegisteredRepos({ validate: true });
      console.log(`\n📦 Registered Repositories (${repos.length}):`);
      for (const repo of repos) {
        console.log(`   - ${repo.name}`);
        console.log(`     Path: ${repo.path}`);
        console.log(`     Stats: ${repo.stats?.files || 0} files, ${repo.stats?.nodes || 0} nodes`);
      }
      break;
    }
    
    default:
      console.log(`
🌌 GitNexus Nebular - Multi-Repository Knowledge Graph

Usage:
   gitnexus nebular init          Initialize nebular from registered repos
   gitnexus nebular scan <path>  Scan folder for GitNexus-indexed repos
   gitnexus nebular search <query> Search across all repos
   gitnexus nebular graph         Output unified graph JSON
   gitnexus nebular repos         List registered repositories
`);
  }
}

main().catch(console.error);

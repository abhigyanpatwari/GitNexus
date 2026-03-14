/**
 * gitnexus export — Export the indexed knowledge graph to portable formats.
 *
 * Supported formats:
 *   json     – Standard JSON with nodes, edges, clusters, processes
 *   graphml  – GraphML XML (standard interchange format for graph tools)
 *   cypher   – Cypher script to recreate the graph in any Neo4j-compatible DB
 *   bundle   – Gzipped JSON bundle (.gitnexus.bundle) with manifest, for sharing
 *
 * Usage:
 *   gitnexus export [path] --format <json|graphml|cypher|bundle> [-o output]
 *   gitnexus export . --format=bundle --include-embeddings
 */

import fs from 'fs/promises';
import { createWriteStream } from 'fs';
import path from 'path';
import { execSync } from 'child_process';
import { createGzip } from 'zlib';
import { pipeline } from 'stream/promises';
import { Readable } from 'stream';
import { getStoragePaths, loadMeta, listRegisteredRepos } from '../storage/repo-manager.js';
import { withKuzuDb, executeQuery, closeKuzu } from '../core/kuzu/kuzu-adapter.js';
import { NODE_TABLES } from '../core/kuzu/schema.js';
import { GraphNode, GraphRelationship } from '../core/graph/types.js';

// ─── Graph Building ───────────────────────────────────────────────────────────

async function buildExportGraph(): Promise<{ nodes: GraphNode[]; relationships: GraphRelationship[] }> {
  const nodes: GraphNode[] = [];
  for (const table of NODE_TABLES) {
    try {
      let query = '';
      if (table === 'File') {
        query = `MATCH (n:File) RETURN n.id AS id, n.name AS name, n.filePath AS filePath`;
      } else if (table === 'Folder') {
        query = `MATCH (n:Folder) RETURN n.id AS id, n.name AS name, n.filePath AS filePath`;
      } else if (table === 'Community') {
        query = `MATCH (n:Community) RETURN n.id AS id, n.label AS label, n.heuristicLabel AS heuristicLabel, n.cohesion AS cohesion, n.symbolCount AS symbolCount`;
      } else if (table === 'Process') {
        query = `MATCH (n:Process) RETURN n.id AS id, n.label AS label, n.heuristicLabel AS heuristicLabel, n.processType AS processType, n.stepCount AS stepCount`;
      } else {
        query = `MATCH (n:${table}) RETURN n.id AS id, n.name AS name, n.filePath AS filePath, n.startLine AS startLine, n.endLine AS endLine`;
      }
      const rows = await executeQuery(query);
      for (const row of rows) {
        nodes.push({
          id: row.id ?? row[0],
          label: table as GraphNode['label'],
          properties: {
            name: row.name ?? row.label ?? row[1],
            filePath: row.filePath ?? row[2],
            startLine: row.startLine,
            endLine: row.endLine,
            heuristicLabel: row.heuristicLabel,
            cohesion: row.cohesion,
            symbolCount: row.symbolCount,
            processType: row.processType,
            stepCount: row.stepCount,
          } as GraphNode['properties'],
        });
      }
    } catch {
      // ignore empty tables
    }
  }

  const relationships: GraphRelationship[] = [];
  const relRows = await executeQuery(
    `MATCH (a)-[r:CodeRelation]->(b) RETURN a.id AS sourceId, b.id AS targetId, r.type AS type, r.confidence AS confidence, r.reason AS reason, r.step AS step`
  );
  for (const row of relRows) {
    relationships.push({
      id: `${row.sourceId}_${row.type}_${row.targetId}`,
      type: row.type,
      sourceId: row.sourceId,
      targetId: row.targetId,
      confidence: row.confidence,
      reason: row.reason,
      step: row.step,
    });
  }

  return { nodes, relationships };
}

// ─── Format Exporters ─────────────────────────────────────────────────────────

function exportJSON(
  graph: { nodes: GraphNode[]; relationships: GraphRelationship[] },
  meta: { repo: string; commit: string; exportedAt: string }
): string {
  return JSON.stringify(
    {
      version: '1.0',
      repo: meta.repo,
      commit: meta.commit,
      exportedAt: meta.exportedAt,
      stats: {
        nodes: graph.nodes.length,
        edges: graph.relationships.length,
      },
      nodes: graph.nodes,
      edges: graph.relationships,
    },
    null,
    2
  );
}

function exportGraphML(
  graph: { nodes: GraphNode[]; relationships: GraphRelationship[] },
  meta: { repo: string; commit: string; exportedAt: string }
): string {
  const lines: string[] = [];
  lines.push('<?xml version="1.0" encoding="UTF-8"?>');
  lines.push('<graphml xmlns="http://graphml.graphdrawing.org/xmlns"');
  lines.push('         xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"');
  lines.push('         xsi:schemaLocation="http://graphml.graphdrawing.org/xmlns');
  lines.push('           http://graphml.graphdrawing.org/xmlns/1.0/graphml.xsd">');
  lines.push('');
  // Key declarations
  lines.push('  <!-- Node attribute keys -->');
  lines.push('  <key id="name"      for="node" attr.name="name"      attr.type="string"/>');
  lines.push('  <key id="type"      for="node" attr.name="type"      attr.type="string"/>');
  lines.push('  <key id="filePath"  for="node" attr.name="filePath"  attr.type="string"/>');
  lines.push('  <key id="startLine" for="node" attr.name="startLine" attr.type="int"/>');
  lines.push('  <key id="endLine"   for="node" attr.name="endLine"   attr.type="int"/>');
  lines.push('  <!-- Edge attribute keys -->');
  lines.push('  <key id="reltype"    for="edge" attr.name="type"       attr.type="string"/>');
  lines.push('  <key id="confidence" for="edge" attr.name="confidence" attr.type="double"/>');
  lines.push('');
  lines.push(`  <!-- GitNexus export: repo=${meta.repo} commit=${meta.commit} exportedAt=${meta.exportedAt} -->`);
  lines.push(`  <graph id="G" edgedefault="directed">`);

  for (const node of graph.nodes) {
    const p = node.properties;
    lines.push(`    <node id="${xmlEscape(node.id)}">`);
    if (p.name)      lines.push(`      <data key="name">${xmlEscape(p.name)}</data>`);
    lines.push(`      <data key="type">${xmlEscape(node.label)}</data>`);
    if (p.filePath)  lines.push(`      <data key="filePath">${xmlEscape(p.filePath)}</data>`);
    if (p.startLine != null) lines.push(`      <data key="startLine">${p.startLine}</data>`);
    if (p.endLine   != null) lines.push(`      <data key="endLine">${p.endLine}</data>`);
    lines.push('    </node>');
  }

  let edgeIdx = 0;
  for (const rel of graph.relationships) {
    lines.push(`    <edge id="e${edgeIdx++}" source="${xmlEscape(rel.sourceId)}" target="${xmlEscape(rel.targetId)}">`);
    lines.push(`      <data key="reltype">${xmlEscape(rel.type)}</data>`);
    if (rel.confidence != null) lines.push(`      <data key="confidence">${rel.confidence}</data>`);
    lines.push('    </edge>');
  }

  lines.push('  </graph>');
  lines.push('</graphml>');
  return lines.join('\n');
}

function exportCypher(
  graph: { nodes: GraphNode[]; relationships: GraphRelationship[] },
  meta: { repo: string; commit: string; exportedAt: string }
): string {
  const lines: string[] = [];
  lines.push(`// GitNexus Cypher export`);
  lines.push(`// repo: ${meta.repo}  commit: ${meta.commit}  exportedAt: ${meta.exportedAt}`);
  lines.push('');
  lines.push('// ─── Nodes ─────────────────────────────────────────────────────');
  for (const node of graph.nodes) {
    const p = node.properties;
    const props: string[] = [`id: ${cypherStr(node.id)}`, `type: ${cypherStr(node.label)}`];
    if (p.name)      props.push(`name: ${cypherStr(p.name)}`);
    if (p.filePath)  props.push(`filePath: ${cypherStr(p.filePath)}`);
    if (p.startLine != null) props.push(`startLine: ${p.startLine}`);
    if (p.endLine   != null) props.push(`endLine: ${p.endLine}`);
    lines.push(`CREATE (:\`${node.label}\` {${props.join(', ')}});`);
  }
  lines.push('');
  lines.push('// ─── Relationships ──────────────────────────────────────────────');
  for (const rel of graph.relationships) {
    const props: string[] = [`type: ${cypherStr(rel.type)}`];
    if (rel.confidence != null) props.push(`confidence: ${rel.confidence}`);
    lines.push(
      `MATCH (a {id: ${cypherStr(rel.sourceId)}}), (b {id: ${cypherStr(rel.targetId)}}) ` +
      `CREATE (a)-[:CodeRelation {${props.join(', ')}}]->(b);`
    );
  }
  return lines.join('\n');
}

async function exportBundle(
  graph: { nodes: GraphNode[]; relationships: GraphRelationship[] },
  meta: { repo: string; commit: string; exportedAt: string },
  outputPath: string,
  includeEmbeddings: boolean,
  storagePath: string
): Promise<void> {
  const manifest = {
    version: '1.0',
    format: 'gitnexus-bundle',
    repo: meta.repo,
    commit: meta.commit,
    exportedAt: meta.exportedAt,
    includesEmbeddings: includeEmbeddings,
    stats: {
      nodes: graph.nodes.length,
      edges: graph.relationships.length,
    },
  };

  const bundleData = {
    manifest,
    graph: {
      nodes: graph.nodes,
      edges: graph.relationships,
    },
  };

  // Write as gzipped JSON
  const jsonStr = JSON.stringify(bundleData);
  const readable = Readable.from([Buffer.from(jsonStr, 'utf-8')]);
  const gzip = createGzip({ level: 9 });
  const writeStream = createWriteStream(outputPath);
  await pipeline(readable, gzip, writeStream);
  void storagePath; // reserved for future: include raw kuzu files when --include-embeddings
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function xmlEscape(str: string | undefined): string {
  if (!str) return '';
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function cypherStr(str: string | undefined): string {
  if (str == null) return 'null';
  return `'${str.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
}

function getRepoName(repoPath: string): string {
  return path.basename(path.resolve(repoPath));
}

function getCurrentCommit(repoPath: string): string {
  try {
    return execSync('git rev-parse HEAD', { cwd: repoPath, stdio: ['pipe', 'pipe', 'pipe'] })
      .toString()
      .trim();
  } catch {
    return 'unknown';
  }
}

// ─── CLI Command ──────────────────────────────────────────────────────────────

interface ExportOptions {
  format: string;
  output?: string;
  repo?: string;
  includeEmbeddings?: boolean;
}

export async function exportCommand(
  targetPath: string | undefined,
  options: ExportOptions
): Promise<void> {
  const format = (options.format ?? 'json').toLowerCase();
  if (!['json', 'graphml', 'cypher', 'bundle'].includes(format)) {
    console.error(`Error: unsupported format "${format}". Choose: json, graphml, cypher, bundle`);
    process.exit(1);
  }

  // Resolve repo path
  let repoPath = targetPath ? path.resolve(targetPath) : process.cwd();

  // If --repo specified, look up from registry
  if (options.repo) {
    const repos = await listRegisteredRepos();
    const found = repos.find(r => r.name === options.repo);
    if (!found) {
      console.error(`Error: repository "${options.repo}" not found in registry. Run: gitnexus analyze`);
      process.exit(1);
    }
    repoPath = found.path;
  }

  const { storagePath, kuzuPath } = getStoragePaths(repoPath);
  const meta = await loadMeta(storagePath);

  if (!meta) {
    console.error(`Error: no GitNexus index found at ${storagePath}`);
    console.error('Run: gitnexus analyze [path]');
    process.exit(1);
  }

  const repoName = getRepoName(repoPath);
  const commit = getCurrentCommit(repoPath);
  const commitShort = commit.slice(0, 8);
  const exportedAt = new Date().toISOString();
  const exportMeta = { repo: repoName, commit, exportedAt };

  console.log(`Exporting ${repoName} (commit: ${commitShort}) as ${format}...`);

  // Build the graph from KuzuDB
  const graph = await withKuzuDb(kuzuPath, () => buildExportGraph());
  console.log(`  ${graph.nodes.length} nodes, ${graph.relationships.length} edges`);

  // Determine output path
  let outputPath = options.output;
  if (!outputPath) {
    const extMap: Record<string, string> = {
      json: `${repoName}-${commitShort}.json`,
      graphml: `${repoName}-${commitShort}.graphml`,
      cypher: `${repoName}-${commitShort}.cypher`,
      bundle: `${repoName}-${commitShort}.gitnexus.bundle`,
    };
    outputPath = extMap[format];
  }

  // Export
  switch (format) {
    case 'json': {
      const content = exportJSON(graph, exportMeta);
      await fs.writeFile(outputPath, content, 'utf-8');
      break;
    }
    case 'graphml': {
      const content = exportGraphML(graph, exportMeta);
      await fs.writeFile(outputPath, content, 'utf-8');
      break;
    }
    case 'cypher': {
      const content = exportCypher(graph, exportMeta);
      await fs.writeFile(outputPath, content, 'utf-8');
      break;
    }
    case 'bundle': {
      await exportBundle(graph, exportMeta, outputPath, options.includeEmbeddings ?? false, storagePath);
      break;
    }
  }

  const stat = await fs.stat(outputPath);
  const sizeKB = (stat.size / 1024).toFixed(1);
  console.log(`  Written to: ${outputPath} (${sizeKB} KB)`);

  // KuzuDB holds a native handle that prevents Node from exiting — close it explicitly.
  await closeKuzu();
  process.exit(0);
}
// test change Sat Mar 14 13:53:24 UTC 2026

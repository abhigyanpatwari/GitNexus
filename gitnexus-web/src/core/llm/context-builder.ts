/**
 * Context Builder for Graph RAG Agent
 *
 * Generates dynamic context about the loaded codebase to inject into the system prompt.
 * This helps the LLM understand the project structure, scale, and key entry points
 * without needing to explore from scratch.
 */

/**
 * Codebase statistics
 */
export interface CodebaseStats {
  projectName: string;
  fileCount: number;
  functionCount: number;
  classCount: number;
  interfaceCount: number;
  methodCount: number;
}

/**
 * Hotspot - highly connected node
 */
export interface Hotspot {
  name: string;
  type: string;
  filePath: string;
  connections: number;
}

/**
 * Folder info for tree rendering
 */
interface FolderInfo {
  path: string;
  name: string;
  depth: number;
  fileCount: number;
  children: FolderInfo[];
}

/**
 * Complete codebase context for prompt injection
 * Simplified: stats + hotspots + folder tree (no entry points or language detection)
 */
export interface CodebaseContext {
  stats: CodebaseStats;
  hotspots: Hotspot[];
  folderTree: string;
}

/**
 * Get codebase statistics via Cypher queries
 */
export async function getCodebaseStats(
  executeQuery: (cypher: string) => Promise<any[]>,
  projectName: string,
): Promise<CodebaseStats> {
  try {
    // Count each node type
    const countQueries = [
      { type: 'files', query: 'MATCH (n:File) RETURN COUNT(n) AS count' },
      { type: 'functions', query: 'MATCH (n:Function) RETURN COUNT(n) AS count' },
      { type: 'classes', query: 'MATCH (n:Class) RETURN COUNT(n) AS count' },
      { type: 'interfaces', query: 'MATCH (n:Interface) RETURN COUNT(n) AS count' },
      { type: 'methods', query: 'MATCH (n:Method) RETURN COUNT(n) AS count' },
    ];

    const counts: Record<string, number> = {};

    for (const { type, query } of countQueries) {
      try {
        const result = await executeQuery(query);
        // Handle both array and object result formats
        const row = result[0];
        counts[type] = Array.isArray(row) ? (row[0] ?? 0) : (row?.count ?? 0);
      } catch {
        counts[type] = 0;
      }
    }

    return {
      projectName,
      fileCount: counts.files,
      functionCount: counts.functions,
      classCount: counts.classes,
      interfaceCount: counts.interfaces,
      methodCount: counts.methods,
    };
  } catch (error) {
    console.error('Failed to get codebase stats:', error);
    return {
      projectName,
      fileCount: 0,
      functionCount: 0,
      classCount: 0,
      interfaceCount: 0,
      methodCount: 0,
    };
  }
}

/**
 * Find hotspots - nodes with the most connections
 */
export async function getHotspots(
  executeQuery: (cypher: string) => Promise<any[]>,
  limit: number = 8,
): Promise<Hotspot[]> {
  try {
    // Find nodes with most edges (both directions)
    const query = `
      MATCH (n)-[r:CodeRelation]-(m)
      WHERE n.name IS NOT NULL
      WITH n, COUNT(r) AS connections
      ORDER BY connections DESC
      LIMIT ${limit}
      RETURN n.name AS name, LABEL(n) AS type, n.filePath AS filePath, connections
    `;

    const results = await executeQuery(query);

    return results
      .map((row) => {
        if (Array.isArray(row)) {
          return {
            name: row[0],
            type: row[1],
            filePath: row[2],
            connections: row[3],
          };
        }
        return {
          name: row.name,
          type: row.type,
          filePath: row.filePath,
          connections: row.connections,
        };
      })
      .filter((h) => h.name && h.type);
  } catch (error) {
    console.error('Failed to get hotspots:', error);
    return [];
  }
}

/**
 * Build folder tree structure from file paths
 * Returns ASCII tree format with smart truncation for readability
 */
export async function getFolderTree(
  executeQuery: (cypher: string) => Promise<any[]>,
  maxDepth: number = 10,
): Promise<string> {
  try {
    // Get all file paths
    const query = 'MATCH (f:File) RETURN f.filePath AS path ORDER BY path';
    const results = await executeQuery(query);

    const paths = results
      .map((row) => {
        if (Array.isArray(row)) return row[0];
        return row.path;
      })
      .filter(Boolean);

    if (paths.length === 0) return '';

    // Use hybrid ASCII format: clear hierarchy with smart truncation
    return formatAsHybridAscii(paths, maxDepth);
  } catch (error) {
    console.error('Failed to get folder tree:', error);
    return '';
  }
}

/**
 * Format paths as indented tree (TOON-style, no ASCII box chars)
 * Uses indentation only for hierarchy - more token efficient than ASCII tree
 * Shows complete structure with no truncation
 *
 * Example output:
 * src/
 *   components/ (45 files)
 *   hooks/
 *     useAppState.tsx
 *     useSigma.ts
 *   core/ (15 files)
 * test/ (12 files)
 */
function formatAsHybridAscii(paths: string[], maxDepth: number): string {
  // Build tree structure
  interface TreeNode {
    isFile: boolean;
    children: Map<string, TreeNode>;
    fileCount: number;
  }

  const root: TreeNode = { isFile: false, children: new Map(), fileCount: 0 };

  for (const path of paths) {
    const normalized = path.replace(/\\/g, '/');
    const parts = normalized.split('/').filter(Boolean);

    let current = root;
    for (let i = 0; i < parts.length; i++) {
      const part = parts[i];
      const isFile = i === parts.length - 1;

      if (!current.children.has(part)) {
        current.children.set(part, { isFile, children: new Map(), fileCount: 0 });
      }

      current = current.children.get(part)!;
      if (isFile) {
        // Count files in parent directories
        let parent = root;
        for (let j = 0; j < i; j++) {
          parent = parent.children.get(parts[j])!;
          parent.fileCount++;
        }
      }
    }
  }

  // Render tree with indentation only (no ASCII box chars)
  const lines: string[] = [];

  function renderNode(node: TreeNode, indent: string, depth: number): void {
    const entries = [...node.children.entries()];
    // Sort: folders first (by file count desc), then files alphabetically
    entries.sort(([aName, aNode], [bName, bNode]) => {
      if (aNode.isFile !== bNode.isFile) return aNode.isFile ? 1 : -1;
      if (!aNode.isFile && !bNode.isFile) return bNode.fileCount - aNode.fileCount;
      return aName.localeCompare(bName);
    });

    for (const [name, childNode] of entries) {
      if (childNode.isFile) {
        // File
        lines.push(`${indent}${name}`);
      } else {
        // Directory
        const childCount = childNode.children.size;
        const fileCount = childNode.fileCount;

        // Only collapse if beyond maxDepth
        if (depth >= maxDepth) {
          lines.push(`${indent}${name}/ (${fileCount} files)`);
        } else {
          lines.push(`${indent}${name}/`);
          renderNode(childNode, indent + '  ', depth + 1);
        }
      }
    }
  }

  renderNode(root, '', 0);

  return lines.join('\n');
}

/**
 * Build a tree structure from file paths
 */
function buildTreeFromPaths(paths: string[], maxDepth: number): Map<string, any> {
  const root = new Map<string, any>();

  for (const fullPath of paths) {
    // Normalize path separators
    const normalizedPath = fullPath.replace(/\\/g, '/');
    const parts = normalizedPath.split('/').filter(Boolean);

    let current = root;
    const depth = Math.min(parts.length, maxDepth + 1); // +1 to include files at maxDepth

    for (let i = 0; i < depth; i++) {
      const part = parts[i];
      const isFile = i === parts.length - 1;

      if (!current.has(part)) {
        current.set(part, isFile ? null : new Map<string, any>());
      }

      const next = current.get(part);
      if (next instanceof Map) {
        current = next;
      } else {
        break;
      }
    }
  }

  return root;
}

/**
 * Format tree as ASCII (like VS Code sidebar)
 */
function formatTreeAsAscii(tree: Map<string, any>, prefix: string, isLast: boolean = true): string {
  const lines: string[] = [];
  const entries = Array.from(tree.entries());

  // Sort: folders first, then files, alphabetically
  entries.sort(([a, aVal], [b, bVal]) => {
    const aIsDir = aVal instanceof Map;
    const bIsDir = bVal instanceof Map;
    if (aIsDir !== bIsDir) return bIsDir ? 1 : -1;
    return a.localeCompare(b);
  });

  entries.forEach(([name, subtree], index) => {
    const isLastItem = index === entries.length - 1;
    const connector = isLastItem ? '└── ' : '├── ';
    const childPrefix = prefix + (isLastItem ? '    ' : '│   ');

    if (subtree instanceof Map && subtree.size > 0) {
      // Folder with children
      const childCount = countItems(subtree);
      const annotation = childCount > 3 ? ` (${childCount} items)` : '';
      lines.push(`${prefix}${connector}${name}/${annotation}`);
      lines.push(formatTreeAsAscii(subtree, childPrefix, isLastItem));
    } else if (subtree instanceof Map) {
      // Empty folder
      lines.push(`${prefix}${connector}${name}/`);
    } else {
      // File
      lines.push(`${prefix}${connector}${name}`);
    }
  });

  return lines.filter(Boolean).join('\n');
}

/**
 * Count items in a tree node
 */
function countItems(tree: Map<string, any>): number {
  let count = 0;
  for (const [, value] of tree) {
    if (value instanceof Map) {
      count += 1 + countItems(value);
    } else {
      count += 1;
    }
  }
  return count;
}

/**
 * Build complete codebase context
 */
export async function buildCodebaseContext(
  executeQuery: (cypher: string) => Promise<any[]>,
  projectName: string,
): Promise<CodebaseContext> {
  // Run all queries in parallel for speed
  const [stats, hotspots, folderTree] = await Promise.all([
    getCodebaseStats(executeQuery, projectName),
    getHotspots(executeQuery),
    getFolderTree(executeQuery),
  ]);

  return {
    stats,
    hotspots,
    folderTree,
  };
}

/**
 * Format context as markdown for prompt injection
 */
export function formatContextForPrompt(context: CodebaseContext): string {
  const { stats, hotspots, folderTree } = context;

  const lines: string[] = [];

  // Project header with stats
  lines.push(`### 📊 CODEBASE: ${stats.projectName}`);

  const statParts = [
    `Files: ${stats.fileCount}`,
    `Functions: ${stats.functionCount}`,
    stats.classCount > 0 ? `Classes: ${stats.classCount}` : null,
    stats.interfaceCount > 0 ? `Interfaces: ${stats.interfaceCount}` : null,
  ].filter(Boolean);
  lines.push(statParts.join(' | '));
  lines.push('');

  // Hotspots
  if (hotspots.length > 0) {
    lines.push('**Hotspots** (most connected):');
    hotspots.slice(0, 5).forEach((h) => {
      lines.push(`- \`${h.name}\` (${h.type}) — ${h.connections} edges`);
    });
    lines.push('');
  }

  // Folder tree
  if (folderTree) {
    lines.push('### 📁 STRUCTURE');
    lines.push('```');
    lines.push(stats.projectName + '/');
    lines.push(folderTree);
    lines.push('```');
  }

  return lines.join('\n');
}

/**
 * Build the complete dynamic system prompt
 * Context is appended at the END so core instructions remain at the top
 */
export function buildDynamicSystemPrompt(basePrompt: string, context: CodebaseContext): string {
  const contextSection = formatContextForPrompt(context);

  // Append context at the END - keeps core instructions at top for better adherence
  return `${basePrompt}

---

## 📦 CURRENT CODEBASE
${contextSection}`;
}

import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { parse as parseJsonc } from 'jsonc-parser';
import { load as parseYaml } from 'js-yaml';
import type { GraphNode, GraphRelationship } from 'gitnexus-shared';

export type GovernanceSurfaceKind =
  | 'mcp'
  | 'cedar'
  | 'surfaces'
  | 'veritas-acta'
  | 'agt'
  | 'scopeblind'
  | 'generic';

export type SensitiveOperationKind = 'network' | 'exec' | 'filesystem-write' | 'secret-access';

export interface GovernanceConstraint {
  id: string;
  title: string;
  kind: string;
  sourcePath: string;
  sourceField?: string;
  appliesTo: SensitiveOperationKind[] | ['all'];
  details?: Record<string, unknown>;
}

export interface GovernanceSurface {
  id: string;
  kind: GovernanceSurfaceKind;
  path: string;
  parser: 'json' | 'jsonc' | 'yaml' | 'cedar' | 'text';
  sha256: string;
  constraints: GovernanceConstraint[];
  parseError?: string;
}

export interface SensitiveOperation {
  id: string;
  kind: SensitiveOperationKind;
  path: string;
  line: number;
  column: number;
  matched: string;
  evidence: string;
}

export interface GovernanceGraphPatch {
  nodes: GraphNode[];
  relationships: GraphRelationship[];
}

export interface GovernanceDetectionReport {
  root: string;
  surfaces: GovernanceSurface[];
  operations: SensitiveOperation[];
  graphPatch: GovernanceGraphPatch;
  contextMarkdown: string;
}

export interface GovernanceDetectionOptions {
  maxFiles?: number;
  maxFileBytes?: number;
}

const DEFAULT_MAX_FILES = 5000;
const DEFAULT_MAX_FILE_BYTES = 512 * 1024;

const SKIP_DIRS = new Set([
  '.git',
  '.gitnexus',
  'node_modules',
  'dist',
  'build',
  'coverage',
  '.next',
  '.venv',
  '__pycache__',
]);

const SOURCE_EXTENSIONS = new Set([
  '.cjs',
  '.cs',
  '.go',
  '.java',
  '.js',
  '.jsx',
  '.mjs',
  '.php',
  '.py',
  '.rb',
  '.rs',
  '.sh',
  '.ts',
  '.tsx',
]);

const SENSITIVE_PATTERNS: Array<{
  kind: SensitiveOperationKind;
  re: RegExp;
  label: string;
}> = [
  { kind: 'network', re: /\bfetch\s*\(/g, label: 'fetch()' },
  { kind: 'network', re: /\baxios\s*\./g, label: 'axios' },
  { kind: 'network', re: /\b(requests|httpx)\s*\./g, label: 'python http client' },
  { kind: 'network', re: /\b(WebSocket|EventSource)\s*\(/g, label: 'browser socket' },
  {
    kind: 'network',
    re: /\b(net|tls|http|https)\.(request|get|createServer|connect)\s*\(/g,
    label: 'node network',
  },
  { kind: 'exec', re: /\b(exec|execFile|spawn|spawnSync)\s*\(/g, label: 'child process' },
  { kind: 'exec', re: /\bchild_process\b/g, label: 'child_process module' },
  {
    kind: 'exec',
    re: /\b(subprocess|os)\.(run|Popen|system|execv|spawn)/g,
    label: 'python process',
  },
  {
    kind: 'filesystem-write',
    re: /\b(writeFile|writeFileSync|appendFile|appendFileSync|createWriteStream)\s*\(/g,
    label: 'node fs write',
  },
  {
    kind: 'filesystem-write',
    re: /\bopen\s*\([^\n]*(?:['"]w['"]|['"]a['"])/g,
    label: 'python file write',
  },
  {
    kind: 'secret-access',
    re: /\b(process\.env|Deno\.env|getenv|os\.environ)\b/g,
    label: 'environment secret access',
  },
];

export function detectGovernance(
  repoRoot: string,
  opts: GovernanceDetectionOptions = {},
): GovernanceDetectionReport {
  const root = path.resolve(repoRoot);
  const files = listCandidateFiles(root, opts);
  const surfaces = files.flatMap((file) => detectSurface(root, file));
  const operations = scanSensitiveOperations(root, files, opts);
  const graphPatch = buildGovernanceGraphPatch(surfaces, operations);
  return {
    root,
    surfaces,
    operations,
    graphPatch,
    contextMarkdown: formatGovernanceContext({ root, surfaces, operations, graphPatch }),
  };
}

export function buildGovernanceGraphPatch(
  surfaces: GovernanceSurface[],
  operations: SensitiveOperation[],
): GovernanceGraphPatch {
  const nodes: GraphNode[] = [];
  const relationships: GraphRelationship[] = [];

  for (const surface of surfaces) {
    nodes.push({
      id: `governance:surface:${surface.id}`,
      label: 'CodeElement',
      properties: {
        name: `Governance surface: ${surface.path}`,
        filePath: surface.path,
        governanceKind: surface.kind,
        governanceParser: surface.parser,
        governanceSha256: surface.sha256,
        governanceConstraintCount: surface.constraints.length,
        governanceParseError: surface.parseError,
      },
    });

    for (const constraint of surface.constraints) {
      nodes.push({
        id: `governance:constraint:${constraint.id}`,
        label: 'CodeElement',
        properties: {
          name: constraint.title,
          filePath: constraint.sourcePath,
          governanceKind: 'constraint',
          constraintKind: constraint.kind,
          appliesTo: constraint.appliesTo,
          sourceField: constraint.sourceField,
          details: constraint.details,
        },
      });
      relationships.push({
        id: `governance-rel:${surface.id}:defines:${constraint.id}`,
        sourceId: `governance:surface:${surface.id}`,
        targetId: `governance:constraint:${constraint.id}`,
        type: 'DEFINES',
        confidence: 1,
        reason: 'governance-surface-defines-constraint',
      });
    }
  }

  for (const operation of operations) {
    nodes.push({
      id: `governance:operation:${operation.id}`,
      label: 'CodeElement',
      properties: {
        name: `${operation.kind}: ${operation.matched}`,
        filePath: operation.path,
        startLine: operation.line,
        endLine: operation.line,
        governanceKind: 'sensitive-operation',
        operationKind: operation.kind,
        evidence: operation.evidence,
      },
    });

    for (const surface of surfaces) {
      for (const constraint of surface.constraints) {
        if (!constraintAppliesToOperation(constraint, operation)) continue;
        relationships.push({
          id: `governance-rel:${operation.id}:uses:${constraint.id}`,
          sourceId: `governance:operation:${operation.id}`,
          targetId: `governance:constraint:${constraint.id}`,
          type: 'USES',
          confidence: 0.75,
          reason: `governance-boundary-applies:${constraint.kind}`,
        });
      }
    }
  }

  return { nodes, relationships };
}

export function formatGovernanceContext(
  report: Omit<GovernanceDetectionReport, 'contextMarkdown'>,
): string {
  const lines = [
    '## Governance boundaries detected by GitNexus',
    '',
    `Repository: ${report.root}`,
    `Governance surfaces: ${report.surfaces.length}`,
    `Sensitive operations: ${report.operations.length}`,
    `Graph patch: ${report.graphPatch.nodes.length} nodes, ${report.graphPatch.relationships.length} edges`,
    '',
  ];

  if (report.surfaces.length > 0) {
    lines.push('### Policy/config surfaces');
    for (const surface of report.surfaces) {
      const status = surface.parseError
        ? `parse warning: ${surface.parseError}`
        : `${surface.constraints.length} constraints`;
      lines.push(`- ${surface.path} (${surface.kind}, ${status})`);
    }
    lines.push('');
  }

  if (report.operations.length > 0) {
    lines.push('### Sensitive code paths');
    for (const operation of report.operations.slice(0, 25)) {
      lines.push(
        `- ${operation.path}:${operation.line} ${operation.kind} via ${operation.matched}`,
      );
    }
    if (report.operations.length > 25) lines.push(`- ... ${report.operations.length - 25} more`);
    lines.push('');
  }

  lines.push('### Agent guidance');
  if (report.surfaces.length === 0) {
    lines.push(
      '- No repository governance files were detected. Do not infer network, exec, or write permissions from GitNexus context alone.',
    );
  } else {
    lines.push(
      '- Treat these governance files as first-class repository context when editing sensitive code paths.',
    );
    lines.push(
      '- If a sensitive operation touches network, process execution, filesystem writes, or secrets, check the linked governance constraint before generating code.',
    );
    lines.push(
      '- This report is advisory: enforcement still belongs to the runtime hook, policy engine, gateway, or CI job that owns the boundary.',
    );
  }

  return `${lines.join('\n')}\n`;
}

function detectSurface(root: string, absPath: string): GovernanceSurface[] {
  const rel = relativePath(root, absPath);
  const base = path.basename(rel).toLowerCase();
  const normalized = rel.split(path.sep).join('/').toLowerCase();
  const kind = classifySurface(normalized, base);
  if (kind === null) return [];

  const raw = readFileSync(absPath, 'utf8');
  const parser = parserForPath(absPath, kind);
  const surface: GovernanceSurface = {
    id: stableId(rel),
    kind,
    path: rel,
    parser,
    sha256: sha256(raw),
    constraints: [],
  };

  try {
    if (parser === 'cedar') {
      surface.constraints = constraintsFromCedar(surface, raw);
    } else if (parser === 'yaml') {
      surface.constraints = constraintsFromObject(surface, parseYaml(raw), []);
    } else if (parser === 'json' || parser === 'jsonc') {
      surface.constraints = constraintsFromObject(surface, parseJsonc(raw), []);
    } else {
      surface.constraints = constraintsFromText(surface, raw);
    }
  } catch (err) {
    surface.parseError = err instanceof Error ? err.message : String(err);
    surface.constraints = [
      {
        id: `${surface.id}:parse-warning`,
        title: `Governance file present but could not be parsed: ${rel}`,
        kind: 'parse-warning',
        sourcePath: rel,
        appliesTo: ['all'],
      },
    ];
  }

  if (surface.constraints.length === 0) {
    surface.constraints = [
      {
        id: `${surface.id}:presence`,
        title: `Governance surface present: ${rel}`,
        kind: `${kind}:presence`,
        sourcePath: rel,
        appliesTo: ['all'],
      },
    ];
  }

  return [surface];
}

function classifySurface(normalized: string, base: string): GovernanceSurfaceKind | null {
  if (base === '.mcp.json' || base === '.mcp.jsonc' || base === 'mcp.json') return 'mcp';
  if (base === 'surfaces.yaml' || base === 'surfaces.yml' || base === '.surfaces.yaml')
    return 'surfaces';
  if (base.endsWith('.cedar')) return 'cedar';
  if (normalized.includes('.veritasacta/') || base === 'veritasacta.config.json')
    return 'veritas-acta';
  if (normalized.includes('.scopeblind/') || base === 'protect-mcp.config.json')
    return 'scopeblind';
  if (
    base === 'agent-governance.json' ||
    base === '.agent-governance.json' ||
    normalized.includes('agent-governance')
  )
    return 'agt';
  return null;
}

function parserForPath(absPath: string, kind: GovernanceSurfaceKind): GovernanceSurface['parser'] {
  if (kind === 'cedar') return 'cedar';
  const ext = path.extname(absPath).toLowerCase();
  if (ext === '.yaml' || ext === '.yml') return 'yaml';
  if (ext === '.jsonc') return 'jsonc';
  if (ext === '.json') return 'json';
  return 'text';
}

function constraintsFromCedar(surface: GovernanceSurface, raw: string): GovernanceConstraint[] {
  const constraints: GovernanceConstraint[] = [];
  const policyCount = (raw.match(/\b(?:permit|forbid)\s*\(/g) || []).length;
  if (policyCount > 0) {
    constraints.push({
      id: `${surface.id}:cedar-policy-set`,
      title: `Cedar policy set (${policyCount} policies)`,
      kind: 'cedar-policy-set',
      sourcePath: surface.path,
      appliesTo: ['all'],
      details: { policyCount },
    });
  }
  return constraints;
}

function constraintsFromText(surface: GovernanceSurface, raw: string): GovernanceConstraint[] {
  if (raw.trim().length === 0) return [];
  return [
    {
      id: `${surface.id}:text-policy`,
      title: `Text governance surface: ${surface.path}`,
      kind: 'text-policy',
      sourcePath: surface.path,
      appliesTo: ['all'],
    },
  ];
}

function constraintsFromObject(
  surface: GovernanceSurface,
  value: unknown,
  pathParts: string[],
): GovernanceConstraint[] {
  const constraints: GovernanceConstraint[] = [];
  if (value === null || value === undefined) return constraints;

  if (Array.isArray(value)) {
    value.forEach((item, index) =>
      constraints.push(...constraintsFromObject(surface, item, [...pathParts, String(index)])),
    );
    return constraints;
  }

  if (typeof value !== 'object') return constraints;
  const obj = value as Record<string, unknown>;

  if (surface.kind === 'mcp' && pathParts.length === 0 && isRecord(obj.mcpServers)) {
    for (const serverName of Object.keys(obj.mcpServers).sort()) {
      constraints.push({
        id: `${surface.id}:mcp-server:${stableId(serverName)}`,
        title: `MCP server boundary: ${serverName}`,
        kind: 'mcp-server',
        sourcePath: surface.path,
        sourceField: `mcpServers.${serverName}`,
        appliesTo: ['exec', 'filesystem-write', 'network'],
        details: { serverName },
      });
    }
  }

  for (const [key, nested] of Object.entries(obj)) {
    const fieldPath = [...pathParts, key].join('.');
    const keyNorm = key.toLowerCase();
    const scalarValues = collectScalarPreview(nested);
    const appliesTo = appliesToForKey(keyNorm);
    if (appliesTo !== null) {
      constraints.push({
        id: `${surface.id}:field:${stableId(fieldPath)}`,
        title: `${surface.kind} constraint: ${fieldPath}`,
        kind: keyNorm,
        sourcePath: surface.path,
        sourceField: fieldPath,
        appliesTo,
        details: scalarValues.length > 0 ? { values: scalarValues } : undefined,
      });
    }
    constraints.push(...constraintsFromObject(surface, nested, [...pathParts, key]));
  }

  return dedupeConstraints(constraints);
}

function appliesToForKey(keyNorm: string): GovernanceConstraint['appliesTo'] | null {
  if (
    keyNorm.includes('host') ||
    keyNorm.includes('url') ||
    keyNorm.includes('network') ||
    keyNorm.includes('egress')
  )
    return ['network'];
  if (
    keyNorm.includes('command') ||
    keyNorm.includes('exec') ||
    keyNorm.includes('shell') ||
    keyNorm.includes('subprocess')
  )
    return ['exec'];
  if (
    keyNorm.includes('write') ||
    keyNorm.includes('filesystem') ||
    keyNorm.includes('path') ||
    keyNorm.includes('workspace')
  )
    return ['filesystem-write'];
  if (
    keyNorm.includes('secret') ||
    keyNorm.includes('env') ||
    keyNorm.includes('token') ||
    keyNorm.includes('credential')
  )
    return ['secret-access'];
  if (
    keyNorm.includes('receipt') ||
    keyNorm.includes('sign') ||
    keyNorm.includes('policy') ||
    keyNorm.includes('cedar') ||
    keyNorm.includes('sandbox') ||
    keyNorm.includes('scope')
  )
    return ['all'];
  return null;
}

function scanSensitiveOperations(
  root: string,
  files: string[],
  opts: GovernanceDetectionOptions,
): SensitiveOperation[] {
  const maxFileBytes = opts.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES;
  const operations: SensitiveOperation[] = [];
  for (const absPath of files) {
    const ext = path.extname(absPath).toLowerCase();
    if (!SOURCE_EXTENSIONS.has(ext)) continue;
    const st = statSync(absPath);
    if (st.size > maxFileBytes) continue;
    const rel = relativePath(root, absPath);
    const raw = readFileSync(absPath, 'utf8');
    const lines = raw.split(/\r?\n/);
    lines.forEach((line, index) => {
      for (const pattern of SENSITIVE_PATTERNS) {
        pattern.re.lastIndex = 0;
        let match: RegExpExecArray | null;
        while ((match = pattern.re.exec(line)) !== null) {
          operations.push({
            id: stableId(`${rel}:${index + 1}:${match.index + 1}:${pattern.kind}:${match[0]}`),
            kind: pattern.kind,
            path: rel,
            line: index + 1,
            column: match.index + 1,
            matched: pattern.label,
            evidence: line.trim().slice(0, 240),
          });
        }
      }
    });
  }
  return operations;
}

function constraintAppliesToOperation(
  constraint: GovernanceConstraint,
  operation: SensitiveOperation,
): boolean {
  const appliesTo = constraint.appliesTo as readonly string[];
  return appliesTo.includes('all') || appliesTo.includes(operation.kind);
}

function listCandidateFiles(root: string, opts: GovernanceDetectionOptions): string[] {
  const maxFiles = opts.maxFiles ?? DEFAULT_MAX_FILES;
  const out: string[] = [];
  const walk = (dir: string): void => {
    if (out.length >= maxFiles) return;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (out.length >= maxFiles) return;
      const absPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) walk(absPath);
      } else if (entry.isFile()) {
        out.push(absPath);
      }
    }
  };
  if (existsSync(root)) walk(root);
  return out.sort();
}

function relativePath(root: string, absPath: string): string {
  return path.relative(root, absPath).split(path.sep).join('/');
}

function stableId(input: string): string {
  return (
    input
      .replace(/[^a-zA-Z0-9._-]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 96) || sha256(input).slice(0, 12)
  );
}

function sha256(input: string | Buffer): string {
  return createHash('sha256').update(input).digest('hex');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function collectScalarPreview(value: unknown): string[] {
  const out: string[] = [];
  const visit = (item: unknown): void => {
    if (out.length >= 8) return;
    if (typeof item === 'string' || typeof item === 'number' || typeof item === 'boolean') {
      out.push(String(item));
    } else if (Array.isArray(item)) {
      for (const child of item) visit(child);
    }
  };
  visit(value);
  return out;
}

function dedupeConstraints(constraints: GovernanceConstraint[]): GovernanceConstraint[] {
  const seen = new Set<string>();
  return constraints.filter((constraint) => {
    if (seen.has(constraint.id)) return false;
    seen.add(constraint.id);
    return true;
  });
}

const MERMAID_FENCE_RE = /```mermaid\s*\n([\s\S]*?)```/g;
const NODE_LABEL_RE =
  /(\[[^\]\n]*(?:\\n)[^\]\n]*\]|\{[^}\n]*(?:\\n)[^}\n]*\}|\([^)\n]*(?:\\n)[^)\n]*\))/g;
const EDGE_LABEL_RE = /\|([^|\n]+)\|/g;
const UNSAFE_EDGE_LABEL_RE = /[()[\]{}<>]/;
const UNSAFE_NODE_ID_RE = /[^A-Za-z0-9_-]/;
const NODE_ID_RE = /^[A-Za-z0-9_.:/()-]+$/;

const LINE_PREFIX_RE = /^(\s*(?:(?:[-A-Za-z0-9_]+)\s*:\s*)?)(.*)$/;
const EDGE_RE =
  /(\s*(?:[ox])?(?:--+|==+|\.\.+)(?:[>|ox])?\|[^|\n]*\|(?:[>|ox])?|\s*(?:[ox])?(?:--+|==+|\.\.+)(?:[>|ox])?|\s*<--+>?\s*)/g;

export function sanitizeMermaidMarkdown(markdown: string): string {
  return markdown.replace(MERMAID_FENCE_RE, (_match, diagram: string) => {
    return '```mermaid\n' + sanitizeMermaidDiagram(diagram) + '```';
  });
}

export function sanitizeMermaidDiagram(diagram: string): string {
  const aliases = new Map<string, string>();
  let nextAlias = 1;

  const aliasFor = (id: string): string => {
    const existing = aliases.get(id);
    if (existing) return existing;

    const base = id.replace(/[^A-Za-z0-9_-]/g, '_').replace(/^_+|_+$/g, '') || 'node';
    let alias = base;
    while ([...aliases.values()].includes(alias)) {
      nextAlias += 1;
      alias = `${base}_${nextAlias}`;
    }
    aliases.set(id, alias);
    return alias;
  };

  return diagram
    .split('\n')
    .map((line) => sanitizeMermaidLine(line, aliasFor))
    .join('\n');
}

function sanitizeMermaidLine(line: string, aliasFor: (id: string) => string): string {
  let sanitized = replaceLiteralLineBreaksInLabels(line);
  sanitized = quoteUnsafeEdgeLabels(sanitized);

  const prefixMatch = sanitized.match(LINE_PREFIX_RE);
  if (!prefixMatch) return sanitized;

  const prefix = prefixMatch[1];
  const body = prefixMatch[2];
  if (isDirectiveLine(body)) return sanitized;

  const parts = body.split(EDGE_RE);
  if (parts.length === 1) return sanitized;

  for (let i = 0; i < parts.length; i += 2) {
    parts[i] = sanitizeNodeReference(parts[i], aliasFor);
  }

  return prefix + parts.join('');
}

function replaceLiteralLineBreaksInLabels(line: string): string {
  return line.replace(NODE_LABEL_RE, (label) => label.replace(/\\n/g, '<br/>'));
}

function quoteUnsafeEdgeLabels(line: string): string {
  return line.replace(EDGE_LABEL_RE, (match, label: string) => {
    const trimmed = label.trim();
    if (!UNSAFE_EDGE_LABEL_RE.test(trimmed)) return match;
    if (
      (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
      (trimmed.startsWith("'") && trimmed.endsWith("'"))
    ) {
      return match;
    }
    return `|"${escapeMermaidLabel(trimmed)}"|`;
  });
}

function sanitizeNodeReference(segment: string, aliasFor: (id: string) => string): string {
  const match = segment.match(/^(\s*)([A-Za-z0-9_.:/()-]+)(.*?)(\s*)$/);
  if (!match) return segment;

  const [, leading, id, suffix, trailing] = match;
  if (!NODE_ID_RE.test(id) || !UNSAFE_NODE_ID_RE.test(id)) return segment;
  const hasInlineLabel =
    suffix.trim().startsWith('[') || suffix.trim().startsWith('(') || suffix.trim().startsWith('{');

  if (hasInlineLabel) return `${leading}${aliasFor(id)}${suffix}${trailing}`;

  return `${leading}${aliasFor(id)}["${escapeMermaidLabel(id)}"]${suffix}${trailing}`;
}

function escapeMermaidLabel(label: string): string {
  return label.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

function isDirectiveLine(line: string): boolean {
  const trimmed = line.trim();
  return (
    trimmed === '' ||
    trimmed.startsWith('%%') ||
    trimmed.startsWith('graph ') ||
    trimmed.startsWith('flowchart ') ||
    trimmed.startsWith('sequenceDiagram') ||
    trimmed.startsWith('classDiagram') ||
    trimmed.startsWith('stateDiagram') ||
    trimmed.startsWith('erDiagram') ||
    trimmed.startsWith('journey') ||
    trimmed.startsWith('gantt') ||
    trimmed.startsWith('pie ') ||
    trimmed.startsWith('mindmap') ||
    trimmed.startsWith('timeline') ||
    trimmed.startsWith('subgraph ') ||
    trimmed === 'end'
  );
}

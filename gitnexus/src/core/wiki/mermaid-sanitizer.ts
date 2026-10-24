const MERMAID_FENCE_RE = /```mermaid\s*\n([\s\S]*?)```/g;
const NODE_LABEL_RE =
  /(\[[^\]\n]*(?:\\n)[^\]\n]*\]|\{[^}\n]*(?:\\n)[^}\n]*\}|\([^)\n]*(?:\\n)[^)\n]*\))/g;
const EDGE_LABEL_RE = /\|([^|\n]+)\|/g;
const UNSAFE_EDGE_LABEL_RE = /[()[\]{}<>]/;
const UNSAFE_NODE_ID_RE = /[^A-Za-z0-9_-]/;
const NODE_ID_RE = /^[A-Za-z0-9_.:/()-]+$/;

const LINE_PREFIX_RE = /^(\s*(?:(?:[-A-Za-z0-9_]+)\s*:\s*)?)(.*)$/;
// One link between two node references, in the forms Mermaid accepts: a
// plain, thick or dotted link (`-->`, `===`, `-.->`), a piped label after it
// (`-->|text|`), or a label inside it (`-- text -->`, `== text ==>`,
// `-. text .->`). The labelled forms are matched whole, so their text is
// never taken for a node reference (#3705). Dots mean a link only in the
// dotted syntax: a plain run of dots is text.
//
// A labelled link opens with a bare `--`, `==` or `-.` followed by its text,
// with or without a space (`-- text -->`, `--text-->`). A complete link never
// opens one. Mermaid's lexer takes the longer match, so `--` followed by
// `-`, `>`, `x` or `o` is a link with a tail (`---`, `-->`, `--x`, `--o`),
// whatever comes after it: `A --xfile.ts --> B` is a chain of three nodes,
// and `file.ts` reaches the node sanitizer like any other reference.
const LINK_HEAD = '(?:--+|==+|-\\.+-?)';
const LABEL_OPENER = '(?:--|==|-\\.)(?![-=.>|xo])';
const EDGE_RE = new RegExp(
  '(' +
    [
      // `-- text -->`, `--text-->`, `== text ==>`, `-. text .->`
      `\\s*(?:[ox<])?${LABEL_OPENER}[^\\n]*?\\s*(?:--+|==+|\\.+-+)(?:[>ox])?`,
      // `-->|text|`
      `\\s*(?:[ox<])?${LINK_HEAD}(?:[>|ox])?\\|[^|\\n]*\\|(?:[>|ox])?`,
      // `-->`, `---`, `-.->`, `==>`
      `\\s*(?:[ox<])?${LINK_HEAD}(?:[>|ox])?`,
      '\\s*<--+>?\\s*',
    ].join('|') +
    ')',
  'g',
);

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

  // Text inside quotes and inside node shapes is a label, not syntax: it is
  // hidden from the split so a `...` or a `--` in it cannot read as a link,
  // and from the node sanitizer so it cannot read as a node (#3705).
  const { masked, labels } = maskLabels(body);
  const parts = masked.split(EDGE_RE);
  if (parts.length === 1) return sanitized;

  for (let i = 0; i < parts.length; i += 2) {
    parts[i] = sanitizeNodeReference(parts[i], aliasFor, labels);
  }

  return prefix + unmaskLabels(parts.join(''), labels);
}

const MASK = '\u0000';
const MASK_RE = /\u0000(\d+)\u0000/g;
const OPENERS: Record<string, string> = { '[': ']', '(': ')', '{': '}' };

/**
 * Replace the inside of every quoted string and every bracketed label with a
 * placeholder, keeping the delimiters, so the shape of the line survives and
 * the node sanitizer still sees where an inline label starts.
 */
function maskLabels(body: string): { masked: string; labels: string[] } {
  const labels: string[] = [];
  let masked = '';
  let i = 0;
  while (i < body.length) {
    const char = body[i];
    const closer = OPENERS[char];
    if (char === '"' || closer) {
      const end = findLabelEnd(body, i, char === '"' ? '"' : closer, char === '"' ? null : char);
      if (end === -1) {
        masked += body.slice(i);
        break;
      }
      masked += char + MASK + labels.length + MASK + body[end];
      labels.push(body.slice(i + 1, end));
      i = end + 1;
      continue;
    }
    masked += char;
    i += 1;
  }
  return { masked, labels };
}

/** Index of the delimiter that closes the one at `start`, or -1. */
function findLabelEnd(body: string, start: number, closer: string, opener: string | null): number {
  let depth = 0;
  for (let i = start + 1; i < body.length; i += 1) {
    const char = body[i];
    if (opener === null) {
      // A quoted string ends at the next quote; brackets inside it are text.
      if (char === '"') return i;
      continue;
    }
    if (char === '"') {
      const quoteEnd = body.indexOf('"', i + 1);
      if (quoteEnd === -1) return -1;
      i = quoteEnd;
      continue;
    }
    if (char === opener) depth += 1;
    else if (char === closer) {
      if (depth === 0) return i;
      depth -= 1;
    }
  }
  return -1;
}

function unmaskLabels(masked: string, labels: string[]): string {
  return masked.replace(MASK_RE, (_match, index: string) => labels[Number(index)] ?? '');
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

// A masked, empty pair of parentheses right after an id: `doc()`, a
// call-shaped id the sanitizer has always repaired, not a round node. The
// member chain that may follow (`foo().bar`) belongs to the same id.
const EMPTY_PARENS_RE = /^\(\u0000(\d+)\u0000\)/;
const MEMBER_CHAIN_RE = /^[A-Za-z0-9_.:/-]+/;

function sanitizeNodeReference(
  segment: string,
  aliasFor: (id: string) => string,
  labels: string[],
): string {
  // The id stops where a node shape opens (`[`, `(`, `{`): `A(Start)` is the
  // node `A` with a round label, and the label is already masked.
  const match = segment.match(/^(\s*)([A-Za-z0-9_.:/-]+)(.*?)(\s*)$/);
  if (!match) return segment;

  const leading = match[1];
  const trailing = match[4];
  let id = match[2];
  let suffix = match[3];
  for (;;) {
    const emptyParens = suffix.match(EMPTY_PARENS_RE);
    if (!emptyParens || labels[Number(emptyParens[1])] !== '') break;
    id += '()';
    suffix = suffix.slice(emptyParens[0].length);
    const members = suffix.match(MEMBER_CHAIN_RE);
    if (members) {
      id += members[0];
      suffix = suffix.slice(members[0].length);
    }
  }
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

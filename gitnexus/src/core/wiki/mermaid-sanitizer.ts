const MERMAID_FENCE_RE = /```mermaid\s*\n([\s\S]*?)```/g;
const NODE_LABEL_RE =
  /(\[[^\]\n]*(?:\\n)[^\]\n]*\]|\{[^}\n]*(?:\\n)[^}\n]*\}|\([^)\n]*(?:\\n)[^)\n]*\))/g;
const EDGE_LABEL_RE = /\|([^|\n]+)\|/g;
const UNSAFE_EDGE_LABEL_RE = /[()[\]{}<>]/;
const UNSAFE_NODE_ID_RE = /[^A-Za-z0-9_-]/;
const NODE_ID_RE = /^[A-Za-z0-9_.:/()-]+$/;

const LINE_PREFIX_RE = /^(\s*)(.*)$/;
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
const EDGE_AT_RE = new RegExp(EDGE_RE.source, 'y');

export function sanitizeMermaidMarkdown(markdown: string): string {
  return markdown.replace(MERMAID_FENCE_RE, (_match, diagram: string) => {
    return '```mermaid\n' + sanitizeMermaidDiagram(diagram) + '```';
  });
}

export function sanitizeMermaidDiagram(diagram: string): string {
  const frontmatter = diagram.match(/^\s*---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/)?.[0] ?? '';
  const body = diagram.slice(frontmatter.length);
  const prelude = body.match(/^(?:\s|%%\{[\s\S]*?\}%%|%%[^\n]*(?:\n|$))*/)?.[0] ?? '';
  const content = body.slice(prelude.length);
  if (!/^(?:graph|flowchart)\s/.test(content)) return diagram;

  // Mask before splitting lines so multiline labels remain a single token.
  const { masked, labels } = maskLabels(content);
  const lines = masked.split('\n');
  const usedIds = new Set<string>();
  const labeledIds = new Set<string>();
  for (const line of lines) {
    sanitizeMermaidLine(
      line,
      (id, hasLabel) => {
        usedIds.add(id);
        if (hasLabel) labeledIds.add(id);
        return id;
      },
      labeledIds,
      labels,
    );
  }
  const aliases = new Map<string, string>();
  let nextAlias = 1;

  const aliasFor = (id: string): string => {
    if (!UNSAFE_NODE_ID_RE.test(id)) return id;
    const existing = aliases.get(id);
    if (existing) return existing;

    let base = id.replace(/[^A-Za-z0-9_-]/g, '_').replace(/^_+|_+$/g, '') || 'node';
    if (
      /^(?:style|classDef|class|click|linkStyle|direction|accTitle|accDescr|end)(?:-|$)/.test(base)
    ) {
      base = `node_${base}`;
    }
    let alias = base;
    while (usedIds.has(alias)) {
      nextAlias += 1;
      alias = `${base}_${nextAlias}`;
    }
    aliases.set(id, alias);
    usedIds.add(alias);
    return alias;
  };

  return (
    frontmatter +
    prelude +
    lines
      .map((line) => unmaskLabels(sanitizeMermaidLine(line, aliasFor, labeledIds, labels), labels))
      .join('\n')
  );
}

function sanitizeMermaidLine(
  line: string,
  aliasFor: (id: string, hasLabel?: boolean) => string,
  labeledIds: ReadonlySet<string>,
  labels: string[],
): string {
  const prefixMatch = line.match(LINE_PREFIX_RE);
  if (!prefixMatch) return line;

  const prefix = prefixMatch[1];
  const body = prefixMatch[2];
  const header = body.match(/^((?:graph|flowchart)\s+\w+\s*;)(.*)$/);
  if (header) {
    return prefix + header[1] + sanitizeMermaidLine(header[2], aliasFor, labeledIds, labels);
  }
  const reference = body.match(/^((?:style|class|click)\s+)([^\s]+)(.*)$/);
  if (reference) {
    const ids = reference[2].split(',').map((id) => aliasFor(id));
    return prefix + reference[1] + ids.join(',') + reference[3];
  }
  const subgraph = body.match(/^(subgraph\s+)([A-Za-z0-9_.:/-]+)(\s*(?:\[.*\])?\s*)$/);
  if (subgraph) {
    const [, keyword, id, suffix] = subgraph;
    const alias = aliasFor(id, true);
    const label = alias !== id && !suffix.trim() ? `["${escapeMermaidLabel(id)}"]` : '';
    return prefix + keyword + alias + label + suffix;
  }
  if (isDirectiveLine(body)) return line;

  // Text inside quotes and inside node shapes is a label, not syntax: it is
  // hidden from the split so a `...` or a `--` in it cannot read as a link,
  // and from the node sanitizer so it cannot read as a node (#3705).
  const parts = body.split(EDGE_RE);

  for (let i = 0; i < parts.length; i += 1) {
    if (i % 2 === 1) {
      parts[i] = quoteUnsafeEdgeLabels(unmaskLabels(parts[i], labels));
    } else {
      const nodes = parts[i].split(/([&;])/);
      for (let j = 0; j < nodes.length; j += 2) {
        nodes[j] = sanitizeNodeReference(nodes[j], aliasFor, labels, labeledIds);
      }
      parts[i] = replaceLiteralLineBreaksInLabels(unmaskLabels(nodes.join(''), labels));
    }
  }

  return prefix + parts.join('');
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
  // Protect quoted link text before recognising links; a quoted arrow is text.
  body = body.replace(/%%[^\n]*|"[^"]*"/g, (quoted) => {
    if (quoted.startsWith('%%')) return quoted;
    const index = labels.push(quoted.slice(1, -1)) - 1;
    return '"' + MASK + index + MASK + '"';
  });
  let masked = '';
  let i = 0;
  while (i < body.length) {
    if (body.startsWith('%%', i)) {
      const end = body.indexOf('\n', i);
      const next = end === -1 ? body.length : end;
      masked += body.slice(i, next);
      i = next;
      continue;
    }
    // Consume complete links before looking for shapes. A `>` in List<T>
    // belongs to the link label, not to an asymmetric node shape.
    EDGE_AT_RE.lastIndex = i;
    const edge = EDGE_AT_RE.exec(body);
    if (edge) {
      masked += edge[0];
      i += edge[0].length;
      continue;
    }
    const char = body[i];
    const closer =
      OPENERS[char] ?? (char === '>' && /[A-Za-z0-9_]/.test(body[i - 1] ?? '') ? ']' : undefined);
    if (closer) {
      const end = findLabelEnd(body, i, closer, char);
      if (end === -1) {
        masked += body.slice(i);
        break;
      }
      masked += char + MASK + labels.length + MASK + body[end];
      labels.push(unmaskLabels(body.slice(i + 1, end), labels));
      i = end + 1;
      continue;
    }
    masked += char;
    i += 1;
  }
  return { masked, labels };
}

/** Index of the delimiter that closes the one at `start`, or -1. */
function findLabelEnd(body: string, start: number, closer: string, opener: string): number {
  let depth = 0;
  for (let i = start + 1; i < body.length; i += 1) {
    const char = body[i];
    if (char === '"') {
      const quoteEnd = body.indexOf('"', i + 1);
      if (quoteEnd === -1) return -1;
      i = quoteEnd;
      continue;
    }
    if (char === opener && opener !== '>') depth += 1;
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
const MEMBER_CHAIN_RE = /^(?:(?!:::)[A-Za-z0-9_.:/-])+/;

function sanitizeNodeReference(
  segment: string,
  aliasFor: (id: string, hasLabel?: boolean) => string,
  labels: string[],
  labeledIds: ReadonlySet<string>,
): string {
  // The id stops where a node shape opens (`[`, `(`, `{`): `A(Start)` is the
  // node `A` with a round label, and the label is already masked.
  const match = segment.match(/^(\s*)((?:(?!:::)[A-Za-z0-9_.:/-])+)(.*?)(\s*)$/);
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
  if (!NODE_ID_RE.test(id)) return segment;
  const hasInlineLabel = /^[\[({>]/.test(suffix.trim()) || suffix.trim().startsWith('@{');
  const alias = aliasFor(id, hasInlineLabel);
  if (!UNSAFE_NODE_ID_RE.test(id)) return segment;

  const metadata = suffix.match(/^\s*@\{\u0000(\d+)\u0000\}/);
  if (metadata) {
    const content = labels[Number(metadata[1])];
    if (!/(?:^|,)\s*label\s*:/.test(content.replace(/"[^"]*"|'[^']*'/g, ''))) {
      suffix = suffix.replace(metadata[0], `@{ label: "${escapeMermaidLabel(id)}", ${content} }`);
    }
  }
  if (hasInlineLabel || labeledIds.has(id)) return `${leading}${alias}${suffix}${trailing}`;

  return `${leading}${alias}["${escapeMermaidLabel(id)}"]${suffix}${trailing}`;
}

function escapeMermaidLabel(label: string): string {
  return label.replace(/"/g, '#quot;');
}

function isDirectiveLine(line: string): boolean {
  const trimmed = line.trim();
  return (
    trimmed === '' ||
    trimmed.startsWith('%%') ||
    trimmed.startsWith('graph ') ||
    trimmed.startsWith('flowchart ') ||
    trimmed.startsWith('subgraph ') ||
    /^(?:style|classDef|class|click|linkStyle|direction|accTitle|accDescr)(?:\s|:|$)/.test(
      trimmed,
    ) ||
    trimmed === 'end'
  );
}

const MERMAID_FENCE_RE = /```mermaid\s*\n([\s\S]*?)```/g;
const NODE_LABEL_RE =
  /(\[[^\]\n]*(?:\\n)[^\]\n]*\]|\{[^}\n]*(?:\\n)[^}\n]*\}|\([^)\n]*(?:\\n)[^)\n]*\))/g;
const EDGE_LABEL_RE = /\|([^|\n]+)\|/g;
const UNSAFE_EDGE_LABEL_RE = /[()[\]{}<>]/;
const UNSAFE_NODE_ID_RE = /[^A-Za-z0-9_-]/;
const NODE_ID_RE = /^[A-Za-z0-9_.:/()-]+$/;
const FLOWCHART_HEADER_RE = /^\s*(?:graph|flowchart)\s+(?:TB|TD|BT|RL|LR)\b/i;

const LINE_PREFIX_RE = /^(\s*(?:(?:[-A-Za-z0-9_]+)\s*:\s*)?)(.*)$/;
const EDGE_RE =
  /(\s*(?:[ox])?(?:--+|==+|\.\.+)(?:[>|ox])?\|[^|\n]*\|(?:[>|ox])?|\s*(?:[ox])?(?:--+|==+|\.\.+)(?:[>|ox])?|\s*<--+>?\s*)/g;

export function sanitizeMermaidMarkdown(markdown: string): string {
  return markdown.replace(MERMAID_FENCE_RE, (_match, diagram: string) => {
    return '```mermaid\n' + sanitizeMermaidDiagram(diagram) + '```';
  });
}

export function sanitizeMermaidDiagram(diagram: string): string {
  const normalized = normalizeFlowchartStatements(diagram);
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

  return normalized
    .split('\n')
    .map((line) => sanitizeMermaidLine(line, aliasFor))
    .join('\n');
}

/**
 * Mermaid 11 对同一行内用分号连接的 flowchart 声明兼容性不稳定。
 * 生成模型常返回 `graph TD; A-->B;`，这里将语句确定性拆成逐行形式。
 */
function normalizeFlowchartStatements(diagram: string): string {
  // 遍历所有行查找 flowchart header，跳过 %% 注释和 %%{init:}%% 指令
  const headerLine = diagram.split('\n').find((line) => {
    const trimmed = line.trim();
    return trimmed !== '' && !trimmed.startsWith('%%');
  });
  if (!headerLine || !FLOWCHART_HEADER_RE.test(headerLine.trim())) return diagram;

  return splitOutsideLabels(diagram, ';')
    .map((statement) => statement.trim())
    .filter(Boolean)
    .join('\n')
    .concat('\n');
}

function splitOutsideLabels(value: string, separator: string): string[] {
  const result: string[] = [];
  let current = '';
  let quote: '"' | "'" | null = null;
  let escaped = false;
  let squareDepth = 0;
  let roundDepth = 0;
  let curlyDepth = 0;
  let inEdgeLabel = false;
  let inComment = false;

  for (let i = 0; i < value.length; i++) {
    const character = value[i];

    // Mermaid 行注释:进入 %% 后直到行尾的内容不参与分号拆分
    if (inComment) {
      current += character;
      if (character === '\n') inComment = false;
      continue;
    }

    if (escaped) {
      current += character;
      escaped = false;
      continue;
    }
    if (character === '\\') {
      current += character;
      escaped = true;
      continue;
    }
    if (
      character === '%' &&
      value[i + 1] === '%' &&
      quote === null &&
      squareDepth === 0 &&
      roundDepth === 0 &&
      curlyDepth === 0 &&
      !inEdgeLabel
    ) {
      inComment = true;
      current += '%%';
      i += 1;
      continue;
    }
    if (quote) {
      current += character;
      if (character === quote) quote = null;
      continue;
    }
    if (character === '"' || character === "'") {
      current += character;
      quote = character;
      continue;
    }
    if (character === '[') squareDepth += 1;
    else if (character === ']') squareDepth = Math.max(0, squareDepth - 1);
    else if (character === '(') roundDepth += 1;
    else if (character === ')') roundDepth = Math.max(0, roundDepth - 1);
    else if (character === '{') curlyDepth += 1;
    else if (character === '}') curlyDepth = Math.max(0, curlyDepth - 1);
    else if (character === '|' && squareDepth === 0 && roundDepth === 0 && curlyDepth === 0) {
      inEdgeLabel = !inEdgeLabel;
    }

    if (
      character === separator &&
      squareDepth === 0 &&
      roundDepth === 0 &&
      curlyDepth === 0 &&
      !inEdgeLabel
    ) {
      result.push(current);
      current = '';
    } else {
      current += character;
    }
  }
  result.push(current);
  return result;
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

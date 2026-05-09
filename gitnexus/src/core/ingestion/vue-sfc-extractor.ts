/**
 * Vue SFC (Single File Component) script extractor.
 *
 * Extracts the <script> / <script setup> block content from .vue files
 * so it can be parsed by the TypeScript tree-sitter grammar.
 *
 * Pure function — no tree-sitter dependency, safe for worker threads.
 */

export interface VueScriptExtraction {
  /** Extracted script content (TypeScript/JavaScript) */
  scriptContent: string;
  /** 0-based line number in the .vue file where the script content starts */
  lineOffset: number;
  /** true if the primary block is <script setup> */
  isSetup: boolean;
}

interface ScriptBlock {
  content: string;
  lineOffset: number;
  isSetup: boolean;
  lang: string;
}

// Closing-tag pattern accepts:
//   - whitespace before `>`            — `</script >`, `</script\t\n>`
//   - attribute-like junk after `script` — `</script foo="bar">`,
//                                          `</script\t\n bar>`
//   - any case                          — `</SCRIPT>`, `</Script>`
//
// HTML5 parses `</script foo>` as a valid close tag (attributes on
// close tags are ignored by the parser but still terminate the script
// block). A strict `<\/script\s*>` would miss those forms and let a
// crafted Vue file hide content from this extractor — exactly the
// CodeQL `js/bad-tag-filter` failure mode (the published test cases
// it checks include `</script foo="bar">` and `</script\t\n bar>`).
//
// `[^>]*` after `</script` accepts everything up to the next `>`,
// matching the HTML parser's actual close-tag behaviour. The `i` flag
// covers the case axis. PR #1330 CI surfaced both the case and
// attribute axes; this expression closes both at once.
const SCRIPT_RE = /<script(\s[^>]*)?>([^]*?)<\/script[^>]*>/gi;
const TEMPLATE_COMPONENT_RE = /<([A-Z][A-Za-z0-9]+)/g;
// Greedy: matches from the first <template> to the *last* </template>.
// This is intentional — nested <template v-slot:...> tags are valid Vue
// syntax and we want the entire outermost template body.
const TEMPLATE_RE = /<template(\s[^>]*)?>([^]*)<\/template>/;

function countNewlines(text: string): number {
  let count = 0;
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) === 10) count++;
  }
  return count;
}

function parseScriptBlock(
  attrs: string | undefined,
  content: string,
  precedingText: string,
): ScriptBlock {
  const isSetup = attrs != null && /\bsetup\b/.test(attrs);
  const langMatch = attrs?.match(/\blang\s*=\s*["']([^"']+)["']/);
  const lang = langMatch ? langMatch[1] : '';
  // +1 for the newline after the opening <script...> tag
  const lineOffset = countNewlines(precedingText) + 1;

  return { content, lineOffset, isSetup, lang };
}

/**
 * Extract script content from a Vue SFC.
 *
 * When both <script> and <script setup> are present, returns only the
 * <script setup> block (the dominant pattern — 94% of Vue files in real
 * projects use setup). The <script> (non-setup) block typically contains
 * only `defineOptions` or legacy option merges and is less important for
 * the knowledge graph.
 */
export function extractVueScript(vueContent: string): VueScriptExtraction | null {
  const blocks: ScriptBlock[] = [];
  let match: RegExpExecArray | null;

  // Reset lastIndex for reuse of the global regex
  SCRIPT_RE.lastIndex = 0;
  while ((match = SCRIPT_RE.exec(vueContent)) !== null) {
    const precedingText = vueContent.slice(0, match.index + match[0].indexOf(match[2]));
    blocks.push(parseScriptBlock(match[1], match[2], precedingText));
  }

  if (blocks.length === 0) return null;

  // Prefer <script setup> if present
  const setupBlock = blocks.find((b) => b.isSetup);
  const primary = setupBlock ?? blocks[0];

  return {
    scriptContent: primary.content,
    lineOffset: primary.lineOffset,
    isSetup: primary.isSetup,
  };
}

/**
 * Vue <script setup>: all top-level bindings are implicitly exported.
 * Returns true if the node (or any ancestor) has the `program` root as its
 * direct parent — i.e. the node is at the top level of the script block.
 *
 * Shared between the worker and sequential parsing paths.
 */
export const isVueSetupTopLevel = (
  node: { parent: { type: string; parent: unknown } | null } | null,
): boolean => {
  if (!node) return false;
  let current: { parent: { type: string; parent: unknown } | null } | null = node;
  while (current) {
    if (current.parent?.type === 'program') return true;
    current = current.parent as typeof current;
  }
  return false;
};

/**
 * Extract PascalCase component names used in <template>.
 * Returns deduplicated component names (e.g., ["MyButton", "AppHeader"]).
 */
export function extractTemplateComponents(vueContent: string): string[] {
  const templateMatch = TEMPLATE_RE.exec(vueContent);
  if (!templateMatch) return [];

  const templateContent = templateMatch[2];
  const components = new Set<string>();
  let componentMatch: RegExpExecArray | null;

  TEMPLATE_COMPONENT_RE.lastIndex = 0;
  while ((componentMatch = TEMPLATE_COMPONENT_RE.exec(templateContent)) !== null) {
    components.add(componentMatch[1]);
  }

  return [...components];
}

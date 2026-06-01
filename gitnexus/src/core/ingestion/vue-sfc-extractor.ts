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

// ── Per-element event binding extraction ──────────────────────────────────
//
// Two sibling regexes capture opening tags distinguished by PascalCase
// (Vue components) vs lowercase (native HTML elements). Both stop their
// attribute-block capture at the first unescaped `>` — which handles the
// common single-line case without a full template AST. Multi-line tags
// whose attribute block contains a literal `>` are documented as a known
// limitation (#1647).
const COMPONENT_TAG_RE = /<([A-Z][A-Za-z0-9]+)([^>]*?)(?:\/>|>)/g;
const NATIVE_TAG_RE = /<([a-z][a-z0-9-]*)([^>]*?)(?:\/>|>)/g;

// Within any tag's attribute block: matches Vue event bindings.
//   @action="handleAction"
//   @keyup.enter="submit"
//   v-on:click="onClick"
const TAG_EVENT_RE = /(?:@|v-on:)([\w:.]+)\s*=\s*["']([A-Za-z_$][A-Za-z0-9_$]*)["']/g;

// ── Script emit() call extraction ─────────────────────────────────────────
//
// Matches `emit('eventName', ...)` and `emit("eventName", ...)` calls.
// Only extracts the event name — the payload and context are not needed for
// graph edge attribution.
const EMIT_CALL_RE = /\bemit\s*\(\s*['"]([A-Za-z][A-Za-z0-9-]*)["']/g;

// ── All-event-handler regex (native + component elements) ─────────────────
// Matches simple method-name references in Vue event-handler attributes.
// Captures only bare identifiers — not inline expressions with arguments,
// arrow functions, or compound expressions.
//
//   @click="handleSave"          → "handleSave"
//   @keyup.enter="addTodo"       → "addTodo"
//   v-on:submit.prevent="onSave" → "onSave"
//   @click="toggle(item)"        — skipped (has parens)
//   @click="() => count++"       — skipped (arrow function)
const EVENT_HANDLER_RE = /(?:@|v-on:)[\w:.]+\s*=\s*["']([A-Za-z_$][A-Za-z0-9_$]*)["']/g;

/**
 * Extract method names from Vue template event-handler bindings.
 *
 * Only captures single-identifier handlers (`@click="handleSave"`).
 * Inline expressions with arguments or operators are intentionally ignored
 * — they cannot be resolved to a single call target without parsing the
 * full template AST.
 *
 * Returns deduplicated method names.
 */
export function extractTemplateEventHandlers(vueContent: string): string[] {
  const templateMatch = TEMPLATE_RE.exec(vueContent);
  if (!templateMatch) return [];

  const templateContent = templateMatch[2];
  const handlers = new Set<string>();
  let match: RegExpExecArray | null;

  EVENT_HANDLER_RE.lastIndex = 0;
  while ((match = EVENT_HANDLER_RE.exec(templateContent)) !== null) {
    handlers.add(match[1]);
  }

  return [...handlers];
}

// Matches simple variable references in Vue bound-attribute values.
// Captures only bare identifiers — not member-access (":key=\"post.id\""),
// literals (":id=\"1\""), or expressions (":val=\"a + b\"").
//
//   :userId="currentUserId"      → "currentUserId"
//   :posts="allPosts"            → "allPosts"
//   v-bind:disabled="isLoading"  → "isLoading"
//   :key="post.id"               — skipped (member access)
//   :id="1"                      — skipped (literal)
const BOUND_ATTR_RE = /(?::[\w-]+|v-bind:[\w-]+)\s*=\s*["']([A-Za-z_$][A-Za-z0-9_$]*)["']/g;

export interface ComponentEventBinding {
  /** PascalCase name of the child component element (e.g. `"PostList"`). */
  componentName: string;
  /** Vue event name without the `@` prefix (e.g. `"select"`, `"keyup.enter"`). */
  eventName: string;
  /** Bare identifier of the parent handler function (e.g. `"onPostSelected"`). */
  handlerName: string;
}

/**
 * Extract Vue component event bindings from a `<template>` block.
 *
 * Scans PascalCase component elements (e.g. `<PostList>`, `<UserCard>`) and
 * returns each `@event="handler"` binding found in the element's attribute
 * block. Native HTML element event handlers (`@click` on `<button>`, etc.)
 * are intentionally excluded — only component-to-component event bindings
 * that go through Vue's `emit()` / `defineEmits` system are included.
 *
 * **Limitation:** component tags whose attribute block spans multiple lines
 * and contains a `>` inside an attribute value are not captured (the regex
 * stops at the first `>`). Full template AST parsing would be required for
 * those edge cases (tracked in #1647).
 */
export function extractComponentEventBindings(vueContent: string): ComponentEventBinding[] {
  const templateMatch = TEMPLATE_RE.exec(vueContent);
  if (!templateMatch) return [];

  const templateContent = templateMatch[2];
  const bindings: ComponentEventBinding[] = [];

  COMPONENT_TAG_RE.lastIndex = 0;
  let tagMatch: RegExpExecArray | null;
  while ((tagMatch = COMPONENT_TAG_RE.exec(templateContent)) !== null) {
    const componentName = tagMatch[1];
    const attrs = tagMatch[2];

    TAG_EVENT_RE.lastIndex = 0;
    let eventMatch: RegExpExecArray | null;
    while ((eventMatch = TAG_EVENT_RE.exec(attrs)) !== null) {
      bindings.push({
        componentName,
        eventName: eventMatch[1],
        handlerName: eventMatch[2],
      });
    }
  }

  return bindings;
}

/**
 * Extract event handler names bound to native HTML elements in the template.
 *
 * Only processes lowercase-named elements (`<button>`, `<input>`, `<div>`,
 * etc.) — PascalCase component elements are handled by
 * `extractComponentEventBindings`. Returns bare handler identifiers only;
 * inline expressions with arguments or arrow functions are excluded.
 *
 * These handlers represent direct DOM-event→function relationships and
 * are emitted as `CALLS` edges (not `BINDS_EVENT_HANDLER`), because native
 * events are synchronous browser callbacks, not Vue's component-event system.
 */
export function extractNativeElementEventHandlers(vueContent: string): string[] {
  const templateMatch = TEMPLATE_RE.exec(vueContent);
  if (!templateMatch) return [];

  const templateContent = templateMatch[2];
  const handlers: string[] = [];

  NATIVE_TAG_RE.lastIndex = 0;
  let tagMatch: RegExpExecArray | null;
  while ((tagMatch = NATIVE_TAG_RE.exec(templateContent)) !== null) {
    const attrs = tagMatch[2];

    TAG_EVENT_RE.lastIndex = 0;
    let eventMatch: RegExpExecArray | null;
    while ((eventMatch = TAG_EVENT_RE.exec(attrs)) !== null) {
      handlers.push(eventMatch[2]);
    }
  }

  return handlers;
}

export interface ScriptEmitCall {
  /** Vue event name passed to `emit()` (e.g. `"action"`, `"update"`). */
  eventName: string;
}

/**
 * Extract `emit('eventName', ...)` calls from a Vue SFC's `<script>` block.
 *
 * Scans the raw SFC source (full `.vue` file), extracts the script content,
 * then finds bare `emit('...')` calls. Only captures literal string event
 * names — dynamic expressions (`emit(eventName)`) are excluded.
 *
 * Returns deduplicated emit declarations.
 */
export function extractScriptEmitCalls(vueContent: string): ScriptEmitCall[] {
  const extracted = extractVueScript(vueContent);
  // Also handle already-extracted script content (worker-mode path)
  const scriptText =
    extracted !== null
      ? extracted.scriptContent
      : /<(?:template|style)\b/i.test(vueContent)
        ? null
        : vueContent;
  if (!scriptText) return [];

  const seen = new Set<string>();
  const calls: ScriptEmitCall[] = [];

  EMIT_CALL_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = EMIT_CALL_RE.exec(scriptText)) !== null) {
    const eventName = match[1];
    if (!seen.has(eventName)) {
      seen.add(eventName);
      calls.push({ eventName });
    }
  }

  return calls;
}

/**
 * Extract variable identifiers from Vue template bound-attribute values.
 *
 * Covers `:prop="varName"` and `v-bind:prop="varName"` patterns where
 * the value is a single plain identifier.  Member-access expressions
 * (`:key="post.id"`) and literals are excluded by design.
 *
 * Returns deduplicated identifier names.
 */
export function extractTemplateAttributeBindings(vueContent: string): string[] {
  const templateMatch = TEMPLATE_RE.exec(vueContent);
  if (!templateMatch) return [];

  const templateContent = templateMatch[2];
  const vars = new Set<string>();
  let match: RegExpExecArray | null;

  BOUND_ATTR_RE.lastIndex = 0;
  while ((match = BOUND_ATTR_RE.exec(templateContent)) !== null) {
    vars.add(match[1]);
  }

  return [...vars];
}

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
  /** 1-based line number in the .vue file where the script content starts
   * (used as offset from tree-sitter's 0-based row). */
  lineOffset: number;
  /** true if at least one block is <script setup> */
  isSetup: boolean;
  /** Value of the `lang` attribute on the extracted script block (e.g. "ts", "js", "tsx", "jsx", or "" for default). */
  lang: string;
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
const TEMPLATE_KEBAB_COMPONENT_RE = /<([a-z][a-z0-9]*(?:-[a-z0-9]+)+)\b/g;
// Greedy: matches from the first <template> to the *last* </template>.
// This is intentional — nested <template v-slot:...> tags are valid Vue
// syntax and we want the entire outermost template body.
const TEMPLATE_RE = /<template(\s[^>]*)?>([^]*)<\/template>/;
const VUE_BUILTIN_KEBAB_TAGS = new Set<string>([
  'router-view',
  'router-link',
  'transition',
  'transition-group',
  'keep-alive',
  'teleport',
  'suspense',
  'component',
  'slot',
]);

function countNewlines(text: string): number {
  let count = 0;
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) === 10) count++;
  }
  return count;
}

function kebabToPascal(name: string): string {
  return name
    .split('-')
    .filter((part) => part.length > 0)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join('');
}

function isBuiltinKebabTag(tagName: string): boolean {
  return VUE_BUILTIN_KEBAB_TAGS.has(tagName);
}

/**
 * Extract bare `emit('event')` / `$emit('event')` calls from script text.
 *
 * Uses a lightweight lexer state-machine (code vs comments/strings), so:
 * - ignores `emit(...)` in comments and string literals
 * - ignores property calls like `socket.emit(...)` / `this.$emit(...)`
 * - captures only literal-string event names
 */
function collectBareEmitEventNames(input: string): string[] {
  enum Mode {
    Code,
    SingleQuote,
    DoubleQuote,
    Template,
    LineComment,
    BlockComment,
  }

  const events: string[] = [];
  const seen = new Set<string>();
  let mode = Mode.Code;

  const isIdentChar = (c: string): boolean => /[A-Za-z0-9_$]/.test(c);
  const skipSpaces = (idx: number): number => {
    let i = idx;
    while (i < input.length && /\s/.test(input[i])) i++;
    return i;
  };

  /**
   * Return true if the token immediately before the `.` at `dotIdx` is the
   * keyword `this` and is not itself a property access (e.g. not `foo.this`).
   * Used to allow `this.$emit(...)` while blocking `socket.emit(...)`.
   */
  const lookbackIsThis = (dotIdx: number): boolean => {
    let j = dotIdx - 1; // step past the '.'
    while (j >= 0 && /\s/.test(input[j])) j--;
    if (j < 3) return false;
    if (input.slice(j - 3, j + 1) !== 'this') return false;
    // Ensure 'this' is not itself a property target (e.g. foo.this)
    const prevOfThis = j >= 4 ? input[j - 4] : '';
    return !(prevOfThis.length > 0 && (isIdentChar(prevOfThis) || prevOfThis === '.'));
  };

  const tryConsumeEmitCall = (idx: number): number => {
    const hasDollar = input[idx] === '$';
    const name = hasDollar ? '$emit' : 'emit';
    if (!input.startsWith(name, idx)) return idx;
    const prev = idx > 0 ? input[idx - 1] : '';
    if (prev.length > 0 && isIdentChar(prev)) return idx;
    if (prev === '.') {
      // Allow `this.$emit(...)` / `this.emit(...)` but block `socket.emit(...)`.
      if (!lookbackIsThis(idx - 1)) return idx;
    }
    const afterName = idx + name.length;
    const next = afterName < input.length ? input[afterName] : '';
    if (next.length > 0 && isIdentChar(next)) return idx;

    let i = skipSpaces(afterName);
    if (input[i] !== '(') return idx;
    i = skipSpaces(i + 1);
    const quote = input[i];
    if (quote !== "'" && quote !== '"') return idx;

    let eventName = '';
    i++;
    while (i < input.length) {
      const ch = input[i];
      if (ch === '\\') {
        i += 2;
        continue;
      }
      if (ch === quote) break;
      eventName += ch;
      i++;
    }
    if (i >= input.length) return idx;
    // Allow simple names ("save"), hyphenated names ("user-loaded"), and
    // update modifier patterns ("update:modelValue", "update:model-value").
    if (/^[A-Za-z$_][A-Za-z0-9:_$-]*$/.test(eventName) && !seen.has(eventName)) {
      seen.add(eventName);
      events.push(eventName);
    }
    return i;
  };

  for (let i = 0; i < input.length; i++) {
    const ch = input[i];
    const next = i + 1 < input.length ? input[i + 1] : '';

    if (mode === Mode.Code) {
      const consumedAt = tryConsumeEmitCall(i);
      if (consumedAt !== i) {
        i = consumedAt;
        continue;
      }
      if (ch === "'" || ch === '"' || ch === '`') {
        mode = ch === "'" ? Mode.SingleQuote : ch === '"' ? Mode.DoubleQuote : Mode.Template;
        continue;
      }
      if (ch === '/' && next === '/') {
        mode = Mode.LineComment;
        i++;
      } else if (ch === '/' && next === '*') {
        mode = Mode.BlockComment;
        i++;
      }
      continue;
    }

    if (mode === Mode.LineComment) {
      if (ch === '\n') {
        mode = Mode.Code;
      }
      continue;
    }

    if (mode === Mode.BlockComment) {
      if (ch === '*' && next === '/') {
        i++;
        mode = Mode.Code;
      }
      continue;
    }

    if (ch === '\\') {
      i++;
      continue;
    }

    if (
      (mode === Mode.SingleQuote && ch === "'") ||
      (mode === Mode.DoubleQuote && ch === '"') ||
      (mode === Mode.Template && ch === '`')
    ) {
      mode = Mode.Code;
    }
  }

  return events;
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
 * When both <script> and <script setup> are present, the content of all
 * blocks is combined (non-setup first, then setup) so the full script
 * surface is available to the knowledge graph.
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

  // Merge all blocks: non-setup first, then setup, so content order is stable.
  const nonSetupBlocks = blocks.filter((b) => !b.isSetup);
  const setupBlocks = blocks.filter((b) => b.isSetup);
  const ordered = [...nonSetupBlocks, ...setupBlocks];
  const combinedContent = ordered.map((b) => b.content).join('\n');
  const lineOffset = ordered[0].lineOffset;
  // Only use JavaScript grammar when ALL blocks are explicitly lang="js"
  // or lang="jsx". If any block omits lang or uses ts/tsx, TypeScript wins.
  const allBlocksJs = blocks.length > 0 && blocks.every((b) => b.lang === 'js' || b.lang === 'jsx');
  const lang = allBlocksJs ? 'js' : '';

  return {
    scriptContent: combinedContent,
    lineOffset,
    isSetup: blocks.some((b) => b.isSetup),
    lang,
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

  TEMPLATE_KEBAB_COMPONENT_RE.lastIndex = 0;
  while ((componentMatch = TEMPLATE_KEBAB_COMPONENT_RE.exec(templateContent)) !== null) {
    if (isBuiltinKebabTag(componentMatch[1])) continue;
    components.add(kebabToPascal(componentMatch[1]));
  }

  return [...components];
}

// ── Per-element event binding extraction ──────────────────────────────────
//
// Three sibling regexes capture opening tags distinguished by PascalCase
// (Vue components), kebab-case (Vue components in kebab form), and simple
// lowercase (native HTML elements). All stop their attribute-block capture
// at the first `>` with a bounded span of at most 512 characters to avoid
// pathological backtracking on large template files (ReDoS mitigation).
// Multi-line tags whose attribute block contains a literal `>` are documented
// as a known limitation (#1647).
//
// NATIVE_TAG_RE uses `(?![A-Za-z0-9-])` to prevent matching the `post` prefix
// of a kebab-case component tag like `<post-list>` — such tags are handled by
// KEBAB_COMPONENT_TAG_RE, not NATIVE_TAG_RE.
const COMPONENT_TAG_RE = /<([A-Z][A-Za-z0-9]+)([^>]{0,512}?)(?:\/>|>)/g;
const KEBAB_COMPONENT_TAG_RE = /<([a-z][a-z0-9]*(?:-[a-z0-9]+)+)([^>]{0,512}?)(?:\/>|>)/g;
const NATIVE_TAG_RE = /<([a-z][a-z0-9]*)(?![A-Za-z0-9-])([^>]{0,512}?)(?:\/>|>)/g;

// Within any tag's attribute block: matches Vue event bindings.
//   @action="handleAction"
//   @keyup.enter="submit"
//   @user-loaded="onLoaded"        — hyphenated event names
//   @update:model-value="onChange" — update modifier with colon
//   v-on:click="onClick"
const TAG_EVENT_RE = /(?:@|v-on:)([\w:.-]+)\s*=\s*["']([A-Za-z_$][A-Za-z0-9_$]*)["']/g;

// ── Script emit() call extraction ─────────────────────────────────────────

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
  const seen = new Set<string>();

  COMPONENT_TAG_RE.lastIndex = 0;
  let tagMatch: RegExpExecArray | null;
  while ((tagMatch = COMPONENT_TAG_RE.exec(templateContent)) !== null) {
    const componentName = tagMatch[1];
    const attrs = tagMatch[2];

    TAG_EVENT_RE.lastIndex = 0;
    let eventMatch: RegExpExecArray | null;
    while ((eventMatch = TAG_EVENT_RE.exec(attrs)) !== null) {
      const eventName = eventMatch[1];
      const handlerName = eventMatch[2];
      const key = `${componentName}::${eventName}::${handlerName}`;
      if (seen.has(key)) continue;
      seen.add(key);
      bindings.push({ componentName, eventName, handlerName });
    }
  }

  KEBAB_COMPONENT_TAG_RE.lastIndex = 0;
  while ((tagMatch = KEBAB_COMPONENT_TAG_RE.exec(templateContent)) !== null) {
    if (isBuiltinKebabTag(tagMatch[1])) continue;
    const componentName = kebabToPascal(tagMatch[1]);
    const attrs = tagMatch[2];

    TAG_EVENT_RE.lastIndex = 0;
    let eventMatch: RegExpExecArray | null;
    while ((eventMatch = TAG_EVENT_RE.exec(attrs)) !== null) {
      const eventName = eventMatch[1];
      const handlerName = eventMatch[2];
      const key = `${componentName}::${eventName}::${handlerName}`;
      if (seen.has(key)) continue;
      seen.add(key);
      bindings.push({ componentName, eventName, handlerName });
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

export interface ExtractScriptEmitCallsOptions {
  /**
   * How to interpret the input text.
   * - `full-sfc` (default): input is a full `.vue` SFC string.
   * - `pre-extracted-script`: input is already the bare script text.
   */
  sourceKind?: 'full-sfc' | 'pre-extracted-script';
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
export function extractScriptEmitCalls(
  vueContent: string,
  options: ExtractScriptEmitCallsOptions = {},
): ScriptEmitCall[] {
  const sourceKind = options.sourceKind ?? 'full-sfc';
  const scriptText =
    sourceKind === 'pre-extracted-script'
      ? vueContent
      : (extractVueScript(vueContent)?.scriptContent ?? null);
  if (!scriptText) return [];
  return collectBareEmitEventNames(scriptText).map((eventName) => ({ eventName }));
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

export interface VueTemplateEdgeData {
  /** PascalCase component names referenced in the template. */
  readonly templateComponents: readonly string[];
  /** Handler names on native elements (@click="fn"). */
  readonly nativeEventHandlers: readonly string[];
  /** Component event bindings (@event="handler" on component elements). */
  readonly componentEventBindings: readonly ComponentEventBinding[];
  /** Event names from emit() / this.$emit() calls in the script block. */
  readonly scriptEmitCalls: readonly ScriptEmitCall[];
  /** Bound attribute variable names (:prop="varName"). */
  readonly templateAttributeBindings: readonly string[];
}

/**
 * Extract all template-derived edge data from a Vue SFC in a single pass.
 *
 * Parses the `<template>` block once and the `<script>` block once, then
 * runs all five extractors on the pre-parsed content rather than repeating
 * the regex on every individual call.  Used by `emitPostResolutionEdges`
 * to avoid multiple full-file scans per `.vue` file.
 */
export function extractVueTemplateEdgeData(
  vueContent: string,
  options: ExtractScriptEmitCallsOptions = {},
): VueTemplateEdgeData {
  // Extract template content once.
  const templateMatch = TEMPLATE_RE.exec(vueContent);
  const tmpl = templateMatch ? templateMatch[2] : '';

  // Template components (PascalCase + kebab-case).
  const componentSet = new Set<string>();
  if (tmpl) {
    TEMPLATE_COMPONENT_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = TEMPLATE_COMPONENT_RE.exec(tmpl)) !== null) componentSet.add(m[1]);
    TEMPLATE_KEBAB_COMPONENT_RE.lastIndex = 0;
    while ((m = TEMPLATE_KEBAB_COMPONENT_RE.exec(tmpl)) !== null) {
      if (!isBuiltinKebabTag(m[1])) componentSet.add(kebabToPascal(m[1]));
    }
  }

  // Native element event handlers.
  const nativeHandlers: string[] = [];
  if (tmpl) {
    NATIVE_TAG_RE.lastIndex = 0;
    let tagM: RegExpExecArray | null;
    while ((tagM = NATIVE_TAG_RE.exec(tmpl)) !== null) {
      TAG_EVENT_RE.lastIndex = 0;
      let evM: RegExpExecArray | null;
      while ((evM = TAG_EVENT_RE.exec(tagM[2])) !== null) nativeHandlers.push(evM[2]);
    }
  }

  // Component event bindings.
  const componentBindings: ComponentEventBinding[] = [];
  const bindingSeen = new Set<string>();
  const processComponentAttrs = (componentName: string, attrs: string): void => {
    TAG_EVENT_RE.lastIndex = 0;
    let evM: RegExpExecArray | null;
    while ((evM = TAG_EVENT_RE.exec(attrs)) !== null) {
      const key = `${componentName}::${evM[1]}::${evM[2]}`;
      if (!bindingSeen.has(key)) {
        bindingSeen.add(key);
        componentBindings.push({ componentName, eventName: evM[1], handlerName: evM[2] });
      }
    }
  };
  if (tmpl) {
    COMPONENT_TAG_RE.lastIndex = 0;
    let tagM: RegExpExecArray | null;
    while ((tagM = COMPONENT_TAG_RE.exec(tmpl)) !== null) processComponentAttrs(tagM[1], tagM[2]);
    KEBAB_COMPONENT_TAG_RE.lastIndex = 0;
    while ((tagM = KEBAB_COMPONENT_TAG_RE.exec(tmpl)) !== null) {
      if (!isBuiltinKebabTag(tagM[1])) processComponentAttrs(kebabToPascal(tagM[1]), tagM[2]);
    }
  }

  // Script emit() calls.
  const sourceKind = options.sourceKind ?? 'full-sfc';
  const scriptText =
    sourceKind === 'pre-extracted-script'
      ? vueContent
      : (extractVueScript(vueContent)?.scriptContent ?? null);
  const scriptEmitCalls: ScriptEmitCall[] = scriptText
    ? collectBareEmitEventNames(scriptText).map((eventName) => ({ eventName }))
    : [];

  // Bound attribute bindings.
  const attrVars = new Set<string>();
  if (tmpl) {
    BOUND_ATTR_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = BOUND_ATTR_RE.exec(tmpl)) !== null) attrVars.add(m[1]);
  }

  return {
    templateComponents: [...componentSet],
    nativeEventHandlers: nativeHandlers,
    componentEventBindings: componentBindings,
    scriptEmitCalls,
    templateAttributeBindings: [...attrVars],
  };
}

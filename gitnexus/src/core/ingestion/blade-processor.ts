/**
 * Blade Processor
 *
 * Links Laravel Blade views to the views they name, using regex over the
 * template text (no tree-sitter dependency, like the Markdown processor).
 * Creates one IMPORTS edge (File → File) per referenced view for:
 *
 *   @extends('layouts.app')          @include('partials.nav')
 *   @includeIf('partials.promo')     @includeWhen($cond, 'partials.admin')
 *   @includeUnless($cond, 'x.y')     @includeFirst(['custom.nav', 'nav'])
 *   @component('components.alert')   @each('orders.row', $orders, 'order')
 *   <x-alert />  <x-forms.input />   (anonymous components)
 *
 * Only static view names are linked. A name built at runtime (`$view`,
 * `"{$prefix}.nav"`), a namespaced name (`mail::message`), or a name with no
 * matching file is skipped rather than guessed.
 */

import { isBladeTemplateFilename } from 'gitnexus-shared';
import { BLADE_VIEW_REFERENCE_REASON } from '../graph/edge-reasons.js';
import { generateId } from '../../lib/utils.js';
import type { KnowledgeGraph } from '../graph/types.js';

/** Laravel's default view directory, relative to the application root. */
const VIEWS_DIR = 'resources/views/';
const BLADE_EXTENSION = '.blade.php';

/** Directives whose FIRST argument is a view name. `(?<!@)` skips `@@include`, Blade's escape for literal text. */
const FIRST_ARG_DIRECTIVE_RE =
  /(?<!@)@(?:extends|include|includeIf|component|each)\s*\(\s*(['"])([^'"]+)\1/g;
/** Directives whose SECOND argument is a view name; the first is a condition. */
const SECOND_ARG_DIRECTIVE_RE =
  /(?<!@)@(?:includeWhen|includeUnless)\s*\([^,]*,\s*(['"])([^'"]+)\1/g;
/** `@includeFirst([...])` renders the first view that exists, so every listed view is a dependency. */
const INCLUDE_FIRST_RE = /(?<!@)@includeFirst\s*\(\s*\[([^\]]*)\]/g;
const QUOTED_STRING_RE = /(['"])([^'"]+)\1/g;
/** Anonymous component tags. `x-slot` and `x-dynamic-component` are Blade built-ins, not files. */
const COMPONENT_TAG_RE = /<x-([a-z0-9][\w.-]*)/gi;
const BUILT_IN_COMPONENT_TAGS = new Set(['slot', 'dynamic-component']);
/** `{{-- … --}}` comments are never rendered, so references inside them are not dependencies. */
const BLADE_COMMENT_RE = /\{\{--[\s\S]*?--\}\}/g;
/** Letters, digits, `_`, `-`, `.` and `/` only: rejects `$var`, `{$x}` and `namespace::name`. */
const STATIC_VIEW_NAME_RE = /^[\w\-./]+$/;

interface BladeFile {
  path: string;
  content: string;
}

/** Every view name the template names. Exported for unit tests. */
export const extractBladeViewReferences = (
  content: string,
): { views: string[]; components: string[] } => {
  const text = content.replace(BLADE_COMMENT_RE, '');
  const views: string[] = [];
  const components: string[] = [];

  for (const match of text.matchAll(FIRST_ARG_DIRECTIVE_RE)) views.push(match[2]);
  for (const match of text.matchAll(SECOND_ARG_DIRECTIVE_RE)) views.push(match[2]);
  for (const match of text.matchAll(INCLUDE_FIRST_RE)) {
    for (const item of match[1].matchAll(QUOTED_STRING_RE)) views.push(item[2]);
  }
  for (const match of text.matchAll(COMPONENT_TAG_RE)) {
    if (!BUILT_IN_COMPONENT_TAGS.has(match[1].toLowerCase())) components.push(match[1]);
  }

  return {
    views: views.filter((name) => STATIC_VIEW_NAME_RE.test(name)),
    components,
  };
};

/**
 * View roots to try for a template, nearest first: the `resources/views/` folder
 * the template itself lives in (so an app in a subfolder resolves to its own
 * views), then the repository's top-level `resources/views/`.
 */
const viewRootsFor = (filePath: string): string[] => {
  const roots: string[] = [];
  const index = filePath.lastIndexOf(VIEWS_DIR);
  if (index === 0 || (index > 0 && filePath[index - 1] === '/')) {
    roots.push(filePath.slice(0, index + VIEWS_DIR.length));
  }
  if (!roots.includes(VIEWS_DIR)) roots.push(VIEWS_DIR);
  return roots;
};

/** `layouts.app` → `layouts/app`. Laravel accepts both separators. */
const viewNameToPath = (name: string): string => name.replace(/\./g, '/');

const resolveView = (
  name: string,
  roots: string[],
  allPathSet: ReadonlySet<string>,
): string | null => {
  for (const root of roots) {
    const candidate = `${root}${viewNameToPath(name)}${BLADE_EXTENSION}`;
    if (allPathSet.has(candidate)) return candidate;
  }
  return null;
};

/** `<x-forms.input>` → `components/forms/input.blade.php`, or `components/forms/input/index.blade.php`. */
const resolveComponent = (
  tag: string,
  roots: string[],
  allPathSet: ReadonlySet<string>,
): string | null => {
  const base = `components/${viewNameToPath(tag)}`;
  for (const root of roots) {
    for (const candidate of [
      `${root}${base}${BLADE_EXTENSION}`,
      `${root}${base}/index${BLADE_EXTENSION}`,
    ]) {
      if (allPathSet.has(candidate)) return candidate;
    }
  }
  return null;
};

export const processBlade = (
  graph: KnowledgeGraph,
  files: BladeFile[],
  allPathSet: ReadonlySet<string>,
): { links: number } => {
  let totalLinks = 0;

  for (const file of files) {
    if (!isBladeTemplateFilename(file.path)) continue;

    const sourceId = generateId('File', file.path);
    if (!graph.getNode(sourceId)) continue;

    const roots = viewRootsFor(file.path);
    const { views, components } = extractBladeViewReferences(file.content);
    const targets = [
      ...views.map((name) => resolveView(name, roots, allPathSet)),
      ...components.map((tag) => resolveComponent(tag, roots, allPathSet)),
    ];

    const seen = new Set<string>();
    for (const targetPath of targets) {
      if (targetPath === null || targetPath === file.path || seen.has(targetPath)) continue;
      seen.add(targetPath);

      const targetId = generateId('File', targetPath);
      if (!graph.getNode(targetId)) continue;

      const linkKey = `${sourceId}->${targetId}`;
      graph.addRelationship({
        id: generateId('IMPORTS', linkKey),
        type: 'IMPORTS',
        sourceId,
        targetId,
        // Below 1.0: `config/view.php` can add view paths this scan does not read.
        confidence: 0.9,
        reason: BLADE_VIEW_REFERENCE_REASON,
      });
      totalLinks++;
    }
  }

  return { links: totalLinks };
};

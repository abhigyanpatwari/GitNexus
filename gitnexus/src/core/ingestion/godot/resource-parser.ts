/**
 * GodotResourceParser
 *
 * Wraps tree-sitter-godot-resource and exposes a stable, typed view of a
 * parsed Godot resource file (.tscn / .tres / project.godot). Downstream
 * phases (ScenesPhase, GodotCrossrefPhase) consume the typed shape and
 * never touch the tree-sitter AST directly.
 */

import Parser from 'tree-sitter';
import { createRequire } from 'node:module';

const _require = createRequire(import.meta.url);

// ── Types ──────────────────────────────────────────────────────────

export interface ResourceHeader {
  /** "gd_scene", "gd_resource", etc. */
  kind: string;
  /** uid="uid://abc" if present */
  uid: string | null;
  /** format=3 etc. */
  format: number | null;
}

export interface ExtResource {
  id: string;
  type: string;
  path: string;
}

export interface SubResource {
  id: string;
  type: string;
}

export type GodotPropertyValue =
  | { kind: 'literal'; value: string | number | boolean | null }
  | { kind: 'constructor'; type: string; args: string[] }
  | { kind: 'ext_resource_ref'; id: string }
  | { kind: 'sub_resource_ref'; id: string };

export interface SceneNode {
  name: string;
  /** node type (e.g. "Node2D"). Null when the node is an instance of another scene. */
  type: string | null;
  /** parent path string (e.g. "."). Null for the root node. */
  parent: string | null;
  /** ExtResource id when the node uses `instance=ExtResource("...")`. */
  instanceExtResourceId: string | null;
  /** Properties below the [node ...] header. */
  properties: Record<string, GodotPropertyValue>;
}

export interface SignalConnection {
  signal: string;
  from: string;
  to: string;
  method: string;
}

export interface Autoload {
  name: string;
  /** The script path. Godot prefixes singleton autoloads with `*`; we preserve it verbatim. */
  path: string;
}

export interface ParsedGodotResource {
  header: ResourceHeader | null;
  extResources: ExtResource[];
  subResources: SubResource[];
  nodes: SceneNode[];
  connections: SignalConnection[];
  autoloads: Autoload[];
}

// ── Parser ─────────────────────────────────────────────────────────

interface SyntaxNode {
  type: string;
  text: string;
  namedChildCount: number;
  namedChild(i: number): SyntaxNode | null;
}

let cachedParser: Parser | null = null;
function getParser(): Parser {
  if (cachedParser !== null) return cachedParser;
  const grammar = _require('tree-sitter-godot-resource');
  const parser = new Parser();
  parser.setLanguage(grammar);
  cachedParser = parser;
  return parser;
}

/**
 * tree-sitter's default input buffer is 32 KB. Real-world Godot scene
 * files for complex levels exceed that easily (e.g. platformer's
 * level/level.tscn is ~55 KB / 1722 lines). Bumping to 1 MB covers
 * every scene file we've encountered without measurable cost — the
 * binding allocates lazily.
 */
const PARSE_BUFFER_BYTES = 1024 * 1024;

export function parseGodotResource(text: string): ParsedGodotResource {
  const parser = getParser();
  const tree = parser.parse(text, undefined, { bufferSize: PARSE_BUFFER_BYTES });
  const root = tree.rootNode as unknown as SyntaxNode;

  const result: ParsedGodotResource = {
    header: null,
    extResources: [],
    subResources: [],
    nodes: [],
    connections: [],
    autoloads: [],
  };

  for (const section of namedChildren(root)) {
    if (section.type !== 'section') continue;
    const identifier = firstNamedChildOfType(section, 'identifier');
    if (identifier === null) continue;
    const sectionKind = identifier.text;
    const attrs = extractAttributes(section);
    const properties = extractProperties(section);

    switch (sectionKind) {
      case 'gd_scene':
      case 'gd_resource':
        result.header = {
          kind: sectionKind,
          uid: unquote(attrs.get('uid')) ?? null,
          format: parseIntOrNull(attrs.get('format')),
        };
        break;
      case 'ext_resource':
        result.extResources.push({
          id: unquote(attrs.get('id')) ?? '',
          type: unquote(attrs.get('type')) ?? '',
          path: unquote(attrs.get('path')) ?? '',
        });
        break;
      case 'sub_resource':
        result.subResources.push({
          id: unquote(attrs.get('id')) ?? '',
          type: unquote(attrs.get('type')) ?? '',
        });
        break;
      case 'node': {
        const instanceAttr = attrs.get('instance');
        const instanceExtResourceId =
          instanceAttr !== undefined ? extractExtResourceId(instanceAttr) : null;
        result.nodes.push({
          name: unquote(attrs.get('name')) ?? '',
          type: unquote(attrs.get('type')) ?? null,
          parent: unquote(attrs.get('parent')) ?? null,
          instanceExtResourceId,
          properties,
        });
        break;
      }
      case 'connection':
        result.connections.push({
          signal: unquote(attrs.get('signal')) ?? '',
          from: unquote(attrs.get('from')) ?? '',
          to: unquote(attrs.get('to')) ?? '',
          method: unquote(attrs.get('method')) ?? '',
        });
        break;
      case 'autoload':
        for (const [name, value] of Object.entries(properties)) {
          if (value.kind === 'literal' && typeof value.value === 'string') {
            result.autoloads.push({ name, path: value.value });
          }
        }
        break;
    }
  }

  return result;
}

// ── AST helpers ────────────────────────────────────────────────────

function* namedChildren(node: SyntaxNode): Generator<SyntaxNode> {
  for (let i = 0; i < node.namedChildCount; i++) {
    const child = node.namedChild(i);
    if (child !== null) yield child;
  }
}

function firstNamedChildOfType(node: SyntaxNode, type: string): SyntaxNode | null {
  for (const child of namedChildren(node)) {
    if (child.type === type) return child;
  }
  return null;
}

/** A section's `attribute` children store the raw value node for downstream extraction. */
function extractAttributes(section: SyntaxNode): Map<string, SyntaxNode> {
  const attrs = new Map<string, SyntaxNode>();
  for (const child of namedChildren(section)) {
    if (child.type !== 'attribute') continue;
    const key = firstNamedChildOfType(child, 'identifier');
    if (key === null) continue;
    const value = valueChildOfAttribute(child);
    if (value !== null) attrs.set(key.text, value);
  }
  return attrs;
}

/** An attribute is `identifier = value`. The value is the last named child. */
function valueChildOfAttribute(attribute: SyntaxNode): SyntaxNode | null {
  let last: SyntaxNode | null = null;
  for (const child of namedChildren(attribute)) {
    if (child.type !== 'identifier') last = child;
  }
  return last;
}

function extractProperties(section: SyntaxNode): Record<string, GodotPropertyValue> {
  const out: Record<string, GodotPropertyValue> = {};
  for (const child of namedChildren(section)) {
    if (child.type !== 'property') continue;
    const path = firstNamedChildOfType(child, 'path');
    if (path === null) continue;
    const value = valueChildOfProperty(child);
    if (value !== null) out[path.text] = interpretValue(value);
  }
  return out;
}

function valueChildOfProperty(property: SyntaxNode): SyntaxNode | null {
  let last: SyntaxNode | null = null;
  for (const child of namedChildren(property)) {
    if (child.type !== 'path') last = child;
  }
  return last;
}

function interpretValue(node: SyntaxNode): GodotPropertyValue {
  if (node.type === 'constructor') {
    const id = firstNamedChildOfType(node, 'identifier');
    const ctorType = id?.text ?? '';
    if (ctorType === 'ExtResource') {
      const firstArg = firstConstructorStringArg(node);
      if (firstArg !== null) return { kind: 'ext_resource_ref', id: firstArg };
    }
    if (ctorType === 'SubResource') {
      const firstArg = firstConstructorStringArg(node);
      if (firstArg !== null) return { kind: 'sub_resource_ref', id: firstArg };
    }
    return { kind: 'constructor', type: ctorType, args: collectConstructorArgs(node) };
  }
  if (node.type === 'integer') return { kind: 'literal', value: parseInt(node.text, 10) };
  if (node.type === 'float') return { kind: 'literal', value: parseFloat(node.text) };
  if (node.type === 'string') return { kind: 'literal', value: unquoteRaw(node.text) };
  if (node.type === 'true') return { kind: 'literal', value: true };
  if (node.type === 'false') return { kind: 'literal', value: false };
  return { kind: 'literal', value: null };
}

function firstConstructorStringArg(ctor: SyntaxNode): string | null {
  const args = firstNamedChildOfType(ctor, 'arguments');
  if (args === null) return null;
  for (const a of namedChildren(args)) {
    if (a.type === 'string') return unquoteRaw(a.text);
  }
  return null;
}

function collectConstructorArgs(ctor: SyntaxNode): string[] {
  const args = firstNamedChildOfType(ctor, 'arguments');
  if (args === null) return [];
  const out: string[] = [];
  for (const a of namedChildren(args)) {
    if (a.type === 'string') out.push(unquoteRaw(a.text));
    else out.push(a.text);
  }
  return out;
}

function extractExtResourceId(value: SyntaxNode): string | null {
  if (value.type !== 'constructor') return null;
  const id = firstNamedChildOfType(value, 'identifier');
  if (id?.text !== 'ExtResource') return null;
  return firstConstructorStringArg(value);
}

function unquote(node: SyntaxNode | undefined): string | undefined {
  if (node === undefined) return undefined;
  if (node.type === 'string') return unquoteRaw(node.text);
  return node.text;
}

function unquoteRaw(text: string): string {
  if (text.length >= 2 && text.startsWith('"') && text.endsWith('"')) {
    return text.slice(1, -1);
  }
  return text;
}

function parseIntOrNull(node: SyntaxNode | undefined): number | null {
  if (node === undefined) return null;
  if (node.type !== 'integer') return null;
  const n = parseInt(node.text, 10);
  return Number.isNaN(n) ? null : n;
}

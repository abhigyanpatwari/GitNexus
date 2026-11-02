/** Statically locate fixture inputs without evaluating test/helper code. */
import path from 'node:path';
import { parse } from '@babel/parser';
import * as t from '@babel/types';
import {
  buildFrame,
  resolveName,
  staticValue,
  type Frame,
  type Programs,
} from '../../test-dupes/test-dupes.js';
import { buildScope } from './checks.js';
import type { FacetSubject, InputFacet } from './input-facet.js';
import type { SourceReader } from './source-shape.js';
import { FixtureProfiler, type FixtureProfile } from './fixture-profile.js';
import { sha1, sortedUnique } from '../util.js';

// Includes integration/cfg/fixtures and other test-local source corpora, not just test/fixtures.
const ROOT = 'gitnexus/test';
const INPUT_CALL =
  /^(?:runPipelineFromRepo|readFileSync|readFile|cpSync|cp|copyFileSync|copyFile)$/;

export interface FixtureReferences {
  roots: string[];
  unresolved: string[];
}

/** Resolve imported constants lazily; importing the pipeline must not scan its entire closure. */
class FixturePrograms extends Map<string, { file: string; frame: Frame }> implements Programs {
  private readonly attempted = new Set<string>();
  constructor(private readonly sources: SourceReader) {
    super();
  }

  override get(key: string) {
    if (!this.attempted.has(key)) {
      this.attempted.add(key);
      if (key.startsWith('gitnexus/test/')) {
        for (const suffix of ['.ts', '.js', '.mts', '.mjs', '/index.ts', '/index.js']) {
          const file = key + suffix;
          const text = this.sources.read(file);
          if (text === null) continue;
          try {
            const ast = parse(text, { sourceType: 'unambiguous', plugins: ['typescript', 'jsx'] });
            this.set(key, { file, frame: buildFrame(file, ast.program, []) });
          } catch {
            /* The caller records an unresolved input instead of executing code. */
          }
          break;
        }
      }
    }
    return super.get(key);
  }
}

export class FixtureInputs {
  private readonly programs: FixturePrograms;
  private readonly profiler: FixtureProfiler;
  private readonly known = new Set<string>();
  private readonly references = new WeakMap<t.Node, Map<string, FixtureReferences>>();

  constructor(sources: SourceReader) {
    this.programs = new FixturePrograms(sources);
    this.profiler = new FixtureProfiler(sources);
    for (const file of sources.list(ROOT)) {
      this.known.add(file);
      let dir = path.posix.dirname(file);
      while (dir.startsWith(`${ROOT}/`)) {
        this.known.add(dir);
        dir = path.posix.dirname(dir);
      }
    }
  }

  resolve(subject: FacetSubject): FixtureReferences {
    const { record, instance } = subject;
    const rowKey = instance === null ? 'unknown' : `${instance.row}:${instance.rowFingerprint}`;
    const cached = this.references.get(record.fn)?.get(rowKey);
    if (cached !== undefined) return cached;
    const roots = new Set<string>();
    const unresolved = new Set<string>();
    const scope = buildScope({ record, instance, fullName: record.title });
    const rowFrame: Frame = { decls: new Map(), setup: [], extra: [] };
    for (const [name, value] of scope.rows) {
      if (value?.kind === 'string')
        rowFrame.decls.set(name, {
          kind: 'node',
          node: t.variableDeclarator(t.identifier(name), t.stringLiteral(value.value)),
        });
    }
    const evaluate = (
      node: t.Node,
      file: string,
      chain: Frame[],
      depth = 0,
    ): string | undefined => {
      if (depth > 8 || !t.isExpression(node)) return undefined;
      if (t.isTSAsExpression(node) || t.isTSNonNullExpression(node))
        return evaluate(node.expression, file, chain, depth + 1);
      if (t.isTemplateLiteral(node)) {
        const values = node.expressions.map((entry) => evaluate(entry, file, chain, depth + 1));
        if (values.some((value) => value === undefined)) return undefined;
        return node.quasis
          .map((part, i) => (part.value.cooked ?? part.value.raw) + (values[i] ?? ''))
          .join('');
      }
      if (t.isBinaryExpression(node, { operator: '+' })) {
        const left = evaluate(node.left, file, chain, depth + 1);
        const right = evaluate(node.right, file, chain, depth + 1);
        return left === undefined || right === undefined ? undefined : left + right;
      }
      if (
        t.isNewExpression(node) &&
        t.isIdentifier(node.callee, { name: 'URL' }) &&
        node.arguments.length === 2 &&
        t.isMemberExpression(node.arguments[1]) &&
        t.isMetaProperty(node.arguments[1].object) &&
        t.isIdentifier(node.arguments[1].property, { name: 'url' })
      ) {
        const relative = evaluate(node.arguments[0], file, chain, depth + 1);
        return relative === undefined
          ? undefined
          : path.posix.join(path.posix.dirname(file), relative);
      }
      if (t.isCallExpression(node)) {
        const callee = node.callee;
        const decl = t.isIdentifier(callee)
          ? resolveName(callee.name, chain)
          : t.isMemberExpression(callee) && t.isIdentifier(callee.object)
            ? resolveName(callee.object.name, chain)
            : undefined;
        const pathImport = decl?.kind === 'import' && /^import:(?:node:)?path#/.test(decl.key);
        const operation =
          t.isIdentifier(callee) && pathImport
            ? decl.key.split('#').at(-1)
            : t.isMemberExpression(callee) && pathImport && t.isIdentifier(callee.property)
              ? callee.property.name
              : undefined;
        if (operation === 'join' || operation === 'resolve') {
          const parts = node.arguments.map((arg) => evaluate(arg, file, chain, depth + 1));
          if (
            parts.every(
              (part): part is string => part !== undefined && !path.posix.isAbsolute(part),
            )
          )
            return path.posix.normalize(path.posix.join(...parts));
        }
      }
      // staticValue already follows constants and imports and handles __dirname/path.join.
      const value = staticValue(
        { kind: 'node', node: t.variableDeclarator(t.identifier('__fixture'), node) },
        file,
        chain,
        this.programs,
      );
      if (value !== undefined) return value;
      if (t.isIdentifier(node)) {
        const decl = resolveName(node.name, chain);
        if (decl?.kind === 'node' && t.isVariableDeclarator(decl.node) && decl.node.init)
          return evaluate(decl.node.init, file, chain, depth + 1);
      }
      return undefined;
    };
    const seen = new Set<t.Node>();
    const visit = (node: t.Node, file: string, chain: Frame[], depth: number): void => {
      if (depth > 5 || seen.has(node)) {
        unresolved.add(`fixture helper traversal incomplete: ${file}:${node.loc?.start.line ?? 0}`);
        return;
      }
      seen.add(node);
      const inspect = (call: t.Node, chain: Frame[]): void => {
        if (!t.isCallExpression(call)) return;
        const callee = call.callee;
        const imported = t.isIdentifier(callee) ? resolveName(callee.name, chain) : undefined;
        const name =
          imported?.kind === 'import'
            ? (imported.key.split('#').at(-1) ?? '')
            : t.isIdentifier(callee)
              ? callee.name
              : t.isMemberExpression(callee) && t.isIdentifier(callee.property)
                ? callee.property.name
                : '';
        if (/^before(All|Each)$/.test(name) && t.isIdentifier(call.arguments[0])) {
          inspect(t.callExpression(call.arguments[0], []), chain);
          return;
        }
        if (INPUT_CALL.test(name)) {
          const arg = call.arguments[0];
          const value = arg === undefined ? undefined : evaluate(arg, file, chain);
          if (value !== undefined) {
            const normalized = path.posix.normalize(value);
            if (this.known.has(normalized) && normalized !== ROOT) roots.add(normalized);
            else unresolved.add(`input path outside the known test tree: ${normalized}`);
          } else
            unresolved.add(
              `unresolved fixture input: ${name} at ${file}:${call.loc?.start.line ?? 0}`,
            );
          return;
        }
        if (!t.isIdentifier(callee)) return;
        let decl = resolveName(callee.name, chain);
        let helperFile = file;
        let helperChain = chain;
        if (decl?.kind === 'import') {
          const match = /^import:(.+)#([^#]+)$/.exec(decl.key);
          if (match === null) return;
          const program = this.programs.get(match[1]);
          if (program === undefined) return;
          decl = program.frame.decls.get(match[2]);
          helperFile = program.file;
          helperChain = [program.frame];
        }
        const fn =
          decl?.kind !== 'node'
            ? null
            : t.isVariableDeclarator(decl.node)
              ? decl.node.init
              : decl.node;
        if (!fn || !t.isFunction(fn)) return;
        const frame = buildFrame(helperFile, fn.body, []);
        fn.params.forEach((param, i) => {
          // Unknown arguments still shadow outer constants of the same name.
          for (const name of Object.keys(t.getBindingIdentifiers(param)))
            frame.decls.set(name, {
              kind: 'node',
              node: t.variableDeclarator(t.identifier(name)),
            });
          const arg = call.arguments[i];
          const value = arg === undefined ? undefined : evaluate(arg, file, chain);
          if (t.isIdentifier(param) && value !== undefined)
            frame.decls.set(param.name, {
              kind: 'node',
              node: t.variableDeclarator(param, t.stringLiteral(value)),
            });
        });
        visit(fn.body, helperFile, [...helperChain, frame], depth + 1);
      };
      const walk = (current: t.Node, frames: Frame[]): void => {
        // Named helpers are visited only at a call, with their argument bindings.
        if (t.isFunctionDeclaration(current)) return;
        if (t.isFunction(current)) {
          const params: Frame = { decls: new Map(), setup: [], extra: [] };
          for (const param of current.params)
            for (const name of Object.keys(t.getBindingIdentifiers(param))) {
              params.decls.set(name, {
                kind: 'node',
                node: t.variableDeclarator(t.identifier(name)),
              });
            }
          frames = [...frames, params];
        }
        if (t.isBlockStatement(current)) frames = [...frames, buildFrame(file, current, [])];
        inspect(current, frames);
        for (const key of t.VISITOR_KEYS[current.type] ?? []) {
          const value = (current as unknown as Record<string, unknown>)[key];
          for (const child of Array.isArray(value) ? value : [value]) {
            if (t.isVariableDeclarator(current) && key === 'init' && t.isFunction(child)) continue;
            if (child !== null && typeof child === 'object' && 'type' in child)
              walk(child as t.Node, frames);
          }
        }
      };
      walk(node, chain);
      seen.delete(node);
    };
    const bodyFrame = buildFrame(record.file, record.fn.body, []);
    const chain = [...record.chain, rowFrame, bodyFrame];
    visit(record.fn.body, record.file, chain, 0);
    const ownParams = new Set(
      record.fn.params.flatMap((param) => Object.keys(t.getBindingIdentifiers(param))),
    );
    const hookRows: Frame = {
      ...rowFrame,
      decls: new Map([...rowFrame.decls].filter(([name]) => !ownParams.has(name))),
    };
    record.chain.forEach((frame, index) => {
      for (const setup of frame.setup)
        visit(setup, record.file, [...record.chain.slice(0, index + 1), hookRows], 0);
    });
    const result = { roots: [...roots].sort(), unresolved: [...unresolved].sort() };
    const cache = this.references.get(record.fn) ?? new Map<string, FixtureReferences>();
    cache.set(rowKey, result);
    this.references.set(record.fn, cache);
    return result;
  }

  async profile(subject: FacetSubject): Promise<FixtureProfile | null> {
    const refs = this.resolve(subject);
    if (refs.roots.length === 0 && refs.unresolved.length === 0) return null;
    const profile = await this.profiler.profile(refs.roots);
    return {
      ...profile,
      contentKey: refs.unresolved.length > 0 ? null : profile.contentKey,
      unresolved: sortedUnique([...profile.unresolved, ...refs.unresolved]),
    };
  }
}

/** Exact fixture bytes/layout participate in input identity; structural features never do. */
export function withFixtureIdentity(facet: InputFacet, profile: FixtureProfile | null): InputFacet {
  if (profile === null) return facet;
  const identity = profile.contentKey ?? 'unknown';
  return {
    ...facet,
    fingerprint: sha1(`${facet.fingerprint}\0fixture-content:${identity}`),
    parts: { ...facet.parts, fixtures: [...facet.parts.fixtures, `content:${identity}`] },
    unresolved: sortedUnique([
      ...facet.unresolved,
      ...profile.unresolved.map((reason) => `fixture: ${reason}`),
    ]),
  };
}

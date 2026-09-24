/**
 * Parity guard for the two NestJS route layers.
 *
 * GitNexus reads `@Controller` / `@Get` decorators for two consumers: the
 * indexer's `route-extractors/nest.ts` (which mints graph `Route` nodes) and
 * the group layer's `http-patterns/node.ts` (which mints cross-repo HTTP
 * contracts). They used to be two independent tree-sitter scans, and that is
 * the shape #2265 already showed to be a slow leak: there the group query
 * matched Spring's array form `@GetMapping({"/a","/b"})` and ingestion's did
 * not, so the graph silently under-covered what the contracts claimed. Nest had
 * the same divergence pointing the other way and worse — the group scan
 * INVENTED `/` for any method path it could not read, so `@Get(ROUTES.SEARCH)`
 * became a `GET /venues` contract with no Route node behind it. "A missing
 * route is a coverage limit; an invented one is a lie" (ARCHITECTURE.md).
 *
 * The group layer now CALLS `extractNestRoutes` instead of re-querying the
 * decorators, so the two cannot disagree by construction. What this file
 * guards is that the call stays wired and keeps its `HttpDetection` shape: the
 * assertions below pair each group result with the value computed straight from
 * `extractNestRoutes` + `normalizeExtractedRoutePath`, and also pin the literal
 * expected URLs, so a mutual regression cannot pass by having both sides go
 * quiet together.
 */
import { describe, it, expect } from 'vitest';
import Parser from 'tree-sitter';
import JavaScript from 'tree-sitter-javascript';
import TypeScript from 'tree-sitter-typescript';
import {
  JAVASCRIPT_HTTP_PLUGIN,
  TYPESCRIPT_HTTP_PLUGIN,
} from '../../../src/core/group/extractors/http-patterns/node.js';
import type { HttpLanguagePlugin } from '../../../src/core/group/extractors/http-patterns/types.js';
import { extractNestRoutes } from '../../../src/core/ingestion/route-extractors/nest.js';
import { normalizeExtractedRoutePath } from '../../../src/core/ingestion/route-extractors/route-path.js';

// Compiled tree-sitter queries are grammar-bound, so a plugin must be driven
// with a tree parsed by ITS grammar.
interface Lang {
  readonly parser: Parser;
  readonly plugin: HttpLanguagePlugin;
}

function lang(grammar: unknown, plugin: HttpLanguagePlugin): Lang {
  const parser = new Parser();
  parser.setLanguage(grammar as Parameters<Parser['setLanguage']>[0]);
  return { parser, plugin };
}

const TS = lang(TypeScript.typescript, TYPESCRIPT_HTTP_PLUGIN);
const JS = lang(JavaScript, JAVASCRIPT_HTTP_PLUGIN);

/** `METHOD /full/url` pairs the GROUP layer reports as NestJS providers. */
function groupPairs(src: string, target: Lang = TS): string[] {
  return target.plugin
    .scan(target.parser.parse(src))
    .filter((d) => d.role === 'provider' && d.framework === 'nest')
    .map((d) => `${d.method} ${d.path}`)
    .sort();
}

/**
 * The same pairs computed straight from the indexer's extractor, joining the
 * prefix the way the routes phase does. This is the reference the group layer
 * must equal — and, since the group layer now calls the same function, the
 * assertion is really "the call is still there and still joins the prefix".
 */
function ingestionPairs(src: string, target: Lang = TS): string[] {
  return extractNestRoutes(target.parser.parse(src), 'venues.controller.ts')
    .map((r) => `${r.httpMethod} ${normalizeExtractedRoutePath(r.routePath, r.prefix ?? null)}`)
    .sort();
}

/** A minimal `@Controller('venues')` wrapping the given class-body members. */
function venuesController(members: string): string {
  return `
import { Controller, Get, Post, Put, Patch, Delete, Head, Options, All, Sse } from '@nestjs/common';

@Controller('venues')
export class VenuesController {
${members}
}
`;
}

describe('NestJS route parity — group node.ts delegates to ingestion nest.ts', () => {
  const VERB_CASES: ReadonlyArray<readonly [string, string]> = [
    ['Get', 'GET'],
    ['Post', 'POST'],
    ['Put', 'PUT'],
    ['Patch', 'PATCH'],
    ['Delete', 'DELETE'],
    // The four the group layer's own query never listed: its verb set stopped
    // at Patch, so every @Head/@Options/@All/@Sse endpoint was invisible to
    // contract matching while sitting in the graph as a Route node.
    ['Head', 'HEAD'],
    ['Options', 'OPTIONS'],
    ['All', '*'],
    // @Sse mounts a real streaming GET; '*' is the method-agnostic spelling
    // `findMatchingKeys` already understands from Spring's @RequestMapping.
    ['Sse', 'GET'],
  ];

  it.each(VERB_CASES)('pins the verb @%s → %s', (decorator, method) => {
    const src = venuesController(`  @${decorator}('slots')\n  handler() {}`);
    expect(groupPairs(src)).toEqual([`${method} /venues/slots`]);
    expect(ingestionPairs(src)).toEqual(groupPairs(src));
  });

  it('pins an abstract controller — a node type the group query never matched', () => {
    // `export abstract class C` parses as `abstract_class_declaration`, a
    // DIFFERENT node type from `class_declaration`. A decorated abstract base
    // sharing CRUD routes with its subclasses is ordinary Nest, and the old
    // group query dropped the WHOLE controller for it, not one route.
    const src = `
import { Controller, Get } from '@nestjs/common';

@Controller('venues')
export abstract class BaseVenuesController {
  @Get('list')
  list() {}
}
`;
    expect(groupPairs(src)).toEqual(['GET /venues/list']);
    expect(ingestionPairs(src)).toEqual(groupPairs(src));
  });

  it('pins the object-form @Controller({ path }) — the documented versioning shape', () => {
    // The old group query required a positional `(string)`/`(template_string)`
    // argument, so `@Controller({ path: 'cats', version: '1' })` — the form the
    // Nest docs give for URI/header versioning — suppressed the whole class.
    const src = `
import { Controller, Get } from '@nestjs/common';

@Controller({ path: 'venues', version: '1' })
export class VenuesController {
  @Get('list')
  list() {}
}
`;
    expect(groupPairs(src)).toEqual(['GET /venues/list']);
    expect(ingestionPairs(src)).toEqual(groupPairs(src));
  });

  it('pins the argument-less @Controller() — routes mount at the root', () => {
    // Legal Nest, and the old group query's mandatory prefix argument made the
    // class invisible rather than rooting its methods at '/'.
    const src = `
import { Controller, Get } from '@nestjs/common';

@Controller()
export class HealthController {
  @Get('health')
  health() {}
}
`;
    expect(groupPairs(src)).toEqual(['GET /health']);
    expect(ingestionPairs(src)).toEqual(groupPairs(src));
  });

  it('pins a pathless @Get() at the controller prefix with no trailing slash', () => {
    // The group layer's local `joinPath('venues', '/')` returned '/venues/';
    // the graph stored '/venues'. Both contract-id generation
    // (`normalizeHttpPath`) and match-time canonicalization
    // (`normalizeContractId`) strip a trailing slash, so this was a latent
    // divergence rather than a live mismatch — but it is one fewer way for the
    // two layers to describe the same endpoint differently.
    const src = venuesController('  @Get()\n  index() {}');
    expect(groupPairs(src)).toEqual(['GET /venues']);
    expect(ingestionPairs(src)).toEqual(groupPairs(src));
  });

  it('decodes an escaped literal identically in both layers', () => {
    // tree-sitter SPLITS a string around each `escape_sequence`. The group
    // layer's `unquoteLiteral` (`raw.slice(1, -1)`) left the backslash in place,
    // so the ordinary spelling of a Nest regex param came out as a path the app
    // never serves. `plainString` decodes it.
    const src = venuesController(String.raw`  @Get(':id(\\d+)')` + '\n  byId() {}');
    expect(groupPairs(src)).toEqual([String.raw`GET /venues/:id(\d+)`]);
    expect(ingestionPairs(src)).toEqual(groupPairs(src));
  });

  it('emits NOTHING for an unreadable method path instead of inventing the prefix', () => {
    // The precision case. `@Get(ROUTES.SEARCH)` is not readable from this file,
    // and the old group scan answered it with a fabricated `GET /venues` — a
    // contract that exact-matches any consumer of the controller root and has
    // no Route node behind it. The readable sibling proves the controller is
    // still SEEN, so this is a dropped route rather than a dropped class.
    const src = `
import { Controller, Get } from '@nestjs/common';
import { ROUTES } from './routes.js';

@Controller('venues')
export class VenuesController {
  @Get('list')
  list() {}

  @Get(ROUTES.SEARCH)
  search() {}
}
`;
    expect(groupPairs(src)).toEqual(['GET /venues/list']);
    expect(ingestionPairs(src)).toEqual(groupPairs(src));
  });

  it('reads a JavaScript Nest controller, whose decorators sit under the method', () => {
    // tree-sitter-javascript makes a method decorator a CHILD of the
    // `method_definition`; tree-sitter-typescript makes it a preceding SIBLING.
    // The group scan only ever walked siblings, so every `.js` Nest controller
    // emitted zero contracts.
    const src = `
const { Controller, Get } = require('@nestjs/common');

@Controller('venues')
class VenuesController {
  @Get('search')
  search() {}
}
`;
    expect(groupPairs(src, JS)).toEqual(['GET /venues/search']);
    expect(ingestionPairs(src, JS)).toEqual(groupPairs(src, JS));
  });

  it('agrees with the indexer on the full (method, URL) set for one mixed fixture', () => {
    // The genuine parity assertion (#2265's lesson): one fixture, both layers,
    // set equality — plus the literal expectation, so the two cannot agree by
    // both returning nothing.
    const src = `
import { Controller, Get, Post, Delete, All, Sse } from '@nestjs/common';
import { ROUTES } from './routes.js';

@Controller({ path: 'venues' })
export abstract class VenuesController {
  @Get()
  index() {}

  @Get(':id')
  byId() {}

  @Post('/')
  create() {}

  @Delete(ROUTES.PURGE)
  purge() {}

  @All('proxy')
  proxy() {}

  @Sse('events')
  events() {}
}

@Controller()
export class RootController {
  @Get('healthz')
  healthz() {}
}
`;
    const expected = [
      '* /venues/proxy',
      'GET /healthz',
      'GET /venues',
      'GET /venues/:id',
      'GET /venues/events',
      'POST /venues',
    ].sort();

    expect(groupPairs(src)).toEqual(expected);
    expect(ingestionPairs(src)).toEqual(expected);
  });

  it('carries the handler name, 1-based line and provider confidence onto the detection', () => {
    // The fields the contract extractor resolves a symbol from. `lineNumber` is
    // already 1-based at the ingestion layer, so the delegation must NOT add
    // one again — `list()` is on line 7 of this source, the same line the
    // replaced code reported via `methodNode.startPosition.row + 1`.
    const src = venuesController("  @Get('list')\n  list() {}");
    expect(TS.plugin.scan(TS.parser.parse(src)).filter((d) => d.framework === 'nest')).toEqual([
      {
        role: 'provider',
        framework: 'nest',
        method: 'GET',
        path: '/venues/list',
        name: 'list',
        line: 7,
        confidence: 0.8,
      },
    ]);
  });
});

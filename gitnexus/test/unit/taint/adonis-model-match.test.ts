import { describe, expect, it } from 'vitest';
import { cfgOf, importsFor } from '../../helpers/ts-cfg-harness.js';
import { computeReachingDefs } from '../../../src/core/ingestion/cfg/reaching-defs.js';
import {
  buildTaintImportIndex,
  matchFunctionSites,
} from '../../../src/core/ingestion/taint/match.js';
import { computeTaintFlows } from '../../../src/core/ingestion/taint/propagate.js';
import { harvestFunctionSummary } from '../../../src/core/ingestion/taint/summary-harvest.js';
import { hasTaintSafeSites } from '../../../src/core/ingestion/taint/site-safety.js';
import type { SourceSinkSanitizerSpec } from '../../../src/core/ingestion/taint/source-sink-config.js';
import { TS_JS_TAINT_MODEL } from '../../../src/core/ingestion/taint/typescript-model.js';

function analyzeAdonis(code: string, spec: SourceSinkSanitizerSpec = TS_JS_TAINT_MODEL) {
  const cfg = cfgOf(code);
  expect(hasTaintSafeSites(cfg)).toBe(true);
  const matches = matchFunctionSites(cfg, spec, buildTaintImportIndex(importsFor(code)));
  const defUse = computeReachingDefs(cfg);
  return {
    matches,
    flows: computeTaintFlows(cfg, defUse, matches),
    summary: harvestFunctionSummary(cfg, defUse, matches).facts,
  };
}

describe('AdonisJS request sources (#2982)', () => {
  describe.each(['request', 'req', 'ctx.request'])('%s', (receiver) => {
    it.each([
      'input',
      'qs',
      'header',
      'param',
      'cookie',
      'all',
      'body',
      'params',
      'headers',
      'only',
      'except',
    ])('tracks the assigned result of %s() to a dangerous call', (method) => {
      const { flows } = analyzeAdonis(`function controller(request, req, ctx) {
        const value = ${receiver}.${method}('value');
        eval(value);
      }`);
      expect(flows.status).toBe('computed');
      expect(flows.findings).toHaveLength(1);
      expect(flows.findings[0]).toMatchObject({
        source: { type: 'call-result', calleeName: `${receiver}.${method}` },
        sinkKind: 'code-injection',
        sink: { entryName: 'eval', argIndex: 0 },
      });
    });
  });

  it('tracks a request destructured from HttpContext in a controller method', () => {
    const { flows } = analyzeAdonis(`import type { HttpContext } from '@adonisjs/core/http';
      export default class UsersController {
        async index({ request }: HttpContext) {
          const value = request.input('search');
          eval(value);
        }
      }`);
    expect(flows.findings).toHaveLength(1);
  });

  it('seeds an interprocedural flow from request.input() into a helper', () => {
    const { summary } = analyzeAdonis(`function controller({ request }) {
      const value = request.input('search');
      runQuery(value);
    }`);
    expect(summary.sourceToCallArg).toEqual([
      expect.objectContaining({
        sourceKind: 'remote-input',
        calleeName: 'runQuery',
        argIndex: 0,
      }),
    ]);
  });

  it('treats validateUsing output as input, without assuming schema validation escapes code', () => {
    const { flows, matches } = analyzeAdonis(`async function controller({ request }) {
      const payload = await request.validateUsing(searchValidator);
      eval(payload.search);
    }`);
    expect(flows.findings).toHaveLength(1);
    expect(flows.kills).toEqual([]);
    expect(matches.statements.flatMap((statement) => statement.sanitizers)).toEqual([]);
  });

  it.each(['cache', 'ctx.response', 'other.request', 'ctx.request.extra'])(
    'does not infer HTTP input from an unregistered receiver %s',
    (receiver) => {
      const { matches, flows } = analyzeAdonis(`function controller(cache, ctx, other) {
        const value = ${receiver}.input('value');
        eval(value);
      }`);
      expect(matches.hasSource).toBe(false);
      expect(flows.findings).toEqual([]);
    },
  );

  it('does not treat an uncalled request method as its result', () => {
    const { matches } = analyzeAdonis(`function controller(request) {
      const method = request.input;
      eval(method);
    }`);
    expect(matches.hasSource).toBe(false);
  });

  it('tracks a request result destructured directly into a local binding', () => {
    const { flows } = analyzeAdonis(`function controller({ request }, db) {
      const { name } = request.only(['name']);
      db.rawQuery('select * from users where name = ' + name);
    }`);
    expect(flows.findings).toHaveLength(1);
    expect(flows.findings[0]).toMatchObject({
      source: { type: 'call-result', calleeName: 'request.only' },
      sinkKind: 'sql-injection',
    });
  });

  // These are coverage gaps, not safe expressions. Keep the documented
  // direct-assignment boundary explicit until inline sources are supported.
  it.each([
    ['inline call', "db.rawQuery(request.input('sql'));"],
    ['concatenation', "const sql = 'select ' + request.input('name'); db.rawQuery(sql);"],
    ['method chain', "const name = request.input('name', '').trim(); db.rawQuery(name);"],
    ['nullish fallback', "const name = request.input('name') ?? ''; db.rawQuery(name);"],
    ['logical fallback', "const name = request.input('name') || ''; db.rawQuery(name);"],
    ['wrapper call', "const name = String(request.input('name')); db.rawQuery(name);"],
    ['template interpolation', "const sql = `select ${request.input('name')}`; db.rawQuery(sql);"],
  ])('documents the current source coverage gap for %s', (_name, body) => {
    const { matches, flows } = analyzeAdonis(`function controller({ request }, db) {
      ${body}
    }`);
    expect(matches.hasSink).toBe(true);
    expect(matches.hasSource).toBe(false);
    expect(flows.findings).toEqual([]);
  });
});

describe('Lucid SQL sinks (#2982)', () => {
  it.each(['db', 'database', 'trx'])('tracks rawQuery SQL on %s', (receiver) => {
    const { flows } = analyzeAdonis(`function controller(req, ${receiver}) {
      const sql = req.body.sql;
      ${receiver}.rawQuery(sql);
    }`);
    expect(flows.findings).toHaveLength(1);
    expect(flows.findings[0]).toMatchObject({
      sinkKind: 'sql-injection',
      sink: { entryName: 'rawQuery', argIndex: 0 },
    });
  });

  it('resolves an aliased Lucid database service import', () => {
    const { flows } = analyzeAdonis(`import sqlClient from '@adonisjs/lucid/services/db';
      function controller(req) {
        sqlClient.rawQuery(req.body.sql);
      }`);
    expect(flows.findings).toHaveLength(1);
    expect(flows.findings[0].sinkKind).toBe('sql-injection');
  });

  it('does not flag input supplied only through SQL value bindings', () => {
    const { flows } = analyzeAdonis(`function controller(req, db) {
      const value = req.body.value;
      db.rawQuery('select * from users where name = ?', [value]);
    }`);
    expect(flows.findings).toEqual([]);
  });

  it('does not flag the zero-argument Lucid query builder', () => {
    const { flows } = analyzeAdonis(`function controller(req, User) {
      const value = req.body.name;
      User.query().where('name', value);
    }`);
    expect(flows.findings).toEqual([]);
  });

  it('does not flag an unrelated rawQuery method', () => {
    const { matches } = analyzeAdonis(`function controller(req, cache) {
      cache.rawQuery(req.body.value);
    }`);
    expect(matches.hasSink).toBe(false);
  });
});

describe('call-result source receiver paths', () => {
  const spec: SourceSinkSanitizerSpec = {
    sources: [
      { type: 'call-result', kind: 'remote-input', receivers: ['ctx.request'], methods: ['input'] },
    ],
    sinks: [{ name: 'eval', kind: 'code-injection', global: true, args: [0] }],
    sanitizers: [],
  };

  it('matches a configured full receiver path rather than only its first segment', () => {
    const { flows } = analyzeAdonis(
      `function controller(ctx) {
      const value = ctx.request.input('search');
      eval(value);
    }`,
      spec,
    );
    expect(flows.findings).toHaveLength(1);
  });

  it.each(['request', 'other.request', 'ctx.other.request', 'ctx.request.extra'])(
    'does not match %s as ctx.request',
    (receiver) => {
      const { matches } = analyzeAdonis(
        `function controller(ctx, other, request) {
        const value = ${receiver}.input('search');
        eval(value);
      }`,
        spec,
      );
      expect(matches.hasSource).toBe(false);
    },
  );
});

import { registerCases } from '../support/cases.mjs';
import { describe, it, before as beforeAll, after as afterAll } from 'node:test';
import { expect } from 'expect';
import path from 'path';
import fs from 'node:fs';
import os from 'node:os';
import { summarizeUnresolvedReceivers } from '../../../../src/core/ingestion/scope-resolution/unresolved-receivers.js';
import {
  getRelationships,
  runPipelineFromRepo,
  useFixture,
  writeFixtureRepo,
  type PipelineResult,
} from '../support/fixture.js';

describe('Literal writes and owned receiver bases preserve bindings', () => {
  let result: PipelineResult;
  let fixtureRoot: string | undefined;

  beforeAll(
    async () => {
      fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gitnexus-literal-bindings-'));
      writeFixtureRepo(fixtureRoot, {
        'private.js': `const config = { privateFlag: true };
class PrivateProducer {
  #make(row) { return { privateFlag: row.value }; }
}
`,
        'owned.dart': `class DartWorker { void go() {} }
class DartBundle { DartWorker worker = DartWorker(); }
class DartOwner {
  DartBundle task = DartBundle();
  void loop(xs) {
    for (final task in xs) { task.worker.go(); }
  }
}
`,
        'input.js': `const config = { secretFlag: true };
export class SignalService {
  make(options) {
    options.secretFlag = false;
    return { secretFlag: options.secretFlag };
  }
}
new SignalService().make(config);
`,
        'foreign-reader.js': `const local = { foreignFlag: 1 };
export class Service { make(obj) { return obj.foreignFlag; } }
`,
        'foreign-producer.js': `export class Service { make() { return { foreignFlag: 0.5 }; } }
`,
        'repeated.js': `function build() { return { data: { data: 1 } }; }
function use() { const res = build(); return res.data.data; }
`,
        'static.js': `class StaticService { go() {} }
class StaticOther { go() {} }
class StaticBase { static svc = new StaticService(); }
class NullChild extends StaticBase { static svc = null; }
class UnknownChild extends StaticBase { static svc = unknownFactory(); }
class InheritedChild extends StaticBase {}
class TypedChild extends StaticBase { static svc = new StaticOther(); }
function nullProbe() { return NullChild.svc.go(); }
function unknownProbe() { return UnknownChild.svc.go(); }
function inheritedProbe() { return InheritedChild.svc.go(); }
function typedProbe() { return TypedChild.svc.go(); }
`,
        'constructor.js': `class JsRepo { save() {} }
class JsActual { save() {} }
function jsShadow(JsRepo) {
  class JsHolder { static item = new JsRepo(); }
  JsHolder.item.save();
}
jsShadow(JsActual);
`,
        'constructor.ts': fs.readFileSync(
          new URL(
            '../../../../test/fixtures/compiler-conformance/typescript-constructor-shadow/constructor.ts',
            import.meta.url,
          ),
          'utf8',
        ),
      });
      result = await runPipelineFromRepo(fixtureRoot, () => {}, { skipGraphPhases: true });
    },
    { timeout: 120000 },
  );

  afterAll(() => {
    if (fixtureRoot !== undefined) fs.rmSync(fixtureRoot, { recursive: true, force: true });
  });

  registerCases(
    it,
    ['read', 'write'],
    'keeps an input property %s on the declared input',
    (kind) => {
      const edges = getRelationships(result, 'ACCESSES').filter(
        (e) =>
          e.rel.sourceId === 'Method:input.js:SignalService.make#1' &&
          e.rel.reason?.endsWith(`: ${kind}`),
      );
      expect(edges.some((e) => e.rel.targetId === 'Property:input.js:config.secretFlag')).toBe(
        true,
      );
      if (kind === 'read') {
        expect(edges.some((e) => e.rel.targetId.includes('SignalService.make.secretFlag@'))).toBe(
          false,
        );
      }
    },
  );

  it('keeps the returned literal declaration write on its own key', () => {
    const writes = getRelationships(result, 'ACCESSES').filter(
      (e) =>
        e.rel.sourceId === 'Method:input.js:SignalService.make#1' &&
        e.rel.targetId === 'Property:input.js:SignalService.make.secretFlag@4:13' &&
        e.rel.reason?.endsWith(': write'),
    );
    expect(writes).toHaveLength(1);
  });

  it('binds a private method literal write to its own returned key', () => {
    const writes = getRelationships(result, 'ACCESSES').filter(
      (e) =>
        e.sourceFilePath === 'private.js' &&
        e.sourceLabel !== 'File' &&
        e.rel.reason?.endsWith(': write'),
    );
    expect(writes).toHaveLength(1);
    expect(writes[0]?.rel.targetId).toContain(
      'Property:private.js:PrivateProducer.#make.privateFlag@',
    );
  });

  it('records a Dart chain on a masked field base as owned but unbound', () => {
    expect(getRelationships(result, 'CALLS').filter((e) => e.source === 'loop')).toEqual([]);
    expect(
      result.resolutionOutcomes?.some(
        (o) =>
          o.kind === 'suppressed' &&
          o.reason === 'receiver-owned-but-unbound' &&
          o.filePath === 'owned.dart' &&
          o.name === 'go',
      ),
    ).toBe(true);
    const owned =
      result.resolutionOutcomes?.filter((outcome) => outcome.filePath === 'owned.dart') ?? [];
    expect(summarizeUnresolvedReceivers(owned)?.counts.go).toBe(1);
  });

  it('keeps the unresolved outer read when a repeated-name inner read was answered', () => {
    const drops = result.resolutionOutcomes?.filter(
      (outcome) =>
        outcome.kind === 'suppressed' &&
        outcome.reason === 'receiver-unresolved' &&
        outcome.filePath === 'repeated.js' &&
        outcome.name === 'data',
    );
    expect(drops).toHaveLength(1);
    expect(drops?.[0]).toMatchObject({
      range: { startLine: 2, startCol: 45, endCol: 58 },
    });
    expect(
      getRelationships(result, 'ACCESSES').some(
        (edge) =>
          edge.sourceFilePath === 'repeated.js' &&
          edge.rel.reason === 'scope-resolution: return-shape member: read',
      ),
    ).toBe(true);
  });

  it('does not borrow a same-named method return shape from another file', () => {
    const reads = getRelationships(result, 'ACCESSES').filter(
      (e) => e.rel.sourceId === 'Method:foreign-reader.js:Service.make#1',
    );
    expect(reads.map((e) => e.rel.targetId)).toEqual([
      'Property:foreign-reader.js:local.foreignFlag',
    ]);
  });

  registerCases(
    it,
    ['nullProbe', 'unknownProbe'],
    'stops at an untyped static override in %s',
    (source) => {
      expect(getRelationships(result, 'CALLS').filter((e) => e.source === source)).toEqual([]);
    },
  );

  registerCases(
    it,
    [
      ['inheritedProbe', 'Method:static.js:StaticService.go#0'],
      ['typedProbe', 'Method:static.js:StaticOther.go#0'],
      ['tsAnnotated', 'Method:constructor.ts:TsRepo.save#0'],
    ],
    'resolves the available field type in %s',
    (source, target) => {
      expect(
        getRelationships(result, 'CALLS')
          .filter((e) => e.source === source)
          .map((e) => e.rel.targetId),
      ).toContain(target);
    },
  );

  registerCases(
    it,
    ['jsShadow', 'tsShadow'],
    'respects the constructor value parameter in %s',
    (source) => {
      expect(getRelationships(result, 'CALLS').filter((e) => e.source === source)).toEqual([]);
    },
  );
});

describe('TypeScript private class members (#1646)', () => {
  const result = useFixture('private-members-ts', {
    'store.ts': fs.readFileSync(
      new URL(
        '../../../../test/fixtures/lang-resolution/ts-private-members/store.ts',
        import.meta.url,
      ),
      'utf8',
    ),
  });
  const edgesFrom = (type: string, source: string) =>
    getRelationships(result(), type).filter((e) => e.source === source);

  it('links a call through this.#name to the method of the same class', () => {
    expect(edgesFrom('CALLS', 'reset').map((e) => e.rel.targetId)).toEqual([
      expect.stringContaining('Store.#bump'),
    ]);
    expect(edgesFrom('CALLS', 'push').map((e) => e.rel.targetId)).toEqual([
      expect.stringContaining('Queue.#bump'),
    ]);
    expect(edgesFrom('CALLS', 'add').map((e) => e.target)).toEqual(['#log']);
    expect(edgesFrom('CALLS', 'make').map((e) => e.target)).toEqual(['#create']);
    expect(edgesFrom('CALLS', 'refresh').map((e) => e.target)).toEqual(['#load']);
  });

  it('attributes a call made in a private method to that method', () => {
    expect(edgesFrom('CALLS', '#log').map((e) => e.target)).toEqual(['write']);
    expect(edgesFrom('CALLS', 'Store').map((e) => e.target)).not.toContain('write');
  });

  it('records reads and writes of private fields', () => {
    const accesses = (source: string) =>
      edgesFrom('ACCESSES', source).map((e) => `${e.rel.reason} ${e.target}`);
    expect(accesses('add')).toEqual(['read #items']);
    expect(accesses('#log')).toEqual(['read #logger']);
    expect(accesses('#load')).toEqual(['read #count']);
    expect(accesses('reset')).toEqual(['write #count']);
    expect(accesses('#bump')).toEqual(['write #count']);
  });

  it('gives private fields a Property node, and a private closure field a Method', () => {
    expect(
      edgesFrom('HAS_PROPERTY', 'Store')
        .map((e) => e.target)
        .sort(),
    ).toEqual(['#count', '#items', '#logger']);
    expect(
      edgesFrom('HAS_METHOD', 'Button')
        .map((e) => e.target)
        .sort(),
    ).toEqual(['#onClick', '#onPress', 'click', 'press']);
    expect(edgesFrom('CALLS', 'click').map((e) => e.targetLabel)).toEqual(['Method']);
    expect(edgesFrom('CALLS', 'press').map((e) => e.targetLabel)).toEqual(['Method']);
  });

  it('links an awaited call with type arguments, await this.#m<T>()', () => {
    expect(edgesFrom('CALLS', 'reload').map((e) => e.target)).toEqual(['#load']);
  });
});

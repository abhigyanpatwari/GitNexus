import { describe, it, expect } from 'vitest';
import { PhaseRegistry } from '../../../src/core/ingestion/pipeline-phases/registry.js';
import type { PipelinePhase } from '../../../src/core/ingestion/pipeline-phases/types.js';
import { buildPhaseList } from '../../../src/core/ingestion/pipeline.js';

// ---------------------------------------------------------------------------
// PhaseRegistry — the issue #2080 phase-registry seam, tested in isolation
// with lightweight fake phases (no real pipeline dependencies).
// ---------------------------------------------------------------------------

const fakePhase = (name: string): PipelinePhase => ({
  name,
  deps: [],
  execute: async () => ({}),
});

describe('PhaseRegistry', () => {
  it('preserves registration order in build()', () => {
    const list = new PhaseRegistry()
      .register(fakePhase('a'))
      .register(fakePhase('b'))
      .register(fakePhase('c'))
      .build({});
    expect(list.map((p) => p.name)).toEqual(['a', 'b', 'c']);
  });

  it('includes a phase with no enabledWhen predicate unconditionally', () => {
    const list = new PhaseRegistry<{ flag?: boolean }>()
      .register(fakePhase('always'))
      .build({ flag: true });
    expect(list.map((p) => p.name)).toEqual(['always']);
  });

  it('excludes a phase whose enabledWhen returns false', () => {
    const reg = new PhaseRegistry<{ skip?: boolean }>()
      .register(fakePhase('core'))
      .register(fakePhase('optional'), { enabledWhen: (o) => !o.skip });

    expect(reg.build({ skip: true }).map((p) => p.name)).toEqual(['core']);
    expect(reg.build({ skip: false }).map((p) => p.name)).toEqual(['core', 'optional']);
    // empty (normalized) options → predicate sees a real object, phase enabled
    expect(reg.build({}).map((p) => p.name)).toEqual(['core', 'optional']);
  });

  it('enabledWhen filtering does not reorder surviving phases', () => {
    const list = new PhaseRegistry<{ drop?: boolean }>()
      .register(fakePhase('first'))
      .register(fakePhase('gated'), { enabledWhen: (o) => !o.drop })
      .register(fakePhase('last'))
      .build({ drop: true });
    expect(list.map((p) => p.name)).toEqual(['first', 'last']);
  });
});

// ---------------------------------------------------------------------------
// buildPhaseList parity — the registry refactor must produce a phase list
// byte-identical (names + order) to the legacy hand-maintained array for
// every options combination. This is the U6 characterization gate (R7/R8).
//
// Note: the second `skipGraphPhases` guard in runPipelineFromRepo (the
// result-extraction path) is intentionally NOT routed through the registry
// (KTD5); it remains keyed on the same option, so membership here stays
// consistent with output consumption there.
// ---------------------------------------------------------------------------

const FULL_ORDER = [
  'scan',
  'structure',
  'markdown',
  'cobol',
  'parse',
  'routes',
  'tools',
  'orm',
  'crossFile',
  'scopeResolution',
  'pruneLocalSymbols',
  'mro',
  'communities',
  'processes',
];

const WITHOUT_GRAPH_PHASES = FULL_ORDER.filter(
  (n) => n !== 'mro' && n !== 'communities' && n !== 'processes',
);

describe('buildPhaseList parity (registry refactor, #2080)', () => {
  it('default options → full phase list in legacy order', () => {
    expect(buildPhaseList(undefined).map((p) => p.name)).toEqual(FULL_ORDER);
    expect(buildPhaseList({}).map((p) => p.name)).toEqual(FULL_ORDER);
  });

  it('skipGraphPhases:false → full phase list (graph phases included)', () => {
    expect(buildPhaseList({ skipGraphPhases: false }).map((p) => p.name)).toEqual(FULL_ORDER);
  });

  it('skipGraphPhases:true → omits exactly mro/communities/processes', () => {
    expect(buildPhaseList({ skipGraphPhases: true }).map((p) => p.name)).toEqual(
      WITHOUT_GRAPH_PHASES,
    );
  });
});

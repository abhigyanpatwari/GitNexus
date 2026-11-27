/**
 * Swift `import X` names a whole module, not a file. Resolution has to see
 * every file of X, but persisting one File -> File IMPORTS edge per file of X
 * makes the graph grow with importers x module size: a large Swift monorepo
 * whose modules are found by directory name produced millions of them.
 *
 * The persisted edge is kept only toward the files of X that declare something
 * the importer reaches, by the way Swift reaches it (`on-demand-imports.ts`).
 * Name resolution is unchanged; these fixtures pin both.
 */
import { describe, expect, it } from 'vitest';
import { getRelationships, useFixture, type PipelineResult } from './helpers.js';
import { isLanguageAvailable } from '../../../src/core/tree-sitter/parser-loader.js';
import { SupportedLanguages } from '../../../src/config/supported-languages.js';
import { MODULE_MEMBERSHIP_REASON } from '../../../src/core/graph/edge-reasons.js';
import {
  DROPS_FIXTURE,
  FANOUT_LAYOUTS,
  fanoutFixture,
  IMPORTERS,
  LOCALS_IMPORTING,
  localsFixture,
  MATRIX,
  matrixFixture,
  MODULES,
  NAMES_FIXTURE,
  NEGATIVES_FIXTURE,
  SAME_NAMED_TYPES,
  SWIFT_IMPORT_REASON,
  swiftImportTargets as importTargets,
  typeFor,
  UNKNOWN_FIXTURE,
} from './swift-fanout-fixtures.js';

const swiftAvailable = isLanguageAvailable(SupportedLanguages.Swift);

function importCount(result: PipelineResult): number {
  return getRelationships(result, 'IMPORTS').filter((e) => e.rel.reason === SWIFT_IMPORT_REASON)
    .length;
}

function membershipCount(result: PipelineResult): number {
  return getRelationships(result, 'IMPORTS').filter(
    (e) => e.rel.reason === MODULE_MEMBERSHIP_REASON,
  ).length;
}

/** `source->target` per edge of `type` that leaves an importer. */
function rowsFromImporters(result: PipelineResult, type: string): string[] {
  return getRelationships(result, type)
    .filter((e) => e.sourceFilePath.includes('/View'))
    .map((e) => `${e.source}@${e.sourceFilePath}->${e.target}@${e.targetFilePath}`)
    .sort();
}

/** Name resolution is the same before and after the narrowing: these counts
 * and rows were recorded on upstream/main, before it, and must not move. */
const BASE_CALLS_FROM_IMPORTERS = 36; // x.describe() per module per importer
const BASE_ACCESSES_FROM_IMPORTERS = 36; // x.id per module per importer

/** One `render -> member` row per module per importer, to the spelled type's file. */
function expectedRows(modulePath: (m: string) => string, member: string): string[] {
  return Array.from({ length: IMPORTERS }, (_, i) =>
    [0, 1, 2].map(
      (m) =>
        `render@${modulePath('App')}/View${i}.swift->${member}@${modulePath(`Mod${m}`)}/${typeFor(m, i)}.swift`,
    ),
  )
    .flat()
    .sort();
}

for (const layout of FANOUT_LAYOUTS) {
  describe.skipIf(!swiftAvailable)(
    `Swift import X persists used files only: ${layout.name}`,
    () => {
      const result = useFixture(layout.prefix, fanoutFixture(layout));

      it('persists one IMPORTS edge per (importer, module), not one per file of the module', () => {
        // Before: IMPORTERS x MODULES x FILES_PER_MODULE = 288.
        expect(importCount(result())).toBe(IMPORTERS * MODULES);
      });

      it('keeps exactly the files that declare the types the importer spells', () => {
        const targets = importTargets(result());
        for (let i = 0; i < IMPORTERS; i++) {
          expect(targets.get(`${layout.modulePath('App')}/View${i}.swift`)).toEqual(
            [0, 1, 2].map((m) => `${layout.modulePath(`Mod${m}`)}/${typeFor(m, i)}.swift`).sort(),
          );
        }
      });

      it('leaves module membership unchanged', () => {
        expect(membershipCount(result())).toBe(layout.membership);
      });

      it('resolves the same CALLS and ACCESSES from importers', () => {
        const calls = rowsFromImporters(result(), 'CALLS');
        const accesses = rowsFromImporters(result(), 'ACCESSES');
        expect(calls).toHaveLength(BASE_CALLS_FROM_IMPORTERS);
        expect(accesses).toHaveLength(BASE_ACCESSES_FROM_IMPORTERS);
        expect(calls).toEqual(expectedRows(layout.modulePath, 'describe'));
        expect(accesses).toEqual(expectedRows(layout.modulePath, 'id'));
      });
    },
  );
}

describe.skipIf(!swiftAvailable)('Swift import X: what an importer reaches', () => {
  const result = useFixture('swift-fanout-names', NAMES_FIXTURE);

  it('keeps no edge to a module the importer names nothing from', () => {
    expect(importTargets(result()).get('App/UsesModel.swift')).not.toContain('Mod1/Thing.swift');
  });

  it('keeps a type and its conformances for an importer that spells the type', () => {
    expect(importTargets(result()).get('App/UsesModel.swift')).toEqual([
      'Mod0/Model+Eq.swift',
      'Mod0/Model.swift',
    ]);
  });

  it('keeps an extension for an importer that calls its member', () => {
    expect(importTargets(result()).get('App/CallsExt.swift')).toEqual([
      'Mod0/Model+Eq.swift',
      'Mod0/Model+Ext.swift',
      'Mod0/Model.swift',
    ]);
  });

  it('treats top-level values and functions as reached by name, and a file that declares nothing as never reached', () => {
    expect(importTargets(result()).get('App/UsesConfig.swift')).toEqual(['Mod0/Config.swift']);
  });

  it('keeps the edges of an explicit `import struct` beside `import X`', () => {
    // `import struct Mod0.Other0` resolves to the module's files and is not
    // narrowed: each of them keeps its edge, whatever the file spells.
    expect(importTargets(result()).get('App/Explicit.swift')).toEqual([
      'Mod0/Config.swift',
      'Mod0/Model+Eq.swift',
      'Mod0/Model+Ext.swift',
      'Mod0/Model.swift',
      'Mod0/Notes.swift',
      'Mod0/Other.swift',
    ]);
  });
});

describe.skipIf(!swiftAvailable)('Swift import X: targets the facts cannot fully read', () => {
  const result = useFixture('swift-fanout-unknown', UNKNOWN_FIXTURE);

  it('keeps a target with a parse error for an importer that names nothing in it', () => {
    expect(importTargets(result()).get('App/E.swift')).toEqual([
      'Err/Broken.swift',
      'Err/Good.swift',
    ]);
  });

  it('keeps every edge of an `@_exported import`', () => {
    expect(importTargets(result()).get('App/Reexport.swift')).toEqual([
      'Err/Broken.swift',
      'Err/Good.swift',
      'Err/Unused.swift',
    ]);
  });
});

describe.skipIf(!swiftAvailable)('Swift import X: names that do not reach a file', () => {
  const result = useFixture('swift-fanout-negatives', NEGATIVES_FIXTURE);

  it('keeps no extension file for an importer that spells only the extended type', () => {
    expect(importTargets(result()).get('App/SpellsHolder.swift')).toEqual(['Neg/Holder.swift']);
  });

  it('keeps an enum case nested in an extension only for an importer that writes that case', () => {
    expect(importTargets(result()).get('App/OtherCase.swift')).toBeUndefined();
    expect(importTargets(result()).get('App/SameCase.swift')).toEqual(['Neg/Holder+Members.swift']);
  });
});

/**
 * Uses the facts cannot tie to a file without resolving names across files.
 * The persisted edge is dropped for them; these tests record which other
 * edge, if any, still links the importer to the file.
 */
describe.skipIf(!swiftAvailable)('Swift import X: documented drops', () => {
  const result = useFixture('swift-fanout-drops', DROPS_FIXTURE);
  const edges = (type: string, from: string) =>
    getRelationships(result(), type)
      .filter((e) => e.sourceFilePath === from)
      .map((e) => `${e.target}@${e.targetFilePath}`)
      .sort();

  it('drops a type-body member reached through a value of inferred type; CALLS and ACCESSES remain', () => {
    expect(importTargets(result()).get('App/Inferred.swift')).toEqual(['Drop/Make.swift']);
    expect(edges('CALLS', 'App/Inferred.swift')).toEqual([
      'makeRunner@Drop/Make.swift',
      'run@Drop/Runner.swift',
    ]);
    expect(edges('ACCESSES', 'App/Inferred.swift')).toEqual(['state@Drop/Runner.swift']);
  });

  it('drops a superclass member reached through a subclass; a CALLS into the superclass file can remain', () => {
    // Chained, nothing records the superclass file.
    expect(importTargets(result()).get('App/Inherited.swift')).toEqual(['Drop/Sub.swift']);
    expect(edges('CALLS', 'App/Inherited.swift')).toEqual(['Sub@Drop/Sub.swift']);
    // Through a local, a parameter or inside a subclass, CALLS reaches the
    // superclass member with no IMPORTS pair.
    for (const importer of ['InheritedLocal', 'InheritedParam', 'InheritedInside']) {
      const file = `App/${importer}.swift`;
      expect(importTargets(result()).get(file)).toEqual(['Drop/Sub.swift']);
      expect(edges('CALLS', file)).toContain('configure@Drop/Base.swift');
    }
  });

  it('drops the type behind a typealias declared in a type body; no edge records it', () => {
    expect(importTargets(result()).get('App/NestedAlias.swift')).toEqual(['Drop/Svc.swift']);
    expect(edges('CALLS', 'App/NestedAlias.swift')).toEqual([]);
    expect(edges('ACCESSES', 'App/NestedAlias.swift')).toEqual([]);
  });

  it('drops the type behind a typealias to a type of another import; no edge records it', () => {
    expect(importTargets(result()).get('App/CrossImportAlias.swift')).toEqual([
      'Facade/Cash.swift',
    ]);
    expect(edges('CALLS', 'App/CrossImportAlias.swift')).toEqual([]);
    expect(edges('ACCESSES', 'App/CrossImportAlias.swift')).toEqual([]);
  });

  it('drops an unlabelled extension subscript used through a type the importer never writes', () => {
    expect(importTargets(result()).get('App/UnlabelledSubscript.swift')).toEqual([
      'Drop/Label.swift',
    ]);
    expect(edges('CALLS', 'App/UnlabelledSubscript.swift')).toEqual(['label@Drop/Label.swift']);
  });

  it('drops a standard-operator overload declared in a type body, used on inferred values', () => {
    expect(importTargets(result()).get('App/TypeBodyOp.swift')).toEqual(['Drop/MakeVec.swift']);
    expect(edges('CALLS', 'App/TypeBodyOp.swift')).toEqual(['makeVec@Drop/MakeVec.swift']);
  });

  it('drops a protocol-extension default taken only through a conformance; IMPLEMENTS remains', () => {
    expect(importTargets(result()).get('App/Conforms.swift')).toEqual(['Drop/P.swift']);
    expect(edges('IMPLEMENTS', 'App/Conforms.swift')).toEqual(['P@Drop/P.swift']);
  });

  it('drops the type of an implicit `.init(...)`; no edge records it', () => {
    expect(importTargets(result()).get('App/ImplicitInit.swift')).toEqual(['Drop/Setup.swift']);
    expect(edges('CALLS', 'App/ImplicitInit.swift')).toEqual(['setup@Drop/Setup.swift']);
  });

  it('drops a standard-operator overload used through a literal; no edge records it', () => {
    expect(importTargets(result()).get('App/LiteralOp.swift')).toBeUndefined();
    expect(edges('CALLS', 'App/LiteralOp.swift')).toEqual([]);
  });

  it('drops a top-level standard-operator overload; no edge records it', () => {
    expect(importTargets(result()).get('App/StdOp.swift')).toEqual(['Drop/Tok.swift']);
    expect(edges('CALLS', 'App/StdOp.swift')).toEqual([]);
  });
});

/** CALLS that leave a matrix importer, recorded on upstream/main before the
 *  narrowing; they must not move. Most matrix uses leave no CALLS at all, so
 *  the persisted IMPORTS edge is their only record. */
const MATRIX_CALLS = [
  'f@App/U21.swift->greet@Kit/K21.swift',
  'load@App/U20.swift->showAlert@Kit/K20.swift',
  'make@App/U22.swift->Inner@Kit/K22.swift',
  'refresh@App/U28.swift->run@Kit/Aliased.swift',
  'use@App/U13.swift->helper@Kit/K13.swift',
  'use@App/U16.swift->current@Kit/Take.swift',
  'use@App/U17.swift->payload@Kit/Take.swift',
  'use@App/U18.swift->steps@Kit/Take.swift',
  'use@App/U19.swift->setPreset@Kit/Take.swift',
  'use@App/U25.swift->steps@Kit/Take.swift',
  'use@App/U5.swift->apply@Kit/Take.swift',
  'use@App/U6.swift->take@Kit/Take.swift',
  'use@App/U7.swift->extra@Kit/K7.swift',
  'use@App/U7.swift->makeUtil@Kit/Take.swift',
  'use@App/U9.swift->paint@Kit/Take.swift',
];

for (const variant of [
  { name: 'alone', module: 'Kit', extra: {}, calls: MATRIX_CALLS },
  {
    // A second type with the same name in the group must not change what the
    // extension files are reached through.
    name: 'beside same-named types',
    module: 'Kit',
    extra: SAME_NAMED_TYPES,
    // Recorded on upstream/main: the duplicate `Holder` hides `extra()`.
    calls: MATRIX_CALLS.filter((row) => !row.includes('extra@')),
  },
]) {
  describe.skipIf(!swiftAvailable)(`Swift import X: declaration kinds, ${variant.name}`, () => {
    const result = useFixture('swift-fanout-matrix', matrixFixture(variant.module, variant.extra));
    it.each(MATRIX.map((entry, k) => ({ ...entry, k })))(
      'keeps the file of a $kind for the importer that uses only it',
      ({ k, alsoKept }) => {
        expect(importTargets(result()).get(`App/U${k}.swift`)).toEqual(
          [`K${k}.swift`, ...(alsoKept ?? [])].map((file) => `${variant.module}/${file}`).sort(),
        );
      },
    );
    it('resolves the same CALLS from the importers as before the narrowing', () => {
      expect(
        getRelationships(result(), 'CALLS')
          .filter((e) => e.sourceFilePath.startsWith('App/'))
          .map((e) => `${e.source}@${e.sourceFilePath}->${e.target}@${e.targetFilePath}`)
          .sort(),
      ).toEqual(variant.calls);
    });
  });
}

describe.skipIf(!swiftAvailable)('Swift import X: common local and member names', () => {
  const result = useFixture('swift-fanout-locals', localsFixture());

  it('keeps exactly one file per (importer, module) when every file shares member names', () => {
    // Before: IMPORTING x MODULES x FILES = 48.
    expect(importCount(result())).toBe(LOCALS_IMPORTING * MODULES);
    const targets = importTargets(result());
    for (let i = 0; i < LOCALS_IMPORTING; i++) {
      expect(targets.get(`App/Use${i}.swift`)).toEqual(
        [0, 1, 2].map((m) => `Mod${m}/Rec${m}_${i}.swift`),
      );
    }
  });
});

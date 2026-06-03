import { describe, it, expect } from 'vitest';

// Every per-language heritage *shape* descriptor.
import { javaHeritageShapes } from '../../src/core/ingestion/heritage-extractors/configs/java.js';
import { csharpHeritageShapes } from '../../src/core/ingestion/heritage-extractors/configs/csharp.js';
import {
  typescriptExtendsShapes,
  typescriptInterfaceShapes,
} from '../../src/core/ingestion/heritage-extractors/configs/typescript.js';
import { javascriptHeritageShapes } from '../../src/core/ingestion/heritage-extractors/configs/javascript.js';
import { pythonHeritageShapes } from '../../src/core/ingestion/heritage-extractors/configs/python.js';
import { rustHeritageShapes } from '../../src/core/ingestion/heritage-extractors/configs/rust.js';
import { goHeritageShapes } from '../../src/core/ingestion/heritage-extractors/configs/go.js';
import { kotlinHeritageShapes } from '../../src/core/ingestion/heritage-extractors/configs/kotlin.js';
import { cppHeritageShapes } from '../../src/core/ingestion/heritage-extractors/configs/cpp.js';
import { rubyHeritageShapes } from '../../src/core/ingestion/heritage-extractors/configs/ruby.js';

// The exported, interpolated query strings (the runtime artifacts).
import {
  JAVA_QUERIES,
  CSHARP_QUERIES,
  TYPESCRIPT_QUERIES,
  JAVASCRIPT_QUERIES,
  PYTHON_QUERIES,
  RUST_QUERIES,
  GO_QUERIES,
  KOTLIN_QUERIES,
  CPP_QUERIES,
  RUBY_QUERIES,
} from '../../src/core/ingestion/tree-sitter-queries.js';

import type { SupertypeShapeDescriptor } from '../../src/core/ingestion/heritage-types.js';

/**
 * Descriptor → *_ALT → query wiring-exhaustiveness gate.
 *
 * A new `*HeritageShapes` descriptor in heritage-extractors/configs/ can be
 * authored but silently never interpolated into its language query in
 * tree-sitter-queries.ts (buildSupertypeAlternation turns each shape into a
 * `(shape)` S-expression token, embedded via a `*_ALT` constant). The existing
 * tree-sitter-queries.test.ts only does coarse `toContain('@heritage.extends')`
 * capture-tag checks; the integration query-compile guard only proves queries
 * compile. Neither catches an unwired descriptor — its shapes simply never
 * appear, and those supertype forms are silently dropped at ingestion.
 *
 * This gate asserts, per descriptor, that every node-type shape appears as a
 * `(shape)` token in the language's exported query string, i.e. the descriptor
 * really is interpolated. The table is data-driven; the exhaustiveness check
 * below asserts it covers EVERY exported descriptor, so adding a new descriptor
 * without wiring it (or without adding a row here) fails this test.
 *
 * Language-agnostic in spirit: this test enumerates configs and inspects the
 * already-built query strings. No language logic lives in shared code.
 */

interface WiringRow {
  /** Stable label for the descriptor (matches its exported const name). */
  descriptor: string;
  shapes: SupertypeShapeDescriptor;
  /** The exported query constant the descriptor must be interpolated into. */
  queryConstant: string;
  query: string;
}

const WIRING: ReadonlyArray<WiringRow> = [
  {
    descriptor: 'javaHeritageShapes',
    shapes: javaHeritageShapes,
    queryConstant: 'JAVA_QUERIES',
    query: JAVA_QUERIES,
  },
  {
    descriptor: 'csharpHeritageShapes',
    shapes: csharpHeritageShapes,
    queryConstant: 'CSHARP_QUERIES',
    query: CSHARP_QUERIES,
  },
  {
    descriptor: 'typescriptExtendsShapes',
    shapes: typescriptExtendsShapes,
    queryConstant: 'TYPESCRIPT_QUERIES',
    query: TYPESCRIPT_QUERIES,
  },
  {
    descriptor: 'typescriptInterfaceShapes',
    shapes: typescriptInterfaceShapes,
    queryConstant: 'TYPESCRIPT_QUERIES',
    query: TYPESCRIPT_QUERIES,
  },
  {
    descriptor: 'javascriptHeritageShapes',
    shapes: javascriptHeritageShapes,
    queryConstant: 'JAVASCRIPT_QUERIES',
    query: JAVASCRIPT_QUERIES,
  },
  {
    descriptor: 'pythonHeritageShapes',
    shapes: pythonHeritageShapes,
    queryConstant: 'PYTHON_QUERIES',
    query: PYTHON_QUERIES,
  },
  {
    descriptor: 'rustHeritageShapes',
    shapes: rustHeritageShapes,
    queryConstant: 'RUST_QUERIES',
    query: RUST_QUERIES,
  },
  {
    descriptor: 'goHeritageShapes',
    shapes: goHeritageShapes,
    queryConstant: 'GO_QUERIES',
    query: GO_QUERIES,
  },
  {
    descriptor: 'kotlinHeritageShapes',
    shapes: kotlinHeritageShapes,
    queryConstant: 'KOTLIN_QUERIES',
    query: KOTLIN_QUERIES,
  },
  {
    descriptor: 'cppHeritageShapes',
    shapes: cppHeritageShapes,
    queryConstant: 'CPP_QUERIES',
    query: CPP_QUERIES,
  },
  {
    descriptor: 'rubyHeritageShapes',
    shapes: rubyHeritageShapes,
    queryConstant: 'RUBY_QUERIES',
    query: RUBY_QUERIES,
  },
];

describe('heritage descriptor → query wiring', () => {
  for (const { descriptor, shapes, queryConstant, query } of WIRING) {
    describe(`${descriptor} → ${queryConstant}`, () => {
      for (const shape of shapes.shapes) {
        it(`interpolates the (${shape}) shape`, () => {
          // buildSupertypeAlternation emits each shape as a `(shape)` token,
          // either standalone `(shape) @tag` or inside a `[(a) (b) …]` one-of.
          expect(query).toContain(`(${shape})`);
        });
      }
    });
  }

  // Exhaustiveness: the table must cover every exported heritage descriptor, so
  // a NEW descriptor added to configs/ without a row here fails the test. The
  // expected set is the union of:
  //   - every descriptor imported/listed above (the table's own descriptors), and
  //   - a hardcoded roster of the known exported descriptor const names.
  // The hardcoded roster is the tripwire: when a config exports a new
  // `*Shapes` const, the author must add it BOTH to the roster and to a WIRING
  // row (and import it), or this test fails. The accompanying comment in
  // tree-sitter-queries.ts and configs/ documents that this table is the
  // canonical wiring registry.
  it('the wiring table covers every exported heritage descriptor', () => {
    // Keep this roster in sync with `grep -roE "export const \\w+Shapes" \
    // src/core/ingestion/heritage-extractors/configs/`. A mismatch here means a
    // descriptor was added/removed without updating the WIRING table above.
    const EXPECTED_DESCRIPTORS = [
      'cppHeritageShapes',
      'csharpHeritageShapes',
      'goHeritageShapes',
      'javaHeritageShapes',
      'javascriptHeritageShapes',
      'kotlinHeritageShapes',
      'pythonHeritageShapes',
      'rubyHeritageShapes',
      'rustHeritageShapes',
      'typescriptExtendsShapes',
      'typescriptInterfaceShapes',
    ].sort();

    const covered = [...new Set(WIRING.map((r) => r.descriptor))].sort();
    expect(covered).toEqual(EXPECTED_DESCRIPTORS);
  });

  it('every descriptor has at least one shape (an empty descriptor would never wire)', () => {
    for (const { descriptor, shapes } of WIRING) {
      expect(shapes.shapes.length, descriptor).toBeGreaterThan(0);
    }
  });
});

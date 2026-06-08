/**
 * Unit Tests: ReferenceProvider (WI-1, issue #159 P2).
 *
 * The provider is a thin port on top of `LspClient` exposing three
 * higher-level LSP verbs needed for Mode B (`rename` + `impact`):
 *
 *   - `resolveSymbol(name, fileHint?)` — `workspace/symbol` filtered
 *     to a single on-identifier `Location` (0, >1, or off-identifier
 *     → null; KD-4).
 *   - `references(loc)` — `textDocument/references` with
 *     `includeDeclaration:false` (empty → [], request null → null).
 *   - `rename(loc, newName)` — `textDocument/rename` returning a
 *     `WorkspaceEdit` (request null or non-text op → null).
 *
 * The unit test surface is a fully-injected mock `LspClient`
 * (just `request` + `didOpen`, which is the entire surface the
 * provider depends on). No real server.
 *
 * Methodology (the WI-1 spec):
 *   - EP (workspace/symbol 0 · 1 · many)
 *   - state-transition (null-refuse)
 *   - BVA (position-on-identifier)
 *
 * Cases (R1, R2, R3, R5, R6, references×3, rename×2):
 *   R1  workspace/symbol []  + name match     → null
 *   R2  workspace/symbol [1] + on-identifier   → Location
 *   R3  workspace/symbol [1] + off-identifier  → null
 *   R5  workspace/symbol [N>1, fileHint match] → 1 candidate Location
 *   R6  workspace/symbol [N>1, ambiguous]      → null
 *   references: includeDeclaration:false asserted
 *   references: empty result → []
 *   references: request null → null
 *   rename: .changes OR .documentChanges form ok
 *   rename: non-text op → null
 *   cross-cut: explicit didOpen is called BEFORE each request
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

import {
  ReferenceProvider,
  DEFAULT_REQUEST_TIMEOUT_MS,
  __test__,
  type Location,
  type WorkspaceEdit,
} from '../../../src/core/ingestion/lsp/reference-provider.js';
import type { LspClient } from '../../../src/core/ingestion/lsp/lsp-client.js';

// ─── Mock factory ────────────────────────────────────────────────────

/**
 * Build a vi.fn()-driven mock LspClient. The provider uses exactly
 * two methods: `request(method, params, timeoutMs)` and
 * `didOpen(uri, content, languageId?)`. We record calls so tests
 * can assert ordering and exact params.
 */
function makeMockClient() {
  const request = vi.fn();
  const didOpen = vi.fn();
  return {
    client: { request, didOpen } as unknown as LspClient & {
      request: ReturnType<typeof vi.fn>;
      didOpen: ReturnType<typeof vi.fn>;
    },
    request,
    didOpen,
  };
}

// ─── Fixtures ────────────────────────────────────────────────────────

const URI = 'file:///workspace/gitnexus/src/core/ingestion/lsp/location-mapper.ts';
const FILE_HINT = 'location-mapper.ts';

const sym = (name: string, line: number, character: number, uri = URI) => ({
  name,
  kind: 12,
  location: {
    uri,
    range: {
      start: { line, character },
      end: { line, character: character + name.length },
    },
  },
});

// ─── Workspace/symbol resolveSymbol EP (R1, R2, R3, R5, R6) ──────────

describe('ReferenceProvider', () => {
  // (S-23) Hoisted `beforeEach` — every sub-suite shares the
  // same fresh mock-client + provider setup. Avoids the
  // triplicated `let { client, request, didOpen } = ...; beforeEach`
  // pattern in the three sub-suites.
  let { client, request, didOpen } = makeMockClient();
  let provider: ReferenceProvider;

  beforeEach(() => {
    ({ client, request, didOpen } = makeMockClient());
    provider = new ReferenceProvider(client, URI);
  });

  describe('resolveSymbol (R1, R2, R3, R5, R6)', () => {
    it('R1: workspace/symbol returns []  → null', async () => {
      request.mockResolvedValueOnce([]);
      const result = await provider.resolveSymbol('mapLocationToNodeId', FILE_HINT);
      expect(result).toBeNull();
      expect(request).toHaveBeenCalledWith(
        'workspace/symbol',
        { query: 'mapLocationToNodeId' },
        DEFAULT_REQUEST_TIMEOUT_MS,
      );
    });

    it('R2: single symbol, on-identifier  → Location', async () => {
      const s = sym('mapLocationToNodeId', 310, 0);
      request.mockResolvedValueOnce([s]);
      const result = await provider.resolveSymbol('mapLocationToNodeId', FILE_HINT);
      expect(result).toEqual({
        uri: URI,
        range: { start: { line: 310, character: 0 } },
      });
    });

    it('R3: single symbol, but off-identifier (character offset absurdly large)  → null', async () => {
      // BVA: the symbol's range start points at a character offset
      // far beyond any plausible line length (> 4096). The provider
      // refuses structurally (KD-4) — it does NOT re-scan the line
      // looking for the identifier.
      const s = {
        name: 'mapLocationToNodeId',
        kind: 12,
        location: {
          uri: URI,
          range: {
            start: { line: 310, character: 9999 },
            end: { line: 310, character: 10000 },
          },
        },
      };
      request.mockResolvedValueOnce([s]);
      const result = await provider.resolveSymbol('mapLocationToNodeId', FILE_HINT);
      expect(result).toBeNull();
    });

    it('R5: many symbols, fileHint narrows to 1  → Location', async () => {
      const inFile = sym('mapLocationToNodeId', 310, 0, URI);
      const otherFile = sym(
        'mapLocationToNodeId',
        0,
        0,
        'file:///workspace/gitnexus/src/core/ingestion/lsp/lsp-client.ts',
      );
      request.mockResolvedValueOnce([otherFile, inFile]);
      const result = await provider.resolveSymbol('mapLocationToNodeId', FILE_HINT);
      expect(result).toEqual({
        uri: URI,
        range: { start: { line: 310, character: 0 } },
      });
    });

    it('R6: many symbols, fileHint does not resolve (still >1)  → null', async () => {
      const a = sym(
        'mapLocationToNodeId',
        0,
        0,
        'file:///workspace/gitnexus/src/core/ingestion/lsp/foo.ts',
      );
      const b = sym(
        'mapLocationToNodeId',
        0,
        0,
        'file:///workspace/gitnexus/src/core/ingestion/lsp/bar.ts',
      );
      request.mockResolvedValueOnce([a, b]);
      // No fileHint
      const result = await provider.resolveSymbol('mapLocationToNodeId');
      expect(result).toBeNull();
    });
  });

  describe('references (includeDeclaration:false, empty, null)', () => {
    const loc: Location = {
      uri: URI,
      range: { start: { line: 310, character: 0 } },
    };

    it('returns the locations array verbatim, sending includeDeclaration:false', async () => {
      const refs: Location[] = [
        { uri: 'file:///workspace/gitnexus/src/x.ts', range: { start: { line: 5, character: 0 } } },
        { uri: 'file:///workspace/gitnexus/src/y.ts', range: { start: { line: 9, character: 2 } } },
      ];
      request.mockResolvedValueOnce(refs);
      const result = await provider.references(loc);
      expect(result).toEqual(refs);
      expect(request).toHaveBeenCalledWith(
        'textDocument/references',
        {
          textDocument: { uri: URI },
          position: { line: 310, character: 0 },
          context: { includeDeclaration: false },
        },
        DEFAULT_REQUEST_TIMEOUT_MS,
      );
    });

    it('empty result → [] (NOT null — refs can legitimately be empty)', async () => {
      request.mockResolvedValueOnce([]);
      const result = await provider.references(loc);
      expect(result).toEqual([]);
    });

    it('request returns null → null (refuse over guess)', async () => {
      request.mockResolvedValueOnce(null);
      const result = await provider.references(loc);
      expect(result).toBeNull();
    });
  });

  describe('rename (.changes, .documentChanges, non-text)', () => {
    const loc: Location = {
      uri: URI,
      range: { start: { line: 310, character: 0 } },
    };

    it('returns the .changes WorkspaceEdit verbatim', async () => {
      const edit: WorkspaceEdit = {
        changes: {
          [URI]: [
            { range: { start: { line: 310, character: 0 }, end: { line: 310, character: 21 } }, newText: 'X' },
          ],
        },
      };
      request.mockResolvedValueOnce(edit);
      const result = await provider.rename(loc, 'X');
      expect(result).toEqual(edit);
      expect(request).toHaveBeenCalledWith(
        'textDocument/rename',
        {
          textDocument: { uri: URI },
          position: { line: 310, character: 0 },
          newName: 'X',
        },
        DEFAULT_REQUEST_TIMEOUT_MS,
      );
    });

    it('returns the .documentChanges WorkspaceEdit verbatim (text edits only)', async () => {
      const edit: WorkspaceEdit = {
        documentChanges: [
          {
            textDocument: { uri: URI, version: 1 },
            edits: [
              { range: { start: { line: 310, character: 0 }, end: { line: 310, character: 21 } }, newText: 'X' },
            ],
          },
        ],
      };
      request.mockResolvedValueOnce(edit);
      const result = await provider.rename(loc, 'X');
      expect(result).toEqual(edit);
    });

    it('non-text op in documentChanges (e.g. create)  → null', async () => {
      const edit: WorkspaceEdit = {
        documentChanges: [
          { kind: 'create', uri: 'file:///workspace/new.ts' },
        ] as any,
      };
      request.mockResolvedValueOnce(edit);
      const result = await provider.rename(loc, 'X');
      expect(result).toBeNull();
    });

    it('request returns null  → null', async () => {
      request.mockResolvedValueOnce(null);
      const result = await provider.rename(loc, 'X');
      expect(result).toBeNull();
    });
  });

  // (S-24) The three sub-suites' "didOpen before request"
  // assertions are consolidated into ONE test in a top-level
  // KD-3 block. The contract is "every LSP request is preceded
  // by a didOpen on the target file" — it is structurally
  // identical for all three verbs, so three near-identical
  // tests were redundant.
  describe('KD-3 — didOpen precedes every request', () => {
    it('resolveSymbol / references / rename all issue didOpen before request', async () => {
      const beforeEach = {
        resolveSymbol: [sym('mapLocationToNodeId', 310, 0)],
        references: [] as Location[],
        rename: { changes: {} },
      };
      // resolveSymbol
      request.mockResolvedValueOnce(beforeEach.resolveSymbol);
      await provider.resolveSymbol('mapLocationToNodeId', FILE_HINT);
      // references
      request.mockResolvedValueOnce(beforeEach.references);
      await provider.references({ uri: URI, range: { start: { line: 310, character: 0 } } });
      // rename
      request.mockResolvedValueOnce(beforeEach.rename);
      await provider.rename({ uri: URI, range: { start: { line: 310, character: 0 } } }, 'X');

      // Three didOpen calls (one per verb), each before its
      // request call. Ordering pairs: (0,1), (2,3), (4,5).
      const o = didOpen.mock.invocationCallOrder;
      const r = request.mock.invocationCallOrder;
      expect(o).toHaveLength(3);
      expect(r).toHaveLength(3);
      expect(o[0]).toBeLessThan(r[0]);
      expect(o[1]).toBeLessThan(r[1]);
      expect(o[2]).toBeLessThan(r[2]);
    });
  });
});

// ─── structural: __test__ export shape ───────────────────────────────

describe('ReferenceProvider — module exports', () => {
  it('exposes internal helpers via __test__', () => {
    expect(__test__).toBeDefined();
    // The on-identifier check must be exported (or a close equivalent)
    // so future tests can pin its behavior.
    expect(typeof __test__.isOnIdentifier).toBe('function');
  });
});

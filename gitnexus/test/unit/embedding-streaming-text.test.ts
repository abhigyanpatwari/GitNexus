import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { iterateCharacterChunks } from '../../src/core/embeddings/character-chunk.js';
import { buildLineIndex } from '../../src/core/embeddings/line-index.js';
import { contentHashForNode } from '../../src/core/embeddings/embedding-pipeline.js';
import { extractDeclarationOnly } from '../../src/core/embeddings/text-generator.js';
import { iterateEmbeddingInputs } from '../../src/core/embeddings/embedding-inputs.js';
import { resolveEmbeddingConfig } from '../../src/core/embeddings/config.js';

const fingerprintNode = (label: string, content: string) => ({
  id: 'Function:src/example.ts:test',
  name: 'Example',
  filePath: 'src/example.ts',
  description: 'Sample description.',
  startLine: 1,
  endLine: 99,
  label,
  content,
});

describe('bounded embedding text preserves existing vectors', () => {
  // Exact text AND line-range receipts captured from AST base 6895f91726a3.
  it.each([
    [
      'Function',
      'sample.ts',
      'ast',
      'full',
      12,
      'e3728ed50afd80c3d9da4ba1b2d23c3f906b230851261462e0e554623196f457',
    ],
    [
      'Function',
      'sample.ts',
      'fixed',
      'full',
      15,
      '718690efd94d6ec0ff458b80280751b16aa57ad285ea5541bbe4f0128ab0999d',
    ],
    [
      'Class',
      'sample.ts',
      'ast',
      'full',
      1,
      '3af1649850519626a030297788391a745ee4370269f1f44a33f4362f7f38f5c2',
    ],
    [
      'Class',
      'sample.ts',
      'fixed',
      'full',
      1,
      '3af1649850519626a030297788391a745ee4370269f1f44a33f4362f7f38f5c2',
    ],
    [
      'Function',
      'sample.ts',
      'ast',
      'symbol',
      12,
      '8c5780484a0f3cfcfbd8b010ecb6ea1988f70594cbc10b400e7d9e8836e9f5c0',
    ],
    [
      'Function',
      'sample.ts',
      'ast',
      'none',
      12,
      '8c5780484a0f3cfcfbd8b010ecb6ea1988f70594cbc10b400e7d9e8836e9f5c0',
    ],
    [
      'Function',
      'sample.ipynb',
      'ast',
      'full',
      12,
      '04670833ee0a82f4e243bf065320bed8a6d2218168b7be617eabe6db144e8eb3',
    ],
  ] as const)(
    'matches AST-base %s %s %s %s inputs',
    async (label, filePath, chunkStrategy, contentRetention, count, digest) => {
      const content =
        label === 'Class'
          ? 'class Sample {\n  field = 42;\n  run() { return "BODY_EXCLUDED"; }\n}'
          : filePath.endsWith('ipynb')
            ? 'def Sample():\n' +
              Array.from({ length: 45 }, (_, i) => `    value${i} = "雪😀"`).join('\n') +
              '\n    return value44'
            : 'function Sample() {\n' +
              Array.from({ length: 45 }, (_, i) => `  const value${i} = "雪😀";`).join('\n') +
              '\n  return value44;\n}';
      const node = {
        id: `${label}:${filePath}:Sample`,
        name: 'Sample',
        label,
        filePath,
        content,
        startLine: 10,
        endLine: 10 + content.split('\n').length - 1,
      };
      const config = resolveEmbeddingConfig({
        chunkSize: 100,
        overlap: 20,
        maxInputChars: 256,
        chunkStrategy,
      });
      const release = vi.fn();
      const readSource = vi.fn(async () => ({ content, release }));
      const inputs = [];
      for await (const input of iterateEmbeddingInputs(node, config, {
        source: { repoPath: '/unused', fileHashes: {}, contentRetention },
        readSource,
      }))
        inputs.push(input);
      expect(inputs).toHaveLength(count);
      expect(createHash('sha256').update(JSON.stringify(inputs)).digest('hex')).toBe(digest);
      expect(release).toHaveBeenCalledTimes(contentRetention === 'full' ? 1 : 0);
      expect(node).not.toHaveProperty('classDeclaration');
      expect(
        inputs
          .filter(() => label === 'Class')
          .map((input) => input.text)
          .join('\n'),
      ).not.toContain('BODY_EXCLUDED');
    },
  );

  it('releases expanded source when iteration is cancelled at a chunk boundary', async () => {
    const node = {
      ...fingerprintNode('Function', 'function sample() ... [truncated]'),
      name: 'sample',
    };
    const release = vi.fn();
    const iterator = iterateEmbeddingInputs(node, resolveEmbeddingConfig({}), {
      source: { repoPath: '/unused', fileHashes: {}, contentRetention: 'full' },
      readSource: async () => ({
        content: 'function sample() {\n' + '  consume();\n'.repeat(1000) + '}',
        release,
      }),
    });
    expect((await iterator.next()).done).toBe(false);
    expect(release).not.toHaveBeenCalled();
    await iterator.return(undefined);
    expect(release).toHaveBeenCalledOnce();
  });
  it.each(['short', 'x'.repeat(2401)])(
    'rejects a negative overlap without skipping source text (case %#)',
    (content) => {
      expect(() => [...iterateCharacterChunks(content, 1, 1, 1200, -1)]).toThrow('overlap');
    },
  );

  it.each([
    [
      'Function',
      'export function 漢() {\r\n  return "😀";  \r\n\r\n\r\n}\u3000\n',
      '69f18eaa2f90496499546d329389cfbbaf05b5ed',
    ],
    ['File', 'a \t\r\n\n\n'.repeat(100000), 'bcdad0b0fb7dda9b85406be8c775ef1df3ac060a'],
    [
      'Class',
      'export class Example {\n value: string;\n method() { return "😀"; }\n}\n',
      '05ce2f0a472c683379947bfe495db27a24e9c401',
    ],
    [
      'TypeAlias',
      'type Huge = ' + '"漢😀" | '.repeat(40000) + 'never;\n',
      'b0b393e258779fafede851f76d33d0831695e6bb',
    ],
    // Captured independently from AST base 6895f91726a3fc2f82add44c4bb0287a5c6b28d3.
  ])('keeps the AST-base %s fingerprint', (label, content, expected) => {
    expect(contentHashForNode(fingerprintNode(label, content))).toBe(expected);
  });

  it('retains every character and exact line spans across Unicode and unusual overlaps', () => {
    const content = '\n😀漢\r\n a\n'.repeat(70);
    for (const overlap of [0, 1, 7, 8, 20]) {
      let covered = 0;
      for (const chunk of iterateCharacterChunks(content, 13, 999, 8, overlap)) {
        expect(chunk.text).toBe(content.slice(chunk.startOffset, chunk.endOffset));
        expect(chunk.startLine).toBe(
          13 + content.slice(0, chunk.startOffset).split('\n').length - 1,
        );
        expect(chunk.endLine).toBe(
          13 + content.slice(0, chunk.endOffset - 1).split('\n').length - 1,
        );
        expect(chunk.startOffset).toBeLessThanOrEqual(covered);
        covered = chunk.endOffset;
      }
      expect(covered).toBe(content.length);
    }
  });

  it('produces the first huge-line chunk without retaining the remaining chunks', () => {
    const content = '漢😀'.repeat(1000000);
    const iterator = iterateCharacterChunks(content, 1, 1, 1200, 120);
    expect(iterator.next().value).toMatchObject({
      text: content.slice(0, 1200),
      startOffset: 0,
      endOffset: 1200,
      startLine: 1,
      endLine: 1,
    });
    iterator.return(undefined);
    expect(iterator.next().done).toBe(true);
  });

  it('packs line offsets including the final empty line', () => {
    expect(buildLineIndex('a\r\n😀\n\n')).toEqual(new Int32Array([0, 3, 6, 7]));
    const index = buildLineIndex('a\n'.repeat(1000000));
    expect(index.length).toBe(1000001);
    expect(index.at(-1)).toBe(2000000);
  });

  it('keeps exactly three lines of declaration brace lookahead', () => {
    expect(extractDeclarationOnly('class Example\n\n\n{\n field: string;\n}')).toBe(
      'class Example',
    );
    expect(extractDeclarationOnly('class Example\n\n\n\n{\n field: string;\n}')).toBe('');
  });
});

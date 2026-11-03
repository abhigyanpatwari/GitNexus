import { describe, expect, it } from 'vitest';
import { iterateCharacterChunks } from '../../src/core/embeddings/character-chunk.js';
import { buildLineIndex } from '../../src/core/embeddings/line-index.js';
import { contentHashForNode } from '../../src/core/embeddings/embedding-pipeline.js';
import { extractDeclarationOnly } from '../../src/core/embeddings/text-generator.js';

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
  it.each([
    [
      'Function',
      'export function 漢() {\r\n  return "😀";  \r\n\r\n\r\n}\u3000\n',
      '69f18eaa2f90496499546d329389cfbbaf05b5ed',
    ],
    ['File', 'a \t\r\n\n\n'.repeat(100000), '8750197e52b3b2d3ce89913a1946ff377f3b47e6'],
    [
      'Class',
      'export class Example {\n value: string;\n method() { return "😀"; }\n}\n',
      '9559301b3f875312190e654e10b16734631a1dee',
    ],
    [
      'TypeAlias',
      'type Huge = ' + '"漢😀" | '.repeat(40000) + 'never;\n',
      'b0b393e258779fafede851f76d33d0831695e6bb',
    ],
  ])('keeps the pre-change v7 %s fingerprint', (label, content, expected) => {
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
        if (overlap >= 0) expect(chunk.startOffset).toBeLessThanOrEqual(covered);
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

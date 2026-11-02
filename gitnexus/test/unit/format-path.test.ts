import { describe, expect, it } from 'vitest';
import { formatPathForTerminal } from '../../src/cli/format-path.js';

describe('terminal path rendering', () => {
  it('preserves ordinary Unicode and spaces', () => {
    expect(formatPathForTerminal('src/王 name.ts')).toBe('src/王 name.ts');
  });

  it.each(['\u001b', '\u0007', '\r', '\n', '\u007f', '\u0085', '\u009b'])(
    'renders control %j visibly without changing the decoded path',
    (control) => {
      const filePath = `src/a${control}.ts`;
      const rendered = formatPathForTerminal(filePath);
      expect(rendered).not.toMatch(/[\u0000-\u001f\u007f-\u009f]/);
      expect(JSON.parse(rendered)).toBe(filePath);
    },
  );
});

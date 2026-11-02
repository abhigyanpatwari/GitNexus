import { expect, it } from 'vitest';
import { hasFilePrivateExportSemantics } from '../../src/core/ingestion/languages/typescript/file-private-exports.js';

it.each([
  ['plain module', 'entry.ts', 'interface Entry {}\nexport function verify() {}', true],
  ['JS module', 'entry.js', 'class Entry {}\nexport function verify() {}', true],
  ['TSX module', 'entry.tsx', 'interface Entry {}\nexport const View = () => <div/>;', true],
  ['JSX module', 'entry.jsx', 'class Entry {}\nexport const View = () => <div/>;', true],
  ['named export', 'entry.ts', 'interface Entry {}\nexport { Entry };', false],
  ['renamed export', 'entry.ts', 'interface Entry {}\nexport { Entry as Public };', false],
  ['default export', 'entry.ts', 'class Entry {}\nexport default Entry;', false],
  ['assignment export', 'entry.ts', 'class Entry {}\nexport = Entry;', false],
  ['type alias', 'entry.ts', 'interface Entry {}\nexport type Public = Entry;', false],
  [
    'wrapped type alias',
    'entry.ts',
    'class Entry {}\nexport type Public = Readonly<Entry>;',
    false,
  ],
  ['CommonJS', 'entry.js', 'class Entry {}\nmodule.exports = Entry;', false],
  ['bracket CommonJS', 'entry.js', "class Entry {}\nmodule['exports'] = Entry;", false],
  [
    'mixed CommonJS',
    'entry.js',
    'class Entry {}\nexports.Entry = Entry;\nexport const n = 1;',
    false,
  ],
  ['ambient', 'entry.d.ts', 'interface Entry {}\nexport const n: number;', false],
  ['ambient ESM', 'entry.d.mts', 'interface Entry {}\nexport const n: number;', false],
  ['script global', 'entry.ts', 'interface Entry {}', false],
  [
    'global augmentation',
    'entry.ts',
    "import './side'; declare global { interface Entry {} }",
    false,
  ],
  ['missing retained source', 'entry.ts', '', false],
  [
    'normalized line comment',
    'entry.ts',
    'interface Entry {} export function verify() {} // comment export { Entry };',
    false,
  ],
  [
    'truncated source',
    'entry.ts',
    'interface Entry {} export function verify() {} /* [truncated] */',
    false,
  ],
  ['invalid source', 'entry.ts', 'interface Entry {\nexport const', false],
])('%s has conservative file privacy', (_label, filePath, content, expected) => {
  expect(hasFilePrivateExportSemantics(filePath, content)).toBe(expected);
});

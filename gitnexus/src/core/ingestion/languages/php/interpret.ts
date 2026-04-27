import type { CaptureMatch, ParsedImport } from 'gitnexus-shared';

export function interpretPhpImport(captures: CaptureMatch): ParsedImport | null {
  const statement = captures['@import.statement'];
  if (statement === undefined) return null;

  // A very basic PHP import parser for MVP.
  // Strips `use `, `use function `, and the trailing semicolon.
  let text = statement.text.trim();
  text = text.replace(/^use\s+(function|const)?\s*/, '').replace(/;$/, '').trim();

  // Handle aliases: `use Foo\Bar as Baz;`
  if (text.includes(' as ')) {
    const [imported, alias] = text.split(/\s+as\s+/);
    if (!imported || !alias) return null;
    return {
      kind: 'alias',
      localName: alias.trim(),
      importedName: imported.trim(),
      alias: alias.trim(),
      targetRaw: imported.trim(),
    };
  }

  // Handle basic namespaced imports: `use Foo\Bar;` -> exposed as `Bar`
  const parts = text.split('\\');
  const localName = parts[parts.length - 1];
  if (!localName) return null;

  return {
    kind: 'namespace',
    localName: localName.trim(),
    importedName: text,
    targetRaw: text,
  };
}

import { describe, it, expect } from 'vitest';
import { extractNamespaceViaScanner } from '../../src/core/ingestion/languages/php/namespace-siblings.js';

describe('extractNamespaceViaScanner', () => {
  it('extracts standard namespace declaration', () => {
    const src = `<?php\nnamespace App\\Models;\n\nclass User {}`;
    expect(extractNamespaceViaScanner(src)).toBe('App\\Models');
  });

  it('extracts braced namespace declaration', () => {
    const src = `<?php\nnamespace App\\Models {\n  class User {}\n}`;
    expect(extractNamespaceViaScanner(src)).toBe('App\\Models');
  });

  it('extracts namespace on same line as opening tag', () => {
    const src = `<?php namespace App\\Services;`;
    expect(extractNamespaceViaScanner(src)).toBe('App\\Services');
  });

  it('extracts namespace after declare(strict_types=1)', () => {
    const src = `<?php\ndeclare(strict_types=1);\nnamespace App\\Http\\Controllers;\n\nclass FooController {}`;
    expect(extractNamespaceViaScanner(src)).toBe('App\\Http\\Controllers');
  });

  it('extracts namespace after docblock', () => {
    const src = `<?php\n/**\n * This is a docblock.\n */\nnamespace Vendor\\Package;`;
    expect(extractNamespaceViaScanner(src)).toBe('Vendor\\Package');
  });

  it('returns empty string for no namespace declaration', () => {
    const src = `<?php\nfunction foo() { return 42; }`;
    expect(extractNamespaceViaScanner(src)).toBe('');
  });

  it('returns empty string for empty file', () => {
    expect(extractNamespaceViaScanner('')).toBe('');
  });

  it('handles uppercase NAMESPACE keyword (case-insensitive)', () => {
    const src = `<?php\nNAMESPACE App\\Legacy;`;
    expect(extractNamespaceViaScanner(src)).toBe('App\\Legacy');
  });

  it('handles mixed-case Namespace keyword', () => {
    const src = `<?php\nNamespace App\\Mixed;`;
    expect(extractNamespaceViaScanner(src)).toBe('App\\Mixed');
  });

  it('ignores namespace inside heredoc body', () => {
    const src = [
      '<?php',
      '$code = <<<EOT',
      'namespace Fake\\Vendor;',
      'EOT;',
      'namespace App\\Real;',
    ].join('\n');
    expect(extractNamespaceViaScanner(src)).toBe('App\\Real');
  });

  it('ignores namespace inside nowdoc body', () => {
    const src = [
      '<?php',
      "$code = <<<'EOT'",
      'namespace Fake\\Vendor;',
      'EOT;',
      'namespace App\\Real;',
    ].join('\n');
    expect(extractNamespaceViaScanner(src)).toBe('App\\Real');
  });

  it('ignores namespace inside block comment', () => {
    const src = ['<?php', '/*', ' * namespace Fake\\Comment;', ' */', 'namespace App\\Real;'].join(
      '\n',
    );
    expect(extractNamespaceViaScanner(src)).toBe('App\\Real');
  });

  it('ignores namespace after // single-line comment marker', () => {
    const src = `<?php\n// namespace Fake\\Comment;\nnamespace App\\Real;`;
    expect(extractNamespaceViaScanner(src)).toBe('App\\Real');
  });

  it('ignores namespace after # single-line comment marker', () => {
    const src = `<?php\n# namespace Fake\\Comment;\nnamespace App\\Real;`;
    expect(extractNamespaceViaScanner(src)).toBe('App\\Real');
  });

  it('does not match namespace inside a string on the same line as other code', () => {
    const src = `<?php\n$x = "namespace Fake\\Str;";\nnamespace App\\Real;`;
    expect(extractNamespaceViaScanner(src)).toBe('App\\Real');
  });

  it('handles declare on same line as opening tag and namespace', () => {
    const src = `<?php declare(strict_types=1); namespace App\\Inline;`;
    expect(extractNamespaceViaScanner(src)).toBe('App\\Inline');
  });

  it('ignores namespace inside mid-line block comment', () => {
    const src = ['<?php /*', 'namespace Fake\\Comment;', '*/', 'namespace App\\Real;'].join('\n');
    expect(extractNamespaceViaScanner(src)).toBe('App\\Real');
  });

  it('handles single-line block comment before namespace on same line', () => {
    const src = `<?php /* comment */ namespace App\\After;`;
    expect(extractNamespaceViaScanner(src)).toBe('App\\After');
  });

  it('handles PHP 7.3 flexible heredoc with indented closing delimiter', () => {
    const src = [
      '<?php',
      '$code = <<<EOT',
      '    namespace Fake\\Vendor;',
      '    EOT;',
      'namespace App\\Real;',
    ].join('\n');
    expect(extractNamespaceViaScanner(src)).toBe('App\\Real');
  });

  it('handles nowdoc with indented closing delimiter', () => {
    const src = [
      '<?php',
      "$code = <<<'EOT'",
      '    namespace Fake\\Vendor;',
      '  EOT;',
      'namespace App\\Real;',
    ].join('\n');
    expect(extractNamespaceViaScanner(src)).toBe('App\\Real');
  });
});

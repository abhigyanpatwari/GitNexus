import { describe, it, expect } from 'vitest';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { safeJSON, generateHTMLViewer } from '../../src/core/wiki/html-viewer.js';

describe('safeJSON', () => {
  it('escapes < to \\u003c', () => {
    expect(safeJSON('a < b')).toContain('\\u003c');
    expect(safeJSON('a < b')).not.toContain('<');
  });

  it('escapes > to \\u003e', () => {
    expect(safeJSON('a > b')).toContain('\\u003e');
    expect(safeJSON('a > b')).not.toContain('>');
  });

  it('escapes & to \\u0026', () => {
    expect(safeJSON('a & b')).toContain('\\u0026');
    expect(safeJSON('a & b')).not.toContain('&');
  });

  it('escapes </script> — the primary XSS vector', () => {
    const result = safeJSON({ content: '</script><img onerror=alert(1)>' });
    expect(result).not.toContain('</script>');
    expect(result).not.toContain('<');
    expect(result).not.toContain('>');
  });

  it('round-trips through JSON.parse to the original value', () => {
    const values = [
      'hello',
      '<script>alert(1)</script>',
      { key: 'a < b & c > d' },
      ['</script>', '&amp;', '<div>'],
      null,
      42,
    ];
    for (const v of values) {
      expect(JSON.parse(safeJSON(v))).toEqual(v);
    }
  });

  it('does not double-escape — replacement order is safe', () => {
    const result = safeJSON('&lt;');
    const parsed = JSON.parse(result);
    expect(parsed).toBe('&lt;');
  });

  it('returns "null" for non-serializable values like undefined', () => {
    expect(safeJSON(undefined)).toBe('null');
    expect(safeJSON(() => {})).toBe('null');
  });
});

describe('generateHTMLViewer — CSP meta tag', () => {
  it('includes a Content-Security-Policy meta tag in generated HTML', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'wiki-csp-'));
    try {
      await fs.writeFile(path.join(tmpDir, 'overview.md'), '# Hello');
      await fs.writeFile(path.join(tmpDir, 'module_tree.json'), '[]');
      const outputPath = await generateHTMLViewer(tmpDir, 'TestProject');
      const html = await fs.readFile(outputPath, 'utf-8');
      expect(html).toContain('Content-Security-Policy');
      expect(html).toContain("'unsafe-eval'");
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });
});

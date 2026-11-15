import { describe, expect, it } from 'vitest';

import {
  sanitizeMermaidDiagram,
  sanitizeMermaidMarkdown,
} from '../../src/core/wiki/mermaid-sanitizer.js';

describe('sanitizeMermaidMarkdown', () => {
  it('replaces literal newline escapes inside rectangle and diamond labels', () => {
    const markdown = [
      '```mermaid',
      'flowchart TD',
      '    A[HTTP request\\nwith ID param] --> B{Preceding tei:zone\\nwith @start=#pid?}',
      '```',
    ].join('\n');

    const sanitized = sanitizeMermaidMarkdown(markdown);

    expect(sanitized).toContain('A[HTTP request<br/>with ID param]');
    expect(sanitized).toContain('B{Preceding tei:zone<br/>with @start=#pid?}');
    expect(sanitized).not.toContain('\\n');
  });

  it('quotes unsafe edge labels without changing safe labels', () => {
    const diagram = [
      'graph LR',
      '    Script -->|doc()| eXist[(eXist-db XML)]',
      '    Client -->|HTTP params| Script',
    ].join('\n');

    const sanitized = sanitizeMermaidDiagram(diagram);

    expect(sanitized).toContain('Script -->|"doc()"| eXist[(eXist-db XML)]');
    expect(sanitized).toContain('Client -->|HTTP params| Script');
  });

  it('encodes quotes and preserves backslashes in quoted edge labels', () => {
    const diagram = ['graph LR', '    Script -->|doc("C:\\\\tmp")| Target'].join('\n');

    const sanitized = sanitizeMermaidDiagram(diagram);

    expect(sanitized).toContain('Script -->|"doc(#quot;C:\\\\tmp#quot;)"| Target');
  });

  it('aliases bare node IDs that contain dots and keeps display labels', () => {
    const diagram = [
      'graph LR',
      '    Client -->|xmlurl + xslurl| xslt-conversion.xq',
      '    xslt-conversion.xq -->|stream-transform| lbpwebjs-main.xsl',
      '    lbpwebjs-main.xsl -->|fetches| TEI-XML[(TEI XML in eXist)]',
    ].join('\n');

    const sanitized = sanitizeMermaidDiagram(diagram);

    expect(sanitized).toContain(
      'Client -->|xmlurl + xslurl| xslt-conversion_xq["xslt-conversion.xq"]',
    );
    expect(sanitized).toContain(
      'xslt-conversion_xq["xslt-conversion.xq"] -->|stream-transform| lbpwebjs-main_xsl["lbpwebjs-main.xsl"]',
    );
    expect(sanitized).toContain(
      'lbpwebjs-main_xsl["lbpwebjs-main.xsl"] -->|fetches| TEI-XML[(TEI XML in eXist)]',
    );
  });

  it('aliases unsafe node IDs while preserving existing inline labels', () => {
    const diagram = [
      'graph LR',
      '    file.name.ts[(eXist-db XML)] --> target.node["Target node"]',
    ].join('\n');

    const sanitized = sanitizeMermaidDiagram(diagram);

    expect(sanitized).toContain('file_name_ts[(eXist-db XML)] --> target_node["Target node"]');
  });

  it('leaves an ellipsis or a dotted name inside a label alone', () => {
    // #3705: these three diagrams are valid; sanitizing must not change them.
    const diagrams = [
      'flowchart TD\n    A["value.when(...)"] -->|data| B["data"]',
      'flowchart TD\n    G["x = compute(...).result"] --> H["done"]',
      'flowchart LR\n    N -- ref.invalidate --> A',
    ];

    for (const diagram of diagrams) {
      expect(sanitizeMermaidDiagram(diagram)).toBe(diagram);
    }
  });

  it('reads dots as a link only in the dotted link syntax', () => {
    const diagram = [
      'flowchart LR',
      '    A -.-> B',
      '    B -. later .-> C',
      '    C -..- D',
      '    file.ts -.-> E["x..y"]',
    ].join('\n');

    const sanitized = sanitizeMermaidDiagram(diagram);

    expect(sanitized).toContain('A -.-> B');
    expect(sanitized).toContain('B -. later .-> C');
    expect(sanitized).toContain('C -..- D');
    expect(sanitized).toContain('file_ts["file.ts"] -.-> E["x..y"]');
  });

  it('keeps the text of a labelled link while still aliasing the nodes around it', () => {
    const diagram = [
      'flowchart LR',
      '    cache.ts -- ref.invalidate --> store.ts',
      '    store.ts == on.save ==> db[(db)]',
      '    a.b -- plain --> c[c --> d]',
    ].join('\n');

    const sanitized = sanitizeMermaidDiagram(diagram);

    expect(sanitized).toContain('cache_ts["cache.ts"] -- ref.invalidate --> store_ts["store.ts"]');
    expect(sanitized).toContain('store_ts["store.ts"] == on.save ==> db[(db)]');
    expect(sanitized).toContain('a_b["a.b"] -- plain --> c[c --> d]');
  });

  it('only rewrites fenced Mermaid blocks in markdown', () => {
    const markdown = [
      'Regular text with doc() and file.name.ts.',
      '',
      '```ts',
      'const label = "A\\nB";',
      '```',
      '',
      '```mermaid',
      'flowchart LR',
      '    A -->|doc()| file.name.ts',
      '```',
    ].join('\n');

    const sanitized = sanitizeMermaidMarkdown(markdown);

    expect(sanitized).toContain('Regular text with doc() and file.name.ts.');
    expect(sanitized).toContain('const label = "A\\nB";');
    expect(sanitized).toContain('A -->|"doc()"| file_name_ts["file.name.ts"]');
  });
});

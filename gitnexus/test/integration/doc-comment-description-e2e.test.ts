import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runPipelineFromRepo } from './resolvers/helpers.js';
import type { PipelineResult } from '../../src/types/pipeline.js';
import { isLanguageAvailable } from '../../src/core/tree-sitter/parser-loader.js';
import { SupportedLanguages } from '../../src/config/supported-languages.js';

function createSwiftRepo(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'doc-desc-swift-e2e-'));
  fs.writeFileSync(
    path.join(dir, 'Widget.swift'),
    [
      'class Widget {',
      '  /**',
      '   Renders the widget, marker SWIFTDOC.',
      '   Example:',
      '   #if os(iOS)',
      '   useUIKit()',
      '   #endif',
      '   */',
      '  func render() {}',
      '}',
      '',
    ].join('\n'),
  );
  return dir;
}

describe('doc-comment description end-to-end (issue #2270)', () => {
  // Swift preprocessing blanks nested conditional directives before parsing;
  // doing that inside a doc comment would delete lines from `description` (#2771).
  it.skipIf(!isLanguageAvailable(SupportedLanguages.Swift))(
    'keeps directive lines inside a Swift doc comment in the node description',
    async () => {
      const result: PipelineResult = await runPipelineFromRepo(createSwiftRepo(), () => {}, {
        skipGraphPhases: true,
        workerPoolSize: 2,
      });

      const descriptions = new Map<string, unknown>();
      result.graph.forEachNode((node) => {
        descriptions.set(`${node.label}:${node.properties.name}`, node.properties.description);
      });

      expect(descriptions.get('Function:render')).toBe(
        'Renders the widget, marker SWIFTDOC. Example: #if os(iOS) useUIKit() #endif',
      );
    },
  );
});

/**
 * End-to-end coverage of Blade view-to-view links (#1853).
 *
 * Runs the full ingestion pipeline on a small Laravel view tree and checks the
 * IMPORTS edges the blade phase adds between Blade File nodes, and from PHP
 * code to the views it renders.
 *
 * Fixture: `test/fixtures/blade-view-app/`.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import path from 'node:path';
import { runPipelineFromRepo } from '../../src/core/ingestion/pipeline.js';
import {
  BLADE_VIEW_REFERENCE_REASON,
  BLADE_VIEW_RENDER_REASON,
} from '../../src/core/graph/edge-reasons.js';
import type { PipelineResult } from '../../src/types/pipeline.js';

const FIXTURE = path.resolve(__dirname, '..', 'fixtures', 'blade-view-app');
const VIEWS = 'resources/views';

describe('Blade view imports — ingestion pipeline (#1853)', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(FIXTURE, () => {}, {});
  }, 60_000);

  function bladeLinks(): string[] {
    const links: string[] = [];
    result.graph.forEachRelationship((rel) => {
      if (rel.type !== 'IMPORTS' || rel.reason !== BLADE_VIEW_REFERENCE_REASON) return;
      const source = result.graph.getNode(rel.sourceId)?.properties.filePath;
      const target = result.graph.getNode(rel.targetId)?.properties.filePath;
      links.push(`${source} -> ${target}`);
    });
    return links.sort();
  }

  it('links each view to the layouts, partials, and components it uses', () => {
    expect(bladeLinks()).toEqual(
      [
        `${VIEWS}/layouts/app.blade.php -> ${VIEWS}/partials/nav.blade.php`,
        `${VIEWS}/posts/index.blade.php -> ${VIEWS}/components/alert.blade.php`,
        `${VIEWS}/posts/index.blade.php -> ${VIEWS}/components/forms/input/index.blade.php`,
        `${VIEWS}/posts/index.blade.php -> ${VIEWS}/layouts/app.blade.php`,
        `${VIEWS}/posts/index.blade.php -> ${VIEWS}/partials/promo.blade.php`,
        `${VIEWS}/posts/index.blade.php -> ${VIEWS}/posts/row.blade.php`,
        `${VIEWS}/posts/show.blade.php -> ${VIEWS}/layouts/app.blade.php`,
        `${VIEWS}/posts/show.blade.php -> ${VIEWS}/partials/promo.blade.php`,
      ].sort(),
    );
  });

  function renderLinks(): string[] {
    const links: string[] = [];
    result.graph.forEachRelationship((rel) => {
      if (rel.type !== 'IMPORTS' || !rel.reason?.startsWith(BLADE_VIEW_RENDER_REASON)) return;
      const source = result.graph.getNode(rel.sourceId)?.properties.filePath;
      const target = result.graph.getNode(rel.targetId)?.properties.filePath;
      const via = [...rel.reason.matchAll(/\|via:([^|]+)/g)]
        .map((m) => result.graph.getNode(m[1])?.properties.name)
        .sort();
      links.push(`${source} -> ${target} via [${via.join(', ')}]`);
    });
    return links.sort();
  }

  it('links PHP code to the views it renders, naming the rendering methods', () => {
    const controller = 'app/Http/Controllers/PostController.php';
    expect(renderLinks()).toEqual(
      [
        // view() and View::make(); errors.404 has no file and view($name) is dynamic.
        `${controller} -> ${VIEWS}/posts/index.blade.php via [index]`,
        `${controller} -> ${VIEWS}/posts/show.blade.php via [show]`,
        // Route::view at file scope: no enclosing callable to name.
        `routes/web.php -> ${VIEWS}/partials/promo.blade.php via []`,
      ].sort(),
    );
  });

  it('keeps Blade templates out of PHP symbol extraction', () => {
    const bladeSymbols: string[] = [];
    result.graph.forEachNode((node) => {
      const filePath = String(node.properties.filePath ?? '');
      if (node.label !== 'File' && node.label !== 'Folder' && filePath.endsWith('.blade.php')) {
        bladeSymbols.push(`${node.label}:${node.properties.name}`);
      }
    });
    expect(bladeSymbols).toEqual([]);
  });
});

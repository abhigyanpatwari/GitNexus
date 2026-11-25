import { describe, expect, it } from 'vitest';
import {
  extractBladeViewReferences,
  processBlade,
} from '../../src/core/ingestion/blade-processor.js';
import { BLADE_VIEW_REFERENCE_REASON } from '../../src/core/graph/edge-reasons.js';
import { createKnowledgeGraph } from '../../src/core/graph/graph.js';
import { generateId } from '../../src/lib/utils.js';

describe('extractBladeViewReferences', () => {
  it('reads the view name from each directive', () => {
    const { views } = extractBladeViewReferences(`
@extends('layouts.app')
@include("partials.nav")
@includeIf('partials.promo', ['x' => 1])
@component('components.card')
@each('orders.row', $orders, 'order')
@includeWhen($user->isAdmin(), 'partials.admin')
@includeUnless($hidden, 'partials.footer')
@includeFirst(['custom.header', "partials.header"])
`);
    expect(views).toEqual([
      'layouts.app',
      'partials.nav',
      'partials.promo',
      'components.card',
      'orders.row',
      'partials.admin',
      'partials.footer',
      'custom.header',
      'partials.header',
    ]);
  });

  it('reads anonymous component tags and ignores Blade built-in tags', () => {
    const { components } = extractBladeViewReferences(
      `<x-alert type="error"><x-slot name="title">Hi</x-slot></x-alert>
<x-forms.input name="q" /><x-user-card /><x-dynamic-component :component="$c" />`,
    );
    expect(components).toEqual(['alert', 'forms.input', 'user-card']);
  });

  it('skips dynamic, namespaced, escaped, and commented-out references', () => {
    const { views } = extractBladeViewReferences(`
@include($view)
@include("{$prefix}.nav")
@include('mail::message')
@@include('partials.literal')
{{-- @include('partials.old') --}}
{{--
  @extends('layouts.legacy')
--}}
`);
    expect(views).toEqual([]);
  });
});

describe('processBlade', () => {
  const graphWithFiles = (paths: string[]) => {
    const graph = createKnowledgeGraph();
    for (const filePath of paths) {
      graph.addNode({
        id: generateId('File', filePath),
        label: 'File',
        properties: { name: filePath, filePath },
      });
    }
    return graph;
  };

  const importsFrom = (graph: ReturnType<typeof createKnowledgeGraph>, sourcePath: string) =>
    [...graph.iterRelationshipsByType('IMPORTS')]
      .filter((r) => r.sourceId === generateId('File', sourcePath))
      .map((r) => graph.getNode(r.targetId)?.properties.filePath)
      .sort();

  it('links a view to the existing views it names, once each', () => {
    const paths = [
      'resources/views/home.blade.php',
      'resources/views/layouts/app.blade.php',
      'resources/views/components/alert.blade.php',
    ];
    const graph = graphWithFiles(paths);

    const result = processBlade(
      graph,
      [
        {
          path: 'resources/views/home.blade.php',
          content: `@extends('layouts.app') @extends('layouts/app')
<x-alert /> @include('partials.missing')`,
        },
      ],
      new Set(paths),
    );

    expect(result.links).toBe(2);
    expect(importsFrom(graph, 'resources/views/home.blade.php')).toEqual([
      'resources/views/components/alert.blade.php',
      'resources/views/layouts/app.blade.php',
    ]);
    const reasons = [...graph.iterRelationshipsByType('IMPORTS')].map((r) => r.reason);
    expect(reasons).toEqual([BLADE_VIEW_REFERENCE_REASON, BLADE_VIEW_REFERENCE_REASON]);
  });

  it('resolves names against the views folder of an app in a subfolder first', () => {
    const paths = [
      'backend/resources/views/home.blade.php',
      'backend/resources/views/layouts/app.blade.php',
      'resources/views/layouts/app.blade.php',
    ];
    const graph = graphWithFiles(paths);

    processBlade(
      graph,
      [{ path: 'backend/resources/views/home.blade.php', content: `@extends('layouts.app')` }],
      new Set(paths),
    );

    expect(importsFrom(graph, 'backend/resources/views/home.blade.php')).toEqual([
      'backend/resources/views/layouts/app.blade.php',
    ]);
  });

  it('ignores files that are not Blade templates', () => {
    const paths = ['app/Http/Kernel.php', 'resources/views/layouts/app.blade.php'];
    const graph = graphWithFiles(paths);

    const result = processBlade(
      graph,
      [{ path: 'app/Http/Kernel.php', content: `// @extends('layouts.app')` }],
      new Set(paths),
    );

    expect(result.links).toBe(0);
  });
});

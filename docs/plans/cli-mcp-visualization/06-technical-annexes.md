# 06 — Technical Annexes

**Feature:** CLI-MCP Graph Visualization (`gitnexus view`)

---

## Implementation tasks

```
[ ] 1. Export `buildGraph()` from `gitnexus/src/server/api.ts`
        Add `export` keyword to the const declaration (line 20)

[ ] 2. Create `gitnexus/src/core/graph/html-graph-viewer.ts`
        Generates self-contained HTML from { nodes, relationships }
        Pattern: follow `gitnexus/src/core/wiki/html-viewer.ts`
        Renderer: Sigma.js v3 from cdn.jsdelivr.net
        Embed nodes + relationships as window.GRAPH_DATA = {...}

[ ] 3. Create `gitnexus/src/cli/view.ts`
        - Find repo via `findRepo(cwd)` (same as other CLI commands)
        - Init KuzuDB via `initKuzu(repo.kuzuPath)`
        - Call `buildGraph()` to get { nodes, relationships }
        - Call `generateHTMLGraphViewer(outputPath, nodes, relationships, projectName)`
        - Open with `open`/`xdg-open` unless `--no-open`

[ ] 4. Register command in `gitnexus/src/cli/index.ts`
        program
          .command('view [path]')
          .description('Open interactive graph visualization in browser')
          .option('--output <file>', 'Output HTML path', '.gitnexus/graph.html')
          .option('--no-open', 'Generate file without opening browser')
          .action(viewCommand)

[ ] 5. Node coloring: map cluster heuristicLabel to color palette
        20-color categorical palette (one per cluster label)
        Fallback: grey for unassigned nodes

[ ] 6. Resolve Q3 (node filtering defaults) before implementing R4
```

---

## Key reference files

| File | What to read |
|------|--------------|
| `gitnexus/src/core/wiki/html-viewer.ts` | Self-contained HTML pattern to follow |
| `gitnexus/src/server/api.ts:20` | `buildGraph()` — copy the query logic exactly |
| `gitnexus/src/cli/wiki.ts` | CLI command pattern (`gitnexus wiki`) |
| `gitnexus-web/src/lib/graph-adapter.ts` | Existing Sigma.js node/edge attribute shapes |

---

## Sigma.js v3 CDN snippet (starting point)

```html
<script src="https://cdn.jsdelivr.net/npm/sigma@3/build/sigma.min.js"></script>
<script src="https://cdn.jsdelivr.net/npm/graphology@0.25/dist/graphology.umd.min.js"></script>
<script src="https://cdn.jsdelivr.net/npm/graphology-layout-forceatlas2@0.10/dist/graphology-layout-forceatlas2.min.js"></script>
```

Minimal bootstrap:
```js
const graph = new graphology.Graph({ type: 'directed' });

GRAPH_DATA.nodes.forEach(n => graph.addNode(n.id, {
  label: n.properties.name,
  size: 4,
  color: clusterColor(n.properties.heuristicLabel),
  x: Math.random(), y: Math.random(),
}));

GRAPH_DATA.relationships.forEach(r => {
  if (graph.hasNode(r.sourceId) && graph.hasNode(r.targetId)) {
    graph.addEdge(r.sourceId, r.targetId, { type: r.type, color: '#ccc', size: 1 });
  }
});

FA2Layout.assign(graph, { iterations: 100 });
const renderer = new Sigma(graph, document.getElementById('container'));
```

---

## Development cycle

1. **Red:** write failing BDD scenarios (`03-prd.md`) as integration tests
2. **Green:** implement tasks 1–5 above
3. **Blue:** verify on a real repo (GitNexus itself — 1306 symbols), measure render time
4. Resolve Q1 (performance threshold) from empirical measurement in step 3

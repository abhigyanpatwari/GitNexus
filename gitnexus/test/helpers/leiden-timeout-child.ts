import {
  buildGraphologyGraph,
  runGraphologyLeiden,
} from '../../src/core/ingestion/community-processor.js';

// 105-node / 128-edge graph from #3476 on which the vendored Leiden never
// terminates (graphology/graphology#557). Preserve the original insertion order:
// sorting either the nodes or edges changes the path through the algorithm.
const EDGES =
  '39-26 65-66 72-52 10-38 98-68 37-10 26-81 37-38 30-66 18-66 30-97 84-81 50-96 36-76 ' +
  '33-29 54-87 4-75 44-31 29-31 60-44 91-10 48-41 68-15 83-90 82-57 50-71 28-55 100-11 ' +
  '42-19 28-42 74-92 55-5 7-65 96-41 61-27 60-85 89-67 97-34 94-64 89-6 61-51 12-13 ' +
  '35-9 91-20 94-23 91-7 43-99 80-85 80-101 75-50 38-57 4-104 35-6 65-103 83-45 62-91 ' +
  '16-37 94-33 103-17 67-66 39-73 68-2 26-31 48-19 43-88 88-47 54-42 26-66 100-65 7-30 ' +
  '32-13 56-2 22-24 78-24 84-53 90-71 60-12 76-49 86-35 55-68 96-46 33-30 4-1 24-68 ' +
  '23-14 93-3 58-56 64-27 85-87 61-101 36-37 37-85 60-63 37-26 41-74 103-87 78-36 69-97 ' +
  '77-42 97-52 57-25 27-34 68-28 95-104 18-96 4-15 60-48 17-14 51-31 83-40 48-75 16-99 ' +
  '79-65 70-14 3-27 0-62 21-101 44-59 4-24 34-52 65-8 102-66 67-24 11-26 39-78 6-103 ' +
  '4-71 70-4';

const graph = buildGraphologyGraph({
  nodes: Array.from({ length: 105 }, (_, i) => ({
    id: String(i),
    name: String(i),
    filePath: `/src/${i}.ts`,
    type: 'Function',
  })),
  edges: EDGES.split(/\s+/).map((edge) => {
    const [source, target] = edge.split('-').map(Number);
    return [source, target];
  }),
  symbolCount: 105,
  isLarge: false,
});

const result = await runGraphologyLeiden(graph, false, 'graphology', 500);
console.log(JSON.stringify(result));
// No explicit exit: a leaked worker must keep this process alive for the parent to detect.

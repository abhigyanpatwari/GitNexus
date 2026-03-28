/**
 * Graphology Leiden Algorithm
 * ============================
 *
 * JavaScript implementation of the Leiden community detection
 * algorithm for graphology.
 *
 * Vendored from: https://github.com/graphology/graphology/tree/master/src/communities-leiden
 * License: MIT
 *
 * Converted to ESM for Vite compatibility.
 *
 * [Reference]
 * Traag, V. A., et al. "From Louvain to Leiden: Guaranteeing Well-Connected
 * Communities". Scientific Reports, vol. 9, no 1, 2019, p. 5233.
 * https://arxiv.org/abs/1810.08473
 */
import resolveDefaults from 'graphology-utils/defaults';
import isGraph from 'graphology-utils/is-graph';
import inferType from 'graphology-utils/infer-type';
import SparseMap from 'mnemonist/sparse-map';
import SparseQueueSet from 'mnemonist/sparse-queue-set';
import randomIndexModule from 'pandemonium/random-index';
import { addWeightToCommunity, UndirectedLeidenAddenda } from './utils.js';

import indices from 'graphology-indices/louvain';

var createRandomIndex = randomIndexModule.createRandomIndex || randomIndexModule;
var UndirectedLouvainIndex = indices.UndirectedLouvainIndex;

var DEFAULTS = {
  attributes: {
    community: 'community',
    weight: 'weight',
  },
  randomness: 0.01,
  randomWalk: true,
  resolution: 1,
  rng: Math.random,
  weighted: false,
};

var EPSILON = 1e-10;

function tieBreaker(bestCommunity, currentCommunity, targetCommunity, delta, bestDelta) {
  if (Math.abs(delta - bestDelta) < EPSILON) {
    if (bestCommunity === currentCommunity) {
      return false;
    } else {
      return targetCommunity > bestCommunity;
    }
  } else if (delta > bestDelta) {
    return true;
  }

  return false;
}

function undirectedLeiden(detailed, graph, options) {
  var index = new UndirectedLouvainIndex(graph, {
    attributes: {
      weight: options.attributes.weight,
    },
    keepDendrogram: detailed,
    resolution: options.resolution,
    weighted: options.weighted,
  });

  var addenda = new UndirectedLeidenAddenda(index, {
    randomness: options.randomness,
    rng: options.rng,
  });

  var randomIndex = createRandomIndex(options.rng);

  // Communities
  var currentCommunity, targetCommunity;
  var communities = new SparseMap(Float64Array, index.C);

  // Traversal
  var queue = new SparseQueueSet(index.C),
    start,
    end,
    weight,
    ci,
    ri,
    s,
    i,
    j,
    l;

  // Metrics
  var degree, targetCommunityDegree;

  // Moves
  var bestCommunity, bestDelta, deltaIsBetter, delta;

  // Details
  var deltaComputations = 0,
    nodesVisited = 0,
    moves = [],
    currentMoves;

  while (true) {
    l = index.C;

    currentMoves = 0;

    // Traversal of the graph
    ri = options.randomWalk ? randomIndex(l) : 0;

    for (s = 0; s < l; s++, ri++) {
      i = ri % l;
      queue.enqueue(i);
    }

    while (queue.size !== 0) {
      i = queue.dequeue();
      nodesVisited++;

      degree = 0;
      communities.clear();

      currentCommunity = index.belongings[i];

      start = index.starts[i];
      end = index.starts[i + 1];

      // Traversing neighbors
      for (; start < end; start++) {
        j = index.neighborhood[start];
        weight = index.weights[start];

        targetCommunity = index.belongings[j];

        // Incrementing metrics
        degree += weight;
        addWeightToCommunity(communities, targetCommunity, weight);
      }

      // Finding best community to move to
      bestDelta = index.fastDeltaWithOwnCommunity(
        i,
        degree,
        communities.get(currentCommunity) || 0,
        currentCommunity,
      );
      bestCommunity = currentCommunity;

      for (ci = 0; ci < communities.size; ci++) {
        targetCommunity = communities.dense[ci];

        if (targetCommunity === currentCommunity) continue;

        targetCommunityDegree = communities.vals[ci];

        deltaComputations++;

        delta = index.fastDelta(i, degree, targetCommunityDegree, targetCommunity);

        deltaIsBetter = tieBreaker(
          bestCommunity,
          currentCommunity,
          targetCommunity,
          delta,
          bestDelta,
        );

        if (deltaIsBetter) {
          bestDelta = delta;
          bestCommunity = targetCommunity;
        }
      }

      if (bestDelta < 0) {
        bestCommunity = index.isolate(i, degree);

        if (bestCommunity === currentCommunity) continue;
      } else {
        if (bestCommunity === currentCommunity) {
          continue;
        } else {
          index.move(i, degree, bestCommunity);
        }
      }

      currentMoves++;

      // Adding neighbors from other communities to the queue
      start = index.starts[i];
      end = index.starts[i + 1];

      for (; start < end; start++) {
        j = index.neighborhood[start];
        targetCommunity = index.belongings[j];

        if (targetCommunity !== bestCommunity) queue.enqueue(j);
      }
    }

    moves.push(currentMoves);

    if (currentMoves === 0) {
      index.zoomOut();
      break;
    }

    if (!addenda.onlySingletons()) {
      // We continue working on the induced graph
      addenda.zoomOut();
      continue;
    }

    break;
  }

  var results = {
    index: index,
    deltaComputations: deltaComputations,
    nodesVisited: nodesVisited,
    moves: moves,
  };

  return results;
}

/**
 * Function returning the communities mapping of the graph.
 */
function leiden(assign, detailed, graph, options) {
  if (!isGraph(graph))
    throw new Error(
      'graphology-communities-leiden: the given graph is not a valid graphology instance.',
    );

  var type = inferType(graph);

  if (type === 'mixed')
    throw new Error(
      'graphology-communities-leiden: cannot run the algorithm on a true mixed graph.',
    );

  if (type === 'directed')
    throw new Error('graphology-communities-leiden: not yet implemented for directed graphs.');

  // Attributes name
  options = resolveDefaults(options, DEFAULTS);

  // Empty graph case
  var c = 0;

  if (graph.size === 0) {
    if (assign) {
      graph.forEachNode(function (node) {
        graph.setNodeAttribute(node, options.attributes.communities, c++);
      });

      return;
    }

    var communities = {};

    graph.forEachNode(function (node) {
      communities[node] = c++;
    });

    if (!detailed) return communities;

    return {
      communities: communities,
      count: graph.order,
      deltaComputations: 0,
      dendrogram: null,
      level: 0,
      modularity: NaN,
      moves: null,
      nodesVisited: 0,
      resolution: options.resolution,
    };
  }

  var fn = undirectedLeiden;

  var results = fn(detailed, graph, options);

  var index = results.index;

  // Standard output
  if (!detailed) {
    if (assign) {
      index.assign(options.attributes.community);
      return;
    }

    return index.collect();
  }

  // Detailed output
  var output = {
    count: index.C,
    deltaComputations: results.deltaComputations,
    dendrogram: index.dendrogram,
    level: index.level,
    modularity: index.modularity(),
    moves: results.moves,
    nodesVisited: results.nodesVisited,
    resolution: options.resolution,
  };

  if (assign) {
    index.assign(options.attributes.community);
    return output;
  }

  output.communities = index.collect();

  return output;
}

/**
 * Exporting.
 */
var fn = leiden.bind(null, false, false);
fn.assign = leiden.bind(null, true, false);
fn.detailed = leiden.bind(null, false, true);
fn.defaults = DEFAULTS;

export default fn;

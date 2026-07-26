/**
 * Graphology Leiden Utils
 * ========================
 *
 * Miscellaneous utilities used by the Leiden algorithm.
 *
 * Vendored from: https://github.com/graphology/graphology/tree/master/src/communities-leiden
 * License: MIT
 *
 * LOCAL MODIFICATION (#2337) — do NOT re-vendor this file by copying upstream
 * over it without re-applying the change below.
 *
 *   `mergeNodesSubset` used to snapshot the pre-merge
 *   `externalEdgeWeightPerCommunity` with a full N-length `.slice()` on every
 *   macro-community — O(communities x N) copying, ~70% of Leiden runtime on
 *   large repos. It now writes only the current subset's entries into a
 *   scratch buffer allocated once (`this.microDegrees`).
 *
 * A revert is invisible to the test suite: the two versions produce
 * bit-identical partitions, so every golden and determinism test still passes.
 * The only symptom is the old timeout cliff returning — a 200k-symbol
 * projection back over LEIDEN_TIMEOUT_MS, collapsing every symbol into one
 * community. Search for "microDegrees" to find both edits.
 */
var SparseMap = require('mnemonist/sparse-map');
var createRandom = require('pandemonium/random').createRandom;

function addWeightToCommunity(map, community, weight) {
 var currentWeight = map.get(community);

 if (typeof currentWeight === 'undefined') currentWeight = 0;

 currentWeight += weight;

 map.set(community, currentWeight);
}

function UndirectedLeidenAddenda(index, options) {
 options = options || {};

 var rng = options.rng || Math.random;
 var randomness = 'randomness' in options ? options.randomness : 0.01;

 this.index = index;
 this.random = createRandom(rng);
 this.randomness = randomness;
 this.rng = rng;

 var NodesPointerArray = index.counts.constructor;
 var WeightsArray = index.weights.constructor;

 var order = index.C;
 this.resolution = index.resolution;

 // Used to group nodes by communities
 this.B = index.C;
 this.C = 0;
 this.communitiesOffsets = new NodesPointerArray(order);
 this.nodesSortedByCommunities = new NodesPointerArray(order);
 this.communitiesBounds = new NodesPointerArray(order + 1);

 // Used to merge nodes subsets
 this.communityWeights = new WeightsArray(order);
 this.degrees = new WeightsArray(order);
 this.nonSingleton = new Uint8Array(order);
 this.externalEdgeWeightPerCommunity = new WeightsArray(order);
 this.belongings = new NodesPointerArray(order);
 this.neighboringCommunities = new SparseMap(WeightsArray, order);
 this.cumulativeIncrement = new Float64Array(order);
 // Scratch buffer for mergeNodesSubset's pre-merge snapshot, allocated once.
 // Upstream re-`.slice()`d the full N-length array per macro-community, which is
 // O(communities x N) copying — 70% of Leiden runtime on large repos (#2337).
 this.microDegrees = new WeightsArray(order);
 this.macroCommunities = null;
}

UndirectedLeidenAddenda.prototype.groupByCommunities = function () {
 var index = this.index;

 var n, i, c, b, o;

 n = 0;
 o = 0;

 for (i = 0; i < index.C; i++) {
 c = index.counts[i];

 if (c !== 0) {
 this.communitiesBounds[o++] = n;
 n += c;
 this.communitiesOffsets[i] = n;
 }
 }

 this.communitiesBounds[o] = n;

 o = 0;

 for (i = 0; i < index.C; i++) {
 b = index.belongings[i];
 o = --this.communitiesOffsets[b];
 this.nodesSortedByCommunities[o] = i;
 }

 this.B = index.C - index.U;
 this.C = index.C;
};

UndirectedLeidenAddenda.prototype.communities = function () {
 var communities = new Array(this.B);

 var i, j, community, start, stop;

 for (i = 0; i < this.B; i++) {
 start = this.communitiesBounds[i];
 stop = this.communitiesBounds[i + 1];
 community = [];

 for (j = start; j < stop; j++) {
 community.push(j);
 }

 communities[i] = community;
 }

 return communities;
};

UndirectedLeidenAddenda.prototype.mergeNodesSubset = function (start, stop) {
 var index = this.index;
 var currentMacroCommunity =
 index.belongings[this.nodesSortedByCommunities[start]];
 var neighboringCommunities = this.neighboringCommunities;

 var totalNodeWeight = 0;

 var i, j, w;
 var ei, el, et;

 // Initializing singletons
 for (j = start; j < stop; j++) {
 i = this.nodesSortedByCommunities[j];

 this.belongings[i] = i;
 this.nonSingleton[i] = 0;
 this.degrees[i] = 0;
 totalNodeWeight += index.loops[i] / 2;

 this.communityWeights[i] = index.loops[i];
 this.externalEdgeWeightPerCommunity[i] = 0;

 ei = index.starts[i];
 el = index.starts[i + 1];

 for (; ei < el; ei++) {
 et = index.neighborhood[ei];
 w = index.weights[ei];

 this.degrees[i] += w;

 if (index.belongings[et] !== currentMacroCommunity) continue;

 totalNodeWeight += w;
 this.externalEdgeWeightPerCommunity[i] += w;
 this.communityWeights[i] += w;
 }
 }

 // Only entries for nodes inside [start, stop) are ever read below (every `et`
 // is filtered on `belongings[et] === currentMacroCommunity`), so snapshot just
 // those instead of copying the whole N-length array.
 var microDegrees = this.microDegrees;

 for (j = start; j < stop; j++) {
 i = this.nodesSortedByCommunities[j];
 microDegrees[i] = this.externalEdgeWeightPerCommunity[i];
 }

 var s, ri, ci;
 var order = stop - start;

 var degree,
 bestCommunity,
 qualityValueIncrement,
 maxQualityValueIncrement,
 totalTransformedQualityValueIncrement,
 targetCommunity,
 targetCommunityDegree,
 targetCommunityWeight;

 var r, lo, hi, mid, chosenCommunity;

 ri = this.random(start, stop - 1);

 for (s = start; s < stop; s++, ri++) {
 j = start + (ri % order);

 i = this.nodesSortedByCommunities[j];

 if (this.nonSingleton[i] === 1) {
 continue;
 }

 if (
 this.externalEdgeWeightPerCommunity[i] <
 this.communityWeights[i] *
 (totalNodeWeight / 2 - this.communityWeights[i]) *
 this.resolution
 ) {
 continue;
 }

 this.communityWeights[i] = 0;
 this.externalEdgeWeightPerCommunity[i] = 0;

 neighboringCommunities.clear();
 neighboringCommunities.set(i, 0);

 degree = 0;

 ei = index.starts[i];
 el = index.starts[i + 1];

 for (; ei < el; ei++) {
 et = index.neighborhood[ei];

 if (index.belongings[et] !== currentMacroCommunity) continue;

 w = index.weights[ei];

 degree += w;

 addWeightToCommunity(neighboringCommunities, this.belongings[et], w);
 }

 bestCommunity = i;
 maxQualityValueIncrement = 0;
 totalTransformedQualityValueIncrement = 0;

 for (ci = 0; ci < neighboringCommunities.size; ci++) {
 targetCommunity = neighboringCommunities.dense[ci];
 targetCommunityDegree = neighboringCommunities.vals[ci];
 targetCommunityWeight = this.communityWeights[targetCommunity];

 if (
 this.externalEdgeWeightPerCommunity[targetCommunity] >=
 targetCommunityWeight *
 (totalNodeWeight / 2 - targetCommunityWeight) *
 this.resolution
 ) {
 qualityValueIncrement =
 targetCommunityDegree -
 ((degree + index.loops[i]) *
 targetCommunityWeight *
 this.resolution) /
 totalNodeWeight;

 if (qualityValueIncrement > maxQualityValueIncrement) {
 bestCommunity = targetCommunity;
 maxQualityValueIncrement = qualityValueIncrement;
 }

 if (qualityValueIncrement >= 0)
 totalTransformedQualityValueIncrement += Math.exp(
 qualityValueIncrement / this.randomness
 );
 }

 this.cumulativeIncrement[ci] = totalTransformedQualityValueIncrement;
 }

 if (
 totalTransformedQualityValueIncrement < Number.MAX_VALUE &&
 totalTransformedQualityValueIncrement < Infinity
 ) {
 r = totalTransformedQualityValueIncrement * this.rng();
 lo = -1;
 hi = neighboringCommunities.size + 1;

 while (lo < hi - 1) {
 mid = (lo + hi) >>> 1;

 if (this.cumulativeIncrement[mid] >= r) hi = mid;
 else lo = mid;
 }

 chosenCommunity = neighboringCommunities.dense[hi];
 } else {
 chosenCommunity = bestCommunity;
 }

 this.communityWeights[chosenCommunity] += degree + index.loops[i];

 ei = index.starts[i];
 el = index.starts[i + 1];

 for (; ei < el; ei++) {
 et = index.neighborhood[ei];

 if (index.belongings[et] !== currentMacroCommunity) continue;

 targetCommunity = this.belongings[et];

 if (targetCommunity === chosenCommunity) {
 this.externalEdgeWeightPerCommunity[chosenCommunity] -=
 microDegrees[et];
 } else {
 this.externalEdgeWeightPerCommunity[chosenCommunity] +=
 microDegrees[et];
 }
 }

 if (chosenCommunity !== i) {
 this.belongings[i] = chosenCommunity;
 this.nonSingleton[chosenCommunity] = 1;
 this.C--;
 }
 }

 var microCommunities = this.neighboringCommunities;
 microCommunities.clear();

 for (j = start; j < stop; j++) {
 i = this.nodesSortedByCommunities[j];
 microCommunities.set(this.belongings[i], 1);
 }

 return microCommunities.dense.slice(0, microCommunities.size);
};

UndirectedLeidenAddenda.prototype.refinePartition = function () {
 this.groupByCommunities();

 this.macroCommunities = new Array(this.B);

 var i, start, stop, mapping;

 var bounds = this.communitiesBounds;

 for (i = 0; i < this.B; i++) {
 start = bounds[i];
 stop = bounds[i + 1];

 mapping = this.mergeNodesSubset(start, stop);
 this.macroCommunities[i] = mapping;
 }
};

UndirectedLeidenAddenda.prototype.split = function () {
 var index = this.index;
 var isolates = this.neighboringCommunities;

 isolates.clear();

 var i, community, isolated;

 for (i = 0; i < index.C; i++) {
 community = this.belongings[i];

 if (i !== community) continue;

 isolated = index.isolate(i, this.degrees[i]);
 isolates.set(community, isolated);
 }

 for (i = 0; i < index.C; i++) {
 community = this.belongings[i];

 if (i === community) continue;

 isolated = isolates.get(community);
 index.move(i, this.degrees[i], isolated);
 }

 var j, macro;

 for (i = 0; i < this.macroCommunities.length; i++) {
 macro = this.macroCommunities[i];

 for (j = 0; j < macro.length; j++) macro[j] = isolates.get(macro[j]);
 }
};

UndirectedLeidenAddenda.prototype.zoomOut = function () {
 var index = this.index;
 this.refinePartition();
 this.split();

 var newLabels = index.zoomOut();

 var macro, leader, follower;

 var i, j;

 for (i = 0; i < this.macroCommunities.length; i++) {
 macro = this.macroCommunities[i];
 leader = newLabels[macro[0]];

 for (j = 1; j < macro.length; j++) {
 follower = newLabels[macro[j]];
 index.expensiveMove(follower, leader);
 }
 }
};

UndirectedLeidenAddenda.prototype.onlySingletons = function () {
 var index = this.index;

 var i;

 for (i = 0; i < index.C; i++) {
 if (index.counts[i] > 1) return false;
 }

 return true;
};

exports.addWeightToCommunity = addWeightToCommunity;
exports.UndirectedLeidenAddenda = UndirectedLeidenAddenda;

/**
 * Heritage Map — model module facade re-export (SM-20).
 *
 * NOTE: This file is a facade, NOT a model implementation. The actual
 * HeritageMap lives in `../heritage-map.ts` (parent module). It is
 * re-exported here so consumers can import all resolution-time data
 * structures through the unified `model/` module boundary via `model/index.ts`.
 *
 * Do not add heritage logic to this file. If a new heritage-related type
 * or helper is needed, add it to the parent `heritage-map.ts` and re-export
 * it from here.
 */

export { type HeritageMap, buildHeritageMap } from '../heritage-map.js';

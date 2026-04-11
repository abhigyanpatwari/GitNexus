/**
 * Heritage Map — model module re-export (SM-20).
 *
 * Re-exports the HeritageMap interface and buildHeritageMap factory from the
 * parent module so that consumers can import heritage data through the
 * unified `model/` module boundary.
 */

export { type HeritageMap, buildHeritageMap } from '../heritage-map.js';

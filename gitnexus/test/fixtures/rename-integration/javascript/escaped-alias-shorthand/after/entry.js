import { compute } from "./source.js";
import { middle } from "./middle.js";
export const handlers = { calculate: compute };
export function entry() { return compute() + middle(); }
function shadow(calculate) { return calculate; }
const label = "calculate";

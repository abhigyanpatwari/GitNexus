import { calculate } from "./source.js";
import { middle } from "./middle.js";
export const handlers = { calculate };
export function entry() { return calculate() + middle(); }
function shadow(calculate) { return calculate; }
const label = "calculate";

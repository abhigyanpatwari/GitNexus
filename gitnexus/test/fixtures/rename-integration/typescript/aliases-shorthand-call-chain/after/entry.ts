import { compute } from "./source";
import { middle } from "./middle";
export function entry() { return middle(); }
export const handlers = { calculate: compute };
function shadow(calculate: number) { return calculate; }
const label = "calculate";

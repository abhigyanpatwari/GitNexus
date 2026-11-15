import { calculate } from "./source";
import { middle } from "./middle";
export function entry() { return middle(); }
export const handlers = { calculate };
function shadow(calculate: number) { return calculate; }
const label = "calculate";

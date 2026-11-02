import { value as renderer, Other } from "./model";
export function entry() { return renderer.render(); }
export function replace() { renderer = new Other(); }

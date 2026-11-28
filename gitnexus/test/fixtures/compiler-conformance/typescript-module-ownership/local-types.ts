
class Impl { save() {} }
function hidden() {}
export type { Impl as Public };
export { type hidden };
export function directValue() {}
export type { directValue as Erased };

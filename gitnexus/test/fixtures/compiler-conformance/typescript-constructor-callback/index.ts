function first() {}
function second() {}
class Runner {
  constructor(cb: () => void) { cb(); }
}
class Other {
  constructor(cb: () => void) { cb(); }
}
export function run() {
  new Runner(first);
  new Other(second);
}

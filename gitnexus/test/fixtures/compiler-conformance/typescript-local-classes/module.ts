export class Local {
  run() { return 'module'; }
}

export function makeLocal() {
  class Local {
    run() { return 'function'; }
  }
  return new Local().run();
}

export function makePublic() {
  return new Local().run();
}

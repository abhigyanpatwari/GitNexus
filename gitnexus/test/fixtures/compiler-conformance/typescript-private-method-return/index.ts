class Result { done() {} }
export class Store {
  #load(): Result { return new Result(); }
  run() { this.#load().done(); }
}

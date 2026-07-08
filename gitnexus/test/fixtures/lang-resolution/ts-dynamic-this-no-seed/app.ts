class Router {
  go(): void {
    // decoy target: a wrong seed resolves this.route via App's class
    // scope and emits onClick → Router.go
  }
}

export class App {
  route = new Router();

  // Object-literal method: `this` at runtime is the handlers object,
  // NOT the App instance — the language deliberately leaves `this`
  // unbound here, so no CALLS edge to Router.go may be fabricated
  // from the lexically enclosing class.
  static handlers = {
    onClick() {
      this.route.go();
    },
  };
}

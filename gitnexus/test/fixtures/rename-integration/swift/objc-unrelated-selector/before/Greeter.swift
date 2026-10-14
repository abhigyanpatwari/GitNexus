class Greeter {
    func greet(_ name: String, loudly: Bool) {}
}

func run(greeter: Greeter) { greeter.greet("x", loudly: true) }

class Greeter {
    func welcome(_ name: String, loudly: Bool) {}
}

func run(greeter: Greeter) { greeter.welcome("x", loudly: true) }

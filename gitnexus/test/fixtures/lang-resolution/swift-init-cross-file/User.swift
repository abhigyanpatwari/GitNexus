class User {
    var name: String

    init(name: String) {
        self.name = name
    }

    func save() {}
    func greet() -> String {
        return "Hello, \(name)"
    }
}

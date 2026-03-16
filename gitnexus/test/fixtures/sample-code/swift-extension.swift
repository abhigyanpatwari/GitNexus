protocol Greetable {
    func greet() -> String
}

class Person {
    var name: String
    init(name: String) {
        self.name = name
    }
}

extension Person: Greetable {
    func greet() -> String {
        return "Hello, \(name)"
    }
}

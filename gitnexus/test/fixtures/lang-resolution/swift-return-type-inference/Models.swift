class User {
    var name: String
    init(name: String) { self.name = name }
    func save() -> Bool { return true }
}

class Repo {
    var name: String
    init(name: String) { self.name = name }
    func save() -> Bool { return true }
}

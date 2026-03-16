class User {
    let name: String

    init(name: String) {
        self.name = name
    }

    func save() {}
}

func getUser(name: String) -> User {
    return User(name: name)
}

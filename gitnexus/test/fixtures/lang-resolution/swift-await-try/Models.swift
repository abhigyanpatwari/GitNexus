class User {
    func save() {}
}

class Repo {
    func save() {}
}

func fetchUser() async -> User {
    return User()
}

func parseRepo(_ name: String) throws -> Repo {
    return Repo()
}

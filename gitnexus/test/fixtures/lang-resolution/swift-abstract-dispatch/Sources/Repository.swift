protocol Repository {
    func find(id: Int) -> String
    func save(entity: String) -> Bool
}

class SqlRepository: Repository {
    func find(id: Int) -> String {
        return "user-\(id)"
    }

    func save(entity: String) -> Bool {
        return true
    }
}

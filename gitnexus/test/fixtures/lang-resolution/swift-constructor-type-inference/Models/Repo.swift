class Repo {
    let dbName: String

    init(dbName: String) {
        self.dbName = dbName
    }

    func save() -> Bool {
        return false
    }
}

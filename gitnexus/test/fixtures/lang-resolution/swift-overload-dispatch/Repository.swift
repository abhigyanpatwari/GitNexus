protocol Repository {
    func find(id: Int) -> String
    func find(name: String, exact: Bool) -> String
    func save(data: String)
}

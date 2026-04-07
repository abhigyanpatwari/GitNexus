class SqlRepository: Repository {
    func find(id: Int) -> String { return "found-by-id" }
    func find(name: String, exact: Bool) -> String { return "found-by-name" }
    func save(data: String) { print(data) }
}

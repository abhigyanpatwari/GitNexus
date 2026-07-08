protocol Repository {
    var title: String { get }
    var count: Int { get set }
    static var shared: Repository { get }
}

class FileRepository {
    var name: String = ""
}

class UserManager {
    var users: [String] = []

    init() {
        users = []
    }

    func addUser(_ name: String) {
        users.append(name)
    }

    public func getCount() -> Int {
        return users.count
    }
}

func helperFunction() -> String {
    return "swift helper"
}

protocol Animal {
    func speak() -> String
}

class Dog: Animal {
    func speak() -> String {
        return "woof"
    }

    static func classify(_ name: String) -> String {
        return "mammal"
    }

    @objc final func breathe() -> Bool {
        return true
    }
}

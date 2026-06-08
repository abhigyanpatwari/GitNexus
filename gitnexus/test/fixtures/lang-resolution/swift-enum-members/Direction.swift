enum Direction {
    case north
    case south

    func describe() -> String {
        return "direction"
    }

    var label: String {
        return "dir"
    }

    static func make() -> Direction {
        return .north
    }
}

class Compass {
    func heading() -> String {
        return "n"
    }
}

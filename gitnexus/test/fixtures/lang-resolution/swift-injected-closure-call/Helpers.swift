import Foundation

extension Example {
    static func makeValue(input: Int) -> Int {
        input + 1
    }
}

enum Other {
    private static func makeValue(other: String) -> Int {
        -1
    }

    static func clock() -> Date {
        Date.distantPast
    }
}

extension DerivedService {
    func refreshInheritedFromExtension() -> Date {
        clock()
    }
}

extension BaseService {
    func refreshOwnFromExtension() -> Date {
        clock()
    }
}

final class PrivateDerived: PrivateBase {
    func clock() -> Int {
        2
    }

    func refreshPrivateAncestor() -> Int {
        clock()
    }
}

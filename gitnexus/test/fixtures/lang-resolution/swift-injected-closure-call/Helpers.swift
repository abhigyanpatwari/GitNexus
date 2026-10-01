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

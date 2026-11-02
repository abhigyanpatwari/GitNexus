import Foundation

enum Example {
    static func runScenario() -> Int {
        makeValue(input: 1)
    }
}

final class Service {
    private let clock: () -> Date

    init(clock: @escaping () -> Date) {
        self.clock = clock
    }

    func refreshValue() -> Date {
        clock()
    }

    func refreshWithLocalClock() -> Int {
        func clock() -> Int { 2 }
        return clock()
    }
}

class BaseService {
    let clock: () -> Date

    init(clock: @escaping () -> Date) {
        self.clock = clock
    }
}

final class DerivedService: BaseService {
    func refreshInheritedValue() -> Date {
        clock()
    }
}

final class LabeledService {
    let first: Int = 1

    func first(where value: Bool) -> Int {
        value ? 2 : 0
    }

    func refreshLabeled() -> Int {
        first(where: true)
    }
}

class PrivateBase {
    private let clock: () -> Int = { 1 }
}

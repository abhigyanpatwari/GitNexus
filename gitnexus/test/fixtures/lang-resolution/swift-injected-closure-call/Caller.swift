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

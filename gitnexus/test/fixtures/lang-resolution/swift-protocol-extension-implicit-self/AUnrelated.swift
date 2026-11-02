struct OtherStore { let value: Int }

struct OtherScenario {
    private func makeStore(currentValue: Int) -> OtherStore { OtherStore(value: currentValue) }
}

enum OtherValue {
    private static func makeValue(year: Int, month: Int, day: Int) -> Int { -1 }
}

enum OtherItems {
    private static func insertItem(into store: Store) -> String { "decoy" }
}

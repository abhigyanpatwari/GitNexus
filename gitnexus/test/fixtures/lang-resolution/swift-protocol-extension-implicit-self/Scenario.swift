struct Scenario: ScenarioSupport {
    func run() -> String {
        let store = makeStore()
        let value = makeValue(year: 2, month: 3, day: 4)
        let item = insertItem(into: store, count: 1)
        return "\(store.worker.execute()):\(value):\(item)"
    }
}

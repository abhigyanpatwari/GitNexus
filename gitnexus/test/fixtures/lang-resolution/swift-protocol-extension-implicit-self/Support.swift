protocol ScenarioSupport {}

struct Worker {
    func execute() -> String { "worker" }
}

struct Store { let worker: Worker }

extension ScenarioSupport {
    func makeStore(observer: Int? = nil) -> Store { Store(worker: Worker()) }
    func makeValue(year: Int, month: Int, day: Int) -> Int { year + month + day }
    func insertItem(into store: Store, count: Int = 1) -> String { "item" }
}

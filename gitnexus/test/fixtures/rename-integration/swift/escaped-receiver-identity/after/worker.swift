class `Worker` {
    func readValue() -> Int { return 1 }
}
func run() -> Int {
    let `worker`: `Worker` = `Worker`()
    return `worker`.readValue()
}

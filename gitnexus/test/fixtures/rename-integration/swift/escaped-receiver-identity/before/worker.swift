class `Worker` {
    func read() -> Int { return 1 }
}
func run() -> Int {
    let `worker`: `Worker` = `Worker`()
    return `worker`.read()
}

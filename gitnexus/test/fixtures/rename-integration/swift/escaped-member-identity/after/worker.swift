class Worker {
  func `fetch`() -> Int { return 7 }
}
func run() -> Int { let `worker` = Worker(); return `worker`.`fetch`() }

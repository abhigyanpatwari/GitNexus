class Worker {
  fun `fetch`(): Int { return 7 }
}
fun run(): Int { val `worker` = Worker(); return `worker`.`fetch`() }

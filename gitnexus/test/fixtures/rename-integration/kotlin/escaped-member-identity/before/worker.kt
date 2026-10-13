class Worker {
  fun `read`(): Int { return 7 }
}
fun run(): Int { val `worker` = Worker(); return `worker`.`read`() }

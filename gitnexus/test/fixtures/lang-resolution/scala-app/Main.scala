import services.UserService

object Main {
  def main(args: Array[String]): Unit = {
    val user = UserService.createUser("Alice", "alice@example.com")
    UserService.process(user)
  }
}

package app

import com.example._

object App {
  def run(): Unit = {
    val user: User = new User("alice")
    user.save()
  }
}

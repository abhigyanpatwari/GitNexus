package app

import models.User

object Main {
  def main(args: Array[String]): Unit = {
    val user = new User("alice")
    user.save()
  }
}
